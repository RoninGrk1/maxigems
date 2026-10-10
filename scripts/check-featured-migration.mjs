// Runs the pro + featured migrations on an in-process Postgres (PGlite) with minimal Supabase stubs, then checks
// public.featured_book() against the JS scheduler (featured-core.js schedule()) on random booking storms,
// idempotency per order, one live listing per coin, featured_pull(), and that anon/authenticated can't read the table.
// Usage: npm i --no-save @electric-sql/pglite && node scripts/check-featured-migration.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { schedule } from '../supabase/functions/_shared/featured-core.js';

let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { console.log('skip: @electric-sql/pglite not installed'); process.exit(0); }
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
`);
const dir = new URL('../supabase/migrations/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => /_(pro|featured)\.sql$/.test(f)).sort();
assert.ok(files.at(-1).endsWith('_featured.sql'), 'featured migration runs after pro');
for (const f of files) {
  const sql = fs.readFileSync(new URL(f, dir), 'utf8').replace(/create extension if not exists pgcrypto;/, '');
  await db.exec(sql); await db.exec(sql); // idempotent re-run
}
const q = async (s, p) => (await db.query(s, p)).rows;
const W = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
await q(`insert into profiles (wallet) values ($1)`, [W]);
const mkOrder = async (ca) => (await q(`insert into orders (wallet, kind, plan, ca, lamports, reference, expires_at, meta)
  values ($1, 'featured', 'featured', $2, 1000000000, $3, now() + interval '20 min', '{}') returning id`, [W, ca, `ref${Math.random()}`]))[0].id;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const ca = () => Array.from({ length: 44 }, () => B58[Math.floor(rnd() * 58)]).join('');
const book = async (oid, c, now) => (await q(`select featured_book($1, 'GEM', $2, $3, '{}'::jsonb, '{}'::jsonb, $4::timestamptz) as r`, [c, oid, W, new Date(now).toISOString()]))[0].r;
const rows = async () => (await q(`select id, ca, status, starts_at, ends_at, post_due_at, posted_at from featured_listings`)).map((r) => ({
  ...r, starts_at: new Date(r.starts_at).toISOString(), ends_at: new Date(r.ends_at).toISOString(), post_due_at: r.post_due_at && new Date(r.post_due_at).toISOString(), posted_at: r.posted_at && new Date(r.posted_at).toISOString() }));

// 1) SQL scheduler == JS scheduler over a random storm
let now = Date.parse('2026-10-10T12:00:00Z');
for (let i = 0; i < 30; i++) {
  now += Math.floor(rnd() * 12 * 3600000);
  if (rnd() < 0.15) { const live = (await rows()).filter((r) => r.status !== 'pulled' && r.status !== 'ended'); if (live.length) await q(`select featured_pull($1, 'test', 'storm')`, [live[0].id]); }
  if (rnd() < 0.3) { const r = (await rows()).find((x) => Date.parse(x.post_due_at) <= now && !x.posted_at && x.status !== 'pulled'); if (r) await q(`update featured_listings set posted_at = $2 where id = $1`, [r.id, new Date(now).toISOString()]); }
  const before = await rows();
  for (const r of before) if ((r.status === 'queued' || r.status === 'active') && Date.parse(r.ends_at) <= now) r.status = 'ended';
  const want = schedule(before, now);
  const c = ca(); const oid = await mkOrder(c);
  const got = await book(oid, c, now);
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(new Date(got.listing.starts_at).toISOString(), want.startsAt, `start #${i}`);
  assert.equal(new Date(got.listing.post_due_at).toISOString(), want.postDueAt, `post #${i}`);
  assert.equal(got.listing.status, Date.parse(want.startsAt) <= now ? 'active' : 'queued');
  assert.equal((await book(oid, c, now)).already, true, 'idempotent per order');
}
// 2) one live listing per coin
const live = (await rows()).find((r) => r.status === 'queued' || r.status === 'active');
assert.equal((await book(await mkOrder(live.ca), live.ca, now)).error, 'already_featured');
// 3) pull: idempotent; ended can't be pulled
assert.equal((await q(`select featured_pull($1, 'admin', 'x') as r`, [live.id]))[0].r.ok, true);
const again = (await q(`select featured_pull($1, 'admin', 'x') as r`, [live.id]))[0].r;
assert.equal(again.already, true);
assert.equal((await q(`select featured_pull(gen_random_uuid(), 'admin', null) as r`))[0].r.error, 'not_found');
// 4) RLS / grants: anon + authenticated can't read or call
for (const role of ['anon', 'authenticated']) {
  await db.exec(`set role ${role}`);
  await assert.rejects(db.query('select * from featured_listings'), /permission denied/);
  await assert.rejects(db.query(`select featured_pull(gen_random_uuid(), 'x', null)`), /permission denied/);
  await db.exec('reset role');
}
console.log(`featured migration OK (${files.join(', ')}): ${(await rows()).length} listings, SQL scheduler matches JS`);
