// Tip card: copy the full SOL address (works with or without common.js) and give feedback when
// a solana: link opens nothing (desktop without a wallet app).
(function () {
  'use strict';
  var RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function toast(msg) {
    if (window.MG && window.MG.toast) return window.MG.toast(msg);
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function copy(text, btn) {
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', label); // keep the original label across rapid double clicks
    var done = function () { toast('Tip address copied 💎'); btn.textContent = 'Copied ✓'; clearTimeout(btn._t); btn._t = setTimeout(function () { btn.textContent = label; }, 1500); };
    var fail = function () { toast('Copy failed — long-press the address to copy it'); };
    var fallback = function () {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.setAttribute('aria-hidden', 'true');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
      document.body.appendChild(ta); ta.focus(); ta.select(); try { ta.setSelectionRange(0, text.length); } catch (e) { /* old iOS */ }
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } // keyboard users keep their place
      ok ? done() : fail();
    };
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  var btns = document.querySelectorAll('.tip-copy');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function (e) {
      var a = e.currentTarget.getAttribute('data-tip') || '';
      if (RE.test(a)) copy(a, e.currentTarget);
    });
  }
  // solana: links do nothing on a desktop without a wallet app: if the page keeps focus, point to the QR / Copy.
  var links = document.querySelectorAll('.tip a[href^="solana:"]');
  for (var j = 0; j < links.length; j++) {
    links[j].addEventListener('click', function (e) {
      var card = e.currentTarget.closest('.tip');
      var left = false, mark = function () { left = true; };
      window.addEventListener('blur', mark, { once: true });
      document.addEventListener('visibilitychange', mark, { once: true });
      setTimeout(function () {
        window.removeEventListener('blur', mark); document.removeEventListener('visibilitychange', mark);
        if (left || document.hidden) return;
        var qr = card && card.querySelector('.tip-qr');
        if (qr) {
          toast('No wallet app opened? Scan the QR code with your phone’s wallet.');
          qr.classList.add('tip-flash'); setTimeout(function () { qr.classList.remove('tip-flash'); }, 2400);
          if (qr.getBoundingClientRect().bottom > window.innerHeight) qr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else toast('No wallet app opened? Copy the address, or scan the QR on the home page.');
      }, 1600);
    });
  }
})();
