-- MaxiGems Featured listings (1 SOL = 24h sponsored spot on /trending/ + one "Sponsored" channel post).
-- Runs AFTER the Pro/payments core migration (orders table). Idempotent.
-- Access: RLS on with NO policies → anon/authenticated can't read or write. Only the service role (Edge Functions,
-- engine) touches this table. The public site reads site/data/featured.json, which the engine writes each run.

create table if not exists public.featured_listings (
  id uuid primary key default gen_random_uuid(),
  ca text not null check (ca ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  symbol text not null default '' check (char_length(symbol) <= 16),
  order_id uuid unique references public.orders(id) on delete restrict,
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'active', 'ended', 'pulled')),
  post_due_at timestamptz,
  posted_at timestamptz,
  post_message_id bigint,
  post_skipped text,                     -- why the channel post was not sent (e.g. failed safety re-check)
  token jsonb not null default '{}'::jsonb,   -- name/image/pair at booking time
  safety jsonb not null default '{}'::jsonb,  -- safety snapshot at booking time (RugCheck summary)
  pulled_at timestamptz,
  pulled_by text,
  pull_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint featured_window check (ends_at > starts_at)
);

-- one live (queued/active) listing per token
create unique index if not exists featured_listings_one_live_per_ca on public.featured_listings (ca) where status in ('queued', 'active');
create index if not exists featured_listings_live_idx on public.featured_listings (status, starts_at, ends_at);

alter table public.featured_listings enable row level security;
revoke all on public.featured_listings from anon, authenticated;
grant select, insert, update on public.featured_listings to service_role;

create or replace function public.featured_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists featured_listings_touch on public.featured_listings;
create trigger featured_listings_touch before update on public.featured_listings for each row execute function public.featured_touch();

-- Atomic booking under an advisory lock. Mirrors schedule() in supabase/functions/_shared/featured-core.js
-- (scripts/check-featured-migration.mjs checks they agree):
--   start = earliest t ≥ now with < max_concurrent live listings overlapping [t, t+hours) AND a channel post slot
--   (≥ 24h/posts_per_day after the last planned/sent post) that lands ≥ post_lead before the window closes.
-- Idempotent per order_id.
create or replace function public.featured_book(
  p_ca text, p_symbol text, p_order_id uuid, p_wallet text, p_token jsonb, p_safety jsonb,
  p_now timestamptz default now(), p_hours int default 24, p_max_concurrent int default 3,
  p_posts_per_day int default 3, p_post_lead interval default interval '1 hour'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  dur interval := make_interval(hours => p_hours);
  gap interval := interval '24 hours' / greatest(1, p_posts_per_day);
  last_post timestamptz;
  post_floor timestamptz;
  c timestamptz;
  t timestamptz;
  lst public.featured_listings;
begin
  perform pg_advisory_xact_lock(hashtext('mg_featured_book'));
  select * into lst from public.featured_listings where order_id = p_order_id;
  if found then return jsonb_build_object('ok', true, 'already', true, 'listing', to_jsonb(lst)); end if;
  update public.featured_listings set status = 'ended' where status in ('queued', 'active') and ends_at <= p_now;
  if exists (select 1 from public.featured_listings where ca = p_ca and status in ('queued', 'active')) then
    return jsonb_build_object('ok', false, 'error', 'already_featured');
  end if;
  select max(coalesce(posted_at, post_due_at)) into last_post from public.featured_listings where status <> 'pulled';
  post_floor := case when last_post is null then '-infinity'::timestamptz else last_post + gap end;
  for c in
    select x from (
      select p_now as x
      union select ends_at from public.featured_listings where status in ('queued', 'active')
      union select post_floor - (dur - p_post_lead)
    ) s where x >= p_now and isfinite(x) order by x
  loop
    if greatest(c, post_floor) <= c + dur - p_post_lead
       and (select count(*) from public.featured_listings
            where status in ('queued', 'active') and starts_at < c + dur and ends_at > c) < p_max_concurrent then
      t := c; exit;
    end if;
  end loop;
  if t is null then
    select greatest(p_now, max(ends_at), case when isfinite(post_floor) then post_floor - (dur - p_post_lead) else p_now end)
      into t from public.featured_listings where status in ('queued', 'active');
  end if;
  insert into public.featured_listings (ca, symbol, order_id, wallet, starts_at, ends_at, status, post_due_at, token, safety)
  values (p_ca, left(coalesce(p_symbol, ''), 16), p_order_id, p_wallet, t, t + dur,
          case when t <= p_now then 'active' else 'queued' end, greatest(t, post_floor), coalesce(p_token, '{}'::jsonb), coalesce(p_safety, '{}'::jsonb))
  returning * into lst;
  return jsonb_build_object('ok', true, 'listing', to_jsonb(lst));
end $$;

-- Pull (admin link / auto safety re-check). Idempotent; ended listings can't be pulled.
create or replace function public.featured_pull(p_id uuid, p_by text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare lst public.featured_listings;
begin
  update public.featured_listings set status = 'pulled', pulled_at = now(), pulled_by = left(p_by, 40), pull_reason = left(p_reason, 200)
    where id = p_id and status in ('queued', 'active') returning * into lst;
  if found then return jsonb_build_object('ok', true, 'listing', to_jsonb(lst)); end if;
  select * into lst from public.featured_listings where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', lst.status = 'pulled', 'already', true, 'listing', to_jsonb(lst), 'error', case when lst.status = 'pulled' then null else 'not_live' end);
end $$;

revoke all on function public.featured_book(text, text, uuid, text, jsonb, jsonb, timestamptz, int, int, int, interval) from public, anon, authenticated;
revoke all on function public.featured_pull(uuid, text, text) from public, anon, authenticated;
grant execute on function public.featured_book(text, text, uuid, text, jsonb, jsonb, timestamptz, int, int, int, interval) to service_role;
grant execute on function public.featured_pull(uuid, text, text) to service_role;
