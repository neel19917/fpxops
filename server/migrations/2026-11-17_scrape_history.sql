-- Applied 2026-11-17.
-- What changed between two reads of FreightPOP, for everything FPX reads and
-- stores other than the tracking grid (whose every scrape is already kept in
-- fpx_shipment_scrapes, with its diff).
--
-- Append-only. One row when FPX first sees an entity, and one row each time a
-- later read finds a stored value different. A read that finds nothing
-- changed writes NO row here: the entity's own last_seen_at / captured_at
-- already holds the time of the latest read. Rows are never updated or
-- deleted by the server (see server/lib/scrapeHistory.js).
--
--   source       entity_key                 the entity's table
--   erp_transactions   shipment_id          fpx_erp_transactions
--   audit_approvals    approval_key         fpx_audit_approvals
--   shipment_details   shipment_id          fpx_shipment_details
--   shipment_record    shipment_id|kind     fpx_shipment_records
create table if not exists public.fpx_scrape_history (
  id bigint generated always as identity primary key,
  source text not null,
  entity_key text not null,
  event text not null check (event in ('first_seen', 'changed')),
  scraped_at timestamptz not null,       -- the read that saw this (the entity's last_seen_at / captured_at of that read)
  previous_scraped_at timestamptz,       -- the read before it; null on first_seen
  changes jsonb not null default '{}'::jsonb, -- { field: { from, to } }; on first_seen, from is null
  request_id uuid,                       -- the read's job: fpx_scrape_requests.id, or the ERP pull's audit id
  run_by text,                           -- who or what handed the read in
  created_at timestamptz not null default now()
);
create index if not exists fpx_scrape_history_entity_idx on public.fpx_scrape_history (source, entity_key, scraped_at desc);
create index if not exists fpx_scrape_history_at_idx on public.fpx_scrape_history (scraped_at desc);
-- For the summary's "changes in the last 24 hours / 7 days" per source.
create index if not exists fpx_scrape_history_changed_idx on public.fpx_scrape_history (source, scraped_at desc) where event = 'changed';

alter table public.fpx_scrape_history enable row level security;
revoke all on public.fpx_scrape_history from anon, authenticated;

-- A captured record's text can be half a megabyte. To tell whether a new
-- capture differs, the server compares this fingerprint instead of reading the
-- stored text back. The database fills both columns itself; nothing writes them.
alter table public.fpx_shipment_records
  add column if not exists text_md5 text generated always as (md5(text)) stored,
  add column if not exists text_chars integer generated always as (char_length(text)) stored;
