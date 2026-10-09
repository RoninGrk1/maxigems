/* MaxiGems Trending Radar (/trending/). Client-side, free keyless APIs, XSS-safe: DOM built with textContent only,
   links rebuilt from validated Solana addresses, images limited to known CDNs. Falls back to /data/trending.json. */
(function () {
  'use strict';
  var R = window.MGRadar;
  var CFG = Object.assign({ telegramUrl: 'https://t.me/maxigems_calls', chatUrl: 'https://t.me/MGcalls_gc', xUrl: 'https://x.com/maxigems_sol', refreshSeconds: 60 }, window.MAXIGEMS_CONFIG || {});
  var DS = 'https://api.dexscreener.com';
  var GT = 'https://api.geckoterminal.com/api/v2';
  var DATA = '/data/';
  var REFRESH_MS = Math.max(30, R.num(CFG.refreshSeconds) || 60) * 1000;
  var MAX_ENRICH = 120; // 4 DexScreener batches of 30
  var DEX_NAMES = { pumpswap: 'PumpSwap', pumpfun: 'Pump.fun', raydium: 'Raydium', raydiumclmm: 'Raydium CLMM', raydiumcpmm: 'Raydium CPMM', meteora: 'Meteora', meteoradbc: 'Meteora DBC', meteoradammv2: 'Meteora DAMM', launchlab: 'LaunchLab', orca: 'Orca' };
  var TABS = {
    hot: { sort: 'heat', desc: 'Ranked by 🔥 heat: 5-minute and 1-hour volume acceleration, buyer count and buy share. Min $3K liquidity and $1K 1h volume.' },
    grads: { sort: 'newest', desc: 'Pump.fun tokens that graduated to PumpSwap or Raydium in the last 24 hours, newest first.' },
    watch: { sort: 'score', desc: 'Near-misses from the latest MaxiGems scan: tokens that almost qualified, with the main reason they weren’t called. Not calls.' }
  };
  var state = { tab: 'hot', q: '', sorts: { hot: 'heat', grads: 'newest', watch: 'score' }, hot: [], grads: [], watch: [], called: {}, updatedAt: null, mode: 'connecting', busy: false, first: true, partial: false };
  var $ = function (id) { return document.getElementById(id); };

  // ---------- helpers ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function usd(v) { var n = R.num(v); if (n === null) return '—'; var a = Math.abs(n); if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; return '$' + n.toFixed(0); }
  function pct(v) { var n = R.num(v); if (n === null) return '—'; return (n > 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 100 ? 0 : 1) + '%'; }
  function age(ms) { if (ms == null || ms < 0) return '—'; var m = Math.floor(ms / 60000); if (m < 60) return m + 'm'; var hr = Math.floor(m / 60); if (hr < 48) return hr + 'h ' + (m % 60) + 'm'; return Math.floor(hr / 24) + 'd'; }
  function since(ts) { if (!ts) return '—'; var s = Math.max(0, Math.floor((Date.now() - ts) / 1000)); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; return Math.floor(s / 3600) + 'h ago'; }
  function dexName(d) { return DEX_NAMES[d] || (d ? d.charAt(0).toUpperCase() + d.slice(1) : 'DEX'); }
  function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
  function safeHttps(u) { try { var x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; } }
  function tgHref(u) { var s = safeHttps(u); return s && /^https:\/\/(t\.me|telegram\.me)\//.test(s) ? s : null; }
  function xHref(u) { var s = safeHttps(u); return s && /^https:\/\/(www\.)?(x|twitter)\.com\//.test(s) ? s : null; }

  // Per-host spacing keeps every visitor well inside free limits (GeckoTerminal ~30 rpm, DexScreener 60–300 rpm).
  var GAP = { 'api.dexscreener.com': 350, 'api.geckoterminal.com': 2200 };
  var next = {};
  var gtNextAt = 0, gtLast = [null, null];
  function getJson(url, timeoutMs) {
    var host = new URL(url, location.href).host;
    var wait = Math.max(0, (next[host] || 0) - Date.now());
    next[host] = Date.now() + wait + (GAP[host] || 0);
    return new Promise(function (res) { setTimeout(res, wait); }).then(function () {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 12000);
      return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { clearTimeout(t); return d; }, function (e) { clearTimeout(t); throw e; });
    });
  }
  function soft(p, errs, name) { return p.catch(function (e) { errs.push(name + ': ' + (e && e.message || e)); return null; }); }

  // ---------- data ----------
  function refresh() {
    if (state.busy) return; state.busy = true;
    var errs = [];
    var local = Promise.all([
      soft(getJson(DATA + 'watchlist.json?t=' + Date.now()), errs, 'watchlist'),
      soft(getJson(DATA + 'calls.json?t=' + Date.now()), errs, 'calls'),
      soft(getJson(DATA + 'trending.json?t=' + Date.now()), errs, 'snapshot')
    ]);
    var ds = Promise.all([
      soft(getJson(DS + '/token-boosts/top/v1'), errs, 'dexscreener boosts top'),
      soft(getJson(DS + '/token-boosts/latest/v1'), errs, 'dexscreener boosts latest')
    ]);
    // GeckoTerminal has the tightest free limit: refresh it every ~2 min (reuse the last result in between)
    // and back off for 5 min after a failure (a 429 there comes without CORS headers).
    var gtDue = Date.now() >= gtNextAt;
    var gt = !gtDue ? Promise.resolve(gtLast) : Promise.all([
      soft(getJson(GT + '/networks/solana/trending_pools?page=1'), errs, 'geckoterminal trending'),
      soft(getJson(GT + '/networks/solana/new_pools?page=1'), errs, 'geckoterminal new')
    ]).then(function (res) {
      var failed = res.some(function (x) { return x === null; });
      gtNextAt = Date.now() + (failed ? 300000 : 110000);
      gtLast = [res[0] || gtLast[0], res[1] || gtLast[1]];
      return gtLast;
    });
    var snap = null, watchRaw = [];
    Promise.all([local, ds, gt]).then(function (all) {
      var L = all[0], D = all[1], G = all[2];
      watchRaw = L[0] && Array.isArray(L[0].items) ? L[0].items : [];
      var called = {};
      (L[1] && Array.isArray(L[1].calls) ? L[1].calls : []).forEach(function (c) { if (c && R.isSol(c.address)) called[c.address] = 1; });
      state.called = called;
      snap = L[2] && typeof L[2] === 'object' ? L[2] : null;

      var order = [], seen = {};
      function add(a, cap) { var n = 0; a.forEach(function (x) { if (n < cap && R.isSol(x) && !seen[x]) { seen[x] = 1; order.push(x); n++; } }); }
      add(watchRaw.map(function (w) { return w && w.address; }), 15);
      var gtNew = R.gtPools(G[1]);
      add(gtNew.filter(function (p) { return /^(pumpswap|raydium)/.test(p.dex) && /pump$/.test(p.address); }).map(function (p) { return p.address; }), 30);
      add(R.gtPools(G[0]).map(function (p) { return p.address; }), 20);
      add(R.dsBoosts(D[0]), 30);
      add(R.dsBoosts(D[1]), 30);
      if (snap) add([].concat(snap.hot || [], snap.graduates || []).map(function (r) { return r && r.address; }), 40);
      order = order.slice(0, MAX_ENRICH);
      return Promise.all(chunk(order, 30).map(function (b) { return soft(getJson(DS + '/tokens/v1/solana/' + b.join(',')), errs, 'dexscreener tokens'); }));
    }).then(function (batches) {
      var pairs = [];
      batches.forEach(function (d) { if (Array.isArray(d)) pairs = pairs.concat(d); else if (d && Array.isArray(d.pairs)) pairs = pairs.concat(d.pairs); });
      var best = R.bestPairs(pairs), rows = Object.keys(best).map(function (k) { return best[k]; });
      var now = Date.now();
      var watch = watchRaw.map(R.fromWatch).filter(Boolean).map(function (w) { return R.overlay(w, best[w.address]); });
      if (rows.length) {
        state.hot = R.sortRows(rows.filter(R.isHot), 'heat').slice(0, 60);
        state.grads = R.sortRows(rows.filter(function (r) { return R.isGraduate(r, now); }), 'newest').slice(0, 40);
        state.mode = 'live';
        state.updatedAt = now;
        state.partial = errs.some(function (e) { return /^(dexscreener|geckoterminal)/.test(e); });
      } else if (snap) {
        state.hot = (Array.isArray(snap.hot) ? snap.hot : []).slice(0, 60).map(R.fromSnapshot).filter(Boolean);
        state.grads = (Array.isArray(snap.graduates) ? snap.graduates : []).slice(0, 40).map(R.fromSnapshot).filter(Boolean);
        state.mode = 'snapshot';
        state.updatedAt = Date.parse(snap.updatedAt) || null;
      } else {
        state.mode = 'down';
      }
      state.watch = watch;
      if (errs.length && window.console) console.info('[radar] some sources failed:', errs.join('; '));
    }).catch(function (e) {
      if (!state.hot.length && snap) {
        try {
          state.hot = (Array.isArray(snap.hot) ? snap.hot : []).slice(0, 60).map(R.fromSnapshot).filter(Boolean);
          state.grads = (Array.isArray(snap.graduates) ? snap.graduates : []).slice(0, 40).map(R.fromSnapshot).filter(Boolean);
          state.mode = 'snapshot'; state.updatedAt = Date.parse(snap.updatedAt) || null;
        } catch (e2) { state.mode = 'down'; }
      } else if (!state.hot.length) state.mode = 'down';
      if (window.console) console.info('[radar] refresh failed:', e && e.message);
    }).then(function () {
      state.busy = false; state.lastTry = Date.now();
      render(); tick();
    });
  }

  // ---------- render ----------
  function badge(cls, text, title) { return h('span', { class: 'badge ' + cls, title: title || null, text: text }); }
  function avatar(r) {
    var fb = h('div', { class: 'ava', 'aria-hidden': 'true', text: r.symbol.charAt(0).toUpperCase() });
    if (!r.imageUrl) return fb;
    var img = h('img', { class: 'ava', src: r.imageUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', width: 46, height: 46 });
    img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(fb, img); });
    return img;
  }
  function chg(label, v) { var n = R.num(v); return h('span', { class: 'tr-chg ' + (n == null ? '' : n >= 0 ? 'pos' : 'neg') }, [h('i', { text: label }), pct(n)]); }
  function kv(k, v, cls) { return h('div', null, [h('span', { text: k }), h('b', { class: cls || null, text: v })]); }
  function safetyRow(s) {
    if (!s) return null;
    function pc(v) { return v == null ? '?' : Math.round(v) + '%'; }
    function it(label, ok, val) { return h('span', { class: 'sf ' + (ok ? 'ok' : 'bad') }, [label + ' ', h('b', { text: val })]); }
    return h('div', { class: 'safety', 'aria-label': 'Safety check from the last scan' }, [
      h('span', { class: 'sf-t', text: '🛡' }),
      it('Mint', s.mint, s.mint ? '✅' : '❌'), it('Freeze', s.freeze, s.freeze ? '✅' : '❌'),
      it('LP 🔥', s.lp != null && s.lp >= 80, pc(s.lp)), it('Top10', s.top10 != null && s.top10 <= 35, pc(s.top10)),
      s.holders != null ? it('Holders', true, String(Math.round(s.holders))) : null
    ]);
  }

  function card(r, tab) {
    var now = Date.now();
    var dsUrl = 'https://dexscreener.com/solana/' + (r.pairAddress && R.isSol(r.pairAddress) ? r.pairAddress : r.address);
    var called = state.called[r.address] === 1;
    var copyBtn = h('button', { class: 'copy', type: 'button', 'aria-label': 'Copy contract address of ' + r.symbol, text: 'Copy CA' });
    copyBtn.addEventListener('click', function () { copy(r.address, copyBtn); });
    var b = r.txns && r.txns.h1 ? r.txns.h1.b : 0, s = r.txns && r.txns.h1 ? r.txns.h1.s : 0;
    var share = b + s > 0 ? Math.round((b / (b + s)) * 100) : null;
    var big = tab === 'watch'
      ? h('div', { class: 'xbox' }, [h('div', { class: 'x tr-score', text: r.score != null ? String(r.score) : '—' }), h('div', { class: 'xl', text: 'score' })])
      : h('div', { class: 'xbox' }, [h('div', { class: 'x tr-heat' + (r.heat >= 70 ? ' hot' : ''), text: String(r.heat) }), h('div', { class: 'xl', text: '🔥 heat' })]);
    var grad = R.isGraduate(r, now);
    return h('article', { class: 'card tr-card' + (called ? ' is-called' : ''), 'aria-label': r.name + ' ($' + r.symbol + ')' }, [
      h('div', { class: 'top' }, [
        avatar(r),
        h('div', { class: 'ttl' }, [
          h('div', { class: 'nm', title: r.name, text: r.name }),
          h('div', { class: 'sym' }, [
            h('span', { text: '$' + r.symbol }),
            badge('dex', dexName(r.dex)),
            grad && tab !== 'grads' ? badge('tr-grad', '🎓 Grad', 'Graduated from pump.fun in the last 24h') : null,
            called ? badge('tr-called', '💎 Called', 'Called in the MaxiGems channel') : null
          ])
        ]),
        big
      ]),
      h('div', { class: 'tr-chgs' }, [chg('5m', r.ch.m5), chg('1h', r.ch.h1), chg('24h', r.ch.h24)]),
      h('div', { class: 'kv' }, [
        kv('Age', age(R.ageMs(r, now))),
        kv('Market cap', usd(r.mc)),
        kv('Liquidity', usd(r.liq)),
        kv('Vol 1h', usd(r.vol && r.vol.h1))
      ]),
      h('div', { class: 'tr-bs', title: 'Buys / sells in the last hour' }, [
        h('span', { class: 'tr-bs-l' }, ['Buys/Sells 1h ', h('b', { class: 'pos', text: String(b) }), ' / ', h('b', { class: 'neg', text: String(s) })]),
        h('span', { class: 'tr-bar', 'aria-hidden': 'true' }, [h('i', { style: null })])
      ]),
      tab === 'watch' ? h('div', { class: 'tr-why' }, [h('span', { text: 'Why not called: ' }), h('b', { text: r.reason })].concat(r.otherReasons && r.otherReasons.length ? [h('span', { class: 'tr-why2', text: ' · also ' + r.otherReasons.join(', ') })] : [])) : null,
      tab === 'watch' ? safetyRow(r.safety) : null,
      h('div', { class: 'ca' }, [h('code', { title: r.address, text: r.address }), copyBtn]),
      h('div', { class: 'foot' }, [
        h('span', { class: 'ago', text: share == null ? 'No trades in 1h' : share + '% buys (1h)' }),
        h('div', { class: 'lnk' }, [
          h('a', { class: 'pri', href: dsUrl, target: '_blank', rel: 'noopener noreferrer', text: 'DexScreener' }),
          h('a', { href: 'https://solscan.io/token/' + r.address, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan' })
        ])
      ])
    ]);
  }

  function setBar(el, r) {
    var b = r.txns && r.txns.h1 ? r.txns.h1.b : 0, s = r.txns && r.txns.h1 ? r.txns.h1.s : 0;
    var i = el.querySelector('.tr-bar i'); if (i) i.style.width = (b + s > 0 ? Math.round((b / (b + s)) * 100) : 0) + '%'; // CSSOM, not markup
  }

  function render() {
    var list = R.sortRows(R.search(state[state.tab] || [], state.q), state.sorts[state.tab]);
    var feed = $('radar'), frag = document.createDocumentFragment();
    list.forEach(function (r) { var el = card(r, state.tab); setBar(el, r); frag.appendChild(el); });
    feed.replaceChildren(frag);
    feed.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    feed.setAttribute('aria-labelledby', 'tab-' + state.tab);
    $('nHot').textContent = state.hot.length ? String(state.hot.length) : '';
    $('nGrads').textContent = state.grads.length ? String(state.grads.length) : '';
    $('nWatch').textContent = state.watch.length ? String(state.watch.length) : '';
    $('tabDesc').textContent = TABS[state.tab].desc;
    $('sort').value = state.sorts[state.tab];
    var fb = $('fallback');
    if (state.mode === 'snapshot') { fb.hidden = false; fb.textContent = 'Live market APIs didn’t respond, so this is the bot’s latest snapshot (' + since(state.updatedAt) + '). It will switch back to live data automatically.'; }
    else if (state.mode === 'down') { fb.hidden = false; fb.textContent = 'Live data is unavailable right now. Retrying every minute…'; }
    else fb.hidden = true;
    var empty = $('empty');
    if (list.length) empty.hidden = true;
    else {
      empty.hidden = false;
      empty.textContent = state.busy && state.first ? 'Loading…'
        : (state[state.tab] || []).length ? 'No tokens match your search.'
        : state.tab === 'watch' ? 'Nothing on watch right now. The list updates with every bot scan.'
        : state.tab === 'grads' ? 'No pump.fun graduates spotted in the last 24h yet.'
        : 'Nothing hot right now. Check back in a minute.';
    }
    if (!state.busy) state.first = false;
  }

  function tick() {
    var el = $('live'), t = $('liveText');
    if (state.mode === 'live') { el.className = 'live ok'; t.textContent = 'Live · updated ' + since(state.updatedAt); el.title = state.partial ? 'Some sources didn’t respond; list may be partial' : 'Radar status'; }
    else if (state.mode === 'snapshot') { el.className = 'live err'; t.textContent = 'Snapshot · ' + since(state.updatedAt); }
    else if (state.mode === 'down') { el.className = 'live err'; t.textContent = 'Offline · retrying'; }
  }

  function copy(text, btn) {
    var done = function () { toast('Contract address copied'); btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = 'Copy CA'; }, 1500); };
    function legacy() {
      var ta = h('textarea', { readonly: '', 'aria-hidden': 'true' }); ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — long-press to copy'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, legacy); else legacy();
  }
  var tt; function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1800); }

  // ---------- init ----------
  function wire() {
    var tg = tgHref(CFG.telegramUrl) || 'https://t.me/maxigems_calls', chat = tgHref(CFG.chatUrl), xu = xHref(CFG.xUrl);
    $('tgBtn').href = $('ftrTg').href = tg;
    if (chat) $('chatBtn').href = $('ftrChat').href = chat; else $('chatBtn').hidden = $('ftrChat').hidden = true;
    if (xu) $('xBtn').href = $('ftrX').href = xu; else $('xBtn').hidden = $('ftrX').hidden = true;
    if (!chat !== !xu) document.querySelector('.cta').classList.add('one');
    $('yr').textContent = String(new Date().getFullYear());
  }
  function selectTab(name, focus) {
    if (!TABS[name]) return;
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tr-tab'), function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    if (history.replaceState) history.replaceState(null, '', name === 'hot' ? location.pathname : '#' + name);
    render();
  }
  wire();
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tr-tab'));
  tabs.forEach(function (b, i) {
    b.addEventListener('click', function () { selectTab(b.getAttribute('data-tab')); });
    b.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
      e.preventDefault(); selectTab(tabs[(i + d + tabs.length) % tabs.length].getAttribute('data-tab'), true);
    });
  });
  var qt; $('q').addEventListener('input', function (e) { clearTimeout(qt); qt = setTimeout(function () { state.q = e.target.value; render(); }, 120); });
  $('sort').addEventListener('change', function (e) { state.sorts[state.tab] = e.target.value; render(); });
  $('refresh').addEventListener('click', function () { refresh(); });
  var hash = (location.hash || '').slice(1);
  if (TABS[hash]) selectTab(hash); else render();
  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && (!state.lastTry || Date.now() - state.lastTry > REFRESH_MS)) refresh(); });
  setInterval(tick, 1000);
})();
