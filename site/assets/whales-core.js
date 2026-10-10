/* MaxiGems Whale Watcher core — pure functions, no DOM, no network.
   Browser: window.MGWH (coin lookup). Engine + tests: evaluated in a vm (src/whales.js). */
(function (root) {
  'use strict';
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
  function isSol(a) { return typeof a === 'string' && SOL_RE.test(a); }

  /** base58 → Uint8Array (null on bad input). */
  function b58decode(s) {
    if (!isSol(s)) return null;
    var bytes = [0];
    for (var i = 0; i < s.length; i++) {
      var c = B58.indexOf(s.charAt(i)); if (c < 0) return null;
      for (var j = 0; j < bytes.length; j++) { c += bytes[j] * 58; bytes[j] = c & 0xff; c >>= 8; }
      while (c > 0) { bytes.push(c & 0xff); c >>= 8; }
    }
    for (var k = 0; k < s.length && s.charAt(k) === '1'; k++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  // ed25519 point decompression test: PDAs (program-derived addresses) are OFF the curve by construction,
  // so an off-curve owner is a program-owned account (pool vault, bonding curve, locker, escrow…), never a person.
  var P = (BigInt(1) << BigInt(255)) - BigInt(19);
  var D = (BigInt(-121665) * modpow(BigInt(121666), P - BigInt(2), P)) % P;
  function mod(a) { var r = a % P; return r < BigInt(0) ? r + P : r; }
  function modpow(b, e, m) {
    var r = BigInt(1); b = ((b % m) + m) % m;
    while (e > BigInt(0)) { if (e & BigInt(1)) r = (r * b) % m; b = (b * b) % m; e >>= BigInt(1); }
    return r;
  }
  function isOnCurve(addr) {
    var b = b58decode(addr); if (!b || b.length !== 32) return false;
    var y = BigInt(0);
    for (var i = 31; i >= 0; i--) y = (y << BigInt(8)) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
    if (y >= P) return false;
    var y2 = mod(y * y), u = mod(y2 - BigInt(1)), v = mod(D * y2 + BigInt(1));
    var v3 = mod(v * v * v), v7 = mod(v3 * v3 * v);
    var x = mod(u * v3 * modpow(mod(u * v7), (P - BigInt(5)) / BigInt(8), P));
    var vx2 = mod(v * x * x);
    if (vx2 === u || vx2 === mod(-u)) return true;
    return false;
  }

  /** Curated deny-list: burn/null addresses, launchpad fee wallets and well-known CEX hot wallets (best effort). */
  var DENY = {
    '1nc1nerator11111111111111111111111111111111': 'burn',
    '11111111111111111111111111111111': 'system',
    'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM': 'pump.fun fee',
    '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV': 'pump.fun fee',
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'cex: binance',
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhLu1HFp': 'cex: binance',
    '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'cex: binance',
    'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2': 'cex: bybit',
    'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'cex: coinbase',
    'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE': 'cex: coinbase',
    'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ': 'cex: mexc',
    '5PAhQiYdLBd6SVdjzBQDxUAEFyDdF5ExNPQfcscnPRj5': 'cex: mexc',
    'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w': 'cex: gate',
    'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5': 'cex: kraken',
    'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6': 'cex: kucoin',
    '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD': 'cex: okx',
    'is6MTRHEgyFLNTfYcuV4QBWLjrZBfmhVNYR6ccgr8KV': 'cex: okx'
  };
  var KNOWN_EXCLUDE = /AMM|LOCKER|POOL|CLOB|BURN|EXCHANGE|CEX|BRIDGE|PROGRAM|VAULT|MARKET|STAKE|ESCROW/i;

  /** Excluded addresses from a RugCheck report (pools, lockers, market accounts) + the pair itself. */
  function excludedFromReport(r, pairAddress) {
    var ex = {};
    var known = (r && r.knownAccounts) || {};
    Object.keys(known).forEach(function (k) { var t = (known[k] && (known[k].type + ' ' + (known[k].name || ''))) || ''; if (KNOWN_EXCLUDE.test(t)) ex[k] = 1; });
    ((r && r.markets) || []).forEach(function (m) {
      if (!m) return;
      ['pubkey', 'liquidityA', 'liquidityB', 'liquidityAAccount', 'liquidityBAccount'].forEach(function (k) {
        var v = m[k]; if (isSol(v)) ex[v] = 1; else if (v && isSol(v.owner)) ex[v.owner] = 1;
      });
    });
    if (r && r.lockers && typeof r.lockers === 'object') Object.keys(r.lockers).forEach(function (k) { ex[k] = 1; var o = r.lockers[k] && r.lockers[k].owner; if (isSol(o)) ex[o] = 1; });
    if (isSol(pairAddress)) ex[pairAddress] = 1;
    return ex;
  }

  /** Why a holder is excluded (string) or null if it's a real wallet. */
  function excludeReason(owner, account, ctx) {
    ctx = ctx || {};
    if (!isSol(owner)) return 'invalid';
    if (DENY[owner]) return DENY[owner];
    if (account && DENY[account]) return DENY[account];
    var ex = ctx.excluded || {};
    if (ex[owner] || (account && ex[account])) return 'pool/locker';
    if (ctx.mint && owner === ctx.mint) return 'mint';
    if (!isOnCurve(owner)) return 'program-owned';
    return null;
  }

  /**
   * RugCheck report → snapshot {supply, dec, creator, cut, accts:{tokenAccount:{o,a,ins}}} keeping real wallets only.
   * cut = smallest raw top-holder amount RugCheck listed (anyone absent held less than this).
   */
  function snapshotFromReport(r, opts) {
    opts = opts || {};
    if (!r || typeof r !== 'object' || !Array.isArray(r.topHolders)) return null;
    var tok = r.token || {};
    var dec = num(tok.decimals); var supplyRaw = num(tok.supply);
    var supply = supplyRaw !== null && dec !== null ? supplyRaw / Math.pow(10, dec) : null;
    var ctx = { excluded: excludedFromReport(r, opts.pairAddress), mint: r.mint || opts.mint };
    var accts = {}, cut = null, seenEx = {};
    r.topHolders.forEach(function (h) {
      if (!h) return;
      var a = num(h.uiAmount); if (a === null) { var raw = num(h.amount), d = num(h.decimals); a = raw !== null && d !== null ? raw / Math.pow(10, d) : null; }
      if (a === null) return;
      cut = cut === null ? a : Math.min(cut, a);
      var why = excludeReason(h.owner, h.address, ctx);
      if (why) { if (why === 'pool/locker' && isSol(h.owner)) seenEx[h.owner] = 1; return; }
      if (!isSol(h.address)) return;
      accts[h.address] = { o: h.owner, a: a, ins: h.insider === true ? 1 : 0 };
    });
    if (supply === null) { // derive from pct if supply missing
      r.topHolders.some(function (h) { var p = num(h && h.pct), a = num(h && h.uiAmount); if (p && a) { supply = a / (p / 100); return true; } return false; });
    }
    return { supply: supply, dec: dec, creator: isSol(r.creator) ? r.creator : null, cut: cut, ex: seenEx, accts: accts };
  }

  /** Sum token accounts per owner → [{o, a, pct, ins, dev}] sorted by amount desc. */
  function owners(snap) {
    if (!snap || !snap.accts) return [];
    var m = {};
    Object.keys(snap.accts).forEach(function (k) {
      var x = snap.accts[k]; if (!x || !isSol(x.o)) return;
      var e = m[x.o] || (m[x.o] = { o: x.o, a: 0, ins: 0, dev: 0 });
      e.a += num(x.a) || 0; if (x.ins) e.ins = 1;
    });
    var sup = num(snap.supply);
    return Object.keys(m).map(function (o) {
      var e = m[o]; e.dev = snap.creator && o === snap.creator ? 1 : 0;
      e.pct = sup ? (e.a / sup) * 100 : null; return e;
    }).filter(function (e) { return e.a > 0; }).sort(function (a, b) { return b.a - a.a; });
  }

  function top10Pct(list) { var s = 0, any = false; (list || []).slice(0, 10).forEach(function (e) { if (num(e.pct) !== null) { s += e.pct; any = true; } }); return any ? +s.toFixed(2) : null; }

  /**
   * Diff two owner lists of one coin. prevList/curList from owners(). Returns events
   * {k:'buy'|'sell'|'exit'|'new', o, d (tokens, >0), dp (% of supply), chg (% change of holding|null), hp (new % held), prevRank, rank, ins, dev, min}
   * 'new' uses the conservative minimum bought (holding − previous cut-off) and sets min=true.
   */
  function diff(prevList, curList, o) {
    o = o || {};
    var sup = num(o.supply), cut = num(o.prevCut) || 0;
    var dust = sup ? sup * 1e-6 : 1e-9; // < 0.0001% of supply counts as zero
    var P = {}, C = {}, ev = [];
    (prevList || []).forEach(function (e, i) { P[e.o] = { e: e, r: i + 1 }; });
    (curList || []).forEach(function (e, i) { C[e.o] = { e: e, r: i + 1 }; });
    function pc(t) { return sup ? (t / sup) * 100 : null; }
    Object.keys(P).forEach(function (ow) {
      var p = P[ow].e, c = C[ow] ? C[ow].e : null;
      // absent from the current list: exact balance if given, 0 when the caller re-read every tracked account (complete)
      var now = c ? c.a : (o.balances && num(o.balances[ow]) !== null ? num(o.balances[ow]) : o.complete ? 0 : null);
      if (now === null) return; // unknown current balance → no event (honest)
      var d = now - p.a;
      if (Math.abs(d) <= dust) return;
      var k = now <= dust ? 'exit' : d > 0 ? 'buy' : 'sell';
      ev.push({ k: k, o: ow, d: Math.abs(d), dp: pc(Math.abs(d)), chg: p.a > 0 ? (d / p.a) * 100 : null, hp: pc(Math.max(0, now)), ha: Math.max(0, now), prevRank: P[ow].r, rank: C[ow] ? C[ow].r : null, ins: (p.ins || (c && c.ins)) ? 1 : 0, dev: (p.dev || (c && c.dev)) ? 1 : 0, min: false });
    });
    Object.keys(C).forEach(function (ow) {
      if (P[ow]) return;
      var c = C[ow].e, d = c.a - cut;
      if (d <= dust) return;
      ev.push({ k: 'new', o: ow, d: d, dp: pc(d), chg: null, hp: pc(c.a), ha: c.a, prevRank: null, rank: C[ow].r, ins: c.ins ? 1 : 0, dev: c.dev ? 1 : 0, min: cut > 0 });
    });
    return ev;
  }

  /** Feed filter: notable moves only (small noise dropped). */
  function notable(e, usd, t) {
    t = t || {};
    if (usd !== null && usd < (t.feedFloorUsd != null ? t.feedFloorUsd : 100)) return false;
    return (num(e.dp) !== null && e.dp >= (t.feedMinPct != null ? t.feedMinPct : 0.1)) || (usd !== null && usd >= (t.feedMinUsd != null ? t.feedMinUsd : 2500));
  }

  /**
   * Alert test for one event. Big = ≥ minPct of supply AND ≥ minUsd ("whichever is larger").
   * Eligible wallets: top-N holder of the coin (before a sell/exit, after a buy/new) or a global top whale.
   * Insider/dev sells use the lower insider thresholds. Returns reason string or null.
   */
  function alertReason(e, usd, a, isTopWhale) {
    a = a || {};
    var minPct = a.minPct != null ? a.minPct : 1, minUsd = a.minUsd != null ? a.minUsd : 5000;
    var rankN = a.topHolderRank || 10;
    var dp = num(e.dp), u = num(usd);
    if (dp === null || u === null) return null;
    var selling = e.k === 'sell' || e.k === 'exit';
    if (selling && (e.ins || e.dev) && dp >= (a.insiderMinPct != null ? a.insiderMinPct : 0.25) && u >= (a.insiderMinUsd != null ? a.insiderMinUsd : 1000)) return e.dev ? 'dev-sell' : 'insider-sell';
    var rank = selling ? e.prevRank : e.rank;
    var eligible = (rank !== null && rank !== undefined && rank <= rankN) || !!isTopWhale;
    if (!eligible) return null;
    if (dp >= minPct && u >= minUsd) return selling ? 'big-' + e.k : 'big-buy';
    return null;
  }

  /**
   * Anti-spam caps. log = [{ca, t}] of alerts already posted. Returns {allowed:[ca], blocked:{ca: reason}}.
   * Max 1 per coin per cooldown window, max maxPerDay in any rolling 24h. coins = [{ca, score}] best first.
   */
  function applyCaps(coins, log, now, a) {
    a = a || {};
    var cool = (a.coinCooldownMinutes != null ? a.coinCooldownMinutes : 60) * 60000, maxDay = a.maxPerDay != null ? a.maxPerDay : 6;
    var recent = (log || []).filter(function (x) { return x && now - x.t < 86400000; });
    var used = recent.length, allowed = [], blocked = {};
    coins.forEach(function (c) {
      if (recent.some(function (x) { return x.ca === c.ca && now - x.t < cool; })) { blocked[c.ca] = 'coin cooldown'; return; }
      if (used >= maxDay) { blocked[c.ca] = 'daily cap'; return; }
      used++; allowed.push(c.ca);
    });
    return { allowed: allowed, blocked: blocked };
  }

  function shortAddr(a) { a = String(a || ''); return a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }

  root.MGWH = { isSol: isSol, b58decode: b58decode, isOnCurve: isOnCurve, DENY: DENY, excludedFromReport: excludedFromReport, excludeReason: excludeReason, snapshotFromReport: snapshotFromReport, owners: owners, top10Pct: top10Pct, diff: diff, notable: notable, alertReason: alertReason, applyCaps: applyCaps, shortAddr: shortAddr };
})(typeof window !== 'undefined' ? window : globalThis);
