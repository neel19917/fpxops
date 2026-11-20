-- Applied to production 2026-11-20 (the view part here was superseded by 2026-11-20_mailbox_thread_summary.sql).
-- Support Mailbox v2: link each email thread to FPX shipments and classify who
-- the thread is with (customer | carrier | internal | other). Written by the
-- linker in server/lib/mailbox/linking.js; read by server/routes/mailbox.js.
--
-- Additive only. Rows are never deleted: a wrong link is dismissed
-- (dismissed = true) and the linker never re-creates a dismissed link
-- (insert ... on conflict do nothing on the unique key).
--
-- Example queries:
--   select party, count(*) from public.fpx_mailbox_threads group by party;
--   select conversation_id, shipment_id, matched_on, matched_text from public.fpx_mailbox_links
--   where not dismissed order by created_at desc limit 20;
--   select count(*) filter (where linked_at is null) as never_linked, count(*) from public.fpx_mailbox_thread_meta;

-- Sender domain -> party. source: 'rule' (seeded here), 'ai' (learned by the
-- linker), 'person' (set in the dashboard; always wins).
create table if not exists public.fpx_mailbox_domains (
  domain text primary key,
  party text not null check (party in ('customer', 'carrier', 'internal', 'other')),
  source text not null default 'rule' check (source in ('rule', 'ai', 'person')),
  set_by text,
  updated_at timestamptz default now()
);

insert into public.fpx_mailbox_domains (domain, party, source) values
  ('freightpop.com', 'internal', 'rule'),
  ('xpo.com', 'carrier', 'rule'),
  ('rxo.com', 'carrier', 'rule'),
  ('abf.com', 'carrier', 'rule'),
  ('arcb.com', 'carrier', 'rule'),
  ('estes-express.com', 'carrier', 'rule'),
  ('odfl.com', 'carrier', 'rule'),
  ('saia.com', 'carrier', 'rule'),
  ('rlcarriers.com', 'carrier', 'rule'),
  ('fedex.com', 'carrier', 'rule'),
  ('ups.com', 'carrier', 'rule'),
  ('tforcefreight.com', 'carrier', 'rule'),
  ('southeasternfreight.com', 'carrier', 'rule'),
  ('sefl.com', 'carrier', 'rule'),
  ('aaacooper.com', 'carrier', 'rule'),
  ('averitt.com', 'carrier', 'rule'),
  ('averittexpress.com', 'carrier', 'rule'),
  ('daylightransport.com', 'carrier', 'rule'),
  ('pittohio.com', 'carrier', 'rule'),
  ('centraltransport.com', 'carrier', 'rule'),
  ('yrc.com', 'carrier', 'rule'),
  ('yellow.com', 'carrier', 'rule'),
  ('holland.com', 'carrier', 'rule'),
  ('hollandregional.com', 'carrier', 'rule'),
  ('reddaway.com', 'carrier', 'rule'),
  ('dhl.com', 'carrier', 'rule'),
  ('usps.com', 'carrier', 'rule'),
  ('usps.gov', 'carrier', 'rule'),
  ('dayross.com', 'carrier', 'rule'),
  ('dohrn.com', 'carrier', 'rule'),
  ('ward.com', 'carrier', 'rule'),
  ('wardtlc.com', 'carrier', 'rule'),
  ('newpenn.com', 'carrier', 'rule'),
  ('forwardair.com', 'carrier', 'rule'),
  ('pilotdelivers.com', 'carrier', 'rule'),
  ('dependablehighwayexpress.com', 'carrier', 'rule'),
  ('frontlinefreight.com', 'carrier', 'rule'),
  ('roadrunnerfreight.com', 'carrier', 'rule'),
  ('tql.com', 'carrier', 'rule'),
  ('chrobinson.com', 'carrier', 'rule'),
  ('jbhunt.com', 'carrier', 'rule'),
  ('schneider.com', 'carrier', 'rule'),
  ('werner.com', 'carrier', 'rule'),
  ('landstar.com', 'carrier', 'rule'),
  ('purolator.com', 'carrier', 'rule'),
  ('canpar.com', 'carrier', 'rule'),
  ('ontrac.com', 'carrier', 'rule'),
  ('lso.com', 'carrier', 'rule')
on conflict (domain) do nothing;

