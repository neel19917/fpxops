-- Close the holes the Supabase security advisor flagged on the public schema.
-- The anon key ships in the dashboard bundle, so anything anon can reach via
-- PostgREST is effectively public. Only the API server (service role, which
-- bypasses RLS and grants checks) touches these objects directly.

-- 1. fpx_scrape_requests shipped without RLS: anon could read the queue and
--    enqueue/claim rescrapes. Same pattern as the other fpx_* server-only
--    tables: RLS on, no policies.
alter table public.fpx_scrape_requests enable row level security;

-- 2. fpx_analyses_stats is SECURITY DEFINER and was callable by anon and
--    authenticated via /rest/v1/rpc. Only server/routes/analyses.js calls it.
revoke execute on function public.fpx_analyses_stats(text, text, int) from public, anon, authenticated;
grant  execute on function public.fpx_analyses_stats(text, text, int) to service_role;

-- 3. fpx_is_admin / fpx_is_enabled back the RLS policies for the
--    authenticated role, so authenticated keeps EXECUTE. Anon has no policies
--    that use them and no reason to probe user roles.
revoke execute on function public.fpx_is_admin(uuid)   from public, anon;
revoke execute on function public.fpx_is_enabled(uuid) from public, anon;
grant  execute on function public.fpx_is_admin(uuid)   to authenticated, service_role;
grant  execute on function public.fpx_is_enabled(uuid) to authenticated, service_role;

-- 4. Trigger function: pin search_path and drop direct EXECUTE (triggers
--    don't need the caller to hold it).
alter function public.fpx_cascade_share_links_on_shipment_delete() set search_path = public;
revoke execute on function public.fpx_cascade_share_links_on_shipment_delete() from public, anon, authenticated;
