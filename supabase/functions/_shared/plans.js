// MaxiGems Pro + Featured pricing. Single source of truth for the Edge Functions, the site bundle and tests.
// Pure JS (Node + Deno + browser). All money math is integer lamports (BigInt) — never floats.

export const LAMPORTS_PER_SOL = 1000000000n;
export const DAY_MS = 86400000;

/** Pro passes. Paying early stacks the days on top of the time left. */
export const PLANS = Object.freeze({
  p30: Object.freeze({ id: 'p30', days: 30, sol: '0.48', label: '30 days' }),
  p90: Object.freeze({ id: 'p90', days: 90, sol: '1.28', label: '90 days' }),
  p365: Object.freeze({ id: 'p365', days: 365, sol: '4', label: '365 days' }),
});

/** Featured listing: 24h at the top of Trending + one sponsored channel post. */
export const FEATURED = Object.freeze({ sol: '1', hours: 24, maxConcurrent: 3, maxPostsPerDay: 1 });

/** Mainnet-safe test price, only ever for an allow-listed wallet (TEST_WALLETS secret). */
export const TEST_SOL = '0.001';

/** Pending orders expire after this (the reference stops being accepted for NEW orders; a late payment is still swept). */
export const ORDER_TTL_MS = 20 * 60000;

const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddr = (s) => typeof s === 'string' && B58_RE.test(s);

/** "0.48" → 480000000n. Integer parsing only; null when invalid or > 9 decimals. */
export function solToLamports(input) {
  const s = String(input ?? '').trim();
  const m = /^(\d{1,9})(?:\.(\d{1,9}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * LAMPORTS_PER_SOL + BigInt((m[2] || '').padEnd(9, '0'));
}

/** 480000000n → "0.48" */
export function lamportsToSol(l) {
  const v = BigInt(l);
  const w = v / LAMPORTS_PER_SOL;
  const f = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

/** Parse a comma/space separated wallet allow-list. */
export function parseWalletList(s) {
  return String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(isAddr);
}

/**
 * Price an order. Returns { ok, lamports, sol, days?, hours?, test } or { ok:false, status, error }.
 *  - payments disabled → refused (403) unless the wallet is on the test allow-list (then 0.001 SOL)
 *  - test wallets always pay the tiny test price, so nobody on the list can be charged a real price by mistake
 */
/** @param {{kind:string, plan?:string, wallet:string, paymentsEnabled?:boolean, testWallets?:string[]}} o */
export function priceOrder({ kind, plan, wallet, paymentsEnabled = false, testWallets = [] }) {
  const test = isAddr(wallet) && testWallets.includes(wallet);
  if (!paymentsEnabled && !test) return { ok: false, status: 403, error: 'Payments are not open yet — coming soon.' };
  let base;
  if (kind === 'pro') {
    const p = PLANS[plan];
    if (!p) return { ok: false, status: 400, error: 'Unknown plan.' };
    base = { days: p.days, plan: p.id, sol: p.sol };
  } else if (kind === 'featured') {
    base = { hours: FEATURED.hours, plan: 'featured', sol: FEATURED.sol };
  } else return { ok: false, status: 400, error: 'Unknown order type.' };
  const sol = test ? TEST_SOL : base.sol;
  return { ok: true, ...base, sol, lamports: solToLamports(sol), test };
}

/** Public plan list for the UI (strings only). */
export function publicPlans() {
  return {
    plans: Object.values(PLANS).map((p) => ({ id: p.id, days: p.days, sol: p.sol, lamports: String(solToLamports(p.sol)) })),
    featured: { sol: FEATURED.sol, hours: FEATURED.hours, lamports: String(solToLamports(FEATURED.sol)) },
  };
}

/** New expiry: paying early stacks on top of the time left; an expired/absent pass starts from now. */
export function stackExpiry(currentExpiresAt, days, now = Date.now()) {
  const cur = currentExpiresAt ? Date.parse(currentExpiresAt) : NaN;
  const base = Number.isFinite(cur) && cur > now ? cur : now;
  return new Date(base + days * DAY_MS).toISOString();
}

/** Days left (ceil), 0 when expired. */
export function daysLeft(expiresAt, now = Date.now()) {
  const t = Date.parse(expiresAt || '');
  if (!Number.isFinite(t) || t <= now) return 0;
  return Math.ceil((t - now) / DAY_MS);
}

/** Gate for Pro-only endpoints: 401 without a valid session, 402 without an active pass. */
export function gate(session, sub, now = Date.now()) {
  if (!session || !isAddr(session.wallet)) return { status: 401, error: 'Sign in with your wallet.' };
  if (!sub || sub.wallet !== session.wallet || daysLeft(sub.expires_at, now) <= 0) return { status: 402, error: 'MaxiGems Pro required.', expired: !!sub };
  return { status: 200, expiresAt: sub.expires_at, daysLeft: daysLeft(sub.expires_at, now) };
}
