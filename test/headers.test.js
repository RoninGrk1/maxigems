// Cloudflare Workers static-assets config: wrangler.jsonc, site/_headers, upload limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = path.join(ROOT, 'site');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
function parseHeaders(txt) {
  const rules = [];
  for (const line of txt.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), headers: {} }); continue; }
    const i = line.indexOf(':');
    assert.ok(rules.length && i > 0, `bad _headers line: ${line}`);
    assert.ok(line.length <= 2000, '_headers line over 2000 chars');
    const name = line.slice(0, i).trim().toLowerCase();
    assert.ok(!(name in rules.at(-1).headers), `duplicate ${name}`);
    rules.at(-1).headers[name] = line.slice(i + 1).trim();
  }
  return rules;
}
const csp = (s) => Object.fromEntries(s.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, new Set(v)]; }));

test('wrangler.jsonc: assets-only Worker serving ./site', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(cfg.name, 'maxigems');
  assert.match(cfg.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(cfg.main, undefined);
  assert.deepEqual(cfg.assets, { directory: './site', not_found_handling: '404-page', html_handling: 'auto-trailing-slash' });
  assert.ok(fs.existsSync(path.join(SITE, '404.html')));
});

test('site/ fits Workers static asset limits (files <= 25 MiB, count well under 20,000)', () => {
  const files = walk(SITE);
  assert.ok(files.length < 15000, `${files.length} assets`);
  for (const f of files) assert.ok(fs.statSync(f).size < 25 * 1024 * 1024, `${f} too large`);
});

test('_headers: one global security rule; header CSP allows every page meta CSP and adds frame-ancestors', () => {
  const rules = parseHeaders(fs.readFileSync(path.join(SITE, '_headers'), 'utf8'));
  assert.ok(rules.length <= 100);
  const glob = rules.find((r) => r.pattern === '/*');
  assert.equal(glob.headers['x-frame-options'], 'DENY');
  assert.equal(glob.headers['x-content-type-options'], 'nosniff');
  assert.equal(glob.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  // a header set by two matching rules would be comma-joined (broken CSP / Cache-Control)
  const setBy = {};
  for (const r of rules) for (const h of Object.keys(r.headers)) (setBy[h] ||= []).push(r.pattern);
  for (const h of ['content-security-policy', 'x-frame-options', 'cache-control']) {
    const ps = setBy[h] || [];
    if (ps.includes('/*')) assert.equal(ps.length, 1, `${h} set by ${ps}`);
  }
  assert.match(rules.find((r) => r.pattern === '/data/*').headers['cache-control'], /max-age=60\b/);
  assert.match(rules.find((r) => r.pattern === '/assets/*').headers['cache-control'], /max-age=\d+/);

  const H = csp(glob.headers['content-security-policy']);
  assert.deepEqual([...H['frame-ancestors']], ["'none'"]);
  assert.ok(!glob.headers['content-security-policy'].includes('unsafe-'));
  const pages = walk(SITE).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 5);
  for (const f of pages) {
    const m = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
    assert.ok(m, `${f} lost its meta CSP`);
    const M = csp(m[1].replace(/&#39;/g, "'"));
    for (const [dir, srcs] of Object.entries(M)) {
      const allowed = H[dir] || H['default-src'];
      for (const s of srcs) assert.ok(allowed.has(s), `${path.relative(SITE, f)}: header CSP ${dir} misses ${s}`);
    }
  }
});

test('src/share.js coin-page CSP sources are allowed by the header CSP', () => {
  const H = csp(parseHeaders(fs.readFileSync(path.join(SITE, '_headers'), 'utf8')).find((r) => r.pattern === '/*').headers['content-security-policy']);
  const src = fs.readFileSync(path.join(ROOT, 'src/share.js'), 'utf8');
  for (const u of new Set(src.match(/https:\/\/[a-z0-9.-]+\.(?:com|xyz|io|fun)\b/g) || []))
    if (/rpc|api\./.test(u)) assert.ok(H['connect-src'].has(u), `connect-src misses ${u}`);
});
