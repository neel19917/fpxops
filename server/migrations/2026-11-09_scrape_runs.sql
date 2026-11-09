-- Scrape run history + full logs, written by the hosted browser service
-- (browser-service/, Railway service "fpx-browser") after every Refresh All —
-- manual (from fpx_scrape_requests) and scheduled.
--
-- id is the fpx_scrape_requests id for manual runs, or "sch_…" for scheduled
-- runs. log is the full tab-separated run log (timestamp, level, text), capped
-- by the service at 5,000 lines.
--
-- Server-only, like the other fpx_* tables: RLS on with no policies, so only
-- the service role (browser-service, API server) can read or write it.

create table if not exists public.fpx_scrape_runs (
  id             text primary key,
  source         text not null check (source in ('manual', 'schedule')),
  user_email     text not null,
  schedule_id    text,
  schedule_name  text,
  started_at     timestamptz not null,
  finished_at    timestamptz not null,
  duration_ms    integer not null,
  ok             boolean not null,
  note           text,
  counts         jsonb,
  log            text,
  log_lines      integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists idx_scrape_runs_started on public.fpx_scrape_runs (started_at desc);
create index if not exists idx_scrape_runs_user    on public.fpx_scrape_runs (user_email, started_at desc);

alter table public.fpx_scrape_runs enable row level security;
