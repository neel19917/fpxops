-- Refresh fpx_shipments_latest to expose every column on fpx_shipments.
--
-- Why: subsequent migrations (FreightPOP grid columns, action_source +
-- override fields, action_target/confidence/override_stale, notes, etc.)
-- added columns to fpx_shipments without recreating the view, so the
-- dashboard's narrowed select started 500ing on `order_number does not exist`.
--
-- Pattern: list every column explicitly, distinct-on tracking_number,
-- security_invoker=true so RLS on the base table still applies.

drop view if exists public.fpx_shipments_latest;

create view public.fpx_shipments_latest with (security_invoker = true) as
select distinct on (tracking_number)
  id,
  tracking_number,
  shipment_id,
  customer_name,
  customer_id,
  account_manager,
  carrier,
  carrier_name,
  mode,
  shipment_status,
  comments,
  pickup_response,
  pickup_request_number,
  confirmation_number,
  pickup_date,
  updated_eta,
  estimated_departure,
  actual_departure,
  estimated_arrival,
  actual_arrival,
  delivery_date,
  signed_by,
  booking_date,
  inbound_customs_date,
  port_departure_date,
  outbound_customs_date,
  on_board_date,
  longitude,
  latitude,
  origin,
  destination,
  ship_from,
  ship_to,
  service,
  shipment_marked_up_rate,
  shipment_rate_without_markup,
  shipment_gross_profit,
  total_weight,
  total_packages,
  action_required,
  ai_issue,
  ai_recommendation,
  raw_data,
  scraped_at,
  created_at,
  updated_at,
  seen_count,
  created_by,
  action_source,
  action_overridden_by,
  action_overridden_at,
  action_override_reason,
  company_name,
  shipment_date,
  tracking_comments,
  shipper_spot_quote,
  pickup_tendered,
  last_modified_at,
  updated_via,
  original_eta,
  order_number,
  reference_one,
  reference_two,
  reference_three,
  reference_four,
  reference_five,
  reference_six,
  ready_time,
  cut_off_time,
  appointment_set,
  appointment_date,
  required_arrival_date,
  spot_quote_fulfilled_by,
  last_analyzed_at,
  action_target,
  action_confidence,
  action_override_stale,
  notes
from public.fpx_shipments
where tracking_number is not null and tracking_number <> ''
order by tracking_number, scraped_at desc, created_at desc;

-- Keep grants in line with the prior hardening: deny anon/authenticated/public,
-- only allow service_role to read directly. RLS on the base table governs the
-- dashboard's per-user reads via security_invoker.
revoke all on public.fpx_shipments_latest from anon, authenticated, public;
grant select on public.fpx_shipments_latest to service_role;
