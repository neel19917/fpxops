-- Applied 2026-11-17.
-- NOT APPLIED YET. Apply before (or with) the server change that adds
-- lib/invoiceBatch.js; until then batch mode logs "Batch not stored" and the
-- files go back to wait (direct mode is unaffected).
--
-- Reading saved invoice files through Anthropic's Message Batches API
-- (invoice_ocr.mode = "batch"): half the price of the direct call, results
-- within 24 hours. One row per batch sent; each file sent carries the batch
-- in fpx_invoice_documents.ocr_batch_id until its result is saved.
--
-- Example queries:
--   select status, request_count, succeeded, errored, cost_usd, submitted_at, ended_at, results_applied_at
--   from public.fpx_invoice_ocr_batches order by created_at desc limit 20;
--
--   -- files waiting inside an open batch
--   select b.anthropic_batch_id, d.shipment_id, d.file
--   from public.fpx_invoice_documents d join public.fpx_invoice_ocr_batches b on b.id = d.ocr_batch_id;
--
--   select public.fpx_invoice_ocr_batches_summary();

create table if not exists public.fpx_invoice_ocr_batches (
  id uuid primary key default gen_random_uuid(),
  anthropic_batch_id text unique,          -- msgbatch_...; null while being sent
  status text not null default 'sending'
    check (status in ('sending', 'in_progress', 'canceling', 'ended', 'failed')),
  request_count integer not null default 0,
  succeeded integer not null default 0,
  errored integer not null default 0,
  expired integer not null default 0,
  canceled integer not null default 0,
  model text,
  -- [{ document_id, sha256, bytes, mime }]: what was sent, so a result is
  -- saved against the bytes Claude actually read.
  requests jsonb not null default '[]'::jsonb,
  bytes_sent bigint,
  submitted_at timestamptz,
  expires_at timestamptz,                   -- Claude's 24-hour limit
  checked_at timestamptz,                   -- last status check
  ended_at timestamptz,
  results_applied_at timestamptz,           -- every result saved: the batch is finished
  cost_usd numeric,                         -- at the batch price (half)
  error text,
  created_at timestamptz not null default now()
);
create index if not exists fpx_invoice_ocr_batches_open_idx
  on public.fpx_invoice_ocr_batches (created_at) where results_applied_at is null and status <> 'failed';
create index if not exists fpx_invoice_ocr_batches_created_idx on public.fpx_invoice_ocr_batches (created_at desc);
alter table public.fpx_invoice_ocr_batches enable row level security;
revoke all on public.fpx_invoice_ocr_batches from anon, authenticated;

alter table public.fpx_invoice_documents add column if not exists ocr_batch_id uuid;
create index if not exists fpx_invoice_documents_ocr_batch_idx
  on public.fpx_invoice_documents (ocr_batch_id) where ocr_batch_id is not null;

-- ---------------------------------------------------------------------------
-- The claim function, replaced. Same arguments and result as before; two changes:
--   * a row inside an open batch (ocr_batch_id set) stays 'processing' for
--     up to 25 hours while Claude reads it: the 15-minute reclaim and the
--     "out of tries" sweep leave it alone
--   * a claimed row starts with ocr_batch_id null (the batch sets it)
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
   where x.status = 'processing' and x.ocr_batch_id is null
     and x.claimed_at < now() - interval '15 minutes' and x.attempts >= p_max_attempts;

  return query
  update public.fpx_invoice_documents d
     set status = 'processing', attempts = d.attempts + 1, claimed_at = now(), updated_at = now(), ocr_batch_id = null
   where d.id in (
     select c.id from public.fpx_invoice_documents c
      where ( c.status = 'pending'
           or (c.status = 'failed' and c.attempts < p_max_attempts and c.updated_at < now() - (c.attempts * interval '2 minutes'))
           or (c.status = 'processing' and c.ocr_batch_id is null
               and c.claimed_at < now() - interval '15 minutes' and c.attempts < p_max_attempts) )
        and (p_shipment_id is null or c.shipment_id = p_shipment_id)
        and (p_audit_id is null or c.audit_id = p_audit_id)
      order by (c.doc_type = 'invoice') desc, c.created_at
      limit least(greatest(coalesce(p_limit, 1), 1), 50)
      for update skip locked)
  returning d.id, d.shipment_id, d.audit_id, d.file, d.doc_type, d.content_sha256, d.extracted_at, d.attempts;
end;
$function$;

revoke execute on function public.fpx_invoice_documents_claim(int, text, uuid, int) from public, anon, authenticated;
grant execute on function public.fpx_invoice_documents_claim(int, text, uuid, int) to service_role;

-- Counts for the dashboard, in one call.
create or replace function public.fpx_invoice_ocr_batches_summary()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'total', (select count(*) from public.fpx_invoice_ocr_batches),
    'open', (select count(*) from public.fpx_invoice_ocr_batches where results_applied_at is null and status <> 'failed'),
    'failed', (select count(*) from public.fpx_invoice_ocr_batches where status = 'failed'),
    'docs_in_open_batches', (select count(*) from public.fpx_invoice_documents where ocr_batch_id is not null),
    'docs_sent', (select coalesce(sum(request_count), 0) from public.fpx_invoice_ocr_batches where status <> 'failed'),
    'cost_usd', (select coalesce(sum(cost_usd), 0) from public.fpx_invoice_ocr_batches),
    'last_submitted_at', (select max(submitted_at) from public.fpx_invoice_ocr_batches),
    'last_finished_at', (select max(results_applied_at) from public.fpx_invoice_ocr_batches)
  );
$function$;
revoke execute on function public.fpx_invoice_ocr_batches_summary() from public, anon, authenticated;
grant execute on function public.fpx_invoice_ocr_batches_summary() to service_role;
