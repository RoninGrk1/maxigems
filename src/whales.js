// Whale Watcher engine: holder snapshots for called coins → diffs → moves feed, top whales, Telegram alerts.
// Free keyless sources: Solana public RPC (balances of tracked token accounts every run; getTokenLargestAccounts
// when it isn't rate-limited) + RugCheck /report (baseline, labels, insider/creator flags) on a rotating batch.
// Never throws: any failure leaves the previous data in place.
import fs from 'node:fs';
import vm from 'node:vm';
import { fetchJson, chunk, num, log, sleep, escapeHtml as e, fmtUsd, safeUrl } from './util.js';
import { fetchRugcheck } from './safety.js';
import { coinPageUrl } from './format.js';

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const DAY = 86400000;

const ctx = {};
vm.runInNewContext(fs.readFileSync(new URL('../site/assets/whales-core.js', import.meta.url), 'utf8'), { globalThis: ctx, window: ctx, BigInt });
export const W = ctx.MGWH;

export const DEFAULTS = {
  enabled: true, holdersPerRun: 10, timeBudgetSeconds: 60, trackHolders: 20, publicHolders: 10, topWhales: 15,
  megaWhaleUsd: 100000, feedMinPct: 0.1, feedMinUsd: 2500, feedFloorUsd: 100, maxMoves: 200,
  alerts: { enabled: true, minPct: 1, minUsd: 5000, insiderMinPct: 0.25, insiderMinUsd: 1000, coinCooldownMinutes: 60, maxPerDay: 6, topHolderRank: 10, maxLinesPerAlert: 4 },
};
export const whaleCfg = (cfg) => ({ ...DEFAULTS, ...(cfg?.whales ?? {}), alerts: { ...DEFAULTS.alerts, ...(cfg?.whales?.alerts ?? {}) } });

const rpc = (method, params) => fetchJson(RPC, { method: 'POST', retries: 1, timeoutMs: 15000, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

/** Current balances of token accounts. Map<account, {o, a}> (closed account → a:0). Accounts missing from the map = unknown. */
export async function fetchBalances(accounts) {
  const out = new Map();
  for (const batch of chunk([...new Set(accounts)].filter(W.isSol), 100)) {
    try {
      const d = await rpc('getMultipleAccounts', [batch, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const vals = d?.result?.value;
      if (!Array.isArray(vals)) continue;
      vals.forEach((acc, i) => {
        if (acc === null) { out.set(batch[i], { o: null, a: 0 }); return; }
        const info = acc?.data?.parsed?.info;
        const a = num(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount);
        if (info && a !== null) out.set(batch[i], { o: info.owner, a, mint: info.mint });
      });
    } catch (err) {
      log(`WARN whales balances batch failed (${err.message}); trying fallback RPC`);
      try { await fallbackBatch(batch, out); } catch (err2) { log(`WARN whales fallback RPC failed: ${err2.message}`); }
    }
  }
  return out;
}

const FALLBACK_RPC = 'https://solana-rpc.publicnode.com'; // keyless; serves getMultipleAccounts (not indexed methods)
async function fallbackBatch(batch, out) {
  if (batch.length > 10) { for (const part of chunk(batch, 10)) await fallbackBatch(part, out); return; } // PublicNode: ≤10 accounts/call
  const d = await fetchJson(FALLBACK_RPC, { method: 'POST', retries: 1, timeoutMs: 15000, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [batch, { encoding: 'jsonParsed', commitment: 'confirmed' }] }) });
  (d?.result?.value ?? []).forEach((acc, i) => {
    if (acc === null) { out.set(batch[i], { o: null, a: 0 }); return; }
    const info = acc?.data?.parsed?.info;
    const a = num(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount);
    if (info && a !== null) out.set(batch[i], { o: info.owner, a, mint: info.mint });
  });
}

/** Largest token accounts via RPC (often rate-limited on the public endpoint → returns null). */
async function rpcLargest(mint) {
  try {
    const d = await fetchJson(RPC, { method: 'POST', retries: 0, timeoutMs: 12000, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [mint, { commitment: 'confirmed' }] }) });
    const v = d?.result?.value;
    return Array.isArray(v) && v.length ? v.map((x) => ({ address: x.address, a: num(x.uiAmountString ?? x.uiAmount) })) : null;
  } catch { return null; }
}

