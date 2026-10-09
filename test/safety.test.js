import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeReport } from '../src/safety.js';
import { isRugged } from '../src/engine.js';
import { safetyLine, callMessage, links } from '../src/format.js';
import { fakeReport, POOL } from './fixtures.js';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const S = CFG.safety;
const ctx = { pairAddress: POOL };

test('clean pump.fun token passes; pool excluded from top10', () => {
  const r = analyzeReport(fakeReport(), ctx, S);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.safety.top10Pct, 20); // 10 × 2%, pool's 60% excluded
  assert.equal(r.safety.lpLockedPct, 100);
  assert.ok(r.safety.mintRevoked && r.safety.freezeRevoked);
});

test('rejects: mint/freeze authority, LP unlocked, concentration, insiders, creator, danger, rugged, missing data', () => {
  const cases = [
    [{ mintAuthority: 'Abc', token: { mintAuthority: 'Abc', supply: 1e15 } }, /mint authority/],
    [{ freezeAuthority: 'Abc' }, /freeze authority/],
    [{ markets: [{ pubkey: POOL, lp: { lpLockedPct: 40 } }] }, /LP locked/],
    [{ markets: [] }, /LP lock unknown/],
    [{ topHolders: Array.from({ length: 10 }, (_, i) => ({ address: `A${i}`, owner: `B${i}`, pct: 5 })) }, /top10/],
    [{ topHolders: [{ address: 'a', owner: 'b', pct: 18, insider: true }] }, /insiders/],
    [{ creatorBalance: 1e14 }, /creator holds/],
    [{ risks: [{ name: 'Low Liquidity', level: 'danger' }] }, /danger/],
    [{ rugged: true }, /rugged/],
    [{ totalHolders: 40 }, /holders/],
    [{ graphInsidersDetected: 500, totalHolders: 900 }, /insider network/],
  ];
  for (const [o, re] of cases) {
    const r = analyzeReport(fakeReport(o), ctx, S);
    assert.ok(r.reasons.some((x) => re.test(x)), `${re} not in ${r.reasons}`);
  }
  assert.ok(analyzeReport(null, ctx, S).reasons.length);
});

test('loosened limits still pass borderline-OK tokens', () => {
  const h = Array.from({ length: 10 }, (_, i) => ({ address: `A${i}`, owner: `B${i}`, pct: 3.4, insider: i === 0 }));
  const r = analyzeReport(fakeReport({ topHolders: h, markets: [{ pubkey: POOL, lp: { lpLockedPct: 85 } }], totalHolders: 250, creatorBalance: 7e13 }), ctx, S);
  assert.deepEqual(r.reasons, []); // top10 34%, LP 85%, 250 holders, creator 7%
});

test('RPC cross-check overrides a stale "revoked" report', () => {
  const r = analyzeReport(fakeReport(), { ...ctx, rpc: { mintAuthority: 'Xyz', freezeAuthority: null } }, S);
  assert.ok(r.reasons.some((x) => /mint authority/.test(x)));
});

test('rug detection: -80% price or -70% liquidity, sticky', () => {
  assert.equal(isRugged({ currentMultiple: 0.19, liquidity: 40000, currentLiquidity: 30000 }), true);
  assert.equal(isRugged({ currentMultiple: 0.5, liquidity: 40000, currentLiquidity: 11000 }), true);
  assert.equal(isRugged({ currentMultiple: 0.5, liquidity: 40000, currentLiquidity: 20000 }), false);
  assert.equal(isRugged({ currentMultiple: 3, liquidity: 40000, currentLiquidity: 500 }), true);
  assert.equal(isRugged({ status: 'rugged', currentMultiple: 2 }), true);
});

test('safety line in Telegram post is escaped + formatted', () => {
  const line = safetyLine({ mintRevoked: true, freezeRevoked: true, lpLockedPct: 100, top10Pct: 18.4 });
  assert.equal(line, '🛡 Mint ✅ | Freeze ✅ | LP 🔥 100% | Top10 18%');
  const ca = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
  const html = callMessage({ name: 'a', symbol: 'b', dex: 'pumpswap', address: ca, change: {}, links: links(ca, POOL), score: 80,
    safety: { mintRevoked: true, freezeRevoked: false, lpLockedPct: null, top10Pct: 10 } }, CFG);
  assert.match(html, /Freeze ❌ \| LP 🔥 \?/);
});
