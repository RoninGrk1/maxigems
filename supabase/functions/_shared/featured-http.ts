// Public `featured` Edge Function (no sign-in needed):
//   POST {action:'check', ca}        → safety check + quote for the /featured/ page (no payment option on failure)
//   POST {action:'status', ca}       → public status of the latest listing for a coin (status page / Track & Share)
//   POST {action:'admin-view', token}→ listing details for the signed admin page (HMAC token, short expiry)
//   POST {action:'pull', token}      → pull the listing + delete its channel post when Telegram still allows it
// The admin token lives in the URL #fragment of https://maxigems.fun/featured/admin/ and is POSTed here, so it never
// appears in a server access log, and a link preview / prefetch (GET) can never pull a listing.
// deno-lint-ignore-file no-explicit-any
import { json, type Deps } from './app.ts';
import { checkFeatured } from './featured.ts';
import { featuredDb } from './featured-db.ts';
import { isMint, verifyAdminToken, publicListing } from './featured-core.js';
import { publicPlans } from './plans.js';

const on = (v?: string) => /^(1|true|yes|on)$/i.test(String(v ?? ''));
const cache = new Map<string, { at: number; body: any }>(); // per-isolate: one RugCheck hit per coin per minute

export async function handleFeatured(req: Request, d: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: json(req, d.env, {}).headers });
  if (req.method !== 'POST') return json(req, d.env, { error: 'POST only' }, 405);
  let b: any = {};
  try { const t = await req.text(); if (t.length > 4096) return json(req, d.env, { error: 'body too large' }, 413); b = t ? JSON.parse(t) : {}; } catch { return json(req, d.env, { error: 'bad json' }, 400); }
  const env = d.env as Record<string, string | undefined>;
  try {
    if (b.action === 'check') {
      const ca = String(b.ca ?? '');
      const hit = cache.get(ca);
      if (hit && d.now() - hit.at < 60000) return json(req, d.env, hit.body);
      const r: any = await checkFeatured(d, ca);
      const body = { ok: r.ok, reasons: r.reasons, token: r.token, safety: r.safety, quote: r.quote, price: publicPlans().featured, paymentsEnabled: on(env.PAYMENTS_ENABLED) };
      if (isMint(ca)) { cache.set(ca, { at: d.now(), body }); if (cache.size > 500) cache.delete(cache.keys().next().value!); }
      return json(req, d.env, body);
    }
    if (b.action === 'status') {
      if (!isMint(b.ca)) return json(req, d.env, { error: 'Bad contract address.' }, 400);
      const l = await featuredDb(d).latestForCa(b.ca);
      if (!l) return json(req, d.env, { found: false });
      return json(req, d.env, { found: true, status: l.status, listing: publicListing(l), postDueAt: l.post_due_at, posted: !!l.posted_at });
    }
    if (b.action === 'admin-view' || b.action === 'pull') {
      const v: any = await verifyAdminToken(b.token, env.FEATURED_ADMIN_SECRET || '', { now: d.now() });
      if (!v.ok) return json(req, d.env, { ok: false, error: v.error }, 403);
      const db = featuredDb(d);
      const l = await db.get(v.id);
      if (!l) return json(req, d.env, { ok: false, error: 'not_found' }, 404);
      if (b.action === 'admin-view') return json(req, d.env, { ok: true, status: l.status, listing: publicListing(l), posted: !!l.posted_at, wallet: l.wallet });
      const r: any = await db.pull(v.id, 'admin-link', typeof b.reason === 'string' ? b.reason.slice(0, 200) : null);
      let postDeleted: boolean | null = null;
      if (r.ok && !r.already && l.post_message_id && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHANNEL_ID) {
        // Bots can delete their own channel posts for 48h; older ones stay (the reply says so).
        const t = await d.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHANNEL_ID, message_id: Number(l.post_message_id) }) }).then((x) => x.json()).catch(() => ({ ok: false }));
        postDeleted = !!t.ok;
      }
      try { await d.store.audit('admin', 'featured_pull', { id: v.id, ok: r.ok, postDeleted }); } catch { /* ignore */ }
      return json(req, d.env, { ok: !!r.ok, already: !!r.already, status: r.listing?.status ?? l.status, postDeleted, error: r.error ?? null, note: 'The sponsored card disappears from the site at the next bot run (≤ 25 min). Refunds are manual.' }, r.ok ? 200 : 409);
    }
    return json(req, d.env, { error: 'Unknown action.' }, 400);
  } catch (e: any) {
    console.error('featured', e?.message);
    return json(req, d.env, { error: 'Server error — try again in a minute.' }, 500);
  }
}
