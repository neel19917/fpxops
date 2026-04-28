-- Add free-form operator notes to a shipment. Surfaced in the dashboard
-- drawer's Notes section; not analyzed by AI.

alter table fpx_shipments
  add column if not exists notes text;
