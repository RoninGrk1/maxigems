// Tip card: address source, Solana Pay URIs, static pages in sync, QR decodes exactly, no tipping in Telegram posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tipAddress, isPubkey, b58bytes, payUri, tipCardHtml, shortAddr } from '../src/tip.js';
import { STATIC_PAGES, inject, qrSvg } from '../scripts/build-tip.mjs';
import { coinPageHtml, snapshotOf } from '../src/share.js';
import { callMessage, callButtons, links } from '../src/format.js';

const require = createRequire(import.meta.url);
const ADDR = '2vrom1iH7Fr3fCJwfQvg9tCL5Y1n6EVpLn7zyqdnJfwD';
const BASE = `solana:${ADDR}?label=MaxiGems&message=Tip%20for%20MaxiGems`;

test('tip address: exactly the configured key, valid 32-byte base58', () => {
  assert.equal(tipAddress(), ADDR);
  assert.equal(b58bytes(ADDR).length, 32);
  assert.ok(isPubkey(ADDR));
  assert.equal(isPubkey(ADDR.slice(0, -1) + '0'), false); // '0' not base58
  assert.equal(isPubkey('1'.repeat(44)), false);           // decodes to 44 bytes
  assert.equal(tipAddress("  tipAddress: 'nope',"), '');
  assert.equal(tipCardHtml('nope'), '');
});

test('Solana Pay URIs are exact and HTML-escaped in links', () => {
  assert.equal(payUri(ADDR), BASE);
  assert.equal(payUri(ADDR, '0.1'), `solana:${ADDR}?amount=0.1&label=MaxiGems&message=Tip%20for%20MaxiGems`);
  assert.throws(() => payUri(ADDR, '1;x'));
  const html = tipCardHtml(ADDR);
  for (const a of ['0.05', '0.1', '0.5']) assert.ok(html.includes(`href="solana:${ADDR}?amount=${a}&amp;label=MaxiGems&amp;message=Tip%20for%20MaxiGems"`), a);
  assert.ok(html.includes(`href="${BASE.replace(/&/g, '&amp;')}">Open in Phantom / wallet</a>`));
  assert.ok(html.includes(`href="https://solscan.io/account/${ADDR}"`));
  assert.ok(html.includes(`data-tip="${ADDR}"`) && html.includes(`>${shortAddr(ADDR)}</code>`));
  assert.ok(html.includes('Scan with your wallet app') && html.includes('/assets/tip-qr.svg'));
  assert.ok(html.includes('Printing with MaxiGems? 💎 Toss a tip to keep the gem engine running and the calls free. Every lamport fuels the next 10x. WAGMI 🚀'));
  // every address occurrence is the exact key (no typos / truncation besides the short display)
  const found = html.match(/[1-9A-HJ-NP-Za-km-z]{40,44}/g);
  assert.ok(found.length >= 6 && found.every((x) => x === ADDR));
});

test('static pages carry the current card, footer Tip link and tip.js', () => {
  const card = tipCardHtml(ADDR);
  for (const p of STATIC_PAGES) {
    const html = fs.readFileSync(new URL(`../site/${p}`, import.meta.url), 'utf8');
    assert.equal(inject(html, card), html, `${p} out of date: run npm run build:tip`);
    assert.ok(html.indexOf('id="tip"') < html.indexOf('<footer'), `${p}: card above footer`);
    assert.ok(html.includes('class="ftr-tip" href="#tip"'), `${p}: footer link`);
    assert.ok(html.includes('<script src="/assets/tip.js"></script>'), `${p}: tip.js`);
  }
});

test('committed QR SVG is current and decodes back to the exact Solana Pay URI', async () => {
  const svg = fs.readFileSync(new URL('../site/assets/tip-qr.svg', import.meta.url), 'utf8');
  assert.equal(svg, await qrSvg(BASE));
  const { Resvg } = require('@resvg/resvg-js');
  const jsQR = require('jsqr');
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: 376 } }).render();
  const res = jsQR(new Uint8ClampedArray(img.pixels), img.width, img.height);
  assert.equal(res?.data, BASE);
});

