import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escapeHtml, cleanText, fmtUsd, fmtPct, fmtX, fmtPrice, num, isSolAddress } from '../src/util.js';
import { metrics, filterReasons, score } from '../src/scoring.js';
import { callMessage, links } from '../src/format.js';
import { readJson } from '../src/state.js';
import { fakePair } from './fixtures.js';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';

test('formatters never emit NaN/undefined', () => {
  for (const v of [undefined, null, '', 'abc', NaN, Infinity, {}]) {
    for (const f of [fmtUsd, fmtPct, fmtX, fmtPrice]) assert.ok(!/NaN|undefined|Infinity/.test(f(v)), `${f.name}(${v})`);
  }
  assert.equal(num('1e3'), 1000);
  assert.equal(fmtUsd(1234567), '$1.23M');
});

test('escaping + cleaning neutralise HTML/XSS in token names', () => {
  assert.equal(escapeHtml('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;');
  assert.equal(cleanText('a\u202eb\u200bc\n d', 40), 'abc d');
  const p = fakePair({ baseToken: { address: CA, name: '<script>alert(1)</script>', symbol: '<a href=x>' } });
  const m = metrics(p);
  const call = { ...m, name: cleanText(m.name), symbol: cleanText(m.symbol), dex: m.dex, address: CA, ageMsAtCall: m.ageMs, priceAtCall: m.priceUsd, mcAtCall: m.marketCap, liquidity: m.liquidity, volume24h: m.vol24, volume1h: m.vol1, change: { m5: 1, h1: 2, h24: 3 }, buysH1: 1, sellsH1: 1, score: 80, links: links(CA, m.pairAddress) };
  const html = callMessage(call, CFG);
  assert.ok(!html.includes('<script>') && !html.includes('<a href=x>'));
  assert.ok(html.includes('&lt;script&gt;'));
  // only whitelisted tags remain
  const tags = [...html.matchAll(/<\/?([a-z]+)/g)].map((x) => x[1]);
  assert.ok(tags.every((t) => ['b', 'i', 'code', 'a'].includes(t)), tags.join());
});

test('solana address validation', () => {
  assert.ok(isSolAddress(CA));
  assert.ok(!isSolAddress('0xabc'));
  assert.ok(!isSolAddress('javascript:alert(1)'));
});

test('good pair passes filters and scores high', () => {
  const m = metrics(fakePair());
  assert.deepEqual(filterReasons(m, CFG.filters), []);
  assert.ok(score(m, CFG.filters) >= CFG.filters.minScore);
});

test('rugs / missing fields are rejected, not crashed', () => {
  const f = CFG.filters;
  assert.ok(filterReasons(metrics(fakePair({ liquidity: { usd: 0 } })), f).includes('zero liquidity (rug?)'));
  assert.ok(filterReasons(metrics(fakePair({ liquidity: undefined })), f).includes('zero liquidity (rug?)'));
  assert.ok(filterReasons(metrics(fakePair({ txns: undefined, volume: undefined, priceChange: undefined })), f).length > 0);
  assert.ok(filterReasons(metrics(fakePair({ pairCreatedAt: Date.now() - 5 * 60000 })), f).includes('too new'));
  assert.ok(filterReasons(metrics(fakePair({ baseToken: { address: CA, name: 'Wrapped SOL', symbol: 'SOL' } })), f).includes('blocked symbol'));
  assert.ok(filterReasons(metrics({}), f).length > 3);
  assert.ok(Number.isFinite(score(metrics({}), f)));
});

test('corrupt state file is backed up and replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(readJson(file, { ok: 1 }), { ok: 1 });
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('corrupt')));
});

test('loosened market filters: borderline pair passes, young-token + 5m-dump rules still bite', () => {
  const f = CFG.filters;
  const p = fakePair({ liquidity: { usd: 21000 }, marketCap: 300000, fdv: 300000, txns: { h1: { buys: 32, sells: 34 }, h24: { buys: 900, sells: 800 } },
    volume: { h24: 200000, h6: 20000, h1: 2600 }, priceChange: { m5: 30, h1: 180, h6: 200, h24: 300 }, pairCreatedAt: Date.now() - 3 * 3600000 });
  assert.deepEqual(filterReasons(metrics(p), f), []);
  assert.ok(filterReasons(metrics(fakePair({ pairCreatedAt: Date.now() - 60 * 60000 })), f).includes('too new'));
  assert.ok(filterReasons(metrics(fakePair({ priceChange: { m5: -25, h1: 5, h6: 5, h24: 5 } })), f).includes('dumping 5m'));
  assert.equal(f.minAgeMinutes, 90);
  assert.equal(f.minScore, 60);
});
