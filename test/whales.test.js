// Whale Watcher: exclusion rules, diff logic, thresholds, anti-spam caps, engine cycle (mocked network), escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { W, runWhales, whaleAlertMessage, whaleAlertButtons, prune } from '../src/whales.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b) break; s = '1' + s; }
  return s;
}
/** Real ed25519 public key (on the curve) = a normal user wallet. */
const wallet = () => b58(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const PDA = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC'; // Meteora pool authority (off-curve)
const RAY_AUTH = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const MINT = 'So11111111111111111111111111111111111111112';
const NOW = Date.parse('2026-10-10T06:00:00Z');
const MIN = 60000;

test('on-curve check: wallets yes, PDAs / garbage no', () => {
  for (let i = 0; i < 20; i++) assert.equal(W.isOnCurve(wallet()), true);
  assert.equal(W.isOnCurve(PDA), false);
  assert.equal(W.isOnCurve(RAY_AUTH), false);
  assert.equal(W.isOnCurve('not-an-address'), false);
  assert.equal(W.isOnCurve('<img src=x onerror=alert(1)>'), false);
});

test('exclusions: burn, CEX, launchpad fee, pools/lockers (RugCheck labels + markets), program-owned, mint', () => {
  const pool = wallet(), locker = wallet(), mktAcct = wallet(), person = wallet();
  const r = { mint: MINT, knownAccounts: { [pool]: { type: 'AMM', name: 'Raydium' }, [locker]: { type: 'LOCKER', name: 'Streamflow' }, [person]: { type: 'CREATOR', name: 'Creator' } }, markets: [{ pubkey: wallet(), liquidityA: mktAcct, liquidityAAccount: { owner: wallet() } }] };
  const ex = W.excludedFromReport(r, null);
  const ctx = { excluded: ex, mint: MINT };
  assert.equal(W.excludeReason('1nc1nerator11111111111111111111111111111111', null, ctx), 'burn');
  assert.match(W.excludeReason('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', null, ctx), /^cex/);
  assert.equal(W.excludeReason('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', null, ctx), 'pump.fun fee');
  assert.equal(W.excludeReason(pool, null, ctx), 'pool/locker');
  assert.equal(W.excludeReason(locker, null, ctx), 'pool/locker');
  assert.equal(W.excludeReason(wallet(), mktAcct, ctx), 'pool/locker'); // pool vault token account
  assert.equal(W.excludeReason(PDA, null, ctx), 'program-owned');
  assert.equal(W.excludeReason(person, null, ctx), null); // creator is a real wallet (flagged as dev, not excluded)
  assert.equal(W.excludeReason('"><script>', null, ctx), 'invalid');
});

function report({ holders, creator = null, supply = 1e15, decimals = 6, known = {} }) {
  return { mint: MINT, creator, token: { supply, decimals }, knownAccounts: known, markets: [], topHolders: holders.map((h) => ({ address: h.acc, owner: h.o, uiAmount: h.a, pct: (h.a / (supply / 10 ** decimals)) * 100, insider: !!h.ins })) };
}

test('snapshotFromReport: drops pools/PDAs, aggregates owners, flags dev + insider, keeps cut-off', () => {
  const a = wallet(), b = wallet(), dev = wallet(), pool = wallet();
  const r = report({ creator: dev, known: { [pool]: { type: 'AMM' } }, holders: [
    { acc: wallet(), o: pool, a: 9e7 }, { acc: wallet(), o: PDA, a: 8e7 }, { acc: wallet(), o: a, a: 3e7 }, { acc: wallet(), o: a, a: 1e7, ins: 1 },
    { acc: wallet(), o: dev, a: 2e7 }, { acc: wallet(), o: b, a: 5e6 },
  ] });
  const s = W.snapshotFromReport(r);
  const list = W.owners(s);
  assert.deepEqual([...list.map((x) => x.o)], [a, dev, b]);
  assert.equal(list[0].a, 4e7); assert.equal(list[0].ins, 1); assert.equal(list[1].dev, 1);
  assert.equal(+list[0].pct.toFixed(2), 4);
  assert.equal(s.cut, 5e6);
  assert.equal(W.top10Pct(list), 6.5);
});

test('diff: buy / sell / exit / new (conservative), dust + unknown balances ignored', () => {
  const a = wallet(), b = wallet(), c = wallet(), d = wallet(), e = wallet();
  const L = (arr) => arr.map(([o, amt, x = {}]) => ({ o, a: amt, pct: amt / 1e7, ins: 0, dev: 0, ...x }));
  const prev = L([[a, 1e8], [b, 5e7], [c, 3e7], [e, 2e7]]);
  const cur = L([[a, 1.5e8], [b, 2e7], [d, 4e7]]); // c exited, e absent
  const ev = W.diff(prev, cur, { supply: 1e9, prevCut: 1e7, balances: { [e]: 2e7 + 5 }, complete: true });
  const by = Object.fromEntries(ev.map((x) => [x.o, x]));
  assert.equal(by[a].k, 'buy'); assert.equal(by[a].d, 5e7); assert.equal(by[a].dp, 5); assert.equal(by[a].chg, 50);
  assert.equal(by[b].k, 'sell'); assert.equal(by[b].d, 3e7); assert.equal(by[b].hp, 2);
  assert.equal(by[c].k, 'exit'); assert.equal(by[c].hp, 0); assert.equal(by[c].prevRank, 3);
  assert.equal(by[d].k, 'new'); assert.equal(by[d].d, 3e7); assert.equal(by[d].min, true); // ≥ holding − previous cut-off
  assert.equal(by[e], undefined); // +5 tokens = dust
  const unknown = W.diff(prev, cur, { supply: 1e9 }); // no balances, not complete → no exit event for c
  assert.equal(unknown.some((x) => x.o === c), false);
});

test('notable + alert thresholds (pct AND usd), eligibility, insider/dev sells', () => {
  const A = { minPct: 1, minUsd: 5000, insiderMinPct: 0.25, insiderMinUsd: 1000, topHolderRank: 10 };
  const ev = (o) => ({ k: 'sell', dp: 1.5, prevRank: 3, rank: 3, ins: 0, dev: 0, ...o });
  assert.equal(W.alertReason(ev(), 6000, A), 'big-sell');
  assert.equal(W.alertReason(ev(), 4000, A), null);            // under $5k
  assert.equal(W.alertReason(ev({ dp: 0.8 }), 90000, A), null); // under 1% of supply
  assert.equal(W.alertReason(ev({ k: 'exit' }), 6000, A), 'big-exit');
  assert.equal(W.alertReason(ev({ k: 'buy' }), 6000, A), 'big-buy');
  assert.equal(W.alertReason(ev({ k: 'new', rank: 7, prevRank: null }), 6000, A), 'big-buy');
  assert.equal(W.alertReason(ev({ prevRank: 14 }), 6000, A), null);       // not a top-10 holder
  assert.equal(W.alertReason(ev({ prevRank: 14 }), 6000, A, true), 'big-sell'); // …but a global top-15 whale
  assert.equal(W.alertReason(ev({ dp: 0.3, ins: 1, prevRank: 18 }), 1500, A), 'insider-sell');
  assert.equal(W.alertReason(ev({ dp: 0.3, dev: 1, prevRank: 18 }), 1500, A), 'dev-sell');
  assert.equal(W.alertReason(ev({ k: 'buy', dp: 0.3, ins: 1 }), 1500, A), null); // insider BUY is not special
  assert.equal(W.alertReason(ev({ dp: 0.1, ins: 1 }), 900, A), null);
  assert.equal(W.notable({ dp: 0.05 }, 3000, {}), true);
  assert.equal(W.notable({ dp: 0.2 }, 50, {}), false); // below USD floor
  assert.equal(W.notable({ dp: 0.02 }, 400, {}), false);
});

test('anti-spam caps: 1 per coin per hour, max 6 per rolling day', () => {
  const A = { coinCooldownMinutes: 60, maxPerDay: 6 };
  const log = [{ ca: 'X', t: NOW - 30 * MIN }, { ca: 'Y', t: NOW - 61 * MIN }];
  let r = W.applyCaps([{ ca: 'X' }, { ca: 'Y' }, { ca: 'Z' }], log, NOW, A);
  assert.deepEqual([...r.allowed], ['Y', 'Z']); assert.equal(r.blocked.X, 'coin cooldown');
  const full = Array.from({ length: 6 }, (_, i) => ({ ca: 'C' + i, t: NOW - (2 + i) * 3600e3 }));
  r = W.applyCaps([{ ca: 'N1' }], full, NOW, A);
  assert.deepEqual([...r.allowed], []); assert.equal(r.blocked.N1, 'daily cap');
  r = W.applyCaps([{ ca: 'N1' }, { ca: 'N2' }], full.slice(1).concat([{ ca: 'old', t: NOW - 25 * 3600e3 }]), NOW, A);
  assert.deepEqual([...r.allowed], ['N1']); assert.equal(r.blocked.N2, 'daily cap');
});

// ---- engine cycle with mocked network ----
function world() {
  const holders = Array.from({ length: 12 }, (_, i) => ({ o: wallet(), acc: wallet(), a: (12 - i) * 1e7 })); // 12%..1% of 1B supply
  holders[4].ins = 1;
  const dev = holders[6].o;
  const chain = new Map(holders.map((h) => [h.acc, { o: h.o, a: h.a, mint: null }]));
  return { holders, dev, chain };
}
const CA1 = 'Ce11111111111111111111111111111111111111pump';
function setup(symbol = 'WHL') {
  const w = world();
  for (const v of w.chain.values()) v.mint = CA1;
  const call = { address: CA1, symbol, name: symbol, status: 'active', calledAt: new Date(NOW - 3600e3).toISOString(), currentPrice: 0.001, pairAddress: null, tg: { messageId: 42 } };
  const deps = {
    fetchRugcheck: async () => report({ creator: w.dev, supply: 1e15, decimals: 6, holders: w.holders.map((h) => ({ acc: h.acc, o: h.o, a: w.chain.get(h.acc).a, ins: h.ins })) }),
    fetchBalances: async (accs) => new Map(accs.filter((a) => w.chain.has(a)).map((a) => [a, { ...w.chain.get(a) }])),
    rpcLargest: async () => null, // public RPC rate-limited → RugCheck discovery
  };
  return { w, call, deps };
}
const cfg = { siteUrl: 'https://maxigems.fun/', trackDays: 7, whales: { holdersPerRun: 5 } };

test('runWhales: first snapshot is baseline only, then diffs → feed + batched alert (reply under the call), caps hold', async () => {
  const { w, call, deps } = setup();
  const posts = [];
  const post = async (c, html, buttons) => { posts.push({ c, html, buttons }); return true; };
  let r = await runWhales({ calls: [call], cfg, now: NOW, store: {}, deps, post });
  assert.equal(r.stats.baselined, 1); assert.equal(r.movesFile.moves.length, 0); assert.equal(posts.length, 0);
  assert.equal(r.pub.coins[CA1].holders.length, 10);
  assert.equal(r.pub.whales.length, 12 > 15 ? 15 : 12);
  assert.equal(r.pub.whales[0].usd, 120000); // 1.2e8 tokens × $0.001

  // whale #1 dumps 5% ($50k), #2 adds 2%, the insider (rank 5) exits, dev sells 0.5%
  w.chain.get(w.holders[0].acc).a = 7e7;
  w.chain.get(w.holders[1].acc).a = 1.3e8;
  w.chain.get(w.holders[4].acc).a = 0;
  w.chain.get(w.holders[6].acc).a = 6e7 - 5e6;
  r = await runWhales({ calls: [call], cfg, now: NOW + 20 * MIN, store: r.store, prevMoves: r.movesFile.moves, deps, post });
  const kinds = r.movesFile.moves.map((m) => m.k).sort();
  assert.deepEqual(kinds, ['buy', 'exit', 'sell', 'sell']);
  assert.equal(posts.length, 1, 'all moves on one coin → ONE batched message');
  assert.match(posts[0].html, /🐳 <b>Whale alert — \$WHL<\/b>/);
  assert.match(posts[0].html, /🚨 <b>Dev wallet<\/b>/);
  assert.match(posts[0].html, /🚪 <b>Exited<\/b> ⚠️ <b>Insider<\/b>/);
  assert.match(posts[0].html, /href="https:\/\/solscan\.io\/account\//);
  assert.deepEqual(posts[0].buttons[0].map((b) => b.url), [`https://maxigems.fun/c/${CA1}/`, 'https://maxigems.fun/whales/']);
  assert.equal(posts[0].c.tg.messageId, 42);
  assert.ok(r.movesFile.moves.filter((m) => m.al).length >= 3);
  assert.equal(r.store.alerts.length, 1);

  // another big sell 20 min later → same coin inside the 1h cooldown → suppressed, still in the feed
  w.chain.get(w.holders[1].acc).a = 5e7;
  r = await runWhales({ calls: [call], cfg, now: NOW + 40 * MIN, store: r.store, prevMoves: r.movesFile.moves, deps, post });
  assert.equal(posts.length, 1); assert.equal(r.stats.blocked, 1);
  assert.equal(r.movesFile.moves[0].k, 'sell'); assert.equal(r.movesFile.moves[0].al, 0);

  // after the cooldown it may alert again
  w.chain.get(w.holders[1].acc).a = 2e7;
  r = await runWhales({ calls: [call], cfg, now: NOW + 90 * MIN, store: r.store, prevMoves: r.movesFile.moves, deps, post });
  assert.equal(posts.length, 2);
});

test('runWhales: rugged / expired coins dropped, failed balance reads never invent moves, no post when mode off', async () => {
  const { w, call, deps } = setup();
  let r = await runWhales({ calls: [call], cfg, now: NOW, store: {}, deps });
  w.chain.get(w.holders[0].acc).a = 1e6;
  const broken = { ...deps, fetchBalances: async () => new Map() };
  r = await runWhales({ calls: [call], cfg, now: NOW + 20 * MIN, store: r.store, deps: broken });
  assert.equal(r.movesFile.moves.length, 0);
  r = await runWhales({ calls: [call], cfg, now: NOW + 40 * MIN, store: r.store, deps }); // post=null (site-only)
  assert.equal(r.movesFile.moves.length, 1); assert.equal(r.alerts.length, 1); assert.equal(r.stats.alerts, 0);
  assert.equal(r.store.alerts.length, 0, 'unposted alerts do not consume the caps');
  r = await runWhales({ calls: [{ ...call, status: 'rugged' }], cfg, now: NOW + 60 * MIN, store: r.store, deps });
  assert.deepEqual(Object.keys(r.store.coins), []); assert.equal(r.pub.whales.length, 0);
});

test('alert message escapes hostile symbols / never trusts addresses', () => {
  const call = { address: CA1, symbol: '<b>x</b>&"', name: 'x' };
  const html = whaleAlertMessage(call, [{ k: 'sell', o: wallet(), d: 1e6, usd: 9000, dp: 2, hp: 1, chg: -50, ins: 0, dev: 0, min: 0 }], cfg);
  assert.match(html, /\$&lt;b&gt;x&lt;\/b&gt;&amp;&quot;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.equal(whaleAlertButtons({ address: 'bad' }, { siteUrl: 'https://maxigems.fun/' })[0].length, 1); // only the whales button
});

test('prune keeps top N owners and raises the cut-off', () => {
  const s = { supply: 1e9, accts: {} };
  for (let i = 0; i < 25; i++) s.accts[wallet()] = { o: wallet(), a: (i + 1) * 1e6 };
  const p = prune(s, 20);
  assert.equal(Object.keys(p.accts).length, 20);
  assert.equal(p.cut, 5e6);
});
