// Tip card: copy the full SOL address (works with or without common.js).
(function () {
  'use strict';
  var RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function toast(msg) {
    if (window.MG && window.MG.toast) return window.MG.toast(msg);
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function copy(text, btn) {
    var label = btn.textContent;
    var done = function () { toast('Tip address copied 💎'); btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = label; }, 1500); };
    var fallback = function () {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? done() : toast('Copy failed — long-press the address'); } catch (e) { toast('Copy failed — long-press the address'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  var btns = document.querySelectorAll('.tip-copy');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function (e) {
      var a = e.currentTarget.getAttribute('data-tip') || '';
      if (RE.test(a)) copy(a, e.currentTarget);
    });
  }
})();
