// MaxiGems Pro + Featured pure logic (shared with the Supabase Edge Functions): prices, lamports math, payment
// verification, expiry stacking, gating, Telegram invite/kick, SIWS, JWT, shared RugCheck rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { PLANS, FEATURED, TEST_SOL, solToLamports, lamportsToSol, priceOrder, stackExpiry, daysLeft, gate, publicPlans, parseWalletList, DAY_MS } from '../supabase/functions/_shared/plans.js';
import { verifyPayment } from '../supabase/functions/_shared/verify.js';
import { inviteParams, kickList, kickCalls, kick, startToken, esc } from '../supabase/functions/_shared/tg.js';
import { buildMessage, parseMessage, checkSignIn } from '../supabase/functions/_shared/siws.js';
import { signJwt, verifyJwt } from '../supabase/functions/_shared/jwt.js';
import { b58encode, b58decode, randomPubkey } from '../supabase/functions/_shared/b58.js';
import { analyzeReport, SAFETY_DEFAULTS } from '../supabase/functions/_shared/safety-rules.js';
import { analyzeReport as engineAnalyze } from '../src/safety.js';
import { fakeReport } from './fixtures.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const TREASURY = '9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX';
const PAYER = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const OTHER = '2vrom1iH7Fr3fCJwfQvg9tCL5Y1n6EVpLn7zyqdnJfwD';
const REF = 'Ref1111111111111111111111111111111111111111';
const SIG = '5'.repeat(88);
const NOW = Date.parse('2026-10-10T12:00:00Z');

// ------------------------------------------------------------------ prices + lamports
test('prices: 0.48 / 1.28 / 4 SOL Pro, 1 SOL featured, exact integer lamports', () => {
  assert.deepEqual(Object.values(PLANS).map((p) => [p.days, p.sol]), [[30, '0.48'], [90, '1.28'], [365, '4']]);
  assert.equal(solToLamports(PLANS.p30.sol), 480000000n);
  assert.equal(solToLamports(PLANS.p90.sol), 1280000000n);
  assert.equal(solToLamports(PLANS.p365.sol), 4000000000n);
  assert.equal(solToLamports(FEATURED.sol), 1000000000n);
  assert.equal(FEATURED.hours, 24);
  assert.equal(solToLamports(TEST_SOL), 1000000n);
  assert.equal(solToLamports('0.000000001'), 1n);
  for (const bad of ['', '-1', '1e3', '0.1234567891', 'abc', '1.', '.5']) assert.equal(solToLamports(bad), null, bad);
  assert.equal(lamportsToSol(480000000n), '0.48');
  assert.equal(lamportsToSol(4000000000n), '4');
  assert.equal(lamportsToSol('1'), '0.000000001');
  // the 365-day plan is the ×3.2 anchor: 0.48 = 0.15×3.2, 1.28 = 0.4×3.2, 4 = 1.25×3.2
  assert.equal(solToLamports('0.15') * 32n / 10n, solToLamports(PLANS.p30.sol));
  assert.equal(solToLamports('0.4') * 32n / 10n, solToLamports(PLANS.p90.sol));
  assert.equal(solToLamports('1.25') * 32n / 10n, solToLamports(PLANS.p365.sol));
  const pub = publicPlans();
  assert.deepEqual(pub.plans.map((p) => p.lamports), ['480000000', '1280000000', '4000000000']);
  assert.equal(pub.featured.lamports, '1000000000');
});

test('site config + /pro/ show the same prices as the functions', () => {
  const pro = fs.readFileSync(new URL('../site/pro/index.html', import.meta.url), 'utf8');
  for (const p of Object.values(PLANS)) assert.match(pro, new RegExp(`data-plan="${p.id}"[\\s\\S]*?${p.sol.replace('.', '\\.')} SOL`));
  assert.doesNotMatch(pro, /0\.195|0\.52 SOL|1\.625|1\.3 SOL|0\.15 SOL|0\.4 SOL|1\.25 SOL/);
  const cfg = fs.readFileSync(new URL('../site/config.js', import.meta.url), 'utf8');
  assert.match(cfg, /proPrices:\s*\{\s*30:\s*0\.48,\s*90:\s*1\.28,\s*365:\s*4\s*\}/);
  assert.match(cfg, /featuredPriceSol:\s*1\b/);
  assert.match(cfg, /paymentsEnabled:\s*true/);
});

