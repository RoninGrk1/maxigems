/* /whales/ page: top whales, moves feed, client-side top-holders lookup. DOM via textContent only (MG.h). */
(function () {
  'use strict';
  var MG = window.MG, WH = window.MGWH;
  if (!MG || !WH) return;
  var $ = MG.$, h = MG.h, num = MG.num;
  var RC = 'https://api.rugcheck.xyz/v1/tokens/';
  // Browser-safe keyless RPC (CORS *). api.mainnet-beta.solana.com answers 403 to browser origins; indexed methods
  // (getTokenLargestAccounts) need a key everywhere, so the holder LIST comes from RugCheck and balances are re-read here.
  var RPC = 'https://solana-rpc.publicnode.com';
  var DS = 'https://api.dexscreener.com/tokens/v1/solana/';
  var KIND = { buy: ['🟢', 'Bought more'], sell: ['🔴', 'Sold'], exit: ['🚪', 'Exited'], new: ['🆕', 'New top holder'] };
  var st = { pub: null, moves: [], called: {}, filter: 'all', shown: 30, last: 0, busy: false };

  function tok(v) {
    var n = num(v); if (n === null) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }
  function pc(v) { var n = num(v); return n === null ? '—' : (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + '%'; }
  function sym(s) { return MG.clean(String(s || '').replace(/^\$/, ''), 16) || '???'; }
  function acctUrl(o) { return 'https://solscan.io/account/' + o; }
  function coinUrl(ca) { return '/c/' + ca + '/'; }
  function badge(cls, text, title) { return h('span', { class: 'wb ' + cls, text: text, title: title || null }); }
  function walletLink(o) { return h('a', { href: acctUrl(o), target: '_blank', rel: 'noopener noreferrer', title: o, text: WH.shortAddr(o) }); }
  function getJson(url, opts, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 15000) : null;
    return fetch(url, Object.assign({ signal: ctrl ? ctrl.signal : undefined }, opts || {})).then(function (r) {
      if (t) clearTimeout(t);
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    }, function (e) { if (t) clearTimeout(t); throw e; });
  }
  function rpc(method, params) {
    return getJson(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) }, 15000).then(function (d) {
      if (d && d.error) { var e = new Error(d.error.message || 'rpc error'); e.status = d.error.code === 429 ? 429 : 500; throw e; }
      return d && d.result;
    });
  }

  // ---------- whales ----------
  function renderWhales() {
    var box = $('whales'), pub = st.pub;
    box.setAttribute('aria-busy', 'false');
    while (box.firstChild) box.removeChild(box.firstChild);
    var list = pub && Array.isArray(pub.whales) ? pub.whales.filter(function (w) { return w && WH.isSol(w.o); }) : [];
    var mega = num(pub && pub.megaWhaleUsd) || 100000; // config.whales.megaWhaleUsd, carried in whales.json
    var megaTxt = MG.usd(mega).replace(/\.0([KMB])$/, '$1'); // $100K, not $100.0K
    if (pub && num(pub.megaWhaleUsd)) $('megaUsd').textContent = megaTxt; // no data → keep the page's own text
    $('whEmpty').hidden = !!list.length;
    if (!list.length) $('whEmpty').textContent = pub ? 'No whale data yet — holder snapshots build up over the next few bot runs.' : 'Whale data is unavailable right now — retrying every minute.';
    list.forEach(function (w, i) {
      var hold = (Array.isArray(w.h) ? w.h : []).filter(function (x) { return x && WH.isSol(x.ca); });
      var badges = [];
      if (num(w.usd) >= mega) badges.push(badge('mega', '🐳 Mega whale', 'Holds ≥ ' + megaTxt + ' across called coins'));
      if (hold.length >= 3) badges.push(badge('multi', '🔁 Holds ' + hold.length + ' calls'));
      if (w.dev) badges.push(badge('dev', '⚠️ Dev wallet', 'Token creator wallet'));
      else if (w.ins) badges.push(badge('ins', '⚠️ Insider', 'Flagged as insider by RugCheck'));
      var copyBtn = h('button', { type: 'button', class: 'wh-btn', 'aria-label': 'Copy wallet address ' + w.o, text: 'Copy' });
      copyBtn.addEventListener('click', function () { MG.copy(w.o, copyBtn, 'Wallet address copied'); });
      box.appendChild(h('article', { class: 'card wh-card', 'aria-label': 'Whale #' + (i + 1) }, [
        h('div', { class: 'wh-top' }, [
          h('span', { class: 'wh-rank' + (i < 3 ? ' r' + (i + 1) : ''), text: String(i + 1) }),
          h('div', { class: 'wh-id' }, [
            h('div', { class: 'wh-addr', title: w.o, text: WH.shortAddr(w.o) }),
            h('div', { class: 'wh-sub', text: hold.length + (hold.length === 1 ? ' called coin' : ' called coins') })
          ]),
          h('div', { class: 'wh-usd', text: MG.usd(w.usd) })
        ]),
        badges.length ? h('div', { class: 'wh-badges' }, badges) : null,
        h('ul', { class: 'wh-hold' }, hold.slice(0, 6).map(function (x) {
          return h('li', null, [
            h('a', { href: coinUrl(x.ca), text: '$' + sym(x.sym) }),
            h('span', { class: 'amt' }, [tok(x.a) + ' · ', h('span', { class: 'pc', text: pc(x.pct) })]),
            h('span', { class: 'usd', text: MG.usd(x.usd) })
          ]);
        })),
        h('div', { class: 'wh-acts' }, [copyBtn, h('a', { class: 'wh-btn', href: acctUrl(w.o), target: '_blank', rel: 'noopener noreferrer', text: 'Solscan ↗' })])
      ]));
    });
  }

  // ---------- moves ----------
  function moveRow(m) {
    var k = KIND[m.k] || ['•', m.k];
    var ge = m.min ? '≥' : '';
    var l1 = [h('span', { class: 'k-' + m.k, text: k[1] }), h('a', { href: coinUrl(m.ca), text: '$' + sym(m.sym) })];
    if (m.dev) l1.push(badge('dev', '⚠️ Dev'));
    else if (m.ins) l1.push(badge('ins', '⚠️ Insider'));
    if (m.al) l1.push(badge('called', '📣 Alerted', 'Posted to the MaxiGems Telegram channel'));
    var hold = m.k === 'exit' ? 'now holds 0%' : 'now holds ' + pc(m.hp) + (num(m.chg) !== null ? ' (' + (m.chg > 0 ? '+' : '') + Math.round(m.chg) + '%)' : '');
    return h('li', { class: 'wh-mv' + (m.al ? ' al' : '') }, [
      h('span', { class: 'wh-ico', 'aria-hidden': 'true', text: k[0] }),
      h('div', { class: 'wh-l1' }, l1),
      h('time', { class: 'wh-t', datetime: m.t, title: new Date(m.t).toLocaleString(), text: MG.ago(m.t) }),
      h('div', { class: 'wh-l2' }, [walletLink(m.o), ' · ' + ge + tok(m.d) + ' tokens · ' + ge + MG.usd(m.usd) + ' · ' + ge + pc(m.dp) + ' of supply · ' + hold])
    ]);
  }
  function validMoves(list) { return (Array.isArray(list) ? list : []).filter(function (m) { return m && WH.isSol(m.ca) && WH.isSol(m.o) && KIND[m.k] && isFinite(Date.parse(m.t)); }); }
  function renderMoves() {
    var ol = $('moves');
    while (ol.firstChild) ol.removeChild(ol.firstChild);
    var list = st.moves.filter(function (m) { return st.filter === 'all' || m.k === st.filter; });
    list.slice(0, st.shown).forEach(function (m) { ol.appendChild(moveRow(m)); });
    $('mvMore').hidden = list.length <= st.shown;
    $('mvEmpty').hidden = !!list.length;
    if (!list.length) $('mvEmpty').textContent = st.moves.length ? 'No moves of this type yet.' : st.movesFailed ? 'Whale moves are unavailable right now — retrying every minute.' : 'No whale moves yet — moves appear once a coin has two holder snapshots (baseline first, no alerts on it).';
  }

  function stats() {
    var pub = st.pub || {}, day = Date.now() - 864e5;
    var m24 = st.moves.filter(function (m) { return Date.parse(m.t) > day; });
    var al = {}; m24.forEach(function (m) { if (m.al) al[m.ca + m.t] = 1; });
    $('sCoins').textContent = num(pub.coinsTracked) !== null ? String(pub.coinsTracked) : '—';
    $('sWhales').textContent = Array.isArray(pub.whales) ? String(pub.whales.length) : '—';
    $('sMoves').textContent = String(m24.length);
    $('sAlerts').textContent = String(Object.keys(al).length);
    var rot = num(pub.rotationRuns);
    $('topNote').textContent = pub.updatedAt ? 'updated ' + MG.ago(pub.updatedAt) : '';
    $('movesNote').textContent = 'last ' + st.moves.length + ' moves' + (rot ? ' · new holders rescanned every ~' + rot + ' runs' : '');
    var pill = $('proPill');
    if (st.delay) {
      if (!pill) { pill = h('a', { class: 'pro-pill', id: 'proPill', href: '/pro/' }); var hd = $('movesNote').parentNode; hd.appendChild(pill); }
      pill.className = 'pro-pill' + (st.proLive ? ' live-on' : '');
      pill.textContent = st.proLive ? '💎 Pro · live' : '⏱ ' + st.delay + '-min delay · ⚡ Pro is live';
    } else if (pill) pill.remove();
  }

  function load() {
    var t = '?t=' + Math.floor(Date.now() / 30000);
    Promise.all([
      getJson('/data/whales.json' + t, { cache: 'no-store' }).catch(function () { return null; }),
      getJson('/data/whale-moves.json' + t, { cache: 'no-store' }).catch(function () { return null; }),
      getJson(MG.CFG.dataUrl + t, { cache: 'no-store' }).catch(function () { return null; })
    ]).then(function (r) {
      st.pub = r[0]; st.moves = validMoves(r[1] && r[1].moves); st.movesFailed = !r[1];
      st.delay = r[1] && +r[1].delayMinutes > 0 ? +r[1].delayMinutes : 0; st.proLive = false;
      if (st.delay && window.MGPro && window.MGPro.session()) {
        window.MGPro.proData().then(function (d) {
          if (!d || !d.whaleMoves || !Array.isArray(d.whaleMoves.moves)) return;
          st.moves = validMoves(d.whaleMoves.moves); st.proLive = true; renderMoves(); stats();
        });
      }
      st.called = {};
      ((r[2] && r[2].calls) || []).forEach(function (c) { if (c && WH.isSol(c.address)) st.called[c.address] = c; });
      var ok = !!r[0], age = ok ? Date.now() - Date.parse(r[0].updatedAt) : NaN;
      var stale = ok && !(age < 90 * 60e3); // bot runs every ~15–25 min; > 90 min (or a bad timestamp) = stale
      $('live').className = 'live ' + (ok && !stale ? 'ok' : 'err');
      $('liveText').textContent = !ok ? 'Offline · retrying' : (stale ? 'Stale · updated ' : 'Live · updated ') + MG.ago(r[0].updatedAt);
      renderWhales(); renderMoves(); stats();
    });
  }

  // ---------- lookup ----------
  function msg(text, err) { var m = $('lkMsg'); m.textContent = text; m.className = 'wh-msg' + (err ? ' err' : ''); }
  function fromRugcheck(ca) {
    return getJson(RC + ca + '/report', null, 20000).then(function (r) {
      var snap = WH.snapshotFromReport(r, { mint: ca });
      if (!snap || !Array.isArray(r.topHolders) || !r.topHolders.length) { var e0 = new Error('no list'); e0.empty = true; throw e0; }
      snap.removed = (r.topHolders || []).length - Object.keys(snap.accts).length;
      var meta = r.tokenMeta || r.fileMeta || null;
      var res = { snap: snap, meta: meta, src: 'RugCheck holder list', verified: false, total: num(r.totalHolders) };
      // RugCheck lists can lag: re-read the balances on-chain when the public RPC allows it
      // (PublicNode serves at most 10 accounts per getMultipleAccounts call)
      var keys = Object.keys(snap.accts), parts = [];
      for (var i = 0; i < keys.length; i += 10) parts.push(keys.slice(i, i + 10));
      return parts.reduce(function (p, part) {
        return p.then(function () {
          return rpc('getMultipleAccounts', [part, { encoding: 'jsonParsed' }]).then(function (m) {
            ((m && m.value) || []).forEach(function (acc, j) {
              var info = acc && acc.data && acc.data.parsed && acc.data.parsed.info, x = snap.accts[part[j]];
              if (!x) return;
              if (acc === null) x.a = 0;
              else if (info && info.tokenAmount && info.mint === ca) { x.a = num(info.tokenAmount.uiAmountString) || 0; if (WH.isSol(info.owner)) x.o = info.owner; }
            });
          });
        });
      }, Promise.resolve()).then(function () {
        res.verified = true; res.src += ', balances re-checked live on Solana RPC';
        return res;
      }, function () { res.src += ' (on-chain re-check unavailable, may lag)'; return res; });
    });
  }
  function price(ca) {
    return getJson(DS + ca, null, 10000).then(function (d) {
      var pairs = (Array.isArray(d) ? d : []).filter(function (p) { return p && p.baseToken && p.baseToken.address === ca; });
      pairs.sort(function (a, b) { return (num(b.liquidity && b.liquidity.usd) || 0) - (num(a.liquidity && a.liquidity.usd) || 0); });
      return pairs.length ? { price: num(pairs[0].priceUsd), name: pairs[0].baseToken.name, symbol: pairs[0].baseToken.symbol } : null;
    }).catch(function () { return null; });
  }
  function renderLookup(ca, res, px) {
    var out = $('lkOut');
    while (out.firstChild) out.removeChild(out.firstChild);
    var list = WH.owners(res.snap).slice(0, 15);
    var p = px && px.price;
    var top10 = WH.top10Pct(list);
    var ins = list.filter(function (x) { return x.ins || x.dev; }).length;
    var name = MG.clean((res.meta && res.meta.name) || (px && px.name) || '', 40);
    var symb = sym((res.meta && res.meta.symbol) || (px && px.symbol) || '');
    var head = [h('b', { text: (name || 'Token') + ' ($' + symb + ')' })];
    if (st.called[ca]) head.push(h('a', { class: 'wb called', href: coinUrl(ca), text: '💎 Called by MaxiGems →' }));
    head.push(h('a', { class: 'wh-btn', href: 'https://solscan.io/token/' + ca, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan ↗' }));
    var maxPct = list.reduce(function (m, x) { return Math.max(m, num(x.pct) || 0); }, 0) || 1;
    var rows = list.map(function (x, i) {
      var flags = [];
      if (x.dev) flags.push(badge('dev', 'Dev')); else if (x.ins) flags.push(badge('ins', 'Insider'));
      var cp = h('button', { type: 'button', class: 'wh-btn', 'aria-label': 'Copy wallet ' + x.o, text: '⧉' });
      cp.addEventListener('click', function () { MG.copy(x.o, cp, 'Wallet address copied'); });
      return h('tr', null, [
        h('td', { text: String(i + 1) }),
        h('td', null, [h('span', { class: 'who' }, [walletLink(x.o), cp].concat(flags))]),
        h('td', { class: 'n' }, [pc(x.pct), h('span', { class: 'bar', 'aria-hidden': 'true' })]),
        h('td', { class: 'n hide-s', text: tok(x.a) }),
        h('td', { class: 'n', text: p ? MG.usd(x.a * p) : '—' })
      ]);
    });
    // bar widths via CSSOM (no inline style attribute strings → CSP-safe)
    rows.forEach(function (tr, i) { var b = tr.querySelector('.bar'); b.style.width = Math.max(3, Math.round(((num(list[i].pct) || 0) / maxPct) * 100)) + '%'; });
    out.appendChild(h('div', { class: 'wh-res' }, [
      h('div', { class: 'wh-res-h' }, head),
      h('div', { class: 'wh-kpis' }, [
        h('div', { class: 'wh-kpi' }, [h('span', { text: 'Top 10 hold' }), h('b', { class: top10 !== null && top10 > 35 ? 'hi' : 'ok', text: top10 === null ? '—' : pc(top10) })]),
        h('div', { class: 'wh-kpi' }, [h('span', { text: 'Insider/dev' }), h('b', { class: ins ? 'hi' : 'ok', text: res.meta ? ins + ' of ' + list.length : 'n/a' })]),
        h('div', { class: 'wh-kpi' }, [h('span', { text: 'Holders' }), h('b', { text: res.total ? res.total.toLocaleString('en-US') : '—' })])
      ]),
      list.length ? h('div', { class: 'wh-tbl-wrap' }, [h('table', { class: 'wh-tbl' }, [
        h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: '#' }), h('th', { scope: 'col', text: 'Wallet' }), h('th', { scope: 'col', class: 'n', text: '% supply' }), h('th', { scope: 'col', class: 'n hide-s', text: 'Amount' }), h('th', { scope: 'col', class: 'n', text: 'USD' })])]),
        h('tbody', null, rows)
      ])]) : h('p', { class: 'empty', text: 'No wallet holders found (only pools / program accounts in the top list).' }),
      h('p', { class: 'wh-src', text: 'Source: ' + res.src + '. Excluded ' + (res.snap.removed || 0) + ' pool / locker / burn / CEX / program-owned account(s). ' + (p ? 'USD values use the DexScreener price (' + MG.usd(p * 1e6) + ' per 1M tokens).' : 'No DexScreener price.') })
    ]));
  }
  function lookup(raw) {
    var ca = String(raw || '').trim();
    if (st.busy) return;
    var b = WH.b58decode(ca);
    if (!WH.isSol(ca) || !b || b.length !== 32) { msg('That doesn’t look like a Solana token address (base58, 32–44 characters).', true); return; }
    var wait = 4000 - (Date.now() - st.last);
    if (wait > 0) { msg('Easy, whale — wait ' + Math.ceil(wait / 1000) + 's between lookups (free APIs).', true); return; }
    st.busy = true; st.last = Date.now(); $('lkGo').disabled = true;
    $('lkOut').textContent = '';
    msg('Checking holders…');
    try { history.replaceState(null, '', '?ca=' + ca + '#lookup'); } catch (e) { /* ignore */ }
    fromRugcheck(ca).catch(function (e) {
      if (!e || e.status !== 429) throw e;
      msg('RugCheck is rate-limiting — retrying in 3s…');
      return new Promise(function (r) { setTimeout(r, 3000); }).then(function () { return fromRugcheck(ca); });
    }).then(function (res) {
      return price(ca).then(function (px) { renderLookup(ca, res, px); msg(''); });
    }).catch(function (e) {
      var busy = e && e.status === 429;
      msg(busy ? 'The free holder API is rate-limiting right now. Try again in a minute.' : e && e.empty ? 'RugCheck has no holder list for this token (common for very large or brand-new tokens).' : (e && e.status === 400) || (e && e.status === 404) || (e && /no holders/.test(e.message)) ? 'No holder data for that address. Is it a Solana token mint (not a wallet)?' : 'Couldn’t reach the holder API. Check your connection and try again.', true);
    }).then(function () { st.busy = false; $('lkGo').disabled = false; });
  }

  // ---------- wiring ----------
  Array.prototype.forEach.call(document.querySelectorAll('#mvFilter .chip'), function (b) {
    b.addEventListener('click', function () {
      st.filter = b.getAttribute('data-k'); st.shown = 30;
      Array.prototype.forEach.call(document.querySelectorAll('#mvFilter .chip'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      renderMoves();
    });
  });
  $('mvMore').addEventListener('click', function () { st.shown += 30; renderMoves(); });
  $('lkForm').addEventListener('submit', function (e) { e.preventDefault(); lookup($('lkCa').value); });
  var q = null;
  try { q = new URLSearchParams(location.search).get('ca'); } catch (e) { q = null; }
  if (q && WH.isSol(q.trim())) { $('lkCa').value = q.trim(); lookup(q); }
  load();
  setInterval(function () { if (!document.hidden) load(); }, Math.max(60, num(MG.CFG.refreshSeconds) || 60) * 1000);
})();
