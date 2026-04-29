-- Surface "this shipment just moved" on the Tracking table without
-- making the dashboard do a per-row join against fpx_shipment_scrapes.
-- The bulk upsert flow already computes a material diff per row;
-- it stamps this column at the same time when the diff is non-null.
-- Indexed DESC NULLS LAST so "what changed in the last 24h" stays
-- cheap once the table grows past ~10k rows.

ALTER TABLE fpx_shipments
  ADD COLUMN IF NOT EXISTS last_material_change_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS fpx_shipments_last_material_change_at_idx
  ON fpx_shipments (last_material_change_at DESC NULLS LAST)
  WHERE last_material_change_at IS NOT NULL;

-- The fpx_shipments_latest view enumerates columns explicitly rather
-- than SELECT *, so the new column won't appear there until we
-- recreate it. Same column order as before, just with
-- last_material_change_at appended at the end.
CREATE OR REPLACE VIEW fpx_shipments_latest AS
SELECT DISTINCT ON (tracking_number)
  id, tracking_number, shipment_id, customer_name, customer_id,
  account_manager, carrier, carrier_name, mode, shipment_status,
  comments, pickup_response, pickup_request_number, confirmation_number,
  pickup_date, updated_eta, estimated_departure, actual_departure,
  estimated_arrival, actual_arrival, delivery_date, signed_by,
  booking_date, inbound_customs_date, port_departure_date,
  outbound_customs_date, on_board_date, longitude, latitude, origin,
  destination, ship_from, ship_to, service, shipment_marked_up_rate,
  shipment_rate_without_markup, shipment_gross_profit, total_weight,
  total_packages, action_required, ai_issue, ai_recommendation,
  raw_data, scraped_at, created_at, updated_at, seen_count, created_by,
  action_source, action_overridden_by, action_overridden_at,
  action_override_reason, company_name, shipment_date, tracking_comments,
  shipper_spot_quote, pickup_tendered, last_modified_at, updated_via,
  original_eta, order_number, reference_one, reference_two,
  reference_three, reference_four, reference_five, reference_six,
  ready_time, cut_off_time, appointment_set, appointment_date,
  required_arrival_date, spot_quote_fulfilled_by, last_analyzed_at,
  action_target, action_confidence, action_override_stale, notes,
  last_material_change_at
FROM fpx_shipments
WHERE tracking_number IS NOT NULL AND tracking_number <> ''
ORDER BY tracking_number, scraped_at DESC, created_at DESC;
