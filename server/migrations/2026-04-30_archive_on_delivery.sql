-- A shipment that disappears from the FreightPOP dashboard between scrapes
-- has been delivered (FPX hides delivered shipments from the default
-- Tracking grid). The bulk-upload route used to leave those rows around
-- forever, slowly polluting the dashboard with stale "in transit" entries
-- whose tracking pages 404. Adds soft-archive columns so the new
-- /shipments/sweep-complete endpoint can flip them off without losing
-- history (analyses, scrape diffs, audit log all still resolve).
--
-- Scope:
--   - fpx_shipments.archived_at + archived_reason
--   - fpx_shipment_tasks.archived_at + archived_reason
--   - fpx_shipments_latest filters out archived rows (dashboard list endpoint
--     reads this view, so archived shipments vanish from /tracking by default)

ALTER TABLE public.fpx_shipments
  ADD COLUMN IF NOT EXISTS archived_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_reason  TEXT;

ALTER TABLE public.fpx_shipment_tasks
  ADD COLUMN IF NOT EXISTS archived_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_reason  TEXT;

-- Partial indexes — overwhelming majority of rows are unarchived, so a
-- partial index on the archived subset stays small and the unarchived
-- common-path queries can keep using the existing scraped_at index.
CREATE INDEX IF NOT EXISTS fpx_shipments_archived_at_idx
  ON public.fpx_shipments (archived_at DESC)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS fpx_shipment_tasks_archived_at_idx
  ON public.fpx_shipment_tasks (archived_at DESC)
  WHERE archived_at IS NOT NULL;

-- Same column list as 2026-04-29_add_last_material_change_at_to_shipments
-- with the two new archive columns appended. WHERE clause now also
-- excludes archived rows so the dashboard's list endpoint hides them
-- automatically.
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
  last_material_change_at, archived_at, archived_reason
FROM fpx_shipments
WHERE tracking_number IS NOT NULL AND tracking_number <> ''
  AND archived_at IS NULL
ORDER BY tracking_number, scraped_at DESC, created_at DESC;
