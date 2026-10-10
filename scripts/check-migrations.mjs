// Runs supabase/migrations/*_pro.sql against an in-process Postgres (PGlite) with minimal Supabase stubs
// (roles anon/authenticated/service_role, auth.jwt()), then exercises public.fulfil_order():
// stacking, idempotency, duplicate signatures, featured paid → fulfilled.
// Usage: npm i --no-save @electric-sql/pglite && node scripts/check-migrations.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';

let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { console.log('skip: @electric-sql/pglite not installed'); process.exit(0); }
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
`);
const sql = fs.readFileSync(new URL('../supabase/migrations/20261010120000_pro.sql', import.meta.url), 'utf8').replace(/create extension if not exists pgcrypto;/, '');
await db.exec(sql);
await db.exec(sql); // idempotent re-run
const W = 'DK1enXZB5wKaDtvTGPy1dt6qh2kvhkZnFKEGg4Ypump';
const q = async (s, p) => (await db.query(s, p)).rows;
await q(`insert into profiles (wallet) values ($1)`, [W]);
const order = async (kind, extra = {}) => (await q(`insert into orders (wallet, kind, plan, days, ca, lamports, reference, expires_at, meta)
  values ($1, $2, $3, $4, $5, $6, $7, now() + interval '20 min', $8) returning id`,
  [W, kind, extra.plan ?? (kind === 'pro' ? 'p30' : 'featured'), extra.days ?? (kind === 'pro' ? 30 : null), extra.ca ?? null, extra.lamports ?? 480000000, `ref${Math.random()}`, JSON.stringify({ symbol: 'GEM' })]))[0].id;
const fulfil = async (id, sig, paid) => (await q(`select fulfil_order($1, $2, $3) as r`, [id, sig, paid]))[0].r;

// pro: stacking + idempotent + short + duplicate signature
const o1 = await order('pro');
assert.equal((await fulfil(o1, 'sig1', 479999999)).error, 'short_amount');
const r1 = await fulfil(o1, 'sig1', 480000000);
assert.equal(r1.ok, true);
assert.equal((await fulfil(o1, 'sig1', 480000000)).already, true);
const o2 = await order('pro', { plan: 'p90', days: 90, lamports: 1280000000 });
await assert.rejects(fulfil(o2, 'sig1', 1280000000), /duplicate key/);
const r2 = await fulfil(o2, 'sig2', 1280000000);
const days = (Date.parse(r2.expires_at) - Date.now()) / 86400000;
assert.ok(days > 119.9 && days <= 120.01, `stacked days ${days}`);

// featured: only marked paid here (fulfilment is the featured hook's job); mark_order_fulfilled is idempotent
const of = await order('featured', { ca: 'CA0', lamports: 1000000000 });
const rf = await fulfil(of, 'fs0', 1000000000);
assert.deepEqual([rf.ok, rf.kind, rf.fulfilled], [true, 'featured', false]);
assert.equal((await fulfil(of, 'fs0', 1000000000)).fulfilled, false);
await q('select mark_order_fulfilled($1)', [of]); await q('select mark_order_fulfilled($1)', [of]);
assert.equal((await fulfil(of, 'fs0', 1000000000)).fulfilled, true);
assert.equal((await fulfil(of, 'other', 1000000000)).error, 'order_already_paid');

// grants: anon/authenticated can't touch tables or call fulfil_order
for (const role of ['anon', 'authenticated']) {
  await db.exec(`set role ${role}`);
  await assert.rejects(db.query('select * from telegram_links'), /permission denied/);
  await assert.rejects(db.query(`select fulfil_order('${o1}', 'x', 1)`), /permission denied/);
  await db.exec('reset role');
}
await db.exec(`set role authenticated; select set_config('request.jwt.claims', '{"wallet":"${W}"}', false);`);
assert.equal((await q('select count(*)::int as n from subscriptions'))[0].n, 1);
await db.exec(`select set_config('request.jwt.claims', '{"wallet":"other"}', false);`);
assert.equal((await q('select count(*)::int as n from subscriptions'))[0].n, 0);
await db.exec('reset role');
console.log('migrations OK: tables, RLS/grants, fulfil_order (stacking, idempotency, dup signature, featured paid→hook→fulfilled)');
