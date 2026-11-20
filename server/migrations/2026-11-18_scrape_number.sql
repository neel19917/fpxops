-- Applied 2026-11-18.
-- A plain, ever-increasing number for every scrape job (Get Invoice runs
-- included), so a run can be named "Scrape #57" in files people sort and
-- paste into their own spreadsheets. Existing jobs are numbered in the order
-- they were requested; new ones take the next number. Additive only.

alter table public.fpx_scrape_requests add column if not exists scrape_number bigint;

create sequence if not exists public.fpx_scrape_number_seq owned by public.fpx_scrape_requests.scrape_number;

with ordered as (
  select id, row_number() over (order by requested_at, id) as n
  from public.fpx_scrape_requests
  where scrape_number is null
)
update public.fpx_scrape_requests r
   set scrape_number = o.n + coalesce((select max(scrape_number) from public.fpx_scrape_requests), 0)
  from ordered o
 where r.id = o.id;

select setval('public.fpx_scrape_number_seq', greatest(coalesce((select max(scrape_number) from public.fpx_scrape_requests), 0), 1));

alter table public.fpx_scrape_requests alter column scrape_number set default nextval('public.fpx_scrape_number_seq');
create unique index if not exists fpx_scrape_requests_scrape_number_key on public.fpx_scrape_requests (scrape_number);
