// MaxiGems Pro — engine side. Pro is optional EXTRAS ONLY:
//  - calls are NEVER touched here: every call still posts instantly to the public channel and the website
//    (test/pro-engine.test.js asserts this with Pro fully launched);
//  - when `pro.launched` is true: whale alerts go instantly to the private Pro group, the public channel gets a short
//    delayed whale digest, the public site gets whale moves on a 15-min delay and the 👀 On watch list moves to Pro;
//  - the live versions are pushed to Supabase (ingest function) for the gated pro-data endpoint.
// While `pro.launched` is false (default), the engine behaves exactly as before.
import { fetchJson, log, escapeHtml as e, fmtUsd, safeUrl } from './util.js';

export const PRO_DEFAULTS = { launched: false, groupId: '', whaleDelayMinutes: 15, digest: { enabled: true, everyHours: 6, maxItems: 5 } };

export function proCfg(cfg) {
  const p = cfg?.pro ?? {};
  const out = { ...PRO_DEFAULTS, ...p, digest: { ...PRO_DEFAULTS.digest, ...(p.digest ?? {}) } };
  if (process.env.TELEGRAM_PRO_GROUP_ID) out.groupId = process.env.TELEGRAM_PRO_GROUP_ID;
  if (process.env.PRO_LAUNCHED !== undefined && process.env.PRO_LAUNCHED !== '') out.launched = /^(1|true|yes)$/i.test(process.env.PRO_LAUNCHED);
  out.groupId = String(out.groupId || '');
  out.alertsToGroup = Boolean(out.launched && /^-100\d{6,}$/.test(out.groupId));
  return out;
}

/** Public whale-moves file: moves younger than the delay are held back (Pro sees them live). */
export function publicMoves(movesFile, pc, now = Date.now()) {
  if (!pc.launched || !movesFile) return movesFile;
  const cut = now - pc.whaleDelayMinutes * 60000;
  const moves = (movesFile.moves ?? []).filter((m) => Date.parse(m.t) <= cut);
  const held = (movesFile.moves ?? []).length - moves.length;
  return { ...movesFile, moves, delayMinutes: pc.whaleDelayMinutes, heldForPro: held };
}

/** Public watchlist: the near-miss list is a Pro extra (it's not calls). Keeps the count for the lock screen. */
export function publicWatchlist(w, pc) {
  if (!pc.launched || !w) return w;
  return { updatedAt: w.updatedAt, proOnly: true, count: (w.items ?? []).length, items: [] };
}

/** Delayed whale digest for the public channel (at most once per `everyHours`; only moves older than the delay). */
export function digestDue(state, pc, now = Date.now()) {
  if (!pc.launched || !pc.digest.enabled) return false;
  const last = Date.parse(state.lastWhaleDigestAt ?? '');
  return !Number.isFinite(last) || now - last >= pc.digest.everyHours * 3600000;
}
export function digestMessage(moves, pc, cfg, now = Date.now(), sinceMs = null) {
  const cut = now - pc.whaleDelayMinutes * 60000;
  const from = sinceMs ?? now - pc.digest.everyHours * 3600000;
  const list = (moves ?? []).filter((m) => { const t = Date.parse(m.t); return t <= cut && t > from && (m.usd ?? 0) > 0; })
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)).slice(0, pc.digest.maxItems);
  if (!list.length) return null;
  const KIND = { buy: '🟢 bought', sell: '🔴 sold', exit: '🚪 exited', new: '🆕 entered' };
  const lines = [`🐳 <b>Whale digest</b> — biggest moves on MaxiGems calls (last ${pc.digest.everyHours}h, ${pc.whaleDelayMinutes}+ min delayed)`, ''];
  for (const m of list) lines.push(`• $${e(m.sym)} — ${KIND[m.k] ?? e(m.k)} ${m.min ? '≥' : ''}${e(fmtUsd(m.usd))}${m.dev ? ' 🚨 dev' : m.ins ? ' ⚠️ insider' : ''}`);
  const site = safeUrl(cfg.siteUrl);
  lines.push('', `Full moves feed (free, 15-min delay): ${e(site ? new URL('whales/', site.endsWith('/') ? site : site + '/').toString() : 'maxigems.fun/whales/')}`);
  lines.push('<i>Instant whale alerts are a MaxiGems Pro extra. Calls are always free and instant here. NFA.</i>');
  return lines.join('\n');
}

/** Push live Pro data to Supabase (ingest Edge Function). Never throws; no-op when not configured. */
export async function pushProData({ movesFile, watchlist }, deps = {}) {
  const url = process.env.PRO_INGEST_URL, secret = process.env.PRO_INGEST_SECRET;
  if (!url || !secret) return false;
  try {
    await (deps.fetchJson ?? fetchJson)(url, { method: 'POST', retries: 1, timeoutMs: 15000, headers: { 'x-ingest-secret': secret }, body: JSON.stringify({ whaleMoves: movesFile ?? null, watchlist: watchlist ?? null }) });
    return true;
  } catch (err) { log(`WARN pro ingest failed: ${err.message}`); return false; }
}

/** Live moves back from Supabase (GET ingest with the secret). null when not configured/unreachable. */
export async function fetchLiveMoves(deps = {}) {
  const url = process.env.PRO_INGEST_URL, secret = process.env.PRO_INGEST_SECRET;
  if (!url || !secret) return null;
  try {
    const d = await (deps.fetchJson ?? fetchJson)(url, { retries: 1, timeoutMs: 15000, headers: { 'x-ingest-secret': secret } });
    return Array.isArray(d?.whaleMoves?.moves) ? d.whaleMoves.moves : null;
  } catch (err) { log(`WARN pro live moves fetch failed: ${err.message}`); return null; }
}

/** Newest-first union of two move lists (dedupe on time+coin+wallet+kind). */
export function mergeMoves(a, b, max = 300) {
  const seen = new Set(), out = [];
  for (const m of [...(a ?? []), ...(b ?? [])]) {
    if (!m) continue;
    const k = `${m.t}|${m.ca}|${m.o}|${m.k}`;
    if (seen.has(k)) continue; seen.add(k); out.push(m);
  }
  return out.sort((x, y) => Date.parse(y.t) - Date.parse(x.t)).slice(0, max);
}
