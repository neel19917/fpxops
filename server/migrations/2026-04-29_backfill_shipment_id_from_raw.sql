-- Backfill fpx_shipments.shipment_id from raw_data for rows that were
-- scraped before the mapShipment fix in server/lib/shipments.js. The
-- mapper used to look for "Shipment ID" (capital ID), but FreightPOP
-- actually emits "Shipment Id" (capital S, lowercase d), so the value
-- was being captured into raw_data but dropped during the transform.
--
-- This migration is one-shot and idempotent: it only updates rows where
-- shipment_id is currently NULL. Future scrapes will populate the
-- column directly via the fixed mapper, so this script never needs to
-- run again — but re-running it is safe.
--
-- We try the canonical key first, then the legacy variants for safety
-- (some early scrapes used different casing). The fpx_shipments_latest
-- materialized view is refreshed at the end so the dashboard read path
-- picks up the change without waiting for the next scheduled refresh.

UPDATE fpx_shipments
SET shipment_id = COALESCE(
  NULLIF(raw_data->>'Shipment Id', ''),
  NULLIF(raw_data->>'Shipment ID', ''),
  NULLIF(raw_data->>'SHIPMENT ID', ''),
  NULLIF(raw_data->>'shipment_id', '')
)
WHERE shipment_id IS NULL
  AND raw_data IS NOT NULL
  AND (
    raw_data->>'Shipment Id' IS NOT NULL
    OR raw_data->>'Shipment ID' IS NOT NULL
    OR raw_data->>'SHIPMENT ID' IS NOT NULL
    OR raw_data->>'shipment_id' IS NOT NULL
  );

-- Refresh the latest-by-tracking view so the dashboard /api/shipments
-- read path reflects the backfill immediately. If the view doesn't
-- exist (older environment), the DO block silently skips it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_matviews WHERE matviewname = 'fpx_shipments_latest'
  ) THEN
    REFRESH MATERIALIZED VIEW fpx_shipments_latest;
  END IF;
END $$;
