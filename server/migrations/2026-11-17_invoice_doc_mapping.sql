-- Applied 2026-11-17.
-- 1. Map what Claude read off each saved document onto FreightPOP's own data
--    for the shipment, as one view: fpx_invoice_doc_matches. One row per read
--    document with what FreightPOP holds beside it, a true / false / null
--    (nothing to compare) per check, and the list of checks that failed.
--      select shipment_id, doc_type, mismatches from fpx_invoice_doc_matches where cardinality(mismatches) > 0;
--      select * from fpx_invoice_doc_matches where doc_type = 'invoice' and amount_match = false;
-- 2. Ask FPX: what the documents say goes into each tracked shipment's facts,
--    its searchable text and its embedded text (fpx_assistant_reindex), so
--    the chat finds a shipment by its invoice, BOL, PRO or PO number and by
--    what the documents say. Embedded on the next index rebuild, only where
--    the text changed.

-- An id as it can be compared: letters and digits only, upper case, no leading zeros.
create or replace function public.fpx_norm_id(p text)
 returns text
 language sql
 immutable
as $$
  select nullif(ltrim(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '0'), '');
$$;

create or replace view public.fpx_invoice_doc_matches with (security_invoker = true) as
with j as (
  select d.id, d.shipment_id, d.doc_type, d.file, d.extracted_at, d.confidence,
         d.invoice_number, d.tracking_number, d.bol_number, d.po_number, d.carrier, d.bill_to, d.total,
         t.customer_name as fp_customer, t.carrier as fp_carrier, t.tracking_number as fp_tracking,
         t.billing_invoice_number as fp_invoice_number, t.charge as fp_charge, t.cost as fp_cost,
         t.approved_invoice_amount as fp_approved, t.exported_to_erp as fp_exported, t.last_seen_at as fp_read_at,
         sd.po_number as fp_po, sd.tracking_number as fp_details_tracking,
         -- What the document's total should equal: the customer's charge on an
         -- invoice or quote, the carrier's cost on a rate confirmation.
         case d.doc_type when 'invoice' then t.charge when 'quote' then t.charge when 'rate_confirmation' then t.cost end as expected_total
  from public.fpx_invoice_documents d
  left join public.fpx_erp_transactions t on t.shipment_id = d.shipment_id
  left join public.fpx_shipment_details sd on sd.shipment_id = d.shipment_id
  where d.status = 'done'
), c as (
  select j.*,
    case when j.tracking_number is null or coalesce(j.fp_tracking, j.fp_details_tracking) is null then null
         else public.fpx_norm_id(j.tracking_number) in (public.fpx_norm_id(j.fp_tracking), public.fpx_norm_id(j.fp_details_tracking)) end as tracking_match,
    case when j.bol_number is null then null
         else public.fpx_norm_id(j.bol_number) in (public.fpx_norm_id(j.shipment_id), public.fpx_norm_id('SHP' || j.shipment_id)) end as bol_match,
    case when j.doc_type <> 'invoice' or j.invoice_number is null then null
         else public.fpx_norm_id(j.invoice_number) in (public.fpx_norm_id(j.shipment_id), public.fpx_norm_id(j.fp_invoice_number)) end as invoice_number_match,
    case when j.po_number is null or j.fp_po is null then null
         else public.fpx_norm_id(j.po_number) = public.fpx_norm_id(j.fp_po) end as po_match,
    case when j.carrier is null or j.fp_carrier is null then null
         else lower(j.carrier) like '%' || lower(j.fp_carrier) || '%' or lower(j.fp_carrier) like '%' || lower(j.carrier) || '%'
              or extensions.similarity(lower(j.carrier), lower(j.fp_carrier)) >= 0.3 end as carrier_match,
    case when j.total is null or j.expected_total is null then null else round(j.total - j.expected_total, 2) end as amount_diff,
    case when j.total is null or j.expected_total is null then null else abs(j.total - j.expected_total) <= 0.01 end as amount_match
  from j
)
select c.*,
  array_remove(array[
    case when c.tracking_match = false then 'PRO / tracking number differs from FreightPOP' end,
    case when c.bol_match = false then 'BOL number is not this shipment''s' end,
    case when c.invoice_number_match = false then 'Invoice number differs from FreightPOP' end,
    case when c.po_match = false then 'PO number differs from FreightPOP' end,
    case when c.carrier_match = false then 'Carrier differs from FreightPOP' end,
    case when c.amount_match = false then
      case c.doc_type when 'rate_confirmation' then 'Total differs from FreightPOP''s cost' else 'Total differs from FreightPOP''s charge' end end
  ], null) as mismatches
