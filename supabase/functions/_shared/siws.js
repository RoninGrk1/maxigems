// Sign-In With Solana (SIWS-style, EIP-4361 shaped) — message build/parse + ed25519 verification via WebCrypto.
// The wallet signs a plain-text message containing the domain, address, a one-time nonce and an expiry.
import { b58decode } from './b58.js';

export const SIWS_TTL_MS = 5 * 60000;
const STATEMENT = 'Sign in to MaxiGems. This only proves you own this wallet — it is free, sends no transaction and grants no spending permission.';

/** @param {{domain:string,address:string,nonce:string,issuedAt:string,expiresAt:string,uri?:string}} p */
export function buildMessage({ domain, address, nonce, issuedAt, expiresAt, uri }) {
  return `${domain} wants you to sign in with your Solana account:\n${address}\n\n${STATEMENT}\n\nURI: ${uri || `https://${domain}`}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
}

export function parseMessage(msg) {
  if (typeof msg !== 'string' || msg.length > 1200) return null;
  const m = /^([a-z0-9.-]+(?::\d+)?) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n[\s\S]*?\nURI: (\S+)\nVersion: 1\nChain ID: mainnet\nNonce: ([A-Za-z0-9]{8,64})\nIssued At: (\S+)\nExpiration Time: (\S+)$/.exec(msg);
  if (!m) return null;
  return { domain: m[1], address: m[2], uri: m[3], nonce: m[4], issuedAt: m[5], expiresAt: m[6] };
}

export async function verifyEd25519(address, message, signatureB58) {
  try {
    const pub = b58decode(address), sig = b58decode(signatureB58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(message));
  } catch { return false; }
}

/**
 * Full check. nonceRow = { nonce, wallet, expires_at, used_at } from the DB.
 * Returns { ok:true, wallet } or { ok:false, error }.
 */
export async function checkSignIn({ message, signature, nonceRow, allowedDomains, now = Date.now() }) {
  const p = parseMessage(message);
  if (!p) return { ok: false, error: 'bad_message' };
  if (!allowedDomains.includes(p.domain)) return { ok: false, error: 'bad_domain' };
  if (!nonceRow || nonceRow.nonce !== p.nonce || nonceRow.wallet !== p.address) return { ok: false, error: 'bad_nonce' };
  if (nonceRow.used_at) return { ok: false, error: 'nonce_used' };
  if (Date.parse(nonceRow.expires_at) < now || Date.parse(p.expiresAt) < now) return { ok: false, error: 'expired' };
  if (!(await verifyEd25519(p.address, message, signature))) return { ok: false, error: 'bad_signature' };
  return { ok: true, wallet: p.address };
}
