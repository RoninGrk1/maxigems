-- MaxiGems shared payments/auth core + Pro pass. (featured_listings lives in the featured branch's later migration.)
-- All writes go through Edge Functions using the service role. anon/authenticated get NO table access
-- (sessions are MaxiGems SIWS JWTs verified inside the functions, not Supabase Auth). RLS is on everywhere as
-- defence in depth; the "own rows" SELECT policies only apply if a Supabase-auth JWT carrying a `wallet` claim is used later.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  wallet text primary key check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists public.auth_nonces (
  nonce text primary key,
  wallet text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_nonces_exp on public.auth_nonces (expires_at);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  wallet text not null references public.profiles(wallet),
  kind text not null check (kind in ('pro', 'featured')),
  plan text not null,                       -- p30 | p90 | p365 | featured
  days int,                                 -- pro only
  ca text,                                  -- featured only
  meta jsonb not null default '{}'::jsonb,  -- featured: symbol/name/image/safety snapshot
  lamports bigint not null check (lamports > 0),
  test boolean not null default false,
  reference text not null unique,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  signature text unique,                    -- one signature can only ever pay one order
  paid_lamports bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  checked_at timestamptz,
  fulfilled_at timestamptz                  -- set after the per-kind hook succeeded (pro: in fulfil_order; featured: fulfilFeatured)
);
create index if not exists orders_pending on public.orders (status, created_at) where status = 'pending';
create index if not exists orders_wallet on public.orders (wallet, created_at desc);

create table if not exists public.subscriptions (
  wallet text primary key references public.profiles(wallet),
  plan text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_links (
  wallet text primary key references public.profiles(wallet),
  token text unique,
  token_expires_at timestamptz,
  tg_user_id bigint unique,
  linked_at timestamptz,
  invited_at timestamptz,
  removed_at timestamptz
);

-- Live Pro data pushed by the engine (ingest function): 'whale_moves', 'watchlist'.
create table if not exists public.pro_feed (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------- RLS + grants
do $$ declare t text; begin
  foreach t in array array['profiles','auth_nonces','orders','subscriptions','telegram_links','pro_feed','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
  grant usage, select on all sequences in schema public to service_role;
end $$;

drop policy if exists own_subscription on public.subscriptions;
create policy own_subscription on public.subscriptions for select to authenticated using (wallet = (auth.jwt() ->> 'wallet'));
drop policy if exists own_orders on public.orders;
create policy own_orders on public.orders for select to authenticated using (wallet = (auth.jwt() ->> 'wallet'));
grant select on public.subscriptions, public.orders to authenticated;

-- ---------------------------------------------------------------- atomic fulfilment
-- Called by verify-payment and the sweep AFTER the transaction was verified on-chain. Locks the order and marks it
-- paid (idempotent: the same signature again → already=true; a different signature → order_already_paid).
-- kind 'pro': extends the subscription in the same transaction (paying early stacks) and sets fulfilled_at.
-- kind 'featured': only marks it paid; the Edge Function then runs fulfilFeatured() (_shared/featured.ts) and sets
-- fulfilled_at via mark_order_fulfilled(). The sweep retries paid orders whose fulfilled_at is still null.
create or replace function public.fulfil_order(p_order uuid, p_signature text, p_paid bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.orders%rowtype;
  cur timestamptz; nexp timestamptz;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_order'); end if;
  if o.status = 'paid' then
    return jsonb_build_object('ok', o.signature = p_signature, 'already', true, 'kind', o.kind, 'fulfilled', o.fulfilled_at is not null,
      'error', case when o.signature = p_signature then null else 'order_already_paid' end);
  end if;
  if p_paid < o.lamports then return jsonb_build_object('ok', false, 'error', 'short_amount'); end if;
  update public.orders set status = 'paid', signature = p_signature, paid_lamports = p_paid, paid_at = now() where id = o.id;

  if o.kind = 'pro' then
    select expires_at into cur from public.subscriptions where wallet = o.wallet for update;
    nexp := greatest(coalesce(cur, now()), now()) + make_interval(days => o.days); -- paying early stacks
    insert into public.subscriptions (wallet, plan, expires_at, updated_at) values (o.wallet, o.plan, nexp, now())
      on conflict (wallet) do update set plan = excluded.plan, expires_at = excluded.expires_at, updated_at = now();
    update public.telegram_links set removed_at = null where wallet = o.wallet;
    update public.orders set fulfilled_at = now() where id = o.id;
    insert into public.audit_log (actor, action, detail) values (o.wallet, 'pro_paid', jsonb_build_object('order', o.id, 'sig', p_signature, 'lamports', p_paid, 'expires_at', nexp, 'test', o.test));
    return jsonb_build_object('ok', true, 'kind', 'pro', 'fulfilled', true, 'expires_at', nexp);
  end if;

  insert into public.audit_log (actor, action, detail) values (o.wallet, o.kind || '_paid', jsonb_build_object('order', o.id, 'sig', p_signature, 'lamports', p_paid, 'test', o.test));
  return jsonb_build_object('ok', true, 'kind', o.kind, 'fulfilled', false);
end $$;
revoke all on function public.fulfil_order(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.fulfil_order(uuid, text, bigint) to service_role;

create or replace function public.mark_order_fulfilled(p_order uuid)
returns void language sql security definer set search_path = public as $$
  update public.orders set fulfilled_at = coalesce(fulfilled_at, now()) where id = p_order and status = 'paid';
$$;
revoke all on function public.mark_order_fulfilled(uuid) from public, anon, authenticated;
grant execute on function public.mark_order_fulfilled(uuid) to service_role;
