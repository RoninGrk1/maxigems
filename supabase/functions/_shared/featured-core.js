// MaxiGems Featured listings: pure logic shared by the Supabase Edge Functions (Deno), the engine (Node) and tests.
// No imports, no I/O. Money is never computed here (price comes from the shared payments core / CONTRACT.md).
//
// Rules (user-approved): 1 SOL = 24h sponsored spot at the top of /trending/ + ONE "Sponsored" channel post.
//  - max 3 listings live at once; extra bookings go on a waitlist with the next available start time
//  - max 1 sponsored channel post per 24h across ALL listings, and every listing's post must land inside its own
//    window (≥ 1h before it ends), so a booking only starts once a post slot is guaranteed
//  - the coin must pass the engine's RugCheck hard rules + liquidity/age minimums, and not be rugged/live already

export const FEATURED_RULES = Object.freeze({
  hours: 24,
  maxConcurrent: 3,
  maxPostsPerDay: 1,
  postLeadMs: 3600000, // a listing's post must be due ≥ 1h before its window closes
  minLiquidityUsd: 20000, // = config.json filters.minLiquidityUsd (test/featured.test.js keeps them in sync)
  minAgeMinutes: 90, // = config.json filters.minAgeMinutes
  adminLinkMaxTtlMs: 72 * 3600000,
});

const H = 3600000;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (t) => new Date(t).toISOString();
const ms = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : NaN; };

/** Decode base58 → bytes (null if invalid). */
export function b58decode(s) {
  if (typeof s !== 'string' || !s) return null;
  const bytes = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === '1') bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}

/** A Solana mint address: base58 that decodes to exactly 32 bytes. */
export function isMint(ca) {
  if (typeof ca !== 'string' || !B58_RE.test(ca)) return false;
  const b = b58decode(ca);
  return !!b && b.length === 32;
}

/** Trim + strip anything that isn't base58 (users paste with spaces/quotes/URLs). Returns '' if nothing usable. */
export function normalizeCa(input) {
  const s = String(input ?? '').trim();
  const m = /[1-9A-HJ-NP-Za-km-z]{32,44}/.exec(s.replace(/^https?:\/\/\S*?\/(?=[1-9A-HJ-NP-Za-km-z]{32,44})/, ''));
  return m ? m[0] : '';
}

const LIVE = new Set(['queued', 'active']);
/** A listing that occupies (or will occupy) a slot. */
export const isLive = (l) => !!l && LIVE.has(l.status) && Number.isFinite(ms(l.ends_at));

/** Map an engine safety reason to plain English for the /featured/ page. */
export function humanReason(r) {
  const s = String(r || '');
  const m = (re) => re.exec(s);
  let x;
  if (/mint authority/.test(s)) return 'Mint authority is still active (the dev can print more tokens).';
  if (/freeze authority/.test(s)) return 'Freeze authority is still active (wallets can be frozen).';
  if (/LP lock unknown/.test(s)) return 'Liquidity lock could not be verified.';
  if ((x = m(/LP locked (\d+)%/))) return `Only ${x[1]}% of liquidity is locked or burned (minimum 80%).`;
  if ((x = m(/top10 ([\d.]+)%/))) return `Top 10 holders own ${x[1]}% of supply (maximum 35%).`;
  if ((x = m(/insiders ([\d.]+)%/))) return `Insiders hold ${x[1]}% of supply (maximum 15%).`;
  if ((x = m(/creator holds ([\d.]+)%/))) return `The creator still holds ${x[1]}% of supply (maximum 8%).`;
  if ((x = m(/insider network (\d+)\/(\d+)/))) return `RugCheck found a large insider wallet network (${x[1]} of ${x[2]} holders).`;
  if ((x = m(/holders (\d+)/))) return `Only ${x[1]} holders (minimum 200).`;
  if (/flagged rugged/.test(s)) return 'RugCheck flags this token as rugged.';
  if (/transfer fee/.test(s)) return 'The token charges a transfer fee.';
  if ((x = m(/danger \((.*)\)/))) return `RugCheck danger warnings: ${x[1]}.`;
  if ((x = m(/rugcheck score ([\d.]+)/))) return `RugCheck risk score is ${x[1]} (must be 0).`;
  if (/rugcheck unavailable|no rugcheck data/.test(s)) return 'RugCheck could not be reached, so the safety check failed closed. Try again in a few minutes.';
  return s.replace(/^safety: /, '');
}

