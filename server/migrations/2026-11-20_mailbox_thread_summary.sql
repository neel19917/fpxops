-- Applied to production 2026-11-20.
-- Speed: fpx_mailbox_threads used to rebuild every thread from every message on
-- each read (~0.5 s at 36k messages / 19k threads, and the mailbox page makes
-- several such reads per load). Threads now live in a summary table that
-- triggers keep current: any insert/update of messages, thread meta (party) or
-- links refreshes just the conversations it touched. The view keeps the same
-- name and columns, so the server code is unchanged.
-- Apply after 2026-11-20_mailbox_linking.sql.

create table if not exists public.fpx_mailbox_thread_summary (
  connection_id uuid not null,
  conversation_id text not null,
  subject text,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  message_count int not null default 0,
  preview text,
  last_from_name text,
  last_from_address text,
  participants text[] not null default '{}',
  status text not null,
  party text not null default 'unknown',
  linked_shipment_ids text[] not null default '{}',
  linked_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (connection_id, conversation_id)
);
create index if not exists fpx_mailbox_thread_summary_recent_idx
  on public.fpx_mailbox_thread_summary (connection_id, last_message_at desc);
create index if not exists fpx_mailbox_thread_summary_status_idx
  on public.fpx_mailbox_thread_summary (connection_id, status, last_message_at desc);
create index if not exists fpx_mailbox_thread_summary_party_idx
  on public.fpx_mailbox_thread_summary (connection_id, party, last_message_at desc);
create index if not exists fpx_mailbox_thread_summary_links_idx
  on public.fpx_mailbox_thread_summary using gin (linked_shipment_ids);

-- Recompute the given conversations of one connection. Conversations with no
-- live message left lose their summary row (it is derived data; the messages
-- themselves are never deleted).
create or replace function public.fpx_mailbox_refresh_threads(p_conn uuid, p_convs text[])
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_conn is null or p_convs is null or cardinality(p_convs) = 0 then
    return;
  end if;

  delete from public.fpx_mailbox_thread_summary s
  where s.connection_id = p_conn
    and s.conversation_id = any (p_convs)
    and not exists (
      select 1 from public.fpx_mailbox_messages m
      where m.connection_id = p_conn and m.conversation_id = s.conversation_id and not m.removed_in_outlook
    );

  insert into public.fpx_mailbox_thread_summary as s (
    connection_id, conversation_id, subject, last_message_at, last_inbound_at, last_outbound_at,
    message_count, preview, last_from_name, last_from_address, participants, status,
    party, linked_shipment_ids, linked_count, updated_at)
  with live as (
    select m.*, coalesce(m.received_at, m.sent_at) as at
    from public.fpx_mailbox_messages m
    where m.connection_id = p_conn
      and m.conversation_id = any (p_convs)
      and not m.removed_in_outlook
  ),
  agg as (
    select conversation_id,
      max(at) as last_message_at,
      max(at) filter (where direction = 'in') as last_inbound_at,
      max(at) filter (where direction = 'out') as last_outbound_at,
      count(*)::int as message_count,
      coalesce(array_agg(distinct from_address) filter (where from_address is not null), '{}') as participants
    from live group by conversation_id
  ),
  latest as (
    select distinct on (conversation_id) conversation_id, subject, body_preview, from_name, from_address
    from live order by conversation_id, at desc nulls last, id
  ),
  links as (
    select conversation_id, array_agg(distinct shipment_id order by shipment_id) as ids
    from public.fpx_mailbox_links
    where connection_id = p_conn and conversation_id = any (p_convs) and not dismissed
    group by conversation_id
  )
  select p_conn, a.conversation_id, l.subject, a.last_message_at, a.last_inbound_at, a.last_outbound_at,
    a.message_count, l.body_preview, l.from_name, l.from_address, a.participants,
    case
      when a.last_inbound_at is null then 'outbound_only'
      when a.last_outbound_at is not null and a.last_outbound_at >= a.last_inbound_at then 'responded'
      else 'awaiting_reply'
    end,
    coalesce(tm.party, 'unknown'),
    coalesce(lk.ids, '{}'::text[]),
    coalesce(cardinality(lk.ids), 0),
    now()
  from agg a
  join latest l using (conversation_id)
  left join public.fpx_mailbox_thread_meta tm on tm.connection_id = p_conn and tm.conversation_id = a.conversation_id
  left join links lk on lk.conversation_id = a.conversation_id
  on conflict (connection_id, conversation_id) do update set
    subject = excluded.subject, last_message_at = excluded.last_message_at,
    last_inbound_at = excluded.last_inbound_at, last_outbound_at = excluded.last_outbound_at,
    message_count = excluded.message_count, preview = excluded.preview,
    last_from_name = excluded.last_from_name, last_from_address = excluded.last_from_address,
    participants = excluded.participants, status = excluded.status, party = excluded.party,
    linked_shipment_ids = excluded.linked_shipment_ids, linked_count = excluded.linked_count,
    updated_at = now();
