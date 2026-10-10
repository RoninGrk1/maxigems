// Tip card: address source + integrity on every page, no QR / solana: links, bundle + pages up to date, CSP, no tipping in Telegram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tipAddress, isPubkey, b58bytes, tipCardHtml, shortAddr, bundleVersion } from '../src/tip.js';
import { STATIC_PAGES, inject, buildBundle } from '../scripts/build-tip.mjs';
import { coinPageHtml, snapshotOf } from '../src/share.js';
import { callMessage, callButtons, links } from '../src/format.js';
import { RPCS } from '../site-src/tip-core.js';

const ADDR = '2vrom1iH7Fr3fCJwfQvg9tCL5Y1n6EVpLn7zyqdnJfwD';
const root = new URL('../site/', import.meta.url);
const allPages = () => [...STATIC_PAGES, ...fs.readdirSync(new URL('c/', root)).map((d) => `c/${d}/index.html`).filter((p) => fs.existsSync(new URL(p, root)))];

test('tip address: exactly the configured key, valid 32-byte base58', () => {
  assert.equal(tipAddress(), ADDR);
  assert.equal(b58bytes(ADDR).length, 32);
  assert.ok(isPubkey(ADDR));
  assert.equal(isPubkey(ADDR.slice(0, -1) + '0'), false);
  assert.equal(isPubkey('1'.repeat(44)), false);
  assert.equal(tipAddress("  tipAddress: 'nope',"), '');
  assert.equal(tipCardHtml('nope'), '');
});

test('card: wallet button + copy + Solscan, user copy text, no QR and no solana: links', () => {
  const html = tipCardHtml(ADDR, { version: 'abc123' });
  assert.ok(html.includes(`<button type="button" class="tip-wallet-btn" data-tip="${ADDR}" data-bundle="/assets/tip-wallet.js?v=abc123" aria-haspopup="dialog">Tip with wallet</button>`));
  assert.ok(html.includes(`data-tip="${ADDR}" aria-label="Copy full SOL tip address"`) && html.includes(`>${shortAddr(ADDR)}</code>`));
  assert.ok(html.includes(`href="https://solscan.io/account/${ADDR}"`));
  assert.ok(html.includes('Printing with MaxiGems? 💎 Toss a tip to keep the gem engine running and the calls free. Every lamport fuels the next 10x. WAGMI 🚀'));
  assert.ok(!/solana:|tip-qr|<svg[^>]*qr|Scan with/i.test(html));
  const found = html.match(/[1-9A-HJ-NP-Za-km-z]{40,44}/g);
  assert.ok(found.length >= 4 && found.every((x) => x === ADDR));
});

