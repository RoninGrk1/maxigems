-- MaxiGems Pro pass + Featured listings.
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
  checked_at timestamptz
);
create index if not exists orders_pending on public.orders (status, created_at) where status = 'pending';
create index if not exists orders_wallet on public.orders (wallet, created_at desc);

create table if not exists public.subscriptions (
  wallet text primary key references public.profiles(wallet),
  plan text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.featured_listings (
  id uuid primary key default gen_random_uuid(),
  order_id uuid unique references public.orders(id),
  wallet text not null,
  ca text not null,
  symbol text, name text, image_url text,
  status text not null default 'scheduled' check (status in ('scheduled', 'active', 'ended', 'pulled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  post_due_at timestamptz,
  posted_at timestamptz,
  post_message_id bigint,
  pulled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists featured_live on public.featured_listings (status, ends_at);

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
  foreach t in array array['profiles','auth_nonces','orders','subscriptions','featured_listings','telegram_links','pro_feed','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

drop policy if exists own_subscription on public.subscriptions;
create policy own_subscription on public.subscriptions for select to authenticated using (wallet = (auth.jwt() ->> 'wallet'));
drop policy if exists own_orders on public.orders;
create policy own_orders on public.orders for select to authenticated using (wallet = (auth.jwt() ->> 'wallet'));
grant select on public.subscriptions, public.orders to authenticated;

-- ---------------------------------------------------------------- atomic fulfilment
-- Called by the pay + sweep functions AFTER the transaction was verified on-chain.
-- Locks the order; idempotent (a second call for the same order returns the existing result).
create or replace function public.fulfil_order(p_order uuid, p_signature text, p_paid bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.orders%rowtype;
  cur timestamptz; nexp timestamptz;
  n int; st timestamptz; en timestamptz; last_post timestamptz; due timestamptz; fid uuid;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_order'); end if;
  if o.status = 'paid' then
    return jsonb_build_object('ok', o.signature = p_signature, 'already', true, 'error', case when o.signature = p_signature then null else 'order_already_paid' end);
  end if;
  if p_paid < o.lamports then return jsonb_build_object('ok', false, 'error', 'short_amount'); end if;
  update public.orders set status = 'paid', signature = p_signature, paid_lamports = p_paid, paid_at = now() where id = o.id;

  if o.kind = 'pro' then
    select expires_at into cur from public.subscriptions where wallet = o.wallet for update;
    nexp := greatest(coalesce(cur, now()), now()) + make_interval(days => o.days); -- paying early stacks
    insert into public.subscriptions (wallet, plan, expires_at, updated_at) values (o.wallet, o.plan, nexp, now())
      on conflict (wallet) do update set plan = excluded.plan, expires_at = excluded.expires_at, updated_at = now();
    update public.telegram_links set removed_at = null where wallet = o.wallet;
    insert into public.audit_log (actor, action, detail) values (o.wallet, 'pro_paid', jsonb_build_object('order', o.id, 'sig', p_signature, 'lamports', p_paid, 'expires_at', nexp, 'test', o.test));
    return jsonb_build_object('ok', true, 'kind', 'pro', 'expires_at', nexp);
  end if;

  -- featured: 3 concurrent 24h slots, FIFO waitlist; 1 sponsored channel post per 24h
  perform pg_advisory_xact_lock(hashtext('maxigems_featured'));
  select count(*) into n from public.featured_listings where status in ('scheduled', 'active') and ends_at > now();
  if n < 3 then st := now();
  else
    select ends_at into st from public.featured_listings where status in ('scheduled', 'active') and ends_at > now()
      order by ends_at asc offset (n - 3) limit 1;
  end if;
  en := st + interval '24 hours';
  select max(coalesce(posted_at, post_due_at)) into last_post from public.featured_listings where status <> 'pulled' and (posted_at is not null or post_due_at is not null);
  due := greatest(st, coalesce(last_post + interval '24 hours', st));
  if due > en - interval '1 hour' then due := null; end if; -- no free post slot inside its window: listing only
  insert into public.featured_listings (order_id, wallet, ca, symbol, name, image_url, status, starts_at, ends_at, post_due_at)
    values (o.id, o.wallet, o.ca, o.meta ->> 'symbol', o.meta ->> 'name', o.meta ->> 'image', case when st <= now() then 'active' else 'scheduled' end, st, en, due)
    returning id into fid;
  insert into public.audit_log (actor, action, detail) values (o.wallet, 'featured_paid', jsonb_build_object('order', o.id, 'listing', fid, 'sig', p_signature, 'lamports', p_paid, 'starts_at', st, 'test', o.test));
  return jsonb_build_object('ok', true, 'kind', 'featured', 'listing', fid, 'starts_at', st, 'ends_at', en, 'post_due_at', due);
end $$;
revoke all on function public.fulfil_order(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.fulfil_order(uuid, text, bigint) to service_role;
