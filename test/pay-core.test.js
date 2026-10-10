// MGPay client core: Solana Pay-style transfer with a read-only reference key, order sanity checks (treasury pinning),
// sessions; the committed /assets/pay.js bundle is current; Pro pages are CSP-clean and gate nothing free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildPayment, checkOrder, readSession, canSignMessage, daysLabel } from '../site-src/pay-core.js';
import { b58bytes } from '../src/tip.js';

const TREASURY = '9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX';
const FROM = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const REF = 'So11111111111111111111111111111111111111112';
const BH = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYS = '11111111111111111111111111111111';
const ORDER = { orderId: '123e4567-e89b-12d3-a456-426614174000', reference: REF, lamports: '480000000', treasury: TREASURY, expiresAt: 'x' };

function parseLegacy(msg) {
  const [nSig, nRoSig, nRoUnsig] = msg; let i = 3;
  const nKeys = msg[i++]; const keys = [];
  for (let k = 0; k < nKeys; k++) { keys.push(Buffer.from(msg.slice(i, i + 32)).toString('hex')); i += 32; }
  i += 32; // blockhash
  const nIx = msg[i++]; const ixs = [];
  for (let k = 0; k < nIx; k++) {
    const prog = msg[i++]; const nAcc = msg[i++]; const acc = [...msg.slice(i, i + nAcc)]; i += nAcc;
    const len = msg[i++]; const data = Buffer.from(msg.slice(i, i + len)); i += len;
    ixs.push({ prog, acc, data });
  }
  return { nSig, nRoSig, nRoUnsig, keys, ixs };
}
const hex = (a) => Buffer.from(b58bytes(a)).toString('hex');

test('buildPayment: one SystemProgram transfer payer → treasury for the exact lamports, reference read-only non-signer', () => {
  const { message } = buildPayment({ from: FROM, treasury: TREASURY, lamports: 480000000n, reference: REF, blockhash: BH, lastValidBlockHeight: 1 });
  const m = parseLegacy(message);
  assert.equal(m.nSig, 1);
  assert.equal(m.keys[0], hex(FROM));
  assert.equal(m.ixs.length, 1);
  const ix = m.ixs[0];
  assert.equal(m.keys[ix.prog], hex(SYS));
  assert.deepEqual(ix.acc.map((k) => m.keys[k]), [hex(FROM), hex(TREASURY), hex(REF)]);
  const refIdx = m.keys.indexOf(hex(REF));
  assert.ok(refIdx >= m.nSig, 'reference is not a signer');
  assert.ok(refIdx >= m.keys.length - m.nRoUnsig, 'reference is read-only');
  assert.equal(ix.data.readUInt32LE(0), 2); // SystemInstruction::Transfer
  assert.equal(ix.data.readBigUInt64LE(4), 480000000n);
});
test('buildPayment refuses bad inputs', () => {
  const ok = { from: FROM, treasury: TREASURY, lamports: 1n, reference: REF, blockhash: BH };
  assert.throws(() => buildPayment({ ...ok, from: TREASURY }));
  assert.throws(() => buildPayment({ ...ok, lamports: 0n }));
  assert.throws(() => buildPayment({ ...ok, lamports: 10000000001n }));
  assert.throws(() => buildPayment({ ...ok, reference: 'nope' }));
});
test('checkOrder: pins the treasury baked into the bundle and sanity-checks the server order', () => {
  assert.equal(checkOrder(ORDER, TREASURY), 480000000n);
  assert.throws(() => checkOrder({ ...ORDER, treasury: FROM }, TREASURY), /mismatch/);
  assert.throws(() => checkOrder({ ...ORDER, reference: TREASURY }, TREASURY));
  assert.throws(() => checkOrder({ ...ORDER, lamports: '-1' }, TREASURY));
  assert.throws(() => checkOrder({ ...ORDER, lamports: '99000000000' }, TREASURY));
  assert.throws(() => checkOrder({ ...ORDER, orderId: '<x>' }, TREASURY));
});
test('sessions + helpers', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const s = { token: 'a.b.c', wallet: FROM, expiresAt: new Date(now + 3600e3).toISOString() };
  assert.deepEqual(readSession(JSON.stringify(s), now), s);
  assert.equal(readSession(JSON.stringify({ ...s, expiresAt: new Date(now + 30e3).toISOString() }), now), null);
  assert.equal(readSession('{bad', now), null);
  assert.equal(readSession(JSON.stringify({ ...s, wallet: 'x' }), now), null);
  assert.equal(canSignMessage({ std: { features: { 'solana:signMessage': {} } } }), true);
  assert.equal(canSignMessage({ injected: { signMessage() {} } }), true);
  assert.equal(canSignMessage({ std: { features: {} } }), false);
  assert.equal(daysLabel(1), '1 day left'); assert.equal(daysLabel(0), 'Expired');
});

