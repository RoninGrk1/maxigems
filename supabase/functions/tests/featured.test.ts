// Featured listings hooks + the public `featured` function: MemoryStore/MemoryFeatured + fake DexScreener/RugCheck/
// Helius/Telegram. No network, no Supabase. Run: deno test -A --no-lock supabase/functions/tests/
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { MemoryStore } from '../_shared/store.ts';
import { MemoryFeatured } from '../_shared/featured-db.ts';
import { handleCreateOrder, handleVerifyPayment, handleSweep, type Deps } from '../_shared/app.ts';
import { validateFeaturedOrder, fulfilFeatured, sweepFeatured, handleFeaturedCallback } from '../_shared/featured.ts';
import { handleFeatured } from '../_shared/featured-http.ts';
import { signAdminToken } from '../_shared/featured-core.js';
import { signJwt } from '../_shared/jwt.js';

const TREASURY = '9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX';
const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const POOL = '2h59QWesujZ6Tb8dWr9K6ruSjeLk7MRSovLQQVYjigdB';
const PAYER = 'So11111111111111111111111111111111111111112';
const ADMIN_SECRET = 'a'.repeat(48);
const H = 3600000, DAY = 24 * H;
const T0 = Date.parse('2026-10-10T12:00:00Z');
const ORIGIN = 'https://maxigems.fun';

