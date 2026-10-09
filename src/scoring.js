// Turn a DexScreener pair into normalized metrics, run rug/quality filters, compute a 0-100 score.
import { num, isSolAddress } from './util.js';

export function metrics(pair, now = Date.now()) {
  const t = pair?.txns ?? {};
  const h1b = num(t.h1?.buys) ?? 0, h1s = num(t.h1?.sells) ?? 0;
  const h24b = num(t.h24?.buys) ?? 0, h24s = num(t.h24?.sells) ?? 0;
  const mc = num(pair?.marketCap) ?? num(pair?.fdv);
  const created = num(pair?.pairCreatedAt);
  const info = pair?.info ?? {};
  return {
    address: pair?.baseToken?.address,
    name: pair?.baseToken?.name ?? '',
    symbol: pair?.baseToken?.symbol ?? '',
    dex: String(pair?.dexId ?? '').toLowerCase(),
    pairAddress: pair?.pairAddress ?? '',
    pairUrl: pair?.url ?? '',
    priceUsd: num(pair?.priceUsd),
    marketCap: mc,
    fdv: num(pair?.fdv) ?? mc,
    liquidity: num(pair?.liquidity?.usd),
    vol24: num(pair?.volume?.h24) ?? 0,
    vol6: num(pair?.volume?.h6) ?? 0,
    vol1: num(pair?.volume?.h1) ?? 0,
    chM5: num(pair?.priceChange?.m5),
    chH1: num(pair?.priceChange?.h1),
    chH6: num(pair?.priceChange?.h6),
    chH24: num(pair?.priceChange?.h24),
    buysH1: h1b,
    sellsH1: h1s,
    txH1: h1b + h1s,
    txH24: h24b + h24s,
    bsH1: h1s > 0 ? h1b / h1s : h1b > 0 ? h1b : 0,
    bsH24: h24s > 0 ? h24b / h24s : h24b > 0 ? h24b : 0,
    ageMs: created ? now - created : null,
    pairCreatedAt: created,
    imageUrl: info.imageUrl ?? null,
    socials: [...(info.socials ?? []), ...(info.websites ?? []).map((w) => ({ type: 'website', url: w.url }))],
    boosts: num(pair?.boosts?.active) ?? 0,
  };
}

/** Returns list of failure reasons (empty array = passes). */
export function filterReasons(m, f) {
  const r = [];
  if (!isSolAddress(m.address)) r.push('bad address');
  if (!m.symbol) r.push('no symbol');
  if (m.priceUsd === null || m.priceUsd <= 0) r.push('no price');
  if (m.liquidity === null || m.liquidity <= 0) r.push('zero liquidity (rug?)');
  else {
    if (m.liquidity < f.minLiquidityUsd) r.push(`liq<${f.minLiquidityUsd}`);
    if (f.maxLiquidityUsd && m.liquidity > f.maxLiquidityUsd) r.push('liq too high (not a gem)');
  }
  if (m.marketCap === null) r.push('no mcap');
  else {
    if (m.marketCap < f.minMarketCapUsd) r.push('mcap low');
    if (m.marketCap > f.maxMarketCapUsd) r.push('mcap high');
    if (m.liquidity && m.liquidity / m.marketCap < f.minLiquidityToMcapRatio) r.push('thin liq vs mcap');
    if (m.fdv && f.maxFdvToMcapRatio && m.fdv / m.marketCap > f.maxFdvToMcapRatio) r.push('fdv>>mcap');
  }
  if (m.vol24 < f.minVolume24hUsd) r.push('vol24 low');
  if (m.vol1 < f.minVolume1hUsd) r.push('vol1h low');
  if (m.ageMs === null) r.push('unknown age');
  else {
    if (m.ageMs < f.minAgeMinutes * 60000) r.push('too new');
    if (m.ageMs > f.maxAgeHours * 3600000) r.push('too old');
  }
  if (m.txH1 < f.minTxnsH1) r.push('few txns');
  if (m.bsH1 < f.minBuySellRatioH1) r.push('sell pressure');
  if (m.chH1 === null || m.chH1 < f.minPriceChangeH1) r.push('dumping 1h');
  if (m.chH1 !== null && m.chH1 > f.maxPriceChangeH1) r.push('overextended 1h');
  if (m.chH24 !== null && m.chH24 < f.minPriceChangeH24) r.push('dumping 24h');
  if (f.maxPriceChangeH24 && m.chH24 !== null && m.chH24 > f.maxPriceChangeH24) r.push('overextended 24h');
  if (f.allowedDexes?.length && !f.allowedDexes.includes(m.dex)) r.push(`dex ${m.dex} not allowed`);
  if (f.requireSocials && m.socials.length === 0) r.push('no socials');
  const sym = m.symbol.toUpperCase();
  if (f.blockedSymbols?.some((b) => b.toUpperCase() === sym)) r.push('blocked symbol');
  return r;
}

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

/** 0-100 score. Weighted momentum + flow + depth + activity + extras. */
export function score(m, f, extra = {}) {
  const liq = clamp((Math.log10(Math.max(m.liquidity ?? 1, 1)) - 4) / 2); // 10k→0, 1M→1
  const turnover = clamp((m.vol24 / Math.max(m.liquidity ?? 1, 1)) / 8); // vol/liq 8x → max
  const flow = clamp((m.bsH1 - 1) / 1.0) * 0.7 + clamp((m.bsH24 - 0.9) / 0.6) * 0.3;
  const mom =
    clamp(((m.chH1 ?? 0) + 5) / 60) * 0.5 + clamp(((m.chH6 ?? 0) + 10) / 150) * 0.3 + clamp(((m.chM5 ?? 0) + 2) / 12) * 0.2;
  const activity = clamp(Math.log10(Math.max(m.txH1, 1)) / 3); // 1000 tx/h → max
  const accel = clamp((m.vol1 * 24) / Math.max(m.vol24, 1) / 3); // last hour vs 24h avg
  let s = liq * 15 + turnover * 15 + flow * 20 + mom * 20 + activity * 15 + accel * 15;
  if (f.preferredDexes?.includes(m.dex)) s += 4;
  if (m.socials.length > 0) s += 3;
  if (m.boosts > 0 || extra.boost > 0) s += 2;
  if ((extra.hits ?? 1) > 1) s += 3; // seen on multiple sources
  if (m.chH1 > 150) s -= 8; // chasing risk
  if (m.chH24 > 600) s -= 6;
  return Math.round(clamp(s, 0, 100));
}
