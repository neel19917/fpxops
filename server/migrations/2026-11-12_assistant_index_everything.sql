-- Ask FPX retrieval index: cover everything, and embed all of it.
--
-- Before: one record per shipment that was scraped in the last 24h or had an
-- open task (~1.4k of ~15.5k), only the latest note, no closed tasks, no
-- tracking history, and only the first 1,200 characters were embedded.
--
-- Now:
--   * every non-archived shipment gets a record (on_dashboard still marks the
--     ones FreightPOP currently lists; search only includes the rest when asked)
--   * the record text holds ALL notes, open AND closed task titles, the
--     tracking event history (raw_data.Details) and the reference numbers
--   * the text is split into chunks of ~1,000 characters (up to 8 per
--     shipment) in fpx_assistant_chunks, and every chunk is embedded, so
--     nothing is cut off from meaning-based search
--   * a rebuild only rewrites records whose content changed
--
-- The fpx-embed edge function is unchanged: fpx_assistant_embed_queue() and
-- fpx_assistant_set_embeddings() keep their shapes and now work on chunks.

create table if not exists public.fpx_assistant_chunks (
  shipment_uuid uuid not null references public.fpx_assistant_index(shipment_uuid) on delete cascade,
  chunk_no      int  not null,
  body          text not null,
  body_hash     text generated always as (md5(body)) stored,
  on_dashboard  boolean not null default false,
  open_tasks    int not null default 0,
  last_seen     timestamptz,
  embedding     extensions.vector(384),
  embedded_hash text,
  primary key (shipment_uuid, chunk_no)
);
alter table public.fpx_assistant_chunks enable row level security;
revoke all on public.fpx_assistant_chunks from anon, authenticated;

create index if not exists fpx_assistant_chunks_embedding on public.fpx_assistant_chunks
  using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists fpx_assistant_chunks_pending on public.fpx_assistant_chunks
  (open_tasks desc, on_dashboard desc, last_seen desc nulls last)
  where embedded_hash is distinct from body_hash;
create index if not exists fpx_assistant_chunks_on_dash on public.fpx_assistant_chunks (shipment_uuid) where on_dashboard;

-- ---------------------------------------------------------------------------
-- Rebuild
-- ---------------------------------------------------------------------------
create or replace function public.fpx_assistant_reindex()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
 set statement_timeout to '120s'
as $function$
declare
  v_cutoff timestamptz;
  v_now timestamptz := now();
  v_count int;
