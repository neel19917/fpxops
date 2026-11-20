-- Applied to production 2026-11-20.
-- Support Mailbox v3: log linked email threads on their FPX shipments.
-- Written by server/lib/mailbox/shipmentLog.js (logLinksToShipments, run at the
-- end of every linker tick and right after a person links a shipment).
--
-- Each link that is logged gets ONE fpx_shipment_notes row
-- (created_by = 'Support Mailbox', "Support email linked: ...") and these two
-- columns record it. logged_at is set first with
-- "update ... where logged_at is null" so two processes never log a link twice.
-- Links older than 30 days are never backfilled (they stay logged_at null).
--
-- Additive only. Nothing is deleted; dismissing a link keeps its note.
--
-- Example queries:
--   select count(*) filter (where logged_at is not null) as logged, count(*) from public.fpx_mailbox_links;
--   select l.conversation_id, l.shipment_id, n.body from public.fpx_mailbox_links l
--   join public.fpx_shipment_notes n on n.id = l.note_id order by l.logged_at desc limit 20;

alter table public.fpx_mailbox_links
  add column if not exists note_id uuid,
  add column if not exists logged_at timestamptz;

-- The logger looks for recent, unlogged, live links.
create index if not exists fpx_mailbox_links_unlogged_idx
  on public.fpx_mailbox_links (created_at desc)
  where logged_at is null and not dismissed;
