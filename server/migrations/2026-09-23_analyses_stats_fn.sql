-- Exact totals for the AI Analyses page.
--
-- PostgREST caps a single select at 1000 rows on this project, so the page's
-- KPI strip (count / total cost / tokens / avg latency) was being computed
-- from the first 1000 rows and read "1000 analyses, $4.47" no matter how
-- much had actually been spent. This aggregates server-side, optionally
-- filtered by kind, metadata.subkind and a trailing day window, and returns
-- a per-kind/subkind breakdown for the page's cost table.
--
-- Applied to prod via the Supabase MCP on 2026-09-23.

create or replace function public.fpx_analyses_stats(p_kind text default null, p_subkind text default null, p_days int default null)
returns json language sql stable security definer set search_path = public as $$
  with base as (
    select kind, coalesce(metadata->>'subkind','') subkind, cost_usd, input_tokens, output_tokens, duration_ms, created_at, error
    from fpx_ai_analyses
    where (p_kind is null or kind = p_kind)
      and (p_subkind is null or coalesce(metadata->>'subkind','') = p_subkind)
      and (p_days is null or created_at >= now() - make_interval(days => p_days))
  )
  select json_build_object(
    'count', (select count(*) from base),
    'cost_usd', (select coalesce(sum(cost_usd),0) from base),
    'input_tokens', (select coalesce(sum(input_tokens),0) from base),
    'output_tokens', (select coalesce(sum(output_tokens),0) from base),
    'avg_duration_ms', (select coalesce(round(avg(duration_ms)),0) from base where duration_ms is not null),
    'errors', (select count(*) from base where error is not null),
    'first_at', (select min(created_at) from base),
    'last_at', (select max(created_at) from base),
    'by_kind', (select coalesce(json_agg(json_build_object('kind', kind, 'subkind', subkind, 'count', c, 'cost_usd', cost) order by cost desc), '[]'::json)
                from (select kind, subkind, count(*) c, coalesce(sum(cost_usd),0) cost from base group by 1,2) k)
  );
$$;

grant execute on function public.fpx_analyses_stats(text, text, int) to service_role;
