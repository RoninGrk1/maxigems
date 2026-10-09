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

const a = (url, label) => `<a href="${e(url)}">${e(label)}</a>`;

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
    ``,
    [a(L.dexscreener, 'DexScreener'), a(L.solscan, 'Solscan'), a(L.birdeye, 'Birdeye'), a(L.photon, 'Photon'), a(L.bullx, 'BullX')].join(' • '),
    site ? `🌐 ${a(site, 'All calls & tracking → MaxiGems')}` : null,
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
  if (site) last.push({ text: '💎 Live Calls', url: site });
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
    `🏆 <b>MAXIGEMS TOP PERFORMERS</b> — last ${e(hours)}h`,
    ``,
    ...rows,
    ``,
    site ? `🌐 ${a(site, 'Full live tracker')}` : null,
    `<i>Multiples = ATH price since call ÷ call price. NFA.</i>`,
  ].filter((x) => x !== null).join('\n');
}
