-- Applied to production 2026-11-16 (Supabase migration "assistant_index_shipment_details").
-- Ask FPX (the text chat) now knows what the read-only details job stored for
-- a shipment: sale, cost, gross profit, margin and the quote breakdown from
-- fpx_shipment_details. They are added to each shipment's facts, to its
-- searchable text (quote number, vendor) and to the text that is embedded.
-- Written as edits to the function as it stands, so nothing else in it moves.
do $do$
declare
  def text := pg_get_functiondef('public.fpx_assistant_reindex()'::regprocedure);
  step record;
begin
  if position('fpx_shipment_details' in def) > 0 then
    raise notice 'fpx_assistant_reindex already reads fpx_shipment_details: nothing to do';
    return;
  end if;
  for step in
    select * from (values
      (1, 'left join notes nt on nt.sid = s.id',
          'left join notes nt on nt.sid = s.id' || chr(10) ||
          '    left join public.fpx_shipment_details fd on fd.shipment_id = s.shipment_id'),
      (2, '(s.scraped_at is null or s.scraped_at >= v_cutoff) as on_dash',
          '(s.scraped_at is null or s.scraped_at >= v_cutoff) as on_dash,' || chr(10) ||
          '           fd.sale as fp_sale, fd.cost as fp_cost, fd.gross_profit as fp_gp, fd.quote_number as fp_quote_no,' || chr(10) ||
          '           fd.quote_freight as fp_freight, fd.quote_fuel as fp_fuel, fd.quote_accessorial_total as fp_acc, fd.quote_total as fp_quote_total,' || chr(10) ||
          '           fd.vendor_name as fp_vendor, fd.account_nickname as fp_account, fd.captured_at as fp_read_at'),
      (3, '''history'', left(history, 500)',
          '''history'', left(history, 500),' || chr(10) ||
          '      ''financials'', case when fp_sale is not null or fp_cost is not null or fp_quote_total is not null then jsonb_strip_nulls(jsonb_build_object(' || chr(10) ||
          '        ''sale'', fp_sale, ''cost'', fp_cost, ''gross_profit'', fp_gp,' || chr(10) ||
          '        ''margin_pct'', case when fp_sale > 0 and fp_gp is not null then round(fp_gp / fp_sale * 100, 1) end,' || chr(10) ||
          '        ''quote_number'', fp_quote_no, ''quote_freight'', fp_freight, ''quote_fuel'', fp_fuel,' || chr(10) ||
          '        ''quote_accessorials'', fp_acc, ''quote_total'', fp_quote_total, ''vendor'', fp_vendor,' || chr(10) ||
          '        ''read_from_freightpop_at'', fp_read_at)) end'),
      (4, 'service, signed_by, account_manager, history) as doc',
          'service, signed_by, account_manager, fp_quote_no, fp_vendor, fp_account, history) as doc'),
      (5, '''Tracking history: '' || history) as sem',
          '''Shipment sale $'' || fp_sale, ''Shipment cost $'' || fp_cost, ''Gross profit $'' || fp_gp,' || chr(10) ||
          '      ''Margin '' || case when fp_sale > 0 and fp_gp is not null then round(fp_gp / fp_sale * 100, 1) end || ''%'',' || chr(10) ||
          '      ''Quote '' || fp_quote_no || '': freight $'' || fp_freight || '', fuel surcharge $'' || fp_fuel || '', accessorials $'' || fp_acc || '', total $'' || fp_quote_total,' || chr(10) ||
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
