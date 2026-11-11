-- Scrape email subscription (applied 2026-11-11 as scrape_email_subscription).
alter table public.fpx_user_profiles add column if not exists scrape_email text not null default 'off' check (scrape_email in ('off','all','failed'));
