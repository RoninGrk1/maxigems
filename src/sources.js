// Candidate discovery + enrichment from FREE public APIs (no keys):
//  - DexScreener  https://api.dexscreener.com  (boosts latest/top, token profiles, tokens/v1 batch)
//  - GeckoTerminal https://api.geckoterminal.com/api/v2 (solana trending + new pools)
import { fetchJson, chunk, isSolAddress, log } from './util.js';

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const CHAIN = 'solana';

async function safe(name, fn) {
  try {
    const r = await fn();
    log(`source ${name}: ${r.length} solana tokens`);
    return r;
  } catch (e) {
    log(`WARN source ${name} failed: ${e.message}`);
    return [];
  }
}

const dsList = async (path) => {
  const d = await fetchJson(`${DS}${path}`);
  const arr = Array.isArray(d) ? d : [];
  return arr
    .filter((x) => x && x.chainId === CHAIN && isSolAddress(x.tokenAddress))
    .map((x) => ({ address: x.tokenAddress, boost: Number(x.totalAmount ?? x.amount ?? 0) || 0 }));
};

const gtList = async (path) => {
  const out = [];
  for (const page of [1, 2]) {
    const d = await fetchJson(`${GT}${path}${path.includes('?') ? '&' : '?'}page=${page}`, {
      headers: { accept: 'application/json;version=20230302' },
    });
    for (const p of d?.data ?? []) {
      const id = p?.relationships?.base_token?.data?.id ?? '';
      const addr = id.startsWith('solana_') ? id.slice(7) : null;
      if (isSolAddress(addr)) out.push({ address: addr, boost: 0 });
    }
  }
  return out;
};

/** Returns unique candidate token addresses with source tags. */
export async function discoverCandidates() {
  const lists = await Promise.all([
    safe('dexscreener:boosts-latest', () => dsList('/token-boosts/latest/v1')),
    safe('dexscreener:boosts-top', () => dsList('/token-boosts/top/v1')),
    safe('dexscreener:profiles-latest', () => dsList('/token-profiles/latest/v1')),
    safe('geckoterminal:trending', () => gtList('/networks/solana/trending_pools')),
    safe('geckoterminal:new', () => gtList('/networks/solana/new_pools')),
  ]);
  const map = new Map();
  for (const list of lists)
    for (const c of list) {
      const prev = map.get(c.address);
      map.set(c.address, { address: c.address, boost: Math.max(prev?.boost ?? 0, c.boost), hits: (prev?.hits ?? 0) + 1 });
    }
  return [...map.values()];
}

/**
 * Fetch DexScreener pairs for addresses (batches of 30, the API max) and return
 * Map<address, pairs[]> containing only Solana pairs where the token is the BASE token.
 */
export async function fetchPairs(addresses) {
  const out = new Map();
  for (const batch of chunk([...new Set(addresses)].filter(isSolAddress), 30)) {
    let pairs = [];
    try {
      const d = await fetchJson(`${DS}/tokens/v1/${CHAIN}/${batch.join(',')}`);
      pairs = Array.isArray(d) ? d : Array.isArray(d?.pairs) ? d.pairs : [];
    } catch (e) {
      log(`WARN dexscreener tokens batch failed: ${e.message}`);
      continue;
    }
    for (const p of pairs) {
      if (!p || p.chainId !== CHAIN) continue;
      const a = p.baseToken?.address;
      if (!batch.includes(a)) continue;
      if (!out.has(a)) out.set(a, []);
      out.get(a).push(p);
    }
  }
  return out;
}

/** Highest-liquidity pair; if preferPairAddress is given and still present, use that one (stable tracking). */
export function pickPair(pairs, preferPairAddress) {
  if (!pairs?.length) return null;
  if (preferPairAddress) {
    const same = pairs.find((p) => p.pairAddress === preferPairAddress);
    if (same) return same;
  }
  return pairs.reduce((b, p) => ((Number(p.liquidity?.usd) || 0) > (Number(b.liquidity?.usd) || 0) ? p : b));
}

/** GeckoTerminal multi-pool lookup (≤30 per call) → Map<pairAddress, {buyersH1, sellersH1, buysH1, sellsH1}>. Empty on failure. */
export async function fetchUniqueTraders(pairAddresses) {
  const out = new Map();
  for (const batch of chunk([...new Set(pairAddresses)].filter(isSolAddress), 30)) {
    try {
      const d = await fetchJson(`${GT}/networks/solana/pools/multi/${batch.join(',')}`, { headers: { accept: 'application/json;version=20230302' } });
      for (const p of d?.data ?? []) {
        const a = p?.attributes ?? {};
        const h1 = a.transactions?.h1 ?? {};
        if (a.address) out.set(a.address, { buyersH1: Number(h1.buyers) || 0, sellersH1: Number(h1.sellers) || 0, buysH1: Number(h1.buys) || 0, sellsH1: Number(h1.sells) || 0 });
      }
    } catch (e) {
      log(`WARN geckoterminal pools/multi failed: ${e.message}`);
    }
  }
  return out;
}
