// Headless QA for the Pro UI: overflow/console checks at 320/390/1280 + screenshots of /pro/ and locked/unlocked states.
// Supabase API and proOnly/delayed data are mocked via request interception. Usage: node scripts/pro-shots.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import puppeteer from 'puppeteer-core';
const ROOT = path.resolve('site'), OUT = path.resolve('screenshots'); fs.mkdirSync(OUT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.xml': 'text/xml', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404, { 'content-type': 'text/html' }); return r.end(fs.readFileSync(path.join(ROOT, '404.html'))); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0); const BASE = `http://127.0.0.1:${srv.address().port}`;
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const watch = JSON.parse(fs.readFileSync('site/data/watchlist.json', 'utf8'));
const moves = JSON.parse(fs.readFileSync('site/data/whale-moves.json', 'utf8'));
const exp = new Date(Date.now() + 27 * 864e5).toISOString();
function account(mode) {
  const pub = { paymentsEnabled: false, plans: [], proGroupReady: true };
  if (mode === 'anon') return { ...pub, signedIn: false };
  return { ...pub, signedIn: true, wallet: WALLET, testWallet: false, pro: mode === 'pro' ? { active: true, plan: 'p30', expiresAt: exp, daysLeft: 27 } : { active: false, plan: null, expiresAt: null, daysLeft: 0 }, telegram: { linked: mode === 'pro' } };
}
async function page(b, w, { mode = 'anon', launched = false } = {}) {
  const p = await b.newPage(); await p.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
  await p.setRequestInterception(true);
  p.on('request', (q) => {
    const u = q.url(); const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (u.includes('supabase.co/functions/v1/')) {
      if (q.method() === 'OPTIONS') return q.respond({ status: 204, headers: cors });
      if (u.includes('/account')) return q.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(account(mode)) });
      if (u.includes('/pro-data')) return mode === 'pro' ? q.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ pro: { daysLeft: 27, expiresAt: exp }, whaleMoves: moves, watchlist: watch }) })
        : q.respond({ status: mode === 'anon' ? 401 : 402, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: 'Pro needed' }) });
    }
    if (launched && u.startsWith(BASE + '/data/watchlist.json')) return q.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ updatedAt: watch.updatedAt, minScore: watch.minScore, proOnly: true, count: watch.items.length, items: [] }) });
    if (launched && u.startsWith(BASE + '/data/whale-moves.json')) { const cut = Date.now() - 15 * 6e4; return q.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ updatedAt: moves.updatedAt, delayMinutes: 15, moves: moves.moves.filter((m) => Date.parse(m.t) <= cut) }) }); }
    q.continue();
  });
  if (mode !== 'anon') await p.evaluateOnNewDocument((s) => localStorage.setItem('mg.session.v1', s), JSON.stringify({ token: 'x.y.z', wallet: WALLET, expiresAt: new Date(Date.now() + 864e5).toISOString() }));
  return { p, errs };
}
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [];
// 1) overflow + console on every page
for (const route of ['/', '/trending/', '/leaderboard/', '/whales/', '/pro/', '/terms/', '/risk/', '/nope/'])
  for (const w of [320, 390, 1280]) for (const mode of ['anon', 'pro']) {
    const { p, errs } = await page(b, w, { mode, launched: true });
    await p.goto(BASE + route, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}); await new Promise((r) => setTimeout(r, 600));
    const o = await p.evaluate(() => { const W = document.documentElement.clientWidth; const bad = [...document.querySelectorAll('header *, .acct-btn, .nav-pro')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1; }).map((e) => e.className || e.tagName).slice(0, 4); return { sw: document.documentElement.scrollWidth, W, bad }; });
    if (o.sw > o.W || o.bad.length || errs.length) report.push(`${route} @${w} ${mode}: scrollW ${o.sw}/${o.W} ${o.bad.join(',')} ${errs.join(' | ')}`);
    await p.close();
  }
// 2) screenshots
async function shot(name, route, w, opts, act) {
  const { p } = await page(b, w, opts); await p.goto(BASE + route, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800)); if (act) { await act(p); await new Promise((r) => setTimeout(r, 900)); }
  await p.screenshot({ path: path.join(OUT, `${name}-${w}.png`), fullPage: name.startsWith('pro-page') }); await p.close();
}
const tabWatch = async (p) => { await p.click('#tab-watch'); await p.evaluate(() => document.querySelector('#radar')?.scrollIntoView()); };
const drawer = async (p) => { await p.click('#acctBtn'); };
for (const w of [390, 1280]) {
  await shot('pro-page', '/pro/', w, {});
  await shot('trending-onwatch-locked', '/trending/', w, { mode: 'free', launched: true }, tabWatch);
  await shot('trending-onwatch-unlocked-pro', '/trending/', w, { mode: 'pro', launched: true }, tabWatch);
  await shot('whales-free-delayed', '/whales/', w, { mode: 'free', launched: true });
  await shot('whales-pro-live', '/whales/', w, { mode: 'pro', launched: true });
  await shot('account-drawer-pro', '/', w, { mode: 'pro', launched: true }, drawer);
  await shot('home-prelaunch-anon', '/', w, {});
}
await b.close(); srv.close();
console.log(report.length ? 'ISSUES:\n' + report.join('\n') : 'layout/console: OK on all pages at 320/390/1280 (anon + pro)');
console.log(fs.readdirSync(OUT).join('\n'));