function report(o: Record<string, unknown> = {}) {
  const holders = Array.from({ length: 12 }, (_, i) => ({ address: `H${i}`.padEnd(40, 'x'), owner: `O${i}`.padEnd(40, 'y'), pct: 2, insider: false }));
  return { mint: CA, mintAuthority: null, freezeAuthority: null, token: { supply: 1e15 }, creatorBalance: 0, totalHolders: 900, graphInsidersDetected: 0, rugged: false, transferFee: { pct: 0 }, risks: [], knownAccounts: {}, markets: [{ pubkey: POOL, lp: { lpLockedPct: 100, quoteUSD: 1 } }], topHolders: holders, ...o };
}
function world(env: Record<string, string> = {}) {
  const store = new MemoryStore(); const featured = new MemoryFeatured(); (store as any).featured = featured;
  let now = T0; store.now = () => now;
  const tg: any[] = []; let rug: any = report(); let liq = 50000; const hits: string[] = []; const txs = new Map<string, any>();
  const f = (async (url: string, o: any = {}) => {
    hits.push(url);
    const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (url.startsWith('https://mainnet.helius-rpc.com')) {
      const b = JSON.parse(o.body);
      if (b.method === 'getTransaction') return j({ result: txs.get(b.params[0]) ?? null });
      if (b.method === 'getMultipleAccounts') return j({ result: { value: [{ data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } }] } });
      return j({ result: [] });
    }
    if (url.includes('api.dexscreener.com')) { const ca = url.split('/').pop(); return j([{ chainId: 'solana', dexId: 'pumpswap', pairAddress: POOL, baseToken: { address: ca, symbol: '<b>GEM', name: 'Gem <script>' }, priceUsd: '0.001', liquidity: { usd: liq }, marketCap: 900000, pairCreatedAt: T0 - 5 * H, info: { imageUrl: 'https://cdn.dexscreener.com/x.png' } }]); }
    if (url.includes('api.rugcheck.xyz')) return rug ? j(rug) : j({}, 503);
    if (url.endsWith('/data/calls.json')) return j({ calls: [{ address: 'So11111111111111111111111111111111111111112', status: 'rugged' }] });
    if (url.includes('api.telegram.org')) { const m = url.split('/').pop(); tg.push({ m, b: JSON.parse(o.body) }); return j({ ok: true, result: { message_id: 900 + tg.length } }); }
    return j({}, 404);
  }) as unknown as typeof fetch;
  const d: Deps = { store, env: { SESSION_JWT_SECRET: 's'.repeat(48), SWEEP_SECRET: 'w'.repeat(40), TELEGRAM_BOT_TOKEN: 'T:1', TELEGRAM_ADMIN_CHAT_ID: '8995645285', TELEGRAM_CHANNEL_ID: '@maxigems_calls', HELIUS_API_KEY: 'k', TREASURY_WALLET: TREASURY, FEATURED_ADMIN_SECRET: ADMIN_SECRET, ...env } as any, fetch: f, now: () => now };
  return { d, store, featured, tg, hits, txs, setNow: (t: number) => (now = t), setRug: (r: any) => (rug = r), setLiq: (v: number) => (liq = v) };
}
const req = (body: unknown, headers: Record<string, string> = {}) => new Request('https://x.supabase.co/functions/v1/featured', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const order = (id: string, ca = CA, o: Record<string, unknown> = {}) => ({ id, kind: 'featured', ca, wallet: PAYER, status: 'paid', meta: { symbol: 'GEM', token: { ca, symbol: 'GEM', name: 'Gem', pairAddress: POOL }, safety: { mintRevoked: true, freezeRevoked: true, lpLockedPct: 100, top10Pct: 20 } }, ...o });
const CAS = ['7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'];

Deno.test('validateFeaturedOrder: clean token → meta with quote; unsafe / rugged / RugCheck down → reasons, fail closed', async () => {
  const w = world();
  const ok: any = await validateFeaturedOrder(CA, w.d);
  assertEquals(ok.ok, true);
  assertEquals(ok.meta.token.symbol, '<b>GEM'); // raw (escaped at render time)
  assertEquals(ok.meta.quote.startsAt, new Date(T0).toISOString());
  w.setRug(report({ freezeAuthority: 'Abc' }));
  const bad: any = await validateFeaturedOrder(CA, w.d);
  assertEquals(bad.status, 422); assertMatch(bad.reasons.join(' '), /Freeze authority/);
  w.setRug(null);
  assertMatch(((await validateFeaturedOrder(CA, w.d)) as any).reasons.join(' '), /failed closed/);
  assertEquals(((await validateFeaturedOrder(CA, w.d)) as any).status, 503);
  w.setRug(report()); w.setLiq(5000);
  assertMatch(((await validateFeaturedOrder(CA, w.d)) as any).reasons.join(' '), /minimum \$20,000/);
  w.setLiq(50000);
  assertMatch(((await validateFeaturedOrder(PAYER, w.d)) as any).reasons.join(' '), /flagged this token as rugged/);
  assertEquals(((await validateFeaturedOrder('bad', w.d)) as any).status, 400);
});

Deno.test('create-order (test wallet, payments off) → verify-payment → fulfilFeatured books + DMs admin a signed URL button', async () => {
  const w = world({ TEST_WALLETS: PAYER });
  const auth = { authorization: `Bearer ${await signJwt({ wallet: PAYER }, 's'.repeat(48), 3600, Math.floor(T0 / 1000))}` };
  const r = await handleCreateOrder(new Request('https://x/f', { method: 'POST', headers: { origin: ORIGIN, ...auth }, body: JSON.stringify({ kind: 'featured', ca: CA }) }), w.d);
  assertEquals(r.status, 200);
  const o = await r.json();
  assertEquals(o.test, true); assertEquals(o.lamports, '1000000'); // allow-listed test price only
  const sig = '5'.repeat(88);
  w.txs.set(sig, { slot: 1, meta: { err: null }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: TREASURY, signer: false }, { pubkey: o.reference, signer: false }], instructions: [{ programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: PAYER, destination: TREASURY, lamports: 1000000 } } }] } } });
  const v = await handleVerifyPayment(new Request('https://x/f', { method: 'POST', headers: { origin: ORIGIN, ...auth }, body: JSON.stringify({ orderId: o.orderId, signature: sig }) }), w.d);
  const vj = await v.json();
  assertEquals(v.status, 200, JSON.stringify(vj));
  assertEquals(vj.result.booked, true);
  assertEquals(w.featured.rows.length, 1);
  assertEquals(w.featured.rows[0].status, 'active');
  assert((await w.store.getOrder(o.orderId))!.fulfilled_at, 'order marked fulfilled');
  const dm = w.tg.find((x) => x.m === 'sendMessage');
  assertEquals(dm.b.chat_id, '8995645285');
  assertMatch(dm.b.text, /New featured booking<\/b> \(TEST payment\)/);
  assert(!dm.b.text.includes('<script>') && dm.b.text.includes('&lt;b&gt;GEM'), 'escaped');
  const btn = dm.b.reply_markup.inline_keyboard[0][0];
  assertEquals(btn.text, '🛑 Pull listing');
  assertMatch(btn.url, /^https:\/\/maxigems\.fun\/featured\/admin\/#[0-9a-f-]+\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert(!w.tg.some((x) => x.b.callback_data || JSON.stringify(x.b).includes('callback_data')), 'no callback buttons');
  // idempotent: verifying again books nothing new and sends no second DM
  await handleVerifyPayment(new Request('https://x/f', { method: 'POST', headers: { origin: ORIGIN, ...auth }, body: JSON.stringify({ orderId: o.orderId, signature: sig }) }), w.d);
  assertEquals(w.featured.rows.length, 1);
  assertEquals(w.tg.filter((x) => x.m === 'sendMessage').length, 1);
});

Deno.test('caps: 4th concurrent booking is waitlisted; posts are spaced 24h; same coin twice → manual refund DM', async () => {
  const w = world();
  for (let i = 0; i < 4; i++) assertEquals((await fulfilFeatured(w.d, order(`o${i}`, CAS[i]), `sig${i}`)).ok, true);
  const rows = w.featured.rows;
  const starts = rows.map((r) => Date.parse(r.starts_at) - T0);
  assertEquals(starts[0], 0);
  for (let i = 1; i < 4; i++) assert(starts[i] > 0, 'later bookings wait for a post slot');
  const posts = rows.map((r) => Date.parse(r.post_due_at)).sort((a, b) => a - b);
  for (let i = 1; i < posts.length; i++) assert(posts[i] - posts[i - 1] >= DAY);
  // quote shown on the page equals the next booking's slot
  const q: any = await validateFeaturedOrder(CAS[4], w.d);
  const r5: any = await fulfilFeatured(w.d, order('o4', CAS[4]), 'sig4');
  assertEquals(q.meta.quote.startsAt, r5.result.startsAt);
  // a paid order for a coin that got booked meanwhile → terminal, admin told to refund
  const dup: any = await fulfilFeatured(w.d, order('o9', CAS[0]), 'sig9');
  assertEquals(dup.ok, true); assertEquals(dup.result.refundRequired, true);
  assertMatch(w.tg.at(-1).b.text, /manual refund/);
});

