-- Task board (segments, health flags, shipment dispositions) at the start / end of each scrape run.
alter table public.fpx_scrape_runs add column if not exists tasks_before jsonb, add column if not exists tasks_after jsonb;
