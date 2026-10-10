// FEATURED LISTINGS HOOKS (owned by the featured worker). Contract: CONTRACT.md.
// Pure rules live in featured-core.js (shared with the engine + Node tests); data access in featured-db.ts.
//  - validateFeaturedOrder: server-side gate for create-order AND the public pre-check (/featured/ page). Fails closed.
//  - fulfilFeatured: called once the order is PAID; books the slot atomically (public.featured_book), DMs the admin a
//    signed "Pull listing" URL button (no callbacks: a bot webhook would break the engine's getUpdates). Idempotent.
//  - handleFeaturedCallback: not used (URL buttons only) → always false.
//  - sweepFeatured: lifecycle only (queued → active → ended). The ONE sponsored channel post is sent by the engine
//    (src/featured.js) so it uses the exact call formatting/escaping and the strict 1-per-24h cap in one place.
// deno-lint-ignore-file no-explicit-any require-await
import type { Deps } from './app.ts';
import { analyzeReport, SAFETY_DEFAULTS } from './safety-rules.js';
import { evaluate, tick, isMint, FEATURED_RULES, signAdminToken, adminLinkExp, adminUrl, adminBookingMessage, escapeHtml } from './featured-core.js';
import { featuredDb } from './featured-db.ts';

export type FeaturedValidation =
  | { ok: true; meta: Record<string, unknown> }
  | { ok: false; status: number; error: string; reasons?: string[] };

const DAY = 86400000;
const envOf = (d: Deps) => d.env as Record<string, string | undefined>;
const dry = (d: Deps) => /^(1|true|yes)$/i.test(envOf(d).FEATURED_DRY_RUN ?? '');
const site = (d: Deps) => envOf(d).SITE_URL || 'https://maxigems.fun/';

