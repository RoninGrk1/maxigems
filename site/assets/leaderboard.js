/* MaxiGems leaderboard page — renders from /data/calls.json. textContent / createElement only (XSS-safe). */
(function () {
  'use strict';
  var MG = window.MG, LB = window.MGLB;
  var $ = MG.$, h = MG.h, num = MG.num, usd = MG.usd, xf = MG.xf, clean = MG.clean;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var state = { calls: [], period: '7d', q: '', key: 'peak', dir: 'desc', lastOk: 0, updatedAt: null };

  try { var sp = new URLSearchParams(location.search).get('p'); if (sp && LB.PERIODS[sp] !== undefined) state.period = sp; } catch (e) { /* ignore */ }

  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || !MG.SOL_RE.test(raw.address || '')) return null;
    var calledTs = Date.parse(raw.calledAt);
    if (!isFinite(calledTs)) return null;
    var athAt = Date.parse(raw.athAt || raw.peakAt);
    var c = {
      address: raw.address,
      pairAddress: MG.SOL_RE.test(raw.pairAddress || '') ? raw.pairAddress : null,
      name: clean(raw.name, 40) || clean(raw.symbol, 20) || 'Unknown',
      symbol: clean(raw.symbol, 16).replace(/^\$/, '') || '???',
      img: MG.imgUrl(raw.imageUrl),
      calledAt: new Date(calledTs).toISOString(),
      mcAtCall: num(raw.mcAtCall), currentMc: num(raw.currentMc),
      athMultiple: num(raw.athMultiple), currentMultiple: num(raw.currentMultiple),
      liquidity: num(raw.liquidity), currentLiquidity: num(raw.currentLiquidity),
      status: raw.status === 'rugged' ? 'rugged' : 'active',
      athAt: isFinite(athAt) ? new Date(Math.max(athAt, calledTs)).toISOString() : null
    };
    var peakMc = num(raw.athMc != null ? raw.athMc : raw.peakMc);
    c.athMc = peakMc !== null && peakMc > 0 ? peakMc : (c.mcAtCall !== null ? c.mcAtCall * LB.peakX(c) : null);
    return c;
  }

  function peakIn(c) {
    if (!c.athAt) return null;
    return dur(Date.parse(c.athAt) - Date.parse(c.calledAt));
  }
  function dur(ms) {
    if (!isFinite(ms)) return null;
    if (ms < 60e3) return 'at call';
    var m = ms / 60e3;
    if (m < 60) return '+' + Math.round(m) + 'm';
    if (m < 1440) return '+' + (m / 60).toFixed(m < 600 ? 1 : 0).replace(/\.0$/, '') + 'h';
    return '+' + (m / 1440).toFixed(1).replace(/\.0$/, '') + 'd';
  }
  function when(iso) {
    var d = new Date(iso);
    try { return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function xClass(v) { v = num(v); return v === null ? 'flat' : v >= 1.05 ? 'up' : v < 0.95 ? 'down' : 'flat'; }
  var STATUS = { live: ['Live', 'st-live'], rugged: ['Rugged', 'st-rug'], pulled: ['Liquidity pulled', 'st-pull'] };
  function statusBadge(c) { var s = STATUS[LB.statusOf(c)]; return h('span', { class: 'badge st ' + s[1], text: s[0] }); }
  function linkRow(c) {
    var L = MG.links(c.address, c.pairAddress);
    return h('div', { class: 'lnk' }, [
      h('a', { class: 'pri', href: L.dexscreener, target: '_blank', rel: 'noopener noreferrer', text: 'Chart' }),
      h('a', { href: L.solscan, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan' }),
      h('a', { href: L.jupiter, target: '_blank', rel: 'noopener noreferrer', text: 'Buy' }),
      MG.shareButton ? MG.shareButton({ ca: c.address, symbol: c.symbol, peak: LB.peakX(c) }) : null
    ]);
  }
  function tokenCell(c, size) {
    return h('div', { class: 'tok' }, [MG.avatar(c.img, c.symbol, size || 36), h('div', { class: 'tok-t' }, [
      h('div', { class: 'nm', text: c.name }), h('div', { class: 'sym', text: '$' + c.symbol })
    ])]);
  }

  function renderStats(list) {
    var s = LB.stats(list);
    $('sTotal').textContent = String(s.total);
    [2, 5, 10].forEach(function (m) { $('sH' + m).textContent = s.total ? s.hits[m].count + ' (' + Math.round(s.hits[m].pct) + '%)' : '—'; });
    $('sAvg').textContent = s.avgPeak === null ? '—' : xf(s.avgPeak);
    $('sMed').textContent = s.medianPeak === null ? '—' : xf(s.medianPeak);
    $('sBest').textContent = s.best ? '$' + s.best.symbol + ' ' + xf(s.bestPeak) : '—';
    $('sBest').title = s.best ? s.best.name : '';
    $('sRug').textContent = s.total ? s.rugs.count + ' (' + Math.round(s.rugs.pct) + '%)' : '—';
  }

  function renderPodium(list) {
    var el = $('podium'); el.textContent = '';
    var top = LB.ranked(list).slice(0, 3);
    el.hidden = !top.length;
    var medals = ['🥇', '🥈', '🥉'], cls = ['gold', 'silver', 'bronze'];
    top.forEach(function (r, i) {
      var c = r.call, pk = LB.peakX(c);
      el.appendChild(h('article', { class: 'pod ' + cls[i] }, [
        h('div', { class: 'medal', 'aria-hidden': 'true', text: medals[i] }),
        h('div', { class: 'pod-rank', text: '#' + r.rank }),
        tokenCell(c, 52),
        h('div', { class: 'pod-x', text: xf(pk) }),
        h('div', { class: 'pod-m' }, [usd(c.mcAtCall) + ' → ' + usd(c.athMc)]),
        h('div', { class: 'pod-m muted' }, ['Called ' + MG.ago(c.calledAt) + (peakIn(c) ? ' · peak ' + peakIn(c) : '')]),
        h('div', { class: 'pod-act' }, [statusBadge(c), MG.shareButton ? MG.shareButton({ ca: c.address, symbol: c.symbol, peak: pk }) : null])
      ]));
    });
  }

  function svg(tag, attrs, text) {
    var el = document.createElementNS(SVGNS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  }
  function renderChart(list) {
    var box = $('chart'); box.textContent = '';
    var calls = LB.sortCalls(list, 'called', 'asc');
    $('chartNote').textContent = calls.length ? calls.length + ' calls · oldest → newest · log scale' : '';
    if (!calls.length) { box.appendChild(h('p', { class: 'muted', text: 'No calls in this period yet.' })); return; }
    var W = Math.max(240, box.clientWidth || 600), H = 160, padL = 30, padB = 6, padT = 8;
    var maxX = Math.max(10, Math.max.apply(null, calls.map(LB.peakX)));
    var lmax = Math.log(maxX);
    function y(v) { return padT + (H - padT - padB) * (1 - Math.log(Math.max(1, v)) / lmax); }
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'Bar chart of peak multiple per call', class: 'bars' });
    [1, 2, 5, 10, 50, 100].filter(function (v) { return v <= maxX; }).forEach(function (v) {
      s.appendChild(svg('line', { x1: padL, x2: W, y1: y(v), y2: y(v), class: 'gl' + (v === 2 ? ' g2' : '') }));
      s.appendChild(svg('text', { x: 2, y: y(v) + 4, class: 'gt' }, v + 'x'));
    });
    var bw = (W - padL) / calls.length;
    calls.forEach(function (c, i) {
      var pk = LB.peakX(c), st = LB.statusOf(c), top = y(Math.max(pk, 1.03));
      var r = svg('rect', { x: (padL + i * bw + bw * 0.15).toFixed(1), y: top.toFixed(1), width: (bw * 0.7).toFixed(1), height: Math.max(1, H - padB - top).toFixed(1), rx: 2, class: 'bar ' + (st !== 'live' ? 'rug' : pk >= 2 ? 'hit' : 'base') });
      r.appendChild(svg('title', {}, '$' + c.symbol + ' — peak ' + xf(pk) + (st !== 'live' ? ' (' + STATUS[st][0] + ')' : '')));
      s.appendChild(r);
    });
    box.appendChild(s);
    box.appendChild(h('div', { class: 'legend' }, [h('span', { class: 'lg hit', text: '≥ 2x' }), h('span', { class: 'lg base', text: '< 2x' }), h('span', { class: 'lg rug', text: 'Rugged / pulled' })]));
  }

  function renderTable(list) {
    var tb = $('rows'); tb.textContent = '';
    var rk0 = LB.ranked(list), rankOf = new Map(rk0.map(function (r) { return [r.call, r.rank]; }));
    var rows = LB.sortCalls(rk0.map(function (r) { return r.call; }).filter(function (c) { return LB.matches(c, state.q); }), state.key, state.dir);
    $('empty').hidden = rows.length > 0;
    $('empty').textContent = !list.length ? 'No calls in this period yet — try a longer period.' : 'No calls match your search.';
    rows.forEach(function (c) {
      var pk = LB.peakX(c), rk = rankOf.get(c);
      var pin = peakIn(c);
      tb.appendChild(h('tr', { class: LB.statusOf(c) !== 'live' ? 'is-rug' : null }, [
        h('td', { class: 'c-rank' + (rk <= 3 ? ' top' + rk : ''), 'data-label': 'Rank', text: '#' + rk }),
        h('td', { class: 'c-tok', 'data-label': 'Token' }, [tokenCell(c)]),
        h('td', { 'data-label': 'Called' }, [h('span', { text: MG.ago(c.calledAt) }), h('small', { text: when(c.calledAt) })]),
        h('td', { class: 'num', 'data-label': 'MC at call', text: usd(c.mcAtCall) }),
        h('td', { class: 'num', 'data-label': 'Peak MC' }, [h('span', { text: usd(c.athMc) }), pin ? h('small', { text: 'peak ' + pin }) : null]),
        h('td', { class: 'num', 'data-label': 'Peak x' }, [h('b', { class: 'x ' + xClass(pk), text: xf(pk) })]),
        h('td', { class: 'num', 'data-label': 'Now x' }, [h('span', { class: xClass(c.currentMultiple) === 'down' ? 'neg' : xClass(c.currentMultiple) === 'up' ? 'pos' : '', text: xf(c.currentMultiple) })]),
        h('td', { 'data-label': 'Status' }, [statusBadge(c)]),
        h('td', { class: 'c-lnk', 'data-label': 'Links' }, [linkRow(c)])
      ]));
    });
    Array.prototype.forEach.call(document.querySelectorAll('.th'), function (b) {
      var on = b.getAttribute('data-k') === state.key;
      b.parentNode.setAttribute('aria-sort', on ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      b.classList.toggle('on', on);
    });
    var sv = state.key + ':' + state.dir;
    if (Array.prototype.some.call($('sort').options, function (o) { return o.value === sv; })) $('sort').value = sv;
    $('board').setAttribute('aria-busy', 'false');
  }

  function render() {
    var list = LB.filterPeriod(state.calls, state.period, Date.now());
    Array.prototype.forEach.call(document.querySelectorAll('#period .chip'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-p') === state.period)); });
    renderStats(list); renderPodium(list); renderChart(list); renderTable(list);
  }

  function setLive(ok, text) { var el = $('live'); if (!el) return; el.className = 'live ' + (ok ? 'ok' : 'err'); $('liveText').textContent = text; }
  function load() {
    var url = MG.CFG.dataUrl + (MG.CFG.dataUrl.indexOf('?') === -1 ? '?' : '&') + 't=' + Math.floor(Date.now() / 30000);
    return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (d) {
      var arr = d && Array.isArray(d.calls) ? d.calls : [];
      var seen = {};
      state.calls = arr.map(sanitize).filter(function (c) { if (!c || seen[c.address]) return false; seen[c.address] = 1; return true; });
      state.lastOk = Date.now();
      state.updatedAt = d && isFinite(Date.parse(d.updatedAt)) ? d.updatedAt : new Date().toISOString();
      setLive(true, 'Live · updated ' + MG.ago(state.updatedAt));
      render();
    }).catch(function () {
      setLive(false, 'Offline · retrying');
      if (!state.lastOk) { $('rows').textContent = ''; $('board').setAttribute('aria-busy', 'false'); $('empty').hidden = false; $('empty').textContent = 'Couldn’t load calls right now — retrying shortly.'; }
    });
  }

  // ---- events ----
  $('period').addEventListener('click', function (e) {
    var b = e.target.closest('[data-p]'); if (!b) return;
    state.period = b.getAttribute('data-p');
    try { var u = new URL(location.href); if (state.period === '7d') u.searchParams.delete('p'); else u.searchParams.set('p', state.period); history.replaceState(null, '', u.pathname + u.search); } catch (err) { /* ignore */ }
    render();
  });
  var qt; $('q').addEventListener('input', function (e) { clearTimeout(qt); var v = e.target.value; qt = setTimeout(function () { state.q = v.slice(0, 64); renderTable(LB.filterPeriod(state.calls, state.period, Date.now())); }, 120); });
  $('sort').addEventListener('change', function (e) { var p = String(e.target.value).split(':'); state.key = p[0]; state.dir = p[1] === 'asc' ? 'asc' : 'desc'; renderTable(LB.filterPeriod(state.calls, state.period, Date.now())); });
  Array.prototype.forEach.call(document.querySelectorAll('.th'), function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-k');
      if (state.key === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc'; else { state.key = k; state.dir = (k === 'token' || k === 'status') ? 'asc' : 'desc'; }
      renderTable(LB.filterPeriod(state.calls, state.period, Date.now()));
    });
  });

  var rt, lastW = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { var w = $('chart').clientWidth; if (state.lastOk && Math.abs(w - lastW) > 4) { lastW = w; renderChart(LB.filterPeriod(state.calls, state.period, Date.now())); } }, 150); });

  load();
  var every = Math.max(20, num(MG.CFG.refreshSeconds) || 60) * 1000;
  setInterval(function () { if (!document.hidden) load(); }, every);
  setInterval(function () { if (state.updatedAt) $('liveText').textContent = 'Live · updated ' + MG.ago(state.updatedAt); }, 15000);
})();
