// Telegram HTML message builders. EVERYTHING dynamic goes through escapeHtml().
import { escapeHtml as e, fmtUsd, fmtPrice, fmtPct, fmtX, fmtAge, safeUrl as _safeUrl } from './util.js';

// Ignore the unconfigured placeholder so we never post a dead link.
const safeUrl = (u) => (/YOUR_GITHUB_USERNAME/i.test(String(u ?? '')) ? null : _safeUrl(u));

const DEX_NAMES = {
  pumpswap: 'PumpSwap', pumpfun: 'Pump.fun', raydium: 'Raydium', meteora: 'Meteora',
  meteoradbc: 'Meteora DBC', launchlab: 'LaunchLab', orca: 'Orca',
};
export const dexName = (d) => DEX_NAMES[d] ?? (d ? d[0].toUpperCase() + d.slice(1) : 'DEX');

export function links(ca, pairAddress) {
  return {
    dexscreener: `https://dexscreener.com/solana/${pairAddress || ca}`,
    solscan: `https://solscan.io/token/${ca}`,
    birdeye: `https://birdeye.so/token/${ca}?chain=solana`,
    photon: `https://photon-sol.tinyastro.io/en/lp/${pairAddress || ca}`,
    bullx: `https://neo.bullx.io/terminal?chainId=1399811149&address=${ca}`,
    jupiter: `https://jup.ag/swap/SOL-${ca}`,
    pumpfun: ca.endsWith('pump') ? `https://pump.fun/coin/${ca}` : null,
  };
}

/** Per-coin share page (/c/<CA>/) under the configured site URL, or null. */
export function coinPageUrl(call, cfg) {
  const site = safeUrl(cfg.siteUrl);
  if (!site || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(call?.address ?? ''))) return null;
  try { return new URL(`c/${call.address}/`, site.endsWith('/') ? site : site + '/').toString(); } catch { return null; }
}

const a = (url, label) => `<a href="${e(url)}">${e(label)}</a>`;

export function safetyLine(s) {
  if (!s) return null;
  const pct = (v) => (v === null || v === undefined ? '?' : `${Math.round(v)}%`);
  return `🛡 Mint ${s.mintRevoked ? '✅' : '❌'} | Freeze ${s.freezeRevoked ? '✅' : '❌'} | LP 🔥 ${pct(s.lpLockedPct)} | Top10 ${pct(s.top10Pct)}`;
}

export function callMessage(call, cfg) {
  const L = call.links;
  const site = safeUrl(cfg.siteUrl);
  const lines = [
    `💎 <b>MAXIGEMS CALL</b> 🟢 <b>#SOLANA</b>`,
    ``,
    `🪙 <b>${e(call.name)}</b> ($${e(call.symbol)})`,
    `🏦 ${e(dexName(call.dex))} • ⏳ Age ${e(fmtAge(call.ageMsAtCall))}`,
    `📋 <code>${e(call.address)}</code>`,
    ``,
    `💰 Price: <b>${e(fmtPrice(call.priceAtCall))}</b>`,
    `📈 MC: <b>${e(fmtUsd(call.mcAtCall))}</b> | 💧 Liq: <b>${e(fmtUsd(call.liquidity))}</b>`,
    `📊 Vol 24h: ${e(fmtUsd(call.volume24h))} | 1h: ${e(fmtUsd(call.volume1h))}`,
    `🚀 5m ${e(fmtPct(call.change.m5))} | 1h ${e(fmtPct(call.change.h1))} | 24h ${e(fmtPct(call.change.h24))}`,
    `🔄 1h Buys/Sells: ${e(call.buysH1)}/${e(call.sellsH1)}`,
    `⭐ Score: <b>${e(call.score)}/100</b>`,
    call.safety ? e(safetyLine(call.safety)) : null,
    ``,
    [a(L.dexscreener, 'DexScreener'), a(L.solscan, 'Solscan'), a(L.birdeye, 'Birdeye'), a(L.photon, 'Photon'), a(L.bullx, 'BullX')].join(' • '),
    site ? `🌐 ${coinPageUrl(call, cfg) ? a(coinPageUrl(call, cfg), 'Live tracking & share card') + ' • ' : ''}${a(site, 'All calls → MaxiGems')}` : null,
    `<i>⚠️ High risk. DYOR — not financial advice.</i>`,
  ];
  return lines.filter((x) => x !== null).join('\n');
}

export function callButtons(call, cfg) {
  const L = call.links;
  const rows = [
    [{ text: '📊 Chart', url: L.dexscreener }, { text: '🔎 Solscan', url: L.solscan }],
    [{ text: '🪐 Buy on Jupiter', url: L.jupiter }, { text: '🦅 Birdeye', url: L.birdeye }],
  ];
  const site = safeUrl(cfg.siteUrl);
  const chat = safeUrl(cfg.telegramChatUrl);
  const last = [];
  const page = coinPageUrl(call, cfg);
  if (page || site) last.push({ text: page ? '💎 Track & Share' : '💎 Live Calls', url: page || site });
  if (chat) last.push({ text: '💬 Chat', url: chat });
  const x = safeUrl(cfg.xUrl);
  if (x) last.push({ text: '𝕏 Follow', url: x });
  if (last.length) rows.push(last);
  return rows;
}

