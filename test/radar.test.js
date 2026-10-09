// Trending Radar: engine exports (src/radar.js) + browser core (site/assets/radar-core.js) — sanitization, ranking, parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { heat, radarRow, buildWatchlist, buildTrending, reasonText, isGraduate } from '../src/radar.js';
import { metrics, filterReasons, score } from '../src/scoring.js';
import { fakePair } from './fixtures.js';

const ctx = { URL, self: undefined };
ctx.self = ctx;
vm.runInNewContext(fs.readFileSync(new URL('../site/assets/radar-core.js', import.meta.url), 'utf8'), ctx);
const R = ctx.MGRadar;
const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const f = cfg.filters;
const NOW = Date.parse('2026-10-09T18:00:00Z');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const code = (i) => B58[Math.floor(i / 58) % 58] + B58[i % 58];
const addr = (i) => `${'A'.repeat(38)}${code(i)}pump`;
const pairFor = (i, o = {}) => fakePair({ baseToken: { address: addr(i), name: `Tok${i}`, symbol: `T${i}` }, pairAddress: `${'b'.repeat(42)}${code(i)}`, pairCreatedAt: NOW - 5 * 3600000, ...o });
const plain = (x) => JSON.parse(JSON.stringify(x)); // values from the vm realm

test('heat is 0–100, rewards acceleration and buyers, and matches the browser formula', () => {
  const calm = radarRow(fakePair({ volume: { m5: 100, h1: 1200, h24: 200000 }, txns: { m5: {}, h1: { buys: 10, sells: 30 } } }), NOW);
  const hot = radarRow(fakePair({ volume: { m5: 30000, h1: 100000, h24: 300000 }, txns: { m5: {}, h1: { buys: 900, sells: 300 } } }), NOW);
  assert.ok(hot.heat > calm.heat);
  for (const r of [calm, hot]) assert.ok(r.heat >= 0 && r.heat <= 100);
  assert.equal(heat({}), 0);
  for (const p of [fakePair(), fakePair({ volume: { m5: 30000, h1: 100000, h24: 300000 } }), fakePair({ volume: {}, txns: {} })]) {
    assert.equal(R.fromPair(p).heat, radarRow(p, NOW).heat, 'engine and site agree');
  }
});

test('radarRow sanitizes attacker-controlled fields', () => {
  const r = radarRow(fakePair({ baseToken: { address: addr(1), name: 'Evil\u202e<script>alert(1)</script>'.repeat(3), symbol: '$<b>X</b>\u0000' }, pairAddress: 'javascript:alert(1)', dexId: 'pump<swap>', info: { imageUrl: 'javascript:alert(1)' } }), NOW);
  assert.ok(r.name.length <= 40 && !r.name.includes('\u202e'));
  assert.equal(r.symbol, '<b>X</b>'); // kept as text (site uses textContent), control chars stripped, $ removed
  assert.equal(r.pairAddress, null);
  assert.equal(r.imageUrl, null);
  assert.equal(r.dex, 'pumpswap');
  assert.equal(radarRow(fakePair({ baseToken: { address: 'not-an-address' } }), NOW), null);
});

test('reasonText maps engine reason codes to plain English', () => {
  assert.equal(reasonText('liq<20000'), 'Liquidity under $20K');
  assert.equal(reasonText('score<60'), 'Score just under 60');
  assert.equal(reasonText('safety: holders 120'), 'Not enough holders yet');
  assert.equal(reasonText('too new'), 'Too new (age filter)');
});

test('buildWatchlist: tiers, exclusions, cap', () => {
  const evaluated = [];
  // 20 tokens failing only the age filter, varying score
  for (let i = 1; i <= 20; i++) {
    const m = metrics(pairFor(i, { pairCreatedAt: NOW - 30 * 60000, txns: { h1: { buys: 100 + i * 20, sells: 100 }, h24: { buys: 2000, sells: 1500 } } }), NOW);
    evaluated.push({ c: { address: m.address }, m, reasons: filterReasons(m, f) });
  }
  // hard fails are never on watch
  const dead = metrics(pairFor(30, { liquidity: { usd: 0 } }), NOW);
  evaluated.push({ c: {}, m: dead, reasons: filterReasons(dead, f) });
  const many = metrics(pairFor(31, { liquidity: { usd: 5000 }, volume: { h24: 10, h1: 1 }, txns: { h1: { buys: 1, sells: 9 } } }), NOW);
  evaluated.push({ c: {}, m: many, reasons: filterReasons(many, f) });
  // stage-2: soft safety fail (on watch, tier 1), hard safety fail (excluded), run-cap (tier 0), called (excluded)
  const mk = (i) => ({ m: metrics(pairFor(i), NOW), sc: 70 });
  const soft = { ...mk(40), rejectReasons: ['safety: holders 120'], safety: { mintRevoked: true, freezeRevoked: true, lpLockedPct: 100, top10Pct: 22, holders: 120 } };
  const hard = { ...mk(41), rejectReasons: ['safety: mint authority active'] };
  const cap = mk(42), called = mk(43);
  const w = buildWatchlist({ evaluated, scored: [soft, hard, cap, called], shortlist: [soft, hard, cap, called], picks: [called], f, now: NOW });
  assert.equal(w.items.length, 15);
  const ids = w.items.map((i) => i.address);
  assert.equal(ids[0], cap.m.address); assert.equal(w.items[0].reasonText, 'Passed — run limit reached');
  assert.equal(ids[1], soft.m.address); assert.equal(w.items[1].reasonText, 'Not enough holders yet');
  assert.deepEqual(w.items[1].safety, { mint: true, freeze: true, lp: 100, top10: 22, holders: 120 });
  for (const bad of [hard, called].map((x) => x.m.address).concat(dead.address, many.address)) assert.ok(!ids.includes(bad));
  const tier2 = w.items.filter((i) => i.tier === 2);
  assert.ok(tier2.every((i) => i.reason === 'too new'));
  assert.deepEqual(tier2.map((i) => i.score), tier2.map((i) => i.score).slice().sort((a, b) => b - a), 'sorted by score');
  assert.equal(tier2[0].score, Math.max(...evaluated.slice(0, 20).map((e) => score(e.m, f, e.c))));
});

