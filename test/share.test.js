// Share pages (/c/<CA>/), OG card rendering, escaping, change detection, caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { esc, isSolAddress, coinPageHtml, cardSvg, snapshotOf, needsRender, generateShare, sitemapXml, fetchIcon, renderCard, templateParts, peakX } from '../src/share.js';
import { callButtons, callMessage, coinPageUrl, links } from '../src/format.js';

const CA = 'HoLyRoDEQvK5zPsGpcz3BbCWhceTGhWAGnVifSoUShit';
const EVIL = '<script>alert(1)</script>"\'><img src=x onerror=alert(2)>&amp;';
const call = (o = {}) => ({ address: CA, pairAddress: 'BFrSZakeqNzVtM3EFhroo4eRhagmmWN8BRntiQKFH6Ru', symbol: 'HOLY', name: 'holy shit', calledAt: '2026-10-09T12:31:00.000Z',
  mcAtCall: 136100, athMc: 298700, athMultiple: 2.19, currentMultiple: 1.44, currentMc: 196000, status: 'active', imageUrl: 'https://cdn.dexscreener.com/x.png',
  safety: { mint: true, freeze: true, lp: 100, top10: 24 }, ...o });

test('escape + base58 validation', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.ok(isSolAddress(CA));
  for (const bad of ['../../etc', 'O0Il' + CA.slice(4), CA + '/x', '', null, 'a'.repeat(31), '"><script>']) assert.equal(isSolAddress(bad), false, String(bad));
  assert.throws(() => coinPageHtml(call({ address: '../../evil' }), snapshotOf(call(), true)), /invalid CA/);
});

test('coin page: meta tags, absolute URLs, everything escaped', () => {
  const c = call({ name: EVIL, symbol: EVIL, imageUrl: 'javascript:alert(1)', pairAddress: '"><x' });
  const html = coinPageHtml(c, snapshotOf(c, true));
  assert.ok(!/<script>alert/i.test(html) && !/<img src=x/i.test(html) && !/onerror=alert\(2\)>/.test(html.replace(/&lt;img src=x onerror=alert\(2\)&gt;/g, '')));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes(`https://dexscreener.com/solana/${CA}`), 'invalid pair falls back to CA');
  const ok = coinPageHtml(call(), snapshotOf(call(), true));
  const meta = (p) => (ok.match(new RegExp(`(?:property|name)="${p}" content="([^"]*)"`)) || [])[1];
  assert.equal(meta('og:url'), `https://maxigems.fun/c/${CA}/`);
  assert.match(meta('og:image'), new RegExp(`^https://maxigems\\.fun/c/${CA}/card\\.png\\?v=`));
  assert.equal(meta('og:title'), '$HOLY called by MaxiGems — 2.19x peak');
  assert.equal(meta('twitter:card'), 'summary_large_image');
  assert.equal(meta('twitter:site'), '@maxigems_sol');
  assert.equal(meta('theme-color'), '#39ff88');
  assert.ok(ok.includes(`<link rel="canonical" href="https://maxigems.fun/c/${CA}/" />`));
  assert.ok(ok.includes('class="nav"') && ok.includes('id="tgBtn"') && ok.includes('id="chatBtn"') && ok.includes('id="xBtn"'));
  assert.ok(!ok.includes('aria-current'), 'no nav item active on coin pages');
  // no card yet → site OG image
  assert.match(coinPageHtml(call(), snapshotOf(call(), false)), /og:image" content="https:\/\/maxigems\.fun\/assets\/og-image\.jpg"/);
  // rugged wording
  assert.match(coinPageHtml(call({ status: 'rugged', currentLiquidity: 50 }), snapshotOf(call({ status: 'rugged', currentLiquidity: 50 }), true)), /<title>\$HOLY called by MaxiGems — 2\.19x peak \(liquidity pulled\)<\/title>/);
});

test('card SVG escapes token text; renders a 1200x630 PNG under 150KB', async () => {
  const c = call({ name: EVIL, symbol: EVIL, safety: null });
  const svg = cardSvg(c, snapshotOf(c, true), {});
  assert.ok(!svg.includes('<script') && !svg.includes('<img'));
  const png = await renderCard(c, snapshotOf(c, true), { iconData: null });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length < 150 * 1024, `png ${png.length} bytes`);
  const rug = await renderCard(call({ status: 'rugged', athMultiple: 37.5 }), snapshotOf(call({ status: 'rugged', athMultiple: 37.5 }), true), { iconData: null });
  assert.ok(rug.length < 150 * 1024);
});

test('needsRender: first time, ≥0.05x peak move, status change, version, dirty', () => {
  const s = snapshotOf(call(), true);
  assert.equal(needsRender(null, call()), true);
  assert.equal(needsRender(s, call({ athMultiple: 2.23 })), false);
  assert.equal(needsRender(s, call({ athMultiple: 2.24 })), true);
  assert.equal(needsRender(s, call({ status: 'rugged' })), true);
  assert.equal(needsRender({ ...s, v: 0 }, call()), true);
  assert.equal(needsRender({ ...s, dirty: true }, call()), true);
  assert.equal(needsRender({ ...s, hasCard: false }, call()), true);
  assert.equal(peakX({ athMultiple: 0.5, currentMultiple: 0.2 }), 1);
});