begin
  select max(scraped_at) - interval '24 hours' into v_cutoff from public.fpx_shipments_latest;
  if v_cutoff is null then v_cutoff := v_now - interval '24 hours'; end if;

  drop table if exists _fpx_ix;
  create temp table _fpx_ix on commit drop as
  with open_tasks as (
    select t.shipment_id as sid,
           count(*) as n,
           bool_or(t.status = 'blocked') as any_blocked,
           min(t.created_at) as oldest,
           jsonb_agg(jsonb_build_object(
             'task_id', t.id, 'task', left(t.title, 160), 'status', t.status,
             'assigned_to', t.assigned_to, 'age_days', round((extract(epoch from (v_now - t.created_at)) / 86400)::numeric, 1)
           ) order by t.created_at) as list,
           string_agg(t.title, ' | ' order by t.created_at) as titles
    from public.fpx_shipment_tasks t
    where t.archived_at is null and t.status in ('open','in_progress','blocked') and t.shipment_id is not null
    group by t.shipment_id
  ),
  closed_tasks as (
    select t.sid, count(*) as n,
           jsonb_agg(jsonb_build_object('task', left(t.title, 160), 'status', t.status, 'closed', t.closed_at::date)
                     order by t.closed_at desc) filter (where t.rn <= 3) as list,
           string_agg(t.title, ' | ' order by t.closed_at desc) as titles
    from (
      select x.shipment_id as sid, x.title, x.status, coalesce(x.completed_at, x.updated_at, x.created_at) as closed_at,
             row_number() over (partition by x.shipment_id order by coalesce(x.completed_at, x.updated_at, x.created_at) desc) as rn
      from public.fpx_shipment_tasks x
      where x.status in ('done','cancelled') and x.shipment_id is not null
    ) t
    group by t.sid
  ),
  notes as (
    select n.sid, count(*) as n,
           jsonb_agg(jsonb_build_object('note', left(n.body, 220), 'by', n.created_by, 'at', n.created_at)
                     order by n.created_at desc) filter (where n.rn <= 5) as list,
           string_agg(n.body, ' | ' order by n.created_at desc) as all_text
    from (
      select x.shipment_id as sid, x.body, x.created_by, x.created_at,
             row_number() over (partition by x.shipment_id order by x.created_at desc) as rn
      from public.fpx_shipment_notes x
    ) n
    group by n.sid
  ),
  src as (
    select s.*, ot.n as task_n, ot.any_blocked, ot.oldest, ot.list as task_list, ot.titles,
           ct.n as closed_n, ct.list as closed_list, ct.titles as closed_titles,
           nt.n as note_n, nt.list as note_list, nt.all_text as notes_text,
           nullif(btrim(regexp_replace(coalesce(s.raw_data->>'Details', ''),
             '^\s*Carrier Status Code\s+Status\s+Status Comment\s+Status Date\s+City\s+State\s+Longitude\s+Latitude\s*', '')), '') as history,
           (s.scraped_at is null or s.scraped_at >= v_cutoff) as on_dash
    from public.fpx_shipments_latest s
    left join open_tasks ot on ot.sid = s.id
    left join closed_tasks ct on ct.sid = s.id
    left join notes nt on nt.sid = s.id
  )
  select
    id as shipment_uuid, shipment_id, tracking_number, customer_name as customer,
    coalesce(carrier_name, carrier) as carrier, mode, shipment_status as status,
    coalesce(action_required = 'YES', false) as action_needed, on_dash as on_dashboard,
    coalesce(task_n, 0)::int as open_tasks,
    ( case when action_required = 'YES' then 40 else 0 end
    + case when shipment_status ilike 'issue' then 30 else 0 end
    + case when coalesce(updated_eta, estimated_arrival) < v_now and delivery_date is null then 25 else 0 end
    + case when any_blocked then 10 else 0 end
    + least(20, coalesce(extract(epoch from (v_now - oldest)) / 86400 * 2, 0)) )::numeric as focus_score,
    jsonb_strip_nulls(jsonb_build_object(
      'id', id, 'shipment', shipment_id, 'tracking', tracking_number, 'customer', customer_name,
      'carrier', coalesce(carrier_name, carrier), 'mode', mode, 'status', shipment_status,
      'action_needed', action_required = 'YES', 'issue', left(ai_issue, 220),
      'recommendation', left(ai_recommendation, 300),
      'eta', coalesce(updated_eta, estimated_arrival), 'delivered', delivery_date, 'appointment', appointment_date,
      'origin', coalesce(origin, left(ship_from, 80)), 'destination', coalesce(destination, left(ship_to, 80)),
      'tracking_comments', left(tracking_comments, 240), 'pickup_response', left(pickup_response, 120),
      'last_seen', scraped_at, 'on_dashboard', on_dash,
      'tasks', task_list,
      'closed_tasks', closed_list, 'closed_task_count', closed_n,
      'latest_note', note_list->0,
      'notes', case when note_n > 1 then note_list end, 'note_count', note_n,
      'history', left(history, 500)
    )) as facts,
    -- Full text for keyword / fuzzy search.
    concat_ws(' ', shipment_id, tracking_number, customer_name, carrier_name, carrier, mode, shipment_status,
      origin, destination, ship_from, ship_to, ai_issue, ai_recommendation, tracking_comments, pickup_response,
      titles, notes_text, closed_titles, order_number, reference_one, reference_two, reference_three,
      reference_four, reference_five, reference_six, service, signed_by, account_manager, history) as doc,
    -- Text for meaning-based search: what happened first, identifiers left out.
    concat_ws('. ',
      nullif(concat_ws(' ', customer_name, '/', coalesce(carrier_name, carrier), mode), '/'),
      'Status ' || shipment_status,
      'From ' || coalesce(origin, left(ship_from, 80)) || ' to ' || coalesce(destination, left(ship_to, 80)),
      'Issue: ' || ai_issue, 'Next step: ' || ai_recommendation,
      'Carrier update: ' || tracking_comments, pickup_response,
      'Open tasks: ' || titles, 'Notes: ' || notes_text, 'Closed tasks: ' || closed_titles,
      'Tracking history: ' || history) as sem,
    concat_ws(' / ', customer_name, coalesce(carrier_name, carrier)) as sem_prefix,
    scraped_at as last_seen
  from src;

  -- Records: rewrite only what changed, insert what's new, drop what's gone.
  -- (Not INSERT .. ON CONFLICT: that computes the generated search columns for
  -- every row before it checks for a conflict, which made a no-change rebuild
  -- take ~9s.)
  update public.fpx_assistant_index ix set
    shipment_id = s.shipment_id, tracking_number = s.tracking_number, customer = s.customer, carrier = s.carrier,
    mode = s.mode, status = s.status, action_needed = s.action_needed, on_dashboard = s.on_dashboard,
    open_tasks = s.open_tasks, focus_score = s.focus_score, facts = s.facts, doc = s.doc, last_seen = s.last_seen,
    indexed_at = v_now
  from _fpx_ix s
  where s.shipment_uuid = ix.shipment_uuid
    and (ix.doc, ix.facts, ix.on_dashboard, ix.open_tasks, ix.focus_score, ix.last_seen, ix.status, ix.action_needed, ix.customer, ix.carrier, ix.mode)
        is distinct from
        (s.doc, s.facts, s.on_dashboard, s.open_tasks, s.focus_score, s.last_seen, s.status, s.action_needed, s.customer, s.carrier, s.mode);

  insert into public.fpx_assistant_index
    (shipment_uuid, shipment_id, tracking_number, customer, carrier, mode, status, action_needed, on_dashboard,
     open_tasks, focus_score, facts, doc, last_seen, indexed_at)
  select s.shipment_uuid, s.shipment_id, s.tracking_number, s.customer, s.carrier, s.mode, s.status, s.action_needed, s.on_dashboard,
         s.open_tasks, s.focus_score, s.facts, s.doc, s.last_seen, v_now
  from _fpx_ix s
  where not exists (select 1 from public.fpx_assistant_index ix where ix.shipment_uuid = s.shipment_uuid)
  on conflict (shipment_uuid) do nothing;

  delete from public.fpx_assistant_index ix
   where not exists (select 1 from _fpx_ix s where s.shipment_uuid = ix.shipment_uuid);

  -- Chunks: ~1,000 characters each (100 overlap), up to 8 per shipment.
  drop table if exists _fpx_ch;
  create temp table _fpx_ch on commit drop as
  select s.shipment_uuid, g.i as chunk_no,
         case when g.i = 0 then '' else coalesce(nullif(s.sem_prefix, '') || ': ', '') end
           || substr(s.sem, g.i * 1000 + 1, 1100) as body,
         s.on_dashboard, s.open_tasks, s.last_seen
  from _fpx_ix s
  cross join lateral generate_series(0, least(7, greatest(0, ceil((length(s.sem) - 100) / 1000.0)::int - 1))) as g(i)
  where coalesce(s.sem, '') <> '';

  update public.fpx_assistant_chunks c set
    body = s.body, on_dashboard = s.on_dashboard, open_tasks = s.open_tasks, last_seen = s.last_seen
  from _fpx_ch s
  where s.shipment_uuid = c.shipment_uuid and s.chunk_no = c.chunk_no
    and (c.body, c.on_dashboard, c.open_tasks, c.last_seen) is distinct from (s.body, s.on_dashboard, s.open_tasks, s.last_seen);

  insert into public.fpx_assistant_chunks (shipment_uuid, chunk_no, body, on_dashboard, open_tasks, last_seen)
  select s.shipment_uuid, s.chunk_no, s.body, s.on_dashboard, s.open_tasks, s.last_seen
  from _fpx_ch s
  where not exists (select 1 from public.fpx_assistant_chunks c where c.shipment_uuid = s.shipment_uuid and c.chunk_no = s.chunk_no)
  on conflict (shipment_uuid, chunk_no) do nothing;

  delete from public.fpx_assistant_chunks c
   where not exists (select 1 from _fpx_ch s where s.shipment_uuid = c.shipment_uuid and s.chunk_no = c.chunk_no);

  select count(*) into v_count from public.fpx_assistant_index;
  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Embedding queue + write-back (same shapes the fpx-embed function uses)
