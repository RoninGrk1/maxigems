// Leaderboard maths (site/assets/leaderboard-core.js) + engine peak MC / peak timestamp export & backfill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { backfillPeak, siteData } from '../src/engine.js';

const ctx = {};
vm.runInNewContext(fs.readFileSync(new URL('../site/assets/leaderboard-core.js', import.meta.url), 'utf8'), { globalThis: ctx, window: ctx });
const LB = ctx.MGLB;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = 3600e3;
const call = (o) => ({ address: 'So' + Math.random().toString(36).slice(2), symbol: 'T', name: 'T', calledAt: new Date(NOW - H).toISOString(), athMultiple: 1, currentMultiple: 1, status: 'active', ...o });

test('median / mean', () => {
  assert.equal(LB.median([]), null);
  assert.equal(LB.median([5]), 5);
  assert.equal(LB.median([3, 1, 2]), 2);
  assert.equal(LB.median([4, 1, 3, 2]), 2.5);
  assert.equal(LB.median([1, 'x', null, 9]), 5);
  assert.equal(LB.mean([1, 2, 3, 6]), 3);
  assert.equal(LB.mean([]), null);
});

test('peakX never below 1 or below current multiple', () => {
  assert.equal(LB.peakX({ athMultiple: 3.2, currentMultiple: 1.1 }), 3.2);
  assert.equal(LB.peakX({ athMultiple: 1.5, currentMultiple: 2 }), 2);
  assert.equal(LB.peakX({ athMultiple: null, currentMultiple: 0.2 }), 1);
  assert.equal(LB.peakX({}), 1);
});

test('periods: 24h / 7d / 30d / all, future and bad timestamps excluded', () => {
  const calls = [
    call({ calledAt: new Date(NOW - 2 * H).toISOString() }),
    call({ calledAt: new Date(NOW - 30 * H).toISOString() }),
    call({ calledAt: new Date(NOW - 10 * 24 * H).toISOString() }),
    call({ calledAt: new Date(NOW - 40 * 24 * H).toISOString() }),
    call({ calledAt: new Date(NOW + 5 * H).toISOString() }),
    call({ calledAt: 'garbage' }),
  ];
  assert.equal(LB.filterPeriod(calls, '24h', NOW).length, 1);
  assert.equal(LB.filterPeriod(calls, '7d', NOW).length, 2);
  assert.equal(LB.filterPeriod(calls, '30d', NOW).length, 3);
  assert.equal(LB.filterPeriod(calls, 'all', NOW).length, 6);
  assert.equal(LB.filterPeriod(calls, 'bogus', NOW).length, 6);
});

test('stats: hit rates, avg/median, best, rug rate include rugged calls', () => {
  const calls = [
    call({ symbol: 'A', athMultiple: 12 }),
    call({ symbol: 'B', athMultiple: 5, status: 'rugged', currentLiquidity: 50000, liquidity: 60000 }),
    call({ symbol: 'C', athMultiple: 2.5 }),
    call({ symbol: 'D', athMultiple: 1.2, status: 'rugged', currentLiquidity: 10, liquidity: 60000 }),
    call({ symbol: 'E', athMultiple: 1 }),
  ];
  const s = LB.stats(calls);
  assert.equal(s.total, 5);
  assert.deepEqual([s.hits[2].count, s.hits[5].count, s.hits[10].count], [3, 2, 1]);
  assert.equal(s.hits[2].pct, 60);
  assert.equal(s.hits[10].pct, 20);
  assert.equal(s.medianPeak, 2.5);
  assert.ok(Math.abs(s.avgPeak - (12 + 5 + 2.5 + 1.2 + 1) / 5) < 1e-9);
  assert.equal(s.best.symbol, 'A');
  assert.equal(s.rugs.count, 2);
  assert.equal(s.rugs.pct, 40);
  const empty = LB.stats([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.hits[2].pct, 0);
  assert.equal(empty.medianPeak, null);
  assert.equal(empty.best, null);
});

test('status: live / rugged / liquidity pulled', () => {
  assert.equal(LB.statusOf(call({})), 'live');
  assert.equal(LB.statusOf(call({ status: 'rugged', currentLiquidity: 40000, liquidity: 50000 })), 'rugged');
  assert.equal(LB.statusOf(call({ status: 'rugged', currentLiquidity: 500, liquidity: 50000 })), 'pulled');
  assert.equal(LB.statusOf(call({ status: 'rugged', currentLiquidity: 2000, liquidity: 80000 })), 'pulled');
  assert.equal(LB.statusOf(call({ status: 'rugged' })), 'rugged');
});

test('ranking + sorting: ties → earlier call ranks higher; nulls last; search', () => {
  const a = call({ symbol: 'OLD', athMultiple: 2, calledAt: new Date(NOW - 5 * H).toISOString(), mcAtCall: null });
  const b = call({ symbol: 'NEW', athMultiple: 2, calledAt: new Date(NOW - 1 * H).toISOString(), mcAtCall: 5e5 });
  const c = call({ symbol: 'TOP', name: 'Moon Dog', athMultiple: 7, mcAtCall: 1e5 });
  const r = LB.ranked([b, a, c]);
  assert.deepEqual(r.map((x) => [x.rank, x.call.symbol]), [[1, 'TOP'], [2, 'OLD'], [3, 'NEW']]);
  assert.deepEqual(LB.sortCalls([a, b, c], 'mc', 'desc').map((x) => x.symbol), ['NEW', 'TOP', 'OLD']);
  assert.deepEqual(LB.sortCalls([a, b, c], 'mc', 'asc').map((x) => x.symbol), ['TOP', 'NEW', 'OLD']);
  assert.deepEqual(LB.sortCalls([a, b, c], 'token', 'asc').map((x) => x.symbol), ['NEW', 'OLD', 'TOP']);
  assert.ok(LB.matches(c, '$top') && LB.matches(c, 'moon') && LB.matches(c, '') && !LB.matches(c, 'zzz'));
  assert.ok(LB.matches(c, c.address.slice(2, 8)));
});

test('engine backfills peak MC + peak timestamp and exports them', () => {
  const old = { address: 'X', calledAt: '2026-10-08T10:00:00.000Z', lastUpdated: '2026-10-09T10:00:00.000Z', mcAtCall: 100000, athMultiple: 2.5 };
  backfillPeak(old);
  assert.equal(old.athMc, 250000);
  assert.equal(old.athAt, '2026-10-08T10:00:00.000Z');
  const kept = backfillPeak({ calledAt: '2026-10-08T10:00:00.000Z', mcAtCall: 1, athMultiple: 3, athMc: 777, athAt: '2026-10-08T12:00:00.000Z' });
  assert.equal(kept.athMc, 777);
  assert.equal(kept.athAt, '2026-10-08T12:00:00.000Z');
  const state = { calls: [{ address: 'Y', calledAt: '2026-10-08T10:00:00.000Z', mcAtCall: 50000, athMultiple: 1.4, status: 'rugged', ruggedAt: '2026-10-08T11:00:00.000Z' }] };
  const out = siteData(state, { telegramChannelUrl: 'https://t.me/x' }, NOW).calls[0];
  assert.equal(out.athMc, 70000);
  assert.equal(out.peakMc, 70000);
  assert.equal(out.athAt, '2026-10-08T10:00:00.000Z');
  assert.equal(out.peakAt, out.athAt);
  assert.equal(out.ruggedAt, '2026-10-08T11:00:00.000Z');
  assert.equal(state.calls[0].athMc, undefined, 'siteData must not mutate stored state');
});
