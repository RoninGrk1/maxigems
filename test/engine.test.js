// End-to-end engine runs with mocked APIs: dedupe, tracking/ATH, API-down, Telegram 429.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakePair, fakeReport } from './fixtures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-e2e-'));
process.env.MAXIGEMS_STATE = path.join(dir, 'state.json');
process.env.MAXIGEMS_SITE_DATA = path.join(dir, 'calls.json');
process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
process.env.TELEGRAM_CHANNEL_ID = '@test';
delete process.env.DRY_RUN;

const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
let price = '0.0002';
let apiDown = false;
let tgCalls = [];
let tg429 = 1;
let rugcheckDown = false;

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (d, status = 200, headers = {}) => new Response(JSON.stringify(d), { status, headers });
  if (url.includes('api.telegram.org')) {
    const body = opts.body instanceof FormData ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? (k === 'reply_markup' || k === 'reply_parameters' ? JSON.parse(v) : v) : '<file>'])) : JSON.parse(opts.body);
    if (tg429 > 0) { tg429--; return json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429); }
    tgCalls.push({ method: url.split('/').pop(), body });
    return json({ ok: true, result: { message_id: tgCalls.length } });
  }
  if (url.includes('api.rugcheck.xyz')) return rugcheckDown ? json({ error: 'down' }, 503) : json(fakeReport());
  if (url.includes('mainnet-beta.solana.com')) return json({ result: { value: [] } });
  if (apiDown) return json({ error: 'down' }, 503);
  if (url.includes('token-boosts') || url.includes('token-profiles')) return json([{ chainId: 'solana', tokenAddress: CA }, { chainId: 'ethereum', tokenAddress: '0xabc' }]);
  if (url.includes('geckoterminal')) return json({ data: [] });
  if (url.includes('/tokens/v1/solana/')) return json([fakePair({ priceUsd: price })]);
  return json({}, 404);
};

const { runOnce } = await import('../src/engine.js');

test('first run calls the token and posts once (after 429 retry)', async () => {
  const r = await runOnce();
  assert.equal(r.newCalls.length, 1);
  assert.equal(tgCalls.length, 1);
  assert.equal(tgCalls[0].method, 'sendPhoto');
  assert.ok(tgCalls[0].body.reply_markup.inline_keyboard.flat().some((b) => b.url.startsWith('https://jup.ag/swap/SOL-')));
  const site = JSON.parse(fs.readFileSync(process.env.MAXIGEMS_SITE_DATA));
  assert.equal(site.calls.length, 1);
  assert.equal(site.calls[0].address, CA);
  assert.deepEqual(site.calls[0].safety, { mint: true, freeze: true, lp: 100, top10: 20 });
  assert.match(tgCalls[0].body.caption, /🛡 Mint ✅ \| Freeze ✅ \| LP 🔥 100% \| Top10 20%/);
});

test('second run dedupes and tracks ATH + posts milestone reply', async () => {
  price = '0.0005'; // 2.5x
  const r = await runOnce();
  assert.equal(r.newCalls.length, 0);
  const st = JSON.parse(fs.readFileSync(process.env.MAXIGEMS_STATE));
  assert.equal(st.calls.length, 1);
  assert.equal(st.calls[0].athMultiple, 2.5);
  const ms = tgCalls.find((c) => c.body.reply_parameters);
  assert.ok(ms, 'milestone reply posted');
  assert.equal(ms.body.reply_parameters.message_id, 1);
});

test('price drop keeps ATH, updates current multiple', async () => {
  price = '0.0001';
  await runOnce();
  const st = JSON.parse(fs.readFileSync(process.env.MAXIGEMS_STATE));
  assert.equal(st.calls[0].athMultiple, 2.5);
  assert.equal(st.calls[0].currentMultiple, 0.5);
});

test('rugcheck down → fail closed: no call, no post', { timeout: 120000 }, async () => {
  const st = JSON.parse(fs.readFileSync(process.env.MAXIGEMS_STATE));
  st.seen = {}; st.calls = []; fs.writeFileSync(process.env.MAXIGEMS_STATE, JSON.stringify(st));
  rugcheckDown = true; price = '0.0002';
  const before = tgCalls.length;
  const r = await runOnce();
  assert.equal(r.newCalls.length, 0);
  assert.equal(tgCalls.length, before);
  assert.ok(Object.keys(r.rejectStats).some((k) => /fail closed/.test(k)));
  rugcheckDown = false;
});

test('APIs down: run completes, keeps existing data', { timeout: 120000 }, async () => {
  apiDown = true;
  const r = await runOnce();
  assert.equal(r.newCalls.length, 0);
  const site = JSON.parse(fs.readFileSync(process.env.MAXIGEMS_SITE_DATA));
  assert.equal(site.calls.length, 0); // state was reset by the previous test; nothing invented while APIs are down
  apiDown = false;
});