/** Best Solana pair for this mint on DexScreener (deepest liquidity), or null. */
export function pickPair(pairs, ca) {
  const list = (Array.isArray(pairs) ? pairs : []).filter((p) => p && p.chainId === 'solana' && p.baseToken?.address === ca);
  list.sort((a, b) => (num(b?.liquidity?.usd) ?? 0) - (num(a?.liquidity?.usd) ?? 0));
  return list[0] ?? null;
}

const cleanText = (s, max) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const IMG_RE = /^https:\/\/(cdn\.dexscreener\.com|dd\.dexscreener\.com|assets\.geckoterminal\.com|coin-images\.coingecko\.com)\//;

/** Token summary from a DexScreener pair (all strings cleaned, image limited to known CDNs). */
export function tokenFromPair(p, ca, now = Date.now()) {
  const created = num(p?.pairCreatedAt);
  return {
    ca,
    symbol: cleanText(p?.baseToken?.symbol, 16).replace(/^\$/, ''),
    name: cleanText(p?.baseToken?.name, 40),
    imageUrl: IMG_RE.test(String(p?.info?.imageUrl ?? '')) ? p.info.imageUrl : null,
    dex: String(p?.dexId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
    pairAddress: B58_RE.test(String(p?.pairAddress ?? '')) ? p.pairAddress : null,
    priceUsd: num(p?.priceUsd),
    liquidityUsd: num(p?.liquidity?.usd),
    marketCap: num(p?.marketCap) ?? num(p?.fdv),
    ageMinutes: created ? Math.floor((now - created) / 60000) : null,
  };
}

/**
 * Earliest slot for a new booking. Pure. `listings` = rows with status/starts_at/ends_at/post_due_at.
 * start t = earliest time ≥ now such that
 *   (a) fewer than maxConcurrent live listings overlap [t, t+24h)   → waitlist when the slots are full
 *   (b) a post slot p ≥ lastPlannedPost + 24h/maxPostsPerDay exists with p ≤ t + 24h − postLeadMs
 * Returns { startsAt, endsAt, postDueAt, waitlisted, ahead } (ISO strings).
 */
export function schedule(listings, now = Date.now(), rules = FEATURED_RULES) {
  const dur = rules.hours * H;
  const live = (listings || []).filter(isLive).filter((l) => ms(l.ends_at) > now);
  const gap = (24 * H) / Math.max(1, rules.maxPostsPerDay);
  const posts = (listings || []).filter((l) => l && l.status !== 'pulled').map((l) => ms(l.posted_at) || ms(l.post_due_at)).filter(Number.isFinite);
  const lastPost = posts.length ? Math.max(...posts) : -Infinity;
  const postFloor = lastPost + gap; // earliest next post
  // candidate starts: now, every live listing end, and the earliest start that still fits a post
  const cands = [now, ...live.map((l) => ms(l.ends_at)), postFloor - (dur - rules.postLeadMs)].filter((t) => Number.isFinite(t) && t >= now).sort((a, b) => a - b);
  const overlap = (t) => live.filter((l) => ms(l.starts_at) < t + dur && ms(l.ends_at) > t).length;
  const fitsPost = (t) => Math.max(t, postFloor) <= t + dur - rules.postLeadMs;
  let start = null;
  for (const t of cands) if (overlap(t) < rules.maxConcurrent && fitsPost(t)) { start = t; break; }
  if (start === null) { // walk forward through ends (always terminates: past the last end nothing overlaps)
    const ends = live.map((l) => ms(l.ends_at)).sort((a, b) => a - b);
    start = Math.max(now, ends[ends.length - 1] ?? now, postFloor - (dur - rules.postLeadMs));
  }
  const postDue = Math.max(start, postFloor);
  return {
    startsAt: iso(start),
    endsAt: iso(start + dur),
    postDueAt: iso(postDue),
    waitlisted: start > now + 60000,
    ahead: live.filter((l) => ms(l.starts_at) <= start).length,
  };
}

/**
 * The full order check (pure; the I/O wrapper in featured.ts fetches the inputs).
 * @param o { ca, pairs (DexScreener tokens/v1), report (RugCheck), rpc, ruggedCas (Set from /data/calls.json),
 *            listings (existing featured_listings rows), analyzeReport, safetyRules, now, rules }
 * @returns { ok, reasons: string[] (plain English), codes: string[], token, safety, quote }
 */
export function evaluate(o) {
  const rules = o.rules ?? FEATURED_RULES;
  const now = o.now ?? Date.now();
  const ca = o.ca;
  const fail = (codes, reasons, extra = {}) => ({ ok: false, codes, reasons, token: null, safety: null, quote: null, ...extra });
  if (!isMint(ca)) return fail(['invalid_ca'], ['That is not a valid Solana token address (it should be 32–44 base58 characters).']);
  if ((o.listings || []).some((l) => isLive(l) && l.ca === ca && ms(l.ends_at) > now)) {
    return fail(['already_featured'], ['This token is already featured or waiting in the queue.']);
  }
  const p = pickPair(o.pairs, ca);
  if (!p) return fail(['no_pair'], ['No Solana trading pair was found on DexScreener for this token.']);
  const token = tokenFromPair(p, ca, now);
  const codes = [], reasons = [];
  if (o.ruggedCas && o.ruggedCas.has(ca)) { codes.push('rugged'); reasons.push('MaxiGems has flagged this token as rugged.'); }
  if (token.liquidityUsd === null || token.liquidityUsd < rules.minLiquidityUsd) {
    codes.push('low_liquidity');
    reasons.push(`Liquidity is ${token.liquidityUsd === null ? 'unknown' : '$' + Math.round(token.liquidityUsd).toLocaleString('en-US')} (minimum $${rules.minLiquidityUsd.toLocaleString('en-US')}).`);
  }
  if (token.ageMinutes === null || token.ageMinutes < rules.minAgeMinutes) {
    codes.push('too_new');
    reasons.push(`The trading pair is ${token.ageMinutes === null ? 'of unknown age' : token.ageMinutes + ' minutes old'} (minimum ${rules.minAgeMinutes} minutes).`);
  }
  let safety = null;
  if (!o.report) { codes.push('rugcheck_unavailable'); reasons.push(humanReason('safety: rugcheck unavailable')); }
  else {
    const r = o.analyzeReport(o.report, { pairAddress: token.pairAddress, rpc: o.rpc }, o.safetyRules);
    safety = r.safety;
    for (const x of r.reasons) { codes.push('safety'); reasons.push(humanReason(x)); }
  }
  if (reasons.length) return { ok: false, codes, reasons, token, safety, quote: null };
  return { ok: true, codes: [], reasons: [], token, safety, quote: schedule(o.listings, now, rules) };
}

/**
 * What changes now. Pure. Returns ids to activate (queued → active), end (→ ended) and AT MOST ONE id to post,
 * only if ≥ 24h/maxPostsPerDay since the last real post (strict daily cap even if the engine ran late).
 */
export function tick(listings, now = Date.now(), rules = FEATURED_RULES) {
  const activate = [], end = [], post = [];
  for (const l of listings || []) {
    if (!isLive(l)) continue;
    if (ms(l.ends_at) <= now) end.push(l.id);
    else if (l.status === 'queued' && ms(l.starts_at) <= now) activate.push(l.id);
  }
  const gap = (24 * H) / Math.max(1, rules.maxPostsPerDay);
  const sent = (listings || []).map((l) => ms(l?.posted_at)).filter(Number.isFinite);
  const last = sent.length ? Math.max(...sent) : -Infinity;
  if (now - last >= gap) {
    const due = (listings || []).filter((l) => isLive(l) && !end.includes(l.id) && !l.posted_at && !l.post_skipped
      && ms(l.starts_at) <= now && ms(l.post_due_at || l.starts_at) <= now && ms(l.ends_at) - now > rules.postLeadMs / 2)
      .sort((a, b) => ms(a.post_due_at || a.starts_at) - ms(b.post_due_at || b.starts_at));
    if (due.length) post.push(due[0].id);
  }
  return { activate, end, post };
}

/** Listings to show on the site right now (active by time; pulled/ended never). */
export function visibleNow(listings, now = Date.now()) {
  return (listings || []).filter((l) => isLive(l) && ms(l.starts_at) <= now && ms(l.ends_at) > now)
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
}

/** Public projection for site/data/featured.json: no wallet, no order id, no message ids. */
export function publicListing(l) {
  const t = l.token || {};
  const s = l.safety || {};
  return {
    ca: l.ca,
    symbol: cleanText(l.symbol ?? t.symbol, 16),
    name: cleanText(t.name ?? l.symbol, 40),
    imageUrl: IMG_RE.test(String(t.imageUrl ?? '')) ? t.imageUrl : null,
    dex: t.dex ?? null,
    pairAddress: B58_RE.test(String(t.pairAddress ?? '')) ? t.pairAddress : null,
    startsAt: l.starts_at,
    endsAt: l.ends_at,
    safety: { mint: !!s.mintRevoked, freeze: !!s.freezeRevoked, lp: num(s.lpLockedPct), top10: num(s.top10Pct), holders: num(s.holders) },
  };
}

// ------------------------------------------------------------------ signed admin links (HMAC-SHA256, WebCrypto)
const enc = new TextEncoder();
const b64url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Token "<id>.<expSeconds>.<sig>" authorising ONE action on ONE listing until exp. Secret must be ≥ 32 chars. */
export async function signAdminToken({ id, action = 'pull', exp }, secret) {
  if (!secret || secret.length < 32) throw new Error('FEATURED_ADMIN_SECRET missing or too short');
  if (!ID_RE.test(String(id))) throw new Error('bad listing id');
  const e = Math.floor(exp / 1000);
  return `${id}.${e}.${await hmac(secret, `mg-featured:${action}:${id}:${e}`)}`;
}

/** Verify a token. Returns { ok:true, id } or { ok:false, error: 'malformed'|'expired'|'bad_signature' }. Constant-time compare. */
export async function verifyAdminToken(token, secret, { action = 'pull', now = Date.now() } = {}) {
  const m = /^([A-Za-z0-9-]{1,64})\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m || !secret || secret.length < 32) return { ok: false, error: 'malformed' };
  const want = await hmac(secret, `mg-featured:${action}:${m[1]}:${m[2]}`);
  let x = want.length ^ m[3].length;
  for (let i = 0; i < want.length; i++) x |= want.charCodeAt(i) ^ (m[3].charCodeAt(i) || 0);
  if (x !== 0) return { ok: false, error: 'bad_signature' };
  if (Number(m[2]) * 1000 <= now) return { ok: false, error: 'expired' };
  return { ok: true, id: m[1] };
}

