-- Parcel tracking turned off + retroactive cleanup of the auto-tasks that
-- were spawned for parcel shipments before the ui.tracking.show_parcels
-- switch existed.
--
-- Context: the parcel switch (ui.tracking.show_parcels, default OFF) hides
-- parcel-mode rows from the Tracking page and suppresses auto-task creation
-- for them going forward. But tasks auto-created for parcels *before* the
-- gate landed still sat on the Tasks page (which lists archived tasks too,
-- via include_archived=1) — so a soft-archive wouldn't hide them. They have
-- to be deleted to actually clear the noise.
--
-- Scope of the delete:
--   - parcel-mode shipments only (lower(trim(mode)) = 'parcel')
--   - auto-created only (created_by = 'system (auto-flag)') — human-made
--     tasks on parcel shipments are deliberate and left untouched
--   - active statuses only (open, in_progress) — done/cancelled are history
--     and preserved, matching 2026-04-29_backfill_followup_prefixes
--
-- Idempotent: re-running deletes nothing once the rows are gone. No audit
-- row is emitted (audit fires from the app layer, not this migration).
-- Applied live against project FPX (vvplkjgymahavqrejmgm) on 2026-06-02;
-- removed 3 open FedEx parcel followup tasks.

DELETE FROM fpx_shipment_tasks t
USING fpx_shipments s
WHERE t.shipment_id = s.id
  AND lower(trim(s.mode)) = 'parcel'
  AND t.created_by = 'system (auto-flag)'
  AND t.status IN ('open', 'in_progress');

-- Pin the switch OFF explicitly (it already defaults OFF via the settings
-- fallback, but recording it makes the choice durable + visible in the
-- admin Settings page even if the default ever changes).
INSERT INTO fpx_settings (key, value, description, updated_by, updated_at)
VALUES ('ui.tracking.show_parcels', 'false'::jsonb,
        'Master parcel switch: hide parcels from Tracking + skip auto-tasks.',
        'system (parcel-tracking-removal)', now())
ON CONFLICT (key) DO UPDATE
  SET value = excluded.value,
      description = excluded.description,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;
