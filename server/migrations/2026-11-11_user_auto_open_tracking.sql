-- Hosted FreightPOP lookups also open the tracking popup (false = only filter the grid; the user clicks).
alter table public.fpx_user_profiles add column if not exists auto_open_tracking boolean not null default true;
