// Headless UI check for /featured/, /featured/admin/ and the Trending sponsored card with a MOCK active listing.
// Serves a temp copy of site/ (mock data/featured.json), mocks DexScreener for the sponsored CA and the Supabase
// `featured` function, then at 320/390/1280: no horizontal overflow, no console errors / page errors.
// Screenshots → screenshots/featured-mobile.png, featured-desktop.png, trending-sponsored.png
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/usr/bin/google-chrome node scripts/check-featured-ui.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pw;
try { pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core'); } catch { console.log('skip: playwright-core not available'); process.exit(0); }
const chromium = pw.chromium ?? pw.default.chromium;

const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const BAD = 'So11111111111111111111111111111111111111112';
const POOL = '2h59QWesujZ6Tb8dWr9K6ruSjeLk7MRSovLQQVYjigdB';
const now = Date.now();
const iso = (t) => new Date(t).toISOString();

// temp site copy with a mock active listing
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-ui-'));
fs.cpSync(path.join(ROOT, 'site'), tmp, { recursive: true });
const listing = { ca: CA, symbol: 'GEMZ', name: 'Gemz Coin', imageUrl: null, dex: 'pumpswap', pairAddress: POOL, startsAt: iso(now - 3 * 3600000), endsAt: iso(now + 21 * 3600000),
  safety: { mint: true, freeze: true, lp: 100, top10: 22, holders: 1430 } };
fs.writeFileSync(path.join(tmp, 'data', 'featured.json'), JSON.stringify({ updatedAt: iso(now), label: 'Sponsored – not financial advice', maxConcurrent: 3, activeCount: 1, nextAvailableAt: iso(now + 3600000), listings: [listing] }));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(tmp, path.normalize(p));
  fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404).end('nf'); return; } res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(buf); });
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;

const pair = { chainId: 'solana', dexId: 'pumpswap', pairAddress: POOL, baseToken: { address: CA, symbol: 'GEMZ', name: 'Gemz Coin' }, priceUsd: '0.00123', liquidity: { usd: 84200 }, marketCap: 1230000, fdv: 1230000, priceChange: { m5: 1.2, h1: 6.4, h24: 18.5 }, pairCreatedAt: now - 30 * 3600000, txns: { h1: { buys: 320, sells: 210 } }, volume: { h1: 52000, h24: 640000 } };
const okCheck = { ok: true, reasons: [], token: { ca: CA, symbol: 'GEMZ', name: 'Gemz Coin', imageUrl: null, dex: 'pumpswap', pairAddress: POOL, priceUsd: 0.00123, liquidityUsd: 84200, marketCap: 1230000, ageMinutes: 1800 },
  safety: { mintRevoked: true, freezeRevoked: true, lpLockedPct: 100, top10Pct: 22, insiderPct: 0, creatorPct: 0, holders: 1430 },
  quote: { startsAt: iso(now + 3600000), endsAt: iso(now + 25 * 3600000), postDueAt: iso(now + 24 * 3600000), waitlisted: true, ahead: 1 }, price: { sol: '1', hours: 24 }, paymentsEnabled: false };
