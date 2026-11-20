-- Applied 2026-11-17.
-- What GET /audits/erp/pushed reads. FreightPOP's own column titles have
-- spaces ("GL Code"), which a PostgREST select cannot name, so the few that
-- are shown are given plain names here. Read-only; server (service role) only.
create or replace view public.fpx_erp_pushed_transactions with (security_invoker = true) as
select t.shipment_id, t.tracking_number, t.tracking_key, t.customer_name, t.carrier, t.shipped_date,
       t.billing_invoice_number, t.charge, t.cost, t.gross_profit, t.approved_invoice_amount,
       t.invoice_approved_date, t.exported_to_erp, t.exported_changed_at, t.first_seen_at, t.last_seen_at,
       nullif(btrim(t.data->>'Batch Number'), '') as batch_number
from public.fpx_erp_transactions t;

create or replace view public.fpx_erp_pushed_approvals with (security_invoker = true) as
select a.approval_key, a.tracking_number, a.tracking_key, a.invoice_number, a.carrier, a.approved_date, a.approved_by,
       a.invoice_amount, a.exported_date, a.last_seen_at,
       a.data->>'Exported' as exported, a.data->>'GL Code' as gl_code, a.data->>'Internal Vendor ID' as internal_vendor_id,
       a.data->>'PO Number' as po_number, a.data->>'SO Number' as so_number, a.data->>'BOL Number' as bol_number,
       a.data->>'Payee' as payee
from public.fpx_audit_approvals a;

revoke all on public.fpx_erp_pushed_transactions, public.fpx_erp_pushed_approvals from anon, authenticated;
