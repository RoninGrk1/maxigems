// Featured listings: validation, caps, waitlist scheduling, 1 post/day, signed admin links, XSS escaping, DRY_RUN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FEATURED_RULES, isMint, normalizeCa, evaluate, schedule, tick, visibleNow, publicListing, humanReason,
  signAdminToken, verifyAdminToken, adminLinkExp, adminUrl, adminBookingMessage,
} from '../supabase/functions/_shared/featured-core.js';
import { analyzeReport, SAFETY_DEFAULTS } from '../supabase/functions/_shared/safety-rules.js';
import { sponsoredMessage, sponsoredButtons, SPONSORED_LABEL } from '../src/format.js';
import { runFeatured, featuredRules, restClient } from '../src/featured.js';
import { fakePair, fakeReport, POOL } from './fixtures.js';

delete process.env.SUPABASE_SERVICE_ROLE_KEY; // never touch the real project from tests
const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const CA = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const CA2 = 'So11111111111111111111111111111111111111112';
const H = 3600000, DAY = 24 * H;
const T0 = Date.parse('2026-10-10T12:00:00Z');
const SECRET = 'k'.repeat(48);
const iso = (t) => new Date(t).toISOString();
const base = (o = {}) => ({ ca: CA, pairs: [fakePair({ pairCreatedAt: T0 - 5 * H })], report: fakeReport(), ruggedCas: new Set(), listings: [], analyzeReport, safetyRules: SAFETY_DEFAULTS, now: T0, ...o });
const row = (id, start, o = {}) => ({ id, ca: `CA${id}`, symbol: `S${id}`, status: start <= T0 ? 'active' : 'queued', starts_at: iso(start), ends_at: iso(start + DAY), post_due_at: iso(start), posted_at: null, ...o });

// ------------------------------------------------------------------ rules stay in sync with the engine
test('featured minimums + safety rules are the engine’s (config.json)', () => {
  assert.equal(FEATURED_RULES.minLiquidityUsd, CFG.filters.minLiquidityUsd);
  assert.equal(FEATURED_RULES.minAgeMinutes, CFG.filters.minAgeMinutes);
  for (const [k, v] of Object.entries(SAFETY_DEFAULTS)) assert.equal(CFG.safety[k], v, `safety.${k}`);
  assert.equal(featuredRules(CFG).maxConcurrent, 3);
  assert.equal(featuredRules(CFG).maxPostsPerDay, 1);
  assert.equal(CFG.featured.adminChatId, '8995645285');
});

// ------------------------------------------------------------------ validation
test('isMint: base58 that decodes to exactly 32 bytes', () => {
  assert.ok(isMint(CA) && isMint(CA2) && isMint(POOL));
  for (const bad of ['', 'abc', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'O'.repeat(44), `${CA}xx`, '0xdeadbeef', null, 42, `${CA.slice(0, 30)}`]) assert.equal(isMint(bad), false, String(bad));
  assert.equal(normalizeCa(`  https://dexscreener.com/solana/${CA}  `), CA);
  assert.equal(normalizeCa(`"${CA}"`), CA);
  assert.equal(normalizeCa('nope'), '');
});

test('evaluate: a clean token passes with a quote', () => {
  const r = evaluate(base());
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.equal(r.token.symbol, 'GEM');
  assert.equal(r.safety.lpLockedPct, 100);
  assert.equal(r.quote.startsAt, iso(T0));
  assert.equal(r.quote.endsAt, iso(T0 + DAY));
  assert.equal(r.quote.waitlisted, false);
});

