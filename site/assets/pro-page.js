/* /pro/ page: enables the plan buttons only when payments are open (site flag AND server flag), or for an allow-listed
   test wallet (server says testWallet → 0.001 SOL test price). Otherwise the buttons stay "Coming soon". */
(function () {
  'use strict';
  var CFG = window.MAXIGEMS_CONFIG || {};
  var btns = document.querySelectorAll('[data-buy]');
  var state = document.getElementById('payState');
  var PLANS = { p30: 1, p90: 1, p365: 1 };
  function set(open, test, d) {
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.disabled = !open;
      b.textContent = !open ? 'Coming soon' : test ? 'Test purchase (0.001 SOL)' : (d && d.pro && d.pro.active ? 'Extend Pro' : 'Get Pro');
    }
    if (state) state.textContent = !open ? 'Payments open soon. Calls stay free in the meantime, and always will.'
      : test ? 'Test mode: your wallet is allow-listed, so each plan costs 0.001 SOL.'
        : d && d.pro && d.pro.active ? '💎 You’re Pro: ' + d.pro.daysLeft + ' days left. Extending adds days on top.' : 'Pick a pass. You’ll approve the exact amount in your wallet.';
  }
  function update(d) {
    d = d || {};
    var test = !!d.testWallet;
    var open = !d.offline && ((CFG.paymentsEnabled === true && d.paymentsEnabled === true) || test);
    set(open, test && !(CFG.paymentsEnabled === true && d.paymentsEnabled === true), d);
  }
  set(false);
  for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function (e) {
    var plan = e.currentTarget.getAttribute('data-buy'); if (!PLANS[plan] || !window.MGPro) return;
    var b = e.currentTarget, label = b.textContent; b.disabled = true; b.textContent = 'Opening wallet…';
    window.MGPro.load().then(function (pay) { return pay.payOrder({ kind: 'pro', plan: plan }); })
      .then(function () { return window.MGPro.refresh(true); }, function () { /* cancelled or shown in the modal */ })
      .then(function () { b.disabled = false; b.textContent = label; window.MGPro.status().then(update); });
  });
  window.addEventListener('mg:pro', function (e) { update(e.detail); });
  if (window.MGPro) window.MGPro.status().then(update);
  else document.addEventListener('DOMContentLoaded', function () { if (window.MGPro) window.MGPro.status().then(update); });
})();
