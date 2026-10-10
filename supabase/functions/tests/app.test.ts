// End-to-end Edge Function handler tests: MemoryStore + fake Helius/RugCheck/DexScreener/Telegram.
// Run: deno test -A supabase/functions/tests/   (no network, no Supabase needed)
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { MemoryStore } from '../_shared/store.ts';
import { handleAuth, handleAccount, handleCreateOrder, handleVerifyPayment, handleProData, handleIngest, handleTelegram, handleSweep, type Deps } from '../_shared/app.ts';
import { b58encode } from '../_shared/b58.js';
import { MemoryFeatured } from '../_shared/featured-db.ts';

const TREASURY = '9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX';
const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const ORIGIN = 'https://maxigems.fun';
const DAY = 86400000;

function world(envOver: Record<string, string> = {}) {
  const store = new MemoryStore();
  let now = Date.parse('2026-10-10T12:00:00Z');
  store.now = () => now;
  const txs = new Map<string, any>(); const sigsByRef = new Map<string, any[]>();
  const tg: any[] = []; let rug: any = goodReport();
  const f = (async (url: string, o: any = {}) => {
    const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (url.startsWith('https://mainnet.helius-rpc.com')) {
      const b = JSON.parse(o.body);
      if (b.method === 'getTransaction') return j({ result: txs.get(b.params[0]) ?? null });
      if (b.method === 'getSignaturesForAddress') return j({ result: sigsByRef.get(b.params[0]) ?? [] });
      if (b.method === 'getMultipleAccounts') return j({ result: { value: [{ data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } }] } });
    }
    if (url.includes('api.dexscreener.com')) return j([{ chainId: 'solana', pairAddress: 'POOL1111111111111111111111111111111111111111', baseToken: { address: url.split('/').pop(), symbol: 'GEM', name: 'Gem <b>' }, liquidity: { usd: 50000 }, marketCap: 900000, info: { imageUrl: 'https://cdn.dexscreener.com/x.png' } }]);
    if (url.includes('api.rugcheck.xyz')) return rug ? j(rug) : j({}, 503);
    if (url.includes('api.telegram.org')) { const m = url.split('/').pop(); tg.push({ m, b: JSON.parse(o.body) }); return j({ ok: true, result: m === 'createChatInviteLink' ? { invite_link: 'https://t.me/+single' } : { message_id: 77 } }); }
    return j({}, 404);
  }) as unknown as typeof fetch;
  const env = { SESSION_JWT_SECRET: 's'.repeat(48), SWEEP_SECRET: 'w'.repeat(40), INGEST_SECRET: 'i'.repeat(40), TELEGRAM_WEBHOOK_SECRET: 'h'.repeat(40), TELEGRAM_BOT_TOKEN: 'T:1', TELEGRAM_PRO_GROUP_ID: '-1004352042429', TELEGRAM_ADMIN_CHAT_ID: '8995645285', TELEGRAM_CHANNEL_ID: '@maxigems_calls', HELIUS_API_KEY: 'k', TREASURY_WALLET: TREASURY, ...envOver };
  const d: Deps = { store, env, fetch: f, now: () => now };
  return { d, store, txs, sigsByRef, tg, setNow: (t: number) => (now = t), getNow: () => now, setRug: (r: any) => (rug = r) };
}
function goodReport() {
  const holders = Array.from({ length: 12 }, (_, i) => ({ address: `H${i}`.padEnd(40, 'x'), owner: `O${i}`.padEnd(40, 'y'), pct: 2, insider: false }));
  return { mint: CA, mintAuthority: null, freezeAuthority: null, token: { supply: 1e15 }, creatorBalance: 0, totalHolders: 900, graphInsidersDetected: 0, rugged: false, transferFee: { pct: 0 }, risks: [], knownAccounts: {}, markets: [{ pubkey: 'POOL1111111111111111111111111111111111111111', lp: { lpLockedPct: 100, quoteUSD: 1 } }], topHolders: holders };
}
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) => new Request('https://x.supabase.co/functions/v1/f', { method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

async function signIn(w: ReturnType<typeof world>) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const wallet = b58encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const n = await (await handleAuth(req('POST', { action: 'nonce', wallet }), w.d)).json();
  const sig = b58encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(n.message))));
  const r = await handleAuth(req('POST', { action: 'verify', message: n.message, signature: sig }), w.d);
  assertEquals(r.status, 200);
  const j = await r.json();
  // replaying the same signed message must fail (nonce is single-use)
  assertEquals((await handleAuth(req('POST', { action: 'verify', message: n.message, signature: sig }), w.d)).status, 401);
  return { wallet, auth: { authorization: `Bearer ${j.token}` } };
}
function payTx(from: string, ref: string, lamports: string | number, sig: string, to = TREASURY) {
  return { slot: 1, meta: { err: null }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: from, signer: true }, { pubkey: to, signer: false }, { pubkey: ref, signer: false }], instructions: [{ programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: from, destination: to, lamports: Number(lamports) } } }] } } };
}
const SIG1 = '3'.repeat(88), SIG2 = '4'.repeat(88);

