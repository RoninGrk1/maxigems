// Telegram client: fallback logo upload (multipart), photo→logo→text fallback chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
delete process.env.DRY_RUN;
delete process.env.TELEGRAM_CHANNEL_ID;
const { postMessage } = await import('../src/telegram.js');
const LOGO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'branding', 'telegram-fallback.jpg');
const cfg = { telegram: { channelId: '@maxigems_calls', sendPhoto: true } };

function mock(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const method = String(url).split('/').pop();
    const isForm = opts.body instanceof FormData;
    const fields = isForm ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.size}b>`])) : JSON.parse(opts.body);
    calls.push({ method, isForm, fields });
    const r = handler(method, fields, isForm);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return calls;
}

test('no token image → uploads fallback logo as multipart sendPhoto', async () => {
  const calls = mock(() => ({ status: 200, body: { ok: true, result: { message_id: 7 } } }));
  const r = await postMessage({ html: '<b>hi</b>', photo: null, fallbackPhoto: LOGO, buttons: [[{ text: 'x', url: 'https://x.com' }]], cfg });
  assert.equal(r.result.message_id, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.ok(calls[0].isForm);
  assert.equal(calls[0].fields.chat_id, '@maxigems_calls');
  assert.match(calls[0].fields.photo, /^<file \d+b>$/);
  assert.equal(JSON.parse(calls[0].fields.reply_markup).inline_keyboard[0][0].text, 'x');
});

test('rejected token image → logo → text', async () => {
  const calls = mock((m) => (m === 'sendPhoto' ? { status: 400, body: { ok: false, description: 'Bad Request: wrong file' } } : { status: 200, body: { ok: true, result: { message_id: 9 } } }));
  await postMessage({ html: 'x', photo: 'https://cdn.dexscreener.com/bad.png', fallbackPhoto: LOGO, cfg });
  assert.deepEqual(calls.map((c) => [c.method, c.isForm]), [['sendPhoto', false], ['sendPhoto', true], ['sendMessage', false]]);
});

test('missing fallback file is ignored (text post)', async () => {
  const calls = mock(() => ({ status: 200, body: { ok: true, result: { message_id: 1 } } }));
  await postMessage({ html: 'x', fallbackPhoto: '/nope/missing.jpg', cfg });
  assert.equal(calls[0].method, 'sendMessage');
});
