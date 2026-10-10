// Minimal base58 (Bitcoin alphabet) encode/decode. Pure JS.
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
export function b58decode(str) {
  if (typeof str !== 'string' || !str) throw new Error('bad base58');
  let n = 0n;
  for (const c of str) { const i = A.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of str) { if (c !== '1') break; out.unshift(0); }
  return new Uint8Array(out);
}
/** 32 random bytes as a base58 pubkey (Solana Pay "reference": any unique 32-byte key, never signs). */
export function randomPubkey() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return b58encode(b);
}
export function randomToken(n = 18) {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return b58encode(b);
}
