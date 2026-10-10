// Tip card: copy the full SOL address (works with or without common.js) and open the lazy-loaded wallet tip modal.
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
  // "Tip with wallet": lazy-load the wallet bundle (only when asked), then open the modal.
  var loading = null;
  function loadBundle(src) {
    if (window.MGTipWallet) return Promise.resolve(window.MGTipWallet);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (!/^\/assets\/tip-wallet\.js(\?v=[0-9a-f]{1,16})?$/.test(src)) return reject(new Error('bad bundle path'));
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = function () { window.MGTipWallet ? resolve(window.MGTipWallet) : reject(new Error('bundle')); };
      s.onerror = function () { reject(new Error('load')); };
      document.head.appendChild(s);
    });
    loading.catch(function () { loading = null; });
    return loading;
  }
  function openTip(btn) {
    var label = btn.getAttribute('data-label') || btn.textContent; btn.setAttribute('data-label', label);
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Loading…';
    loadBundle(btn.getAttribute('data-bundle') || '/assets/tip-wallet.js').then(function (w) { w.open(btn); }, function () {
      toast('Couldn’t load the wallet module — check your connection and try again.');
    }).then(function () { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = label; });
  }
  var wb = document.querySelectorAll('.tip-wallet-btn');
  for (var k = 0; k < wb.length; k++) wb[k].addEventListener('click', function (e) { openTip(e.currentTarget); });
  // Opened from a wallet's in-app browser deep link (?tip=1): open the modal straight away.
  try { if (wb.length && new URLSearchParams(location.search).get('tip') === '1') openTip(wb[0]); } catch (e) { /* ignore */ }
})();
