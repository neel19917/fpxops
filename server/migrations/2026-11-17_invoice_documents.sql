-- Applied 2026-11-17.
--
-- The hosted browser's Get Invoice job saves files in Storage (bucket
-- erp-pulls, <audit_id>/invoices/<name>) and lists them in
-- fpx_shipment_records.files. The server reads each file once with Claude
-- (lib/invoiceExtract.js, lib/invoiceDocs.js) and keeps here:
--   * named, typed columns for what people filter and add up
--   * `fields`: every other labelled value on the page, label -> value
--   * `line_items`, `raw_text` (the whole page as text), `summary`
--   * chunks of the text with embeddings, for search by meaning
-- One row per file of an audit. A file is read again only when its bytes
-- change (content_sha256).
--
-- Example queries (run as the service role / in the SQL editor):
--
-- 1. Invoices over $1,000 from one carrier this month
--    select shipment_id, invoice_number, invoice_date, carrier, total
--    from public.fpx_invoice_documents
--    where doc_type = 'invoice' and status = 'done' and carrier ilike '%xpo%'
--      and total > 1000 and invoice_date >= date_trunc('month', current_date)
--    order by total desc;
--
-- 2. Invoices whose read total differs from what FreightPOP approved
--    select shipment_id, invoice_number, carrier, total, fp_approved_invoice_amount, total_vs_approved
--    from public.fpx_invoice_documents_v
--    where doc_type = 'invoice' and status = 'done'
--      and fp_approved_invoice_amount is not null and abs(total_vs_approved) > 0.01
--    order by abs(total_vs_approved) desc;
--
-- 3. Everything saved for one shipment, the invoice first
--    select doc_type, file, status, invoice_number, total, summary
--    from public.fpx_invoice_documents where shipment_id = '15612931'
--    order by (doc_type = 'invoice') desc, file;
--
-- 4. Find a document by a number printed anywhere on it (PRO, BOL, PO, ...)
--    select shipment_id, doc_type, file, invoice_number, tracking_number, bol_number, po_number
--    from public.fpx_invoice_documents
--    where '4471002938' in (invoice_number, tracking_number, bol_number, po_number, so_number, quote_number)
--       or fts @@ websearch_to_tsquery('english', '4471002938');
--
-- 5. Any labelled value, even one with no column of its own
--    select shipment_id, file, fields->>'Payment Terms' as payment_terms, fields->>'Pickup Date' as pickup_date
--    from public.fpx_invoice_documents where fields ? 'Payment Terms';
--
-- 6. Fuel surcharge by carrier and month, with the customer FreightPOP has
--    select date_trunc('month', invoice_date)::date as month, carrier, fp_customer_name,
--           count(*) as invoices, sum(fuel_surcharge) as fuel, sum(total) as total
--    from public.fpx_invoice_documents_v
--    where doc_type = 'invoice' and status = 'done' and invoice_date is not null
--    group by 1, 2, 3 order by 1 desc, total desc;
--
-- 7. Ranked search (words, numbers, and meaning when an embedding is passed)
--    select s.score, d.shipment_id, d.doc_type, d.invoice_number, d.carrier, d.total, d.summary
--    from public.fpx_invoice_documents_search('liftgate fee disputed') s
--    join public.fpx_invoice_documents d using (id)
--    order by s.score desc;
--
-- 8. What is waiting or failed
--    select status, count(*), max(updated_at) from public.fpx_invoice_documents group by 1;
--    select file, attempts, error from public.fpx_invoice_documents where status = 'failed';