test('buildTrending: capped hot list + graduates (pumpswap/raydium, pump mint, <24h) + slur filter', () => {
  const pairs = [];
  for (let i = 1; i <= 40; i++) pairs.push(pairFor(i, { dexId: i % 2 ? 'pumpswap' : 'meteora', pairCreatedAt: NOW - i * 3600000 }));
  pairs.push(pairFor(50, { baseToken: { address: addr(50), name: 'n1gga coin', symbol: 'X' } }));
  pairs.push(pairFor(1)); // duplicate
  const t = buildTrending({ pairs, now: NOW });
  assert.equal(t.hot.length, 25);
  assert.ok(t.hot.every((r, i, a) => i === 0 || a[i - 1].heat >= r.heat));
  assert.ok(t.graduates.length > 0 && t.graduates.length <= 15);
  assert.ok(t.graduates.every((r) => r.dex === 'pumpswap' && NOW - r.pairCreatedAt < 24 * 3600000));
  assert.ok(![...t.hot, ...t.graduates].some((r) => r.address === addr(50)));
  assert.equal(new Set(t.hot.map((r) => r.address)).size, t.hot.length);
  assert.ok(Buffer.byteLength(JSON.stringify(t)) < 40000, 'snapshot stays small');
  assert.equal(isGraduate({ dex: 'pumpswap', address: addr(1), pairCreatedAt: NOW - 25 * 3600000 }, NOW), false);
});

test('browser core: malicious snapshot/watchlist JSON never throws and is cleaned', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const bad = [null, 'str', 42, [], { address: 'javascript:alert(1)' }, { address: addr(1), name: { toString: 1 }, symbol: ['x'], imageUrl: 'https://evil.example/a.png', pairAddress: '"><x', ch: 'x', vol: null, txns: { h1: 'x' } }];
  for (const x of bad) { R.fromSnapshot(x); R.fromWatch(x); }
  const ok = R.fromSnapshot(bad[5]);
  assert.equal(ok.name, 'Unknown'); assert.equal(ok.symbol, '???'); assert.equal(ok.imageUrl, null); assert.equal(ok.pairAddress, null);
  const w = R.fromWatch({ address: addr(2), name: evil, symbol: evil, reasonText: { a: 1 }, otherReasons: [evil, {}], safety: { mint: 'yes', freeze: true, lp: '<b>', top10: '20' }, score: '<b>' });
  assert.equal(w.name, evil); // stays text; DOM uses textContent
  assert.equal(w.reason, 'Near miss');
  assert.deepEqual(JSON.parse(JSON.stringify(w.safety)), { mint: false, freeze: true, lp: null, top10: 20, holders: null });
  assert.equal(w.score, null);
  assert.equal(R.fromWatch({ address: addr(3), name: 'f@ggot', symbol: 'Y' }), null);
  assert.equal(R.img('https://cdn.dexscreener.com/cms/images/a.png'), 'https://cdn.dexscreener.com/cms/images/a.png');
  assert.equal(R.img('http://cdn.dexscreener.com/a.png'), null);
});

test('browser core: bestPairs keeps deepest solana pair per token; GT/boost parsing validates ids', () => {
  const best = R.bestPairs([pairFor(1, { liquidity: { usd: 10 } }), pairFor(1, { liquidity: { usd: 99 } }), { ...pairFor(2), chainId: 'base' }, null]);
  assert.deepEqual(plain(Object.keys(best)), [addr(1)]);
  assert.equal(best[addr(1)].liq, 99);
  assert.deepEqual(plain(R.gtPools({ data: [{ relationships: { base_token: { data: { id: 'solana_' + addr(1) } }, dex: { data: { id: 'pump-swap' } } } }, { relationships: { base_token: { data: { id: 'solana_<x>' } } } }] }).map((p) => p.address)), [addr(1)]);
  assert.deepEqual(plain(R.dsBoosts([{ chainId: 'solana', tokenAddress: addr(1) }, { chainId: 'solana', tokenAddress: '<x>' }, { chainId: 'eth', tokenAddress: addr(2) }])), [addr(1)]);
  const rows = [R.fromPair(pairFor(1)), R.fromPair(pairFor(2, { marketCap: 9e6 }))];
  assert.equal(R.sortRows(rows, 'mc')[0].address, addr(2));
  assert.equal(R.search(rows, '$t2').length, 1);
  assert.equal(R.search(rows, addr(1)).length, 1);
});