/** Snapshot → owner list with % (uses snap.supply). */
const ownersOf = (snap) => W.owners(snap);

/** Keep the top N owners' accounts; returns pruned snapshot + the largest dropped amount (raises the cut-off). */
export function prune(snap, n) {
  const list = ownersOf(snap);
  const keep = new Set(list.slice(0, n).map((x) => x.o));
  let dropped = 0;
  for (const x of list.slice(n)) dropped = Math.max(dropped, x.a);
  const accts = {};
  for (const [k, v] of Object.entries(snap.accts ?? {})) if (keep.has(v.o) && num(v.a) > 0) accts[k] = v;
  return { ...snap, accts, cut: Math.max(num(snap.cut) ?? 0, dropped) };
}

const fmtTok = (v) => {
  const n = num(v); if (n === null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};
const fmtP = (v) => { const n = num(v); return n === null ? '?' : `${n >= 10 ? n.toFixed(1) : n.toFixed(2)}%`; };
const KIND = { buy: ['🟢', 'Bought more'], sell: ['🔴', 'Sold'], exit: ['🚪', 'Exited'], new: ['🆕', 'New whale entered top holders'] };

/** Telegram HTML for one coin's batched moves. Everything dynamic is escaped. */
export function whaleAlertMessage(call, moves, cfg, max = 4) {
  const lines = [`🐳 <b>Whale alert — $${e(call.symbol)}</b>`, ''];
  for (const m of moves.slice(0, max)) {
    const [ico, label] = KIND[m.k] ?? ['•', m.k];
    const tag = m.dev ? ' 🚨 <b>Dev wallet</b>' : m.ins ? ' ⚠️ <b>Insider</b>' : '';
    lines.push(`${ico} <b>${e(label)}</b>${tag}`);
    lines.push(`👛 <a href="${e(`https://solscan.io/account/${m.o}`)}">${e(W.shortAddr(m.o))}</a>`);
    lines.push(`📦 ${m.min ? '≥' : ''}${e(fmtTok(m.d))} tokens · ${m.min ? '≥' : ''}${e(fmtUsd(m.usd))} · ${m.min ? '≥' : ''}${e(fmtP(m.dp))} of supply`);
    lines.push(`📊 Now holds ${e(fmtP(m.hp))}${m.chg !== null && m.chg !== undefined && m.k !== 'exit' ? ` (${m.chg > 0 ? '+' : ''}${e(Math.round(m.chg))}%)` : ''}`);
    lines.push('');
  }
  if (moves.length > max) lines.push(`…and ${e(moves.length - max)} more on the whales page`, '');
  lines.push(`📋 <code>${e(call.address)}</code>`);
  lines.push('<i>On-chain holder balances, checked every bot run. Wallet transfers can look like sells. NFA.</i>');
  return lines.join('\n');
}

export function whaleAlertButtons(call, cfg) {
  const row = [];
  const page = coinPageUrl(call, cfg);
  if (page) row.push({ text: '💎 Track & Share', url: page });
  const site = safeUrl(cfg.siteUrl);
  if (site) row.push({ text: '🐳 Whales', url: new URL('whales/', site.endsWith('/') ? site : site + '/').toString() });
  return row.length ? [row] : undefined;
}

const tracked = (calls, cfg, now) => calls.filter((c) => c && W.isSol(c.address) && c.status !== 'rugged' && now - Date.parse(c.calledAt) < (cfg.trackDays ?? 7) * DAY);

/**
 * One whale cycle. store = data/holders.json contents (mutated + returned). reports = Map<ca, rugcheck report> already fetched this run.
 * post(call, html, buttons) → Promise<boolean posted>. Returns {store, pub, movesFile, alerts, stats}.
 */
export async function runWhales({ calls, cfg, now = Date.now(), store, prevMoves = [], reports = new Map(), post = null, deps = {} }) {
  const wc = whaleCfg(cfg);
  const t0 = Date.now();
  const getBalances = deps.fetchBalances ?? fetchBalances;
  const getReport = deps.fetchRugcheck ?? fetchRugcheck;
  const getLargest = deps.rpcLargest ?? rpcLargest;
  const stats = { tracked: 0, baselined: 0, refreshed: 0, discovered: 0, events: 0, alerts: 0, blocked: 0, src: {} };
  store = store && typeof store === 'object' ? store : {};
  store.coins = store.coins && typeof store.coins === 'object' ? store.coins : {};
  store.alerts = Array.isArray(store.alerts) ? store.alerts.filter((x) => x && now - x.t < 2 * DAY) : [];
  const prevWhales = new Set(Array.isArray(store.whales) ? store.whales : []);
  const coins = tracked(calls, cfg, now);
  stats.tracked = coins.length;
  const byCa = new Map(coins.map((c) => [c.address, c]));
  for (const ca of Object.keys(store.coins)) if (!byCa.has(ca)) delete store.coins[ca]; // rugged / out of window

  const prev = {}; // ca → snapshot before this run (only coins that already had a baseline)
  for (const ca of Object.keys(store.coins)) prev[ca] = JSON.parse(JSON.stringify(store.coins[ca]));
  const fresh = (r, c, src) => {
    const s = W.snapshotFromReport(r, { pairAddress: c.pairAddress, mint: c.address });
    if (!s || !Object.keys(s.accts).length || !num(s.supply)) return null;
    return { ...s, at: now, bat: now, src };
  };

  // 1) baselines from reports fetched by the safety check this run (new calls): no extra API calls
  for (const [ca, r] of reports) {
    const c = byCa.get(ca);
    if (!c || store.coins[ca]) continue;
    const s = fresh(r, c, 'rugcheck');
    if (s) { store.coins[ca] = prune(s, wc.trackHolders); stats.baselined++; }
  }

  // 2) exact current balances of every tracked token account (batched RPC, fresh every run)
  const accts = [];
  for (const ca of Object.keys(prev)) accts.push(...Object.keys(prev[ca].accts ?? {}));
  const bal = accts.length ? await getBalances(accts) : new Map();
  const balOk = {}; // ca → all balances known
  for (const ca of Object.keys(prev)) {
    const s = store.coins[ca];
    let ok = true;
    for (const [acc, v] of Object.entries(s.accts ?? {})) {
      const b = bal.get(acc);
      if (!b) { ok = false; continue; }
      if (b.mint && b.mint !== ca) continue; // not this token's account (shouldn't happen)
      if (b.o && b.o !== v.o) { v.o = b.o; } // account ownership moved (rare)
      v.a = b.a;
    }
    balOk[ca] = ok;
    if (ok) { s.bat = now; stats.refreshed++; }
  }

  // 3) rotating discovery: coins without a baseline first, then the stalest holder lists
  const budget = wc.timeBudgetSeconds * 1000;
  const order = coins.map((c) => c.address).sort((a, b) => (store.coins[a] ? store.coins[a].at ?? 0 : -1) - (store.coins[b] ? store.coins[b].at ?? 0 : -1));
  let rpcLargestOk = true;
  const discoveredNew = [];
  for (const ca of order.slice(0, wc.holdersPerRun)) {
    if (Date.now() - t0 > budget) { log('whales: time budget reached, rotation continues next run'); break; }
    const c = byCa.get(ca);
    const s = store.coins[ca];
    if (s && s.at === now) continue; // baselined this run
    if (!s) {
      let r = null;
      try { r = await getReport(ca); } catch (err) { log(`WARN whales rugcheck ${c.symbol}: ${err.message}`); }
      const b = r && fresh(r, c, 'rugcheck');
      if (b) { store.coins[ca] = prune(b, wc.trackHolders); stats.baselined++; stats.src.rugcheck = (stats.src.rugcheck ?? 0) + 1; }
      continue;
    }
    let list = rpcLargestOk ? await getLargest(ca) : null;
    if (list) {
      stats.src.rpc = (stats.src.rpc ?? 0) + 1;
      const cut = Math.min(...list.map((x) => x.a ?? Infinity));
      const unknown = list.filter((x) => !s.accts[x.address]).map((x) => x.address);
      const info = unknown.length ? await getBalances(unknown) : new Map();
      for (const x of list) {
        if (s.accts[x.address]) continue;
        const b = info.get(x.address);
        if (!b || !b.o || W.excludeReason(b.o, x.address, { excluded: s.ex ?? {}, mint: ca })) continue;
        s.accts[x.address] = { o: b.o, a: b.a, ins: 0 };
        discoveredNew.push(x.address);
      }
      s.cut = Number.isFinite(cut) ? cut : s.cut;
      s.at = now; s.src = 'rpc';
    } else {
      rpcLargestOk = false; // public RPC rate-limits this method: fall back to RugCheck for the rest of the run
      let r = null;
      try { r = await getReport(ca); } catch (err) { log(`WARN whales rugcheck ${c.symbol}: ${err.message}`); }
      const f = r && W.snapshotFromReport(r, { pairAddress: c.pairAddress, mint: ca });
      if (!f) continue;
      stats.src.rugcheck = (stats.src.rugcheck ?? 0) + 1;
      // RugCheck holder lists can be cached/stale: use it to DISCOVER accounts + flags; amounts are re-read on-chain below
      for (const [acc, v] of Object.entries(f.accts)) {
        if (s.accts[acc]) { if (v.ins) s.accts[acc].ins = 1; continue; }
        s.accts[acc] = { ...v };
        discoveredNew.push(acc);
      }
      s.ex = { ...(s.ex ?? {}), ...(f.ex ?? {}) };
      if (f.creator) s.creator = f.creator;
      if (num(f.cut) !== null) s.cut = Math.max(num(s.cut) ?? 0, f.cut);
      s.at = now; s.src = 'rugcheck';
    }
  }
  // RugCheck holder lists can lag: re-read newly discovered + freshly baselined accounts on-chain (one batched call)
  const baseAccts = Object.keys(store.coins).filter((ca) => !prev[ca]).flatMap((ca) => Object.keys(store.coins[ca].accts ?? {}));
  const verify = [...discoveredNew, ...baseAccts];
  if (verify.length) {
    const info = await getBalances(verify);
    const set = new Set(verify);
    for (const ca of Object.keys(store.coins)) for (const [acc, v] of Object.entries(store.coins[ca].accts ?? {})) {
      if (!set.has(acc)) continue;
      const b = info.get(acc);
      if (b && (!b.mint || b.mint === ca)) { v.a = b.a; if (b.o && W.isSol(b.o)) v.o = b.o; }
    }
    stats.discovered = discoveredNew.length;
  }

  // 4) diff → events (never on a coin's first snapshot; skip coins whose balances couldn't be read)
  const moves = [];
  const alertsByCoin = new Map();
  for (const ca of Object.keys(prev)) {
    const c = byCa.get(ca), s = store.coins[ca];
    if (!c || !s || !balOk[ca]) continue;
    const price = num(c.currentPrice);
    const before = ownersOf(prev[ca]), after = ownersOf(s);
    const evs = W.diff(before, after, { supply: s.supply, prevCut: prev[ca].cut, complete: true });
    for (const ev of evs) {
      const usd = price !== null ? ev.d * price : null;
      if (!W.notable(ev, usd, wc)) continue;
      const reason = wc.alerts.enabled ? W.alertReason(ev, usd, wc.alerts, prevWhales.has(ev.o)) : null;
      const m = { t: new Date(now).toISOString(), ca, sym: c.symbol, o: ev.o, k: ev.k, d: +ev.d.toPrecision(6), usd: usd === null ? null : Math.round(usd), dp: ev.dp === null ? null : +ev.dp.toFixed(3), chg: ev.chg === null ? null : +ev.chg.toFixed(1), hp: ev.hp === null ? null : +ev.hp.toFixed(3), ins: ev.ins, dev: ev.dev, min: ev.min ? 1 : 0, al: 0 };
      moves.push(m);
      if (reason) { m.why = reason; if (!alertsByCoin.has(ca)) alertsByCoin.set(ca, []); alertsByCoin.get(ca).push(m); }
    }
  }
  stats.events = moves.length;

  // 5) alerts: batch per coin, 1/coin/hour, max N/day, biggest first
  const ranked = [...alertsByCoin.entries()].map(([ca, ms]) => ({ ca, ms: ms.sort((a, b) => (b.dev - a.dev) || (b.ins - a.ins) || ((b.usd ?? 0) - (a.usd ?? 0))), score: ms.reduce((t, m) => t + (m.usd ?? 0), 0) }))
    .sort((a, b) => b.score - a.score);
  const caps = W.applyCaps(ranked, store.alerts, now, wc.alerts);
  const alerts = [];
  for (const r of ranked) {
    if (!caps.allowed.includes(r.ca)) { stats.blocked++; log(`whales: alert for $${byCa.get(r.ca).symbol} suppressed (${caps.blocked[r.ca]})`); continue; }
    const call = byCa.get(r.ca);
    const html = whaleAlertMessage(call, r.ms, cfg, wc.alerts.maxLinesPerAlert);
    alerts.push({ ca: r.ca, symbol: call.symbol, html, moves: r.ms.length });
    let ok = false;
    if (post) { try { ok = await post(call, html, whaleAlertButtons(call, cfg)); } catch (err) { log(`ERROR whale alert post failed: ${err.message}`); } }
    if (ok) { store.alerts.push({ ca: r.ca, t: now }); for (const m of r.ms) m.al = 1; stats.alerts++; }
  }

  // 6) prune snapshots + build public files
  const pubCoins = {};
  const agg = new Map();
  for (const c of coins) {
    const s0 = store.coins[c.address];
    if (!s0) continue;
    const s = store.coins[c.address] = prune(s0, wc.trackHolders);
    const list = ownersOf(s);
    const price = num(c.currentPrice);
    pubCoins[c.address] = {
      sym: c.symbol, at: new Date(s.at).toISOString(), bat: new Date(s.bat ?? s.at).toISOString(), src: s.src,
      top10: W.top10Pct(list),
      holders: list.slice(0, wc.publicHolders).map((x) => ({ o: x.o, a: +x.a.toPrecision(6), pct: x.pct === null ? null : +x.pct.toFixed(3), usd: price === null ? null : Math.round(x.a * price), ins: x.ins, dev: x.dev })),
    };
    for (const x of list) {
      const usd = price === null ? 0 : x.a * price;
      const w = agg.get(x.o) ?? { o: x.o, usd: 0, ins: 0, dev: 0, h: [] };
      w.usd += usd; if (x.ins) w.ins = 1; if (x.dev) w.dev = 1;
      w.h.push({ ca: c.address, sym: c.symbol, a: +x.a.toPrecision(6), usd: Math.round(usd), pct: x.pct === null ? null : +x.pct.toFixed(3) });
      agg.set(x.o, w);
    }
  }
  const whales = [...agg.values()].sort((a, b) => b.usd - a.usd).slice(0, wc.topWhales)
    .map((w) => ({ ...w, usd: Math.round(w.usd), n: w.h.length, h: w.h.sort((a, b) => b.usd - a.usd) }));
  store.whales = whales.map((w) => w.o);
  const perRun = wc.holdersPerRun;
  const pub = {
    updatedAt: new Date(now).toISOString(),
    note: 'Balances of tracked top holders are re-read on-chain every bot run (~15–25 min). New top holders are discovered on a rotating batch of coins per run.',
    rotationRuns: Math.max(1, Math.ceil(coins.length / Math.max(1, perRun))),
    megaWhaleUsd: wc.megaWhaleUsd,
    coinsTracked: Object.keys(pubCoins).length,
    whales, coins: pubCoins,
  };
  const all = [...moves.reverse(), ...(Array.isArray(prevMoves) ? prevMoves : [])].filter((m) => m && W.isSol(m.ca) && W.isSol(m.o)).slice(0, wc.maxMoves);
  const movesFile = { updatedAt: pub.updatedAt, moves: all };
  stats.ms = Date.now() - t0;
  log(`whales: ${stats.tracked} coins, ${stats.baselined} baselined, ${stats.refreshed} balance-refreshed, ${stats.discovered} accounts discovered (${JSON.stringify(stats.src)}), ${stats.events} moves, ${alerts.length} alert(s) [${stats.alerts} posted, ${stats.blocked} capped] (${stats.ms}ms)`);
  return { store, pub, movesFile, alerts, stats };
}
