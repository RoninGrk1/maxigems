/* MaxiGems Trending Radar — pure data helpers (no DOM). Used by trending.js in the browser and by unit tests in Node.
   Everything coming from APIs / JSON is treated as untrusted: numbers coerced, text cleaned, addresses validated. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.MGRadar = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var IMG_RE = /^https:\/\/(cdn\.dexscreener\.com|dd\.dexscreener\.com|assets\.geckoterminal\.com|coin-images\.coingecko\.com)\//;
  var SLUR_RE = /n[i1!]gg|f[a@]gg[o0]t|\bk[i1]ke\b/i; // never show hate-speech token names on the site
  var GRAD_DEXES = { pumpswap: 1, raydium: 1 };
  var GRAD_MAX_AGE_MS = 24 * 3600000;

  function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; var n = typeof v === 'number' ? v : Number(v); return isFinite(n) ? n : null; }
  function clean(s, max) { s = typeof s === 'string' ? s : typeof s === 'number' && isFinite(s) ? String(s) : ''; s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
  function isSol(a) { return typeof a === 'string' && SOL_RE.test(a); }
  function img(u) { if (typeof u !== 'string' || !IMG_RE.test(u)) return null; try { var x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; } }
  function dexId(d) { return String(d == null ? '' : d).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20); }
  function clamp(x) { return Math.max(0, Math.min(1, x)); }
  function obj(o) { return o && typeof o === 'object' ? o : {}; }

  /** Momentum heat 0–100 (same formula as src/radar.js). */
  function heat(t) {
    var v = obj(t.vol), h1 = obj(obj(t.txns).h1);
    var v5 = num(v.m5) || 0, v1 = num(v.h1) || 0, v24 = num(v.h24) || 0, b1 = num(h1.b) || 0, s1 = num(h1.s) || 0;
    var acc5 = clamp((v5 * 12) / Math.max(v1, 1) / 3);
    var acc1 = clamp((v1 * 24) / Math.max(v24, 1) / 4);
    var buys = clamp(Math.log10(Math.max(b1, 1)) / 3);
    var share = b1 + s1 > 0 ? clamp((b1 / (b1 + s1) - 0.4) / 0.3) : 0;
    var depth = clamp((Math.log10(Math.max(v1, 1)) - 3) / 3);
    return Math.round((acc5 * 0.25 + acc1 * 0.25 + buys * 0.2 + share * 0.15 + depth * 0.15) * 100);
  }

  function finish(r) {
    if (!r.name) r.name = r.symbol || 'Unknown';
    if (!r.symbol) r.symbol = '???';
    if (SLUR_RE.test(r.name) || SLUR_RE.test(r.symbol)) return null;
    r.heat = heat(r);
    return r;
  }

  /** DexScreener pair → row. */
  function fromPair(p) {
    p = obj(p);
    var bt = obj(p.baseToken);
    if (p.chainId !== 'solana' || !isSol(bt.address)) return null;
    var t = obj(p.txns), v = obj(p.volume), ch = obj(p.priceChange);
    return finish({
      address: bt.address, pairAddress: isSol(p.pairAddress) ? p.pairAddress : null,
      name: clean(bt.name, 40), symbol: clean(bt.symbol, 16).replace(/^\$/, ''), dex: dexId(p.dexId),
      imageUrl: img(obj(p.info).imageUrl), pairCreatedAt: num(p.pairCreatedAt),
      mc: num(p.marketCap) != null ? num(p.marketCap) : num(p.fdv), liq: num(obj(p.liquidity).usd),
      ch: { m5: num(ch.m5), h1: num(ch.h1), h24: num(ch.h24) },
      vol: { m5: num(v.m5), h1: num(v.h1), h24: num(v.h24) },
      txns: { m5: { b: num(obj(t.m5).buys) || 0, s: num(obj(t.m5).sells) || 0 }, h1: { b: num(obj(t.h1).buys) || 0, s: num(obj(t.h1).sells) || 0 } }
    });
  }

  /** Row from site/data/trending.json (already compact, but still untrusted). */
  function fromSnapshot(r) {
    r = obj(r);
    if (!isSol(r.address)) return null;
    var ch = obj(r.ch), v = obj(r.vol), t = obj(r.txns), m5 = obj(t.m5), h1 = obj(t.h1);
    return finish({
      address: r.address, pairAddress: isSol(r.pairAddress) ? r.pairAddress : null,
      name: clean(r.name, 40), symbol: clean(r.symbol, 16).replace(/^\$/, ''), dex: dexId(r.dex),
      imageUrl: img(r.imageUrl), pairCreatedAt: num(r.pairCreatedAt), mc: num(r.mc), liq: num(r.liq),
      ch: { m5: num(ch.m5), h1: num(ch.h1), h24: num(ch.h24) },
      vol: { m5: num(v.m5), h1: num(v.h1), h24: num(v.h24) },
      txns: { m5: { b: num(m5.b) || 0, s: num(m5.s) || 0 }, h1: { b: num(h1.b) || 0, s: num(h1.s) || 0 } }
    });
  }

  /** Item from site/data/watchlist.json. */
  function fromWatch(w) {
    w = obj(w);
    if (!isSol(w.address)) return null;
    var ch = obj(w.ch), s = w.safety && typeof w.safety === 'object' ? w.safety : null;
    var r = finish({
      address: w.address, pairAddress: isSol(w.pairAddress) ? w.pairAddress : null,
      name: clean(w.name, 40), symbol: clean(w.symbol, 16).replace(/^\$/, ''), dex: dexId(w.dex),
      imageUrl: img(w.imageUrl), pairCreatedAt: null,
      mc: num(w.mc), liq: num(w.liq), ch: { m5: num(ch.m5), h1: num(ch.h1), h24: num(ch.h24) },
      vol: { m5: null, h1: num(w.vol1h), h24: null },
      txns: { m5: { b: 0, s: 0 }, h1: { b: num(w.buysH1) || 0, s: num(w.sellsH1) || 0 } }
    });
    if (!r) return null;
    r.ageMin = num(w.ageMin);
    r.score = num(w.score);
    r.reason = clean(w.reasonText || w.reason, 70) || 'Near miss';
    r.otherReasons = Array.isArray(w.otherReasons) ? w.otherReasons.slice(0, 3).map(function (x) { return clean(x, 70); }).filter(Boolean) : [];
    r.uniqueBuyersH1 = num(w.uniqueBuyersH1);
    r.safety = s ? { mint: s.mint === true, freeze: s.freeze === true, lp: num(s.lp), top10: num(s.top10), holders: num(s.holders) } : null;
    return r;
  }

  /** Overlay live market fields (from a fresh pair row) onto a watch item, keeping its score/reason/safety. */
  function overlay(w, live) {
    if (!live) return w;
    var out = {}; for (var k in w) out[k] = w[k];
    ['pairAddress', 'imageUrl', 'pairCreatedAt', 'mc', 'liq', 'ch', 'vol', 'txns', 'heat', 'dex'].forEach(function (k) { if (live[k] != null) out[k] = live[k]; });
    if (!out.imageUrl) out.imageUrl = w.imageUrl;
    out.live = true;
    return out;
  }

  function ageMs(r, now) { if (r.pairCreatedAt) return Math.max(0, now - r.pairCreatedAt); if (r.ageMin != null) return r.ageMin * 60000; return null; }

  function isGraduate(r, now) {
    return !!r && GRAD_DEXES[r.dex] === 1 && /pump$/.test(r.address) && !!r.pairCreatedAt && now - r.pairCreatedAt >= 0 && now - r.pairCreatedAt < GRAD_MAX_AGE_MS;
  }
  function isHot(r) { return (r.liq || 0) >= 3000 && ((r.vol && r.vol.h1) || 0) >= 1000; }

  /** Pick highest-liquidity Solana pair per base token. pairs: DexScreener tokens/v1 response(s). */
  function bestPairs(pairs) {
    var best = {};
    (Array.isArray(pairs) ? pairs : []).forEach(function (p) {
      var r = fromPair(p); if (!r) return;
      var prev = best[r.address];
      if (!prev || (r.liq || 0) > (prev.liq || 0)) best[r.address] = r;
    });
    return best;
  }

  /** GeckoTerminal pools response → [{address, dex, createdAt}] */
  function gtPools(d) {
    var out = [];
    (d && Array.isArray(d.data) ? d.data : []).forEach(function (p) {
      var rel = obj(obj(p).relationships), id = String(obj(obj(rel.base_token).data).id || '');
      var a = id.indexOf('solana_') === 0 ? id.slice(7) : null;
      if (isSol(a)) out.push({ address: a, dex: dexId(obj(obj(rel.dex).data).id), createdAt: Date.parse(obj(obj(p).attributes).pool_created_at) || null });
    });
    return out;
  }
  /** DexScreener boosts response → [address] (solana only) */
  function dsBoosts(d) {
    var out = [];
    (Array.isArray(d) ? d : []).forEach(function (x) { x = obj(x); if (x.chainId === 'solana' && isSol(x.tokenAddress)) out.push(x.tokenAddress); });
    return out;
  }

  var SORTS = {
    heat: function (r) { return r.heat || 0; },
    score: function (r) { return r.score != null ? r.score : -1; },
    newest: function (r) { return r.pairCreatedAt || (r.ageMin != null ? -r.ageMin : -1e15); },
    mc: function (r) { return r.mc || 0; },
    liq: function (r) { return r.liq || 0; },
    vol: function (r) { return (r.vol && r.vol.h1) || 0; },
    m5: function (r) { return r.ch && r.ch.m5 != null ? r.ch.m5 : -1e9; },
    h1: function (r) { return r.ch && r.ch.h1 != null ? r.ch.h1 : -1e9; },
    buys: function (r) { return (r.txns && r.txns.h1.b) || 0; }
  };
  function sortRows(rows, key) { var f = SORTS[key] || SORTS.heat; return rows.slice().sort(function (a, b) { return f(b) - f(a); }); }
  function search(rows, q) {
    q = String(q || '').trim().toLowerCase().replace(/^\$/, '');
    if (!q) return rows;
    return rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0 || r.symbol.toLowerCase().indexOf(q) >= 0 || r.address.toLowerCase().indexOf(q) === 0; });
  }

  return { SOL_RE: SOL_RE, num: num, clean: clean, isSol: isSol, img: img, heat: heat, fromPair: fromPair, fromSnapshot: fromSnapshot, fromWatch: fromWatch, overlay: overlay, ageMs: ageMs, isGraduate: isGraduate, isHot: isHot, bestPairs: bestPairs, gtPools: gtPools, dsBoosts: dsBoosts, sortRows: sortRows, search: search };
});