end;
$$;

-- Statement-level triggers with transition tables (one event per trigger, as
-- Postgres requires). An upsert fires both the insert and the update trigger.
create or replace function public.fpx_mailbox_threads_touch()
returns trigger
language plpgsql
set search_path = public
as $$
declare r record;
begin
  for r in
    select connection_id, array_agg(distinct conversation_id) as convs
    from changed_rows
    where connection_id is not null and conversation_id is not null
    group by connection_id
  loop
    perform public.fpx_mailbox_refresh_threads(r.connection_id, r.convs);
  end loop;
  return null;
end;
$$;

drop trigger if exists fpx_mailbox_messages_threads_ins on public.fpx_mailbox_messages;
create trigger fpx_mailbox_messages_threads_ins after insert on public.fpx_mailbox_messages
  referencing new table as changed_rows for each statement execute function public.fpx_mailbox_threads_touch();
drop trigger if exists fpx_mailbox_messages_threads_upd on public.fpx_mailbox_messages;
create trigger fpx_mailbox_messages_threads_upd after update on public.fpx_mailbox_messages
  referencing new table as changed_rows for each statement execute function public.fpx_mailbox_threads_touch();

drop trigger if exists fpx_mailbox_meta_threads_ins on public.fpx_mailbox_thread_meta;
create trigger fpx_mailbox_meta_threads_ins after insert on public.fpx_mailbox_thread_meta
  referencing new table as changed_rows for each statement execute function public.fpx_mailbox_threads_touch();
drop trigger if exists fpx_mailbox_meta_threads_upd on public.fpx_mailbox_thread_meta;
create trigger fpx_mailbox_meta_threads_upd after update on public.fpx_mailbox_thread_meta
  referencing new table as changed_rows for each statement execute function public.fpx_mailbox_threads_touch();

drop trigger if exists fpx_mailbox_links_threads_ins on public.fpx_mailbox_links;
create trigger fpx_mailbox_links_threads_ins after insert on public.fpx_mailbox_links
  referencing new table as changed_rows for each statement execute function public.fpx_mailbox_threads_touch();
drop trigger if exists fpx_mailbox_links_threads_upd on public.fpx_mailbox_links;
create trigger fpx_mailbox_links_threads_upd after update on public.fpx_mailbox_links
  referencing new table as changed_rows for each statement execute function public.fpx_mailbox_threads_touch();

-- Fill it once for every existing conversation.
do $$
declare r record;
begin
  for r in
    select connection_id, array_agg(distinct conversation_id) as convs
    from public.fpx_mailbox_messages
    where conversation_id is not null
    group by connection_id
  loop
    perform public.fpx_mailbox_refresh_threads(r.connection_id, r.convs);
  end loop;
end $$;

-- Same name and columns as before; now a plain read of the summary table.
create or replace view public.fpx_mailbox_threads with (security_invoker = true) as
select connection_id, conversation_id, subject, last_message_at, last_inbound_at, last_outbound_at,
  message_count, preview, last_from_name, last_from_address, participants, status,
  party, linked_shipment_ids, linked_count
from public.fpx_mailbox_thread_summary;

alter table public.fpx_mailbox_thread_summary enable row level security;
revoke all on public.fpx_mailbox_thread_summary from anon, authenticated;
revoke all on public.fpx_mailbox_threads from anon, authenticated;
revoke all on function public.fpx_mailbox_refresh_threads(uuid, text[]) from anon, authenticated, public;
