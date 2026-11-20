-- Applied to production 2026-11-15 (Supabase migration "shipment_records").
-- What the hosted browser captured for a shipment in FreightPOP, one row per
-- shipment and kind: "view_shipment" (the View Shipment dialog: its text,
-- fields and tables), "invoice" (the invoice PDF Get Invoice opens).
create table if not exists public.fpx_shipment_records (
  shipment_id text not null,
  kind text not null,
  audit_id uuid,
  data jsonb not null default '{}'::jsonb,   -- fields, tables, tabs as read from the page
  text text,                                 -- the plain text of what was on screen
  files text[] not null default '{}',        -- erp-pulls/<audit_id>/<file>
  captured_by text,
  first_captured_at timestamptz not null default now(),
  captured_at timestamptz not null default now(),
  primary key (shipment_id, kind)
);
alter table public.fpx_shipment_records enable row level security;
