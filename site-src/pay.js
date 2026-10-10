// MGPay — shared Sign-In With Solana + pay-to-treasury client for MaxiGems Pro and Featured listings.
// Bundled to /assets/pay.js (npm run build:pay); lazy-loaded by /assets/pro.js. Phantom, Solflare and Jupiter only.
// The wallet is asked for exactly two things, ever: signMessage (free sign-in, no transaction) and ONE SOL transfer
// to the treasury baked in at build time, for the exact server-priced amount, carrying the order's reference key.
//
//   MGPay.session()                        → {token, wallet, expiresAt} | null
//   MGPay.signIn()                         → Promise<session>          (opens the wallet picker)
//   MGPay.signOut()
//   MGPay.api(path, {method, body})        → Promise<json>            (adds the session token)
//   MGPay.account()                        → Promise<account status>
//   MGPay.payOrder({kind, plan} | {kind:'featured', ca}) → Promise<{status:'paid'|'pending', signature, orderId, result, account}>
//        rejects with Error{status:'cancelled'|'disabled'|'error', message}
import { getWallets } from '@wallet-standard/app';
import { CHAIN, RPCS, FEE_BUFFER, isPubkey, lamportsToSol, b58, pickWallets, errorMessage } from './tip-core.js';
import { checkOrder, buildPayment, readSession, canSignMessage, SESSION_KEY } from './pay-core.js';

/* global __TREASURY__ */
const TREASURY = __TREASURY__;
const CFG = window.MAXIGEMS_CONFIG || {};
const API = String(CFG.proApi || '').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const fail = (status, message) => Object.assign(new Error(message), { status });

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

// ------------------------------------------------------------------ session + API
let mem = null;
function session() {
  let raw = null; try { raw = localStorage.getItem(SESSION_KEY); } catch { raw = mem; }
  const s = readSession(raw);
  if (!s && raw) { try { localStorage.removeItem(SESSION_KEY); } catch { mem = null; } }
  return s;
}
function saveSession(s) { const v = JSON.stringify(s); try { localStorage.setItem(SESSION_KEY, v); } catch { mem = v; } emit(); }
function signOut() { try { localStorage.removeItem(SESSION_KEY); } catch { /* */ } mem = null; S.wallet = null; S.account = null; emit(); }
function emit() { try { window.dispatchEvent(new CustomEvent('mg:session', { detail: session() })); } catch { /* */ } }

async function api(path, { method = 'GET', body, auth = true, timeoutMs = 20000 } = {}) {
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/functions\/v1$/.test(API) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(API + '/')) throw fail('error', 'Pro service is not configured.');
  const s = auth ? session() : null;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}/${path}`, { method, headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && s) signOut();
    if (!r.ok && r.status !== 202) throw Object.assign(fail(r.status === 403 ? 'disabled' : 'error', j.error || j.message || `Request failed (${r.status})`), { http: r.status, data: j });
    return Object.assign(j, { _http: r.status });
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof TypeError) throw fail('error', 'MaxiGems Pro is unreachable right now — try again in a minute.');
    throw e;
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ RPC (blockhash, balance, confirmation)
async function rpc(method, params, timeoutMs = 8000) {
  let last;
  for (const url of RPCS) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
      if (!r.ok) throw new Error(`rpc ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(`rpc ${j.error.code}: ${j.error.message}`);
      return j.result;
    } catch (e) { last = e; } finally { clearTimeout(t); }
  }
  throw new Error(`rpc unavailable (${last && last.message})`);
}

