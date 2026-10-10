// RugCheck safety rules shared by the engine (src/safety.js re-exports this) and the Supabase `featured`
// Edge Function, so a sponsored listing has to pass EXACTLY the same checks as a MaxiGems call.
// Pure JS, no imports: runs in Node (engine + tests) and Deno (Edge Functions).

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Same thresholds as config.json "safety" (test/pro-shared.test.js keeps them in sync). */
export const SAFETY_DEFAULTS = Object.freeze({
  minLpLockedPct: 80, maxTop10HolderPct: 35, maxInsiderPct: 15, maxCreatorPct: 8, minHolders: 200, maxRugcheckScore: 0, maxInsiderNetworkRatio: 0.25,
});

/**
 * Turn a RugCheck report into a compact safety summary + rejection reasons.
 * @param r RugCheck /report JSON
 * @param ctx { pairAddress, rpc: {mintAuthority, freezeAuthority} | undefined }
 */
export function analyzeReport(r, ctx = {}, s = {}) {
  const reasons = [];
  if (!r || typeof r !== 'object' || !r.mint) return { reasons: ['safety: no rugcheck data'], safety: null };
  const tok = r.token ?? {};
  const mintAuth = r.mintAuthority ?? tok.mintAuthority ?? null;
  const freezeAuth = r.freezeAuthority ?? tok.freezeAuthority ?? null;
  const rpc = ctx.rpc;
  const mintRevoked = !mintAuth && !(rpc && rpc.mintAuthority);
  const freezeRevoked = !freezeAuth && !(rpc && rpc.freezeAuthority);
  if (!mintRevoked) reasons.push('safety: mint authority active');
  if (!freezeRevoked) reasons.push('safety: freeze authority active');

  // pools / lockers / AMM accounts are not "holders"
  const known = r.knownAccounts ?? {};
  const poolAddrs = new Set(Object.keys(known).filter((k) => /AMM|LOCKER|POOL/i.test(known[k]?.type ?? '')));
  for (const m of r.markets ?? []) for (const k of ['pubkey', 'liquidityAAccount', 'liquidityBAccount']) if (m?.[k]) poolAddrs.add(m[k]);
  if (ctx.pairAddress) poolAddrs.add(ctx.pairAddress);
  const holders = (r.topHolders ?? []).filter((h) => !poolAddrs.has(h.owner) && !poolAddrs.has(h.address));
  const top10Pct = +holders.slice(0, 10).reduce((a, h) => a + (num(h.pct) ?? 0), 0).toFixed(1);
  const insiderPct = +holders.filter((h) => h.insider).reduce((a, h) => a + (num(h.pct) ?? 0), 0).toFixed(1);
  const supply = num(tok.supply);
  const creatorPct = supply ? +(((num(r.creatorBalance) ?? 0) / supply) * 100).toFixed(2) : 0;

  // LP: prefer the market we're calling on; else the deepest one
  const markets = (r.markets ?? []).filter((m) => m?.lp);
  const mkt = markets.find((m) => m.pubkey === ctx.pairAddress)
    ?? markets.sort((a, b) => (num(b.lp.quoteUSD) ?? 0) - (num(a.lp.quoteUSD) ?? 0))[0];
  const lpLockedPct = mkt ? num(mkt.lp.lpLockedPct) : num(r.lpLockedPct);

  if (lpLockedPct === null) reasons.push('safety: LP lock unknown');
  else if (lpLockedPct < s.minLpLockedPct) reasons.push(`safety: LP locked ${lpLockedPct.toFixed(0)}%`);
  if (top10Pct > s.maxTop10HolderPct) reasons.push(`safety: top10 ${top10Pct}%`);
  if (insiderPct > s.maxInsiderPct) reasons.push(`safety: insiders ${insiderPct}%`);
  if (creatorPct > s.maxCreatorPct) reasons.push(`safety: creator holds ${creatorPct}%`);
  // RugCheck's insider graph grows with holder count, so judge it as a share of holders
  const gid = num(r.graphInsidersDetected) ?? 0, nh = num(r.totalHolders) ?? 0;
  const insiderNetRatio = nh > 0 ? gid / nh : gid > 0 ? 1 : 0;
  if (s.maxInsiderNetworkRatio !== undefined && insiderNetRatio > s.maxInsiderNetworkRatio) reasons.push(`safety: insider network ${gid}/${nh}`);
  if (s.minHolders && (num(r.totalHolders) ?? 0) < s.minHolders) reasons.push(`safety: holders ${r.totalHolders ?? 0}`);
  if (r.rugged) reasons.push('safety: flagged rugged');
  if ((num(r.transferFee?.pct) ?? 0) > 0) reasons.push('safety: transfer fee');
  const danger = (r.risks ?? []).filter((x) => x?.level === 'danger').map((x) => x.name);
  if (danger.length) reasons.push(`safety: danger (${danger.join(', ')})`);
  if (s.maxRugcheckScore && (num(r.score_normalised) ?? 0) > s.maxRugcheckScore) reasons.push(`safety: rugcheck score ${r.score_normalised}`);

  return {
    reasons,
    safety: {
      mintRevoked, freezeRevoked,
      lpLockedPct: lpLockedPct === null ? null : +lpLockedPct.toFixed(1),
      top10Pct, insiderPct, creatorPct,
      holders: num(r.totalHolders),
      rugcheckScore: num(r.score_normalised),
      risks: (r.risks ?? []).map((x) => `${x.level}:${x.name}`).slice(0, 8),
      source: rpc ? 'rugcheck+rpc' : 'rugcheck',
    },
  };
}

