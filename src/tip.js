// Tip card: one source of truth = site/config.js `tipAddress`.
// Pure HTML builders used by scripts/build-tip.mjs (static pages) and src/share.js (coin pages).
// The QR SVG is generated at build time only (devDependency `qrcode`) and committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 → bytes (null on any invalid char). */
export function b58bytes(s) {
  if (typeof s !== 'string' || !s) return null;
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return out;
}
export const isPubkey = (s) => typeof s === 'string' && s.length >= 32 && s.length <= 44 && b58bytes(s)?.length === 32;

let _addr;
/** tipAddress from site/config.js; '' if missing or not a valid 32-byte base58 key. */
export function tipAddress(src) {
  if (src === undefined && _addr !== undefined) return _addr;
  const txt = src ?? fs.readFileSync(path.join(ROOT, 'site', 'config.js'), 'utf8');
  const m = /^\s*tipAddress\s*:\s*'([^']*)'/m.exec(txt);
  const a = m && isPubkey(m[1]) ? m[1] : '';
  if (src === undefined) _addr = a;
  return a;
}

export const TIP_LABEL = 'MaxiGems';
export const TIP_MESSAGE = 'Tip for MaxiGems';
export const TIP_AMOUNTS = ['0.05', '0.1', '0.5'];

/** Solana Pay transfer-request URI. */
export function payUri(addr, amount) {
  if (!isPubkey(addr)) throw new Error('invalid tip address');
  const q = [];
  if (amount !== undefined) { if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error('bad amount'); q.push(`amount=${amount}`); }
  q.push(`label=${encodeURIComponent(TIP_LABEL)}`, `message=${encodeURIComponent(TIP_MESSAGE)}`);
  return `solana:${addr}?${q.join('&')}`;
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const TIP_COPY = 'Printing with MaxiGems? 💎 Toss a tip to keep the gem engine running and the calls free. Every lamport fuels the next 10x. WAGMI 🚀';
const GEM = '<svg class="tip-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3h11L22 9l-10 12L2 9l4.5-6zm.9 2L5 8.3h4.1L10.6 5H7.4zm5.9 0 1.5 3.3H19L16.6 5h-3.3zm-1.3.4L10.6 8.3h2.8L12 5.4zM4.9 10l5.5 6.6L8.3 10H4.9zm5.5 0L12 15.6l1.6-5.6h-3.2zm5.3 0-2.1 6.6L19.1 10h-3.4z"/></svg>';

/** Tip card HTML. compact = coin pages (no QR). */
export function tipCardHtml(addr, { compact = false } = {}) {
  if (!isPubkey(addr)) return '';
  const chips = TIP_AMOUNTS.map((a) => `<a class="tip-chip" href="${attr(payUri(addr, a))}" aria-label="Tip ${a} SOL with a Solana wallet">${a} SOL</a>`).join('');
  const addrRow = `<div class="tip-addr"><code title="${attr(addr)}">${attr(shortAddr(addr))}</code><button type="button" class="copy tip-copy" data-tip="${attr(addr)}" aria-label="Copy full SOL tip address">Copy</button></div>`;
  const acts = `<div class="tip-acts"><a class="tip-wallet" href="${attr(payUri(addr))}">Open in Phantom / wallet</a><a class="tip-scan-link" href="https://solscan.io/account/${attr(addr)}" target="_blank" rel="noopener noreferrer">Solscan ↗</a></div>`;
  if (compact) {
    return `<section class="tip tip-sm wrap" id="tip" aria-label="Tip MaxiGems">
    <div class="tip-card">
      <div class="tip-h">${GEM}<h2>Tip the Gem Engine</h2></div>
      <p class="tip-txt">${attr(TIP_COPY)}</p>
      ${addrRow}
      <div class="tip-chips">${chips}</div>
      ${acts}
      <p class="tip-note muted">On desktop? <a href="/#tip">Scan the QR code</a> with your wallet app.</p>
    </div>
  </section>`;
  }
  return `<section class="tip wrap" id="tip" aria-label="Tip MaxiGems">
    <div class="tip-card">
      <div class="tip-main">
        <div class="tip-h">${GEM}<h2>Tip the Gem Engine</h2></div>
        <p class="tip-txt">${attr(TIP_COPY)}</p>
        ${addrRow}
        <div class="tip-chips">${chips}</div>
        ${acts}
      </div>
      <figure class="tip-qr">
        <img src="/assets/tip-qr.svg" width="132" height="132" alt="QR code: Solana Pay tip link for ${attr(addr)}" loading="lazy" decoding="async" />
        <figcaption>Scan with your wallet app</figcaption>
      </figure>
    </div>
  </section>`;
}

/** Footer link (static, address-free). */
export const TIP_FOOTER_LINK = '<a class="ftr-tip" href="#tip"><span aria-hidden="true">💎</span> Tip</a>';
