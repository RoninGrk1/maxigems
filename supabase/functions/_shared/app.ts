// MaxiGems shared payments/auth core + Pro pass: every Edge Function handler, written as (req, deps) => Response so the Deno tests can run
// them against MemoryStore + a fake fetch (Helius / RugCheck / DexScreener / Telegram).
// deno-lint-ignore-file no-explicit-any
import { type Store, type Row, RestStore } from './store.ts';
import { PLANS, ORDER_TTL_MS, priceOrder, publicPlans, lamportsToSol, gate, daysLeft, isAddr, parseWalletList } from './plans.js';
import { verifyPayment, VERIFY_TEXT } from './verify.js';
import { validateFeaturedOrder, fulfilFeatured, handleFeaturedCallback, sweepFeatured } from './featured.ts';
import { buildMessage, checkSignIn, SIWS_TTL_MS } from './siws.js';
import { signJwt, verifyJwt, SESSION_TTL_S } from './jwt.js';
import { randomPubkey, randomToken } from './b58.js';
import { inviteParams, kickList, kick, startToken, tgCall } from './tg.js';

export type Env = {
  PAYMENTS_ENABLED?: string; TEST_WALLETS?: string; TREASURY_WALLET?: string; HELIUS_API_KEY?: string;
  SESSION_JWT_SECRET?: string; SWEEP_SECRET?: string; INGEST_SECRET?: string; TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_PRO_GROUP_ID?: string; TELEGRAM_ADMIN_CHAT_ID?: string; TELEGRAM_CHANNEL_ID?: string;
  TELEGRAM_BOT_USERNAME?: string; ALLOWED_ORIGINS?: string; SIWS_DOMAINS?: string; SITE_URL?: string;
};
export type Deps = { store: Store; env: Env; fetch: typeof fetch; now: () => number };

export const TREASURY_DEFAULT = '9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX';
const ORIGINS_DEFAULT = 'https://maxigems.fun,https://www.maxigems.fun';
const on = (v?: string) => /^(1|true|yes|on)$/i.test(String(v ?? ''));
const treasury = (env: Env) => (isAddr(env.TREASURY_WALLET) ? env.TREASURY_WALLET! : TREASURY_DEFAULT);
const siteUrl = (env: Env) => env.SITE_URL || 'https://maxigems.fun/';

export function deps(): Deps {
  const env = Deno.env.toObject() as Env;
  const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return { store: new RestStore(url, key), env, fetch, now: Date.now };
}

// ------------------------------------------------------------------ http helpers
function cors(req: Request, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || ORIGINS_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean);
  const o = req.headers.get('origin') || '';
  return {
    'access-control-allow-origin': allowed.includes(o) ? o : allowed[0],
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-max-age': '600', vary: 'Origin',
  };
}
export function json(req: Request, env: Env, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors(req, env), ...extra } });
}
async function body(req: Request): Promise<Row> {
  const t = await req.text();
  if (t.length > 8192) throw Object.assign(new Error('body too large'), { status: 413 });
  try { const j = t ? JSON.parse(t) : {}; return j && typeof j === 'object' ? j : {}; } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}
