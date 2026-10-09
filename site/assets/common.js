/* MaxiGems shared helpers + header/CTA/footer wiring for every page. Exposes window.MG. No innerHTML with data. */
(function () {
  'use strict';
  var CFG = Object.assign({ telegramUrl: 'https://t.me/maxigems_calls', chatUrl: 'https://t.me/MGcalls_gc', xUrl: 'https://x.com/maxigems_sol', dataUrl: '/data/calls.json', refreshSeconds: 60 }, window.MAXIGEMS_CONFIG || {});
  var SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var DEX_NAMES = { pumpswap: 'PumpSwap', pumpfun: 'Pump.fun', raydium: 'Raydium', meteora: 'Meteora', meteoradbc: 'Meteora DBC', launchlab: 'LaunchLab', orca: 'Orca' };
  var IMG_RE = /^https:\/\/(cdn\.dexscreener\.com|dd\.dexscreener\.com|assets\.geckoterminal\.com|coin-images\.coingecko\.com)\//;
  function $(id) { return document.getElementById(id); }
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
  function safeHttpUrl(u) { try { var x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; } }
  function telegramHref(u) { var s = safeHttpUrl(u); return s && /^https:\/\/(t\.me|telegram\.me)\//.test(s) ? s : null; }
  function xHref(u) { var s = safeHttpUrl(u); return s && /^https:\/\/(www\.)?(x|twitter)\.com\//.test(s) ? s : null; }
  function imgUrl(u) { return u && IMG_RE.test(String(u)) ? safeHttpUrl(u) : null; }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); });
    return el;
  }
  function usd(v) {
    var n = num(v); if (n === null) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  }
  function pct(v) { var n = num(v); if (n === null) return '—'; return (n > 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 100 ? 0 : 1) + '%'; }
  function xf(v) { var n = num(v); if (n === null || n <= 0) return '—'; return (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + 'x'; }
  function ago(iso) {
    var t = typeof iso === 'number' ? iso : Date.parse(iso); if (!isFinite(t)) return '—';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function clean(s, max) { s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
  function dexName(d) { return DEX_NAMES[d] || (d ? d.charAt(0).toUpperCase() + d.slice(1) : 'DEX'); }
  function links(ca, pair) {
    var p = SOL_RE.test(pair || '') ? pair : ca;
    return { dexscreener: 'https://dexscreener.com/solana/' + p, solscan: 'https://solscan.io/token/' + ca, jupiter: 'https://jup.ag/swap/SOL-' + ca, birdeye: 'https://birdeye.so/token/' + ca + '?chain=solana' };
  }
  var tt;
  function toast(msg) { var t = $('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1800); }
  function copy(text, btn) {
    var label = btn ? btn.textContent : '';
    var done = function () { toast('Contract address copied'); if (btn) { btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = label; }, 1500); } };
    function legacy() {
      var ta = h('textarea', { readonly: '', 'aria-hidden': 'true' }); ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — long-press to copy'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, legacy); else legacy();
  }
  function avatar(img, symbol, size) {
    var fb = h('div', { class: 'ava', 'aria-hidden': 'true', text: (symbol || '?').charAt(0).toUpperCase() });
    if (!img) return fb;
    var el = h('img', { class: 'ava', src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', width: size || 46, height: size || 46 });
    el.addEventListener('error', function () { if (el.parentNode) el.parentNode.replaceChild(fb, el); });
    return el;
  }

  // ---- header / CTA / footer wiring (every page) ----
  function wire() {
    var tg = telegramHref(CFG.telegramUrl) || 'https://t.me/maxigems_calls';
    var chat = telegramHref(CFG.chatUrl), xu = xHref(CFG.xUrl);
    [['tgBtn', tg], ['ftrTg', tg]].forEach(function (p) { if ($(p[0])) $(p[0]).href = p[1]; });
    ['chatBtn', 'ftrChat'].forEach(function (id) { var el = $(id); if (!el) return; if (chat) el.href = chat; else el.hidden = true; });
    ['xBtn', 'ftrX'].forEach(function (id) { var el = $(id); if (!el) return; if (xu) el.href = xu; else el.hidden = true; });
    var cta = document.querySelector('.cta'); if (cta && (!chat !== !xu)) cta.classList.add('one');
    if ($('yr')) $('yr').textContent = new Date().getFullYear();
    // active nav item (fallback if aria-current not set in markup)
    var path = location.pathname.replace(/index\.html$/, '');
    Array.prototype.forEach.call(document.querySelectorAll('.nav a'), function (a) {
      var href = a.getAttribute('href');
      if ((href === '/' && path === '/') || (href !== '/' && path.indexOf(href) === 0)) a.setAttribute('aria-current', 'page');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.MG = { CFG: CFG, SOL_RE: SOL_RE, $: $, num: num, h: h, usd: usd, pct: pct, xf: xf, ago: ago, clean: clean, dexName: dexName, links: links, copy: copy, toast: toast, avatar: avatar, imgUrl: imgUrl, safeHttpUrl: safeHttpUrl };
})();