Deno.test('payments disabled by default: orders refused, account says coming soon', async () => {
  const w = world();
  const { auth } = await signIn(w);
  const r = await handleCreateOrder(req('POST', { kind: 'pro', plan: 'p30' }, auth), w.d);
  assertEquals(r.status, 403);
  const a = await (await handleAccount(req('GET'), w.d)).json();
  assertEquals(a.paymentsEnabled, false);
  assertEquals(a.plans.map((p: any) => p.sol), ['0.48', '1.28', '4']);
  assertEquals(a.featured.sol, '1');
  assertEquals((await handleCreateOrder(req('POST', { kind: 'pro', plan: 'p30' }), w.d)).status, 401);
});

Deno.test('test wallet: 0.001 SOL order → pay → verify → Pro active; reused signature + stacking', async () => {
  const w = world();
  const { wallet, auth } = await signIn(w);
  w.d.env.TEST_WALLETS = wallet;
  const o = await (await handleCreateOrder(req('POST', { kind: 'pro', plan: 'p30' }, auth), w.d)).json();
  assertEquals(o.lamports, '1000000'); assertEquals(o.test, true); assertEquals(o.treasury, TREASURY); assert(o.reference && o.expiresAt && o.orderId);
  // not on-chain yet → 202 retry
  assertEquals((await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG1 }, auth), w.d)).status, 202);
  w.txs.set(SIG1, payTx(wallet, o.reference, o.lamports, SIG1));
  const v = await (await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG1 }, auth), w.d)).json();
  assertEquals(v.ok, true); assertEquals(v.account.pro.active, true); assertEquals(v.account.pro.daysLeft, 30);
  // second order may not reuse the same signature
  const o2 = await (await handleCreateOrder(req('POST', { kind: 'pro', plan: 'p90' }, auth), w.d)).json();
  const reuse = await handleVerifyPayment(req('POST', { orderId: o2.orderId, signature: SIG1 }, auth), w.d);
  assertEquals(reuse.status, 422); assertEquals((await reuse.json()).reason, 'signature_used');
  // paying early stacks: 30 + 90
  w.txs.set(SIG2, payTx(wallet, o2.reference, o2.lamports, SIG2));
  const v2 = await (await handleVerifyPayment(req('POST', { orderId: o2.orderId, signature: SIG2 }, auth), w.d)).json();
  assertEquals(v2.account.pro.daysLeft, 120);
});

Deno.test('live prices + wrong recipient / short amount rejected', async () => {
  const w = world({ PAYMENTS_ENABLED: 'true' });
  const { wallet, auth } = await signIn(w);
  const o = await (await handleCreateOrder(req('POST', { kind: 'pro', plan: 'p365' }, auth), w.d)).json();
  assertEquals(o.lamports, '4000000000');
  w.txs.set(SIG1, payTx(wallet, o.reference, o.lamports, SIG1, CA));
  assertEquals((await (await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG1 }, auth), w.d)).json()).reason, 'wrong_recipient');
  w.txs.set(SIG2, payTx(wallet, o.reference, '3999999999', SIG2));
  assertEquals((await (await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG2 }, auth), w.d)).json()).reason, 'short_amount');
  // someone else's order is invisible
  const other = await signIn(w);
  assertEquals((await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG2 }, other.auth), w.d)).status, 404);
});