test('committed /assets/pay.js matches a fresh build with the config treasury, and pro.js points at its hash', async () => {
  const { buildPayBundle, treasuryAddress } = await import('../scripts/build-pay.mjs');
  assert.equal(treasuryAddress(), TREASURY);
  const fresh = await buildPayBundle();
  const committed = fs.readFileSync(new URL('../site/assets/pay.js', import.meta.url));
  assert.ok(fresh.equals(committed), 'run npm run build:pay');
  assert.ok(committed.includes(TREASURY));
  assert.ok(!committed.includes('2vrom1iH7Fr3fCJwfQvg9tCL5Y1n6EVpLn7zyqdnJfwD'), 'tip address never used for payments');
  const v = crypto.createHash('sha256').update(committed).digest('hex').slice(0, 10);
  assert.match(fs.readFileSync(new URL('../site/assets/pro.js', import.meta.url), 'utf8'), new RegExp(`/assets/pay\\.js\\?v=${v}'`));
});

test('Pro pages: CSP allows Supabase functions, no inline scripts, no secrets, no public group invite link', () => {
  const files = ['site/pro/index.html', 'site/terms/index.html', 'site/risk/index.html', 'site/index.html', 'site/trending/index.html', 'site/whales/index.html', 'site/leaderboard/index.html', 'site/assets/pro.js', 'site/assets/pay.js', 'site/config.js'];
  for (const f of files) {
    const s = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    if (f.endsWith('.html')) {
      assert.match(s, /connect-src 'self' https:\/\/wrlsgqfpcvdjzsueikxw\.supabase\.co/, f);
      assert.doesNotMatch(s, /<script(?![^>]*\bsrc=)[^>]*>/, `${f}: inline script`);
      assert.match(s, /class="nav-pro" href="\/pro\/"/, f);
    }
    assert.doesNotMatch(s, /sb_secret|service_role|api-key=|bot\d{6,}:|TELEGRAM_BOT_TOKEN|SUPABASE_SERVICE_ROLE_KEY/, `${f}: secret-like string`);
    assert.doesNotMatch(s, /t\.me\/\+[A-Za-z0-9_-]{8,}/, `${f}: a group invite link must never be public`);
  }
  const pro = fs.readFileSync(new URL('../site/pro/index.html', import.meta.url), 'utf8');
  assert.match(pro, /<h1>Calls are <span class="g">free<\/span>, always\.<\/h1>/);
  assert.ok(pro.indexOf('Calls are') < pro.indexOf('id="plans"'), 'the page leads with free calls, plans come after');
  assert.match(pro, /No call is ever Pro-only, delayed or held back for Pro/);
  for (const t of ['site/terms/index.html', 'site/risk/index.html']) assert.match(fs.readFileSync(new URL(`../${t}`, import.meta.url), 'utf8'), /DRAFT/);
  const hdr = fs.readFileSync(new URL('../site/_headers', import.meta.url), 'utf8');
  assert.match(hdr, /connect-src 'self' https:\/\/wrlsgqfpcvdjzsueikxw\.supabase\.co/);
});
