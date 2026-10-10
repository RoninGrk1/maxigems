/* MaxiGems Pro — header "Sign in" / 💎 Pro badge, account drawer, and window.MGPro for pages (lazy-loads /assets/pay.js).
   Free stays free: nothing here ever hides calls. DOM via textContent only. */
(function () {
  'use strict';
  var CFG = window.MAXIGEMS_CONFIG || {};
  var API = String(CFG.proApi || '').replace(/\/+$/, '');
  var PAY_SRC = '/assets/pay.js?v=e09e4e5ebe'; // rewritten by `npm run build:pay`
  var KEY = 'mg.session.v1';
  var RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { var v = attrs[k]; if (v === null || v === undefined || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function short(a) { return a.slice(0, 4) + '…' + a.slice(-4); }
  function toast(m) { if (window.MG && window.MG.toast) window.MG.toast(m); }

  function session() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || typeof s.token !== 'string' || !RE.test(s.wallet || '')) return null;
      var exp = Date.parse(s.expiresAt); if (!isFinite(exp) || exp - 60000 <= Date.now()) { localStorage.removeItem(KEY); return null; }
      return s;
    } catch (e) { return null; }
  }
  var loading = null;
  function load() {
    if (window.MGPay) return Promise.resolve(window.MGPay);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (!/^\/assets\/pay\.js(\?v=[0-9a-f]{1,16})?$/.test(PAY_SRC)) return reject(new Error('bad bundle path'));
      var s = document.createElement('script'); s.src = PAY_SRC; s.async = true;
      s.onload = function () { window.MGPay ? resolve(window.MGPay) : reject(new Error('bundle')); };
      s.onerror = function () { reject(new Error('load')); };
      document.head.appendChild(s);
    });
    loading.catch(function () { loading = null; });
    return loading;
  }
  function call(path, opts) {
    opts = opts || {};
    if (!/^https:\/\//.test(API)) return Promise.reject(new Error('Pro service not configured'));
    var s = session(), ctrl = window.AbortController ? new AbortController() : null;
    var t = ctrl && setTimeout(function () { ctrl.abort(); }, 12000);
    var headers = { 'content-type': 'application/json' };
    if (s) headers.authorization = 'Bearer ' + s.token;
    return fetch(API + '/' + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._http = r.status; if (r.status === 401 && s) { try { localStorage.removeItem(KEY); } catch (e) { /* */ } } return j; }); })
      .finally(function () { if (t) clearTimeout(t); });
  }
  // account status, cached 60s (one request per page view)
  var st = { p: null, at: 0, data: null };
  function status(force) {
    if (!force && st.p && Date.now() - st.at < 60000) return st.p;
    st.at = Date.now();
    st.p = call('account').then(function (j) { st.data = j && j._http === 200 ? j : { offline: true }; return st.data; }, function () { st.data = { offline: true }; return st.data; });
    return st.p;
  }
  /** Live Pro data: {whaleMoves, watchlist} for Pro, else {locked:true, http}. Never throws. */
  function proData() {
    if (!session()) return Promise.resolve({ locked: true, http: 401 });
    return call('pro-data').then(function (j) { return j._http === 200 ? j : { locked: true, http: j._http, expired: !!j.expired }; }, function () { return { locked: true, http: 0 }; });
  }
  function isPro(d) { return !!(d && d.pro && d.pro.active); }

  // ---------------------------------------------------------------- header button + drawer
  var btn = null, drawer = null;
  function paint() {
    if (!btn) return;
    var s = session(), d = st.data;
    btn.classList.remove('is-pro');
    if (!s) { btn.textContent = 'Sign in'; btn.setAttribute('aria-label', 'Sign in with your Solana wallet'); return; }
    if (isPro(d) && d.wallet === s.wallet) {
      btn.classList.add('is-pro');
      btn.textContent = '';
      btn.appendChild(h('span', { 'aria-hidden': 'true', text: '💎' }));
      btn.appendChild(document.createTextNode(' Pro'));
      btn.appendChild(h('span', { class: 'acct-days', text: ' · ' + d.pro.daysLeft + 'd' }));
      btn.setAttribute('aria-label', 'MaxiGems Pro, ' + d.pro.daysLeft + ' days left — open account');
    } else { btn.textContent = short(s.wallet); btn.setAttribute('aria-label', 'Account ' + short(s.wallet)); }
  }
  function refresh(force) { return status(force).then(function (d) { paint(); try { window.dispatchEvent(new CustomEvent('mg:pro', { detail: d })); } catch (e) { /* */ } return d; }); }

  function closeDrawer() { if (!drawer) return; drawer.remove(); drawer = null; document.documentElement.classList.remove('tw-open'); document.removeEventListener('keydown', onKey, true); if (btn) btn.focus(); }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); } }
  function row(k, v) { return [h('span', { text: k }), h('b', { text: v })]; }
  function openDrawer() {
    var s = session(); if (!s) return;
    closeDrawer();
    var body = h('div', { class: 'acct-body', 'aria-live': 'polite' }, [h('p', { class: 'tw-p', text: 'Loading your account…' })]);
    var panel = h('aside', { class: 'acct-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'acctTitle' }, [
      h('div', { class: 'tw-head' }, [h('h2', { id: 'acctTitle', text: 'Your MaxiGems account' }), h('button', { type: 'button', class: 'tw-x', 'aria-label': 'Close account', text: '×', onclick: closeDrawer })]), body]);
    drawer = h('div', { class: 'acct-back', onmousedown: function (e) { if (e.target === drawer) closeDrawer(); } }, [panel]);
    document.body.appendChild(drawer); document.documentElement.classList.add('tw-open');
    document.addEventListener('keydown', onKey, true);
    panel.querySelector('.tw-x').focus();
    refresh(true).then(function (d) { if (drawer) renderDrawer(body, s, d); });
  }
  function renderDrawer(body, s, d) {
    var kids = [];
    var kv = h('div', { class: 'tw-kv' }, row('Wallet', short(s.wallet)));
    if (d.offline) {
      kids.push(kv, h('p', { class: 'tw-p', text: 'MaxiGems Pro isn’t live yet — your account will show here once it launches. Calls stay free and instant either way.' }));
    } else {
      var pro = isPro(d);
      row('Plan', pro ? '💎 Pro (' + (d.pro.plan === 'p365' ? '365' : d.pro.plan === 'p90' ? '90' : '30') + ' days)' : 'Free').forEach(function (n) { kv.appendChild(n); });
      if (d.pro && d.pro.expiresAt) row(pro ? 'Expires' : 'Expired', new Date(d.pro.expiresAt).toLocaleString() + (pro ? ' (' + d.pro.daysLeft + ' days left)' : '')).forEach(function (n) { kv.appendChild(n); });
      row('Telegram', d.telegram && d.telegram.linked ? 'Linked ✓' : 'Not linked').forEach(function (n) { kv.appendChild(n); });
      kids.push(kv);
      var acts = h('div', { class: 'acct-acts' });
      acts.appendChild(h('a', { class: 'tw-btn acct-cta', href: '/pro/#plans', text: pro ? 'Extend Pro' : 'Get Pro' }));
      var link = h('button', { type: 'button', class: 'tw-btn tw-ghost', text: d.telegram && d.telegram.linked ? 'Re-link Telegram' : 'Link Telegram' });
      link.addEventListener('click', function () {
        link.disabled = true;
        call('account', { method: 'POST', body: { action: 'tg-link' } }).then(function (j) {
          link.disabled = false;
          if (j.url && /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]+$/.test(j.url)) { window.open(j.url, '_blank', 'noopener'); note.textContent = 'Tap Start in Telegram, then come back and tap “Get Pro group invite”.'; } else note.textContent = j.error || 'Couldn’t create a link.';
        }, function () { link.disabled = false; note.textContent = 'Couldn’t reach MaxiGems Pro.'; });
      });
      acts.appendChild(link);
      if (pro) {
        var inv = h('button', { type: 'button', class: 'tw-btn tw-ghost', text: 'Get Pro group invite' });
        inv.addEventListener('click', function () {
          inv.disabled = true;
          call('account', { method: 'POST', body: { action: 'tg-invite' } }).then(function (j) {
            inv.disabled = false;
            if (j.url && /^https:\/\/t\.me\/\+[A-Za-z0-9_-]+$/.test(j.url)) { note.textContent = 'Your single-use invite (valid 24h): '; note.appendChild(h('a', { href: j.url, target: '_blank', rel: 'noopener noreferrer', text: 'Join the Pro group ↗' })); } else note.textContent = j.error || 'Couldn’t create an invite.';
          }, function () { inv.disabled = false; note.textContent = 'Couldn’t reach MaxiGems Pro.'; });
        });
        acts.appendChild(inv);
      }
      kids.push(acts);
    }
    var note = h('p', { class: 'tw-p acct-note', role: 'status' });
    kids.push(note);
    kids.push(h('div', { class: 'tw-acts' }, [h('button', { type: 'button', class: 'tw-btn tw-ghost', text: 'Sign out', onclick: function () { try { localStorage.removeItem(KEY); } catch (e) { /* */ } if (window.MGPay) window.MGPay.signOut(); st.p = null; closeDrawer(); refresh(true); toast('Signed out'); } })]));
    kids.push(h('p', { class: 'tw-fine', text: 'Calls are free and instant for everyone. Pro adds extras only. Not financial advice.' }));
    body.replaceChildren.apply(body, kids);
  }
  function onBtn() {
    if (session()) return openDrawer();
    btn.disabled = true;
    load().then(function (p) { btn.disabled = false; return p.signIn(); }, function () { btn.disabled = false; toast('Couldn’t load the wallet module — try again.'); })
      .then(function (s) { if (s) { st.p = null; refresh(true); } }, function () { /* cancelled */ });
  }
  function mount() {
    var hdr = document.querySelector('.hdr-in'); if (!hdr || $('acctBtn')) return;
    btn = h('button', { type: 'button', class: 'acct-btn', id: 'acctBtn', 'aria-haspopup': 'dialog' });
    btn.addEventListener('click', onBtn);
    hdr.appendChild(btn);
    paint();
    if (session()) refresh(false);
  }
  window.addEventListener('mg:session', function () { st.p = null; refresh(true); });
  window.addEventListener('storage', function (e) { if (e.key === KEY) { st.p = null; refresh(true); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.MGPro = { load: load, session: session, status: status, refresh: refresh, proData: proData, isPro: isPro, call: call };
  window.MGProLoad = load;
})();
