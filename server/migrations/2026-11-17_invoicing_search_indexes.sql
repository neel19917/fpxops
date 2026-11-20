-- Applied 2026-11-17.
-- Not applied yet.
-- Indexes for the search of the Invoices page (GET /audits/erp/invoicing?q=).
--
-- The search used to run `ilike '%q%'` on the view fpx_erp_invoicing, which
-- joins every shipment to its latest approval, plus one count per step: five
-- full scans and joins of ~48k shipments per keystroke, which ran past the
-- 8 s statement timeout. The server now finds matching shipment ids on the
-- base tables first (server/lib/invoicingSearch.js) and reads only those from
-- the view. These indexes make that first step an index lookup.
--
-- pg_trgm is installed in schema `extensions`. A trigram GIN index serves
-- `ilike '%term%'` for terms of 3 or more characters; shorter terms still scan
-- the base table (no join), which is well under a second.
--
-- Plain CREATE INDEX locks writes to the table while it builds (a few seconds
-- for these sizes). Run it when no scrape is writing, or run each statement
-- on its own (not in a transaction) with CREATE INDEX CONCURRENTLY instead.

-- fpx_erp_transactions: what the search matches on.
create index if not exists fpx_erp_transactions_shipment_id_trgm
  on public.fpx_erp_transactions using gin (shipment_id extensions.gin_trgm_ops);
create index if not exists fpx_erp_transactions_tracking_number_trgm
  on public.fpx_erp_transactions using gin (tracking_number extensions.gin_trgm_ops);
create index if not exists fpx_erp_transactions_billing_invoice_number_trgm
  on public.fpx_erp_transactions using gin (billing_invoice_number extensions.gin_trgm_ops);
create index if not exists fpx_erp_transactions_customer_name_trgm
  on public.fpx_erp_transactions using gin (customer_name extensions.gin_trgm_ops);
create index if not exists fpx_erp_transactions_carrier_trgm
  on public.fpx_erp_transactions using gin (carrier extensions.gin_trgm_ops);

-- fpx_audit_approvals: carrier invoice and tracking numbers → tracking_key.
create index if not exists fpx_audit_approvals_invoice_number_trgm
  on public.fpx_audit_approvals using gin (invoice_number extensions.gin_trgm_ops);
create index if not exists fpx_audit_approvals_tracking_number_trgm
  on public.fpx_audit_approvals using gin (tracking_number extensions.gin_trgm_ops);
-- Exact lookups (approval checks read approvals by tracking_number).
create index if not exists fpx_audit_approvals_invoice_number_idx
  on public.fpx_audit_approvals (invoice_number);
create index if not exists fpx_audit_approvals_tracking_number_idx
  on public.fpx_audit_approvals (tracking_number);

-- The view's LEFT JOIN LATERAL picks each shipment's latest approval by
-- `tracking_key = t.tracking_key order by approved_date desc nulls last,
-- last_seen_at desc limit 1`: this index answers it without a sort.
-- (fpx_audit_approvals_tracking_key_idx on tracking_key alone already exists
-- and is kept.)
create index if not exists fpx_audit_approvals_tracking_latest_idx
  on public.fpx_audit_approvals (tracking_key, approved_date desc nulls last, last_seen_at desc)
  where tracking_key is not null;

analyze public.fpx_erp_transactions;
analyze public.fpx_audit_approvals;
