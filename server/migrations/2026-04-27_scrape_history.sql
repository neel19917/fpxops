-- Persist every scrape (not just the latest). fpx_shipments still holds the
-- "current" snapshot — this table is the audit trail and the data feeding
-- diff-driven re-analysis decisions.
create table if not exists fpx_shipment_scrapes (
  id                     uuid primary key default gen_random_uuid(),
  shipment_id            uuid references fpx_shipments(id) on delete set null,
  tracking_number        text not null,
  scraped_at             timestamptz not null default now(),
  scraped_by             text,                 -- x-fpx-user-name header on the upload
  raw_data               jsonb not null,       -- full scraped payload
  diff                   jsonb,                -- { field: { prev, next } } vs the previous scrape, or null on first sighting
  material_change        boolean not null default false,
  triggered_reanalysis   boolean not null default false
);

create index if not exists fpx_shipment_scrapes_tracking_idx
  on fpx_shipment_scrapes (tracking_number, scraped_at desc);
create index if not exists fpx_shipment_scrapes_shipment_idx
  on fpx_shipment_scrapes (shipment_id) where shipment_id is not null;
create index if not exists fpx_shipment_scrapes_material_idx
  on fpx_shipment_scrapes (tracking_number, scraped_at desc) where material_change;

-- A manual action override is fine at the moment it was set, but loses its
-- justification once new material data shows up. The UI surfaces this so the
-- operator can decide whether to keep or clear it. Cleared back to false when
-- the override is re-confirmed or a fresh scrape introduces no new material
-- data (handled by the server, not the DB).
alter table fpx_shipments
  add column if not exists action_override_stale boolean not null default false;
