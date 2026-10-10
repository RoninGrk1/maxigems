// On-chain payment verification (pure). Input: a getTransaction result (encoding jsonParsed,
// maxSupportedTransactionVersion 0) + the order. Output: { ok:true, lamports, payer } or { ok:false, reason }.
// Rules: tx exists + succeeded; payer signed it and is the fee payer and the signed-in wallet; the order's reference
// pubkey is in the account keys; SystemProgram transfers payer → treasury sum to ≥ the order price; signature unused.
const SYSTEM = '11111111111111111111111111111111';

const keyOf = (k) => (typeof k === 'string' ? k : k && k.pubkey);

function transfersIn(tx) {
  const top = tx?.transaction?.message?.instructions ?? [];
  const inner = (tx?.meta?.innerInstructions ?? []).flatMap((x) => x?.instructions ?? []);
  return [...top, ...inner].filter((ix) => ix && ix.programId === SYSTEM && ix.parsed && (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferWithSeed'));
}

/**
 * @param tx getTransaction(jsonParsed) result or null
 * @param o { signature, treasury, wallet, reference, lamports (bigint|string), usedSignatures?: Set }
 */
export function verifyPayment(tx, o) {
  if (!tx) return { ok: false, reason: 'not_found', retry: true };
  if (!tx.meta) return { ok: false, reason: 'no_meta', retry: true };
  if (tx.meta.err) return { ok: false, reason: 'tx_failed' };
  if (o.usedSignatures && o.usedSignatures.has(o.signature)) return { ok: false, reason: 'signature_used' };
  const sigs = tx.transaction?.signatures ?? [];
  if (o.signature && sigs[0] !== o.signature) return { ok: false, reason: 'signature_mismatch' };
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const k0 = keys[0];
  const feePayer = keyOf(k0);
  const signers = keys.filter((k) => typeof k === 'object' && k.signer).map(keyOf);
  if (feePayer !== o.wallet || (signers.length && !signers.includes(o.wallet))) return { ok: false, reason: 'wrong_payer' };
  const all = new Set([...keys.map(keyOf), ...(tx.meta.loadedAddresses?.readonly ?? []), ...(tx.meta.loadedAddresses?.writable ?? [])]);
  if (!o.reference || !all.has(o.reference)) return { ok: false, reason: 'missing_reference' };
  let paid = 0n, toTreasury = 0;
  for (const ix of transfersIn(tx)) {
    const info = ix.parsed.info || {};
    if (info.destination !== o.treasury) continue;
    toTreasury++;
    if (info.source !== o.wallet) continue;
    paid += BigInt(info.lamports ?? 0);
  }
  if (!toTreasury) return { ok: false, reason: 'wrong_recipient' };
  if (paid < BigInt(o.lamports)) return { ok: false, reason: 'short_amount', paid: String(paid) };
  return { ok: true, lamports: String(paid), payer: o.wallet, blockTime: tx.blockTime ?? null, slot: tx.slot ?? null };
}

/** Human text for a failed verification. */
export const VERIFY_TEXT = {
  not_found: 'Payment not found on-chain yet — it can take a few seconds. We keep checking automatically.',
  no_meta: 'Payment not confirmed yet — we keep checking automatically.',
  tx_failed: 'That transaction failed on-chain, so nothing was paid.',
  signature_used: 'That transaction was already used for another order.',
  signature_mismatch: 'That signature doesn’t match the transaction.',
  wrong_payer: 'The payment must come from the wallet you signed in with.',
  missing_reference: 'That transaction isn’t linked to this order.',
  wrong_recipient: 'That transaction didn’t pay the MaxiGems treasury.',
  short_amount: 'The amount paid is less than the price of this order.',
};
