-- Applied to production 2026-11-16 (Supabase migration "shipment_details").
-- What FreightPOP's own Shipment Details page says about a shipment, read by
-- the hosted browser's read-only details job: one row per shipment, replaced
-- by each new read. Named columns for what the tracking dashboard shows; the
-- page's whole text is kept beside them.
create table if not exists public.fpx_shipment_details (
  shipment_id text primary key,
  quote_id text,
  carrier text,
  account_nickname text,
  tracking_number text,
  vendor_name text,
  service text,
  payer text,
  confirmation text,
  ship_from text,
  ship_to text,
  pickup_date text,           -- as FreightPOP shows it (MM/DD/YYYY)
  delivery_date text,
  ready_time text,
  cutoff_time text,
  quantity numeric,
  package_type text,
  dimension text,
  weight_per_piece numeric,
  freight_class text,
  nmfc text,
  description text,
  so_number text,
  po_number text,
  total_units numeric,
  total_weight numeric,
  linear_feet numeric,
  shipment_quote numeric,
  quote_number text,
  sale numeric,
  cost numeric,
  gross_profit numeric,
  quote_freight numeric,      -- the Quote Detail panel
  quote_fuel numeric,
  quote_accessorial_total numeric,
  quote_total numeric,
  quote_accessorials jsonb not null default '[]'::jsonb, -- [{ name, amount }]
  raw_text text,
  data jsonb not null default '{}'::jsonb,               -- typed-in values, the panel's text, the page address
  captured_by text,
  first_captured_at timestamptz not null default now(),
  captured_at timestamptz not null default now()
);
create index if not exists fpx_shipment_details_quote_idx on public.fpx_shipment_details (quote_id);
create index if not exists fpx_shipment_details_carrier_idx on public.fpx_shipment_details (carrier);
alter table public.fpx_shipment_details enable row level security;