test('payments flag: disabled refuses every order; test wallet gets only the 0.001 SOL test price', () => {
  assert.equal(priceOrder({ kind: 'pro', plan: 'p30', wallet: PAYER }).status, 403);
  assert.equal(priceOrder({ kind: 'featured', wallet: PAYER }).status, 403);
  const t = priceOrder({ kind: 'pro', plan: 'p365', wallet: PAYER, testWallets: [PAYER] });
  assert.equal(t.ok, true); assert.equal(t.lamports, 1000000n); assert.equal(t.days, 365); assert.equal(t.test, true);
  assert.equal(priceOrder({ kind: 'pro', plan: 'p365', wallet: OTHER, testWallets: [PAYER] }).status, 403);
  const live = priceOrder({ kind: 'pro', plan: 'p90', wallet: PAYER, paymentsEnabled: true });
  assert.equal(live.lamports, 1280000000n); assert.equal(live.test, false);
  assert.equal(priceOrder({ kind: 'featured', wallet: PAYER, paymentsEnabled: true }).lamports, 1000000000n);
  assert.equal(priceOrder({ kind: 'pro', plan: 'p7', wallet: PAYER, paymentsEnabled: true }).status, 400);
  assert.equal(priceOrder({ kind: 'nft', wallet: PAYER, paymentsEnabled: true }).status, 400);
  assert.deepEqual(parseWalletList(`${PAYER}, nope ${OTHER}`), [PAYER, OTHER]);
});

// ------------------------------------------------------------------ payment verification
const transfer = (source, destination, lamports) => ({ programId: '11111111111111111111111111111111', program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports } } });
function mkTx({ payer = PAYER, to = TREASURY, lamports = 480000000, ref = REF, err = null, sig = SIG, ixs, inner } = {}) {
  const keys = [{ pubkey: payer, signer: true, writable: true }, { pubkey: to, signer: false, writable: true }, { pubkey: '11111111111111111111111111111111', signer: false, writable: false }];
  if (ref) keys.push({ pubkey: ref, signer: false, writable: false });
  return { slot: 1, blockTime: NOW / 1000, meta: { err, innerInstructions: inner || [] }, transaction: { signatures: [sig], message: { accountKeys: keys, instructions: ixs || [transfer(payer, to, lamports)] } } };
}
const order = { signature: SIG, treasury: TREASURY, wallet: PAYER, reference: REF, lamports: '480000000' };

test('verifyPayment: accepts the exact payment (and overpayment)', () => {
  assert.deepEqual(verifyPayment(mkTx(), order).ok, true);
  assert.equal(verifyPayment(mkTx({ lamports: 500000000 }), order).lamports, '500000000');
});
test('verifyPayment: rejects wrong recipient, short amount, missing reference, reused signature, wrong payer, failed tx', () => {
  assert.equal(verifyPayment(mkTx({ to: OTHER }), order).reason, 'wrong_recipient');
  assert.equal(verifyPayment(mkTx({ lamports: 479999999 }), order).reason, 'short_amount');
  assert.equal(verifyPayment(mkTx({ ref: null }), order).reason, 'missing_reference');
  assert.equal(verifyPayment(mkTx(), { ...order, usedSignatures: new Set([SIG]) }).reason, 'signature_used');
  assert.equal(verifyPayment(mkTx({ payer: OTHER }), order).reason, 'wrong_payer');
  assert.equal(verifyPayment(mkTx({ err: { InstructionError: [0, 'Custom'] } }), order).reason, 'tx_failed');
  assert.equal(verifyPayment(null, order).reason, 'not_found');
  assert.equal(verifyPayment(null, order).retry, true);
  assert.equal(verifyPayment(mkTx({ sig: '6'.repeat(88) }), order).reason, 'signature_mismatch');
});
test('verifyPayment: a third party paying the treasury inside the tx does not count for the payer', () => {
  const tx = mkTx({ ixs: [transfer(OTHER, TREASURY, 480000000), transfer(PAYER, TREASURY, 1000)] });
  assert.equal(verifyPayment(tx, order).reason, 'short_amount');
  const split = mkTx({ ixs: [transfer(PAYER, TREASURY, 240000000)], inner: [{ index: 0, instructions: [transfer(PAYER, TREASURY, 240000000)] }] });
  assert.equal(verifyPayment(split, order).ok, true);
});

