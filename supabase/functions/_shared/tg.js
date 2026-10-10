// Telegram logic for Pro (pure builders + a thin API caller with injectable fetch).
import { daysLeft } from './plans.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const clean = (s, max) => { const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

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