// ------------------------------------------------------------------ modal (same look as the tip modal: .tw-*)
const S = { root: null, body: null, opener: null, wallet: null, account: null, off: null, reject: null, busy: false };
function focusables() { return S.root ? [...S.root.querySelectorAll('button:not([disabled]),a[href],input:not([disabled])')].filter((n) => n.offsetParent !== null) : []; }
function onKey(e) {
  if (!S.root) return;
  if (e.key === 'Escape' && !S.busy) { e.preventDefault(); close(); return; }
  if (e.key === 'Tab') {
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !S.root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !S.root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
}
function view(...nodes) {
  if (!S.root) return;
  S.body.replaceChildren(...nodes.flat().filter(Boolean));
  const f = S.body.querySelector('[data-autofocus]') || focusables()[0];
  if (f) f.focus({ preventScroll: true });
}
function open(title) {
  if (S.root) close();
  S.opener = document.activeElement;
  const body = el('div', { class: 'tw-body', 'aria-live': 'polite' });
  const modal = el('div', { class: 'tw-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mgpTitle' },
    el('div', { class: 'tw-head' }, el('h2', { id: 'mgpTitle', text: title }), el('button', { type: 'button', class: 'tw-x', 'aria-label': 'Close', text: '×', onclick: () => { if (!S.busy) close(); } })), body);
  const back = el('div', { class: 'tw-back', onmousedown: (e) => { if (e.target === back && !S.busy) close(); } }, modal);
  S.root = back; S.body = body;
  document.body.append(back);
  document.documentElement.classList.add('tw-open');
  document.addEventListener('keydown', onKey, true);
}
function close() {
  if (!S.root) return;
  document.removeEventListener('keydown', onKey, true);
  S.root.remove(); S.root = null;
  document.documentElement.classList.remove('tw-open');
  if (S.reject) { const r = S.reject; S.reject = null; r(fail('cancelled', 'Closed.')); }
  if (S.opener && S.opener.isConnected) S.opener.focus({ preventScroll: true });
}
const logo = (w) => el('img', { class: 'tw-logo', src: w.icon, alt: '', width: 32, height: 32 });
const status = (text) => el('p', { class: 'tw-p', role: 'status', text });

// ------------------------------------------------------------------ wallet pick + connect
function detect() {
  let std = [];
  try { const a = getWallets(); std = a.get(); if (!S.off) S.off = a.on('register', () => { if (S.root && S.picking) S.picking(); }); } catch { /* none */ }
  return pickWallets(std, window);
}
function pickWallet(purpose) {
  return new Promise((resolve, reject) => {
    S.reject = reject;
    const render = () => {
      const ws = detect();
      const ok = (w) => w.canSend && (purpose !== 'sign' || canSignMessage(w));
      const any = ws.some(ok), mobile = isMobile(), here = location.origin + location.pathname;
      const rows = ws.map((w) => {
        if (ok(w)) return el('button', { type: 'button', class: 'tw-row', 'data-autofocus': w === ws.find(ok), 'aria-label': `Connect ${w.name}`, onclick: () => { S.picking = null; resolve(w); } },
          logo(w), el('span', { class: 'tw-name', text: w.name }), el('span', { class: 'tw-tag', text: 'Installed' }), el('span', { class: 'tw-go', text: 'Connect' }));
        if (w.installed) return el('div', { class: 'tw-row tw-dis' }, logo(w), el('span', { class: 'tw-name', text: w.name }), el('span', { class: 'tw-go', text: 'Update wallet' }));
        const href = mobile ? (w.browse ? w.browse(here, location.origin) : w.mobile || w.install) : w.install;
        const act = mobile ? (w.browse ? 'Open in app' : 'Get the app') : 'Install';
        return el('a', { class: 'tw-row', href, target: mobile && w.browse ? null : '_blank', rel: 'noopener noreferrer' }, logo(w), el('span', { class: 'tw-name', text: w.name }), el('span', { class: 'tw-go', text: act }));
      });
      view(el('p', { class: 'tw-p', text: any ? 'Pick your Solana wallet.' : mobile ? 'Open MaxiGems inside your wallet app’s browser:' : 'No Solana wallet found in this browser. Install one, then reload:' }),
        el('div', { class: 'tw-list' }, rows),
        el('p', { class: 'tw-fine', text: 'Phantom, Solflare or Jupiter · MaxiGems never sees your keys.' }));
    };
    S.picking = render; render();
  });
}
async function connect(w) {
  let account;
  if (w.std) {
    const res = await w.std.features['standard:connect'].connect();
    const accts = (res && res.accounts) || w.std.accounts || [];
    const a = accts.find((x) => !x.chains || x.chains.includes(CHAIN)) || accts[0];
    if (!a) throw new Error('No account was shared by the wallet.');
    account = { address: a.address, std: a };
  } else {
    const r = await w.injected.connect();
    const pk = (r && r.publicKey) || w.injected.publicKey;
    account = { address: pk && pk.toString() };
  }
  if (!isPubkey(account.address)) throw new Error('Wallet returned an invalid account.');
  S.wallet = w; S.account = account;
  return account;
}
async function signMessage(w, account, text) {
  const bytes = new TextEncoder().encode(text);
  if (w.std && w.std.features['solana:signMessage']) {
    const out = await w.std.features['solana:signMessage'].signMessage({ account: account.std, message: bytes });
    const o = Array.isArray(out) ? out[0] : out;
    return b58(o.signature);
  }
  const r = await w.injected.signMessage(bytes, 'utf8');
  const sig = r && (r.signature || r);
  return typeof sig === 'string' ? sig : b58(new Uint8Array(sig));
}

// ------------------------------------------------------------------ sign in
async function signInFlow(keepOpen) {
  const w = await pickWallet('sign');
  view(status(`Approve the connection in ${w.name}…`));
  const account = await connect(w);
  const n = await api('auth', { method: 'POST', body: { action: 'nonce', wallet: account.address }, auth: false });
  const dom = typeof n.message === 'string' ? n.message.split(' ')[0] : '';
  if (n.message.split('\n')[1] !== account.address || !(dom === location.host || /^(www\.)?maxigems\.fun$/.test(dom))) throw new Error('Unexpected sign-in message.');
  view(status(`Sign the message in ${w.name}. It’s free: no transaction, no spending permission.`));
  const signature = await signMessage(w, account, n.message);
  const v = await api('auth', { method: 'POST', body: { action: 'verify', message: n.message, signature }, auth: false });
  const s = { token: v.token, wallet: v.wallet, expiresAt: v.expiresAt };
  if (!readSession(s) || s.wallet !== account.address) throw new Error('Sign-in failed.');
  saveSession(s);
  if (!keepOpen) close();
  return s;
}
function signIn() {
  open('💎 Sign in to MaxiGems');
  return signInFlow(false).catch((e) => { showError(e); throw e; });
}

// ------------------------------------------------------------------ pay
async function ensureWalletFor(s) {
  if (S.wallet && S.account && S.account.address === s.wallet) return;
  const w = await pickWallet('pay');
  view(status(`Approve the connection in ${w.name}…`));
  const a = await connect(w);
  if (a.address !== s.wallet) throw new Error(`Connect the wallet you signed in with (${short(s.wallet)}), or sign out and sign in with this one.`);
}

async function confirm(sig, lastValid) {
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 75000; i++) {
    await sleep(i ? 2000 : 1200);
    let st = null;
    try { st = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }])).value[0]; } catch { continue; }
    if (st && st.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'ok';
    if (!st && i % 4 === 3) { try { const h = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]); if (BigInt(h) > lastValid) throw new Error('block height exceeded'); } catch (e) { if (/exceeded/.test(e.message)) throw e; } }
  }
  return 'timeout';
}

