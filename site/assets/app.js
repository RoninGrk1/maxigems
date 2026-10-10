/* MaxiGems live feed — no frameworks, no innerHTML with data (XSS-safe). */
(function () {
  'use strict';
  var CFG = Object.assign({ xUrl: 'https://x.com/maxigems_sol', chatUrl: 'https://t.me/MGcalls_gc', telegramUrl: 'https://t.me/maxigems_calls', dataUrl: 'data/calls.json', refreshSeconds: 60 }, window.MAXIGEMS_CONFIG || {});
  var $ = function (id) { return document.getElementById(id); };
  var SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var DEX_NAMES = { pumpswap: 'PumpSwap', pumpfun: 'Pump.fun', raydium: 'Raydium', meteora: 'Meteora', meteoradbc: 'Meteora DBC', launchlab: 'LaunchLab', orca: 'Orca' };
  var DEX_CHIPS = [['all', 'All'], ['pumpswap', 'PumpSwap'], ['pumpfun', 'Pump.fun'], ['raydium', 'Raydium'], ['meteora', 'Meteora'], ['other', 'Other']];
  var state = { calls: [], q: '', dex: 'all', sort: 'new', seen: {}, first: true, lastOk: null };

  // ---------- safe helpers ----------
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
  function safeHttpUrl(u) { try { var x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; } }
  function telegramHref(u) { var s = safeHttpUrl(u); return s && /^https:\/\/(t\.me|telegram\.me)\//.test(s) ? s : 'https://t.me/maxigems_calls'; }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function usd(v) {
    var n = num(v); if (n === null) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  }
  function pct(v) { var n = num(v); if (n === null) return '—'; return (n > 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 100 ? 0 : 1) + '%'; }
  function xf(v) { var n = num(v); if (n === null || n <= 0) return '—'; return (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + 'x'; }
  function ago(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '—';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function clean(s, max) { s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
  function dexName(d) { return DEX_NAMES[d] || (d ? d.charAt(0).toUpperCase() + d.slice(1) : 'DEX'); }
  function dexGroup(d) { return d === 'meteoradbc' ? 'meteora' : (DEX_NAMES[d] && ['pumpswap', 'pumpfun', 'raydium', 'meteora'].indexOf(d) >= 0 ? d : 'other'); }

  // Links are rebuilt from the validated address — never trusted from data.
  function links(ca, pair) {
    var p = SOL_RE.test(pair || '') ? pair : ca;
    return {
      dexscreener: 'https://dexscreener.com/solana/' + p,
      solscan: 'https://solscan.io/token/' + ca,
      jupiter: 'https://jup.ag/swap/SOL-' + ca,
      birdeye: 'https://birdeye.so/token/' + ca + '?chain=solana'
    };
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || !SOL_RE.test(raw.address || '')) return null;
    var priceAtCall = num(raw.priceAtCall);
    var ath = num(raw.athMultiple), cur = num(raw.currentMultiple);
    return {
      address: raw.address,
      pairAddress: raw.pairAddress,
      name: clean(raw.name, 40) || clean(raw.symbol, 20) || 'Unknown',
      symbol: clean(raw.symbol, 16).replace(/^\$/, '') || '???',
      dex: String(raw.dex || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
      img: raw.imageUrl && /^https:\/\/(cdn\.dexscreener\.com|dd\.dexscreener\.com|assets\.geckoterminal\.com|coin-images\.coingecko\.com)\//.test(raw.imageUrl) ? safeHttpUrl(raw.imageUrl) : null,
      calledAt: raw.calledAt,
      calledTs: Date.parse(raw.calledAt) || 0,
      score: num(raw.score),
      mcAtCall: num(raw.mcAtCall), currentMc: num(raw.currentMc), athMc: num(raw.athMc),
      liq: num(raw.currentLiquidity) != null ? num(raw.currentLiquidity) : num(raw.liquidity),
      vol: num(raw.volume24h),
      ch1: raw.change ? num(raw.change.h1) : null,
      priceAtCall: priceAtCall,
      ath: ath != null && ath > 0 ? ath : 1,
      cur: cur != null && cur > 0 ? cur : null,
      rugged: raw.status === 'rugged',
      safety: raw.safety && typeof raw.safety === 'object' ? {
        mint: raw.safety.mint === true, freeze: raw.safety.freeze === true,
        lp: num(raw.safety.lp), top10: num(raw.safety.top10)
      } : null
    };
  }

  // ---------- render ----------
  var SOL_SVG = '<svg viewBox="0 0 397 311" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs><path fill="url(#sg)" d="M64 237a13 13 0 0 1 9-4h317c6 0 9 7 5 11l-62 63a13 13 0 0 1-9 4H7c-6 0-9-7-5-11zM64 4a13 13 0 0 1 9-4h317c6 0 9 7 5 11l-62 63a13 13 0 0 1-9 4H7c-6 0-9-7-5-11zm269 116a13 13 0 0 0-9-4H7c-6 0-9 7-5 11l62 63a13 13 0 0 0 9 4h317c6 0 9-7 5-11z"/></svg>';
  var solN = 0;
  function solBadge() { var b = h('span', { class: 'badge sol', title: 'Solana' }); b.innerHTML = SOL_SVG.replace(/\bsg\b/g, 'sg' + (++solN)); /* unique gradient id per badge */ b.appendChild(document.createTextNode('Solana')); return b; } // static markup only

  function avatar(c) { return MG.avatar(c.img, c.symbol, 46); }

  function safetyRow(s) {
    if (!s) return null;
    function pc(v) { return v == null ? '?' : Math.round(v) + '%'; }
    function item(label, ok, val) { return h('span', { class: 'sf ' + (ok ? 'ok' : 'bad') }, [label + ' ', h('b', { text: val })]); }
    return h('div', { class: 'safety', 'aria-label': 'On-chain safety at call time' }, [
      h('span', { class: 'sf-t', text: '🛡' }),
      item('Mint', s.mint, s.mint ? '✅' : '❌'),
      item('Freeze', s.freeze, s.freeze ? '✅' : '❌'),
      item('LP 🔥', s.lp != null && s.lp >= 90, pc(s.lp)),
      item('Top10', s.top10 != null && s.top10 <= 30, pc(s.top10))
    ]);
  }

  function card(c) {
    var L = links(c.address, c.pairAddress);
    var cls = c.rugged ? 'down' : c.ath >= 1.5 ? 'up' : c.cur != null && c.cur < 0.7 ? 'down' : 'flat';
    var copyBtn = h('button', { class: 'copy', type: 'button', 'aria-label': 'Copy contract address of ' + c.symbol, text: 'Copy CA' });
    copyBtn.addEventListener('click', function () { copy(c.address, copyBtn); });
    var el = h('article', { class: 'card' + (!state.first && !state.seen[c.address + c.calledAt] ? ' new' : ''), 'aria-label': c.name + ' call' }, [
      h('div', { class: 'top' }, [
        avatar(c),
        h('div', { class: 'ttl' }, [
          h('div', { class: 'nm', title: c.name, text: c.name }),
          h('div', { class: 'sym' }, [h('span', { text: '$' + c.symbol }), solBadge(), h('span', { class: 'badge dex', text: dexName(c.dex) }), c.rugged ? h('span', { class: 'badge rug', title: 'Price down 80%+ or liquidity down 70%+ since call', text: 'Rugged' }) : null])
        ]),
        h('div', { class: 'xbox' }, [h('div', { class: 'x ' + cls, text: xf(c.ath) }), h('div', { class: 'xl', text: 'peak since call' })])
      ]),
      h('div', { class: 'kv' }, [
        h('div', null, [h('span', { text: 'MC at call' }), h('b', { text: usd(c.mcAtCall) })]),
        h('div', null, [h('span', { text: 'MC now · ' + xf(c.cur) }), h('b', { class: c.cur == null ? '' : c.cur >= 1 ? 'pos' : 'neg', text: usd(c.currentMc) })]),
        h('div', null, [h('span', { text: 'Liquidity' }), h('b', { text: usd(c.liq) })]),
        h('div', null, [h('span', { text: 'Vol 24h · 1h chg' }), h('b', null, [usd(c.vol) + ' · ', h('span', { class: (c.ch1 || 0) >= 0 ? 'pos' : 'neg', text: pct(c.ch1) })])])
      ]),
      safetyRow(c.safety),
      h('div', { class: 'ca' }, [h('code', { title: c.address, text: c.address }), copyBtn]),
      h('div', { class: 'foot' }, [
        h('span', { class: 'ago' }, [h('time', { datetime: c.calledAt, 'data-ago': c.calledAt, text: 'Called ' + ago(c.calledAt) }), c.score != null ? ' · Score ' + c.score : '']),
        h('div', { class: 'lnk' }, [
          h('a', { class: 'pri', href: L.dexscreener, target: '_blank', rel: 'noopener noreferrer', text: 'DexScreener' }),
          h('a', { href: L.solscan, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan' }),
          h('a', { href: L.jupiter, target: '_blank', rel: 'noopener noreferrer', text: 'Jupiter' }),
          window.MG && MG.shareButton ? MG.shareButton({ ca: c.address, symbol: c.symbol, peak: c.ath }) : null
        ])
      ])
    ]);
    return el;
  }

  function filtered() {
    var q = state.q.toLowerCase().replace(/^\$/, '');
    var list = state.calls.filter(function (c) {
      if (state.dex !== 'all' && dexGroup(c.dex) !== state.dex) return false;
      if (!q) return true;
      return c.name.toLowerCase().indexOf(q) >= 0 || c.symbol.toLowerCase().indexOf(q) >= 0 || c.address.toLowerCase() === q || c.address.toLowerCase().indexOf(q) === 0;
    });
    var key = { new: function (c) { return c.calledTs; }, ath: function (c) { return c.ath; }, score: function (c) { return c.score || 0; }, mc: function (c) { return c.currentMc || 0; } }[state.sort];
    return list.sort(function (a, b) { return key(b) - key(a); });
  }

  function render() {
    var feed = $('feed'), list = filtered(), frag = document.createDocumentFragment();
    list.forEach(function (c) { frag.appendChild(card(c)); });
    feed.replaceChildren(frag);
    feed.setAttribute('aria-busy', 'false');
    var empty = $('empty');
    if (!state.calls.length) { empty.hidden = false; empty.textContent = state.lastOk ? 'No calls yet — the scanner is hunting. Join the Telegram to catch the first one.' : 'Calls will appear here shortly.'; }
    else if (!list.length) { empty.hidden = false; empty.textContent = 'No calls match your filters.'; }
    else empty.hidden = true;
    state.calls.forEach(function (c) { state.seen[c.address + c.calledAt] = 1; });
    state.first = false;
  }

  function renderStats() {
    var cs = state.calls, n = cs.length;
    $('sTotal').textContent = n ? String(n) : '0';
    if (!n) { $('sBest').textContent = '—'; $('sAvg').textContent = '—'; $('sHit').textContent = '—'; return; }
    var clean = cs.filter(function (c) { return !c.rugged; }); // rugs never count as "best"
    var best = clean.length ? clean.reduce(function (b, c) { return c.ath > b.ath ? c : b; }) : null;
    $('sBest').textContent = best ? '$' + best.symbol + ' ' + xf(best.ath) : '—';
    $('sBest').title = best ? best.name : '';
    $('sAvg').textContent = xf(cs.reduce(function (s, c) { return s + c.ath; }, 0) / n);
    var hit = cs.filter(function (c) { return c.ath >= 2; }).length;
    $('sHit').textContent = hit + ' (' + Math.round((hit / n) * 100) + '%)';
  }

  function setLive(ok, text) { var el = $('live'); el.className = 'live ' + (ok ? 'ok' : 'err'); $('liveText').textContent = text; }

  // ---------- data ----------
  var loading = false;
  function load() {
    if (loading) return; loading = true;
    var url = CFG.dataUrl + (CFG.dataUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
    fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var arr = d && Array.isArray(d.calls) ? d.calls : [];
        state.calls = arr.map(sanitize).filter(Boolean);
        state.lastOk = d && d.updatedAt ? d.updatedAt : new Date().toISOString();
        setLive(true, 'Live · updated ' + ago(state.lastOk));
        renderStats(); render();
      })
      .catch(function () {
        setLive(false, state.calls.length ? 'Offline · showing cached' : 'Feed unavailable');
        if (state.first) render();
      })
      .then(function () { loading = false; });
  }

  function copy(text, btn) {
    var done = function () { toast('Contract address copied'); if (btn) { btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = 'Copy CA'; }, 1500); } };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { legacy(); });
    else legacy();
    function legacy() {
      var ta = h('textarea', { readonly: '', 'aria-hidden': 'true' }); ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — long-press to copy'); }
      document.body.removeChild(ta);
    }
  }
  var tt; function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1800); }

  // ---------- init ----------
  // Telegram / Chat / X buttons, footer links and nav are wired by assets/common.js
  $('yr').textContent = new Date().getFullYear();
  var chips = $('dexChips');
  DEX_CHIPS.forEach(function (d) {
    var b = h('button', { class: 'chip', type: 'button', 'aria-pressed': d[0] === 'all' ? 'true' : 'false', 'data-dex': d[0], text: d[1] });
    b.addEventListener('click', function () {
      state.dex = d[0];
      Array.prototype.forEach.call(chips.children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      render();
    });
    chips.appendChild(b);
  });
  var qt; $('q').addEventListener('input', function (e) { clearTimeout(qt); qt = setTimeout(function () { state.q = e.target.value.trim(); render(); }, 120); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });

  load();
  var every = Math.max(15, num(CFG.refreshSeconds) || 60) * 1000;
  setInterval(function () { if (!document.hidden) load(); }, every);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  setInterval(function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ago]'), function (t) { t.textContent = 'Called ' + ago(t.getAttribute('data-ago')); });
    if (state.lastOk) $('liveText').textContent = 'Live · updated ' + ago(state.lastOk);
  }, 30000);
})();
