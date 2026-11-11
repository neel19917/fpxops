-- Scrape mode filter (applied 2026-11-11 as scrape_requests_modes).
alter table public.fpx_scrape_requests add column if not exists modes text[];
alter table public.fpx_scrape_runs add column if not exists modes text[];