// ------------------------------------------------------------------ expiry stacking + gating
test('stackExpiry: paying early stacks on the time left; expired passes restart from now', () => {
  const now = NOW;
  assert.equal(stackExpiry(null, 30, now), new Date(now + 30 * DAY_MS).toISOString());
  const cur = new Date(now + 10 * DAY_MS).toISOString();
  assert.equal(stackExpiry(cur, 30, now), new Date(now + 40 * DAY_MS).toISOString());
  const old = new Date(now - 5 * DAY_MS).toISOString();
  assert.equal(stackExpiry(old, 90, now), new Date(now + 90 * DAY_MS).toISOString());
  assert.equal(daysLeft(cur, now), 10);
  assert.equal(daysLeft(new Date(now + 1).toISOString(), now), 1);
  assert.equal(daysLeft(old, now), 0);
  assert.equal(daysLeft(null, now), 0);
});
test('gate: 401 signed out, 402 no/expired pass or someone else’s row, 200 active', () => {
  const sub = { wallet: PAYER, expires_at: new Date(NOW + 3 * DAY_MS).toISOString() };
  assert.equal(gate(null, sub, NOW).status, 401);
  assert.equal(gate({ wallet: 'bad' }, sub, NOW).status, 401);
  assert.equal(gate({ wallet: PAYER }, null, NOW).status, 402);
  assert.equal(gate({ wallet: PAYER }, { ...sub, expires_at: new Date(NOW - 1).toISOString() }, NOW).status, 402);
  assert.equal(gate({ wallet: PAYER }, { ...sub, expires_at: new Date(NOW - 1).toISOString() }, NOW).expired, true);
  assert.equal(gate({ wallet: OTHER }, sub, NOW).status, 402);
  const ok = gate({ wallet: PAYER }, sub, NOW);
  assert.equal(ok.status, 200); assert.equal(ok.daysLeft, 3);
});

