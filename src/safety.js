// On-chain safety checks from FREE keyless APIs.
//  - RugCheck  https://api.rugcheck.xyz/v1/tokens/{mint}/report   (primary: authorities, LP lock/burn, holders, insiders, risks)
//  - Solana public RPC getMultipleAccounts (cross-check of mint/freeze authority, one batched call)
// Fail CLOSED: if RugCheck can't be read for a token, that token is not called.
import { fetchJson, chunk, log } from './util.js';
import { analyzeReport } from '../supabase/functions/_shared/safety-rules.js';

const RC = 'https://api.rugcheck.xyz/v1/tokens';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export async function fetchRugcheck(mint) {
  return fetchJson(`${RC}/${mint}/report`, { retries: 2, timeoutMs: 20000 });
}

/** Batched mint/freeze authority lookup. Returns Map<mint, {mintAuthority, freezeAuthority}>; empty on failure. */
export async function rpcAuthorities(mints) {
  const out = new Map();
  for (const batch of chunk(mints, 100)) {
    try {
      const d = await fetchJson(RPC, {
        method: 'POST', retries: 1,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [batch, { encoding: 'jsonParsed' }] }),
      });
      (d?.result?.value ?? []).forEach((acc, i) => {
        const info = acc?.data?.parsed?.info;
        if (info) out.set(batch[i], { mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null });
      });
    } catch (e) {
      log(`WARN solana rpc cross-check failed: ${e.message}`);
    }
  }
  return out;
}

export { analyzeReport } from '../supabase/functions/_shared/safety-rules.js';

/** Check a list of {address, pairAddress}. Returns Map<address, {reasons, safety}>. Missing report ⇒ rejected (fail closed). */
export async function checkSafety(items, s) {
  const out = new Map();
  if (!items.length) return out;
  const rpc = await rpcAuthorities(items.map((i) => i.address));
  for (const it of items) {
    let report = null;
    try { report = await fetchRugcheck(it.address); } catch (e) { log(`WARN rugcheck ${it.address}: ${e.message}`); }
    if (!report) { out.set(it.address, { reasons: ['safety: rugcheck unavailable (fail closed)'], safety: null }); continue; }
    out.set(it.address, { ...analyzeReport(report, { pairAddress: it.pairAddress, rpc: rpc.get(it.address) }, s), report }); // report reused for the whale baseline
  }
  return out;
}
