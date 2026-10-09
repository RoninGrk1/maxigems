/* MaxiGems share sheet (X / Telegram / Discord / download card / copy link / native share).
   Exposes MG.openShare(info) and MG.shareButton(info, cls). DOM built with createElement/textContent only. */
(function () {
  'use strict';
  var MG = window.MG; if (!MG) return;
  var h = MG.h, SOL_RE = MG.SOL_RE;
  var SITE = 'https://maxigems.fun';
  var sheet = null, lastFocus = null, blobCache = {};

  function xf(v) { var n = MG.num(v); if (n === null || n <= 0) return '1.00x'; return (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + 'x'; }
  function info(raw) {
    if (!raw || !SOL_RE.test(raw.ca || '')) return null;
    var sym = MG.clean(String(raw.symbol || '').replace(/^\$/, ''), 16) || '???';
    var url = SITE + '/c/' + raw.ca + '/';
    return { ca: raw.ca, symbol: sym, url: url, card: '/c/' + raw.ca + '/card.png', text: '$' + sym + ' called by @maxigems_sol 💎 ' + xf(raw.peak) + ' peak since call' };
  }
  function copyText(text, msg) {
    function ok() { MG.toast(msg); }
    function legacy() {
      var ta = h('textarea', { readonly: '', 'aria-hidden': 'true' }); ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { MG.toast('Copy failed — long-press the link'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, legacy); else legacy();
  }
  function close() {
    if (!sheet) return;
    sheet.classList.remove('open');
    var s = sheet; sheet = null;
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 200);
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab' && sheet) { // focus trap
      var f = sheet.querySelectorAll('a[href],button:not([hidden])'); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function opt(tag, cls, label, sub, attrs) {
    var a = h(tag, Object.assign({ class: 'sh-opt ' + cls }, attrs || {}), [h('span', { class: 'sh-ic', 'aria-hidden': 'true' }), h('span', { class: 'sh-t' }, [h('b', { text: label }), h('small', { text: sub })])]);
    return a;
  }

  function openShare(raw) {
    var s = info(raw); if (!s) return;
    close();
    lastFocus = document.activeElement;
    var tw = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(s.text) + '&url=' + encodeURIComponent(s.url);
    var tg = 'https://t.me/share/url?url=' + encodeURIComponent(s.url) + '&text=' + encodeURIComponent(s.text);
    var bX = opt('a', 'sh-x', 'Post on X', 'Tweet with card preview', { href: tw, target: '_blank', rel: 'noopener noreferrer' });
    var bT = opt('a', 'sh-tg', 'Telegram', 'Share to a chat', { href: tg, target: '_blank', rel: 'noopener noreferrer' });
    var bD = opt('button', 'sh-dc', 'Discord', 'Copy link — card unfurls', { type: 'button' });
    bD.addEventListener('click', function () { copyText(s.url, 'Link copied — paste in Discord to show the card'); });
    var bDl = opt('a', 'sh-dl', 'Save image', '1200×630 PNG card', { href: s.card, download: 'maxigems-' + s.symbol.replace(/[^A-Za-z0-9_-]/g, '') + '.png' });
    var bC = opt('button', 'sh-cp', 'Copy link', s.url.replace('https://', ''), { type: 'button' });
    bC.addEventListener('click', function () { copyText(s.url, 'Link copied'); });
    var bN = opt('button', 'sh-nv', 'More…', 'Share with your apps', { type: 'button', hidden: !navigator.share });
    bN.addEventListener('click', function () {
      var data = { title: 'MaxiGems — $' + s.symbol, text: s.text, url: s.url };
      var b = blobCache[s.ca];
      if (b && window.File) {
        try {
          var file = new File([b], 'maxigems-' + s.symbol.replace(/[^A-Za-z0-9_-]/g, '') + '.png', { type: 'image/png' });
          if (navigator.canShare && navigator.canShare({ files: [file] })) data.files = [file];
        } catch (e) { /* no file share */ }
      }
      navigator.share(data).catch(function () { /* cancelled */ });
    });
    var preview = h('img', { class: 'sh-prev', src: s.card, alt: 'Share card preview for $' + s.symbol, width: 1200, height: 630, decoding: 'async' });
    preview.addEventListener('error', function () { preview.hidden = true; bDl.hidden = true; });
    var closeBtn = h('button', { class: 'sh-close', type: 'button', 'aria-label': 'Close share sheet', text: '✕' });
    closeBtn.addEventListener('click', close);
    var panel = h('div', { class: 'sh-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shTitle' }, [
      h('div', { class: 'sh-grab', 'aria-hidden': 'true' }),
      h('div', { class: 'sh-head' }, [h('h2', { id: 'shTitle', text: 'Share $' + s.symbol }), closeBtn]),
      preview,
      h('div', { class: 'sh-grid' }, [bX, bT, bD, bDl, bC, bN])
    ]);
    sheet = h('div', { class: 'sh-wrap' }, [h('div', { class: 'sh-back' }), panel]);
    sheet.firstChild.addEventListener('click', close);
    document.body.appendChild(sheet);
    requestAnimationFrame(function () { if (sheet) sheet.classList.add('open'); });
    document.addEventListener('keydown', onKey);
    bX.focus();
    // prefetch the card so native share can attach it inside the click gesture
    if (!blobCache[s.ca] && window.fetch) fetch(s.card, { cache: 'force-cache' }).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (b) { if (b && b.type === 'image/png') blobCache[s.ca] = b; }).catch(function () { bDl.hidden = true; });
  }
  function shareButton(raw, cls) {
    var b = h('button', { class: 'share-btn' + (cls ? ' ' + cls : ''), type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Share $' + (raw && raw.symbol || ''), text: 'Share' });
    b.addEventListener('click', function () { openShare(raw); });
    return b;
  }
  MG.openShare = openShare; MG.shareButton = shareButton; MG.closeShare = close;
})();
