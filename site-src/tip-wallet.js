// "Tip with wallet" modal. Lazy-loaded by /assets/tip.js; bundled to /assets/tip-wallet.js (npm run build:tip).
// Phantom, Solflare and Jupiter only. One SystemProgram transfer to the configured tip address; the wallet signs AND sends.
// Never asks for signMessage or anything else.
import { getWallets } from '@wallet-standard/app';
import {
  AMOUNTS, MIN_SOL, MAX_SOL, CHAIN, RPCS, FEE_BUFFER, isPubkey, solToLamports, lamportsToSol, amountError,
  buildTransfer, b58, pickWallets, errorMessage,
} from './tip-core.js';

/* global __TIP_RECIPIENT__ */
const RECIPIENT = __TIP_RECIPIENT__; // baked in from site/config.js at build time
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ------------------------------------------------------------------ toast with a link
function toastLink(text, href, label) {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = text + ' ';
  if (href) t.append(el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label }));
  t.classList.add('show'); clearTimeout(toastLink.t); toastLink.t = setTimeout(() => t.classList.remove('show'), 9000);
}

// ------------------------------------------------------------------ modal
const S = { root: null, body: null, opener: null, wallets: [], wallet: null, account: null, amount: AMOUNTS[1], chip: AMOUNTS[1], busy: false, off: null, gen: 0 };

function focusables() { return [...S.root.querySelectorAll('button:not([disabled]),a[href],input:not([disabled])')].filter((n) => n.offsetParent !== null || n === document.activeElement); }
function onKey(e) {
  if (!S.root) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key === 'Tab') {
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !S.root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !S.root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
}

function view(...nodes) {
  S.body.replaceChildren(...nodes.flat().filter(Boolean));
  const f = S.body.querySelector('[data-autofocus]') || focusables()[0];
  if (f) f.focus({ preventScroll: true });
}

function close() {
  if (!S.root) return;
  document.removeEventListener('keydown', onKey, true);
  if (S.off) { try { S.off(); } catch { /* ignore */ } S.off = null; }
  S.root.remove(); S.root = null; S.gen++;
  document.documentElement.classList.remove('tw-open');
  if (!S.busy) disconnect();
  if (S.opener && S.opener.isConnected) S.opener.focus({ preventScroll: true });
}

async function disconnect() {
  const w = S.wallet; S.wallet = null; S.account = null;
  try {
    if (w && w.std && w.std.features['standard:disconnect']) await w.std.features['standard:disconnect'].disconnect();
    else if (w && w.injected && w.injected.disconnect) await w.injected.disconnect();
  } catch { /* ignore */ }
}

function detect() {
  let std = [];
  try { const api = getWallets(); std = api.get(); if (!S.off) S.off = api.on('register', () => { if (S.root && !S.wallet && !S.busy) renderList(); }); } catch { /* no wallet-standard */ }
  S.wallets = pickWallets(std, window);
}

function logo(w) { return el('img', { class: 'tw-logo', src: w.icon, alt: '', width: 32, height: 32 }); }

function renderList() {
  detect();
  const mobile = isMobile();
  const any = S.wallets.some((w) => w.canSend);
  const here = location.origin + location.pathname + '?tip=1';
  const rows = S.wallets.map((w) => {
    if (w.canSend) {
      return el('button', { type: 'button', class: 'tw-row', onclick: () => connect(w), 'aria-label': `Connect ${w.name}`, 'data-autofocus': w === S.wallets.find((x) => x.canSend) },
        logo(w), el('span', { class: 'tw-name', text: w.name }), el('span', { class: 'tw-tag', text: 'Installed' }), el('span', { class: 'tw-go', text: 'Connect' }));
    }
    if (w.installed) {
      return el('div', { class: 'tw-row tw-dis' }, logo(w), el('span', { class: 'tw-name', text: w.name }), el('span', { class: 'tw-tag', text: 'Installed' }), el('span', { class: 'tw-go', text: 'Update to tip' }));
    }
    const href = mobile ? (w.browse ? w.browse(here, location.origin) : w.mobile || w.install) : w.install;
    const act = mobile ? (w.browse ? 'Open in app' : 'Get the app') : 'Install';
    return el('a', { class: 'tw-row', href, target: mobile && w.browse ? null : '_blank', rel: 'noopener noreferrer', 'aria-label': `${act}: ${w.name}` },
      logo(w), el('span', { class: 'tw-name', text: w.name }), el('span', { class: 'tw-go', text: act }));
  });
  const note = any ? 'Pick your wallet. You approve the exact amount in the wallet before anything is sent.'
    : mobile ? 'No wallet found in this browser. Open MaxiGems inside your wallet app’s browser to tip:'
      : 'No Solana wallet detected in this browser. Install one of these, then reload:';
  view(el('p', { class: 'tw-p', text: note }), el('div', { class: 'tw-list' }, rows),
    el('p', { class: 'tw-fine', text: 'Solana only · Phantom, Solflare or Jupiter · MaxiGems never sees your keys.' }));
}