create table if not exists public.fpx_invoice_documents (
  id uuid primary key default gen_random_uuid(),
  shipment_id text not null,
  audit_id uuid not null,
  file text not null,                    -- path inside the audit's folder: invoices/<name>
  doc_type text not null default 'other', -- invoice | bol | rate_confirmation | quote | shipment_details | accessorials | documents | other
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed', 'skipped')),
  error text,                            -- why it failed, or why it was skipped
  attempts integer not null default 0,
  claimed_at timestamptz,                -- when a worker last took it
  content_sha256 text,                   -- of the file's bytes when it was last read
  bytes integer,
  mime text,

  -- What the document says (null when it does not say).
  invoice_number text,
  invoice_date date,
  due_date date,
  carrier text,
  carrier_scac text,
  bill_to text,
  remit_to text,
  ship_from text,
  ship_to text,
  tracking_number text,                  -- PRO
  bol_number text,
  po_number text,
  so_number text,
  quote_number text,
  terms text,
  currency text,
  subtotal numeric,
  fuel_surcharge numeric,
  accessorial_total numeric,
  discount numeric,
  tax numeric,
  total numeric,
  weight numeric,
  pieces integer,
  freight_class text,
  line_items jsonb not null default '[]'::jsonb, -- [{ description, quantity, rate, amount }]
  fields jsonb not null default '{}'::jsonb,     -- every other labelled value: label -> value
  raw_text text,                         -- the whole document as text
  summary text,                          -- 2-3 plain sentences
  confidence numeric,                    -- 0-1, the model's own
  warnings jsonb not null default '[]'::jsonb,   -- [text]

  fts tsvector generated always as (
    to_tsvector('english',
      coalesce(shipment_id, '') || ' ' || coalesce(invoice_number, '') || ' ' || coalesce(carrier, '') || ' ' ||
      coalesce(carrier_scac, '') || ' ' || coalesce(bill_to, '') || ' ' || coalesce(remit_to, '') || ' ' ||
      coalesce(ship_from, '') || ' ' || coalesce(ship_to, '') || ' ' || coalesce(tracking_number, '') || ' ' ||
      coalesce(bol_number, '') || ' ' || coalesce(po_number, '') || ' ' || coalesce(so_number, '') || ' ' ||
      coalesce(quote_number, '') || ' ' || coalesce(terms, '') || ' ' || coalesce(summary, '') || ' ' ||
      left(coalesce(raw_text, ''), 200000))
  ) stored,

  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric,
  extracted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (audit_id, file)
);

create index if not exists fpx_invoice_documents_shipment_idx on public.fpx_invoice_documents (shipment_id);
create index if not exists fpx_invoice_documents_status_idx on public.fpx_invoice_documents (status, created_at);
create index if not exists fpx_invoice_documents_doc_type_idx on public.fpx_invoice_documents (doc_type);
create index if not exists fpx_invoice_documents_invoice_number_idx on public.fpx_invoice_documents (invoice_number);
create index if not exists fpx_invoice_documents_tracking_idx on public.fpx_invoice_documents (tracking_number);
create index if not exists fpx_invoice_documents_bol_idx on public.fpx_invoice_documents (bol_number);
create index if not exists fpx_invoice_documents_po_idx on public.fpx_invoice_documents (po_number);
create index if not exists fpx_invoice_documents_carrier_idx on public.fpx_invoice_documents (carrier);
create index if not exists fpx_invoice_documents_invoice_date_idx on public.fpx_invoice_documents (invoice_date);
create index if not exists fpx_invoice_documents_total_idx on public.fpx_invoice_documents (total);
create index if not exists fpx_invoice_documents_sha_idx on public.fpx_invoice_documents (content_sha256);
create index if not exists fpx_invoice_documents_created_idx on public.fpx_invoice_documents (created_at desc);
create index if not exists fpx_invoice_documents_fts_idx on public.fpx_invoice_documents using gin (fts);
create index if not exists fpx_invoice_documents_fields_idx on public.fpx_invoice_documents using gin (fields);
-- Part-of-a-number and misspelt-name search (ilike '%...%', similarity).
create index if not exists fpx_invoice_documents_invoice_number_trgm on public.fpx_invoice_documents using gin (invoice_number extensions.gin_trgm_ops);
create index if not exists fpx_invoice_documents_tracking_trgm on public.fpx_invoice_documents using gin (tracking_number extensions.gin_trgm_ops);
create index if not exists fpx_invoice_documents_carrier_trgm on public.fpx_invoice_documents using gin (carrier extensions.gin_trgm_ops);

alter table public.fpx_invoice_documents enable row level security;
revoke all on public.fpx_invoice_documents from anon, authenticated;

-- The document's text in pieces of about 1,000 characters, each embedded
-- (gte-small, 384 numbers) for search by meaning.
create table if not exists public.fpx_invoice_document_chunks (
  document_id uuid not null references public.fpx_invoice_documents(id) on delete cascade,
  chunk_no int not null,
  body text not null,
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  primary key (document_id, chunk_no)
);
create index if not exists fpx_invoice_document_chunks_embedding on public.fpx_invoice_document_chunks
  using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists fpx_invoice_document_chunks_unembedded on public.fpx_invoice_document_chunks (document_id)
  where embedding is null;
