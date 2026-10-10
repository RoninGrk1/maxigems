// Pure payment helpers for the MGPay bundle (no DOM): Solana Pay-style transfer WITH a reference key, session storage
// and order validation. Bundled into site/assets/pay.js by scripts/build-pay.mjs; unit-tested in test/pay-core.test.js.
import {
  address, AccountRole, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction, compileTransaction, getTransactionEncoder, createNoopSigner, pipe,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { isPubkey } from './tip-core.js';

export const MAX_ORDER_LAMPORTS = 10n * 1000000000n; // hard client-side ceiling (largest real price is 4 SOL)
export const SESSION_KEY = 'mg.session.v1';

/**
 * Check a create-order response before asking the wallet to sign anything: the treasury must equal the address baked
 * into the bundle, the reference must be a 32-byte key and the amount must be positive and below the ceiling.
 */
export function checkOrder(o, treasury) {
  if (!o || typeof o !== 'object') throw new Error('Bad order from server.');
  if (!isPubkey(treasury) || o.treasury !== treasury) throw new Error('Payment address mismatch — payment blocked for your safety.');
  if (!isPubkey(o.reference) || o.reference === treasury) throw new Error('Bad order reference.');
  if (!/^\d{1,12}$/.test(String(o.lamports))) throw new Error('Bad order amount.');
  const lam = BigInt(o.lamports);
  if (lam <= 0n || lam > MAX_ORDER_LAMPORTS) throw new Error('Order amount out of range.');
  if (typeof o.orderId !== 'string' || !/^[0-9a-f-]{36}$/.test(o.orderId)) throw new Error('Bad order id.');
  return lam;
}

/**
 * Legacy tx: one SystemProgram.transfer(from → treasury, lamports) with the order's reference appended as a read-only,
 * non-signer account (Solana Pay convention, so the server can find the payment with getSignaturesForAddress).
 */
export function buildPayment({ from, treasury, lamports, reference, blockhash, lastValidBlockHeight }) {
  if (!isPubkey(from)) throw new Error('Wallet account is not a valid Solana address.');
  if (!isPubkey(treasury) || !isPubkey(reference)) throw new Error('Bad payment addresses.');
  if (from === treasury) throw new Error('That is the treasury wallet itself.');
  const lam = BigInt(lamports);
  if (lam <= 0n || lam > MAX_ORDER_LAMPORTS) throw new Error('Amount out of range.');
  if (!isPubkey(blockhash)) throw new Error('Bad blockhash from RPC.');
  const ix0 = getTransferSolInstruction({ source: createNoopSigner(address(from)), destination: address(treasury), amount: lam });
  const ix = { ...ix0, accounts: [...ix0.accounts, { address: address(reference), role: AccountRole.READONLY }] };
  const msg = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(address(from), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight ?? 0) }, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const tx = compileTransaction(msg);
  return { wire: new Uint8Array(getTransactionEncoder().encode(tx)), message: new Uint8Array(tx.messageBytes) };
}

/** Session = {token, wallet, expiresAt}. Returns null when missing/expired/malformed. */
export function readSession(raw, now = Date.now()) {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!s || typeof s.token !== 'string' || !isPubkey(s.wallet)) return null;
    const exp = Date.parse(s.expiresAt);
    if (!Number.isFinite(exp) || exp - 60000 <= now) return null;
    return { token: s.token, wallet: s.wallet, expiresAt: s.expiresAt };
  } catch { return null; }
}

/** Wallets that can sign the SIWS message (Wallet Standard solana:signMessage, or an injected signMessage). */
export function canSignMessage(w) {
  return !!(w && ((w.std && w.std.features && w.std.features['solana:signMessage']) || (w.injected && typeof w.injected.signMessage === 'function')));
}

/** Days-left label for the header badge. */
export function daysLabel(n) { return n > 1 ? `${n} days left` : n === 1 ? '1 day left' : 'Expired'; }
