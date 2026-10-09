/* MaxiGems leaderboard maths — pure functions, no DOM. Browser: window.MGLB. Node tests: evaluated in a vm. */
(function (root) {
  'use strict';
  var HOUR = 3600e3, DAY = 24 * HOUR;
  var PERIODS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity };
  var MILESTONES = [2, 5, 10];

  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
  function median(arr) {
    var a = (arr || []).map(num).filter(function (n) { return n !== null; }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function mean(arr) {
    var a = (arr || []).map(num).filter(function (n) { return n !== null; });
    if (!a.length) return null;
    return a.reduce(function (s, n) { return s + n; }, 0) / a.length;
  }
  /** Peak multiple since call; never below the current multiple, never below 1 (call price is the first datapoint). */
  function peakX(c) {
    var ath = num(c && c.athMultiple), cur = num(c && c.currentMultiple);
    var p = Math.max(ath !== null && ath > 0 ? ath : 0, cur !== null && cur > 0 ? cur : 0);
    return p > 0 ? Math.max(1, p) : 1;
  }
  /** 'live' | 'rugged' | 'pulled' (rugged with liquidity essentially gone). */
  function statusOf(c) {
    if (!c || c.status !== 'rugged') return 'live';
    var liq = num(c.currentLiquidity), base = num(c.liquidity);
    if (liq !== null && (liq < 1000 || (base !== null && base > 0 && liq < base * 0.05))) return 'pulled';
    return 'rugged';
  }
  function inPeriod(c, period, now) {
    var span = PERIODS[period] !== undefined ? PERIODS[period] : Infinity;
    if (span === Infinity) return true;
    var t = Date.parse(c && c.calledAt);
    return isFinite(t) && t <= now + 5 * 60e3 && now - t < span;
  }
  function filterPeriod(calls, period, now) {
    now = now === undefined ? Date.now() : now;
    return (calls || []).filter(function (c) { return inPeriod(c, period, now); });
  }
  function rate(n, total) { return total ? (n / total) * 100 : 0; }
  /** Stats over ALL calls in the set — rugged/pulled calls count toward totals and rates (honest track record). */
  function stats(calls) {
    calls = calls || [];
    var total = calls.length, peaks = calls.map(peakX);
    var hits = {};
    MILESTONES.forEach(function (m) {
      var n = peaks.filter(function (p) { return p >= m; }).length;
      hits[m] = { count: n, pct: rate(n, total) };
    });
    var rugs = calls.filter(function (c) { return statusOf(c) !== 'live'; }).length;
    var best = null;
    calls.forEach(function (c) { if (!best || peakX(c) > peakX(best)) best = c; });
    return {
      total: total, hits: hits,
      avgPeak: mean(peaks), medianPeak: median(peaks),
      best: best, bestPeak: best ? peakX(best) : null,
      rugs: { count: rugs, pct: rate(rugs, total) }
    };
  }
  var KEYS = {
    peak: function (c) { return peakX(c); },
    cur: function (c) { return num(c.currentMultiple); },
    called: function (c) { var t = Date.parse(c.calledAt); return isFinite(t) ? t : null; },
    mc: function (c) { return num(c.mcAtCall); },
    peakMc: function (c) { return num(c.athMc); },
    token: function (c) { return String(c.symbol || c.name || '').toLowerCase(); },
    status: function (c) { return { live: 0, rugged: 1, pulled: 2 }[statusOf(c)]; }
  };
  /** Stable sort; nulls always last. Default: peak desc, then earlier call first. */
  function sortCalls(calls, key, dir) {
    var f = KEYS[key] || KEYS.peak, d = dir === 'asc' ? 1 : -1;
    return (calls || []).map(function (c, i) { return { c: c, i: i, v: f(c) }; }).sort(function (a, b) {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      if (a.v < b.v) return -d;
      if (a.v > b.v) return d;
      return a.i - b.i;
    }).map(function (x) { return x.c; });
  }
  /** Rank by peak x desc (ties → earlier call wins). Returns new array of {rank, call}. */
  function ranked(calls) {
    var byTime = sortCalls(calls, 'called', 'asc');
    return sortCalls(byTime, 'peak', 'desc').map(function (c, i) { return { rank: i + 1, call: c }; });
  }
  function matches(c, q) {
    q = String(q || '').trim().toLowerCase().replace(/^\$/, '');
    if (!q) return true;
    return [c.name, c.symbol, c.address].some(function (s) { return String(s || '').toLowerCase().indexOf(q) !== -1; });
  }

  root.MGLB = { PERIODS: PERIODS, MILESTONES: MILESTONES, median: median, mean: mean, peakX: peakX, statusOf: statusOf, filterPeriod: filterPeriod, stats: stats, sortCalls: sortCalls, ranked: ranked, matches: matches };
})(typeof window !== 'undefined' ? window : globalThis);