-- ---------------------------------------------------------------------------
create or replace function public.fpx_assistant_embed_queue(p_limit integer default 25)
 returns table(shipment_uuid uuid, doc text, doc_hash text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select c.shipment_uuid, c.body, c.body_hash
  from public.fpx_assistant_chunks c
  where c.embedded_hash is distinct from c.body_hash
  order by c.open_tasks desc, c.on_dashboard desc, c.last_seen desc nulls last, c.chunk_no
  limit least(greatest(coalesce(p_limit, 25), 1), 100);
$function$;

create or replace function public.fpx_assistant_set_embeddings(p_rows jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_n int;
begin
  update public.fpx_assistant_chunks c
     set embedding = (r->>'embedding')::extensions.vector, embedded_hash = r->>'doc_hash'
    from jsonb_array_elements(p_rows) r
   where c.shipment_uuid = (r->>'shipment_uuid')::uuid
     and c.body_hash = r->>'doc_hash';
  get diagnostics v_n = row_count;

  -- Keep the record-level columns in step (the Data flow page counts them):
  -- embedding = the first chunk's; embedded_hash = doc_hash once every chunk is done.
  update public.fpx_assistant_index ix
     set embedding = c.embedding,
         embedded_hash = case when not exists (
             select 1 from public.fpx_assistant_chunks p
             where p.shipment_uuid = ix.shipment_uuid and p.embedded_hash is distinct from p.body_hash
           ) then ix.doc_hash else ix.embedded_hash end
    from public.fpx_assistant_chunks c
   where c.shipment_uuid = ix.shipment_uuid and c.chunk_no = 0 and c.embedding is not null
     and ix.shipment_uuid in (select (r->>'shipment_uuid')::uuid from jsonb_array_elements(p_rows) r);
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Search: semantic match on the closest chunk of each shipment
-- ---------------------------------------------------------------------------
create or replace function public.fpx_assistant_search(p_query text, p_include_off_dashboard boolean default false, p_limit integer default 15, p_embedding extensions.vector default null::extensions.vector)
 returns table(facts jsonb, score real)
 language sql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
  with q as (
    select trim(coalesce(p_query, '')) as raw,
           websearch_to_tsquery('english', coalesce(p_query, '')) as tsq
  ),
  near as materialized (
    -- On-dashboard only: exact scan of the small on-dashboard set (the "+ 0"
    -- keeps the planner off the HNSW index, which would filter after the fact).
    select * from (
      select c.shipment_uuid, (c.embedding <=> p_embedding) as d
      from public.fpx_assistant_chunks c
      where p_embedding is not null and not p_include_off_dashboard and c.on_dashboard and c.embedding is not null
      order by (c.embedding <=> p_embedding) + 0
      limit 80
    ) a
    union all
    select * from (
      select c.shipment_uuid, (c.embedding <=> p_embedding) as d
      from public.fpx_assistant_chunks c
      where p_embedding is not null and p_include_off_dashboard and c.embedding is not null
      order by c.embedding <=> p_embedding
      limit 120
    ) b
  ),
  semantic as materialized (
    select shipment_uuid, min(d) as d from near group by shipment_uuid order by 2 limit 40
  )
  select ix.facts,
         ( case when ix.shipment_id = q.raw or ix.tracking_number = q.raw then 100 else 0 end
         + case when length(q.raw) >= 4 and (ix.shipment_id ilike q.raw || '%' or ix.tracking_number ilike '%' || q.raw || '%') then 20 else 0 end
         + ts_rank(ix.fts, q.tsq) * 10
         + greatest(similarity(coalesce(ix.customer, ''), q.raw), similarity(coalesce(ix.carrier, ''), q.raw)) * 5
         + case when p_embedding is null then 0 else coalesce((1 - coalesce(sem.d, (
               select min(c.embedding <=> p_embedding) from public.fpx_assistant_chunks c
               where c.shipment_uuid = ix.shipment_uuid and c.embedding is not null))) * 6, 0) end
         + case when ix.open_tasks > 0 then 0.5 else 0 end )::real as score
  from public.fpx_assistant_index ix
  cross join q
  left join semantic sem on sem.shipment_uuid = ix.shipment_uuid
  where q.raw <> ''
    and (p_include_off_dashboard or ix.on_dashboard)
    and ( ix.shipment_id = q.raw or ix.tracking_number = q.raw
       or (length(q.raw) >= 4 and (ix.shipment_id ilike q.raw || '%' or ix.tracking_number ilike '%' || q.raw || '%'))
       or ix.fts @@ q.tsq
       or q.raw <% ix.customer or q.raw <% ix.carrier
       or sem.shipment_uuid is not null )
  order by score desc
  limit least(greatest(coalesce(p_limit, 15), 1), 50);
$function$;
