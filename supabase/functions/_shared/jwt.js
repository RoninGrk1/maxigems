// Tiny HS256 JWT (WebCrypto) for MaxiGems sessions. Issued by the `auth` function after SIWS; checked by every gated call.
const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const key = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export const SESSION_TTL_S = 24 * 3600;
export const AUD = 'maxigems-pro';

export async function signJwt(claims, secret, ttlS = SESSION_TTL_S, nowS = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32) throw new Error('session secret missing/too short');
  const head = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(enc.encode(JSON.stringify({ ...claims, aud: AUD, iat: nowS, exp: nowS + ttlS })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64u(sig)}`;
}

/** Returns claims or null (bad signature, alg, audience or expired). */
export async function verifyJwt(token, secret, nowS = Math.floor(Date.now() / 1000)) {
  try {
    if (!secret || typeof token !== 'string' || token.length > 2048) return null;
    const [h, b, s] = token.split('.');
    if (!h || !b || !s) return null;
    const head = JSON.parse(new TextDecoder().decode(fromB64u(h)));
    if (head.alg !== 'HS256') return null;
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64u(s), enc.encode(`${h}.${b}`));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64u(b)));
    if (c.aud !== AUD || typeof c.exp !== 'number' || c.exp <= nowS) return null;
    return c;
  } catch { return null; }
}
