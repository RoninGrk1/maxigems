// Trending Radar exports for the website, built ONLY from data the engine already fetched this run
// (no extra API calls):
//  - site/data/watchlist.json → "👀 On watch": top near-miss tokens (score, main reason not called, safety if fetched)
//  - site/data/trending.json  → small capped snapshot ("🔥 Hot now" + "🎓 New graduates"), used by /trending/ when the
//    browser can't reach DexScreener/GeckoTerminal directly.
import { cleanText, safeUrl, num, isSolAddress } from './util.js';
import { score } from './scoring.js';

export const RADAR_LIMITS = { watch: 15, hot: 25, grads: 15 };
const GRAD_DEXES = new Set(['pumpswap', 'raydium']);
const GRAD_MAX_AGE_MS = 24 * 3600000;

// Never put tokens on watch that can't be called no matter how the market moves.
const HARD_FILTER = /^(bad address|no symbol|no price|zero liquidity|blocked symbol|dex .* not allowed|too old|liq too high|mcap high|no mcap|unknown age|fdv>>mcap)/;
const SLUR_RE = /n[i1!]gg|f[a@]gg[o0]t|\bk[i1]ke\b/i; // keep hate-speech token names off the public site
const blocked = (name, sym) => SLUR_RE.test(String(name ?? '')) || SLUR_RE.test(String(sym ?? ''));
const HARD_SAFETY = /mint authority|freeze authority|flagged rugged|transfer fee|danger/;

const REASON_TEXT = [
  [/^liq<(\d+)/, (m) => `Liquidity under $${Math.round(m[1] / 1000)}K`],
  [/^mcap low/, () => 'Market cap too small'],
  [/^thin liq vs mcap/, () => 'Thin liquidity vs market cap'],
  [/^vol24 low/, () => '24h volume too low'],
  [/^vol1h low/, () => '1h volume too low'],
  [/^too new/, () => 'Too new (age filter)'],
  [/^few txns/, () => 'Not enough trades in the last hour'],
  [/^sell pressure/, () => 'Sell pressure (more sells than buys)'],
  [/^dumping 1h/, () => 'Dumping in the last hour'],
  [/^dumping 5m/, () => 'Dumping in the last 5 min'],
  [/^dumping 24h/, () => 'Down hard over 24h'],
  [/^overextended 1h/, () => 'Already pumped hard this hour'],
  [/^overextended 24h/, () => 'Already pumped hard today'],
  [/^spiking 5m/, () => 'Spiking right now (no chasing)'],
  [/^score<(\d+)/, (m) => `Score just under ${m[1]}`],
  [/^few unique buyers/, () => 'Too few unique buyers'],
  [/^low buyer diversity/, () => 'Low buyer diversity (bots?)'],
  [/^safety: LP locked/, () => 'LP not locked/burned enough'],
  [/^safety: LP lock unknown/, () => 'LP lock unknown'],
  [/^safety: top10/, () => 'Top 10 holders own too much'],
  [/^safety: insiders/, () => 'Insiders hold too much'],
  [/^safety: insider network/, () => 'Large insider network'],
  [/^safety: creator/, () => 'Creator holds too much'],
  [/^safety: holders/, () => 'Not enough holders yet'],
  [/^safety: rugcheck unavailable/, () => 'Safety check unavailable'],
  [/^safety: rugcheck score/, () => 'High RugCheck risk score'],
  [/^run cap/, () => 'Passed — run limit reached'],
  [/^queued/, () => 'Passed market filters — safety check pending'],
];
export function reasonText(code) {
  const s = String(code ?? '');
  for (const [re, fn] of REASON_TEXT) { const m = s.match(re); if (m) return fn(m); }
  return cleanText(s, 60);
}

