// Small helpers: safe numbers, HTML escaping, fetch with timeout/retry/rate-limit.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Coerce anything to a finite number or null (never NaN/Infinity). */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Escape for Telegram HTML parse_mode and for any HTML context. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip control chars / zero-width / RTL overrides and clamp length (token names are attacker-controlled). */
export function cleanText(s, max = 40) {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isSolAddress = (a) => typeof a === 'string' && SOL_ADDR.test(a);

/** Only allow http(s) URLs; returns null otherwise. */
export function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function fmtUsd(v) {
  const n = num(v);
  if (n === null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPrice(v) {
  const n = num(v);
  if (n === null || n <= 0) return '—';
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.01) return `$${n.toFixed(5)}`;
  // small prices: 0.0₅1234 style is unreadable in TG; use significant digits
  return `$${n.toPrecision(4)}`;
}

export function fmtPct(v) {
  const n = num(v);
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
}

export function fmtX(v) {
  const n = num(v);
  if (n === null) return '—';
  return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)}x`;
}

export function fmtAge(ms) {
  const n = num(ms);
  if (n === null || n < 0) return '—';
  const m = Math.floor(n / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export const log = (...a) => console.log(new Date().toISOString(), ...a);

// Per-host spacing so we stay well inside free rate limits
// (DexScreener: 60 rpm for profiles/boosts, 300 rpm for pairs/tokens; GeckoTerminal: ~30 rpm).
const lastHit = new Map();
const HOST_GAP_MS = { 'api.dexscreener.com': 1100, 'api.geckoterminal.com': 2500 };

export async function fetchJson(url, { retries = 2, timeoutMs = 15000, headers = {} } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Reserve the next free slot synchronously so concurrent callers queue instead of bursting.
    const gap = HOST_GAP_MS[host] ?? 500;
    const slot = Math.max(Date.now(), (lastHit.get(host) ?? 0) + gap);
    lastHit.set(host, slot);
    if (slot > Date.now()) await sleep(slot - Date.now());
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'user-agent': 'MaxiGemsBot/1.0', ...headers },
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = num(res.headers.get('retry-after'));
        const backoff = Math.min(ra !== null ? ra * 1000 : 2000 * 2 ** attempt, 30000);
        if (attempt < retries) { log(`WARN ${res.status} from ${host}, retry in ${backoff}ms`); await sleep(backoff); continue; }
        throw new Error(`HTTP ${res.status} ${url}`);
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}`);
        err.noRetry = true; // 4xx other than 429: retrying won't help
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e.noRetry || attempt >= retries) throw e;
      log(`WARN fetch failed (${e.message}), retrying`);
      await sleep(1500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`unreachable ${url}`);
}

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