-- One row per thread the linker has processed (or a person has classified).
--   party_source  'rule' | 'ai' | 'person' — the linker never overwrites 'person'
--   linked_at     last time the linker processed the thread
--   last_message_at  the thread's last_message_at at that time; the thread is
--                 processed again when the view shows a newer one
create table if not exists public.fpx_mailbox_thread_meta (
  connection_id uuid not null references public.fpx_mailbox_connections(id),
  conversation_id text not null,
  party text not null default 'unknown' check (party in ('customer', 'carrier', 'internal', 'other', 'unknown')),
  party_source text check (party_source in ('rule', 'ai', 'person')),
  party_reason text,
  party_set_by text,
  linked_at timestamptz,
  last_message_at timestamptz,
  updated_at timestamptz default now(),
  primary key (connection_id, conversation_id)
);
create index if not exists fpx_mailbox_thread_meta_party_idx on public.fpx_mailbox_thread_meta (connection_id, party);

-- Thread <-> shipment links. source 'auto' (linker) or 'person' (manual).
create table if not exists public.fpx_mailbox_links (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.fpx_mailbox_connections(id),
  conversation_id text not null,
  shipment_id text not null,
  matched_on text check (matched_on in ('shipment_id', 'tracking_number', 'order_number', 'reference', 'pickup_number', 'confirmation_number', 'manual')),
  matched_text text,
  source text not null default 'auto' check (source in ('auto', 'person')),
  created_by text,
  dismissed boolean not null default false,
  dismissed_by text,
  dismissed_at timestamptz,
  created_at timestamptz default now(),
  unique (connection_id, conversation_id, shipment_id)
);
create index if not exists fpx_mailbox_links_shipment_idx on public.fpx_mailbox_links (shipment_id) where not dismissed;
create index if not exists fpx_mailbox_links_conv_idx on public.fpx_mailbox_links (connection_id, conversation_id);

-- Inline (cid:) images cached in Storage bucket "mailbox-cache".
create table if not exists public.fpx_mailbox_inline_images (
  message_id uuid not null references public.fpx_mailbox_messages(id),
  content_id text not null,
  storage_path text,
  content_type text,
  size int,
  created_at timestamptz default now(),
  primary key (message_id, content_id)
);

-- Same view as 2026-11-20_support_mailbox.sql (every column, same order) with
-- party, linked_shipment_ids and linked_count appended.
create or replace view public.fpx_mailbox_threads with (security_invoker = true) as
with live as (
  select m.*, coalesce(m.received_at, m.sent_at) as at
  from public.fpx_mailbox_messages m
  where not m.removed_in_outlook and m.conversation_id is not null
),
agg as (
  select
    connection_id,
    conversation_id,
    max(at) as last_message_at,
    max(at) filter (where direction = 'in') as last_inbound_at,
    max(at) filter (where direction = 'out') as last_outbound_at,
    count(*)::int as message_count,
    coalesce(array_agg(distinct from_address) filter (where from_address is not null), '{}') as participants
  from live
  group by connection_id, conversation_id
),
latest as (
  select distinct on (connection_id, conversation_id)
    connection_id, conversation_id, subject, body_preview, from_name, from_address
  from live
  order by connection_id, conversation_id, at desc nulls last, id
),
links as (
  select connection_id, conversation_id, array_agg(distinct shipment_id order by shipment_id) as ids
  from public.fpx_mailbox_links
  where not dismissed
  group by connection_id, conversation_id
)
select
  a.connection_id,
  a.conversation_id,
  l.subject,
  a.last_message_at,
  a.last_inbound_at,
  a.last_outbound_at,
  a.message_count,
  l.body_preview as preview,
  l.from_name as last_from_name,
  l.from_address as last_from_address,
  a.participants,
  case
    when a.last_inbound_at is null then 'outbound_only'
    when a.last_outbound_at is not null and a.last_outbound_at >= a.last_inbound_at then 'responded'
    else 'awaiting_reply'
  end as status,
  coalesce(tm.party, 'unknown') as party,
  coalesce(lk.ids, '{}'::text[]) as linked_shipment_ids,
  coalesce(cardinality(lk.ids), 0)::int as linked_count
from agg a
join latest l on l.connection_id = a.connection_id and l.conversation_id = a.conversation_id
left join public.fpx_mailbox_thread_meta tm on tm.connection_id = a.connection_id and tm.conversation_id = a.conversation_id
left join links lk on lk.connection_id = a.connection_id and lk.conversation_id = a.conversation_id;

-- Server (service role) only, like the other fpx_ tables.
alter table public.fpx_mailbox_domains enable row level security;
alter table public.fpx_mailbox_thread_meta enable row level security;
alter table public.fpx_mailbox_links enable row level security;
alter table public.fpx_mailbox_inline_images enable row level security;
revoke all on public.fpx_mailbox_domains from anon, authenticated;
revoke all on public.fpx_mailbox_thread_meta from anon, authenticated;
revoke all on public.fpx_mailbox_links from anon, authenticated;
revoke all on public.fpx_mailbox_inline_images from anon, authenticated;
revoke all on public.fpx_mailbox_threads from anon, authenticated;