/** Momentum "heat" 0–100: volume acceleration (5m vs 1h, 1h vs 24h avg) + buy count + buy share. Same formula as site/assets/radar-core.js. */
export function heat(t) {
  const v5 = num(t.vol?.m5) ?? 0, v1 = num(t.vol?.h1) ?? 0, v24 = num(t.vol?.h24) ?? 0;
  const b1 = num(t.txns?.h1?.b) ?? 0, s1 = num(t.txns?.h1?.s) ?? 0;
  const c = (x) => Math.max(0, Math.min(1, x));
  const acc5 = c((v5 * 12) / Math.max(v1, 1) / 3);       // 5m pace vs 1h pace (3x → max)
  const acc1 = c((v1 * 24) / Math.max(v24, 1) / 4);      // 1h pace vs 24h avg (4x → max)
  const buys = c(Math.log10(Math.max(b1, 1)) / 3);       // 1000 buys/h → max
  const share = b1 + s1 > 0 ? c((b1 / (b1 + s1) - 0.4) / 0.3) : 0; // 40%→0, 70%→1
  const depth = c((Math.log10(Math.max(v1, 1)) - 3) / 3); // $1k→0, $1M→1 (filters dust)
  return Math.round((acc5 * 0.25 + acc1 * 0.25 + buys * 0.2 + share * 0.15 + depth * 0.15) * 100);
}

