// Build step for the tip card: `npm run build:tip`
//  1. reads tipAddress from site/config.js (validated: 32-byte base58)
//  2. writes site/assets/tip-qr.svg (Solana Pay URI) with the `qrcode` devDependency
//  3. injects the tip card between <!-- tip:start --> / <!-- tip:end --> markers in the static pages
// Coin pages (/c/<CA>/) get the compact card from src/share.js on every engine run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { tipAddress, payUri, tipCardHtml } from '../src/tip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATIC_PAGES = ['index.html', 'trending/index.html', 'leaderboard/index.html', 'whales/index.html', '404.html'];

export async function qrSvg(uri) {
  return QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 3, color: { dark: '#000000', light: '#ffffff' } });
}

export function inject(html, card) {
  const re = /<!-- tip:start -->[\s\S]*?<!-- tip:end -->/;
  if (!re.test(html)) throw new Error('missing tip markers');
  return html.replace(re, `<!-- tip:start -->\n  ${card}\n  <!-- tip:end -->`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const addr = tipAddress();
  if (!addr) { console.error('tipAddress in site/config.js is missing or not a valid Solana address'); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, 'site', 'assets', 'tip-qr.svg'), await qrSvg(payUri(addr)));
  const card = tipCardHtml(addr);
  for (const p of STATIC_PAGES) {
    const f = path.join(ROOT, 'site', p);
    fs.writeFileSync(f, inject(fs.readFileSync(f, 'utf8'), card));
  }
  console.log(`tip: ${addr} → tip-qr.svg + ${STATIC_PAGES.length} pages`);
}
