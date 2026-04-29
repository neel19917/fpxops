-- Lock down two tables that shipped without RLS enabled. Every other fpx_*
-- table is RLS-on with no policies — the API server uses the Supabase service
-- role, which bypasses RLS, while anon/authenticated PostgREST traffic is
-- blocked.
alter table public.fpx_settings         enable row level security;
alter table public.fpx_shipment_scrapes enable row level security;
