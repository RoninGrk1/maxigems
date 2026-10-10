// Telegram Bot API client (plain fetch). Handles 429 retry_after, 5xx, network errors, DRY_RUN.
import fs from 'node:fs';
import path from 'node:path';
import { sleep, log } from './util.js';

const isLocal = (p) => typeof p === 'string' && p.length > 0 && !/^https?:\/\//i.test(p);

/** Build a multipart body when a local file is attached (photo upload); JSON otherwise. */
function encodeBody(body) {
  if (!isLocal(body.photo)) return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const fd = new FormData();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (k === 'photo') fd.append('photo', new Blob([fs.readFileSync(v)], { type: v.endsWith('.png') ? 'image/png' : 'image/jpeg' }), path.basename(v));
    else fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return { headers: {}, body: fd };
}

const DRY = () => /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? '');

export const channelId = (cfg) => process.env.TELEGRAM_CHANNEL_ID || cfg?.telegram?.channelId || '';

export function telegramConfigured(cfg) {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && channelId(cfg));
}

export async function tgApi(method, body, { attempts = 4 } = {}) {
  if (DRY()) {
    const text = body.caption ?? body.text ?? '';
    console.log(`\n──── [DRY_RUN] ${method} → ${body.chat_id || '(channel)'} ────\n${text}`);
    if (body.photo) console.log(`[photo] ${isLocal(body.photo) ? `upload ${body.photo}${fs.existsSync(body.photo) ? '' : ' (MISSING!)'}` : body.photo}`);
    if (body.reply_markup) console.log(`[buttons] ${body.reply_markup.inline_keyboard.flat().map((b) => `${b.text} → ${b.url}`).join(' | ')}`);
    console.log('────────────────────────────────────────');
    return { ok: true, result: { message_id: null, dry: true } };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const url = `https://api.telegram.org/bot${token}/${method}`;
  for (let i = 1; i <= attempts; i++) {
    let res, data;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const enc = encodeBody(body);
      res = await fetch(url, {
        method: 'POST',
        headers: enc.headers,
        body: enc.body,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      data = await res.json().catch(() => ({}));
    } catch (e) {
      log(`WARN telegram ${method} network error: ${e.message} (attempt ${i})`);
      if (i === attempts) throw e;
      await sleep(2000 * i);
      continue;
    }
    if (data.ok) return data;
    const retryAfter = data?.parameters?.retry_after;
    if (res.status === 429 && retryAfter) {
      log(`WARN telegram 429, waiting ${retryAfter}s`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    if (res.status >= 500 && i < attempts) {
      await sleep(2000 * i);
      continue;
    }
    // 400/401/403 etc. are not retryable. Never log the token.
    const err = new Error(`telegram ${method} ${res.status}: ${data?.description ?? 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  throw new Error(`telegram ${method} failed after ${attempts} attempts`);
}

/**
 * Post with image: sendPhoto (token image URL, else the local MaxiGems fallback logo upload),
 * falling back token-image → logo → plain text if Telegram rejects a photo.
 */
export async function postMessage({ html, photo, fallbackPhoto, buttons, replyTo, cfg, chatId }) {
  const chat_id = chatId || channelId(cfg); // chatId: the private Pro group (whale alerts only); default = public channel
  const common = {
    chat_id,
    parse_mode: 'HTML',
    disable_notification: Boolean(cfg?.telegram?.disableNotification),
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  };
  const visibleLen = html.replace(/<[^>]+>/g, '').length;
  const usable = (p) => p && (!isLocal(p) || fs.existsSync(p));
  const photos = [photo, fallbackPhoto].filter(usable).filter((p, i, a) => a.indexOf(p) === i);
  if (cfg?.telegram?.sendPhoto !== false && visibleLen <= 1000) {
    for (const p of photos) {
      try {
        return await tgApi('sendPhoto', { ...common, photo: p, caption: html });
      } catch (e) {
        if (e.status !== 400) throw e;
        log(`WARN sendPhoto rejected (${e.message}); trying next fallback`);
      }
    }
  }
  return tgApi('sendMessage', { ...common, text: html, link_preview_options: { is_disabled: true } });
}