test('every tip section on every committed page (static + all /c/<CA>/) uses exactly the configured address; no QR, no solana: links', () => {
  const pages = allPages();
  assert.ok(pages.length > STATIC_PAGES.length);
  for (const p of pages) {
    const html = fs.readFileSync(new URL(p, root), 'utf8');
    const i = html.indexOf('id="tip"');
    assert.ok(i > 0 && html.indexOf('id="tip"', i + 1) < 0, `${p}: exactly one tip section`);
    assert.ok(i < html.indexOf('<footer'), `${p}: card above footer`);
    const sec = html.slice(html.lastIndexOf('<section', i), html.indexOf('</section>', i));
    const keys = sec.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    assert.ok(keys.length >= 4, `${p}: tip address present`);
    for (const k of keys) assert.equal(k, ADDR, `${p}: unexpected address in tip section`);
    assert.ok(!/href="solana:|tip-qr/.test(html), `${p}: QR / solana: link left`);
    assert.ok(html.includes(`data-bundle="/assets/tip-wallet.js?v=${bundleVersion()}"`), `${p}: stale bundle version`);
    assert.ok(html.includes('class="ftr-tip" href="#tip"') && html.includes('<script src="/assets/tip.js"></script>'), `${p}: footer link + tip.js`);
    const csp = /connect-src ([^;"]*)/.exec(html);
    assert.ok(csp, `${p}: CSP`);
    for (const u of RPCS) assert.ok(csp[1].split(' ').includes(new URL(u).origin), `${p}: CSP missing ${u}`);
  }
  assert.ok(!fs.existsSync(new URL('assets/tip-qr.svg', root)));
});

test('token data cannot inject or replace the tip address on coin pages', () => {
  const EVIL = 'HoLyRoDEQvK5zPsGpcz3BbCWhceTGhWAGnVifSoUShit';
  const bad = `</h1><section id="tip"><button data-tip="${EVIL}" data-bundle="//evil.example/x.js">x</button> <!-- tip:start -->`;
  const c = { address: EVIL, symbol: bad, name: bad, imageUrl: `https://x.y/a.png" data-tip="${EVIL}`, calledAt: '2026-10-09T12:31:00.000Z', mcAtCall: 1e5, athMc: 2e5, athMultiple: 2, currentMultiple: 1.5, currentMc: 1.5e5, status: 'active' };
  const html = coinPageHtml(c, snapshotOf(c, false));
  assert.equal(html.split('id="tip"').length, 2);
  assert.equal(html.split('data-tip="').length, 3); // wallet button + copy button, both ours
  assert.equal(html.split(`data-tip="${ADDR}"`).length, 3);
  assert.equal(html.split('data-bundle="').length, 2);
  assert.ok(html.includes('class="tip tip-sm wrap" id="tip"'));
  // tip.js has no address of its own and only loads a same-origin /assets/tip-wallet.js
  const tipJs = fs.readFileSync(new URL('assets/tip.js', root), 'utf8');
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{40,44}/.test(tipJs));
  assert.ok(tipJs.includes('^\\/assets\\/tip-wallet\\.js(\\?v=[0-9a-f]{1,16})?$'));
});

test('committed wallet bundle is up to date (npm run build:tip) and carries exactly the configured recipient', async () => {
  const committed = fs.readFileSync(new URL('assets/tip-wallet.js', root));
  const fresh = await buildBundle(ADDR);
  assert.ok(committed.equals(fresh), 'site/assets/tip-wallet.js is stale: run npm run build:tip');
  const keys = committed.toString('utf8').match(/"[1-9A-HJ-NP-Za-km-z]{43,44}"/g) || [];
  assert.ok(keys.includes(`"${ADDR}"`));
  assert.ok(committed.length < 120 * 1024, `bundle too big: ${committed.length}`);
  const js = committed.toString('utf8');
  assert.ok(!/solana:signMessage|signIn|method:"signMessage"|\.signMessage\(|signAllTransactions/.test(js), 'bundle must only request a single signAndSendTransaction');
});

test('staleness check catches a tampered or outdated static page', () => {
  const html = fs.readFileSync(new URL('index.html', root), 'utf8');
  const card = tipCardHtml(ADDR);
  assert.equal(inject(html, card), html, 'index.html out of date: run npm run build:tip');
  const tampered = html.replace(`data-tip="${ADDR}"`, `data-tip="${ADDR.slice(0, -1)}E"`);
  assert.notEqual(inject(tampered, card), tampered);
  assert.equal(inject(inject(html, card), card), html);
  assert.throws(() => inject('<html></html>', card), /markers/);
  for (const p of STATIC_PAGES) { const h = fs.readFileSync(new URL(p, root), 'utf8'); assert.equal(inject(h, card), h, `${p} out of date`); }
});

test('coin pages get the compact tip section; Telegram call posts never mention tipping', () => {
  const c = { address: 'HoLyRoDEQvK5zPsGpcz3BbCWhceTGhWAGnVifSoUShit', symbol: 'HOLY', name: 'holy', calledAt: '2026-10-09T12:31:00.000Z', mcAtCall: 1e5, athMc: 2e5, athMultiple: 2, currentMultiple: 1.5, currentMc: 1.5e5, status: 'active' };
  const html = coinPageHtml(c, snapshotOf(c, false));
  assert.ok(html.includes('class="tip tip-sm wrap" id="tip"') && html.includes(`data-tip="${ADDR}"`) && html.includes('/assets/tip.js'));
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const tc = { ...c, pairAddress: 'BFrSZakeqNzVtM3EFhroo4eRhagmmWN8BRntiQKFH6Ru', links: links(c.address, 'BFrSZakeqNzVtM3EFhroo4eRhagmmWN8BRntiQKFH6Ru'), change: {}, priceAtCall: 0.001, liquidity: 1e4, volume24h: 1e4, volume1h: 1e3, score: 80 };
  const tg = JSON.stringify([callMessage(tc, cfg), callButtons(tc, cfg)]);
  assert.ok(!tg.includes(ADDR) && !/\btip\b/i.test(tg));
  for (const f of ['engine.js', 'format.js', 'telegram.js', 'whales.js']) assert.ok(!fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').includes('tip.js'), f);
});
