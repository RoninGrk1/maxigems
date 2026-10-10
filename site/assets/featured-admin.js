/* /featured/admin/#<token>: the admin "Pull listing" page opened from the bot's DM.
   The signed token (HMAC, short expiry, one listing) stays in the #fragment: browsers never send it to any server
   except as the POST body below, so it can't leak into access logs, and nothing is pulled without pressing the button. */
(function () {
  'use strict';
  var MG = window.MG; if (!MG) return;
  var h = MG.h, $ = MG.$;
  var API = String(MG.CFG.proApi || '').replace(/\/+$/, '');
  var token = decodeURIComponent((location.hash || '').slice(1));
  var body = $('adminBody');
  var ERR = { expired: 'This link has expired. Mint a fresh one with: node scripts/featured-admin-link.mjs <listing id>', bad_signature: 'This link is invalid.', malformed: 'This link is incomplete.', not_found: 'Listing not found.' };
  function post(b) {
    return fetch(API + '/featured', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function msg(t) { body.replaceChildren(h('p', { text: t })); }
  if (history.replaceState) history.replaceState(null, '', location.pathname); // drop the token from the address bar
  if (!/^[A-Za-z0-9-]{1,64}\.\d{9,11}\.[A-Za-z0-9_-]{43}$/.test(token)) { msg(ERR.malformed); return; }
  if (!/^https:\/\/[a-z0-9.-]+\/functions\/v1$/.test(API)) { msg('Featured service is not configured.'); return; }
  post({ action: 'admin-view', token: token }).then(function (r) {
    if (!r.ok) { msg(ERR[r.error] || 'Could not load this listing.'); return; }
    var l = r.listing || {};
    var btn = h('button', { class: 'ft-btn', type: 'button', text: '🛑 Pull listing' });
    var reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason (optional, internal)', 'aria-label': 'Reason' });
    var out = h('p', { class: 'ft-muted', 'aria-live': 'polite' });
    btn.addEventListener('click', function () {
      if (!window.confirm('Pull $' + MG.clean(l.symbol, 16) + ' now? This hides it and deletes the channel post if Telegram still allows it.')) return;
      btn.disabled = true; out.textContent = 'Pulling…';
      post({ action: 'pull', token: token, reason: reason.value }).then(function (p) {
        out.textContent = p.ok ? '✅ Pulled.' + (p.postDeleted === true ? ' Channel post deleted.' : p.postDeleted === false ? ' The channel post could not be deleted (over 48h old?), so delete it by hand.' : '') + ' ' + (p.note || '')
          : 'Not pulled: ' + (p.error || 'error');
      }).catch(function () { out.textContent = 'Network error. Try again.'; btn.disabled = false; });
    });
    body.replaceChildren(
      h('div', { class: 'ft-kv' }, [
        h('span', { text: 'Token' }), h('b', { text: MG.clean(l.name, 40) + ' ($' + MG.clean(l.symbol, 16) + ')' }),
        h('span', { text: 'CA' }), h('b', null, [h('code', { text: l.ca })]),
        h('span', { text: 'Status' }), h('b', { text: r.status + (r.posted ? ' · posted' : '') }),
        h('span', { text: 'Window' }), h('b', { text: new Date(l.startsAt).toLocaleString() + ' → ' + new Date(l.endsAt).toLocaleString() }),
        h('span', { text: 'Payer' }), h('b', null, [h('code', { text: r.wallet || '?' })])
      ]),
      r.status === 'queued' || r.status === 'active' ? h('div', { class: 'ft-form' }, [reason, btn]) : h('p', { class: 'ft-muted', text: 'This listing is not live, so there is nothing to pull.' }),
      out,
      h('p', { class: 'ft-muted', text: 'Refunds are manual: send them from the treasury wallet to the payer above.' })
    );
  }).catch(function () { msg('Featured service unreachable.'); });
})();
