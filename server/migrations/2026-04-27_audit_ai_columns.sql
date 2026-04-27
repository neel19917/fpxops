-- Migrate GP/Invoice audit AI from extension to server. Adds:
--   - last_analyzed_at on each audit run (so re-analyze + auto-skip can use it)
--   - ai_notes on each row (per-row review the extension used to write into the XLSX)
-- exec_summary already exists on both audit tables.

alter table fpx_gp_audits
  add column if not exists last_analyzed_at timestamptz;
alter table fpx_invoice_audits
  add column if not exists last_analyzed_at timestamptz;

alter table fpx_gp_audit_rows
  add column if not exists ai_notes text;
alter table fpx_invoice_audit_rows
  add column if not exists ai_notes text;