test('generateShare: cap, idempotent (no rewrites), invalid CA skipped, sitemap, render failure safe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-share-'));
  const man = path.join(dir, 'share.json');
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const mk = (i) => call({ address: (B58[i % 58] + B58[(i * 7) % 58]).repeat(16).slice(0, 44), symbol: 'T' + i, calledAt: new Date(Date.UTC(2026, 9, 9, 12, i)).toISOString() });
  const calls = Array.from({ length: 7 }, (_, i) => mk(i)).concat([call({ address: '../../../etc/passwd' })]);
  let renders = 0;
  const render = async () => { renders++; return Buffer.from('png' + renders); };
  const r1 = await generateShare(calls, { siteDir: dir, manifestFile: man, maxRenders: 5, render });
  assert.equal(r1.rendered, 5); assert.equal(r1.queued, 2); assert.equal(r1.pages, 7);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'c')).sort(), calls.slice(0, 7).map((c) => c.address).sort(), 'only valid CAs get a directory');
  // newest calls rendered first
  assert.ok(fs.existsSync(path.join(dir, 'c', mk(6).address, 'card.png')) && !fs.existsSync(path.join(dir, 'c', mk(0).address, 'card.png')));
  const r2 = await generateShare(calls, { siteDir: dir, manifestFile: man, maxRenders: 5, render });
  assert.equal(r2.rendered, 2); assert.equal(r2.queued, 0);
  const r3 = await generateShare(calls, { siteDir: dir, manifestFile: man, maxRenders: 5, render });
  assert.deepEqual([r3.rendered, r3.pages, r3.queued], [0, 0, 0], 'unchanged data → nothing rewritten');
  const moved = calls.map((c, i) => (i === 3 ? { ...c, athMultiple: 2.4, currentMultiple: 1.1 } : { ...c, currentMultiple: 1.3 }));
  const r4 = await generateShare(moved, { siteDir: dir, manifestFile: man, maxRenders: 5, render });
  assert.equal(r4.rendered, 1, 'only the coin whose peak moved ≥0.05 re-renders'); assert.equal(r4.pages, 1);
  const sm = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
  assert.equal((sm.match(/<url>/g) || []).length, 3 + 7);
  assert.ok(sm.includes('https://maxigems.fun/leaderboard/') && sm.includes(`https://maxigems.fun/c/${mk(1).address}/`));
  // renderer failure never throws; pages still written with fallback OG image
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-share-'));
  const r5 = await generateShare([call()], { siteDir: dir2, manifestFile: path.join(dir2, 's.json'), render: async () => { throw new Error('boom'); } });
  assert.equal(r5.errors, 1); assert.equal(r5.pages, 1);
  assert.match(fs.readFileSync(path.join(dir2, 'c', CA, 'index.html'), 'utf8'), /assets\/og-image\.jpg/);
});

test('fetchIcon: host whitelist, content-type and size limits, timeout', async () => {
  let hit = 0;
  const fake = (type, size) => async () => { hit++; return new Response(new Uint8Array(size), { headers: { 'content-type': type } }); };
  assert.equal(await fetchIcon('https://evil.example.com/a.png', { fetchImpl: fake('image/png', 10) }), null);
  assert.equal(await fetchIcon('http://cdn.dexscreener.com/a.png', { fetchImpl: fake('image/png', 10) }), null);
  assert.equal(hit, 0, 'non-whitelisted URLs are never fetched');
  assert.equal(await fetchIcon('https://cdn.dexscreener.com/a.png', { fetchImpl: fake('text/html', 10) }), null);
  assert.equal(await fetchIcon('https://cdn.dexscreener.com/a.png', { fetchImpl: fake('image/png', 3e6), maxBytes: 1e6 }), null);
  const slow = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const t = Date.now();
  assert.equal(await fetchIcon('https://cdn.dexscreener.com/a.png', { fetchImpl: slow, timeoutMs: 200 }), null);
  assert.ok(Date.now() - t < 2000);
});

test('telegram: share page link + button, max 3 buttons per row', () => {
  const cfg = { siteUrl: 'https://maxigems.fun/', telegramChatUrl: 'https://t.me/MGcalls_gc', xUrl: 'https://x.com/maxigems_sol' };
  const c = { ...call(), links: links(CA, call().pairAddress), change: {}, priceAtCall: 0.001 };
  assert.equal(coinPageUrl(c, cfg), `https://maxigems.fun/c/${CA}/`);
  assert.equal(coinPageUrl({ address: '../x' }, cfg), null);
  assert.equal(coinPageUrl(c, { siteUrl: '' }), null);
  const rows = callButtons(c, cfg);
  assert.ok(rows.every((r) => r.length <= 3));
  assert.ok(rows.flat().some((b) => b.url === `https://maxigems.fun/c/${CA}/` && /Share/.test(b.text)));
  assert.ok(callMessage(c, cfg).includes(`<a href="https://maxigems.fun/c/${CA}/">Live tracking &amp; share card</a>`));
});

test('sitemap + template parts', () => {
  const xml = sitemapXml([CA, 'bad/../x']);
  assert.equal((xml.match(/<url>/g) || []).length, 4);
  const p = templateParts();
  assert.ok(p.header.includes('/trending/') && p.cta.includes('tgBtn') && p.footer.includes('ftrX'));
});
