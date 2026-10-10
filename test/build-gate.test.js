// Workers Builds budget gate + workflow shape after the GitHub Pages → Cloudflare cutover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, MIN_INTERVAL_S, BASE_MSG } from '../scripts/build-gate.mjs';

const T = 1_800_000_000;
test('build gate: new coin page or interval builds, otherwise [skip ci]', () => {
  assert.equal(decide([], 0, T).build, true, 'no record → build');
  assert.deepEqual(decide([], T - 60, T), { build: false, reason: 'batched', message: `${BASE_MSG} [skip ci]` });
  assert.equal(decide(['site/c/ABC/index.html', 'site/c/ABC/card.png'], T - 60, T).message, BASE_MSG);
  assert.equal(decide(['site/c/ABC/card.png'], T - 60, T).build, false, 'only a page add counts');
  assert.equal(decide(['site/data/calls.json'], T - MIN_INTERVAL_S, T).build, true);
  assert.equal(decide([], T - MIN_INTERVAL_S + 1, T).build, false);
  assert.equal(decide([], T + 3600, T).build, true, 'clock skew → build');
  assert.ok(MIN_INTERVAL_S <= 30 * 60);
});

test('workflow: engine only, no GitHub Pages deploy, gate wired into the data commit', () => {
  const wf = fs.readFileSync(new URL('../.github/workflows/maxigems.yml', import.meta.url), 'utf8');
  assert.ok(!/deploy-pages|upload-pages-artifact|configure-pages|github-pages/.test(wf));
  assert.ok(!/^\s*(pages|id-token):/m.test(wf));
  assert.ok(!/^\s*push:/m.test(wf), 'no push trigger (Cloudflare builds on push)');
  assert.match(wf, /node scripts\/build-gate\.mjs/);
  assert.match(wf, /git add[^\n]*data\/deploy\.json|build-gate/);
  assert.match(wf, /DRY_RUN: \$\{\{ \(inputs\.dry_run \|\| vars\.DRY_RUN == '1'\) && '1' \|\| '0' \}\}/);
  assert.match(wf, /group: maxigems-engine\n\s+cancel-in-progress: false/);
  for (const f of ['CNAME', '.nojekyll']) assert.ok(!fs.existsSync(new URL(`../site/${f}`, import.meta.url)), `site/${f} removed`);
});
