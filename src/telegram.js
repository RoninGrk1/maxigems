// Telegram Bot API client (plain fetch). Handles 429 retry_after, 5xx, network errors, DRY_RUN.
import { sleep, log } from './util.js';

const DRY = () => /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? '');

export const channelId = (cfg) => process.env.TELEGRAM_CHANNEL_ID || cfg?.telegram?.channelId || '';

export function telegramConfigured(cfg) {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && channelId(cfg));
}

export async function tgApi(method, body, { attempts = 4 } = {}) {
  if (DRY()) {
    const text = body.caption ?? body.text ?? '';
    console.log(`\n──── [DRY_RUN] ${method} → ${body.chat_id || '(channel)'} ────\n${text}`);
    if (body.photo) console.log(`[photo] ${body.photo}`);
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
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
 * Post a call: sendPhoto (token image as caption) when possible, else sendMessage.
 * Falls back to sendMessage if Telegram rejects the photo (bad/unsupported image URL).
 */
export async function postMessage({ html, photo, buttons, replyTo, cfg }) {
  const chat_id = channelId(cfg);
  const common = {
    chat_id,
    parse_mode: 'HTML',
    disable_notification: Boolean(cfg?.telegram?.disableNotification),
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  };
  const visibleLen = html.replace(/<[^>]+>/g, '').length;
  if (photo && cfg?.telegram?.sendPhoto !== false && visibleLen <= 1000) {
    try {
      return await tgApi('sendPhoto', { ...common, photo, caption: html });
    } catch (e) {
      if (e.status !== 400) throw e;
      log(`WARN sendPhoto rejected (${e.message}); falling back to text`);
    }
  }
  return tgApi('sendMessage', { ...common, text: html, link_preview_options: { is_disabled: true } });
}
