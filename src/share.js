// Per-coin share pages (/c/<CA>/index.html) + 1200x630 OG cards (/c/<CA>/card.png) + sitemap.
// Never throws into the engine: generateShare() catches and logs. Everything dynamic is escaped;
// a CA is only used in a path after strict base58 validation.
import { tipAddress, tipCardHtml } from './tip.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { num, log, fmtUsd, fmtX } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CARD_VERSION = 1;
export const SITE = 'https://maxigems.fun';
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** DexScreener CDN serves fixed sizes only (64/128/160/256/800); the page avatar is 56 CSS px. */
export function dsThumb(u, w = 160) { const m = /^(https:\/\/cdn\.dexscreener\.com\/cms\/images\/[A-Za-z0-9_-]+)(\?[^#]*)?$/.exec(String(u || '')); return m ? `${m[1]}?width=${w}&height=${w}&quality=90&format=auto` : u; }
const IMG_RE = /^https:\/\/(cdn\.dexscreener\.com|dd\.dexscreener\.com|assets\.geckoterminal\.com|coin-images\.coingecko\.com)\//;
const BASE_URLS = ['/', '/trending/', '/leaderboard/', '/whales/'];

export const isSolAddress = (s) => typeof s === 'string' && SOL_RE.test(s);
/** HTML/attribute/XML escape (incl. single quotes). */
export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** Strip control / zero-width / bidi chars and clamp. */
export function clean(s, max = 40) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
export function peakX(c) {
  const a = num(c?.athMultiple), b = num(c?.currentMultiple);
  const p = Math.max(a !== null && a > 0 ? a : 0, b !== null && b > 0 ? b : 0);
  return p > 0 ? Math.max(1, p) : 1;
}
export function statusOf(c) {
  if (!c || c.status !== 'rugged') return 'live';
  const liq = num(c.currentLiquidity), base = num(c.liquidity);
  if (liq !== null && (liq < 1000 || (base !== null && base > 0 && liq < base * 0.05))) return 'pulled';
  return 'rugged';
}
const STATUS_LABEL = { live: 'Live', rugged: 'Rugged', pulled: 'Liquidity pulled' };
export const coinPath = (ca) => `/c/${ca}/`;
export const coinUrl = (ca) => `${SITE}${coinPath(ca)}`;

/** Snapshot of the numbers a card/page displays. Changes only when material. */
export function snapshotOf(c, hasCard) {
  const pk = peakX(c);
  return {
    v: CARD_VERSION, peak: +pk.toFixed(2), cur: num(c.currentMultiple) !== null ? +num(c.currentMultiple).toFixed(2) : null,
    curMc: num(c.currentMc),
    status: statusOf(c), peakMc: num(c.athMc) ?? (num(c.mcAtCall) !== null ? num(c.mcAtCall) * pk : null), hasCard: !!hasCard,
  };
}
/** Re-render when no card yet, version bump, status change, or peak moved by ≥ 0.05x. */
export function needsRender(prev, c) {
  if (!prev || !prev.hasCard || prev.dirty || prev.v !== CARD_VERSION) return true;
  if (prev.status !== statusOf(c)) return true;
  return Math.abs(peakX(c) - (prev.peak ?? 0)) >= 0.05;
}

function fmtCalled(iso) {
  const d = new Date(iso);
  if (!isFinite(d)) return '—';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${m} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}
const pctTxt = (v) => (num(v) === null ? '?' : `${Math.round(num(v))}%`);

// ---------------------------------------------------------------- card SVG
/** Pure: build the 1200x630 card SVG. iconData = data: URI (png) or null. logoData = data: URI. */
export function cardSvg(c, snap, { iconData = null, logoData = null } = {}) {
  const sym = clean(String(c.symbol || '').replace(/^\$/, ''), 14) || '???';
  const name = clean(c.name, 30) || sym;
  const pk = fmtX(snap.peak), cur = snap.cur === null ? '—' : fmtX(snap.cur);
  const st = snap.status;
  const symSize = Math.max(34, Math.min(66, Math.floor(560 / ((sym.length + 1) * 0.66))));
  const peakSize = pk.length > 6 ? 120 : 150;
  const s = c.safety || null;
  const badges = s ? [
    ['Mint', s.mint === true ? 'revoked' : 'active', s.mint === true],
    ['Freeze', s.freeze === true ? 'revoked' : 'active', s.freeze === true],
    ['LP locked', pctTxt(s.lp), num(s.lp) !== null && num(s.lp) >= 80],
    ['Top10', pctTxt(s.top10), num(s.top10) !== null && num(s.top10) <= 35],
  ] : [['Safety data', 'n/a', null]];
  let bx = 80;
  const badgeSvg = badges.map(([k, v, ok]) => {
    const label = `${k} ${v}`;
    const w = Math.round(label.length * 10.6 + 56);
    const col = ok === null ? '#93a4b3' : ok ? '#39ff88' : '#ff5c7a';
    const g = `<g transform="translate(${bx},470)"><rect width="${w}" height="44" rx="22" fill="${ok === null ? 'rgba(255,255,255,0.05)' : ok ? 'rgba(57,255,136,0.12)' : 'rgba(255,92,122,0.12)'}" stroke="${col}" stroke-opacity="0.55"/>`
      + `<circle cx="24" cy="22" r="8" fill="${col}"/>`
      + `<text x="42" y="29" font-family="Inter" font-weight="700" font-size="19" fill="#e9f2f7">${esc(k)} <tspan fill="${ok === null ? '#93a4b3' : ok ? '#39ff88' : '#ff8aa0'}">${esc(v)}</tspan></text></g>`;
    bx += w + 12;
    return g;
  }).join('');
  const icon = iconData
    ? `<clipPath id="ic"><rect x="80" y="150" width="128" height="128" rx="30"/></clipPath><image href="${esc(iconData)}" x="80" y="150" width="128" height="128" clip-path="url(#ic)" preserveAspectRatio="xMidYMid slice"/><rect x="80" y="150" width="128" height="128" rx="30" fill="none" stroke="#39ff88" stroke-opacity="0.5" stroke-width="2"/>`
    : `<rect x="80" y="150" width="128" height="128" rx="30" fill="url(#avg)" stroke="#39ff88" stroke-opacity="0.5" stroke-width="2"/><text x="144" y="236" text-anchor="middle" font-family="Inter" font-weight="900" font-size="64" fill="#39ff88">${esc(sym.charAt(0).toUpperCase())}</text>`;
  const logo = logoData
    ? `<clipPath id="lg"><rect x="80" y="62" width="58" height="58" rx="16"/></clipPath><image href="${esc(logoData)}" x="80" y="62" width="58" height="58" clip-path="url(#lg)"/><rect x="80" y="62" width="58" height="58" rx="16" fill="none" stroke="#39ff88" stroke-opacity="0.6" stroke-width="1.5"/>`
    : '';
  const peakColor = st !== 'live' ? '#ff5c7a' : snap.peak >= 2 ? '#39ff88' : snap.peak >= 1.05 ? '#5ff0b0' : '#e9f2f7';
  const stamp = st !== 'live'
    ? `<g transform="translate(880,180) rotate(-10) scale(0.8)" opacity="0.92"><rect x="-200" y="-52" width="400" height="104" rx="14" fill="rgba(255,40,80,0.10)" stroke="#ff3b62" stroke-width="7"/><text x="0" y="${st === 'pulled' ? 4 : 22}" text-anchor="middle" font-family="Inter" font-weight="900" font-size="${st === 'pulled' ? 40 : 66}" letter-spacing="6" fill="#ff3b62">${st === 'pulled' ? 'LIQUIDITY' : 'RUGGED'}</text>${st === 'pulled' ? '<text x="0" y="40" text-anchor="middle" font-family="Inter" font-weight="900" font-size="30" letter-spacing="6" fill="#ff3b62">PULLED</text>' : ''}</g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
<radialGradient id="g1" cx="0.12" cy="0.05" r="0.75"><stop offset="0" stop-color="#00e676" stop-opacity="0.38"/><stop offset="1" stop-color="#00e676" stop-opacity="0"/></radialGradient>
<radialGradient id="g2" cx="0.95" cy="1" r="0.8"><stop offset="0" stop-color="#2f6bff" stop-opacity="0.45"/><stop offset="1" stop-color="#2f6bff" stop-opacity="0"/></radialGradient>
<linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#39ff88" stop-opacity="0.85"/><stop offset="0.45" stop-color="#ffffff" stop-opacity="0.08"/><stop offset="1" stop-color="#00a8ff" stop-opacity="0.85"/></linearGradient>
<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.075"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.02"/></linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF3C4"/><stop offset="0.3" stop-color="#FFE58A"/><stop offset="0.6" stop-color="#F5C542"/><stop offset="1" stop-color="#C9971C"/></linearGradient>
<linearGradient id="avg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f2a20"/><stop offset="1" stop-color="#0a1c2e"/></linearGradient>
<filter id="glow" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>
<rect width="1200" height="630" fill="#030507"/>
<rect width="1200" height="630" fill="url(#g1)"/><rect width="1200" height="630" fill="url(#g2)"/>
<rect x="36" y="36" width="1128" height="558" rx="34" fill="url(#glass)" stroke="url(#edge)" stroke-width="2"/>
${logo}
<text x="${logoData ? 152 : 80}" y="104" font-family="Inter" font-weight="900" font-size="38" fill="url(#gold)">MaxiGems</text>
<g transform="translate(1120,72)"><rect x="-212" width="212" height="40" rx="20" fill="rgba(153,69,255,0.16)" stroke="#14F195" stroke-opacity="0.45"/><text x="-106" y="27" text-anchor="middle" font-family="Inter" font-weight="700" font-size="18" letter-spacing="2" fill="#d9fff0">SOLANA CALL</text></g>
${icon}
<text x="232" y="${208 + Math.round(symSize * 0.18)}" font-family="Inter" font-weight="900" font-size="${symSize}" fill="#ffffff">$${esc(sym)}</text>
<text x="234" y="262" font-family="Inter" font-weight="400" font-size="28" fill="#93a4b3">${esc(name)}</text>
<text x="80" y="340" font-family="Inter" font-weight="700" font-size="22" letter-spacing="3" fill="#93a4b3">MC AT CALL → PEAK MC</text>
<text x="80" y="388" font-family="Inter" font-weight="900" font-size="40" fill="#e9f2f7">${esc(fmtUsd(c.mcAtCall))} <tspan fill="#00a8ff">→</tspan> ${esc(fmtUsd(snap.peakMc))}</text>
<text x="80" y="438" font-family="Inter" font-weight="700" font-size="24" fill="#93a4b3">Now <tspan fill="${snap.cur !== null && snap.cur >= 1.05 ? '#39ff88' : snap.cur !== null && snap.cur < 0.95 ? '#ff5c7a' : '#e9f2f7'}" font-weight="900">${esc(cur)}</tspan>  ·  Called ${esc(fmtCalled(c.calledAt))}</text>
<text x="1120" y="292" text-anchor="end" font-family="Inter" font-weight="700" font-size="24" letter-spacing="5" fill="#93a4b3">PEAK SINCE CALL</text>
<text x="1120" y="${292 + Math.round(peakSize * 0.86)}" text-anchor="end" font-family="Inter" font-weight="900" font-size="${peakSize}" fill="${peakColor}" opacity="0.55" filter="url(#glow)">${esc(pk)}</text>
<text x="1120" y="${292 + Math.round(peakSize * 0.86)}" text-anchor="end" font-family="Inter" font-weight="900" font-size="${peakSize}" fill="${peakColor}">${esc(pk)}</text>
${badgeSvg}
${stamp}
<line x1="80" y1="540" x2="1120" y2="540" stroke="#ffffff" stroke-opacity="0.08"/>
<text x="80" y="574" font-family="Inter" font-weight="900" font-size="24" fill="#39ff88">maxigems.fun</text>
<text x="1120" y="574" text-anchor="end" font-family="Inter" font-weight="400" font-size="19" fill="#93a4b3">t.me/maxigems_calls · @maxigems_sol · Not financial advice</text>
</svg>`;
}

// ---------------------------------------------------------------- rendering
let _render = null;
async function renderer() {
  if (_render) return _render;
  const { Resvg } = await import('@resvg/resvg-js');
  let sharp = null;
  try { sharp = (await import('sharp')).default; } catch { /* optional */ }
  const fontFiles = ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'Inter-Black.ttf'].map((f) => path.join(ROOT, 'fonts', f));
  _render = {
    sharp,
    async png(svg) {
      const raw = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
      if (!sharp) return raw;
      return sharp(raw).png({ palette: true, quality: 90, effort: 8, compressionLevel: 9, dither: 0.6 }).toBuffer();
    },
  };
  return _render;
}

/** Fetch a token icon safely: whitelisted https hosts, 6s timeout, 1.5MB cap, image/* only → 160px PNG data URI. */
export async function fetchIcon(url, { timeoutMs = 6000, maxBytes = 1.5e6, fetchImpl = fetch } = {}) {
  if (!url || !IMG_RE.test(String(url))) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error', headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' } });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null;
    if (num(res.headers.get('content-length')) > maxBytes) return null;
    const chunks = []; let n = 0;
    for await (const ch of res.body) { n += ch.length; if (n > maxBytes) { ctrl.abort(); return null; } chunks.push(ch); }
    const buf = Buffer.concat(chunks);
    const r = await renderer();
    if (!r.sharp) return /^image\/png/.test(res.headers.get('content-type')) ? `data:image/png;base64,${buf.toString('base64')}` : null;
    const png = await r.sharp(buf, { limitInputPixels: 4096 * 4096, animated: false }).resize(160, 160, { fit: 'cover' }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

let _logo = null;
function logoData() {
  if (_logo !== null) return _logo;
  try { _logo = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'site', 'assets', 'logo-128.png')).toString('base64')}`; } catch { _logo = ''; }
  return _logo || null;
}

export async function renderCard(c, snap, opts = {}) {
  const r = await renderer();
  const iconData = opts.iconData !== undefined ? opts.iconData : await fetchIcon(c.imageUrl, opts);
  return r.png(cardSvg(c, snap, { iconData, logoData: logoData() }));
}

// ---------------------------------------------------------------- page HTML
let _tpl = null;
/** Shared header / CTA / footer cut from site/index.html so every page stays in sync. */
export function templateParts(html) {
  if (!html) { if (!_tpl) _tpl = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8'); html = _tpl; }
  const cut = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`template: missing ${a}`); return html.slice(i, j + b.length); };
  const header = cut('<header class="hdr">', '</header>').replace(/ aria-current="page"/g, '');
  const cta = cut('<div class="cta">', '</a>\n    </div>');
  const footer = cut('<footer class="ftr wrap">', '</footer>');
  return { header, cta, footer };
}

export function shareText(c, snap) {
  const sym = clean(String(c.symbol || '').replace(/^\$/, ''), 16) || '???';
  return `$${sym} called by @maxigems_sol 💎 ${fmtX(snap.peak)} peak since call`;
}

/** Pure: full HTML for /c/<CA>/. */
export function coinPageHtml(c, snap, parts = templateParts()) {
  const ca = c.address;
  if (!isSolAddress(ca)) throw new Error('invalid CA');
  const pair = isSolAddress(c.pairAddress) ? c.pairAddress : ca;
  const sym = clean(String(c.symbol || '').replace(/^\$/, ''), 16) || '???';
  const name = clean(c.name, 40) || sym;
  const url = coinUrl(ca);
  const img = snap.hasCard ? `${url}card.png?v=${CARD_VERSION}-${Math.round(snap.peak * 100)}-${snap.status}` : `${SITE}/assets/og-image.jpg`;
  const st = snap.status;
  const title = `$${sym} called by MaxiGems — ${fmtX(snap.peak)} peak${st !== 'live' ? ` (${STATUS_LABEL[st].toLowerCase()})` : ''}`;
  const desc = `${name} ($${sym}) on Solana. Called at ${fmtUsd(c.mcAtCall)} MC on ${fmtCalled(c.calledAt)} — peak ${fmtX(snap.peak)} (${fmtUsd(snap.peakMc)} MC). Live tracking by MaxiGems. Not financial advice.`;
  const s = c.safety;
  const sf = (k, ok, v) => `<span class="sf ${ok ? 'ok' : 'bad'}">${k} <b>${esc(v)}</b></span>`;
  const safety = s ? `<div class="safety" aria-label="On-chain safety at call time"><span class="sf-t" aria-hidden="true">🛡</span>${sf('Mint', s.mint === true, s.mint === true ? '✓' : '✕')}${sf('Freeze', s.freeze === true, s.freeze === true ? '✓' : '✕')}${sf('LP', num(s.lp) !== null && num(s.lp) >= 80, pctTxt(s.lp))}${sf('Top10', num(s.top10) !== null && num(s.top10) <= 35, pctTxt(s.top10))}</div>` : '';
  const xc = (v) => (v === null ? 'flat' : v >= 1.05 ? 'up' : v < 0.95 ? 'down' : 'flat');
  const iconOk = c.imageUrl && IMG_RE.test(String(c.imageUrl));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="theme-color" content="#39ff88" />
  <link rel="canonical" href="${esc(url)}" />
  <meta property="og:url" content="${esc(url)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="MaxiGems" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(img)}" />
  <meta property="og:image:type" content="${snap.hasCard ? 'image/png' : 'image/jpeg'}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(`MaxiGems call card for $${sym}: ${fmtX(snap.peak)} peak since call`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@maxigems_sol" />
  <meta name="twitter:creator" content="@maxigems_sol" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(img)}" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self' https://solana-rpc.publicnode.com https://public.rpc.solanavibestation.com https://rpc.solanatracker.io; manifest-src 'self'; base-uri 'none'; form-action 'none'" />
  <meta name="referrer" content="no-referrer" />
  <link rel="icon" href="/favicon.ico" sizes="48x48" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <link rel="stylesheet" href="/assets/styles.css" />
  <link rel="stylesheet" href="/assets/whales.css" />
</head>
<body class="coin-page" data-ca="${esc(ca)}" data-symbol="${esc(sym)}" data-peak="${esc(snap.peak)}" data-card="${snap.hasCard ? '1' : '0'}">
  <a class="skip" href="#coin">Skip to coin</a>
  <div class="bg" aria-hidden="true"><span class="orb o1"></span><span class="orb o2"></span><span class="grid"></span></div>

  ${parts.header}

  <section class="hero wrap hero-sm">
    ${parts.cta}
  </section>

  <main class="wrap coin-wrap" id="main">
    <article class="card coin" id="coin" aria-label="${esc(`${name} ($${sym})`)}">
      <div class="top">
        ${iconOk ? `<img class="ava" src="${esc(dsThumb(c.imageUrl))}" alt="" width="56" height="56" referrerpolicy="no-referrer" decoding="async" fetchpriority="high" />` : `<div class="ava" aria-hidden="true">${esc(sym.charAt(0).toUpperCase())}</div>`}
        <div class="ttl"><h1 class="nm">${esc(name)}</h1><div class="sym">$${esc(sym)} <span class="badge sol">Solana</span> <span class="badge st ${st === 'live' ? 'st-live' : st === 'pulled' ? 'st-pull' : 'st-rug'}" id="cStatus">${esc(STATUS_LABEL[st])}</span></div></div>
        <div class="xbox"><div class="x ${st !== 'live' ? 'down' : xc(snap.peak)}" id="cPeak">${esc(fmtX(snap.peak))}</div><div class="xl">peak since call</div></div>
      </div>
      <div class="kv">
        <div><span>MC at call</span><b>${esc(fmtUsd(c.mcAtCall))}</b></div>
        <div><span>Peak MC</span><b id="cPeakMc">${esc(fmtUsd(snap.peakMc))}</b></div>
        <div><span>Now x</span><b class="${xc(snap.cur) === 'up' ? 'pos' : xc(snap.cur) === 'down' ? 'neg' : ''}" id="cCur">${esc(snap.cur === null ? '—' : fmtX(snap.cur))}</b></div>
        <div><span>MC now</span><b id="cMcNow">${esc(fmtUsd(snap.curMc))}</b></div>
      </div>
      ${safety}
      <div class="ca"><code title="${esc(ca)}">${esc(ca)}</code><button class="copy" type="button" id="cCopy" aria-label="Copy contract address">Copy CA</button></div>
      <div class="foot">
        <span class="ago">Called <time datetime="${esc(new Date(c.calledAt).toISOString())}" id="cCalled">${esc(fmtCalled(c.calledAt))}</time></span>
        <div class="lnk">
          <a class="pri" href="https://dexscreener.com/solana/${pair}" target="_blank" rel="noopener noreferrer">DexScreener</a>
          <a href="https://solscan.io/token/${ca}" target="_blank" rel="noopener noreferrer">Solscan</a>
          <a href="https://jup.ag/swap/SOL-${ca}" target="_blank" rel="noopener noreferrer">Jupiter</a>
        </div>
      </div>
      <div class="coin-actions">
        <button type="button" class="share-btn big" id="cShare" aria-haspopup="dialog">Share this call</button>
        <a class="all-link" href="/">← View all calls</a>
      </div>
    </article>
    <p class="note muted">Peak x = highest price since the call ÷ call price, tracked every ~10 minutes. Not financial advice.</p>
  </main>

  ${tipCardHtml(tipAddress(), { compact: true })}

  ${parts.footer}

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="/config.js"></script>
  <script src="/assets/common.js"></script>
  <script src="/assets/share.js"></script>
  <script src="/assets/coin.js"></script>
  <script src="/assets/tip.js"></script>
</body>
</html>
`;
}