test('evaluate: every failure is explained and has no quote (no payment option)', () => {
  const cases = [
    [{ ca: 'not-a-mint' }, /not a valid Solana token address/],
    [{ pairs: [] }, /No Solana trading pair/],
    [{ pairs: [fakePair({ chainId: 'ethereum' })] }, /No Solana trading pair/],
    [{ pairs: [fakePair({ liquidity: { usd: 19999 }, pairCreatedAt: T0 - 5 * H })] }, /Liquidity is \$19,999 \(minimum \$20,000\)/],
    [{ pairs: [fakePair({ pairCreatedAt: T0 - 30 * 60000 })] }, /30 minutes old \(minimum 90 minutes\)/],
    [{ report: null }, /failed closed/],
    [{ report: fakeReport({ mintAuthority: 'Abc', token: { mintAuthority: 'Abc', supply: 1e15 } }) }, /Mint authority is still active/],
    [{ report: fakeReport({ freezeAuthority: 'Abc' }) }, /Freeze authority/],
    [{ report: fakeReport({ markets: [{ pubkey: POOL, lp: { lpLockedPct: 40 } }] }) }, /Only 40% of liquidity is locked/],
    [{ report: fakeReport({ rugged: true }) }, /flags this token as rugged/],
    [{ report: fakeReport({ risks: [{ name: 'Single holder ownership', level: 'danger' }] }) }, /danger warnings: Single holder ownership/],
    [{ report: fakeReport({ totalHolders: 50 }) }, /Only 50 holders \(minimum 200\)/],
    [{ ruggedCas: new Set([CA]) }, /MaxiGems has flagged this token as rugged/],
    [{ listings: [row('a', T0 - H, { ca: CA })] }, /already featured or waiting/],
    [{ listings: [row('a', T0 + 5 * H, { ca: CA, status: 'queued' })] }, /already featured or waiting/],
  ];
  for (const [o, re] of cases) {
    const r = evaluate(base(o));
    assert.equal(r.ok, false, String(re));
    assert.equal(r.quote, null);
    assert.ok(r.reasons.some((x) => re.test(x)), `${re} not in ${JSON.stringify(r.reasons)}`);
    assert.ok(r.reasons.every((x) => !/^safety:/.test(x)), 'reasons are plain English');
  }
  // an ended/pulled listing for the same CA doesn't block a new booking
  assert.equal(evaluate(base({ listings: [row('a', T0 - 2 * DAY, { ca: CA, status: 'ended' }), row('b', T0 - H, { ca: CA, status: 'pulled' })] })).ok, true);
  assert.match(humanReason('safety: top10 41.2%'), /41.2%.*maximum 35%/);
});

// ------------------------------------------------------------------ caps + waitlist + 1 post/day
test('schedule: free slot now; post cap pushes the next booking so its post fits its own window', () => {
  assert.deepEqual(schedule([], T0), { startsAt: iso(T0), endsAt: iso(T0 + DAY), postDueAt: iso(T0), waitlisted: false, ahead: 0 });
  const a = row('a', T0, { post_due_at: iso(T0) });
  const q = schedule([a], T0);
  // next post ≥ 24h after a's → start at T0+1h, post at T0+24h (1h before the window closes)
  assert.equal(q.startsAt, iso(T0 + H));
  assert.equal(q.postDueAt, iso(T0 + DAY));
  assert.equal(q.waitlisted, true);
});

test('schedule: max 3 concurrent → waitlist with the next available start', () => {
  const rules = { ...FEATURED_RULES, maxPostsPerDay: 24 }; // isolate the slot cap
  const ls = [row('a', T0 - 10 * H), row('b', T0 - 5 * H), row('c', T0 - 2 * H)];
  const q = schedule(ls, T0, rules);
  assert.equal(q.startsAt, iso(T0 + 14 * H)); // a ends first
  assert.equal(q.waitlisted, true);
  assert.equal(schedule(ls.slice(0, 2), T0, rules).startsAt, iso(T0)); // 2 live → free now
  // pulled / ended listings don't hold a slot
  assert.equal(schedule([...ls.slice(0, 2), { ...ls[2], status: 'pulled' }], T0, rules).startsAt, iso(T0));
});

