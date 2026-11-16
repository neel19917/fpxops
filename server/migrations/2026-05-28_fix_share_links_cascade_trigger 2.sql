-- The cascade trigger added in 2026-04-29_cascade_delete_shipment_children.sql
-- compared fpx_share_links.resource_id (uuid) against OLD.id::text, which
-- Postgres rejects with "operator does not exist: uuid = text". Every
-- attempt to delete a shipment 500s. Drop the cast so both sides are uuid.

CREATE OR REPLACE FUNCTION fpx_cascade_share_links_on_shipment_delete()
RETURNS trigger AS $$
BEGIN
  DELETE FROM fpx_share_links
  WHERE resource_type = 'shipment' AND resource_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
