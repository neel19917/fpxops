-- Applied to production 2026-11-20.
-- Shippers view: one row per shipper (fpx_shipments.customer_name) with tracking,
-- task and Support Mailbox counts, plus a per-shipper activity timeline.
-- Read-only functions; the server calls them with the service role.
--
-- Rules (checked against production data 2026-11-20):
--   shipper        = btrim(customer_name); null/blank -> '(No shipper)' (none today).
--   active         = archived_at is null.
--   in_transit     = active and shipment_status is 'In Transit' or 'Out For Delivery'
--                    (ilike '%transit%' or ilike '%out for delivery%'). The only statuses
--                    FreightPOP shows are In Transit, Out For Delivery, Booked and Issue.
--   delivered_30d  = delivery_date in the last 30 days, OR the shipment dropped off the
--                    FreightPOP dashboard in the last 30 days (archived_reason =
--                    'absent_from_dashboard', archived_at in the last 30 days). There is no
--                    'Delivered' status and delivery_date is never filled today, so dropping
--                    off the active dashboard is the delivered signal.
--   exceptions     = active and action_required = 'YES' (action_required is text YES/NO).
--   open_tasks     = fpx_shipment_tasks with status open|in_progress|blocked and
--                    archived_at is null, joined tasks.shipment_id (uuid) = fpx_shipments.id.
--   overdue_tasks  = open_tasks with due_at < now().
--   email_threads  = distinct (connection_id, conversation_id) from non-dismissed
--                    fpx_mailbox_links whose shipment_id (text) = fpx_shipments.shipment_id,
--                    joined to fpx_mailbox_thread_summary; awaiting_reply = those with
--                    status 'awaiting_reply'; last_email_at = max(last_message_at).
--   fpx_shipments.shipment_id is not unique (multi-piece shipments have one row per
--   tracking number) but never spans two customers, so links are de-duplicated per shipper.
--
-- Timeline kinds: note, task_created, task_done, email. No 'status' events: there is no
-- shipment status change log (fpx_shipment_scrapes is empty and nothing writes it;
-- fpx_scrape_history only records ERP/detail captures, not tracking status changes).

-- Already exist in production; kept so the functions never lose their indexes.
create index if not exists idx_fpx_shipments_customer on public.fpx_shipments (customer_name);
create index if not exists idx_fpx_tasks_shipment_id on public.fpx_shipment_tasks (shipment_id);
create index if not exists fpx_mailbox_links_shipment_idx on public.fpx_mailbox_links (shipment_id) where not dismissed;

