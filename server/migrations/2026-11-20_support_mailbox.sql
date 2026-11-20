-- Applied to production 2026-11-20.
-- Support mailbox (freightsupport@freightpop.com) read through Microsoft Graph
-- by a dedicated Entra app whose access is limited to that one mailbox by an
-- Exchange Online RBAC-for-Applications management scope. See
-- server/lib/mailbox/{crypto,graph,sync}.js.
--
-- Additive only. Rows are never deleted by the server: a message removed or
-- moved out of Inbox / Sent Items in Outlook keeps its row with
-- removed_in_outlook = true. Disconnecting sets status = 'disconnected' and
-- keeps every message.
--
-- Example queries:
--   select mailbox, status, last_sync_at, backfill_done, last_error from public.fpx_mailbox_connections;
--   select status, count(*) from public.fpx_mailbox_threads group by status;
--   select subject, last_message_at, last_from_address from public.fpx_mailbox_threads
--   where status = 'awaiting_reply' order by last_message_at desc limit 20;

-- One row per connected mailbox. The client secret is stored encrypted
-- (AES-256-GCM, "v1:<iv>:<tag>:<ct>"); secret_hint keeps its last 4 chars.
create table if not exists public.fpx_mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null unique,
  tenant_id text not null,
  client_id text not null,
  secret_enc text not null,
  secret_hint text,
  status text not null default 'connected' check (status in ('connected', 'error', 'disconnected')),
  last_error text,
  connected_by text,
  connected_at timestamptz default now(),
  last_sync_at timestamptz,
  last_sync_result jsonb,
  backfill_done boolean not null default false,
  -- { inbox: { next?: url, delta?: url }, sentitems: { ... } } — Graph delta
  -- links; next is saved after every page so a backfill resumes where it stopped.
  delta_links jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One row per Graph message (ImmutableId) seen in Inbox or Sent Items.
create table if not exists public.fpx_mailbox_messages (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.fpx_mailbox_connections(id),
  graph_id text not null,
  internet_message_id text,
  conversation_id text,
  folder text not null check (folder in ('inbox', 'sentitems')),
  direction text not null check (direction in ('in', 'out')), -- 'out' when from = the mailbox
  subject text,
  from_address text,
  from_name text,
  to_recipients jsonb,  -- [{ name, address }]
  cc_recipients jsonb,  -- [{ name, address }]
  received_at timestamptz,
  sent_at timestamptz,
  body_preview text,
  body_html text,       -- filled lazily when someone opens the message
  has_attachments boolean,
  is_read boolean,
  importance text,
  categories jsonb,
  web_link text,
  removed_in_outlook boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (connection_id, graph_id)
);
create index if not exists fpx_mailbox_messages_conv_idx on public.fpx_mailbox_messages (connection_id, conversation_id);
create index if not exists fpx_mailbox_messages_received_idx on public.fpx_mailbox_messages (connection_id, received_at desc);
create index if not exists fpx_mailbox_messages_subject_idx on public.fpx_mailbox_messages (connection_id, lower(subject));

-- Reply drafts FPX created in Outlook (Drafts folder). FPX never sends mail.
create table if not exists public.fpx_mailbox_drafts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.fpx_mailbox_connections(id),
  conversation_id text,
  reply_to_message_id uuid references public.fpx_mailbox_messages(id),
  draft_graph_id text,
  web_link text,
  body text,
  ai_generated boolean default false,
  reply_all boolean default false,
  created_by text,
  created_at timestamptz default now()
);
create index if not exists fpx_mailbox_drafts_conv_idx on public.fpx_mailbox_drafts (connection_id, conversation_id, created_at desc);

-- One row per conversation, ignoring messages removed in Outlook.
--   responded       the latest outbound message is at or after the latest inbound one
--   awaiting_reply  an inbound message is newer than any outbound one (or there is no outbound)
--   outbound_only   nothing inbound in the conversation
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
  end as status
from agg a
join latest l using (connection_id, conversation_id);

-- Server (service role) only, like the other fpx_ tables.
alter table public.fpx_mailbox_connections enable row level security;
alter table public.fpx_mailbox_messages enable row level security;
alter table public.fpx_mailbox_drafts enable row level security;
revoke all on public.fpx_mailbox_connections from anon, authenticated;
revoke all on public.fpx_mailbox_messages from anon, authenticated;
revoke all on public.fpx_mailbox_drafts from anon, authenticated;
revoke all on public.fpx_mailbox_threads from anon, authenticated;
