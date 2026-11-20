-- Applied 2026-11-17.
-- Every step of reading a saved invoice file (lib/invoiceDocs.js), for the
-- live "Reading invoices" page and for looking back at what happened.
-- Append-only; server (service role) only.
create table if not exists public.fpx_invoice_doc_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  document_id uuid,
  shipment_id text,
  file text,
  doc_type text,
  step text not null,          -- started | downloaded | unchanged | copied | sent | read | embedded | done | failed | run
  level text not null default 'info' check (level in ('info', 'ok', 'warn', 'error')),
  message text not null,
  ms integer,                  -- how long this step took
  cost_usd numeric
);
create index if not exists fpx_invoice_doc_log_at_idx on public.fpx_invoice_doc_log (at desc);
create index if not exists fpx_invoice_doc_log_doc_idx on public.fpx_invoice_doc_log (document_id, at);
create index if not exists fpx_invoice_doc_log_ship_idx on public.fpx_invoice_doc_log (shipment_id, at);
alter table public.fpx_invoice_doc_log enable row level security;
revoke all on public.fpx_invoice_doc_log from anon, authenticated;