alter table public.fpx_invoice_document_chunks enable row level security;
revoke all on public.fpx_invoice_document_chunks from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Each document beside what FreightPOP's Transactions report says about the
-- shipment (fp_ columns), and the two differences people ask about.
-- ---------------------------------------------------------------------------
create or replace view public.fpx_invoice_documents_v with (security_invoker = true) as
select
  d.id, d.shipment_id, d.audit_id, d.file, d.doc_type, d.status, d.error, d.attempts,
  d.content_sha256, d.bytes, d.mime,
  d.invoice_number, d.invoice_date, d.due_date, d.carrier, d.carrier_scac, d.bill_to, d.remit_to,
  d.ship_from, d.ship_to, d.tracking_number, d.bol_number, d.po_number, d.so_number, d.quote_number,
  d.terms, d.currency, d.subtotal, d.fuel_surcharge, d.accessorial_total, d.discount, d.tax, d.total,
  d.weight, d.pieces, d.freight_class, d.line_items, d.fields, d.raw_text, d.summary, d.confidence,
  d.warnings, d.model, d.input_tokens, d.output_tokens, d.cost_usd, d.extracted_at, d.created_at, d.updated_at,
  t.customer_name as fp_customer_name,
  t.carrier as fp_carrier,
  t.tracking_number as fp_tracking_number,
  t.shipped_date as fp_shipped_date,
  t.charge as fp_charge,
  t.cost as fp_cost,
  t.gross_profit as fp_gross_profit,
  t.approved_invoice_amount as fp_approved_invoice_amount,
  t.invoice_approved_date as fp_invoice_approved_date,
  t.billing_invoice_number as fp_billing_invoice_number,
  t.exported_to_erp as fp_exported_to_erp,
  (d.total - t.approved_invoice_amount) as total_vs_approved,
  (d.total - t.cost) as total_vs_cost
from public.fpx_invoice_documents d
left join public.fpx_erp_transactions t on t.shipment_id = d.shipment_id;
revoke all on public.fpx_invoice_documents_v from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ranked search over the documents that have been read. Joins three ways of
-- matching: the id-like columns (exact, or part of a number), full text, a
-- misspelt carrier or bill-to name, and - when p_embedding is passed - the
-- closest chunks by meaning. `doc` is the row without raw_text and fts.
-- ---------------------------------------------------------------------------
create or replace function public.fpx_invoice_documents_search(
  p_query text,
  p_embedding extensions.vector default null,
  p_limit int default 20
)
 returns table(id uuid, score real, doc jsonb)
 language sql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
  with q as (
    select trim(coalesce(p_query, '')) as raw,
           websearch_to_tsquery('english', coalesce(p_query, '')) as tsq
  ),
  near as materialized (
    select c.document_id, (c.embedding <=> p_embedding) as dist
    from public.fpx_invoice_document_chunks c
    where p_embedding is not null and c.embedding is not null
    order by c.embedding <=> p_embedding
    limit 120
  ),
  semantic as materialized (
    select document_id, min(dist) as dist from near group by document_id order by 2 limit 40
  )
  select d.id,
         ( case when q.raw in (d.invoice_number, d.tracking_number, d.bol_number, d.po_number, d.so_number, d.quote_number, d.shipment_id) then 100 else 0 end
         + case when length(q.raw) >= 3 and (
                  d.invoice_number ilike '%' || q.raw || '%' or d.tracking_number ilike '%' || q.raw || '%'
               or d.bol_number ilike '%' || q.raw || '%' or d.po_number ilike '%' || q.raw || '%'
               or d.so_number ilike '%' || q.raw || '%' or d.quote_number ilike '%' || q.raw || '%'
               or d.shipment_id ilike q.raw || '%') then 20 else 0 end
         + ts_rank(d.fts, q.tsq) * 10
         + greatest(similarity(coalesce(d.carrier, ''), q.raw), similarity(coalesce(d.bill_to, ''), q.raw)) * 5
         + case when sem.document_id is null then 0 else greatest(0, 1 - sem.dist) * 6 end
         + case when d.doc_type = 'invoice' then 0.5 else 0 end )::real as score,
         to_jsonb(d) - 'fts' - 'raw_text' as doc
  from public.fpx_invoice_documents d
  cross join q
  left join semantic sem on sem.document_id = d.id
  where q.raw <> '' and d.status = 'done'
    and ( q.raw in (d.invoice_number, d.tracking_number, d.bol_number, d.po_number, d.so_number, d.quote_number, d.shipment_id)
       or (length(q.raw) >= 3 and (
                  d.invoice_number ilike '%' || q.raw || '%' or d.tracking_number ilike '%' || q.raw || '%'
               or d.bol_number ilike '%' || q.raw || '%' or d.po_number ilike '%' || q.raw || '%'
               or d.so_number ilike '%' || q.raw || '%' or d.quote_number ilike '%' || q.raw || '%'
               or d.shipment_id ilike q.raw || '%'))
       or d.fts @@ q.tsq
       or q.raw <% d.carrier or q.raw <% d.bill_to
       or sem.document_id is not null )
  order by score desc, d.extracted_at desc nulls last
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$function$;