export function milestoneMessage(call, multiple, cfg) {
  const site = safeUrl(cfg.siteUrl);
  return [
    `🔥 <b>${e(fmtX(multiple))} SINCE CALL</b> 🔥`,
    ``,
    `🪙 <b>${e(call.name)}</b> ($${e(call.symbol)})`,
    `📈 MC ${e(fmtUsd(call.mcAtCall))} → <b>${e(fmtUsd(call.athMc ?? call.currentMc))}</b>`,
    `📋 <code>${e(call.address)}</code>`,
    ``,
    a(call.links.dexscreener, 'Chart') + (site ? ' • ' + a(site, 'MaxiGems') : ''),
  ].join('\n');
}

export function recapMessage(top, hours, cfg) {
  const site = safeUrl(cfg.siteUrl);
  const medals = ['🥇', '🥈', '🥉'];
  const rows = top.map((c, i) =>
    `${medals[i] ?? `${i + 1}.`} <b>$${e(c.symbol)}</b> — <b>${e(fmtX(c.athMultiple))}</b> ATH (MC ${e(fmtUsd(c.mcAtCall))} → ${e(fmtUsd(c.athMc))}) ${a(c.links.dexscreener, '📊')}`);
  return [
    `🏆 <b>MAXIGEMS TOP PERFORMERS</b> — last ${e(hours >= 48 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`)}`,
    ``,
    ...rows,
    ``,
    site ? `🌐 ${a(site, 'Full live tracker')}` : null,
    `<i>Multiples = ATH price since call ÷ call price. NFA.</i>`,
  ].filter((x) => x !== null).join('\n');
}

/** Public status/share page for a sponsored listing (also the "Track & Share" target). */
export function featuredPageUrl(ca, cfg) {
  const site = safeUrl(cfg.siteUrl);
  if (!site || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(ca ?? ''))) return null;
  try { return new URL(`featured/?ca=${ca}`, site.endsWith('/') ? site : site + '/').toString(); } catch { return null; }
}

export const SPONSORED_LABEL = 'Sponsored – not financial advice';

/**
 * ONE channel post per featured listing. Same escaping as calls (everything dynamic through escapeHtml()).
 * listing: featured_listings row (+ .live = fresh DexScreener pair when available).
 */
export function sponsoredMessage(listing, cfg) {
  const t = listing.token ?? {};
  const p = listing.live ?? null;
  const ca = listing.ca;
  const L = links(ca, validPair(t.pairAddress));
  const site = safeUrl(cfg.siteUrl);
  const page = featuredPageUrl(ca, cfg);
  const price = p ? Number(p.priceUsd) : t.priceUsd;
  const mc = p ? (p.marketCap ?? p.fdv) : t.marketCap;
  const liq = p ? p.liquidity?.usd : t.liquidityUsd;
  const s = listing.safety;
  const lines = [
    `🟡 <b>SPONSORED</b> • <i>${e(SPONSORED_LABEL)}</i>`,
    ``,
    `🪙 <b>${e(t.name || listing.symbol)}</b> ($${e(listing.symbol)})`,
    t.dex ? `🏦 ${e(dexName(t.dex))}` : null,
    `📋 <code>${e(ca)}</code>`,
    ``,
    `💰 Price: <b>${e(fmtPrice(price))}</b>`,
    `📈 MC: <b>${e(fmtUsd(mc))}</b> | 💧 Liq: <b>${e(fmtUsd(liq))}</b>`,
    s ? e(safetyLine(s)) : null,
    `✅ Passed the MaxiGems safety checks when booked. This is a paid placement, <b>not a MaxiGems call</b>.`,
    ``,
    [a(L.dexscreener, 'DexScreener'), a(L.solscan, 'Solscan'), a(L.birdeye, 'Birdeye')].join(' • '),
    site ? `🌐 ${page ? a(page, 'Track & Share') + ' • ' : ''}${a(site, 'All calls → MaxiGems')}` : null,
    `<i>⚠️ ${e(SPONSORED_LABEL)}. High risk. DYOR.</i>`,
  ];
  return lines.filter((x) => x !== null).join('\n');
}

const validPair = (a) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a ?? '')) ? a : null);

export function sponsoredButtons(listing, cfg) {
  const L = links(listing.ca, validPair(listing.token?.pairAddress));
  const page = featuredPageUrl(listing.ca, cfg);
  const rows = [[{ text: '📊 Chart', url: L.dexscreener }, { text: '🔎 Solscan', url: L.solscan }]];
  if (page) rows.push([{ text: '💎 Track & Share', url: page }]);
  return rows;
}
