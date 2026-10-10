// Workers Builds budget gate for the engine's data commit (run by .github/workflows/maxigems.yml).
// Every push to main triggers a Cloudflare Workers Build (free plan: 3,000 build min/month, 1 concurrent).
// Data commits land every ~10-25 min, so most of them are marked "[skip ci]" (Workers Builds and
// GitHub Actions both skip them) and only these trigger a deploy:
//   - a new coin page was added (Telegram posts link to /c/<CA>/, it must go live right away), or
//   - >= MIN_INTERVAL since the last deploying data commit (site data is at most ~30 min old), or
//   - the set of sponsored listings in site/data/featured.json changed (a new booking or a pulled listing must
//     show/disappear right away; start/end times are already enforced client-side).
// A built commit deploys the branch tip, so skipped commits' data goes live with the next build.
// Usage: node scripts/build-gate.mjs  (after `git add`; prints the commit message, updates data/deploy.json)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MIN_INTERVAL_S = 28 * 60;
export const BASE_MSG = 'chore(data): update calls';

/** Pure decision. added = staged added paths; lastBuildAt/now = unix seconds. */
export function decide(added, lastBuildAt, now, minInterval = MIN_INTERVAL_S, featuredChanged = false) {
  const newCoin = added.some((p) => /^site\/c\/[^/]+\/index\.html$/.test(p));
  const due = !(lastBuildAt > 0) || now - lastBuildAt >= minInterval || now < lastBuildAt;
  const build = newCoin || due || featuredChanged;
  return { build, reason: newCoin ? 'new coin page' : due ? 'interval' : featuredChanged ? 'featured changed' : 'batched', message: build ? BASE_MSG : `${BASE_MSG} [skip ci]` };
}

/** Did the set of sponsored listings (ca + window) change between two featured.json texts? */
export function featuredKey(txt) {
  try { return JSON.stringify((JSON.parse(txt).listings ?? []).map((l) => `${l.ca}|${l.startsAt}|${l.endsAt}`).sort()); } catch { return ''; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = 'data/deploy.json';
  let last = 0;
  try { last = Number(JSON.parse(fs.readFileSync(file, 'utf8')).lastBuildAt) || 0; } catch {}
  const added = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=A'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  let featuredChanged = false;
  try {
    const before = execFileSync('git', ['show', 'HEAD:site/data/featured.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    featuredChanged = featuredKey(before) !== featuredKey(fs.readFileSync('site/data/featured.json', 'utf8'));
  } catch { /* no previous file */ }
  const d = decide(added, last, now, MIN_INTERVAL_S, featuredChanged);
  if (d.build) {
    fs.writeFileSync(file, JSON.stringify({ lastBuildAt: now, at: new Date(now * 1000).toISOString() }) + '\n');
    execFileSync('git', ['add', file]);
  }
  console.error(`build-gate: ${d.build ? 'BUILD' : 'skip'} (${d.reason}; last ${last ? Math.round((now - last) / 60) + ' min ago' : 'never'})`);
  process.stdout.write(d.message);
}
