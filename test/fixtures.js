const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
export function fakePair(o = {}) {
  return {
    chainId: 'solana', dexId: 'pumpswap', url: 'https://dexscreener.com/solana/x', pairAddress: '2h59QWesujZ6Tb8dWr9K6ruSjeLk7MRSovLQQVYjigdB',
    baseToken: { address: CA, name: 'Gem', symbol: 'GEM' }, priceUsd: '0.0002',
    txns: { h1: { buys: 300, sells: 150 }, h24: { buys: 2000, sells: 1500 } },
    volume: { h24: 400000, h6: 100000, h1: 60000 }, priceChange: { m5: 2, h1: 20, h6: 40, h24: 60 },
    liquidity: { usd: 50000 }, fdv: 250000, marketCap: 250000, pairCreatedAt: Date.now() - 5 * 3600000,
    info: { imageUrl: 'https://cdn.dexscreener.com/x.png', socials: [{ type: 'twitter', url: 'https://x.com/a' }] }, ...o,
  };
}

export const POOL = '2h59QWesujZ6Tb8dWr9K6ruSjeLk7MRSovLQQVYjigdB';
export function fakeReport(o = {}) {
  const holders = [
    { address: 'PoolVault1111111111111111111111111111111111', owner: POOL, pct: 60, insider: false },
    ...Array.from({ length: 12 }, (_, i) => ({ address: `H${i}`.padEnd(40, 'x'), owner: `O${i}`.padEnd(40, 'y'), pct: 2, insider: false })),
  ];
  return {
    mint: 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump', mintAuthority: null, freezeAuthority: null,
    token: { mintAuthority: null, freezeAuthority: null, supply: 1e15, decimals: 6 },
    creatorBalance: 0, totalHolders: 900, graphInsidersDetected: 0, rugged: false, transferFee: { pct: 0 },
    score_normalised: 1, risks: [{ name: 'Mutable metadata', level: 'warn' }],
    knownAccounts: { [POOL]: { name: 'Pump Fun AMM', type: 'AMM' } },
    markets: [{ pubkey: POOL, lp: { lpLockedPct: 100, quoteUSD: 20000 } }],
    topHolders: holders, ...o,
  };
}
