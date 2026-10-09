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
  load();
  setInterval(function () { if (!document.hidden) load(); }, Math.max(30, MG.num(MG.CFG.refreshSeconds) || 60) * 1000);
})();
