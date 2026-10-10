// Site performance / validity guards from the full audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { dsThumb, coinPageHtml, snapshotOf } from '../src/share.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const DS = 'https://cdn.dexscreener.com/cms/images/y9aN2LtyKytU1d1H?width=800&height=800&quality=95&format=auto';

test('DexScreener token images are requested at a small CDN size (allowed sizes only)', () => {
  assert.equal(dsThumb(DS), 'https://cdn.dexscreener.com/cms/images/y9aN2LtyKytU1d1H?width=160&height=160&quality=90&format=auto');
  assert.equal(dsThumb(DS, 128), 'https://cdn.dexscreener.com/cms/images/y9aN2LtyKytU1d1H?width=128&height=128&quality=90&format=auto');
  for (const u of ['https://assets.geckoterminal.com/x.png', 'https://cdn.dexscreener.com/other/x.png', 'https://cdn.dexscreener.com/cms/images/a"b', null]) assert.equal(dsThumb(u), u);
  const c = { address: 'HoLyRoDEQvK5zPsGpcz3BbCWhceTGhWAGnVifSoUShit', symbol: 'HOLY', name: 'holy', imageUrl: DS, calledAt: '2026-10-09T12:31:00.000Z', mcAtCall: 1e5, athMc: 2e5, athMultiple: 2, currentMultiple: 1.5, currentMc: 1.5e5, status: 'active' };
  const html = coinPageHtml(c, snapshotOf(c, false));
  assert.ok(html.includes('src="https://cdn.dexscreener.com/cms/images/y9aN2LtyKytU1d1H?width=160&amp;height=160&amp;quality=90&amp;format=auto"'));
  assert.ok(!html.includes('width=800'));
  // client helper (common.js) does the same for the 46 px list avatars, with a fallback to the original
  const ctx = { window: {}, document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }, navigator: {}, location: { pathname: '/' }, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.window.MAXIGEMS_CONFIG = {};
  try { vm.runInNewContext(read('site/assets/common.js'), ctx); } catch { /* DOM wiring may fail in vm; MG is set first */ }
  assert.equal(typeof ctx.MG?.thumb, 'function', 'MG.thumb exported');
  assert.equal(ctx.MG.thumb(DS), 'https://cdn.dexscreener.com/cms/images/y9aN2LtyKytU1d1H?width=128&height=128&quality=90&format=auto');
  assert.equal(ctx.MG.thumb('https://assets.geckoterminal.com/x.png'), 'https://assets.geckoterminal.com/x.png');
  assert.ok(read('site/assets/app.js').includes('MG.avatar(c.img, c.symbol, 46)') && read('site/assets/trending.js').includes('MG.avatar(r.imageUrl, r.symbol, 46)'));
});

test('CTA shine animation is transform-only (animating left logged a layout shift every frame)', () => {
  const css = read('site/assets/styles.css');
  const kf = /@keyframes shine\{([^@]*?)\}\}/.exec(css);
  assert.ok(kf, 'shine keyframes');
  assert.ok(!/\b(left|top|right|bottom|width|height|margin)\s*:/.test(kf[1]), kf[1]);
  for (const m of css.matchAll(/@keyframes [\w-]+\{([^@]*?)\}\}/g)) assert.ok(!/(^|[{;])\s*(left|top|width|height|margin[\w-]*)\s*:/.test(m[1]), `layout-animating keyframes: ${m[0].slice(0, 60)}`);
});

test('SOL badge gradient ids are unique per badge (no duplicate ids)', () => {
  assert.ok(read('site/assets/app.js').includes("SOL_SVG.replace(/\\bsg\\b/g, 'sg' + (++solN))"));
});