create or replace function public.fpx_shipper_list()
returns table (
  customer_name text,
  shipments int,
  active int,
  in_transit int,
  delivered_30d int,
  exceptions int,
  last_scraped_at timestamptz,
  last_pickup_date timestamptz,
  open_tasks int,
  overdue_tasks int,
  email_threads int,
  awaiting_reply int,
  last_email_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with s as (
    select x.id, x.shipment_id,
           coalesce(nullif(btrim(x.customer_name), ''), '(No shipper)') as cust,
           x.shipment_status, x.action_required, x.archived_at, x.archived_reason,
           x.scraped_at, x.pickup_date, x.delivery_date
    from public.fpx_shipments x
  ),
  ship as (
    select s.cust,
      count(*)::int as shipments,
      count(*) filter (where s.archived_at is null)::int as active,
      count(*) filter (where s.archived_at is null
                         and (s.shipment_status ilike '%transit%'
                              or s.shipment_status ilike '%out for delivery%'))::int as in_transit,
      count(*) filter (where s.delivery_date >= now() - interval '30 days'
                          or (s.archived_reason = 'absent_from_dashboard'
                              and s.archived_at >= now() - interval '30 days'))::int as delivered_30d,
      count(*) filter (where s.archived_at is null
                         and upper(btrim(s.action_required)) in ('YES', 'TRUE'))::int as exceptions,
      max(s.scraped_at) as last_scraped_at,
      max(s.pickup_date) as last_pickup_date
    from s
    group by s.cust
  ),
  tk as (
    select s.cust,
      count(*)::int as open_tasks,
      count(*) filter (where t.due_at < now())::int as overdue_tasks
    from public.fpx_shipment_tasks t
    join s on s.id = t.shipment_id
    where t.status in ('open', 'in_progress', 'blocked')
      and t.archived_at is null
    group by s.cust
  ),
  sm as (
    select distinct s.shipment_id, s.cust from s where s.shipment_id is not null
  ),
  em as (
    select sm.cust,
      count(distinct (ts.connection_id, ts.conversation_id))::int as email_threads,
      count(distinct (ts.connection_id, ts.conversation_id))
        filter (where ts.status = 'awaiting_reply')::int as awaiting_reply,
      max(ts.last_message_at) as last_email_at
    from public.fpx_mailbox_links l
    join sm on sm.shipment_id = l.shipment_id
    join public.fpx_mailbox_thread_summary ts
      on ts.connection_id = l.connection_id and ts.conversation_id = l.conversation_id
    where not l.dismissed
    group by sm.cust
  )
  select ship.cust,
         ship.shipments,
         ship.active,
         ship.in_transit,
         ship.delivered_30d,
         ship.exceptions,
         ship.last_scraped_at,
         ship.last_pickup_date,
         coalesce(tk.open_tasks, 0),
         coalesce(tk.overdue_tasks, 0),
         coalesce(em.email_threads, 0),
         coalesce(em.awaiting_reply, 0),
         em.last_email_at
  from ship
  left join tk on tk.cust = ship.cust
  left join em on em.cust = ship.cust
  order by ship.shipments desc, ship.cust
$$;

create or replace function public.fpx_shipper_timeline(p_customer text, p_limit int default 100)
returns table (
  at timestamptz,
  kind text,
  title text,
  detail text,
  shipment_id text,
  tracking_number text,
  ref_id text,
  actor text
)
language sql
stable
set search_path = public
as $$
  with p as (
    select p_customer as cust,
           greatest(1, least(coalesce(p_limit, 100), 500)) as lim
  ),
  -- '(No shipper)' means null/blank customer_name.
  s as materialized (
    select x.id, x.shipment_id, x.tracking_number
    from public.fpx_shipments x, p
    where x.customer_name = p.cust
       or (p.cust = '(No shipper)' and (x.customer_name is null or btrim(x.customer_name) = ''))
  ),
  -- Materialized so the task branches hash/index-join once instead of a nested loop
  -- over the shipments CTE (1.6 s -> 5 ms on the largest shipper).
  tk as materialized (
    select t.id, t.title, t.status, t.created_at, t.completed_at, t.created_by, t.assigned_to,
           s.shipment_id, coalesce(t.tracking_number, s.tracking_number) as tracking_number
    from public.fpx_shipment_tasks t
    join s on s.id = t.shipment_id
  ),
  notes as (
    (select n.created_at as at, 'note'::text as kind, 'Note'::text as title,
            left(n.body, 500) as detail, s.shipment_id,
            coalesce(n.tracking_number, s.tracking_number) as tracking_number,
            n.id::text as ref_id, n.created_by as actor
     from public.fpx_shipment_notes n
     join s on s.id = n.shipment_id
     order by n.created_at desc
     limit (select lim from p))
  ),
  tc as (
    (select tk.created_at, 'task_created'::text, tk.title, tk.status, tk.shipment_id,
            tk.tracking_number, tk.id::text, tk.created_by
     from tk
     order by tk.created_at desc
     limit (select lim from p))
  ),
  td as (
    (select tk.completed_at, 'task_done'::text, tk.title, tk.status, tk.shipment_id,
            tk.tracking_number, tk.id::text, tk.assigned_to
     from tk
     where tk.completed_at is not null
     order by tk.completed_at desc
     limit (select lim from p))
  ),
  sm as (
    select s.shipment_id, min(s.tracking_number) as tracking_number
    from s where s.shipment_id is not null
    group by s.shipment_id
  ),
  -- Newest message per linked thread; shipment_id = one of this shipper's linked shipments.
  em as (
    (select ts.last_message_at, 'email'::text,
            coalesce(nullif(ts.subject, ''), '(no subject)'), ts.status,
            lk.shipment_id, lk.tracking_number, ts.conversation_id,
            coalesce(ts.last_from_name, ts.last_from_address)
     from (
       select l.connection_id, l.conversation_id,
              min(l.shipment_id) as shipment_id, min(sm.tracking_number) as tracking_number
       from public.fpx_mailbox_links l
       join sm on sm.shipment_id = l.shipment_id
       where not l.dismissed
       group by l.connection_id, l.conversation_id
     ) lk
     join public.fpx_mailbox_thread_summary ts
       on ts.connection_id = lk.connection_id and ts.conversation_id = lk.conversation_id
     where ts.last_message_at is not null
     order by ts.last_message_at desc
     limit (select lim from p))
  )
  select u.at, u.kind, u.title, u.detail, u.shipment_id, u.tracking_number, u.ref_id, u.actor
  from (
    select * from notes
    union all select * from tc
    union all select * from td
    union all select * from em
  ) u
  order by u.at desc
  limit (select lim from p)
$$;

revoke execute on function public.fpx_shipper_list() from public, anon, authenticated;
revoke execute on function public.fpx_shipper_timeline(text, int) from public, anon, authenticated;
grant execute on function public.fpx_shipper_list() to service_role;
grant execute on function public.fpx_shipper_timeline(text, int) to service_role;