-- ---------------------------------------------------------------------------
-- Worker: take the next files to read. Rows waiting, rows that failed fewer
-- than p_max_attempts times (after a pause that grows with each try), and
-- rows a worker took more than 15 minutes ago and never finished. Two
-- workers never get the same row.
-- ---------------------------------------------------------------------------
create or replace function public.fpx_invoice_documents_claim(
  p_limit int default 1,
  p_shipment_id text default null,
  p_audit_id uuid default null,
  p_max_attempts int default 3
)
 returns table(id uuid, shipment_id text, audit_id uuid, file text, doc_type text,
               content_sha256 text, extracted_at timestamptz, attempts integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  -- Taken, never finished, and out of tries: say so instead of leaving it "processing".
  update public.fpx_invoice_documents x
     set status = 'failed', error = coalesce(x.error, 'Stopped while being read (the server restarted or timed out)'), updated_at = now()
   where x.status = 'processing' and x.claimed_at < now() - interval '15 minutes' and x.attempts >= p_max_attempts;

  return query
  update public.fpx_invoice_documents d
     set status = 'processing', attempts = d.attempts + 1, claimed_at = now(), updated_at = now()
   where d.id in (
     select c.id from public.fpx_invoice_documents c
      where ( c.status = 'pending'
           or (c.status = 'failed' and c.attempts < p_max_attempts and c.updated_at < now() - (c.attempts * interval '2 minutes'))
           or (c.status = 'processing' and c.claimed_at < now() - interval '15 minutes' and c.attempts < p_max_attempts) )
        and (p_shipment_id is null or c.shipment_id = p_shipment_id)
        and (p_audit_id is null or c.audit_id = p_audit_id)
      order by (c.doc_type = 'invoice') desc, c.created_at
      limit least(greatest(coalesce(p_limit, 1), 1), 50)
      for update skip locked)
  returning d.id, d.shipment_id, d.audit_id, d.file, d.doc_type, d.content_sha256, d.extracted_at, d.attempts;
end;
$function$;

-- Replace a document's chunks in one step: p_chunks is
-- [{ "chunk_no": 0, "body": "...", "embedding": "[0.1, ...]" | null }, ...].
-- Chunks past the new count are removed (they are pieces of the old text of
-- the same file; the file and its row are untouched).
create or replace function public.fpx_invoice_document_set_chunks(p_document_id uuid, p_chunks jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_count int;
begin
  insert into public.fpx_invoice_document_chunks (document_id, chunk_no, body, embedding)
  select p_document_id, (c->>'chunk_no')::int, c->>'body', nullif(c->>'embedding', '')::extensions.vector
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) c
  where coalesce(c->>'body', '') <> ''
  on conflict (document_id, chunk_no) do update set body = excluded.body, embedding = excluded.embedding, created_at = now();
  get diagnostics v_count = row_count;
  delete from public.fpx_invoice_document_chunks x
   where x.document_id = p_document_id
     and x.chunk_no not in (select (c->>'chunk_no')::int from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) c
                            where coalesce(c->>'body', '') <> '');
  return v_count;
end;
$function$;

-- Counts for the dashboard, in one call.
create or replace function public.fpx_invoice_documents_summary()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'total', (select count(*) from public.fpx_invoice_documents),
    'by_status', coalesce((select jsonb_object_agg(s.status, s.n) from (select status, count(*) as n from public.fpx_invoice_documents group by status) s), '{}'::jsonb),
    'by_doc_type', coalesce((select jsonb_object_agg(s.doc_type, s.n) from (select doc_type, count(*) as n from public.fpx_invoice_documents group by doc_type) s), '{}'::jsonb),
    'last_extracted_at', (select max(extracted_at) from public.fpx_invoice_documents),
    'cost_usd', (select coalesce(sum(cost_usd), 0) from public.fpx_invoice_documents)
  );
$function$;

revoke execute on function public.fpx_invoice_documents_search(text, extensions.vector, int) from public, anon, authenticated;
revoke execute on function public.fpx_invoice_documents_claim(int, text, uuid, int) from public, anon, authenticated;
revoke execute on function public.fpx_invoice_document_set_chunks(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.fpx_invoice_documents_summary() from public, anon, authenticated;
grant execute on function public.fpx_invoice_documents_search(text, extensions.vector, int) to service_role;
grant execute on function public.fpx_invoice_documents_claim(int, text, uuid, int) to service_role;
grant execute on function public.fpx_invoice_document_set_chunks(uuid, jsonb) to service_role;
grant execute on function public.fpx_invoice_documents_summary() to service_role;