async function getJson(d: Deps, url: string, init: RequestInit = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await d.fetch(url, { ...init, signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** Mint/freeze authority cross-check via Helius (optional, like the engine's public-RPC check). */
async function rpcAuthorities(d: Deps, ca: string) {
  const key = envOf(d).HELIUS_API_KEY;
  if (!key) return undefined;
  const j = await getJson(d, `https://mainnet.helius-rpc.com/?api-key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[ca], { encoding: 'jsonParsed' }] }) });
  const info = j?.result?.value?.[0]?.data?.parsed?.info;
  return info ? { mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null } : undefined;
}

/** Tokens MaxiGems already flagged as rugged (from the public site data). Best effort. */
async function ruggedCas(d: Deps) {
  const j = await getJson(d, `${site(d).replace(/\/?$/, '/')}data/calls.json`, {}, 6000);
  return new Set<string>((Array.isArray(j?.calls) ? j.calls : []).filter((c: any) => c?.status === 'rugged').map((c: any) => c.address));
}

/** Full check + quote. Used by validateFeaturedOrder and the public `featured` function (action 'check'). */
export async function checkFeatured(d: Deps, ca: string) {
  const now = d.now();
  if (!isMint(ca)) return evaluate({ ca, now });
  const db = featuredDb(d);
  const [pairs, report, rpc, rugged, listings] = await Promise.all([
    getJson(d, `https://api.dexscreener.com/tokens/v1/solana/${ca}`),
    getJson(d, `https://api.rugcheck.xyz/v1/tokens/${ca}/report`, {}, 20000),
    rpcAuthorities(d, ca),
    ruggedCas(d),
    db.listings(new Date(now - 3 * DAY).toISOString()),
  ]);
  return evaluate({ ca, pairs, report: report && report.mint ? report : null, rpc, ruggedCas: rugged, listings, analyzeReport, safetyRules: SAFETY_DEFAULTS, now });
}

const STATUS: Record<string, number> = { invalid_ca: 400, already_featured: 409, no_pair: 422, rugcheck_unavailable: 503 };

/** create-order (kind 'featured'): server-side RugCheck gate + caps. Fails closed. */
export async function validateFeaturedOrder(ca: string, d: Deps, _wallet?: string): Promise<FeaturedValidation> {
  const r: any = await checkFeatured(d, ca);
  if (!r.ok) {
    const code = r.codes.find((c: string) => STATUS[c]) ?? 'safety';
    return { ok: false, status: STATUS[code] ?? 422, error: 'This token can’t be featured right now.', reasons: r.reasons };
  }
  return { ok: true, meta: { symbol: r.token.symbol, name: r.token.name, token: r.token, safety: r.safety, quote: r.quote } };
}

async function sendTg(d: Deps, method: string, body: Record<string, unknown>) {
  const tok = envOf(d).TELEGRAM_BOT_TOKEN;
  if (dry(d) || !tok) { console.log(`[FEATURED_DRY_RUN] ${method} → ${body.chat_id}\n${body.text ?? ''}`); return { message_id: null, dry: true }; }
  const r = await d.fetch(`https://api.telegram.org/bot${tok}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw Object.assign(new Error(`telegram ${method}: ${j.description || r.status}`), { status: r.status }); // never includes the token
  return j.result;
}

/** verify-payment / sweep: the order is PAID. Book the slot (atomic, idempotent per order) and DM the admin once. */
export async function fulfilFeatured(d: Deps, order: Record<string, any>, signature: string): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  if (order?.kind !== 'featured' || !isMint(order.ca)) return { ok: false, error: 'not_a_featured_order' };
  const db = featuredDb(d);
  const meta = order.meta ?? {};
  const env = envOf(d);
  const admin = env.TELEGRAM_ADMIN_CHAT_ID;
  const r: any = await db.book({ ca: order.ca, symbol: String(meta.symbol ?? ''), orderId: order.id, wallet: order.wallet, token: meta.token ?? {}, safety: meta.safety ?? {}, now: d.now() });
  if (!r.ok && r.error === 'already_featured') {
    // Someone else booked this coin between quote and payment. Terminal: mark fulfilled, refund manually.
    if (admin) {
      const text = `⚠️ <b>Featured payment needs a manual refund</b>\n\n$${escapeHtml(meta.symbol)} <code>${escapeHtml(order.ca)}</code> was already featured when this payment confirmed.\nPayer <code>${escapeHtml(order.wallet)}</code>\n<a href="https://solscan.io/tx/${escapeHtml(signature)}">Payment tx</a>`;
      try { await sendTg(d, 'sendMessage', { chat_id: admin, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); } catch (e: any) { console.error('featured refund DM', e?.message); }
    }
    return { ok: true, result: { booked: false, refundRequired: true, reason: 'already_featured' } };
  }
  if (!r.ok) return { ok: false, error: r.error || 'book_failed' };
  const l = r.listing;
  if (!r.already && admin) {
    const secret = env.FEATURED_ADMIN_SECRET || '';
    const exp = adminLinkExp(l.ends_at, d.now());
    let url = `${site(d).replace(/\/?$/, '/')}featured/admin/`;
    try { url = adminUrl(site(d), await signAdminToken({ id: l.id, exp }, secret)); } catch (e: any) { console.error('featured admin link', e?.message); }
    const m = adminBookingMessage({ ...l, link_exp: exp }, { url, sol: order.test ? '0.001 (test)' : '1', signature, test: !!order.test });
    try { await sendTg(d, 'sendMessage', { chat_id: admin, text: m.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: m.buttons }, link_preview_options: { is_disabled: true } }); } catch (e: any) { console.error('featured admin DM', e?.message); }
  }
  return { ok: true, result: { booked: true, listingId: l.id, ca: l.ca, startsAt: l.starts_at, endsAt: l.ends_at, postDueAt: l.post_due_at, status: l.status } };
}

/** Not used: the admin "Pull listing" is a signed URL button (see featured-http.ts), never a callback. */
export async function handleFeaturedCallback(_d: Deps, _cq: any): Promise<boolean> {
  return false;
}

/** sweep (every ~2 min): lifecycle only. Posting is the engine's job (1 per 24h, same formatting as calls). */
export async function sweepFeatured(d: Deps): Promise<Record<string, number>> {
  const db = featuredDb(d);
  const now = d.now();
  const rows = await db.listings(new Date(now - 3 * DAY).toISOString());
  const t = tick(rows, now, FEATURED_RULES);
  for (const id of t.end) await db.patch(id, { status: 'ended' });
  for (const id of t.activate) await db.patch(id, { status: 'active' });
  return { featuredActivated: t.activate.length, featuredEnded: t.end.length };
}
