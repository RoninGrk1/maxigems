// Pure tip logic (no DOM): amounts, recipient validation, tx building, wallet filtering, error mapping.
// Bundled into site/assets/tip-wallet.js by scripts/build-tip.mjs and unit-tested in test/tip-wallet.test.js.
import {
  address, getAddressEncoder, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction, compileTransaction, getTransactionEncoder, getBase58Decoder, createNoopSigner, pipe,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

export const LAMPORTS_PER_SOL = 1000000000n;
export const MIN_SOL = '0.001';
export const MAX_SOL = '100';
export const AMOUNTS = ['0.05', '0.1', '0.5'];
export const FEE_BUFFER = 10000n; // base fee (5000) + headroom; priority fee is the wallet's call
export const CHAIN = 'solana:mainnet';
export const RPCS = ['https://solana-rpc.publicnode.com', 'https://public.rpc.solanavibestation.com', 'https://rpc.solanatracker.io/public'];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** True only for a base58 string that decodes to exactly 32 bytes. */
export function isPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
  let len = 0; while (n > 0n) { len++; n >>= 8n; }
  for (const c of s) { if (c !== '1') break; len++; }
  return len === 32;
}

/** "0.1" → 100000000n. Integer math only; null when invalid, out of range or >9 decimals. */
export function solToLamports(input) {
  const s = String(input ?? '').trim().replace(',', '.');
  const m = /^(\d{1,9})(?:\.(\d{0,9}))?$/.exec(s) || /^()\.(\d{1,9})$/.exec(s);
  if (!m) return null;
  const lam = BigInt(m[1] || '0') * LAMPORTS_PER_SOL + BigInt((m[2] || '').padEnd(9, '0') || '0');
  return lam;
}
export const MIN_LAMPORTS = solToLamports(MIN_SOL);
export const MAX_LAMPORTS = solToLamports(MAX_SOL);

/** Validation message for a typed amount ('' when ok). */
export function amountError(input) {
  const lam = solToLamports(input);
  if (lam === null) return 'Enter an amount like 0.1 (max 9 decimals).';
  if (lam < MIN_LAMPORTS) return `Minimum tip is ${MIN_SOL} SOL.`;
  if (lam > MAX_LAMPORTS) return `Maximum tip is ${MAX_SOL} SOL.`;
  return '';
}

/** 100000000n → "0.1" */
export function lamportsToSol(l) {
  const v = BigInt(l); const w = v / LAMPORTS_PER_SOL; const f = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

/**
 * Legacy transaction with exactly one SystemProgram.transfer(from → to, lamports), fee payer = from.
 * Returns wire bytes (signature slot zeroed) for the wallet's signAndSendTransaction, plus the message bytes.
 */
export function buildTransfer({ from, to, lamports, blockhash, lastValidBlockHeight, recipient }) {
  if (!isPubkey(to) || (recipient !== undefined && to !== recipient)) throw new Error('Tip recipient failed validation.');
  if (!isPubkey(from)) throw new Error('Wallet account is not a valid Solana address.');
  if (from === to) throw new Error('That is the tip wallet itself.');
  const lam = BigInt(lamports);
  if (lam < MIN_LAMPORTS || lam > MAX_LAMPORTS) throw new Error('Amount out of range.');
  if (!isPubkey(blockhash)) throw new Error('Bad blockhash from RPC.');
  const src = createNoopSigner(address(from));
  const ix = getTransferSolInstruction({ source: src, destination: address(to), amount: lam });
  const msg = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(address(from), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight ?? 0) }, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const tx = compileTransaction(msg);
  return { wire: new Uint8Array(getTransactionEncoder().encode(tx)), message: new Uint8Array(tx.messageBytes) };
}

export const b58 = (bytes) => getBase58Decoder().decode(bytes);
export const addrBytes = (a) => new Uint8Array(getAddressEncoder().encode(address(a)));

/** The three supported wallets, in display order. */
export const WALLETS = [
  { id: 'phantom', name: 'Phantom', re: /^phantom\b/i, icon: '/assets/wallets/phantom.png', install: 'https://phantom.com/download',
    browse: (url, ref) => `https://phantom.com/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}` },
  { id: 'solflare', name: 'Solflare', re: /^solflare\b/i, icon: '/assets/wallets/solflare.png', install: 'https://solflare.com/download',
    browse: (url, ref) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}` },
  { id: 'jupiter', name: 'Jupiter', re: /^jupiter\b/i, icon: '/assets/wallets/jupiter.png', install: 'https://jup.ag/wallet', mobile: 'https://jup.ag/mobile', browse: null },
];

const hasFeat = (w, f) => !!(w && w.features && w.features[f]);
/** Wallet Standard wallets usable for a tip: allowed name, mainnet, connect + signAndSendTransaction. */
export function usableStandard(w) {
  return !!w && typeof w.name === 'string' && hasFeat(w, 'standard:connect') && hasFeat(w, 'solana:signAndSendTransaction')
    && Array.isArray(w.chains) && w.chains.includes(CHAIN);
}
/**
 * Merge Wallet Standard wallets + injected providers into exactly the 3 allowed entries.
 * Each: {id,name,icon,install,browse,mobile, std: standard wallet|null, injected: provider|null, installed}
 */
export function pickWallets(standard = [], win = {}) {
  return WALLETS.map((d) => {
    const std = (standard || []).find((w) => usableStandard(w) && d.re.test(w.name.trim())) || null;
    let injected = null;
    if (d.id === 'phantom' && win.phantom && win.phantom.solana && win.phantom.solana.isPhantom) injected = win.phantom.solana;
    if (d.id === 'solflare' && win.solflare && win.solflare.isSolflare) injected = win.solflare;
    if (d.id === 'jupiter' && win.jupiter && win.jupiter.solana) injected = win.jupiter.solana;
    return { ...d, std, injected, installed: !!(std || injected), canSend: !!std || (d.id === 'phantom' && !!injected && typeof injected.request === 'function') };
  });
}

/** Human message for wallet / RPC errors. */
export function errorMessage(e) {
  const msg = String((e && (e.message || e.error?.message)) || e || '');
  const code = e && (e.code ?? e.error?.code);
  if (code === 4001 || /reject|denied|declin|cancel|closed|aborted by user/i.test(msg)) return { kind: 'rejected', text: 'Cancelled in your wallet — nothing was sent.' };
  if (/insufficient|not enough|0x1\b|debit an account|no record of a prior credit/i.test(msg)) return { kind: 'funds', text: 'Not enough SOL in this wallet for the tip plus the network fee.' };
  if (/blockhash|expired|block height exceeded/i.test(msg)) return { kind: 'expired', text: 'The transaction expired before it landed. Nothing was charged — try again.' };
  if (/rpc|fetch|network|failed to fetch|timeout|429|503|502/i.test(msg)) return { kind: 'rpc', text: 'Couldn’t reach the Solana network right now. Try again in a minute.' };
  return { kind: 'other', text: msg ? `Wallet error: ${msg.slice(0, 140)}` : 'Something went wrong. Nothing was sent.' };
}
