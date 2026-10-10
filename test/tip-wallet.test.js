// Wallet tip core: lamports math, recipient validation, tx bytes (decoded independently), wallet filtering, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solToLamports, lamportsToSol, amountError, isPubkey, buildTransfer, pickWallets, usableStandard, errorMessage, WALLETS, MIN_LAMPORTS, MAX_LAMPORTS,
} from '../site-src/tip-core.js';

const TO = '2vrom1iH7Fr3fCJwfQvg9tCL5Y1n6EVpLn7zyqdnJfwD';
const FROM = 'HoLyRoDEQvK5zPsGpcz3BbCWhceTGhWAGnVifSoUShit';
const BH = '5Cgd9M14Fgv7reLLE3jmxkDqYaFJ7vCgpvR4Lg8fXu7M';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b) break; s = '1' + s; } return s; };

/** Minimal independent legacy-transaction decoder (wire format). */
function decode(wire) {
  let o = 0; const u8 = () => wire[o++];
  const cu16 = () => { let v = 0, s = 0, b; do { b = u8(); v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v; };
  const take = (n) => { const r = wire.slice(o, o + n); o += n; return r; };
  const nSig = cu16(); const sigs = []; for (let i = 0; i < nSig; i++) sigs.push(take(64));
  assert.ok(wire[o] < 0x80, 'legacy message expected');
  const header = [u8(), u8(), u8()];
  const keys = []; for (let i = cu16(); i > 0; i--) keys.push(enc58(take(32)));
  const blockhash = enc58(take(32));
  const ixs = []; for (let i = cu16(); i > 0; i--) { const p = u8(); const acc = [...take(cu16())]; const data = take(cu16()); ixs.push({ program: keys[p], accounts: acc.map((a) => keys[a]), data }); }
  assert.equal(o, wire.length, 'no trailing bytes');
  return { sigs, header, keys, blockhash, ixs };
}

test('SOL → lamports uses integer math (no float errors)', () => {
  assert.equal(solToLamports('0.1'), 100000000n);
  assert.equal(solToLamports('0.05'), 50000000n);
  assert.equal(solToLamports('0.5'), 500000000n);
  assert.equal(solToLamports('0.3'), 300000000n); // 0.1+0.2 float trap
  assert.equal(solToLamports('1.000000001'), 1000000001n);
  assert.equal(solToLamports('0,25'), 250000000n);
  assert.equal(solToLamports('.5'), 500000000n);
  assert.equal(solToLamports(' 2 '), 2000000000n);
  for (const bad of ['', 'abc', '1e-3', '-1', '0.0000000001', '1.2.3', '0x10', 'Infinity', 'NaN', '1 000']) assert.equal(solToLamports(bad), null, bad);
  assert.equal(lamportsToSol(50000000n), '0.05'); assert.equal(lamportsToSol(1000000001n), '1.000000001'); assert.equal(lamportsToSol(2000000000n), '2');
  assert.equal(MIN_LAMPORTS, 1000000n); assert.equal(MAX_LAMPORTS, 100000000000n);
  assert.equal(amountError('0.001'), ''); assert.equal(amountError('100'), '');
  assert.match(amountError('0.0009'), /Minimum/); assert.match(amountError('100.000000001'), /Maximum/); assert.match(amountError('x'), /Enter/);
});

test('recipient validation: 32-byte base58 only, must equal the configured recipient', () => {
  assert.ok(isPubkey(TO)); assert.ok(isPubkey('11111111111111111111111111111111'));
  for (const bad of ['', TO.slice(6), TO + '1', TO.replace('2', '0'), '1'.repeat(44), 'O'.repeat(44), null, 42]) assert.equal(isPubkey(bad), false, String(bad));
  assert.ok(isPubkey(TO.slice(1)), 'a different valid key'); assert.throws(() => buildTransfer({ from: FROM, to: TO.slice(1), recipient: TO, lamports: 100000000n, blockhash: BH }), /recipient/);
  const ok = { from: FROM, to: TO, recipient: TO, lamports: 100000000n, blockhash: BH, lastValidBlockHeight: 1 };
  assert.throws(() => buildTransfer({ ...ok, to: FROM, recipient: TO }), /recipient/);
  assert.throws(() => buildTransfer({ ...ok, to: TO.slice(0, -1) + 'E' }), /recipient/);
  assert.throws(() => buildTransfer({ ...ok, from: 'nope' }), /Wallet account/);
  assert.throws(() => buildTransfer({ ...ok, from: TO }), /tip wallet itself/);
  assert.throws(() => buildTransfer({ ...ok, lamports: 999999n }), /range/);
  assert.throws(() => buildTransfer({ ...ok, lamports: MAX_LAMPORTS + 1n }), /range/);
  assert.throws(() => buildTransfer({ ...ok, blockhash: 'x' }), /blockhash/);
});

test('built tx = exactly one SystemProgram.transfer(from → exact recipient, exact lamports), fee payer = sender', () => {
  for (const sol of ['0.05', '0.1', '0.5', '0.001', '1.234567891', '100']) {
    const lam = solToLamports(sol);
    const { wire, message } = buildTransfer({ from: FROM, to: TO, recipient: TO, lamports: lam, blockhash: BH, lastValidBlockHeight: 123 });
    const tx = decode(wire);
    assert.equal(tx.sigs.length, 1); assert.ok(tx.sigs[0].every((b) => b === 0), 'unsigned');
    assert.deepEqual(tx.header, [1, 0, 1]); // 1 signer (sender), 0 ro-signed, 1 ro-unsigned (system program)
    assert.deepEqual(tx.keys, [FROM, TO, '11111111111111111111111111111111']);
    assert.equal(tx.blockhash, BH);
    assert.equal(tx.ixs.length, 1);
    const ix = tx.ixs[0];
    assert.equal(ix.program, '11111111111111111111111111111111');
    assert.deepEqual(ix.accounts, [FROM, TO]);
    assert.equal(ix.data.length, 12);
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, 12);
    assert.equal(dv.getUint32(0, true), 2, 'Transfer discriminator');
    assert.equal(dv.getBigUint64(4, true), lam, `${sol} SOL`);
    assert.deepEqual([...message], [...wire.slice(65)]);
  }
});