async function payFlow(req) {
  let s = session();
  if (!s) s = await signInFlow(true);
  await ensureWalletFor(s);
  const w = S.wallet, a = S.account;
  view(status('Creating your order…'));
  const o = await api('create-order', { method: 'POST', body: req });
  const lam = checkOrder(o, TREASURY);
  view(
    el('div', { class: 'tw-kv' },
      el('span', { text: 'Item' }), el('b', { text: o.label || req.kind }),
      el('span', { text: 'Price' }), el('b', { text: `${lamportsToSol(lam)} SOL${o.test ? ' (test price)' : ''}` }),
      el('span', { text: 'From' }), el('b', {}, logo(w), ` ${w.name} · ${short(a.address)}`),
      el('span', { text: 'To' }), el('code', { class: 'tw-to', title: 'MaxiGems treasury', text: TREASURY })),
    status('Checking your balance…'));
  const bal = await rpc('getBalance', [a.address, { commitment: 'confirmed' }]).catch(() => null);
  if (bal && typeof bal.value === 'number' && BigInt(bal.value) < lam + FEE_BUFFER) throw new Error('insufficient funds');
  const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const tx = buildPayment({ from: a.address, treasury: TREASURY, lamports: lam, reference: o.reference, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
  S.body.lastChild.textContent = `Approve ${lamportsToSol(lam)} SOL in ${w.name}…`;
  let sig;
  if (w.std) {
    const out = await w.std.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: a.std, chain: CHAIN, transaction: tx.wire, options: { commitment: 'confirmed' } });
    const r = Array.isArray(out) ? out[0] : out;
    sig = r && r.signature && (typeof r.signature === 'string' ? r.signature : b58(r.signature));
  } else {
    const out = await w.injected.request({ method: 'signAndSendTransaction', params: { message: b58(tx.message) } });
    sig = out && out.signature;
  }
  if (!sig || typeof sig !== 'string') throw new Error('The wallet did not return a transaction signature.');
  S.busy = true;
  view(status('Sent — confirming on Solana… (you can close this; your payment is picked up automatically)'));
  try { await confirm(sig, BigInt(bh.lastValidBlockHeight)); } catch (e) { S.busy = false; throw e; }
  // server-side verification (202 = not visible to the RPC yet → retry)
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await api('verify-payment', { method: 'POST', body: { orderId: o.orderId, signature: sig } }).catch((e) => ({ ok: false, message: e.message, _http: e.http }));
    if (last.ok || (last._http && last._http !== 202)) break;
    await sleep(2500);
  }
  S.busy = false;
  const url = `https://solscan.io/tx/${encodeURIComponent(sig)}`;
  if (last && last.ok) {
    view(el('p', { class: 'tw-p tw-good', text: req.kind === 'pro' ? `💎 You’re Pro! ${last.account && last.account.pro ? last.account.pro.daysLeft + ' days left.' : ''}` : '✅ Payment confirmed.' }),
      el('p', { class: 'tw-p' }, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'View transaction on Solscan ↗' })),
      el('div', { class: 'tw-acts' }, el('button', { type: 'button', class: 'tw-btn', text: 'Done', 'data-autofocus': true, onclick: close })));
    emit();
    return { status: 'paid', signature: sig, orderId: o.orderId, result: last.result, account: last.account };
  }
  view(el('p', { class: 'tw-p', text: (last && last.message) || 'Your payment was sent but isn’t verified yet. It’s picked up automatically within a few minutes — no need to pay again.' }),
    el('p', { class: 'tw-p' }, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'View on Solscan ↗' })),
    el('div', { class: 'tw-acts' }, el('button', { type: 'button', class: 'tw-btn', text: 'Close', 'data-autofocus': true, onclick: close })));
  return { status: 'pending', signature: sig, orderId: o.orderId };
}