test('coin pages get the compact tip section; Telegram call posts never mention tipping', () => {
  const c = { address: 'HoLyRoDEQvK5zPsGpcz3BbCWhceTGhWAGnVifSoUShit', symbol: 'HOLY', name: 'holy', calledAt: '2026-10-09T12:31:00.000Z', mcAtCall: 1e5, athMc: 2e5, athMultiple: 2, currentMultiple: 1.5, currentMc: 1.5e5, status: 'active' };
  const html = coinPageHtml(c, snapshotOf(c, false));
  assert.ok(html.includes('class="tip tip-sm wrap" id="tip"') && html.includes(`data-tip="${ADDR}"`) && html.includes('/assets/tip.js'));
  assert.ok(html.indexOf('id="tip"') < html.indexOf('<footer'));
  assert.ok(!html.includes('tip-qr.svg'));
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const tc = { ...c, pairAddress: 'BFrSZakeqNzVtM3EFhroo4eRhagmmWN8BRntiQKFH6Ru', links: links(c.address, 'BFrSZakeqNzVtM3EFhroo4eRhagmmWN8BRntiQKFH6Ru'), change: {}, priceAtCall: 0.001, liquidity: 1e4, volume24h: 1e4, volume1h: 1e3, score: 80 };
  const tg = JSON.stringify([callMessage(tc, cfg), callButtons(tc, cfg)]);
  assert.ok(!tg.includes(ADDR) && !/\btip\b/i.test(tg));
  for (const f of ['engine.js', 'format.js', 'telegram.js', 'whales.js']) assert.ok(!fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').includes('tip.js'), f);
});

test('every tip section on every committed page (static + all /c/<CA>/) uses exactly the configured address', () => {
  const root = new URL('../site/', import.meta.url);
  const pages = [...STATIC_PAGES, ...fs.readdirSync(new URL('c/', root)).map((d) => `c/${d}/index.html`).filter((p) => fs.existsSync(new URL(p, root)))];
  assert.ok(pages.length > STATIC_PAGES.length);
  for (const p of pages) {
    const html = fs.readFileSync(new URL(p, root), 'utf8');
    const i = html.indexOf('id="tip"');
    assert.ok(i > 0 && html.indexOf('id="tip"', i + 1) < 0, `${p}: exactly one tip section`);
    const sec = html.slice(html.lastIndexOf('<section', i), html.indexOf('</section>', i));
    const keys = sec.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    assert.ok(keys.length >= 6, `${p}: tip links present`);
    for (const k of keys) assert.equal(k, ADDR, `${p}: unexpected address in tip section`);
    for (const m of html.matchAll(/href="solana:([^?"]+)/g)) assert.equal(m[1], ADDR, `${p}: solana: link`);
  }
});

test('token data cannot inject or replace the tip address on coin pages', () => {
  const EVIL = 'HoLyRoDEQvK5zPsGpcz3BbCWhceTGhWAGnVifSoUShit';
  const bad = `</h1><section id="tip"><a href="solana:${EVIL}?amount=9">x</a> data-tip="${EVIL}" <!-- tip:start -->`;
  const c = { address: EVIL, symbol: bad, name: bad, imageUrl: `https://x.y/a.png" data-tip="${EVIL}`, calledAt: '2026-10-09T12:31:00.000Z', mcAtCall: 1e5, athMc: 2e5, athMultiple: 2, currentMultiple: 1.5, currentMc: 1.5e5, status: 'active' };
  const html = coinPageHtml(c, snapshotOf(c, false));
  assert.equal(html.split('id="tip"').length, 2);
  assert.equal(html.split('data-tip="').length, 2);
  assert.ok(html.includes(`data-tip="${ADDR}"`));
  for (const m of html.matchAll(/href="solana:([^?"]+)/g)) assert.equal(m[1], ADDR);
  // the client script never carries its own address: it only copies data-tip from the server-built card
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{40,44}/.test(fs.readFileSync(new URL('../site/assets/tip.js', import.meta.url), 'utf8')));
});

test('staleness check catches a tampered or outdated static page', () => {
  const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  const card = tipCardHtml(ADDR);
  const tampered = html.replace(`data-tip="${ADDR}"`, `data-tip="${ADDR.slice(0, -1)}E"`);
  assert.notEqual(tampered, html);
  assert.notEqual(inject(tampered, card), tampered);
  assert.equal(inject(inject(html, card), card), html); // idempotent
  assert.throws(() => inject('<html></html>', card), /markers/);
});

test('Solana Pay amounts: plain decimals, no exponent, no spl-token', () => {
  for (const a of ['0.05', '0.1', '0.5']) {
    const u = payUri(ADDR, a);
    const q = new URLSearchParams(u.split('?')[1]);
    assert.equal(q.get('amount'), a);
    assert.equal(String(Number(a)), a);
    assert.equal(q.get('label'), 'MaxiGems');
    assert.equal(q.get('message'), 'Tip for MaxiGems');
    assert.equal(q.has('spl-token'), false);
  }
  for (const bad of ['1e-2', '.5', '-1', '0x1', '1,5', '']) assert.throws(() => payUri(ADDR, bad));
});
