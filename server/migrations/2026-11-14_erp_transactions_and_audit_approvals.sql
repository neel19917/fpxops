-- Applied to production 2026-11-14 (Supabase migration
-- "erp_transactions_and_audit_approvals").
--
-- Durable copies of what the invoicing scrapes read from FreightPOP, kept
-- current by upsert on every pull, so the data can be maintained and queried
-- in Supabase rather than only as per-run snapshots.

-- One row per FreightPOP shipment from Transactions > History Report.
create table if not exists public.fpx_erp_transactions (
  shipment_id text primary key,
  tracking_number text,
  tracking_key text,                 -- normalised tracking number, for matching
  customer_id text,
  customer_name text,
  account_manager text,
  carrier text,
  service text,
  status text,
  transaction_type text,
  shipped_date date,
  billing_invoice_number text,
  charge numeric,                    -- Shipment Marked-Up Rate
  cost numeric,                      -- Shipment Rate without mark up
  gross_profit numeric,
  approved_invoice_amount numeric,   -- Original + Additional Approved Invoice Amount
  invoice_approved_date date,
  not_approved_invoice_amount numeric,
  quote_invoice_variance numeric,
  exported_to_erp boolean,
  customer_invoice_sent text,
  shipment_type text,                -- non-parcel | parcel
  data jsonb not null default '{}'::jsonb,   -- every column of the report row
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_pull_audit_id uuid,
  exported_changed_at timestamptz    -- when exported_to_erp last flipped
);
create index if not exists fpx_erp_transactions_tracking_key_idx on public.fpx_erp_transactions (tracking_key);
create index if not exists fpx_erp_transactions_not_exported_idx on public.fpx_erp_transactions (charge desc) where exported_to_erp is not true;
create index if not exists fpx_erp_transactions_shipped_idx on public.fpx_erp_transactions (shipped_date);

-- One row per approved carrier invoice from Audit > Recently Approved / History.
create table if not exists public.fpx_audit_approvals (
  approval_key text primary key,     -- tracking_key | invoice number
  tracking_number text,
  tracking_key text,
  invoice_number text,
  carrier text,
  carrier_scac text,
  approved_date date,
  approved_at_text text,             -- as FreightPOP printed it
  approved_by text,                  -- tidied name, or 'EDI'
  approved_by_kind text,             -- edi | person | unknown
  approved_by_raw text,
  uploaded_by text,
  invoice_amount numeric,
  quote_amount numeric,
  variance numeric,
  invoice_date date,
  shipment_date date,
  exported_date date,
  notes text,
  source text,                       -- recently_approved | history
  data jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists fpx_audit_approvals_tracking_key_idx on public.fpx_audit_approvals (tracking_key);
create index if not exists fpx_audit_approvals_kind_idx on public.fpx_audit_approvals (approved_by_kind);

alter table public.fpx_erp_transactions enable row level security;
alter table public.fpx_audit_approvals enable row level security;

-- Each shipment with its latest approval: the matched picture in one place.
create or replace view public.fpx_erp_invoicing with (security_invoker = true) as
select
  t.shipment_id, t.tracking_number, t.customer_name, t.carrier, t.shipped_date,
  t.charge, t.cost, t.gross_profit, t.exported_to_erp,
  t.approved_invoice_amount, t.not_approved_invoice_amount,
  a.approval_key is not null as in_audit_approvals,
  (a.approval_key is not null or coalesce(t.approved_invoice_amount, 0) <> 0) as approved,
  a.approved_by, a.approved_by_kind,
  (a.approved_by_kind = 'edi') as approved_by_edi,
  a.approved_date, a.invoice_number as approved_invoice_number,
  a.invoice_amount as approved_amount, a.variance as approval_variance,
  a.notes as approval_notes, a.uploaded_by, a.source as approval_source,
  case
    when t.exported_to_erp is true then 'exported'
    when a.approval_key is not null or coalesce(t.approved_invoice_amount, 0) <> 0 then 'approved_ready'
    when coalesce(t.not_approved_invoice_amount, 0) <> 0 then 'invoice_not_approved'
    else 'no_invoice'
  end as bucket,
  t.last_seen_at, t.first_seen_at
from public.fpx_erp_transactions t
left join lateral (
  select * from public.fpx_audit_approvals a
  where a.tracking_key is not null and a.tracking_key = t.tracking_key
  order by a.approved_date desc nulls last, a.last_seen_at desc
  limit 1
) a on true;
