/* /featured/: CA → server-side safety check + quote → (sign in → pay via MGPay) → status page (?ca=<CA>).
   XSS-safe: DOM via MG.h (textContent only). The server re-checks everything on create-order; this page only displays.
   While payments are disabled (site config OR server flag) the pay button reads "Coming soon". */
(function () {
  'use strict';
  var MG = window.MG; if (!MG) return;
  var h = MG.h, $ = MG.$, CFG = MG.CFG;
  var API = String(CFG.proApi || '').replace(/\/+$/, '');
  var B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
  var PRICE = MG.num(CFG.featuredPriceSol) || 1;

  function when(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '—';
    var d = new Date(t), now = Date.now();
    var s = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (t <= now + 60000) return 'Now';
    var m = Math.round((t - now) / 60000);
    return s + ' (in ' + (m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm') + ')';
  }
  function call(body) {
    if (!/^https:\/\/[a-z0-9.-]+\/functions\/v1$/.test(API)) return Promise.reject(new Error('not configured'));
    var ctrl = new AbortController(), t = setTimeout(function () { ctrl.abort(); }, 30000);
    return fetch(API + '/featured', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit', signal: ctrl.signal })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._http = r.status; return j; }); })
      .finally(function () { clearTimeout(t); });
  }
  function payOpen(serverOn) { return !!CFG.paymentsEnabled && !!serverOn; }
  function loadPay() {
    if (window.MGPay) return Promise.resolve(window.MGPay);
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = '/assets/pay.js'; s.async = true;
      s.onload = function () { window.MGPay ? res(window.MGPay) : rej(new Error('pay unavailable')); };
      s.onerror = function () { rej(new Error('pay unavailable')); };
      document.head.appendChild(s);
    });
  }
  function toListing(r) {
    var t = r.token || {}, s = r.safety || {}, q = r.quote || {};
    return { ca: t.ca, symbol: t.symbol, name: t.name, imageUrl: t.imageUrl, pairAddress: t.pairAddress, startsAt: q.startsAt || new Date().toISOString(), endsAt: q.endsAt || new Date(Date.now() + 864e5).toISOString(),
      safety: { mint: s.mintRevoked, freeze: s.freezeRevoked, lp: s.lpLockedPct, top10: s.top10Pct } };
  }
  function pair(t) { return t ? { marketCap: t.marketCap, liquidity: { usd: t.liquidityUsd }, priceChange: {} } : null; }

  // ---------- availability (from the bot's featured.json) ----------
  fetch('/data/featured.json?t=' + Math.floor(Date.now() / 30000), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) return;
    var n = (window.MGSponsored ? window.MGSponsored.active(d.listings, Date.now()) : []).length, max = MG.num(d.maxConcurrent) || 3;
    var next = Date.parse(d.nextAvailableAt);
    $('avail').textContent = n + ' of ' + max + ' featured slots in use. Next available start: ' + (isFinite(next) && next > Date.now() + 60000 ? when(d.nextAvailableAt) : 'now') + '. The channel gets at most 1 sponsored post a day, so a booking may start later to fit its post.';
    $('liveText').textContent = n + '/' + max + ' slots live';
    $('live').className = 'live ok';
  }).catch(function () { /* keep the static text */ });
  $('price').textContent = PRICE + ' SOL';

  // ---------- check ----------
  var busy = false;
  function show(kids) { $('result').replaceChildren.apply($('result'), kids); }
  function failBox(title, reasons) {
    return h('div', { class: 'ft-fail', role: 'alert' }, [h('h3', { text: title }), h('ul', null, (reasons || []).map(function (x) { return h('li', { text: String(x) }); }))]);
  }
  function check(ca) {
    if (busy) return; busy = true;
    $('chkBtn').disabled = true; $('chkBtn').textContent = 'Checking…';
    show([h('p', { class: 'ft-muted', text: 'Checking DexScreener and RugCheck… this can take up to 20 seconds.' })]);
    call({ action: 'check', ca: ca }).then(function (r) {
      if (r._http >= 500 || (r.error && !r.reasons)) throw new Error(r.error || 'HTTP ' + r._http);
      if (!r.ok) {
        show([failBox('This token can’t be featured', r.reasons && r.reasons.length ? r.reasons : ['It didn’t pass the checks.']),
          h('p', { class: 'ft-muted', text: 'No payment option is shown for tokens that fail. You can check again once the issues are fixed.' })]);
        return;
      }
      var q = r.quote || {}, open = payOpen(r.paymentsEnabled), l = toListing(r);
      var cardEl = window.MGSponsored ? window.MGSponsored.card(l, pair(r.token), Date.now()) : null;
      var btn = h('button', { class: 'ft-btn', type: 'button', disabled: open ? null : 'disabled', text: open ? 'Sign in & pay ' + PRICE + ' SOL' : 'Coming soon' });
      if (open) btn.addEventListener('click', function () { pay(l.ca, btn); });
      show([h('div', { class: 'ft-quote' }, [
        h('p', { text: '✅ Passed the safety checks. Here’s your quote:' }),
        cardEl,
        h('div', { class: 'ft-kv' }, [
          h('span', { text: 'Price' }), h('b', { text: PRICE + ' SOL (24 hours)' }),
          h('span', { text: 'Starts' }), h('b', { text: when(q.startsAt) + (q.waitlisted ? ' · waitlist' : '') }),
          h('span', { text: 'Ends' }), h('b', { text: when(q.endsAt) }),
          h('span', { text: 'Channel post' }), h('b', { text: when(q.postDueAt) })
        ]),
        h('p', { class: 'ft-muted', text: 'Final times are set when your payment confirms. The token is checked again on payment and before the channel post.' }),
        h('div', { class: 'ft-acts' }, [btn, h('a', { class: 'ft-muted', href: '#terms', text: 'Refunds are manual · terms' })]),
        open ? null : h('p', { class: 'ft-muted', text: 'Featured payments aren’t open yet. The safety check above is live, so you’ll know you qualify.' })
      ])]);
    }).catch(function () {
      show([failBox('The checker is offline', ['We couldn’t reach the MaxiGems checker. Featured listings are launching soon, so please try again later.'])]);
    }).then(function () { busy = false; $('chkBtn').disabled = false; $('chkBtn').textContent = 'Check token'; });
  }
  function pay(ca, btn) {
    btn.disabled = true;
    loadPay().then(function (P) { return P.payOrder({ kind: 'featured', ca: ca }); }).then(function (r) {
      if (r && (r.status === 'paid' || r.status === 'pending')) location.href = '/featured/?ca=' + encodeURIComponent(ca) + '&paid=1';
    }).catch(function (e) {
      if (e && e.status !== 'cancelled') MG.toast(e.message || 'Payment failed');
    }).then(function () { btn.disabled = false; });
  }
  $('chkForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var m = B58.exec(String($('ca').value || '').trim());
    if (!m || !MG.SOL_RE.test(m[0])) { show([failBox('That doesn’t look like a Solana address', ['Paste the token’s contract address: 32–44 letters and numbers, no 0, O, I or l.'])]); return; }
    $('ca').value = m[0];
    check(m[0]);
  });

  // ---------- status (?ca=) ----------
  var LABELS = { queued: 'Queued (waitlist)', active: 'Live now', ended: 'Ended', pulled: 'Pulled' };
  function status(ca, paid) {
    var box = $('statusBox'), body = $('statusBody');
    box.hidden = false;
    body.replaceChildren(h('p', { class: 'ft-muted', text: paid ? 'Payment received. Loading your listing…' : 'Loading…' }));
    var cardHost = h('div', { 'data-manual': '' });
    call({ action: 'status', ca: ca }).then(function (r) {
      if (!r || !r.found) {
        body.replaceChildren(h('p', { text: paid ? 'Your payment is being confirmed. This page updates in a minute; no need to pay again.' : 'This token has no featured listing yet.' }));
        if (paid) setTimeout(function () { status(ca, paid); }, 30000);
        return;
      }
      var l = r.listing || {}, link = location.origin + '/featured/?ca=' + ca;
      var copyBtn = h('button', { class: 'ft-btn ghost', type: 'button', text: 'Copy link' });
      copyBtn.addEventListener('click', function () { MG.copy(link, copyBtn, 'Link copied'); });
      var x = 'https://x.com/intent/post?text=' + encodeURIComponent('$' + MG.clean(l.symbol, 16) + ' is featured on MaxiGems (sponsored, NFA)') + '&url=' + encodeURIComponent(link);
      body.replaceChildren(
        h('p', null, [h('span', { class: 'ft-status ' + (LABELS[r.status] ? r.status : ''), text: LABELS[r.status] || r.status }), ' ', h('b', { text: MG.clean(l.name || l.symbol, 40) + ' ($' + MG.clean(l.symbol, 16) + ')' })]),
        h('div', { class: 'ft-kv' }, [
          h('span', { text: 'Starts' }), h('b', { text: when(l.startsAt) }),
          h('span', { text: 'Ends' }), h('b', { text: when(l.endsAt) }),
          h('span', { text: 'Channel post' }), h('b', { text: r.posted ? 'Posted ✅' : r.status === 'pulled' || r.status === 'ended' ? '—' : 'Due ' + when(r.postDueAt) })
        ]),
        cardHost,
        h('div', { class: 'ft-acts' }, [copyBtn, h('a', { class: 'ft-btn ghost', href: x, target: '_blank', rel: 'noopener noreferrer', text: 'Share on X' }), h('a', { class: 'ft-btn ghost', href: '/trending/', text: 'View on Trending' })]),
        r.status === 'pulled' ? h('p', { class: 'ft-muted', text: 'This listing was pulled. Refunds are manual: message us on Telegram with your payment transaction.' }) : null
      );
      if (window.MGSponsored && r.status === 'active') window.MGSponsored.mount(cardHost, { only: ca, bare: true });
    }).catch(function () { body.replaceChildren(h('p', { class: 'ft-muted', text: 'Status is unavailable right now. Try again in a minute.' })); });
  }
  var qs = new URLSearchParams(location.search), qca = qs.get('ca');
  if (qca && MG.SOL_RE.test(qca)) { $('ca').value = qca; status(qca, qs.get('paid') === '1'); }
})();
