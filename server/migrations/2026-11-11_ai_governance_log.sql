-- AI governance trail + per-feature usage summary (applied 2026-11-11).
create table if not exists public.fpx_ai_governance_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null,           -- prompt_change | model_change | ai_setting_change | logging_change | ai_rewrite | ai_preview | human_review
  feature text,
  setting_key text,
  actor_email text,
  actor_source text,                  -- jwt | api_key | system
  summary text,
  before jsonb,
  after jsonb,
  analysis_id uuid,
  metadata jsonb
);
create index if not exists fpx_ai_governance_log_created_idx on public.fpx_ai_governance_log (created_at desc);
create index if not exists fpx_ai_governance_log_type_idx on public.fpx_ai_governance_log (event_type, created_at desc);
alter table public.fpx_ai_governance_log enable row level security;
revoke all on public.fpx_ai_governance_log from anon, authenticated;

drop function if exists public.fpx_ai_governance_summary(int);
create function public.fpx_ai_governance_summary(p_days int default 30)
returns table (
  feature text, by text, calls bigint, users bigint, system_calls bigint, errors bigint,
  cost_usd numeric, input_tokens bigint, output_tokens bigint,
  rated_up bigint, rated_down bigint, models text[], last_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(a.metadata->>'subkind', ''), a.kind, 'other') as feature,
         case when nullif(a.metadata->>'subkind', '') is null then 'kind' else 'subkind' end as by,
         count(*), count(distinct a.user_email),
         count(*) filter (where a.user_email is null),
         count(*) filter (where a.error is not null),
         round(coalesce(sum(a.cost_usd), 0)::numeric, 4),
         coalesce(sum(a.input_tokens), 0), coalesce(sum(a.output_tokens), 0),
         count(*) filter (where a.rating = 'up'), count(*) filter (where a.rating = 'down'),
         array_remove(array_agg(distinct a.model), null), max(a.created_at)
  from public.fpx_ai_analyses a
  where a.created_at > now() - make_interval(days => greatest(1, least(p_days, 365)))
  group by 1, 2
  order by 3 desc;
$$;
revoke all on function public.fpx_ai_governance_summary(int) from public, anon, authenticated;
grant execute on function public.fpx_ai_governance_summary(int) to service_role;