function showError(e) {
  S.busy = false;
  if (!S.root || (e && e.status === 'cancelled' && !S.root)) return;
  const m = e && e.status === 'disabled' ? { text: e.message } : e && e.status && e.status !== 'error' && e.status !== 'cancelled' ? { text: e.message } : (e && e.http ? { text: e.message } : errorMessage(e));
  view(el('p', { class: 'tw-err', role: 'alert', text: m.text }), el('div', { class: 'tw-acts' }, el('button', { type: 'button', class: 'tw-btn tw-ghost', text: 'Close', 'data-autofocus': true, onclick: close })));
}

function payOrder(req) {
  if (!req || (req.kind !== 'pro' && req.kind !== 'featured')) return Promise.reject(fail('error', 'Bad order.'));
  if (req.kind === 'featured' && !isPubkey(req.ca)) return Promise.reject(fail('error', 'Bad contract address.'));
  if (!CFG.paymentsEnabled && !req.test) { /* the server still decides: allow-listed test wallets can pay the test price */ }
  open(req.kind === 'pro' ? '💎 Get MaxiGems Pro' : '📢 Feature your token');
  return new Promise((resolve, reject) => {
    S.reject = reject;
    payFlow(req).then((r) => { S.reject = null; resolve(r); }, (e) => {
      const err = e && e.status ? e : Object.assign(e instanceof Error ? e : new Error(String(e)), { status: errorMessage(e).kind === 'rejected' ? 'cancelled' : 'error' });
      if (S.reject) { S.reject = null; showError(err); reject(err); }
    });
  });
}

const account = () => api('account');
window.MGPay = { session, signIn, signOut, api, account, payOrder, close, treasury: TREASURY, _state: S };
emit();