const badCheck = { ok: false, reasons: ['Mint authority is still active (the dev can print more tokens).', 'Only 12% of liquidity is locked or burned (minimum 80%).', 'Liquidity is $4,310 (minimum $20,000).'], token: null, safety: null, quote: null, paymentsEnabled: false };

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
async function run(width, url, act) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 }, deviceScaleFactor: width < 800 ? 2 : 1, isMobile: width < 800, hasTouch: width < 800 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('https://api.dexscreener.com/**', (r) => (r.request().url().includes(CA) ? r.fulfill({ contentType: 'application/json', body: JSON.stringify([pair]), headers: { 'access-control-allow-origin': '*' } }) : r.fulfill({ contentType: 'application/json', body: '[]', headers: { 'access-control-allow-origin': '*' } })));
  await page.route('https://api.geckoterminal.com/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"data":[]}', headers: { 'access-control-allow-origin': '*' } }));
  await page.route('https://wrlsgqfpcvdjzsueikxw.supabase.co/**', async (r) => {
    const b = JSON.parse(r.request().postData() || '{}');
    const body = b.action === 'check' ? (b.ca === CA ? okCheck : badCheck) : b.action === 'status' ? { found: true, status: 'active', listing, postDueAt: iso(now - 3600000), posted: true }
      : b.action === 'admin-view' ? { ok: true, status: 'active', listing, posted: true, wallet: BAD } : { ok: false };
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  if (act) await act(page);
  await page.waitForTimeout(400);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth, wide: [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.nav,.tr-tabs'); }).slice(0, 5).map((e) => e.className || e.tagName) }));
  results.push({ width, url, overflow: ov.sw > ov.w, wide: ov.wide, errors });
  return { page, ctx };
}
const check = (ca) => async (page) => { await page.fill('#ca', ca); await page.click('#chkBtn'); await page.waitForSelector('#result .ft-quote, #result .ft-fail'); };

for (const w of [320, 390, 1280]) {
  let r = await run(w, '/featured/', check(CA));
  if (w === 390) await r.page.screenshot({ path: path.join(ROOT, 'screenshots', 'featured-mobile.png'), fullPage: true });
  if (w === 1280) await r.page.screenshot({ path: path.join(ROOT, 'screenshots', 'featured-desktop.png'), fullPage: false });
  const btn = await r.page.textContent('#result .ft-btn');
  const dis = await r.page.getAttribute('#result .ft-btn', 'disabled');
  results.at(-1).payButton = `${btn} (disabled=${dis !== null})`;
  await r.ctx.close();
  r = await run(w, '/featured/', check(BAD));
  results.at(-1).failShowsPay = await r.page.locator('#result .ft-btn').count();
  results.at(-1).reasons = await r.page.locator('#result .ft-fail li').count();
  await r.ctx.close();
  r = await run(w, `/featured/?ca=${CA}`, async (p) => { await p.waitForSelector('#statusBody .ft-status'); });
  await r.ctx.close();
  r = await run(w, '/featured/admin/#0b6c4c1e-1d1f-4c51-9d0e-1f2a3b4c5d6e.1791634967.QDQuunmv0_WKUoCu9fs5P-zoBMFnU6SU5rvywG78qC0', async (p) => { await p.waitForSelector('#adminBody .ft-kv'); });
  results.at(-1).tokenLeftInUrl = (await r.page.url()).includes('#');
  await r.ctx.close();
  r = await run(w, '/trending/', async (p) => { await p.waitForSelector('#sponsored .sp-card'); });
  results.at(-1).sponsoredCards = await r.page.locator('#sponsored .sp-card').count();
  results.at(-1).label = await r.page.locator('#sponsored .sp-badge').first().textContent();
  if (w === 1280) await r.page.screenshot({ path: path.join(ROOT, 'screenshots', 'trending-sponsored.png'), clip: { x: 0, y: 0, width: 1280, height: 1100 } });
  if (w === 390) await r.page.screenshot({ path: path.join(ROOT, 'screenshots', 'trending-sponsored-mobile.png'), fullPage: false });
  await r.ctx.close();
}
await browser.close(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
let bad = 0;
for (const r of results) {
  const fail = r.overflow || r.errors.length;
  if (fail) bad++;
  console.log(`${fail ? 'FAIL' : 'ok  '} ${String(r.width).padStart(4)} ${r.url.slice(0, 40).padEnd(40)} overflow=${r.overflow}${r.wide.length ? ' ' + JSON.stringify(r.wide) : ''} errors=${r.errors.length}${r.payButton ? ' pay=' + r.payButton : ''}${r.failShowsPay !== undefined ? ` failPayButtons=${r.failShowsPay} reasons=${r.reasons}` : ''}${r.sponsoredCards !== undefined ? ` sponsored=${r.sponsoredCards} badge=${r.label}` : ''}${r.tokenLeftInUrl !== undefined ? ` tokenInUrl=${r.tokenLeftInUrl}` : ''}`);
  for (const e of r.errors) console.log('     ', e.slice(0, 200));
}
process.exit(bad ? 1 : 0);