Deno.test('pro-data gated: 401 → 402 → 200 → 402 after expiry; sweep catches a closed-tab payment and kicks on expiry', async () => {
  const w = world({ PAYMENTS_ENABLED: 'true' });
  assertEquals((await handleProData(req('GET'), w.d)).status, 401);
  const { wallet, auth } = await signIn(w);
  assertEquals((await handleProData(req('GET', undefined, auth), w.d)).status, 402);
  await handleIngest(req('POST', { whaleMoves: { updatedAt: 'now', moves: [{ t: 'x' }] }, watchlist: { items: [{ address: CA }] } }, { 'x-ingest-secret': 'i'.repeat(40) }), w.d);
  assertEquals((await handleIngest(req('POST', {}, { 'x-ingest-secret': 'nope' }), w.d)).status, 403);
  const o = await (await handleCreateOrder(req('POST', { kind: 'pro', plan: 'p30' }, auth), w.d)).json();
  // tab closed: never called verify. The sweep finds it via the reference key.
  w.txs.set(SIG1, payTx(wallet, o.reference, o.lamports, SIG1));
  w.sigsByRef.set(o.reference, [{ signature: SIG1, err: null }]);
  assertEquals((await handleSweep(req('POST', {}, { 'x-sweep-secret': 'bad' }), w.d)).status, 403);
  const s = await (await handleSweep(req('POST', {}, { 'x-sweep-secret': 'w'.repeat(40) }), w.d)).json();
  assertEquals(s.settled, 1);
  const pd = await (await handleProData(req('GET', undefined, auth), w.d)).json();
  assertEquals(pd.whaleMoves.moves.length, 1); assertEquals(pd.watchlist.items[0].address, CA);
  // link Telegram via deep link, get a single-use invite
  const link = await (await handleAccount(req('POST', { action: 'tg-link' }, auth), w.d)).json();
  const token = new URL(link.url).searchParams.get('start')!;
  await handleTelegram(req('POST', { message: { chat: { id: 555, type: 'private' }, from: { id: 555 }, text: `/start ${token}` } }, { 'x-telegram-bot-api-secret-token': 'h'.repeat(40) }), w.d);
  assertEquals((await w.store.getLink(wallet))!.tg_user_id, 555);
  const inv = await (await handleAccount(req('POST', { action: 'tg-invite' }, auth), w.d)).json();
  assertEquals(inv.url, 'https://t.me/+single');
  const c = w.tg.find((x) => x.m === 'createChatInviteLink');
  assertEquals(c.b.member_limit, 1); assertEquals(c.b.chat_id, '-1004352042429');
  // 31 days later: expired → 402 and removed from the group (ban + unban)
  w.setNow(w.getNow() + 31 * DAY);
  assertEquals((await handleProData(req('GET', undefined, auth), w.d)).status, 401); // 24h session expired too
  const s2 = await (await handleSweep(req('POST', {}, { 'x-sweep-secret': 'w'.repeat(40) }), w.d)).json();
  assertEquals(s2.kicked, 1);
  assertEquals(w.tg.filter((x) => x.m === 'banChatMember' || x.m === 'unbanChatMember').slice(-2).map((x) => x.m), ['banChatMember', 'unbanChatMember']);
  assert((await w.store.getLink(wallet))!.removed_at);
});

Deno.test('featured kind goes through the featured hook (fails closed: an unsafe/too-new token creates no order)', async () => {
  const w = world({ PAYMENTS_ENABLED: 'true' });
  (w.store as any).featured = new MemoryFeatured();
  const { auth } = await signIn(w);
  const r = await handleCreateOrder(req('POST', { kind: 'featured', ca: CA }, auth), w.d);
  assertEquals(r.status, 422); // this fixture's pair has no pairCreatedAt → age unknown → rejected with reasons
  assert((await r.json()).reasons.some((x: string) => /minimum 90 minutes/.test(x)));
  assertEquals(w.store.orders.size, 0);
  assertEquals((await handleCreateOrder(req('POST', { kind: 'featured', ca: 'nope' }, auth), w.d)).status, 400);
  // telegram callback queries are delegated to the featured hook; featured uses URL buttons, so they're just acknowledged
  await handleTelegram(req('POST', { callback_query: { id: 'q', from: { id: 1 }, data: 'pull:x' } }, { 'x-telegram-bot-api-secret-token': 'h'.repeat(40) }), w.d);
  assertEquals(w.tg.at(-1).m, 'answerCallbackQuery');
});

Deno.test('verify-payment is idempotent and a paid order cannot be re-paid with another signature', async () => {
  const w = world({ PAYMENTS_ENABLED: 'true' });
  const { wallet, auth } = await signIn(w);
  const o = await (await handleCreateOrder(req('POST', { kind: 'pro', plan: 'p30' }, auth), w.d)).json();
  w.txs.set(SIG1, payTx(wallet, o.reference, o.lamports, SIG1));
  assertEquals((await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG1 }, auth), w.d)).status, 200);
  const again = await (await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG1 }, auth), w.d)).json();
  assertEquals(again.ok, true); assertEquals(again.account.pro.daysLeft, 30); // not double-credited
  w.txs.set(SIG2, payTx(wallet, o.reference, o.lamports, SIG2));
  assertEquals((await handleVerifyPayment(req('POST', { orderId: o.orderId, signature: SIG2 }, auth), w.d)).status, 422);
});

Deno.test('CORS: only maxigems.fun origins are reflected', async () => {
  const w = world();
  const r = await handleAccount(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), w.d);
  assertEquals(r.headers.get('access-control-allow-origin'), 'https://maxigems.fun');
  const ok = await handleAccount(new Request('https://x/f', { method: 'GET', headers: { origin: 'https://www.maxigems.fun' } }), w.d);
  assertEquals(ok.headers.get('access-control-allow-origin'), 'https://www.maxigems.fun');
});