test('schedule: random booking storms never break the caps (≤3 live, posts ≥24h apart, each post inside its window)', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (const perDay of [1, 2, 3]) {
    const rules = { ...FEATURED_RULES, maxPostsPerDay: perDay };
    const ls = []; let now = T0;
    for (let i = 0; i < 40; i++) {
      now += Math.floor(rnd() * 10 * H);
      const q = schedule(ls, now, rules);
      ls.push({ id: String(i), ca: `C${i}`, status: Date.parse(q.startsAt) <= now ? 'active' : 'queued', starts_at: q.startsAt, ends_at: q.endsAt, post_due_at: q.postDueAt });
      assert.ok(Date.parse(q.startsAt) >= now);
      assert.ok(Date.parse(q.postDueAt) >= Date.parse(q.startsAt) && Date.parse(q.postDueAt) <= Date.parse(q.endsAt) - rules.postLeadMs, `post in window #${i}`);
    }
    const ev = ls.flatMap((l) => [[Date.parse(l.starts_at), 1], [Date.parse(l.ends_at), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, peak = 0; for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur); }
    assert.ok(peak <= 3, `peak ${peak}`);
    const posts = ls.map((l) => Date.parse(l.post_due_at)).sort((a, b) => a - b);
    for (let i = 1; i < posts.length; i++) assert.ok(posts[i] - posts[i - 1] >= DAY / perDay - 1, `post gap ${(posts[i] - posts[i - 1]) / H}h`);
  }
});

test('tick: queued → active → ended by time, and at most ONE sponsored post per 24h', () => {
  const ls = [
    row('a', T0 - 2 * H, { status: 'queued' }),
    row('b', T0 - DAY - H, { status: 'active' }),
    row('c', T0 - 3 * H, { status: 'active', post_due_at: iso(T0 - 3 * H) }),
    row('d', T0 + H, { status: 'queued' }),
  ];
  const t = tick(ls, T0);
  assert.deepEqual(t.activate, ['a']);
  assert.deepEqual(t.end, ['b']);
  assert.deepEqual(t.post, ['c'], 'oldest due first, only one');
  // a post 23h ago blocks everything
  assert.deepEqual(tick([...ls, row('z', T0 - 30 * H, { status: 'ended', posted_at: iso(T0 - 23 * H) })], T0).post, []);
  assert.deepEqual(tick([...ls, row('z', T0 - 30 * H, { status: 'ended', posted_at: iso(T0 - 24 * H) })], T0).post, ['c']);
  // pulled / already posted / not started / post skipped → never posted
  assert.deepEqual(tick([row('p', T0 - H, { status: 'pulled' }), row('q', T0 - H, { posted_at: iso(T0 - 25 * H) }), row('r', T0 + H, { status: 'queued' }), row('s', T0 - H, { post_skipped: 'x' })], T0).post, []);
  assert.deepEqual(visibleNow(ls, T0).map((l) => l.id), ['c', 'a'], 'live by time, oldest first (b already ended, d not started)');
});

// ------------------------------------------------------------------ signed admin links
test('admin link HMAC: valid, expired, tampered, wrong secret/action, malformed', async () => {
  const exp = T0 + 6 * H;
  const tok = await signAdminToken({ id: '0b6c4c1e-1d1f-4c51-9d0e-1f2a3b4c5d6e', exp }, SECRET);
  assert.deepEqual(await verifyAdminToken(tok, SECRET, { now: T0 }), { ok: true, id: '0b6c4c1e-1d1f-4c51-9d0e-1f2a3b4c5d6e' });
  assert.equal((await verifyAdminToken(tok, SECRET, { now: exp })).error, 'expired');
  const [id, e, sig] = tok.split('.');
  const flip = (s) => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');
  assert.equal((await verifyAdminToken(`${id}.${e}.${flip(sig)}`, SECRET, { now: T0 })).error, 'bad_signature');
  assert.equal((await verifyAdminToken(`${id}.${Number(e) + 86400}.${sig}`, SECRET, { now: T0 })).error, 'bad_signature', 'extending expiry breaks the signature');
  assert.equal((await verifyAdminToken(`${flip(id)}.${e}.${sig}`, SECRET, { now: T0 })).error, 'bad_signature', 'another listing id breaks it');
  assert.equal((await verifyAdminToken(tok, 'x'.repeat(48), { now: T0 })).error, 'bad_signature');
  assert.equal((await verifyAdminToken(tok, SECRET, { now: T0, action: 'delete' })).error, 'bad_signature');
  for (const bad of ['', 'a.b.c', `${id}.${e}`, `${id}.${e}.${sig}x`, `<script>.${e}.${sig}`]) assert.equal((await verifyAdminToken(bad, SECRET, { now: T0 })).ok, false);
  assert.equal((await verifyAdminToken(tok, 'short', { now: T0 })).ok, false);
  await assert.rejects(signAdminToken({ id: 'x', exp }, 'short'), /too short/);
  assert.equal(adminLinkExp(iso(T0 + 200 * H), T0), T0 + 72 * H, 'capped at 72h');
  assert.equal(adminLinkExp(iso(T0 + 5 * H), T0), T0 + 5 * H, 'never outlives the listing');
  assert.equal(adminUrl('https://maxigems.fun', tok), `https://maxigems.fun/featured/admin/#${tok}`);
});

