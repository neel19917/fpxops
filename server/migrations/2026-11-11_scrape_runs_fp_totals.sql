-- FreightPOP dashboard tiles at the start / end of each scrape run (trends).
alter table public.fpx_scrape_runs add column if not exists fp_before jsonb, add column if not exists fp_after jsonb;
