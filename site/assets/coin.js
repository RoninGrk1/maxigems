/* /c/<CA>/ page: wire copy + share, then refresh the numbers live from /data/calls.json. textContent only. */
(function () {
  'use strict';
  var MG = window.MG; if (!MG) return;
  var $ = MG.$, b = document.body, ca = b.getAttribute('data-ca');
  if (!MG.SOL_RE.test(ca || '')) return;
  var info = { ca: ca, symbol: b.getAttribute('data-symbol'), peak: parseFloat(b.getAttribute('data-peak')) };
  if ($('cCopy')) $('cCopy').addEventListener('click', function () { MG.copy(ca, $('cCopy')); });
  if ($('cShare')) $('cShare').addEventListener('click', function () { MG.openShare(info, $('cShare')); });
  function xc(v) { return v === null ? '' : v >= 1.05 ? 'pos' : v < 0.95 ? 'neg' : ''; }
  function apply(c) {
    var ath = MG.num(c.athMultiple), cur = MG.num(c.currentMultiple);
    var pk = Math.max(1, ath || 0, cur || 0);
    info.peak = pk;
    var rug = c.status === 'rugged';
    var liq = MG.num(c.currentLiquidity), base = MG.num(c.liquidity);
    var pulled = rug && liq !== null && (liq < 1000 || (base && liq < base * 0.05));
    $('cPeak').textContent = MG.xf(pk);
    $('cPeak').className = 'x ' + (rug ? 'down' : pk >= 1.05 ? 'up' : 'flat');
    if (MG.num(c.athMc)) $('cPeakMc').textContent = MG.usd(c.athMc);
    $('cCur').textContent = MG.xf(cur); $('cCur').className = xc(cur);
    $('cMcNow').textContent = MG.usd(c.currentMc);
    var st = $('cStatus'); st.textContent = pulled ? 'Liquidity pulled' : rug ? 'Rugged' : 'Live';
    st.className = 'badge st ' + (pulled ? 'st-pull' : rug ? 'st-rug' : 'st-live');
  }
  function load() {
    fetch(MG.CFG.dataUrl + '?t=' + Math.floor(Date.now() / 30000), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
      var list = d && Array.isArray(d.calls) ? d.calls : [];
      if ($('live')) { $('live').className = 'live ok'; $('liveText').textContent = 'Live · updated ' + MG.ago(d && d.updatedAt ? d.updatedAt : Date.now()); }
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].address === ca) { apply(list[i]); return; }
    }).catch(function () { if ($('live')) { $('live').className = 'live err'; $('liveText').textContent = 'Offline · snapshot'; } });
  }
  // ---- 🐳 Top holders + recent whale moves (from the bot's whale snapshots) ----
  var KIND = { buy: ['🟢', 'Bought more'], sell: ['🔴', 'Sold'], exit: ['🚪', 'Exited'], new: ['🆕', 'New top holder'] };
  function short(a) { return a.slice(0, 4) + '…' + a.slice(-4); }
  function pc(v) { var n = MG.num(v); return n === null ? '—' : (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + '%'; }
  function wallet(o) { return MG.h('a', { href: 'https://solscan.io/account/' + o, target: '_blank', rel: 'noopener noreferrer', title: o, text: short(o) }); }
  function whales() {
    var t = '?t=' + Math.floor(Date.now() / 30000);
    Promise.all([
      fetch('/data/whales.json' + t, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch('/data/whale-moves.json' + t, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (r) {
      var h = MG.h, coin = r[0] && r[0].coins && r[0].coins[ca];
      var moves = ((r[1] && r[1].moves) || []).filter(function (m) { return m && m.ca === ca && MG.SOL_RE.test(m.o || '') && KIND[m.k]; }).slice(0, 5);
      var kids = [h('div', { class: 'wh-h' }, [h('h2', { text: '🐳 Top holders' }), h('span', { class: 'muted', text: coin ? 'balances ' + MG.ago(coin.bat || coin.at) : '' })])];
      var holders = coin && Array.isArray(coin.holders) ? coin.holders.filter(function (x) { return x && MG.SOL_RE.test(x.o || ''); }) : [];
      if (holders.length) {
        kids.push(h('div', { class: 'wh-kpis' }, [
          h('div', { class: 'wh-kpi' }, [h('span', { text: 'Top 10 hold' }), h('b', { class: MG.num(coin.top10) > 35 ? 'hi' : 'ok', text: pc(coin.top10) })]),
          h('div', { class: 'wh-kpi' }, [h('span', { text: 'Insider/dev' }), h('b', { text: String(holders.filter(function (x) { return x.ins || x.dev; }).length) })]),
          h('div', { class: 'wh-kpi' }, [h('span', { text: 'Whale moves' }), h('b', { text: String(moves.length) })])
        ]));
        kids.push(h('div', { class: 'wh-tbl-wrap' }, [h('table', { class: 'wh-tbl' }, [
          h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: '#' }), h('th', { scope: 'col', text: 'Wallet' }), h('th', { scope: 'col', class: 'n', text: '% supply' }), h('th', { scope: 'col', class: 'n', text: 'USD' })])]),
          h('tbody', null, holders.map(function (x, i) {
            var who = [wallet(x.o)];
            if (x.dev) who.push(h('span', { class: 'wb dev', text: 'Dev' })); else if (x.ins) who.push(h('span', { class: 'wb ins', text: 'Insider' }));
            return h('tr', null, [h('td', { text: String(i + 1) }), h('td', null, [h('span', { class: 'who' }, who)]), h('td', { class: 'n', text: pc(x.pct) }), h('td', { class: 'n', text: MG.usd(x.usd) })]);
          }))
        ])]));
      } else {
        kids.push(h('p', { class: 'muted', text: !r[0] ? 'Holder data is unavailable right now — retrying.' : /Rugged|pulled/i.test(($('cStatus') || {}).textContent || '') ? 'Holder tracking stops once a call is marked rugged.' : r[0].coins && !coin && Date.now() - Date.parse($('cCalled') ? $('cCalled').getAttribute('datetime') : '') > 7 * 864e5 ? 'Holder tracking covers the first 7 days after a call.' : 'Holder snapshot not ready yet — it builds up over the next bot runs (~15–25 min each).' }));
      }
      if (moves.length) kids.push(h('ol', { class: 'wh-moves' }, moves.map(function (m) {
        var k = KIND[m.k], ge = m.min ? '≥' : '';
        return h('li', { class: 'wh-mv' + (m.al ? ' al' : '') }, [
          h('span', { class: 'wh-ico', 'aria-hidden': 'true', text: k[0] }),
          h('div', { class: 'wh-l1' }, [h('span', { class: 'k-' + m.k, text: k[1] })].concat(m.dev ? [h('span', { class: 'wb dev', text: 'Dev' })] : m.ins ? [h('span', { class: 'wb ins', text: 'Insider' })] : [])),
          h('time', { class: 'wh-t', datetime: m.t, text: MG.ago(m.t) }),
          h('div', { class: 'wh-l2' }, [wallet(m.o), ' · ' + ge + MG.usd(m.usd) + ' · ' + ge + pc(m.dp) + ' of supply · now ' + pc(m.k === 'exit' ? 0 : m.hp)])
        ]);
      })));
      kids.push(h('p', { class: 'wh-src' }, [h('a', { href: '/whales/?ca=' + ca + '#lookup', text: 'Full holder lookup →' }), ' · ', h('a', { href: '/whales/', text: 'All whales' })]));
      var sec = h('section', { class: 'card coin-wh', id: 'coinWh', 'aria-label': 'Top holders' }, kids);
      // Insert below the short note (not between the coin card and the note) so late-arriving holder data
      // doesn't shove visible content down (CLS). Refreshes swap in place.
      var cur = $('coinWh'), art = $('coin');
      if (cur && cur.parentNode) { cur.parentNode.replaceChild(sec, cur); return; }
      var note = art && art.parentNode ? art.parentNode.querySelector(':scope > .note') : null;
      var anchor = note || art;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor.nextSibling);
    });
  }
  whales();
  load();
  setInterval(function () { if (!document.hidden) { load(); whales(); } }, Math.max(30, MG.num(MG.CFG.refreshSeconds) || 60) * 1000);
})();

// Avatar uses a small DexScreener CDN size; if the CDN refuses it, fall back to the original once, then hide.
(function () {
  var av = document.querySelector('#coin img.ava'); if (!av) return;
  var orig = null;
  function fail() {
    var src = av.getAttribute('src') || '';
    if (!orig && /[?&]width=\d+/.test(src)) { orig = src.replace(/\?.*$/, '?width=800&height=800&quality=95&format=auto'); av.setAttribute('src', orig); return; }
    av.style.visibility = 'hidden';
  }
  av.addEventListener('error', fail);
  if (av.complete && av.naturalWidth === 0) fail();
})();