// ------------------------------------------------------------------ XSS / escaping
const EVIL = { ca: CA, symbol: '<img src=x onerror=alert(1)>', wallet: CA2, order_id: 'o1', status: 'active', starts_at: iso(T0), ends_at: iso(T0 + DAY), post_due_at: iso(T0),
  token: { name: '</b><a href="javascript:alert(1)">x</a>', imageUrl: 'javascript:alert(1)', pairAddress: '"><script>', dex: 'pumpswap', priceUsd: 0.001, marketCap: 1e6, liquidityUsd: 5e4 },
  safety: { mintRevoked: true, freezeRevoked: true, lpLockedPct: 100, top10Pct: 20, holders: 900 } };

test('sponsored channel post: labelled, escaped like calls, Track & Share + chart buttons', () => {
  const html = sponsoredMessage(EVIL, CFG);
  assert.match(html, /Sponsored – not financial advice/);
  assert.equal(SPONSORED_LABEL, 'Sponsored – not financial advice');
  assert.ok(!html.includes('<img') && !html.includes('<script') && !html.includes('javascript:alert(1)">'), html);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const tags = html.match(/<\/?([a-z]+)/g).map((t) => t.replace(/[</]/g, ''));
  assert.ok(tags.every((t) => ['b', 'i', 'a', 'code'].includes(t)), `only Telegram-safe tags: ${[...new Set(tags)]}`);
  assert.ok(html.includes(`<code>${CA}</code>`));
  const btn = sponsoredButtons(EVIL, CFG).flat();
  assert.deepEqual(btn.map((b) => b.text), ['📊 Chart', '🔎 Solscan', '💎 Track & Share']);
  assert.equal(btn[0].url, `https://dexscreener.com/solana/${CA}`, 'invalid pair address falls back to the CA');
  assert.equal(btn[2].url, `https://maxigems.fun/featured/?ca=${CA}`);
});

test('admin DM + public projection: escaped, no wallet/order id leaks, unsafe image dropped', () => {
  const m = adminBookingMessage(EVIL, { url: 'https://maxigems.fun/featured/admin/#t', sol: '1', signature: '5sig' });
  assert.ok(!m.text.includes('<img') && !m.text.includes('</b><a'), m.text);
  assert.deepEqual(m.buttons[0], [{ text: '🛑 Pull listing', url: 'https://maxigems.fun/featured/admin/#t' }]);
  assert.ok(m.buttons.flat().every((b) => b.url && !b.callback_data), 'URL buttons only (no callbacks → no webhook needed)');
  const p = publicListing(EVIL);
  assert.equal(p.imageUrl, null);
  assert.equal(p.pairAddress, null);
  assert.ok(!('wallet' in p) && !('order_id' in p) && !('post_message_id' in p));
  assert.ok(!JSON.stringify(p).includes(CA2), 'payer wallet never public');
});

test('site scripts build DOM with textContent only (no innerHTML / eval)', () => {
  for (const f of ['sponsored.js', 'featured.js', 'featured-admin.js']) {
    const src = fs.readFileSync(new URL(`../site/assets/${f}`, import.meta.url), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), f);
  }
});

