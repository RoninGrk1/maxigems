#!/usr/bin/env node
// Entry: --once (default) | --loop (VPS) | --recap (force a recap post)
import { runOnce, loadConfig } from './engine.js';
import { log, sleep } from './util.js';

const args = new Set(process.argv.slice(2));
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log(`${sig} received, stopping after current cycle`); stopping = true; if (args.has('--loop')) setTimeout(() => process.exit(0), 100).unref(); });

async function main() {
  if (args.has('--loop')) {
    const mins = Number(process.env.LOOP_MINUTES) || loadConfig().loopIntervalMinutes || 10;
    log(`loop mode: every ${mins} min`);
    while (!stopping) {
      try { await runOnce(); } catch (e) { log(`ERROR cycle failed: ${e.stack || e.message}`); }
      for (let i = 0; i < mins * 60 && !stopping; i++) await sleep(1000);
    }
    return;
  }
  await runOnce({ forceRecap: args.has('--recap') });
}

main().catch((e) => { log(`FATAL ${e.stack || e.message}`); process.exit(1); });
