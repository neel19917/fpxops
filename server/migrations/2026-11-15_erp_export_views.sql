-- Applied to production 2026-11-15 (Supabase migration "erp_export_views").
--
-- The stored FreightPOP data as views with FreightPOP's exact export columns,
-- in the export's own order: fpx_freightpop_transactions_export (one column
-- per History Report column) and fpx_freightpop_audit_export (one per Audit
-- export column). The API rebuilds them (GET /audits/erp/master) with the
-- column list of FreightPOP's newest export, so a new column in FreightPOP
-- shows up here too. Values are as FreightPOP wrote them (text).
-- Every row of the History Report exactly as FreightPOP gives it (a parcel
-- shipment has one row per package; fpx_erp_transactions keeps one per shipment).
create table if not exists public.fpx_erp_transaction_rows (
  row_key text primary key,          -- shipment id | tracking number [| n]
  shipment_id text not null,
  tracking_number text,
  shipped_date date,
  shipment_type text,
  data jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists fpx_erp_transaction_rows_shipment_idx on public.fpx_erp_transaction_rows (shipment_id);
create index if not exists fpx_erp_transaction_rows_shipped_idx on public.fpx_erp_transaction_rows (shipped_date);
alter table public.fpx_erp_transaction_rows enable row level security;
-- Start it from what is already stored (one row per shipment).
insert into public.fpx_erp_transaction_rows (row_key, shipment_id, tracking_number, shipped_date, shipment_type, data, first_seen_at, last_seen_at)
select shipment_id || '|' || coalesce(tracking_key, tracking_number, ''), shipment_id, tracking_number, shipped_date, shipment_type, data, first_seen_at, last_seen_at
from public.fpx_erp_transactions on conflict (row_key) do nothing;

create or replace function public.fpx_erp_rebuild_export_views(tx_cols text[], ap_cols text[])
returns void language plpgsql security definer set search_path = public as $$
declare sel text;
begin
  if tx_cols is not null and array_length(tx_cols, 1) > 0 then
    select string_agg(format('data->>%L as %I', c, c), ', ' order by ord) into sel
      from unnest(tx_cols) with ordinality u(c, ord);
    execute 'drop view if exists public.fpx_freightpop_transactions_export';
    execute format('create view public.fpx_freightpop_transactions_export with (security_invoker = true) as select %s from public.fpx_erp_transaction_rows order by shipped_date desc nulls last, row_key', sel);
  end if;
  if ap_cols is not null and array_length(ap_cols, 1) > 0 then
    select string_agg(format('data->>%L as %I', c, c), ', ' order by ord) into sel
      from unnest(ap_cols) with ordinality u(c, ord);
    execute 'drop view if exists public.fpx_freightpop_audit_export';
    execute format('create view public.fpx_freightpop_audit_export with (security_invoker = true) as select %s from public.fpx_audit_approvals order by approved_date desc nulls last, approval_key', sel);
  end if;
end $$;
revoke all on function public.fpx_erp_rebuild_export_views(text[], text[]) from public, anon, authenticated;
grant execute on function public.fpx_erp_rebuild_export_views(text[], text[]) to service_role;