async function connect(w) {
  const gen = S.gen;
  view(el('p', { class: 'tw-p', text: `Approve the connection in ${w.name}…` }), el('div', { class: 'tw-acts' }, el('button', { type: 'button', class: 'tw-btn tw-ghost', text: 'Back', onclick: renderList })));
  try {
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
    if (gen !== S.gen) return;
    if (!isPubkey(account.address)) throw new Error('Wallet returned an invalid account.');
    S.wallet = w; S.account = account;
    renderAmount();
  } catch (e) {
    if (gen !== S.gen) return;
    renderError(errorMessage(e), renderList);
  }
}

function renderAmount(errText) {
  const w = S.wallet, a = S.account;
  const err = el('p', { class: 'tw-err', id: 'twAmtErr', role: 'alert', text: errText || '' });
  const sum = el('p', { class: 'tw-sum' });
  const send = el('button', { type: 'button', class: 'tw-btn', 'data-autofocus': true });
  const input = el('input', { class: 'tw-in', id: 'twAmt', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'twAmtErr', placeholder: 'Custom', value: AMOUNTS.includes(S.amount) ? '' : S.amount });
  const chips = AMOUNTS.map((v) => el('button', { type: 'button', class: 'tw-chip', 'aria-pressed': String(S.amount === v), text: `${v} SOL`,
    onclick: () => { S.chip = v; S.amount = v; input.value = ''; sync(); } }));
  function sync() {
    const msg = amountError(S.amount);
    chips.forEach((c, i) => c.setAttribute('aria-pressed', String(AMOUNTS[i] === S.amount && !input.value)));
    err.textContent = input.value && msg ? msg : (errText && !input.value ? errText : '');
    input.setAttribute('aria-invalid', String(!!(input.value && msg)));
    const ok = !msg;
    send.disabled = !ok;
    send.textContent = ok ? `Send ${lamportsToSol(solToLamports(S.amount))} SOL` : 'Send';
    sum.textContent = ok ? `You’ll send ${lamportsToSol(solToLamports(S.amount))} SOL + a tiny network fee (~0.000005 SOL).` : `Between ${MIN_SOL} and ${MAX_SOL} SOL.`;
  }
  input.addEventListener('input', () => { S.amount = input.value.trim() || S.chip; sync(); });
  send.addEventListener('click', () => sendTip());
  view(
    el('div', { class: 'tw-kv' },
      el('span', { text: 'From' }), el('b', {}, logo(w), ` ${w.name} · ${short(a.address)}`),
      el('span', { text: 'To' }), el('code', { class: 'tw-to', title: 'MaxiGems tip address', text: RECIPIENT })),
    el('div', { class: 'tw-chips', role: 'group', 'aria-label': 'Tip amount' }, chips,
      el('label', { class: 'tw-lbl', for: 'twAmt' }, el('span', { class: 'sr', text: 'Custom amount in SOL' }), input, el('span', { 'aria-hidden': 'true', text: 'SOL' }))),
    err, sum,
    el('div', { class: 'tw-acts' }, send, el('button', { type: 'button', class: 'tw-btn tw-ghost', text: 'Disconnect', onclick: async () => { await disconnect(); renderList(); } })),
  );
  sync();
}

function renderError(m, back) {
  view(el('p', { class: 'tw-p tw-bad', role: 'alert', text: m.text }),
    el('div', { class: 'tw-acts' },
      el('button', { type: 'button', class: 'tw-btn', text: 'Try again', 'data-autofocus': true, onclick: back }),
      el('button', { type: 'button', class: 'tw-btn tw-ghost', text: 'Close', onclick: close })));
}

