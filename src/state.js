// JSON state persistence with atomic writes and corruption recovery.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.js';

export function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    const bak = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, bak); } catch {}
    log(`WARN could not parse ${file} (${e.message}); backed up to ${bak} and starting fresh`);
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function emptyState() {
  return { version: 1, calls: [], seen: {}, lastRecapAt: null, lastRunAt: null };
}

export function normalizeState(s) {
  const st = { ...emptyState(), ...(s && typeof s === 'object' ? s : {}) };
  if (!Array.isArray(st.calls)) st.calls = [];
  if (!st.seen || typeof st.seen !== 'object' || Array.isArray(st.seen)) st.seen = {};
  return st;
}
