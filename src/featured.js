// Featured listings, engine side (runs every engine cycle; never fails the run):
//   1) read featured_listings from Supabase (service role, REST), 2) queued → active → ended by time,
//   3) send AT MOST one "Sponsored" channel post (strict 1 per 24h across all listings) after a fresh safety re-check,
//   4) write the public site/data/featured.json (active listings only, no wallets/order ids).
// DRY_RUN: Supabase is read-only (no PATCH/RPC) and Telegram posts/DMs are printed, not sent.
// No SUPABASE_SERVICE_ROLE_KEY → featured.json is written with an empty list (site shows nothing sponsored).
import { tick, visibleNow, publicListing, schedule, FEATURED_RULES, escapeHtml } from '../supabase/functions/_shared/featured-core.js';
import { sponsoredMessage, sponsoredButtons } from './format.js';
import { log, num } from './util.js';

const DAY = 86400000;
export const DEFAULT_SUPABASE_URL = 'https://wrlsgqfpcvdjzsueikxw.supabase.co';

export function featuredRules(cfg) {
  const f = cfg?.featured ?? {};
  return {
    ...FEATURED_RULES,
    ...(num(f.maxConcurrent) ? { maxConcurrent: num(f.maxConcurrent) } : {}),
    ...(num(f.maxPostsPerDay) ? { maxPostsPerDay: num(f.maxPostsPerDay) } : {}),
    minLiquidityUsd: cfg?.filters?.minLiquidityUsd ?? FEATURED_RULES.minLiquidityUsd,
    minAgeMinutes: cfg?.filters?.minAgeMinutes ?? FEATURED_RULES.minAgeMinutes,
  };
}

/** Tiny PostgREST client. The key only ever goes in headers (never in a URL or a log line). */
export function restClient({ url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl = fetch } = {}) {
  if (!key) return null;
  const base = url.replace(/\/$/, '') + '/rest/v1';
  const call = async (method, path, body) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetchImpl(base + path, {
        method, signal: ctrl.signal,
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`supabase ${method} ${path.split('?')[0]} ${r.status}: ${j?.message ?? ''}`.trim());
      return j;
    } finally { clearTimeout(t); }
  };
  return {
    /** All listings that matter for caps: live ones + anything that ended in the last 3 days (post cap history). */
    listings: (now) => call('GET', `/featured_listings?select=*&ends_at=gte.${encodeURIComponent(new Date(now - 3 * DAY).toISOString())}&order=starts_at.asc&limit=500`),
    patch: (id, body) => call('PATCH', `/featured_listings?id=eq.${encodeURIComponent(id)}`, body),
    pull: (id, by, reason) => call('POST', '/rpc/featured_pull', { p_id: id, p_by: by, p_reason: reason }),
  };
}

/**
 * One featured cycle. deps (all injectable for tests):
 *   db (restClient or fake), post(html, buttons, photo) → message_id, dm(chatId, html, buttons),
 *   recheck(listing) → { ok, reasons, safety, pair }, write(file, json)
 */
export async function runFeatured({ cfg, now = Date.now(), mode, deps }) {
  const dry = mode === 'dry';
  const rules = featuredRules(cfg);
  const out = { listings: [], posted: null, pulled: [], activated: [], ended: [], error: null };
  let rows = [];
  if (deps.db) {
    try { rows = (await deps.db.listings(now)) ?? []; } catch (e) { out.error = e.message; log(`WARN featured: ${e.message}`); }
  }
  if (!out.error && rows.length) {
    const t = tick(rows, now, rules);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const write = async (id, body, label) => {
      const r = byId.get(id); Object.assign(r, body);
      if (dry) { log(`[DRY_RUN] featured ${label} ${r.symbol} (${id}) — not written`); return; }
      try { await deps.db.patch(id, body); } catch (e) { log(`WARN featured ${label} ${id}: ${e.message}`); }
    };
    for (const id of t.end) { await write(id, { status: 'ended' }, 'end'); out.ended.push(id); }
    for (const id of t.activate) { await write(id, { status: 'active' }, 'activate'); out.activated.push(id); }
    for (const id of t.post) {
      const l = byId.get(id);
      let chk;
      try { chk = await deps.recheck(l); } catch (e) { chk = { ok: false, transient: true, reasons: [`re-check failed: ${e.message}`] }; }
      if (!chk.ok && chk.transient) { log(`WARN featured re-check unavailable for $${l.symbol}; will retry next run`); continue; }
      if (!chk.ok) {
        // Fail closed: never promote a coin that stopped passing the safety rules. Hide it now; refund is manual.
        const reason = `Failed the safety re-check before posting: ${chk.reasons.join('; ')}`.slice(0, 200);
        log(`FEATURED auto-pull $${l.symbol}: ${reason}`);
        out.pulled.push(id);
        Object.assign(l, { status: 'pulled', post_skipped: reason });
        if (!dry) {
          try { await deps.db.patch(id, { post_skipped: reason }); await deps.db.pull(id, 'auto-safety', reason); } catch (e) { log(`WARN featured auto-pull ${id}: ${e.message}`); }
        }
        if (mode !== 'off' && cfg.featured?.adminChatId) {
          const html = `🛑 <b>Featured listing auto-pulled</b>\n\n$${escapeHtml(l.symbol)} <code>${escapeHtml(l.ca)}</code>\n${escapeHtml(reason)}\n\n<i>No channel post was sent. Refund manually if appropriate.</i>`;
          try { await deps.dm(String(cfg.featured.adminChatId), html); } catch (e) { log(`WARN featured admin DM failed: ${e.message}`); }
        }
        continue;
      }
      if (mode === 'off') continue;
      try {
        const listing = { ...l, safety: chk.safety ?? l.safety, live: chk.pair ?? null };
        const msgId = await deps.post(sponsoredMessage(listing, cfg), sponsoredButtons(listing, cfg), listing.token?.imageUrl ?? null);
        out.posted = id;
        if (!dry) await deps.db.patch(id, { posted_at: new Date(now).toISOString(), post_message_id: msgId ?? null });
        else log(`[DRY_RUN] featured post for $${l.symbol} printed; posted_at not written`);
        if (!dry) l.posted_at = new Date(now).toISOString();
      } catch (e) {
        log(`ERROR featured post failed for $${l.symbol}: ${e.message}`);
      }
    }
  }
  const visible = visibleNow(rows, now).map(publicListing);
  // queued listings that start before the next run, so the site can switch them on by time without waiting
  const soon = rows.filter((l) => l.status === 'queued' && Date.parse(l.starts_at) > now && Date.parse(l.starts_at) - now < 45 * 60000).map(publicListing);
  const next = schedule(rows, now, rules);
  out.listings = [...visible, ...soon];
  const file = {
    updatedAt: new Date(now).toISOString(),
    label: 'Sponsored – not financial advice',
    maxConcurrent: rules.maxConcurrent,
    activeCount: visible.length,
    nextAvailableAt: next.startsAt,
    listings: out.listings,
  };
  if (out.error && deps.previous) { // Supabase unreachable: keep the last known listings, still filtered by time on the site
    file.listings = (deps.previous.listings ?? []).filter((l) => Date.parse(l.endsAt) > now);
    file.stale = true;
  }
  deps.write(file);
  return out;
}
