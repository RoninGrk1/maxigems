-- Every 2 minutes: call the `sweep` Edge Function (late/closed-tab payments, expiries + Telegram kicks, featured
-- start/end + the sponsored post). The shared secret lives in Vault as 'maxigems_sweep_secret'
-- (scripts/supabase-deploy.sh creates it and sets the same value as the SWEEP_SECRET function secret).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('maxigems-sweep') where exists (select 1 from cron.job where jobname = 'maxigems-sweep');
select cron.schedule('maxigems-sweep', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://wrlsgqfpcvdjzsueikxw.supabase.co/functions/v1/sweep',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-sweep-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'maxigems_sweep_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 50000);
$$);

-- housekeeping: nonces older than a day
select cron.unschedule('maxigems-nonce-gc') where exists (select 1 from cron.job where jobname = 'maxigems-nonce-gc');
select cron.schedule('maxigems-nonce-gc', '17 * * * *', $$ delete from public.auth_nonces where expires_at < now() - interval '1 day' $$);