/** Admin link expiry: the end of the listing, capped at adminLinkMaxTtlMs from now. */
export const adminLinkExp = (endsAt, now = Date.now(), rules = FEATURED_RULES) => Math.min(ms(endsAt) || now, now + rules.adminLinkMaxTtlMs);

/** The admin page URL (token in the #fragment: never sent to a server, never in access logs). */
export const adminUrl = (site, token) => `${String(site || 'https://maxigems.fun/').replace(/\/?$/, '/')}featured/admin/#${token}`;

// ------------------------------------------------------------------ Telegram text (HTML parse mode; everything escaped)
export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtWhen = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const usd = (v) => { const n = num(v); if (n === null) return '?'; return n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`; };

/**
 * Admin DM on every paid booking. The only button is a URL to the signed admin page (no callback/webhook).
 * @param {any} listing
 * @param {{url?: string, sol?: string, signature?: string, test?: boolean}} [opts]
 */
export function adminBookingMessage(listing, { url, sol, signature, test = false } = {}) {
  const t = listing.token || {};
  const s = listing.safety || {};
  const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '?');
  const text = [
    `🟡 <b>New featured booking</b>${test ? ' (TEST payment)' : ''}`,
    ``,
    `🪙 <b>${escapeHtml(t.name || listing.symbol)}</b> ($${escapeHtml(listing.symbol)})`,
    `📋 <code>${escapeHtml(listing.ca)}</code>`,
    `💧 Liq ${escapeHtml(usd(t.liquidityUsd))} • MC ${escapeHtml(usd(t.marketCap))}`,
    `🛡 Mint ${s.mintRevoked ? '✅' : '❌'} | Freeze ${s.freezeRevoked ? '✅' : '❌'} | LP ${escapeHtml(s.lpLockedPct ?? '?')}% | Top10 ${escapeHtml(s.top10Pct ?? '?')}%`,
    ``,
    `🕒 ${escapeHtml(fmtWhen(listing.starts_at))} → ${escapeHtml(fmtWhen(listing.ends_at))}${listing.status === 'queued' && Date.parse(listing.starts_at) > Date.now() + 60000 ? ' (waitlist)' : ''}`,
    `📣 Channel post due ${escapeHtml(fmtWhen(listing.post_due_at || listing.starts_at))}`,
    `👛 Payer <code>${escapeHtml(short(listing.wallet))}</code>${sol ? ` • ${escapeHtml(sol)} SOL` : ''}`,
    signature ? `🔗 <a href="https://solscan.io/tx/${escapeHtml(signature)}">Payment tx</a>` : null,
    ``,
    `<i>Refunds are manual. The pull link expires ${escapeHtml(fmtWhen(listing.link_exp ?? listing.ends_at))}.</i>`,
  ].filter((x) => x !== null).join('\n');
  const buttons = [[{ text: '🛑 Pull listing', url }], [{ text: '📊 Chart', url: `https://dexscreener.com/solana/${listing.ca}` }]];
  return { text, buttons };
}