// ------------------------------------------------------------------ Telegram invite / kick
test('telegram: single-use invite expiring in ~1 day', () => {
  const p = inviteParams(-1004352042429, PAYER, NOW);
  assert.equal(p.member_limit, 1);
  assert.equal(p.expire_date, NOW / 1000 + 86400);
  assert.ok(p.name.length <= 32);
  assert.equal(p.creates_join_request, undefined);
});
test('telegram: only expired, linked, invited, not-yet-removed members are kicked (ban → unban)', () => {
  const links = [
    { wallet: 'A', tg_user_id: 1, linked_at: 'x' }, { wallet: 'B', tg_user_id: 2, linked_at: 'x' },
    { wallet: 'C', tg_user_id: 3, linked_at: 'x', removed_at: 'y' }, { wallet: 'D', tg_user_id: null }, { wallet: 'E', tg_user_id: 5, linked_at: 'x' },
  ];
  const subs = [{ wallet: 'A', expires_at: new Date(NOW - 1).toISOString() }, { wallet: 'B', expires_at: new Date(NOW + DAY_MS).toISOString() }, { wallet: 'C', expires_at: new Date(NOW - 1).toISOString() }];
  assert.deepEqual(kickList(links, subs, NOW).map((k) => k.wallet), ['A', 'E']);
  assert.deepEqual(kickCalls(-100, 7).map((c) => c[0]), ['banChatMember', 'unbanChatMember']);
  assert.equal(kickCalls(-100, 7)[1][1].only_if_banned, true);
});
test('telegram: kick() calls ban then unban; "user not found" counts as removed', async () => {
  const calls = [];
  const f = async (url, o) => { calls.push(url.split('/').pop()); return new Response(JSON.stringify({ ok: true, result: true })); };
  assert.equal(await kick('T', -1, 9, f), true);
  assert.deepEqual(calls, ['banChatMember', 'unbanChatMember']);
  const gone = async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: user not found' }), { status: 400 });
  assert.equal(await kick('T', -1, 9, gone), true);
  const down = async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: not enough rights to restrict/unrestrict chat member' }), { status: 403 });
  await assert.rejects(kick('T', -1, 9, down));
});
test('telegram: deep-link token parsing + HTML escaping', () => {
  assert.equal(startToken('/start abcdefghijklmnopQR'), 'abcdefghijklmnopQR');
  assert.equal(startToken('/start@Maxigems_bot abcdefghijklmnopQR'), 'abcdefghijklmnopQR');
  assert.equal(startToken('/start'), null);
  assert.equal(startToken('/start <script>'), null);
  assert.equal(esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

// ------------------------------------------------------------------ SIWS + JWT
test('SIWS: valid signature signs in once; wrong domain/nonce/expired/forged fail', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const wallet = b58encode(raw);
  const msg = buildMessage({ domain: 'maxigems.fun', address: wallet, nonce: 'abcDEF123456', issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 300000).toISOString() });
  assert.equal(parseMessage(msg).address, wallet);
  const sig = b58encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(msg))));
  const nonceRow = { nonce: 'abcDEF123456', wallet, expires_at: new Date(NOW + 300000).toISOString() };
  const base = { message: msg, signature: sig, nonceRow, allowedDomains: ['maxigems.fun'], now: NOW };
  assert.deepEqual(await checkSignIn(base), { ok: true, wallet });
  assert.equal((await checkSignIn({ ...base, allowedDomains: ['evil.fun'] })).error, 'bad_domain');
  assert.equal((await checkSignIn({ ...base, nonceRow: { ...nonceRow, used_at: 'x' } })).error, 'nonce_used');
  assert.equal((await checkSignIn({ ...base, nonceRow: { ...nonceRow, nonce: 'other1234567' } })).error, 'bad_nonce');
  assert.equal((await checkSignIn({ ...base, now: NOW + 600000 })).error, 'expired');
  assert.equal((await checkSignIn({ ...base, message: msg.replace('Version: 1', 'Version: 1 ') })).error, 'bad_message');
  const forged = msg.replace(wallet, OTHER);
  assert.equal((await checkSignIn({ ...base, message: forged, nonceRow: { ...nonceRow, wallet: OTHER } })).error, 'bad_signature');
});
test('JWT: round-trip; tampered, expired, wrong secret rejected', async () => {
  const secret = 'x'.repeat(40);
  const t = await signJwt({ wallet: PAYER }, secret, 60, 1000);
  assert.equal((await verifyJwt(t, secret, 1010)).wallet, PAYER);
  assert.equal(await verifyJwt(t, secret, 1061), null);
  assert.equal(await verifyJwt(t, 'y'.repeat(40), 1010), null);
  const [h, b, s] = t.split('.');
  const evil = Buffer.from(JSON.stringify({ wallet: OTHER, aud: 'maxigems-pro', exp: 9e9 })).toString('base64url');
  assert.equal(await verifyJwt(`${h}.${evil}.${s}`, secret, 1010), null);
  const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  assert.equal(await verifyJwt(`${none}.${b}.`, secret, 1010), null);
  await assert.rejects(signJwt({ wallet: PAYER }, 'short'));
});
test('base58 round-trip + random reference keys are 32 bytes', () => {
  for (let i = 0; i < 20; i++) { const r = randomPubkey(); assert.equal(b58decode(r).length, 32); assert.equal(b58encode(b58decode(r)), r); }
  assert.equal(b58decode(TREASURY).length, 32);
});

// ------------------------------------------------------------------ RugCheck gating
test('featured safety uses the SAME rules + thresholds as the engine', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual({ ...SAFETY_DEFAULTS }, cfg.safety && Object.fromEntries(Object.keys(SAFETY_DEFAULTS).map((k) => [k, cfg.safety[k]])));
  assert.equal(engineAnalyze, analyzeReport);
  assert.deepEqual(analyzeReport(fakeReport(), {}, SAFETY_DEFAULTS).reasons, []);
  const bad = analyzeReport(fakeReport({ mintAuthority: 'X' }), {}, SAFETY_DEFAULTS);
  assert.ok(bad.reasons.some((r) => /mint authority/.test(r)));
  assert.ok(analyzeReport(null, {}, SAFETY_DEFAULTS).reasons.length);
});
