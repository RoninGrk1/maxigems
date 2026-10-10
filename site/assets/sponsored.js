/* Sponsored (featured) cards: pinned at the top of /trending/ while a paid listing is active.
   Data: /data/featured.json (written by the bot each run; filtered by time here too), live numbers from DexScreener.
   XSS-safe: DOM via MG.h (textContent only); CA validated; images limited to known CDNs (MG.imgUrl). Exposes MGSponsored. */
(function () {
  'use strict';
  var MG = window.MG; if (!MG) return;
  var h = MG.h;
  var LABEL = 'Sponsored – not financial advice';

  function active(list, now) {
    return (Array.isArray(list) ? list : []).filter(function (l) {
      return l && MG.SOL_RE.test(l.ca || '') && Date.parse(l.startsAt) <= now && Date.parse(l.endsAt) > now;
    }).slice(0, 3);
  }
  function left(ms) { var m = Math.max(0, Math.floor(ms / 60000)); return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm'; }
  function safety(s) {
    s = s || {};
    function pc(v) { var n = MG.num(v); return n === null ? '?' : Math.round(n) + '%'; }
    function it(label, ok, val) { return h('span', { class: ok ? 'ok' : 'bad' }, [label + ' ', h('b', { text: val })]); }
    return h('div', { class: 'sp-safe', 'aria-label': 'Safety check when booked' }, [
      h('span', { text: '🛡' }),
      it('Mint', !!s.mint, s.mint ? '✅' : '❌'), it('Freeze', !!s.freeze, s.freeze ? '✅' : '❌'),
      it('LP 🔥', MG.num(s.lp) !== null && s.lp >= 80, pc(s.lp)), it('Top10', MG.num(s.top10) !== null && s.top10 <= 35, pc(s.top10))
    ]);
  }
  /** One sponsored card. l = featured.json listing; p = optional live DexScreener pair. */
  function card(l, p, now) {
    var name = MG.clean(l.name || l.symbol, 40), sym = MG.clean(l.symbol, 16);
    var L = MG.links(l.ca, l.pairAddress);
    var mc = p ? (p.marketCap || p.fdv) : null, liq = p && p.liquidity ? p.liquidity.usd : null, ch = p && p.priceChange ? p.priceChange.h24 : null;
    var copyBtn = h('button', { class: 'copy', type: 'button', 'aria-label': 'Copy contract address of ' + sym, text: 'Copy CA' });
    copyBtn.addEventListener('click', function () { MG.copy(l.ca, copyBtn); });
    return h('article', { class: 'card sp-card', 'aria-label': 'Sponsored: ' + name + ' ($' + sym + ')' }, [
      h('div', { class: 'top' }, [
        MG.avatar(MG.imgUrl(l.imageUrl), sym, 46),
        h('div', { class: 'ttl' }, [
          h('div', { class: 'nm', title: name, text: name }),
          h('div', { class: 'sym' }, [h('span', { text: '$' + sym }), h('span', { class: 'badge sp-badge', title: 'Paid placement. Not a MaxiGems call.', text: 'Sponsored' })])
        ])
      ]),
      h('p', { class: 'sp-label', text: '🟡 ' + LABEL + ' · paid placement, not a call' }),
      h('div', { class: 'kv' }, [
        h('div', null, [h('span', { text: 'Market cap' }), h('b', { text: MG.usd(mc) })]),
        h('div', null, [h('span', { text: 'Liquidity' }), h('b', { text: MG.usd(liq) })]),
        h('div', null, [h('span', { text: '24h' }), h('b', { class: MG.num(ch) === null ? null : ch >= 0 ? 'pos' : 'neg', text: MG.pct(ch) })]),
        h('div', null, [h('span', { text: 'Featured' }), h('b', { text: Date.parse(l.startsAt) > now + 60000 ? 'starts in ' + left(Date.parse(l.startsAt) - now) : left(Date.parse(l.endsAt) - now) + ' left' })])
      ]),
      safety(l.safety),
      h('div', { class: 'ca' }, [h('code', { title: l.ca, text: l.ca }), copyBtn]),
      h('div', { class: 'foot' }, [
        h('span', { class: 'sp-time', text: 'Passed MaxiGems safety checks when booked' }),
        h('div', { class: 'lnk' }, [
          h('a', { class: 'pri', href: L.dexscreener, target: '_blank', rel: 'noopener noreferrer', text: 'Chart' }),
          h('a', { href: L.solscan, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan' }),
          h('a', { class: 'sp-more', href: '/featured/?ca=' + l.ca, text: 'Details' })
        ])
      ])
    ]);
  }
  function live(cas) {
    if (!cas.length) return Promise.resolve({});
    return fetch('https://api.dexscreener.com/tokens/v1/solana/' + cas.join(','), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
      .then(function (d) {
        var best = {};
        (Array.isArray(d) ? d : []).forEach(function (p) {
          var a = p && p.baseToken && p.baseToken.address;
          if (!a || p.chainId !== 'solana') return;
          if (!best[a] || (MG.num(p.liquidity && p.liquidity.usd) || 0) > (MG.num(best[a].liquidity && best[a].liquidity.usd) || 0)) best[a] = p;
        });
        return best;
      });
  }
  /** Render into a container; hides it when nothing is active. Returns a Promise. */
  function mount(el, opts) {
    opts = opts || {};
    return fetch('/data/featured.json?t=' + Math.floor(Date.now() / 30000), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var now = Date.now(), list = active(d && d.listings, now);
        if (opts.only) list = list.filter(function (l) { return l.ca === opts.only; });
        if (!list.length) { el.hidden = true; el.replaceChildren(); return list; }
        return live(list.map(function (l) { return l.ca; })).then(function (best) {
          var grid = h('div', { class: 'sp-list' }, list.map(function (l) { return card(l, best[l.ca], Date.now()); }));
          var kids = opts.bare ? [grid] : [h('div', { class: 'sp-head' }, [h('span', { text: 'Paid placements · not financial advice' }), h('a', { href: '/featured/', text: 'Get featured →' })]), grid];
          el.replaceChildren.apply(el, kids);
          el.hidden = false;
          return list;
        });
      })
      .catch(function (e) { el.hidden = true; if (window.console) console.info('[sponsored] unavailable:', e && e.message); return []; });
  }
  window.MGSponsored = { mount: mount, card: card, active: active, LABEL: LABEL };
  var host = document.getElementById('sponsored');
  if (host && !host.hasAttribute('data-manual')) {
    mount(host);
    setInterval(function () { if (!document.hidden) mount(host); }, 120000);
  }
})();