from c;
revoke all on public.fpx_invoice_doc_matches from anon, authenticated;

-- Ask FPX: the documents in each shipment's facts, searchable text and embedded text.
do $do$
declare
  def text := pg_get_functiondef('public.fpx_assistant_reindex()'::regprocedure);
  step record;
begin
  if position('fpx_invoice_documents' in def) > 0 then
    raise notice 'fpx_assistant_reindex already reads fpx_invoice_documents: nothing to do';
    return;
  end if;
  for step in
    select * from (values
      (1, 'left join public.fpx_shipment_details fd on fd.shipment_id = s.shipment_id',
          'left join public.fpx_shipment_details fd on fd.shipment_id = s.shipment_id' || chr(10) ||
          '    left join lateral (' || chr(10) ||
          '      select count(*) as n, max(x.extracted_at) as read_at,' || chr(10) ||
          '             string_agg(distinct x.invoice_number, '', '') filter (where x.doc_type = ''invoice'') as inv_no,' || chr(10) ||
          '             max(x.total) filter (where x.doc_type = ''invoice'') as inv_total,' || chr(10) ||
          '             max(x.total) filter (where x.doc_type = ''rate_confirmation'') as rc_total,' || chr(10) ||
          '             string_agg(distinct x.bol_number, '', '') as bol_no,' || chr(10) ||
          '             string_agg(distinct x.tracking_number, '', '') as pro_no,' || chr(10) ||
          '             string_agg(distinct x.po_number, '', '') as po_no,' || chr(10) ||
          '             string_agg(x.doc_type || '': '' || left(x.summary, 300), '' | '' order by x.doc_type) as summaries' || chr(10) ||
          '      from public.fpx_invoice_documents x where x.shipment_id = s.shipment_id and x.status = ''done''' || chr(10) ||
          '    ) idoc on true'),
      (2, 'fd.vendor_name as fp_vendor, fd.account_nickname as fp_account, fd.captured_at as fp_read_at',
          'fd.vendor_name as fp_vendor, fd.account_nickname as fp_account, fd.captured_at as fp_read_at,' || chr(10) ||
          '           idoc.n as doc_n, idoc.read_at as doc_read_at, idoc.inv_no as doc_inv_no, idoc.inv_total as doc_inv_total,' || chr(10) ||
          '           idoc.rc_total as doc_rc_total, idoc.bol_no as doc_bol, idoc.pro_no as doc_pro, idoc.po_no as doc_po, idoc.summaries as doc_summaries'),
      (3, '''read_from_freightpop_at'', fp_read_at)) end',
          '''read_from_freightpop_at'', fp_read_at)) end,' || chr(10) ||
          '      ''documents'', case when coalesce(doc_n, 0) > 0 then jsonb_strip_nulls(jsonb_build_object(' || chr(10) ||
          '        ''count'', doc_n, ''invoice_number'', doc_inv_no, ''invoice_total'', doc_inv_total,' || chr(10) ||
          '        ''rate_confirmation_total'', doc_rc_total, ''bol_number'', doc_bol, ''pro_number'', doc_pro, ''po_number'', doc_po,' || chr(10) ||
          '        ''read_at'', doc_read_at)) end'),
      (4, 'fp_quote_no, fp_vendor, fp_account, history) as doc',
          'fp_quote_no, fp_vendor, fp_account, doc_inv_no, doc_bol, doc_pro, doc_po, history) as doc'),
      (5, '''Tracking history: '' || history) as sem',
          '''Documents read: '' || doc_summaries,' || chr(10) ||
          '      ''Tracking history: '' || history) as sem')
    ) as t(n, find, put) order by n
  loop
    if (length(def) - length(replace(def, step.find, ''))) / length(step.find) <> 1 then
      raise exception 'fpx_assistant_reindex: edit % expected its anchor exactly once', step.n;
    end if;
    def := replace(def, step.find, step.put);
  end loop;
  execute def;
end
$do$;
