-- Append-only operator notes log. Replaces the single overwriteable
-- fpx_shipments.notes textarea with a running, timestamped, attributed log:
-- each save is its own immutable row, so the drawer shows the full history
-- of what the rep did and when (mirroring how operators were already hand-
-- typing "Followed up on 06/02" into the blob).
--
-- The old fpx_shipments.notes column is KEPT and denormalized to the most
-- recent entry on every insert (done in the app layer), so the Tracking
-- "With notes" filter, the notes count, and the /notes cross-shipment view
-- keep working unchanged. The drawer reads the full log from this table.
--
-- Each insert also writes an fpx_audit_log row (action='shipment_note') from
-- the app layer, which is what the Audit log page's new "Notes" tab filters
-- on — so the audit trail and the per-shipment log stay in lockstep.

CREATE TABLE IF NOT EXISTS public.fpx_shipment_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id     UUID NOT NULL REFERENCES public.fpx_shipments(id) ON DELETE CASCADE,
  tracking_number TEXT,
  body            TEXT NOT NULL,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drawer reads newest-first for a single shipment — composite index covers it.
CREATE INDEX IF NOT EXISTS fpx_shipment_notes_shipment_idx
  ON public.fpx_shipment_notes (shipment_id, created_at DESC);

-- RLS on, no policies: the dashboard reads/writes exclusively through the
-- service-role API (which bypasses RLS), so this denies any direct anon/auth
-- client access — same posture as the other fpx_* operational tables.
ALTER TABLE public.fpx_shipment_notes ENABLE ROW LEVEL SECURITY;

-- Backfill: turn each existing single-blob note into one log entry so no
-- history is lost. Attributed to '(migrated)' and stamped with the
-- shipment's last update. Idempotent via the NOT EXISTS guard.
INSERT INTO public.fpx_shipment_notes (shipment_id, tracking_number, body, created_by, created_at)
SELECT s.id, s.tracking_number, s.notes, '(migrated)', COALESCE(s.updated_at, s.created_at, now())
FROM public.fpx_shipments s
WHERE s.notes IS NOT NULL
  AND btrim(s.notes) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.fpx_shipment_notes n WHERE n.shipment_id = s.id
  );