// ------------------------------------------------------------------ engine step (DRY_RUN + live, fake Supabase/Telegram)
function fakeDb(rows) {
  const calls = [];
  return { calls, rows,
    listings: async () => rows.map((r) => ({ ...r })),
    patch: async (id, body) => { calls.push(['patch', id, body]); Object.assign(rows.find((r) => r.id === id), body); },
    pull: async (id, by, reason) => { calls.push(['pull', id, by, reason]); Object.assign(rows.find((r) => r.id === id), { status: 'pulled' }); return { ok: true }; } };
}
function deps(db, o = {}) {
  const out = { posts: [], dms: [], files: [] };
  return { out, d: { db, write: (f) => out.files.push(f), post: async (html, buttons) => { out.posts.push({ html, buttons }); return 4242; }, dm: async (chat, html) => out.dms.push({ chat, html }), recheck: async () => ({ ok: true, safety: EVIL.safety }), ...o } };
}

test('engine DRY_RUN: prints the post, writes featured.json, never writes to Supabase', async () => {
  const db = fakeDb([{ ...EVIL, id: 'L1', status: 'queued', starts_at: iso(T0 - H), post_due_at: iso(T0 - H) }]);
  const { out, d } = deps(db);
  const r = await runFeatured({ cfg: CFG, now: T0, mode: 'dry', deps: d });
  assert.equal(out.posts.length, 1, 'post printed through the DRY_RUN Telegram path');
  assert.deepEqual(db.calls, [], 'no PATCH / RPC in DRY_RUN');
  assert.deepEqual(r.activated, ['L1']);
  const f = out.files[0];
  assert.equal(f.listings.length, 1);
  assert.equal(f.label, 'Sponsored – not financial advice');
  assert.ok(!JSON.stringify(f).includes(CA2), 'no payer wallet in featured.json');
});

test('engine live: posts once, stores post_message_id, then respects the 24h cap across runs', async () => {
  const db = fakeDb([
    { ...EVIL, id: 'L1', status: 'active', starts_at: iso(T0 - H), post_due_at: iso(T0 - H) },
    { ...EVIL, ca: CA2, id: 'L2', status: 'active', starts_at: iso(T0 - H), post_due_at: iso(T0 - 30 * 60000) },
  ]);
  const { out, d } = deps(db);
  await runFeatured({ cfg: CFG, now: T0, mode: 'live', deps: d });
  assert.equal(out.posts.length, 1);
  assert.deepEqual(db.calls.find((c) => c[0] === 'patch' && c[2].post_message_id), ['patch', 'L1', { posted_at: iso(T0), post_message_id: 4242 }]);
  await runFeatured({ cfg: CFG, now: T0 + 20 * 60000, mode: 'live', deps: d });
  await runFeatured({ cfg: CFG, now: T0 + 23 * H, mode: 'live', deps: d });
  assert.equal(out.posts.length, 1, 'no second sponsored post inside 24h');
  assert.equal(out.files.at(-1).listings.length, 2);
});

test('engine: failed safety re-check → no post, auto-pull, admin told; transient failure → retry later', async () => {
  const mk = () => fakeDb([{ ...EVIL, id: 'L1', status: 'active', starts_at: iso(T0 - H), post_due_at: iso(T0 - H) }]);
  let db = mk(); let x = deps(db, { recheck: async () => ({ ok: false, reasons: ['safety: LP locked 10%'] }) });
  let r = await runFeatured({ cfg: CFG, now: T0, mode: 'live', deps: x.d });
  assert.equal(x.out.posts.length, 0);
  assert.deepEqual(r.pulled, ['L1']);
  assert.ok(db.calls.some((c) => c[0] === 'pull' && c[2] === 'auto-safety'));
  assert.equal(x.out.dms[0].chat, '8995645285');
  assert.equal(x.out.files[0].listings.length, 0, 'pulled listing disappears from the site');
  db = mk(); x = deps(db, { recheck: async () => ({ ok: false, transient: true, reasons: ['rugcheck unavailable'] }) });
  r = await runFeatured({ cfg: CFG, now: T0, mode: 'live', deps: x.d });
  assert.equal(x.out.posts.length + r.pulled.length + x.out.dms.length, 0);
  // DRY_RUN auto-pull: printed, not written
  db = mk(); x = deps(db, { recheck: async () => ({ ok: false, reasons: ['flagged rugged by MaxiGems'] }) });
  await runFeatured({ cfg: CFG, now: T0, mode: 'dry', deps: x.d });
  assert.deepEqual(db.calls, []);
});

