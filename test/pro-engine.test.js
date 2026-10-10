// Pro never touches calls: with Pro FULLY launched (group set, delays on), every call still posts to the PUBLIC channel
// in the same run, instantly, and lands in the public calls.json. Plus the Pro-only extras (delayed moves, watchlist lock,
// whale alerts → Pro group, delayed digest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakePair, fakeReport } from './fixtures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-pro-'));
const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
cfg.pro = { launched: true, groupId: '-1004352042429', whaleDelayMinutes: 15, digest: { enabled: true, everyHours: 6, maxItems: 5 } };
cfg.share = { enabled: false };
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
process.env.MAXIGEMS_CONFIG = path.join(dir, 'config.json');
process.env.MAXIGEMS_STATE = path.join(dir, 'state.json');
process.env.MAXIGEMS_SITE_DATA = path.join(dir, 'calls.json');
process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
process.env.TELEGRAM_CHANNEL_ID = '@public';
delete process.env.DRY_RUN; delete process.env.PRO_INGEST_URL; delete process.env.PRO_LAUNCHED; delete process.env.TELEGRAM_PRO_GROUP_ID;

const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const tgCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status });
  if (url.includes('api.telegram.org')) {
    const body = opts.body instanceof FormData ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>'])) : JSON.parse(opts.body);
    tgCalls.push({ method: url.split('/').pop(), body, at: Date.now() });
    return json({ ok: true, result: { message_id: tgCalls.length } });
  }
  if (url.includes('api.rugcheck.xyz')) return json(fakeReport());
  if (url.includes('mainnet-beta.solana.com')) return json({ result: { value: [] } });
  if (url.includes('token-boosts') || url.includes('token-profiles')) return json([{ chainId: 'solana', tokenAddress: CA }]);
  if (url.includes('geckoterminal')) return json({ data: [] });
  if (url.includes('/tokens/v1/solana/')) return json([fakePair({ priceUsd: '0.0002' })]);
  return json({}, 404);
};

const { runOnce } = await import('../src/engine.js');
const { proCfg, publicMoves, publicWatchlist, digestMessage, digestDue } = await import('../src/pro.js');

test('Pro launched: the call is posted to the PUBLIC channel instantly, same run, and is in the public calls.json', async () => {
  const t0 = Date.now();
  const r = await runOnce();
  assert.equal(r.newCalls.length, 1);
  const call = tgCalls.find((c) => c.method === 'sendPhoto' || c.method === 'sendMessage');
  assert.ok(call, 'call posted');
  assert.equal(call.body.chat_id, '@public', 'calls go to the public channel, never the Pro group');
  assert.ok(call.at - t0 < 30000, 'posted within the same run (no delay)');
  assert.ok(!tgCalls.some((c) => c.body.chat_id === '-1004352042429' && /Score|CA|📋/.test(c.body.caption ?? c.body.text ?? '') && !/Whale/.test(c.body.caption ?? c.body.text ?? '')), 'no call content in the Pro group');
  const site = JSON.parse(fs.readFileSync(process.env.MAXIGEMS_SITE_DATA));
  assert.equal(site.calls[0].address, CA, 'the website gets the call live too');
  assert.equal(site.calls[0].proOnly, undefined);
  const wl = JSON.parse(fs.readFileSync(path.join(dir, 'watchlist.json')));
  assert.equal(wl.proOnly, true); assert.deepEqual(wl.items, []);
});

test('the same call is posted identically with Pro off (Pro settings cannot change calls)', async () => {
  const off = proCfg({ pro: { launched: false, groupId: '-1004352042429' } });
  assert.equal(off.alertsToGroup, false);
  const on = proCfg(cfg);
  assert.equal(on.alertsToGroup, true);
  // the call pipeline never reads pro config: engine.js only uses it for whales/watchlist/digest
  const src = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
  const callStep = src.slice(src.indexOf('// 3) post new calls'), src.indexOf('// 4) milestone updates'));
  assert.doesNotMatch(callStep, /proCfg|chatId|whaleDelay/);
  assert.match(callStep, /postMessage\(\{ html: callMessage\(call, cfg\)/);
  const ms = src.slice(src.indexOf('// 4) milestone updates'), src.indexOf('// 4b) whale watcher'));
  assert.doesNotMatch(ms, /proCfg|chatId/);
});

test('publicMoves: holds back moves younger than 15 min only when launched', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const mf = { updatedAt: 'x', moves: [{ t: new Date(now - 5 * 60000).toISOString() }, { t: new Date(now - 20 * 60000).toISOString() }] };
  const pc = proCfg(cfg);
  const pub = publicMoves(mf, pc, now);
  assert.equal(pub.moves.length, 1); assert.equal(pub.delayMinutes, 15); assert.equal(pub.heldForPro, 1);
  assert.equal(publicMoves(mf, proCfg({}), now), mf);
  assert.deepEqual(publicWatchlist({ updatedAt: 'u', items: [1, 2] }, pc), { updatedAt: 'u', proOnly: true, count: 2, items: [] });
  assert.deepEqual(publicWatchlist({ items: [1] }, proCfg({})), { items: [1] });
});

test('digest: delayed, capped, escaped, at most every 6h, says calls stay free', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const pc = proCfg(cfg);
  const mk = (min, usd, sym = 'GEM') => ({ t: new Date(now - min * 60000).toISOString(), sym, k: 'buy', usd, o: 'x' });
  const html = digestMessage([mk(5, 99999), mk(30, 5000, '<b>X'), mk(60, 7000)], pc, cfg, now);
  assert.doesNotMatch(html, /99\.9K|<b>X/); // too fresh is excluded; names escaped
  assert.match(html, /\$7\.0K[\s\S]*\$5\.0K/);
  assert.match(html, /Calls are always free and instant/);
  assert.equal(digestMessage([mk(5, 1)], pc, cfg, now), null);
  assert.equal(digestDue({}, pc, now), true);
  assert.equal(digestDue({ lastWhaleDigestAt: new Date(now - 3600000).toISOString() }, pc, now), false);
  assert.equal(digestDue({}, proCfg({}), now), false);
});

test('live moves round-trip through Supabase only (never the public repo); merge dedupes newest-first', async () => {
  const { mergeMoves, fetchLiveMoves } = await import('../src/pro.js');
  const a = [{ t: '2026-10-10T12:00:00Z', ca: 'A', o: 'x', k: 'buy' }];
  const b = [{ t: '2026-10-10T11:00:00Z', ca: 'B', o: 'y', k: 'sell' }, { t: '2026-10-10T12:00:00Z', ca: 'A', o: 'x', k: 'buy' }];
  assert.deepEqual(mergeMoves(a, b).map((m) => m.ca), ['A', 'B']);
  assert.equal(await fetchLiveMoves(), null); // not configured → engine falls back to the public file
  process.env.PRO_INGEST_URL = 'https://x.supabase.co/functions/v1/ingest'; process.env.PRO_INGEST_SECRET = 's';
  let hdr = null;
  const got = await fetchLiveMoves({ fetchJson: async (u, o) => { hdr = o.headers; return { whaleMoves: { moves: a } }; } });
  assert.deepEqual(got, a); assert.equal(hdr['x-ingest-secret'], 's');
  delete process.env.PRO_INGEST_URL; delete process.env.PRO_INGEST_SECRET;
  const wf = fs.readFileSync(new URL('../.github/workflows/maxigems.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(wf, /whale-moves-live/);
});