Deno.test('FEATURED_DRY_RUN: nothing is sent to Telegram (logged instead)', async () => {
  const w = world({ FEATURED_DRY_RUN: '1' });
  const logs: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => logs.push(a.join(' '));
  try { await fulfilFeatured(w.d, order('o1'), 'sig1'); } finally { console.log = orig; }
  assertEquals(w.tg.length, 0);
  assert(logs.some((l) => l.includes('[FEATURED_DRY_RUN] sendMessage → 8995645285')));
});

Deno.test('public featured function: check / status / admin-view / pull (signed link), CORS', async () => {
  const w = world();
  const c = await (await handleFeatured(req({ action: 'check', ca: CA }), w.d)).json();
  assertEquals(c.ok, true); assertEquals(c.paymentsEnabled, false); assertEquals(c.price.sol, '1');
  w.setRug(report({ mintAuthority: 'X' }));
  const c2 = await (await handleFeatured(req({ action: 'check', ca: CAS[1] }), w.d)).json();
  assertEquals(c2.ok, false); assertEquals(c2.quote, null); assertMatch(c2.reasons[0], /Mint authority/);
  w.setRug(report());
  await fulfilFeatured(w.d, order('o1'), 'sig1');
  const l = w.featured.rows[0];
  l.post_message_id = 4242; l.posted_at = new Date(T0).toISOString();
  const st = await (await handleFeatured(req({ action: 'status', ca: CA }), w.d)).json();
  assertEquals(st.status, 'active'); assertEquals(st.posted, true);
  assert(!JSON.stringify(st).includes(PAYER), 'status is public: no payer wallet');
  const tok = await signAdminToken({ id: l.id, exp: T0 + H }, ADMIN_SECRET);
  const view = await (await handleFeatured(req({ action: 'admin-view', token: tok }), w.d)).json();
  assertEquals(view.ok, true); assertEquals(view.wallet, PAYER);
  // tampered / expired / wrong secret → 403, nothing pulled
  const bad = tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A');
  assertEquals((await handleFeatured(req({ action: 'pull', token: bad }), w.d)).status, 403);
  w.setNow(T0 + 2 * H);
  assertEquals((await (await handleFeatured(req({ action: 'pull', token: tok }), w.d)).json()).error, 'expired');
  w.setNow(T0);
  assertEquals(w.featured.rows[0].status, 'active');
  const p = await (await handleFeatured(req({ action: 'pull', token: tok }), w.d)).json();
  assertEquals(p.ok, true); assertEquals(p.postDeleted, true);
  const del = w.tg.find((x) => x.m === 'deleteMessage');
  assertEquals(del.b, { chat_id: '@maxigems_calls', message_id: 4242 });
  assertEquals(w.featured.rows[0].status, 'pulled');
  const again = await (await handleFeatured(req({ action: 'pull', token: tok }), w.d)).json();
  assertEquals(again.already, true);
  assertEquals(w.tg.filter((x) => x.m === 'deleteMessage').length, 1);
  // CORS + method guard
  const pre = await handleFeatured(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), w.d);
  assertEquals(pre.status, 204); assertEquals(pre.headers.get('access-control-allow-origin'), 'https://maxigems.fun');
  assertEquals((await handleFeatured(new Request('https://x/f', { method: 'GET' }), w.d)).status, 405);
  assertEquals((await handleFeatured(req({ action: 'nope' }), w.d)).status, 400);
});

Deno.test('sweep: featured lifecycle (queued → active → ended); callbacks are not used', async () => {
  const w = world();
  for (let i = 0; i < 2; i++) await fulfilFeatured(w.d, order(`o${i}`, CAS[i]), `s${i}`);
  assertEquals(w.featured.rows.map((r) => r.status), ['active', 'queued']);
  w.setNow(Date.parse(w.featured.rows[1].starts_at) + 1000);
  assertEquals(await sweepFeatured(w.d), { featuredActivated: 1, featuredEnded: 0 });
  w.setNow(Date.parse(w.featured.rows[1].ends_at) + 1000);
  const s = await (await handleSweep(new Request('https://x/f', { method: 'POST', headers: { 'x-sweep-secret': 'w'.repeat(40) } }), w.d)).json();
  assertEquals(s.featuredEnded, 2);
  assertEquals(await handleFeaturedCallback(w.d, { data: 'pull:x' }), false);
});