export function sitemapXml(cas) {
  const urls = BASE_URLS.map((u, i) => `  <url><loc>${SITE}${u}</loc><changefreq>hourly</changefreq><priority>${i ? '0.8' : '1.0'}</priority></url>`)
    .concat(cas.filter(isSolAddress).map((ca) => `  <url><loc>${esc(coinUrl(ca))}</loc><changefreq>daily</changefreq><priority>0.5</priority></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function writeIfChanged(file, data) {
  try { if (fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) return false; } catch { /* rewrite */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  return true;
}

/**
 * Generate share pages/cards for site calls. calls = siteData().calls (public fields only).
 * Returns stats. Never throws.
 */
export async function generateShare(calls, { siteDir, manifestFile, maxRenders = 25, timeBudgetMs = 90e3, render = renderCard, now = Date.now() } = {}) {
  const t0 = Date.now();
  const out = { rendered: 0, pages: 0, queued: 0, errors: 0, ms: 0 };
  try {
    let man = { version: 1, coins: {} };
    try { man = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); if (!man.coins) man.coins = {}; } catch { /* fresh */ }
    const list = (calls || []).filter((c) => c && isSolAddress(c.address) && isFinite(Date.parse(c.calledAt)))
      .sort((a, b) => Date.parse(b.calledAt) - Date.parse(a.calledAt)); // newest first → new calls get cards first
    let parts = null;
    try { parts = templateParts(); } catch (e) { log(`WARN share: template ${e.message}`); return out; }
    for (const c of list) {
      const prev = man.coins[c.address];
      let snap = prev;
      if (needsRender(prev, c)) {
        const cardFile = path.join(siteDir, 'c', c.address, 'card.png');
        const material = !prev || prev.v !== CARD_VERSION || prev.status !== statusOf(c) || Math.abs(peakX(c) - (prev.peak ?? 0)) >= 0.05;
        let done = false;
        if (out.rendered + out.errors < maxRenders && Date.now() - t0 < timeBudgetMs) {
          const next = snapshotOf(c, true);
          try {
            writeIfChanged(cardFile, await render(c, next));
            snap = next; out.rendered++; done = true;
          } catch (e) {
            out.errors++; log(`WARN share: card ${c.symbol} failed: ${e.message}`);
          }
        } else out.queued++;
        // not rendered this run: keep the previous snapshot unless the numbers moved materially; retry next run
        if (!done) snap = { ...(material || !prev ? snapshotOf(c, fs.existsSync(cardFile)) : prev), dirty: true };
        man.coins[c.address] = { ...snap, symbol: clean(c.symbol, 16) };
      }
      if (man.coins[c.address].curMc === undefined) man.coins[c.address].curMc = num(c.currentMc); // one-time backfill (older manifests)
      const html = coinPageHtml(c, man.coins[c.address], parts);
      if (writeIfChanged(path.join(siteDir, 'c', c.address, 'index.html'), html)) out.pages++;
    }
    writeIfChanged(manifestFile, JSON.stringify(man, null, 1) + '\n');
    const cas = Object.keys(man.coins).filter((ca) => isSolAddress(ca) && fs.existsSync(path.join(siteDir, 'c', ca, 'index.html')));
    writeIfChanged(path.join(siteDir, 'sitemap.xml'), sitemapXml(cas));
  } catch (e) {
    out.errors++; log(`WARN share generation failed: ${e.message}`);
  }
  out.ms = Date.now() - t0;
  log(`share: ${out.rendered} cards rendered, ${out.pages} pages written, ${out.queued} queued, ${out.errors} errors (${out.ms}ms)`);
  return out;
}
