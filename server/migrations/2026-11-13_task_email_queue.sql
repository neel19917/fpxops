-- Email queue: a rep marks a task "to email" while working the board (hotkey E
-- in the task drawer, or "Queue for email" on a selection). Email Studio then
-- lists the queued tasks grouped by carrier / customer so they can be sent as
-- one email per recipient. Cleared when the rep confirms the email was sent.
alter table public.fpx_shipment_tasks
  add column if not exists email_queued_at timestamptz,
  add column if not exists email_queued_by text;

create index if not exists fpx_shipment_tasks_email_queued_idx
  on public.fpx_shipment_tasks (email_queued_at)
  where email_queued_at is not null;
