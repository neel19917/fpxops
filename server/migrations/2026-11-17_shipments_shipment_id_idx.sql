-- Applied 2026-11-17.
-- Ask FPX looks a shipment up by its FreightPOP shipment id.
create index if not exists fpx_shipments_shipment_id_idx on public.fpx_shipments (shipment_id, scraped_at desc);
