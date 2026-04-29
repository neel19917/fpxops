-- Backfill last_material_change_at on fpx_shipments from the most
-- recent fpx_shipment_scrapes row that has a non-null diff for each
-- shipment. Idempotent: only fills NULLs.
--
-- Note: at the time this was written, fpx_shipment_scrapes was empty
-- on the live DB (the table existed but no rows had been logged with
-- diffs yet, plus the cascade-delete migration earlier today emptied
-- whatever was there). So this update was a no-op on first run.
-- Kept in the repo for the next time someone re-imports scrape
-- history or wants to re-backfill after a data restore.

UPDATE fpx_shipments s
SET last_material_change_at = sub.last_change
FROM (
  SELECT
    shipment_id,
    MAX(scraped_at) AS last_change
  FROM fpx_shipment_scrapes
  WHERE diff IS NOT NULL
  GROUP BY shipment_id
) sub
WHERE s.id = sub.shipment_id
  AND s.last_material_change_at IS NULL;
