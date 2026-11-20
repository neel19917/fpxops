-- Applied to production 2026-11-20.
-- The invoice pipeline: every ERP pull (an fpx_invoice_audits row with
-- shipment_type 'erp_pending') is a numbered run that FPX carries forward on
-- its own: pull → approval check → report email → Get Invoice batches for the
-- not-exported shipments that have no saved documents yet → done.
-- server/lib/invoicePipeline.js moves each run along; this table is its state.
-- Additive only: nothing existing is changed or removed.

create sequence if not exists public.fpx_invoice_run_number_seq;

create table if not exists public.fpx_invoice_pipeline (
  audit_id uuid primary key references public.fpx_invoice_audits(id),
  run_number int not null default nextval('public.fpx_invoice_run_number_seq'),
  erp_request_id uuid,                  -- the erp_audit fpx_scrape_requests row that made the audit
  months int,
  shipment_type text,
  stage text not null default 'pulled'
    check (stage in ('pulled', 'approvals', 'documents', 'done', 'failed')),
  approval_request_id uuid,             -- the approval_check request of this run
  approval_status text check (approval_status is null or approval_status in ('queued', 'running', 'done', 'error')),
  doc_request_ids uuid[] not null default '{}', -- the get_invoice requests of this run, in order
  docs_total int not null default 0,    -- shipments needing documents when the documents stage began
  docs_done int not null default 0,
  docs_failed int not null default 0,
  report_emailed_at timestamptz,
  report_email_error text,
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter sequence public.fpx_invoice_run_number_seq owned by public.fpx_invoice_pipeline.run_number;

create unique index if not exists fpx_invoice_pipeline_run_number_key on public.fpx_invoice_pipeline (run_number);
create index if not exists fpx_invoice_pipeline_stage_idx on public.fpx_invoice_pipeline (stage, created_at);

-- Pulls made before the pipeline existed: numbered 1, 2, 3… in the order they
-- were made, and already finished (FPX does not go back and run them).
with ordered as (
  select a.id, a.created_at, row_number() over (order by a.created_at, a.id) as n
  from public.fpx_invoice_audits a
  where a.shipment_type = 'erp_pending'
    and not exists (select 1 from public.fpx_invoice_pipeline p where p.audit_id = a.id)
)
insert into public.fpx_invoice_pipeline (audit_id, run_number, stage, created_at, updated_at)
select o.id, o.n + coalesce((select max(run_number) from public.fpx_invoice_pipeline), 0), 'done', o.created_at, now()
from ordered o;

select setval('public.fpx_invoice_run_number_seq',
  greatest(coalesce((select max(run_number) from public.fpx_invoice_pipeline), 0), 1),
  (select count(*) > 0 from public.fpx_invoice_pipeline));

alter table public.fpx_invoice_pipeline enable row level security;
revoke all on public.fpx_invoice_pipeline from anon, authenticated;
revoke all on sequence public.fpx_invoice_run_number_seq from anon, authenticated;