test('wallet filtering: only Phantom, Solflare, Jupiter on mainnet with connect + signAndSendTransaction', () => {
  const feats = { 'standard:connect': { connect() {} }, 'solana:signAndSendTransaction': { signAndSendTransaction() {} } };
  const W = (name, o = {}) => ({ name, chains: ['solana:mainnet'], features: feats, accounts: [], ...o });
  const std = [W('Backpack'), W('Phantom'), W('Solflare'), W('Jupiter'), W('Glow'), W('MetaMask'), W('Phantom-ish fake', { chains: ['solana:devnet'] }), W('OKX Wallet')];
  const out = pickWallets(std, {});
  assert.deepEqual(out.map((w) => w.id), ['phantom', 'solflare', 'jupiter']);
  assert.ok(out.every((w) => w.installed && w.canSend && w.std));
  assert.equal(out[0].std.name, 'Phantom');
  // devnet-only / missing features are not usable
  assert.equal(usableStandard(W('Phantom', { chains: ['solana:devnet'] })), false);
  assert.equal(usableStandard(W('Phantom', { features: { 'standard:connect': {} } })), false);
  // nothing installed → 3 entries with install/browse links, nothing sendable
  const none = pickWallets([], {});
  assert.deepEqual(none.map((w) => [w.id, w.installed, w.canSend]), [['phantom', false, false], ['solflare', false, false], ['jupiter', false, false]]);
  // injected fallbacks: Phantom (request API) can send; Solflare injected-only is shown as installed but not sendable
  const inj = pickWallets([], { phantom: { solana: { isPhantom: true, request() {}, connect() {} } }, solflare: { isSolflare: true } });
  assert.deepEqual(inj.map((w) => [w.id, w.installed, w.canSend]), [['phantom', true, true], ['solflare', true, false], ['jupiter', false, false]]);
  assert.equal(WALLETS.length, 3);
});

test('deep links follow the documented browse formats; installs go to official sites', () => {
  const url = 'https://maxigems.fun/c/X/?tip=1', ref = 'https://maxigems.fun';
  const [ph, sf, jup] = WALLETS;
  assert.equal(ph.browse(url, ref), 'https://phantom.com/ul/browse/https%3A%2F%2Fmaxigems.fun%2Fc%2FX%2F%3Ftip%3D1?ref=https%3A%2F%2Fmaxigems.fun');
  assert.equal(sf.browse(url, ref), 'https://solflare.com/ul/v1/browse/https%3A%2F%2Fmaxigems.fun%2Fc%2FX%2F%3Ftip%3D1?ref=https%3A%2F%2Fmaxigems.fun');
  assert.equal(jup.browse, null); assert.equal(jup.mobile, 'https://jup.ag/mobile');
  assert.deepEqual(WALLETS.map((w) => w.install), ['https://phantom.com/download', 'https://solflare.com/download', 'https://jup.ag/wallet']);
  assert.deepEqual(WALLETS.map((w) => w.icon), ['/assets/wallets/phantom.png', '/assets/wallets/solflare.png', '/assets/wallets/jupiter.png']);
});

test('error messages: rejection, funds, expiry, RPC, unknown', () => {
  assert.equal(errorMessage({ code: 4001, message: 'User rejected the request.' }).kind, 'rejected');
  assert.equal(errorMessage(new Error('Transaction declined')).kind, 'rejected');
  assert.equal(errorMessage(new Error('insufficient funds')).kind, 'funds');
  assert.equal(errorMessage(new Error('Attempt to debit an account but found no record of a prior credit.')).kind, 'funds');
  assert.equal(errorMessage(new Error('block height exceeded')).kind, 'expired');
  assert.equal(errorMessage(new Error('rpc unavailable (rpc 429)')).kind, 'rpc');
  assert.equal(errorMessage(new TypeError('Failed to fetch')).kind, 'rpc');
  assert.equal(errorMessage(new Error('weird')).kind, 'other');
  assert.equal(errorMessage(undefined).kind, 'other');
});
