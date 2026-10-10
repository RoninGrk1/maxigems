-- service_role needs DML on Pro tables (featured migration already granted featured_listings).
-- Without this, Edge Functions get PostgREST 403 / SQLSTATE 42501 on ingest, orders, etc.
grant select, insert, update, delete on
  public.profiles, public.auth_nonces, public.orders, public.subscriptions,
  public.telegram_links, public.pro_feed, public.audit_log, public.featured_listings
  to service_role;
grant usage, select on all sequences in schema public to service_role;
