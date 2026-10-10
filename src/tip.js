// Tip card: one source of truth = site/config.js `tipAddress`.
// Pure HTML builders used by scripts/build-tip.mjs (static pages) and src/share.js (coin pages).
// Tipping = Solana wallets only (Phantom / Solflare / Jupiter) via the lazy-loaded /assets/tip-wallet.js bundle.
import fs from 'node:fs';
import crypto from 'node:crypto';
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

export const BUNDLE = 'site/assets/tip-wallet.js';
let _ver;
/** Cache-busting version of the committed wallet bundle (sha256 prefix); '' if missing. */
export function bundleVersion() {
  if (_ver !== undefined) return _ver;
  try { _ver = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BUNDLE))).digest('hex').slice(0, 10); } catch { _ver = ''; }
  return _ver;
}
export function resetBundleVersion() { _ver = undefined; }

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const TIP_COPY = 'Printing with MaxiGems? 💎 Toss a tip to keep the gem engine running and the calls free. Every lamport fuels the next 10x. WAGMI 🚀';
const GEM = '<svg class="tip-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3h11L22 9l-10 12L2 9l4.5-6zm.9 2L5 8.3h4.1L10.6 5H7.4zm5.9 0 1.5 3.3H19L16.6 5h-3.3zm-1.3.4L10.6 8.3h2.8L12 5.4zM4.9 10l5.5 6.6L8.3 10H4.9zm5.5 0L12 15.6l1.6-5.6h-3.2zm5.3 0-2.1 6.6L19.1 10h-3.4z"/></svg>';

const LOGOS = '<span class="tip-logos" aria-hidden="true"><img src="/assets/wallets/phantom.png" alt="" width="20" height="20" loading="lazy" /><img src="/assets/wallets/solflare.png" alt="" width="20" height="20" loading="lazy" /><img src="/assets/wallets/jupiter.png" alt="" width="20" height="20" loading="lazy" /></span>';

/** Tip card HTML. compact = coin pages. No solana: links, no QR: tipping goes through the wallet modal only. */
export function tipCardHtml(addr, { compact = false, version = bundleVersion() } = {}) {
  if (!isPubkey(addr)) return '';
  const src = `/assets/tip-wallet.js${version ? `?v=${version}` : ''}`;
  return `<section class="tip${compact ? ' tip-sm' : ''} wrap" id="tip" aria-label="Tip MaxiGems">
    <div class="tip-card">
      <div class="tip-h">${GEM}<h2>Tip the Gem Engine</h2></div>
      <p class="tip-txt">${attr(TIP_COPY)}</p>
      <div class="tip-acts"><button type="button" class="tip-wallet-btn" data-tip="${attr(addr)}" data-bundle="${attr(src)}" aria-haspopup="dialog">Tip with wallet</button>${LOGOS}</div>
      <div class="tip-addr"><code title="${attr(addr)}">${attr(shortAddr(addr))}</code><button type="button" class="copy tip-copy" data-tip="${attr(addr)}" aria-label="Copy full SOL tip address">Copy address</button><a class="tip-scan-link" href="https://solscan.io/account/${attr(addr)}" target="_blank" rel="noopener noreferrer">Solscan ↗</a></div>
      <p class="tip-note muted">Solana only · Phantom, Solflare or Jupiter. You approve the exact amount in your wallet.</p>
    </div>
  </section>`;
}

/** Footer link (static, address-free). */
export const TIP_FOOTER_LINK = '<a class="ftr-tip" href="#tip"><span aria-hidden="true">💎</span> Tip</a>';