test('engine: Supabase down keeps the last known listings (still time-filtered); no key → empty file, no client', async () => {
  const { out, d } = deps({ listings: async () => { throw new Error('supabase GET 503'); } }, { previous: { listings: [publicListing({ ...EVIL, ends_at: iso(T0 + H) }), publicListing({ ...EVIL, ends_at: iso(T0 - H) })] } });
  const r = await runFeatured({ cfg: CFG, now: T0, mode: 'live', deps: d });
  assert.match(r.error, /503/);
  assert.equal(out.files[0].stale, true);
  assert.equal(out.files[0].listings.length, 1);
  assert.equal(restClient({ key: '' }), null);
  const e = deps(null); await runFeatured({ cfg: CFG, now: T0, mode: 'live', deps: e.d });
  assert.deepEqual(e.out.files[0].listings, []);
});

test('engine wiring: featuredStep in DRY_RUN prints via Telegram DRY path and writes site/data/featured.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-feat-'));
  process.env.MAXIGEMS_SITE_DATA = path.join(dir, 'calls.json');
  process.env.MAXIGEMS_STATE = path.join(dir, 'state.json');
  process.env.DRY_RUN = '1';
  const realFetch = globalThis.fetch; const hits = [];
  globalThis.fetch = async (u) => { hits.push(String(u)); if (String(u).includes('/tokens/v1/solana/')) return new Response(JSON.stringify([fakePair()])); if (String(u).includes('rugcheck')) return new Response(JSON.stringify(fakeReport())); return new Response('{"result":{"value":[]}}'); };
  const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    const { featuredStep } = await import('../src/engine.js');
    const db = fakeDb([{ ...EVIL, symbol: 'GEM', token: { ...EVIL.token, name: 'Gem', pairAddress: POOL }, id: 'L1', status: 'active', starts_at: new Date(Date.now() - H).toISOString(), ends_at: new Date(Date.now() + 20 * H).toISOString(), post_due_at: new Date(Date.now() - H).toISOString() }]);
    await featuredStep({ state: { calls: [] }, cfg: CFG, now: Date.now(), mode: 'dry', tgBroken: false, db });
    assert.ok(!hits.some((u) => u.includes('api.telegram.org')), 'no Telegram request in DRY_RUN');
    assert.ok(logs.some((l) => l.includes('[DRY_RUN] sendPhoto') || l.includes('[DRY_RUN] sendMessage')), 'post printed');
    assert.ok(logs.some((l) => l.includes('Sponsored – not financial advice')));
    assert.deepEqual(db.calls, []);
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'featured.json')));
    assert.equal(f.listings[0].ca, CA);
  } finally { console.log = realLog; globalThis.fetch = realFetch; delete process.env.DRY_RUN; }
});

test('build gate: a changed sponsored listing set deploys right away; unchanged stays batched', async () => {
  const { decide, featuredKey } = await import('../scripts/build-gate.mjs');
  const a = JSON.stringify({ updatedAt: '1', listings: [{ ca: CA, startsAt: 's', endsAt: 'e' }] });
  const b = JSON.stringify({ updatedAt: '2', listings: [{ ca: CA, startsAt: 's', endsAt: 'e' }] });
  assert.equal(featuredKey(a), featuredKey(b), 'timestamps alone don’t force a build');
  assert.notEqual(featuredKey(a), featuredKey(JSON.stringify({ listings: [] })), 'pull → build');
  assert.deepEqual(decide([], 1000, 1060, 1680, true).reason, 'featured changed');
  assert.equal(decide([], 1000, 1060, 1680, false).build, false);
});
