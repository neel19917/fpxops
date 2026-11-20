-- Applied to production 2026-11-15 (Supabase migration "click_log").
-- The audit log of the hosted browser: every click a job makes on a
-- FreightPOP page, in order, and every click FPX stopped (blocked = true:
-- a control that sends, cancels or deletes is never pressed).
create table if not exists public.fpx_click_log (
  id bigint generated always as identity primary key,
  clicked_at timestamptz not null default now(),
  request_id uuid,            -- fpx_scrape_requests.id of the job
  job text,                   -- erp_audit | approval_check | get_invoice
  run_by text,                -- whose FreightPOP session the job ran in
  n integer,                  -- the click's number within the job's page
  label text not null,        -- the text of what was clicked
  tag text,                   -- its element: button, a, input …
  page text,                  -- the FreightPOP page (path and #route)
  shipment_id text,           -- the shipment being worked on, when there is one
  blocked boolean not null default false,
  by_person boolean not null default false, -- a real mouse click in the hosted view, not the job
  created_at timestamptz not null default now()
);
create index if not exists fpx_click_log_request_idx on public.fpx_click_log (request_id, n);
create index if not exists fpx_click_log_shipment_idx on public.fpx_click_log (shipment_id) where shipment_id is not null;
create index if not exists fpx_click_log_at_idx on public.fpx_click_log (clicked_at desc);
alter table public.fpx_click_log enable row level security;
