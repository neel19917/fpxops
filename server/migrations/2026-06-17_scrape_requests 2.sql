-- Rescrape command channel.
--
-- Scraping is push-only: the Chrome extension scrapes FreightPOP and POSTs to
-- /api/shipments. The server has no way to "pull" a fresh scrape on demand.
-- This table is the signal the dashboard writes and the extension polls: the
-- operator clicks "Rescrape", we enqueue a request here, and the extension
-- picks it up on its next cycle, re-pulls FreightPOP, and marks it done.
--
-- status: pending -> claimed (extension picked it up) -> done | error.
-- scope='all' is a full rescrape; scope='selected' carries tracking_numbers.

create table if not exists fpx_scrape_requests (
  id               uuid primary key default gen_random_uuid(),
  status           text not null default 'pending',
  scope            text not null default 'all',
  tracking_numbers text[],
  requested_by     text,
  requested_at     timestamptz not null default now(),
  claimed_at       timestamptz,
  claimed_by       text,
  completed_at     timestamptz,
  result_count     int,
  note             text
);

-- The extension polls for the oldest pending request; index that hot path.
create index if not exists idx_scrape_requests_pending
  on fpx_scrape_requests (requested_at)
  where status = 'pending';
