-- When a shipment is hard-deleted, also delete every row that references
-- it. Previously fpx_ai_analyses and fpx_shipment_scrapes were SET NULL
-- (preserving cost / scrape history as orphans). The intent now is
-- "shipment gone = everything tied to it gone" so the database stays
-- clean and tools that join on shipment_id never see orphans.
--
-- Tasks were already CASCADE; the other two are flipped here. Share
-- links use a trigger because they reference shipments via a typed
-- (resource_type, resource_id) pair, not a real FK.
--
-- Idempotent: dropping + recreating the FK is safe to re-run.

-- fpx_ai_analyses.shipment_uuid → CASCADE
ALTER TABLE fpx_ai_analyses
  DROP CONSTRAINT IF EXISTS fpx_ai_analyses_shipment_uuid_fkey;
ALTER TABLE fpx_ai_analyses
  ADD CONSTRAINT fpx_ai_analyses_shipment_uuid_fkey
    FOREIGN KEY (shipment_uuid)
    REFERENCES fpx_shipments(id)
    ON DELETE CASCADE;

-- fpx_shipment_scrapes.shipment_id → CASCADE
ALTER TABLE fpx_shipment_scrapes
  DROP CONSTRAINT IF EXISTS fpx_shipment_scrapes_shipment_id_fkey;
ALTER TABLE fpx_shipment_scrapes
  ADD CONSTRAINT fpx_shipment_scrapes_shipment_id_fkey
    FOREIGN KEY (shipment_id)
    REFERENCES fpx_shipments(id)
    ON DELETE CASCADE;

-- Share links: typed reference, no real FK. Trigger handles the cascade.
CREATE OR REPLACE FUNCTION fpx_cascade_share_links_on_shipment_delete()
RETURNS trigger AS $$
BEGIN
  DELETE FROM fpx_share_links
  WHERE resource_type = 'shipment' AND resource_id = OLD.id::text;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fpx_shipments_cascade_share_links ON fpx_shipments;
CREATE TRIGGER fpx_shipments_cascade_share_links
  BEFORE DELETE ON fpx_shipments
  FOR EACH ROW EXECUTE FUNCTION fpx_cascade_share_links_on_shipment_delete();