/** Compact, sanitized public row from a DexScreener pair (same shape the site builds client-side). */
export function radarRow(pair, now = Date.now()) {
  const a = pair?.baseToken?.address;
  if (!isSolAddress(a)) return null;
  const t = pair.txns ?? {}, v = pair.volume ?? {}, ch = pair.priceChange ?? {};
  const pairAddress = isSolAddress(pair.pairAddress) ? pair.pairAddress : null;
  const img = safeUrl(pair.info?.imageUrl);
  const row = {
    address: a,
    pairAddress,
    name: cleanText(pair.baseToken?.name, 40),
    symbol: cleanText(pair.baseToken?.symbol, 16).replace(/^\$/, ''),
    dex: String(pair.dexId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
    imageUrl: img && img.startsWith('https://') ? img : null,
    pairCreatedAt: num(pair.pairCreatedAt),
    mc: num(pair.marketCap) ?? num(pair.fdv),
    liq: num(pair.liquidity?.usd),
    ch: { m5: num(ch.m5), h1: num(ch.h1), h24: num(ch.h24) },
    vol: { m5: num(v.m5), h1: num(v.h1), h24: num(v.h24) },
    txns: { m5: { b: num(t.m5?.buys) ?? 0, s: num(t.m5?.sells) ?? 0 }, h1: { b: num(t.h1?.buys) ?? 0, s: num(t.h1?.sells) ?? 0 } },
  };
  row.heat = heat(row);
  return row;
}

export const isGraduate = (r, now = Date.now()) =>
  !!r && GRAD_DEXES.has(r.dex) && /pump$/.test(r.address) && r.pairCreatedAt && now - r.pairCreatedAt < GRAD_MAX_AGE_MS && now - r.pairCreatedAt >= 0;

/**
 * @param evaluated [{ c, m, reasons, pair }] every fresh candidate that had pair data this run
 * @param stage2 shortlist items with optional { rejectReasons, safety, traders }
 * @param picks items called this run (excluded)
 */
export function buildWatchlist({ evaluated = [], scored = [], shortlist = [], picks = [], f = {}, now = Date.now(), limit = RADAR_LIMITS.watch }) {
  const called = new Set(picks.map((x) => x.m.address));
  const byAddr = new Map();
  const add = (e) => { if (!called.has(e.address) && !byAddr.has(e.address) && isSolAddress(e.address) && !blocked(e.name, e.symbol)) byAddr.set(e.address, e); };
  const base = (m, sc) => ({
    address: m.address, pairAddress: isSolAddress(m.pairAddress) ? m.pairAddress : null,
    name: cleanText(m.name, 40), symbol: cleanText(m.symbol, 16).replace(/^\$/, ''), dex: m.dex,
    imageUrl: safeUrl(m.imageUrl)?.startsWith('https://') ? safeUrl(m.imageUrl) : null,
    score: sc, mc: m.marketCap, liq: m.liquidity, vol1h: m.vol1, ageMin: m.ageMs === null ? null : Math.round(m.ageMs / 60000),
    ch: { m5: m.chM5, h1: m.chH1, h24: m.chH24 }, buysH1: m.buysH1, sellsH1: m.sellsH1,
  });
  // tier 0: passed every check but run/day cap hit; tier 1: passed market+score, failed stage 2 (soft reasons only)
  for (const x of shortlist) {
    if (called.has(x.m.address)) continue;
    const rs = x.rejectReasons ?? [];
    if (rs.some((r) => HARD_SAFETY.test(r))) continue;
    const reason = rs[0] ?? 'run cap';
    add({ ...base(x.m, x.sc), tier: rs.length ? 1 : 0, reason, reasonText: reasonText(reason), otherReasons: rs.slice(1, 3).map(reasonText),
      uniqueBuyersH1: x.traders?.buyersH1 ?? null, safety: x.safety ? pubSafety(x.safety) : null });
  }
  // tier 1: passed market filters + score but not safety-checked this run (shortlist/daily cap)
  const inShort = new Set(shortlist.map((x) => x.m.address));
  for (const x of scored) if (!inShort.has(x.m.address)) add({ ...base(x.m, x.sc), tier: 1, reason: 'queued', reasonText: reasonText('queued'), otherReasons: [], uniqueBuyersH1: null, safety: null });
  // tier 2: market filters/score near-misses (≤2 soft reasons), ranked by what the score would be
  const near = [];
  for (const e of evaluated) {
    const rs = e.reasons ?? [];
    if (rs.length > 2 || rs.some((r) => HARD_FILTER.test(r))) continue;
    const sc = e.sc ?? score(e.m, f, e.c);
    const codes = rs.length ? rs : sc < (f.minScore ?? 0) ? [`score<${f.minScore}`] : null;
    if (!codes) continue; // passed: already in shortlist (or not shortlisted, then not a near-miss we know about)
    near.push({ e, sc, codes });
  }
  near.sort((a, b) => a.codes.length - b.codes.length || b.sc - a.sc);
  for (const { e, sc, codes } of near) add({ ...base(e.m, sc), tier: 2, reason: codes[0], reasonText: reasonText(codes[0]), otherReasons: codes.slice(1).map(reasonText), uniqueBuyersH1: null, safety: null });
  const items = [...byAddr.values()].sort((a, b) => a.tier - b.tier || b.score - a.score).slice(0, limit);
  return { updatedAt: new Date(now).toISOString(), minScore: f.minScore ?? null, count: items.length, items };
}

function pubSafety(s) {
  return { mint: s.mintRevoked === true, freeze: s.freezeRevoked === true, lp: num(s.lpLockedPct), top10: num(s.top10Pct), holders: num(s.holders) };
}

/** Small capped snapshot of what's moving, from pairs fetched this run. */
export function buildTrending({ pairs = [], now = Date.now(), limits = RADAR_LIMITS }) {
  const rows = [];
  const seen = new Set();
  for (const p of pairs) {
    const r = radarRow(p, now);
    if (!r || seen.has(r.address) || blocked(r.name, r.symbol)) continue;
    seen.add(r.address);
    rows.push(r);
  }
  const live = rows.filter((r) => (r.liq ?? 0) >= 3000 && (r.vol.h1 ?? 0) >= 1000);
  const hot = live.slice().sort((a, b) => b.heat - a.heat).slice(0, limits.hot);
  const grads = rows.filter((r) => isGraduate(r, now)).sort((a, b) => b.pairCreatedAt - a.pairCreatedAt).slice(0, limits.grads);
  return { updatedAt: new Date(now).toISOString(), source: 'engine', hot, graduates: grads };
}