async function session(req: Request, env: Env, nowMs = Date.now()) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(h);
  const c = m ? await verifyJwt(m[1], env.SESSION_JWT_SECRET || '', Math.floor(nowMs / 1000)) : null;
  return c && isAddr(c.wallet) ? { wallet: c.wallet as string } : null;
}
function wrap(fn: (req: Request, d: Deps) => Promise<Response>) {
  return async (req: Request, d: Deps) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, d.env) });
    try { return await fn(req, d); } catch (e: any) {
      const status = e?.status && e.status >= 400 && e.status < 500 ? e.status : 500;
      if (status === 500) console.error('error', e?.message);
      return json(req, d.env, { error: status === 500 ? 'Server error — try again in a minute.' : e.message }, status);
    }
  };
}
const safeSecretEq = (a: string, b: string) => { if (!a || !b || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };

// ------------------------------------------------------------------ external APIs
async function helius(d: Deps, method: string, params: unknown[]) {
  if (!d.env.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY missing');
  const r = await d.fetch(`https://mainnet.helius-rpc.com/?api-key=${d.env.HELIUS_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || j.error.code}`);
  return j.result;
}
const getTx = (d: Deps, sig: string) => helius(d, 'getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);

export { helius };

// ------------------------------------------------------------------ auth (SIWS)
export const handleAuth = wrap(async (req, d) => {
  if (req.method !== 'POST') return json(req, d.env, { error: 'POST only' }, 405);
  const b = await body(req);
  const domains = (d.env.SIWS_DOMAINS || 'maxigems.fun,www.maxigems.fun').split(',').map((s) => s.trim());
  if (b.action === 'nonce') {
    if (!isAddr(b.wallet)) return json(req, d.env, { error: 'Bad wallet address.' }, 400);
    const host = (() => { try { return new URL(req.headers.get('origin') || '').host; } catch { return ''; } })();
    const domain = domains.includes(host) ? host : domains[0];
    const nonce = randomToken(16), now = d.now();
    const issuedAt = new Date(now).toISOString(), expiresAt = new Date(now + SIWS_TTL_MS).toISOString();
    await d.store.putNonce({ nonce, wallet: b.wallet, expires_at: expiresAt });
    return json(req, d.env, { nonce, message: buildMessage({ domain, address: b.wallet, nonce, issuedAt, expiresAt }) });
  }
  if (b.action === 'verify') {
    if (typeof b.message !== 'string' || typeof b.signature !== 'string') return json(req, d.env, { error: 'Missing signature.' }, 400);
    const nonce = /\nNonce: ([A-Za-z0-9]+)\n/.exec(b.message)?.[1] || '';
    const row = nonce ? await d.store.getNonce(nonce) : null;
    const r = await checkSignIn({ message: b.message, signature: b.signature, nonceRow: row, allowedDomains: domains, now: d.now() });
    if (!r.ok) return json(req, d.env, { error: `Sign-in failed (${r.error}). Try again.` }, 401);
    if (!(await d.store.useNonce(nonce))) return json(req, d.env, { error: 'Sign-in failed (nonce_used). Try again.' }, 401);
    await d.store.upsertProfile(r.wallet!);
    const token = await signJwt({ wallet: r.wallet }, d.env.SESSION_JWT_SECRET || '', SESSION_TTL_S, Math.floor(d.now() / 1000));
    return json(req, d.env, { token, wallet: r.wallet, expiresAt: new Date(d.now() + SESSION_TTL_S * 1000).toISOString() });
  }
  return json(req, d.env, { error: 'Unknown action.' }, 400);
});

// ------------------------------------------------------------------ account (status, Telegram link + invite)
async function status(d: Deps, wallet: string | null) {
  const pub = { paymentsEnabled: on(d.env.PAYMENTS_ENABLED), ...publicPlans(), proGroupReady: !!d.env.TELEGRAM_PRO_GROUP_ID, treasury: treasury(d.env) };
  if (!wallet) return { ...pub, signedIn: false };
  const sub = await d.store.getSub(wallet);
  const link = await d.store.getLink(wallet);
  const left = daysLeft(sub?.expires_at, d.now());
  const test = parseWalletList(d.env.TEST_WALLETS).includes(wallet);
  return { ...pub, signedIn: true, wallet, testWallet: test, pro: { active: left > 0, plan: sub?.plan ?? null, expiresAt: sub?.expires_at ?? null, daysLeft: left }, telegram: { linked: !!link?.tg_user_id } };
}
export const handleAccount = wrap(async (req, d) => {
  const s = await session(req, d.env, d.now());
  if (req.method === 'GET') return json(req, d.env, await status(d, s?.wallet ?? null));
  if (req.method !== 'POST') return json(req, d.env, { error: 'Method not allowed' }, 405);
  if (!s) return json(req, d.env, { error: 'Sign in with your wallet.' }, 401);
  const b = await body(req);
  if (b.action === 'tg-link') {
    const token = randomToken(18);
    await d.store.upsertLink({ wallet: s.wallet, token, token_expires_at: new Date(d.now() + 30 * 60000).toISOString() });
    return json(req, d.env, { url: `https://t.me/${d.env.TELEGRAM_BOT_USERNAME || 'Maxigems_bot'}?start=${token}` });
  }
  if (b.action === 'tg-invite') {
    const g = gate(s, await d.store.getSub(s.wallet), d.now());
    if (g.status !== 200) return json(req, d.env, { error: g.error }, g.status);
    if (!d.env.TELEGRAM_PRO_GROUP_ID) return json(req, d.env, { error: 'The Pro group isn’t open yet — check back soon.' }, 503);
    const link = await d.store.getLink(s.wallet);
    if (!link?.tg_user_id) return json(req, d.env, { error: 'Link your Telegram first.' }, 409);
    // previously removed after an expiry → lift the ban so the new link works (no-op otherwise)
    try { await tgCall(d.env.TELEGRAM_BOT_TOKEN!, 'unbanChatMember', { chat_id: d.env.TELEGRAM_PRO_GROUP_ID, user_id: link.tg_user_id, only_if_banned: true }, d.fetch); } catch { /* ignore */ }
    const inv = await tgCall(d.env.TELEGRAM_BOT_TOKEN!, 'createChatInviteLink', inviteParams(d.env.TELEGRAM_PRO_GROUP_ID, s.wallet, d.now()), d.fetch);
    await d.store.upsertLink({ wallet: s.wallet, invited_at: new Date(d.now()).toISOString(), removed_at: null });
    await d.store.audit(s.wallet, 'tg_invite', { tg: link.tg_user_id });
    return json(req, d.env, { url: inv.invite_link, expiresInHours: 24 });
  }
  return json(req, d.env, { error: 'Unknown action.' }, 400);
});

// ------------------------------------------------------------------ create-order / verify-payment (shared core)
/** Per-kind fulfilment after fulfil_order() marked the order paid. pro: done in SQL. featured: the featured hook. */
async function runFulfilment(d: Deps, order: Row, signature: string, res: Row): Promise<Row> {
  if (res.kind === 'pro' || res.fulfilled) return { ok: true, result: res };
  if (order.kind === 'featured') {
    const f = await fulfilFeatured(d, { ...order, status: 'paid', signature }, signature);
    if (f.ok) await d.store.markFulfilled(order.id);
    return { ok: true, result: { ...res, ...(f.result ?? {}), fulfilled: f.ok }, fulfilError: f.ok ? undefined : f.error };
  }
  return { ok: true, result: res };
}

/** Verify one signature against one order, mark it paid and fulfil it. Shared by verify-payment and the sweep. */
export async function settle(d: Deps, order: Row, signature: string): Promise<Row> {
  if (order.status === 'paid') {
    if (order.signature !== signature) return { ok: false, reason: 'signature_used' };
    return await runFulfilment(d, order, signature, { ok: true, already: true, kind: order.kind, fulfilled: !!order.fulfilled_at });
  }
  if (await d.store.signatureUsed(signature)) return { ok: false, reason: 'signature_used' };
  const tx = await getTx(d, signature);
  const v = verifyPayment(tx, { signature, treasury: treasury(d.env), wallet: order.wallet, reference: order.reference, lamports: order.lamports });
  if (!v.ok) return v;
  let res: Row;
  try { res = await d.store.fulfil(order.id, signature, v.lamports!); } catch (e: any) {
    if (e?.status === 409) return { ok: false, reason: 'signature_used' };
    throw e;
  }
  if (!res.ok) return { ok: false, reason: res.error };
  return await runFulfilment(d, order, signature, res);
}

/** POST {kind:'pro'|'featured', plan?, ca?} (signed in) → {orderId, reference, lamports, treasury, expiresAt, …} */
export const handleCreateOrder = wrap(async (req, d) => {
  if (req.method !== 'POST') return json(req, d.env, { error: 'POST only' }, 405);
  const s = await session(req, d.env, d.now());
  if (!s) return json(req, d.env, { error: 'Sign in with your wallet.' }, 401);
  const b = await body(req);
  const p: any = priceOrder({ kind: b.kind, plan: b.plan, wallet: s.wallet, paymentsEnabled: on(d.env.PAYMENTS_ENABLED), testWallets: parseWalletList(d.env.TEST_WALLETS) });
  if (!p.ok) return json(req, d.env, { error: p.error }, p.status);
  let meta: Row = {}, ca: string | null = null;
  if (b.kind === 'featured') {
    if (!isAddr(b.ca)) return json(req, d.env, { error: 'Bad contract address.' }, 400);
    ca = b.ca;
    const v = await validateFeaturedOrder(ca!, d, s.wallet); // server-side: the client can never skip the safety gate
    if (!v.ok) return json(req, d.env, { error: v.error, reasons: v.reasons ?? [] }, v.status);
    meta = v.meta;
  }
  const order = await d.store.createOrder({
    wallet: s.wallet, kind: b.kind, plan: p.plan, days: p.days ?? null, ca, meta, lamports: String(p.lamports), test: p.test,
    reference: randomPubkey(), expires_at: new Date(d.now() + ORDER_TTL_MS).toISOString(),
  });
  await d.store.audit(s.wallet, 'order_created', { order: order.id, kind: b.kind, plan: p.plan, lamports: String(p.lamports), test: p.test });
  return json(req, d.env, {
    orderId: order.id, reference: order.reference, lamports: String(p.lamports), treasury: treasury(d.env), expiresAt: order.expires_at,
    kind: b.kind, plan: p.plan, sol: p.sol, test: p.test, label: b.kind === 'pro' ? `MaxiGems Pro ${PLANS[b.plan as keyof typeof PLANS].label}` : 'MaxiGems Featured 24h',
  });
});

/** POST {orderId, signature} (signed in) → 200 {ok,status:'paid',result,account} | 202 {retry:true} | 422 {reason,message} */
export const handleVerifyPayment = wrap(async (req, d) => {
  if (req.method !== 'POST') return json(req, d.env, { error: 'POST only' }, 405);
  const s = await session(req, d.env, d.now());
  if (!s) return json(req, d.env, { error: 'Sign in with your wallet.' }, 401);
  const b = await body(req);
  if (typeof b.orderId !== 'string' || typeof b.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(b.signature)) return json(req, d.env, { error: 'Bad request.' }, 400);
  const order = await d.store.getOrder(b.orderId);
  if (!order || order.wallet !== s.wallet) return json(req, d.env, { error: 'Order not found.' }, 404);
  if (order.status === 'pending') await d.store.touchOrder(order.id, { checked_at: new Date(d.now()).toISOString() });
  const r: Row = await settle(d, order, b.signature);
  if (!r.ok) return json(req, d.env, { ok: false, reason: r.reason, message: VERIFY_TEXT[r.reason as keyof typeof VERIFY_TEXT] || 'Payment could not be verified.', retry: !!r.retry }, r.retry ? 202 : 422);
  return json(req, d.env, { ok: true, status: 'paid', result: r.result ?? null, account: await status(d, s.wallet) });
});

// ------------------------------------------------------------------ pro-data (gated on every call)
export const handleProData = wrap(async (req, d) => {
  if (req.method !== 'GET') return json(req, d.env, { error: 'GET only' }, 405);
  const s = await session(req, d.env, d.now());
  const g = gate(s, s ? await d.store.getSub(s.wallet) : null, d.now());
  if (g.status !== 200) return json(req, d.env, { error: g.error, expired: !!(g as any).expired }, g.status);
  const [moves, watch] = await Promise.all([d.store.getFeed('whale_moves'), d.store.getFeed('watchlist')]);
  return json(req, d.env, { pro: { daysLeft: (g as any).daysLeft, expiresAt: (g as any).expiresAt }, whaleMoves: moves?.data ?? null, watchlist: watch?.data ?? null });
});

// ------------------------------------------------------------------ ingest (engine → live Pro data)
export const handleIngest = wrap(async (req, d) => {
  if (!safeSecretEq(req.headers.get('x-ingest-secret') || '', d.env.INGEST_SECRET || '')) return json(req, d.env, { error: 'forbidden' }, 403);
  if (req.method === 'GET') return json(req, d.env, { whaleMoves: (await d.store.getFeed('whale_moves'))?.data ?? null }); // engine reads back the live list
  if (req.method !== 'POST') return json(req, d.env, { error: 'Method not allowed' }, 405);
  const t = await req.text();
  if (t.length > 900000) return json(req, d.env, { error: 'too large' }, 413);
  const b = JSON.parse(t);
  let n = 0;
  if (b.whaleMoves && Array.isArray(b.whaleMoves.moves)) { await d.store.putFeed('whale_moves', { updatedAt: b.whaleMoves.updatedAt, moves: b.whaleMoves.moves.slice(0, 300) }); n++; }
  if (b.watchlist && Array.isArray(b.watchlist.items)) { await d.store.putFeed('watchlist', b.watchlist); n++; }
  return json(req, d.env, { ok: true, stored: n });
});

// ------------------------------------------------------------------ telegram webhook (/start link, admin "Pull listing")
export const handleTelegram = wrap(async (req, d) => {
  if (req.method !== 'POST') return json(req, d.env, { error: 'POST only' }, 405);
  if (!safeSecretEq(req.headers.get('x-telegram-bot-api-secret-token') || '', d.env.TELEGRAM_WEBHOOK_SECRET || '')) return json(req, d.env, { error: 'forbidden' }, 403);
  const u = await body(req);
  const tok = d.env.TELEGRAM_BOT_TOKEN!;
  if (u.callback_query) {
    const handled = await handleFeaturedCallback(d, u.callback_query); // admin "Pull listing" lives in _shared/featured.ts
    if (!handled) { try { await tgCall(tok, 'answerCallbackQuery', { callback_query_id: u.callback_query.id }, d.fetch); } catch { /* ignore */ } }
    return json(req, d.env, { ok: true });
  }
  const m = u.message;
  if (m && m.chat?.type === 'private' && typeof m.text === 'string') {
    const t = startToken(m.text);
    let reply = 'Hi! 💎 This bot posts MaxiGems calls in @maxigems_calls (free, instant). To link your Pro pass, open your account on maxigems.fun and tap “Link Telegram”.';
    if (t) {
      const link = await d.store.getLinkByToken(t);
      if (!link || !link.token_expires_at || Date.parse(link.token_expires_at) < d.now()) reply = 'That link has expired. Open your MaxiGems account and tap “Link Telegram” again.';
      else {
        const other = await d.store.getLinkByTg(m.from.id);
        if (other && other.wallet !== link.wallet) await d.store.upsertLink({ wallet: other.wallet, tg_user_id: null, linked_at: null });
        await d.store.upsertLink({ wallet: link.wallet, tg_user_id: m.from.id, linked_at: new Date(d.now()).toISOString(), token: null, token_expires_at: null });
        await d.store.audit(link.wallet, 'tg_linked', { tg: m.from.id });
        reply = '✅ Telegram linked to your MaxiGems wallet. Back on the site, tap “Get Pro group invite”.';
      }
    }
    try { await tgCall(tok, 'sendMessage', { chat_id: m.chat.id, text: reply }, d.fetch); } catch { /* ignore */ }
  }
  return json(req, d.env, { ok: true });
});

// ------------------------------------------------------------------ sweep (cron every ~2 min)
export const handleSweep = wrap(async (req, d) => {
  if (!safeSecretEq(req.headers.get('x-sweep-secret') || '', d.env.SWEEP_SECRET || '')) return json(req, d.env, { error: 'forbidden' }, 403);
  const now = d.now(), out: Row = { settled: 0, expired: 0, kicked: 0, errors: 0 };
  // 1) payments that were sent but never verified (tab closed, network drop): look up by the order's reference key
  for (const o of await d.store.pendingOrders(new Date(now - 24 * 3600000).toISOString(), 25)) {
    try {
      const sigs = (await helius(d, 'getSignaturesForAddress', [o.reference, { limit: 5, commitment: 'confirmed' }])) as Row[] || [];
      let done = false;
      for (const s of sigs.filter((x) => !x.err)) { const r: Row = await settle(d, o, s.signature); if (r.ok) { out.settled++; done = true; break; } }
      if (!done && Date.parse(o.expires_at) + 4 * 3600000 < now) { await d.store.touchOrder(o.id, { status: 'expired' }); out.expired++; }
      else await d.store.touchOrder(o.id, { checked_at: new Date(now).toISOString() });
    } catch (e: any) { out.errors++; console.error('sweep order', o.id, e?.message); }
  }
  // 2) expired passes → remove from the Pro group (ban + unban)
  const group = d.env.TELEGRAM_PRO_GROUP_ID;
  if (group && d.env.TELEGRAM_BOT_TOKEN) {
    const links = await d.store.linksToCheck();
    const subs = await d.store.allSubs(links.map((l) => l.wallet));
    for (const k of kickList(links.filter((l) => l.invited_at), subs, now)) {
      try { if (await kick(d.env.TELEGRAM_BOT_TOKEN, group, k.tg_user_id, d.fetch)) { await d.store.upsertLink({ wallet: k.wallet, removed_at: new Date(now).toISOString() }); await d.store.audit(k.wallet, 'tg_removed', { tg: k.tg_user_id }); out.kicked++; } } catch (e: any) { out.errors++; console.error('kick', e?.message); }
    }
  }
  // 3) paid orders whose per-kind hook hasn't succeeded yet (e.g. featured fulfilment hit an error) → retry
  for (const o of await d.store.paidUnfulfilled(10)) {
    try { const r = await runFulfilment(d, o, o.signature, { ok: true, kind: o.kind, fulfilled: false }); if (r.result?.fulfilled) out.fulfilled = (out.fulfilled ?? 0) + 1; } catch (e: any) { out.errors++; console.error('fulfil retry', o.id, e?.message); }
  }
  // 4) featured lifecycle + sponsored post (featured hook)
  try { Object.assign(out, await sweepFeatured(d)); } catch (e: any) { out.errors++; console.error('sweepFeatured', e?.message); }
  return json(req, d.env, out);
});