async function sendTip() {
  const w = S.wallet, a = S.account; if (!w || !a || S.busy) return;
  const lam = solToLamports(S.amount);
  if (amountError(S.amount) || lam === null) return renderAmount('Check the amount.');
  const status = el('p', { class: 'tw-p', role: 'status', text: 'Preparing transaction…' });
  view(status, el('p', { class: 'tw-fine', text: `${lamportsToSol(lam)} SOL → ${short(RECIPIENT)}` }));
  S.busy = true;
  let sig = null;
  try {
    const card = S.opener && S.opener.getAttribute('data-tip');
    if (!isPubkey(RECIPIENT) || (card && card !== RECIPIENT)) throw new Error('Tip recipient failed validation — refusing to send.');
    const bal = await rpc('getBalance', [a.address, { commitment: 'confirmed' }]);
    if (bal && typeof bal.value === 'number' && BigInt(bal.value) < lam + FEE_BUFFER) throw new Error('insufficient funds');
    const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const tx = buildTransfer({ from: a.address, to: RECIPIENT, recipient: RECIPIENT, lamports: lam, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
    status.textContent = `Confirm ${lamportsToSol(lam)} SOL to ${short(RECIPIENT)} in ${w.name}…`;
    if (w.std) {
      const out = await w.std.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: a.std, chain: CHAIN, transaction: tx.wire, options: { commitment: 'confirmed' } });
      const s = Array.isArray(out) ? out[0] : out;
      sig = s && s.signature && (typeof s.signature === 'string' ? s.signature : b58(s.signature));
    } else {
      const out = await w.injected.request({ method: 'signAndSendTransaction', params: { message: b58(tx.message) } });
      sig = out && out.signature;
    }
    if (!sig || typeof sig !== 'string') throw new Error('The wallet did not return a transaction signature.');
    const url = `https://solscan.io/tx/${encodeURIComponent(sig)}`;
    status.textContent = 'Sent — confirming on Solana…';
    const res = await confirm(sig, BigInt(bh.lastValidBlockHeight));
    S.busy = false;
    if (res === 'ok') {
      toastLink(`Tip sent — thank you! 💎 ${lamportsToSol(lam)} SOL`, url, 'View on Solscan ↗');
      if (S.root) {
        view(el('p', { class: 'tw-p tw-good', text: `Thank you! 💎 ${lamportsToSol(lam)} SOL is on its way to the gem engine.` }),
          el('p', { class: 'tw-p' }, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'View transaction on Solscan ↗' })),
          el('div', { class: 'tw-acts' }, el('button', { type: 'button', class: 'tw-btn', text: 'Close', 'data-autofocus': true, onclick: close })));
      }
    } else {
      toastLink('Tip sent but not confirmed yet —', url, 'check Solscan ↗');
      if (S.root) {
        view(el('p', { class: 'tw-p', text: 'Your wallet sent the tip, but it isn’t confirmed yet. It may still land — check Solscan before trying again.' }),
          el('p', { class: 'tw-p' }, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'View on Solscan ↗' })),
          el('div', { class: 'tw-acts' }, el('button', { type: 'button', class: 'tw-btn', text: 'Close', 'data-autofocus': true, onclick: close })));
      }
    }
    await disconnect();
  } catch (e) {
    S.busy = false;
    const m = errorMessage(e);
    if (S.root) renderError(m, () => (S.wallet ? renderAmount() : renderList()));
    else toastLink(m.text);
  }
}

/** Poll signature status until confirmed, failed, expired or ~75s. Returns 'ok' | 'timeout'; throws on on-chain error/expiry. */
async function confirm(sig, lastValid) {
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 75000; i++) {
    await sleep(i ? 2000 : 1200);
    let st = null;
    try { st = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }])).value[0]; } catch { continue; }
    if (st && st.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'ok';
    if (!st && i % 4 === 3) {
      try { const h = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]); if (BigInt(h) > lastValid) throw new Error('block height exceeded'); } catch (e) { if (/exceeded/.test(e.message)) throw e; }
    }
  }
  return 'timeout';
}

export function open(opener) {
  if (S.root) return;
  S.opener = opener || document.activeElement; S.gen++;
  const body = el('div', { class: 'tw-body', 'aria-live': 'polite' });
  const modal = el('div', { class: 'tw-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'twTitle' },
    el('div', { class: 'tw-head' }, el('h2', { id: 'twTitle', text: '💎 Tip the Gem Engine' }), el('button', { type: 'button', class: 'tw-x', 'aria-label': 'Close tip dialog', text: '×', onclick: close })),
    body);
  const back = el('div', { class: 'tw-back', onmousedown: (e) => { if (e.target === back) close(); } }, modal);
  S.root = back; S.body = body;
  document.body.append(back);
  document.documentElement.classList.add('tw-open');
  document.addEventListener('keydown', onKey, true);
  if (!isPubkey(RECIPIENT)) return renderError({ text: 'Tip address is misconfigured — tipping is disabled.' }, close);
  if (S.wallet && S.account) renderAmount(); else renderList();
}

window.MGTipWallet = { open, close, _state: S };
