// Telegram logic for Pro (pure builders + a thin API caller with injectable fetch).
import { daysLeft } from './plans.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s, max) => { const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

/** createChatInviteLink params: single use, expires in ~1 day, creates no join-request. */
export function inviteParams(groupId, wallet, nowMs = Date.now()) {
  return { chat_id: groupId, member_limit: 1, expire_date: Math.floor(nowMs / 1000) + 86400, name: `pro ${String(wallet).slice(0, 4)}…${String(wallet).slice(-4)}`.slice(0, 32) };
}

/** Who to remove: linked Telegram users whose pass expired and who haven't been removed since. */
export function kickList(links, subs, nowMs = Date.now()) {
  const byWallet = new Map(subs.map((s) => [s.wallet, s]));
  return links.filter((l) => l.tg_user_id && l.linked_at && !l.removed_at && daysLeft(byWallet.get(l.wallet)?.expires_at, nowMs) <= 0)
    .map((l) => ({ wallet: l.wallet, tg_user_id: l.tg_user_id }));
}

/** Kick = ban then unban immediately (removes the member but lets them rejoin with a new invite after renewing). */
export function kickCalls(groupId, userId) {
  return [['banChatMember', { chat_id: groupId, user_id: userId, revoke_messages: false }], ['unbanChatMember', { chat_id: groupId, user_id: userId, only_if_banned: true }]];
}

/** "/start <token>" (deep link t.me/<bot>?start=<token>) → token or null. */
export function startToken(text) {
  const m = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Callback data for the admin's "Pull listing" button. */
export const pullData = (id) => `pull:${id}`;
export function parsePull(data) { const m = /^pull:([0-9a-f-]{36})$/.exec(String(data || '')); return m ? m[1] : null; }

/** Admin DM for a booking, with a one-tap "Pull listing" button. */
export function bookingMessage(l, siteUrl = 'https://maxigems.fun/') {
  const html = [
    '🆕 <b>Featured listing booked</b>',
    `$${esc(clean(l.symbol, 16))} · ${esc(clean(l.name, 40))}`,
    `📋 <code>${esc(l.ca)}</code>`,
    `👛 Paid by <code>${esc(l.wallet)}</code>${l.test ? ' (TEST price)' : ''}`,
    `💰 ${esc(l.sol)} SOL · <a href="https://solscan.io/tx/${esc(l.signature)}">tx</a>`,
    `🕒 ${esc(l.starts_at)} → ${esc(l.ends_at)}`,
    `📣 Channel post planned: ${esc(l.post_due_at || '—')}`,
    '',
    'Tap <b>Pull listing</b> to remove it from Trending (and the channel post). Refunds are manual.',
  ].join('\n');
  return { text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: '🛑 Pull listing', callback_data: pullData(l.id) }, { text: 'DexScreener', url: `https://dexscreener.com/solana/${l.ca}` }]] } };
}

/** The ONE public-channel post, clearly labelled. */
export function sponsoredPost(l, siteUrl = 'https://maxigems.fun/') {
  const html = [
    '📢 <b>Sponsored – not financial advice</b>',
    '',
    `<b>$${esc(clean(l.symbol, 16))}</b> · ${esc(clean(l.name, 40))}`,
    `📋 <code>${esc(l.ca)}</code>`,
    '',
    'This is a paid placement, <b>not a MaxiGems call</b>. It passed the same automated RugCheck safety rules as our calls, which does not make it safe. Memecoins are extremely risky — DYOR.',
  ].join('\n');
  return { text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'DexScreener', url: `https://dexscreener.com/solana/${l.ca}` }, { text: 'Featured on MaxiGems', url: new URL('trending/', siteUrl).toString() }]] } };
}

/** Telegram Bot API call. Never logs the token. */
export async function tgCall(token, method, body, fetchFn = fetch) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const r = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { const e = new Error(`telegram ${method}: ${d.description || r.status}`); e.status = r.status; throw e; }
  return d.result;
}

/** Remove one member (ban → unban). Returns true when both calls succeeded or the user wasn't in the group. */
export async function kick(token, groupId, userId, fetchFn = fetch) {
  try {
    for (const [m, b] of kickCalls(groupId, userId)) await tgCall(token, m, b, fetchFn);
    return true;
  } catch (e) {
    if (/user not found|PARTICIPANT_ID_INVALID|not a member/i.test(e.message)) return true;
    throw e;
  }
}
