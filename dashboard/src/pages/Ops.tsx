import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, DollarSign, Mail, RefreshCw, Sparkles, TrendingUp, AlertTriangle } from "lucide-react";
import { api, type OpsMetrics, type OpsDailyRow } from "../lib/api";
import { fmtNum, fmtUsd } from "../lib/format";

// Director-of-Ops dashboard. Three signals matter to FPX leadership:
// shipments analyzed daily, tasks completed, emails generated. The
// page is intentionally one screen — KPI strip on top, daily trend
// chart in the middle, operator leaderboard at the bottom — so the
// director can read the day's pulse without scrolling or filtering.
//
// Data freshness: pulls /api/ops/metrics on mount + when the window
// is changed. No polling — the director's pattern is to glance at
// the page in standups, not stare at it. Manual refresh is one tap.

const WINDOWS: { days: number; label: string }[] = [
  { days: 7,  label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 60, label: "60d" },
  { days: 90, label: "90d" },
];

export function OpsPage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<OpsMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await api.ops.metrics(days);
      setData(r);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  // Effect-driven load (initial + window switch). Cancel guard prevents a
  // slower 90d response from overwriting a newer 7d click on rapid range
  // toggles. KPI / chart components already keep prior `data` visible
  // while loading — no full-page blank on window change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    api.ops.metrics(days)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [days]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-emerald-600" /> Ops dashboard
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Director-of-Ops rollup: shipments analyzed, tasks completed, emails generated. Updates on refresh.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setDays(w.days)}
                className={
                  "px-2.5 py-1.5 text-sm font-medium first:rounded-l-lg last:rounded-r-lg transition " +
                  (days === w.days
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-50")
                }
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} /> Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-3 text-sm text-rose-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      ) : null}

      <KpiStrip data={data} loading={loading} />

      <CostBreakdownCard data={data} />

      <DailyTrendCard data={data} loading={loading} days={days} />

      <OperatorLeaderboard data={data} loading={loading} />
    </div>
  );
}

function KpiStrip({ data, loading }: { data: OpsMetrics | null; loading: boolean }) {
  // Three big-number cards with today / last 7d / window-total. The
  // ratio between today and the 7d average gives a quick "are we on
  // pace" read without rendering a chart.
  const cards = useMemo(() => {
    if (!data) return null;
    const dailyAvg7 = (n: number) => n / 7;
    // The cost card uses USD formatting; the others count integers.
    // Marking the format per-card keeps the renderer agnostic.
    return [
      {
        label: "Shipments analyzed",
        Icon: Sparkles,
        tone: "text-sky-700 bg-sky-50 ring-sky-200",
        today: data.today.shipments_analyzed,
        last7: data.last7.shipments_analyzed,
        total: data.totals.shipments_analyzed,
        avg: dailyAvg7(data.last7.shipments_analyzed),
        format: "count" as const,
      },
      {
        label: "Tasks completed",
        Icon: CheckCircle2,
        tone: "text-emerald-700 bg-emerald-50 ring-emerald-200",
        today: data.today.tasks_completed,
        last7: data.last7.tasks_completed,
        total: data.totals.tasks_completed,
        avg: dailyAvg7(data.last7.tasks_completed),
        format: "count" as const,
      },
      {
        label: "Emails generated",
        Icon: Mail,
        tone: "text-violet-700 bg-violet-50 ring-violet-200",
        today: data.today.emails_generated,
        last7: data.last7.emails_generated,
        total: data.totals.emails_generated,
        avg: dailyAvg7(data.last7.emails_generated),
        format: "count" as const,
      },
      {
        label: "AI cost",
        Icon: DollarSign,
        tone: "text-amber-700 bg-amber-50 ring-amber-200",
        today: data.today.cost_usd,
        last7: data.last7.cost_usd,
        total: data.totals.cost_usd,
        avg: dailyAvg7(data.last7.cost_usd),
        format: "usd" as const,
      },
    ];
  }, [data]);

  if (loading && !data) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl ring-1 ring-slate-200 bg-white p-4">
            <div className="h-3 w-24 bg-slate-200 rounded mb-3 animate-pulse" />
            <div className="h-8 w-20 bg-slate-200 rounded mb-2 animate-pulse" />
            <div className="h-3 w-32 bg-slate-200 rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }
  if (!cards) return null;

  // Per-card formatter — counts get fmtNum, AI cost uses fmtUsd. Avg
  // is always shown to 1 decimal for counts but to 2 for $ to match
  // the precision the operator is reading.
  function fmt(c: { format: "count" | "usd" }, v: number) {
    return c.format === "usd" ? fmtUsd(v) : fmtNum(v);
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      {cards.map((c) => {
        const onPace = c.avg > 0 ? c.today / c.avg : null;
        // Tone the "vs avg" strip green when today >= 7d avg, amber
        // when we're trailing; suppress entirely if there's no signal
        // (avg=0 means a quiet window — no useful comparison).
        const trendTone = onPace === null ? "text-slate-400"
          : onPace >= 1 ? "text-emerald-600"
          : onPace >= 0.6 ? "text-amber-600"
          : "text-rose-600";
        return (
          <div key={c.label} className="rounded-xl ring-1 ring-slate-200 bg-white p-4 flex flex-col">
            <div className="flex items-center gap-2">
              <span className={`h-8 w-8 rounded-lg ring-1 inline-flex items-center justify-center ${c.tone}`}>
                <c.Icon className="h-4 w-4" />
              </span>
              <div className="text-sm font-semibold text-slate-700">{c.label}</div>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <div className="text-3xl font-bold text-slate-900 tabular-nums">{fmt(c, c.today)}</div>
              <div className="text-xs text-slate-500">today</div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-3 text-[11px]">
              <div>
                <div className="text-slate-500 uppercase tracking-wider font-semibold">7d</div>
                <div className="text-slate-900 font-semibold tabular-nums">{fmt(c, c.last7)}</div>
              </div>
              <div>
                <div className="text-slate-500 uppercase tracking-wider font-semibold">Window</div>
                <div className="text-slate-900 font-semibold tabular-nums">{fmt(c, c.total)}</div>
              </div>
              <div>
                <div className="text-slate-500 uppercase tracking-wider font-semibold">7d avg/d</div>
                <div className={"font-semibold tabular-nums " + trendTone}>
                  {c.format === "usd" ? fmtUsd(c.avg) : c.avg.toFixed(1)}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DailyTrendCard({ data, loading, days }: { data: OpsMetrics | null; loading: boolean; days: number }) {
  // Lightweight inline bar chart — no chart library dependency. Three
  // colored bars per day stacked vertically, scaled against the
  // window's max across all three series. SVG keeps the markup tiny
  // and crisp across DPRs.
  const max = useMemo(() => {
    if (!data) return 1;
    let m = 0;
    for (const d of data.daily) {
      m = Math.max(m, d.shipments_analyzed, d.tasks_completed, d.emails_generated);
    }
    return Math.max(1, m);
  }, [data]);

  if (loading && !data) {
    return (
      <div className="rounded-xl ring-1 ring-slate-200 bg-white p-4">
        <div className="h-4 w-40 bg-slate-200 rounded animate-pulse mb-3" />
        <div className="h-44 bg-slate-100 rounded animate-pulse" />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Activity className="h-4 w-4 text-slate-700" /> Daily trend ({days} day{days === 1 ? "" : "s"})
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">Each day shows three bars: shipments analyzed (sky), tasks completed (emerald), emails generated (violet).</p>
        </div>
        <Legend />
      </div>
      <div className="overflow-x-auto">
        <DailyChart rows={data.daily} max={max} />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-slate-600">
      <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-sky-500" /> Analyzed</span>
      <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Tasks</span>
      <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-violet-500" /> Emails</span>
    </div>
  );
}

function DailyChart({ rows, max }: { rows: OpsDailyRow[]; max: number }) {
  // Bar width budget: 18px per day with 4px gap, three sub-bars per day
  // taking up the 18px split evenly. Fits ~30 days in ~660px without
  // horizontal scroll on desktop; longer windows scroll.
  const dayW = 22;
  const subW = 6;
  const subGap = 1;
  const groupGap = 4;
  const height = 180;
  const padTop = 8;
  const padBot = 28; // room for date labels
  const innerH = height - padTop - padBot;
  const totalW = rows.length * dayW + (rows.length - 1) * groupGap;

  function barH(v: number) { return Math.max(0, Math.round((v / max) * innerH)); }

  return (
    <svg width={Math.max(totalW, 100)} height={height} className="block">
      {/* Y-axis baseline */}
      <line x1={0} x2={totalW} y1={padTop + innerH} y2={padTop + innerH} stroke="#e2e8f0" />
      {rows.map((d, i) => {
        const x = i * (dayW + groupGap);
        const x0 = x;
        const x1 = x + subW + subGap;
        const x2 = x + (subW + subGap) * 2;
        const y0 = padTop + innerH - barH(d.shipments_analyzed);
        const y1 = padTop + innerH - barH(d.tasks_completed);
        const y2 = padTop + innerH - barH(d.emails_generated);
        const labelEvery = rows.length > 30 ? 7 : rows.length > 14 ? 3 : 1;
        const showLabel = i === 0 || i === rows.length - 1 || i % labelEvery === 0;
        const dt = new Date(d.date + "T00:00:00Z");
        const labelText = `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
        return (
          <g key={d.date}>
            <title>
              {d.date}: {d.shipments_analyzed} analyzed · {d.tasks_completed} tasks done · {d.emails_generated} emails
            </title>
            <rect x={x0} y={y0} width={subW} height={barH(d.shipments_analyzed)} fill="#0ea5e9" rx={1} />
            <rect x={x1} y={y1} width={subW} height={barH(d.tasks_completed)} fill="#10b981" rx={1} />
            <rect x={x2} y={y2} width={subW} height={barH(d.emails_generated)} fill="#8b5cf6" rx={1} />
            {showLabel ? (
              <text
                x={x + (subW * 3 + subGap * 2) / 2}
                y={padTop + innerH + 14}
                textAnchor="middle"
                fontSize="10"
                fill="#64748b"
              >
                {labelText}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function OperatorLeaderboard({ data, loading }: { data: OpsMetrics | null; loading: boolean }) {
  if (loading && !data) {
    return (
      <div className="rounded-xl ring-1 ring-slate-200 bg-white p-4">
        <div className="h-4 w-40 bg-slate-200 rounded animate-pulse mb-3" />
        <div className="h-32 bg-slate-100 rounded animate-pulse" />
      </div>
    );
  }
  if (!data) return null;
  const rows = data.byOperator;
  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <CheckCircle2 className="h-4 w-4 text-emerald-700" /> Top operators
        </h3>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Ranked by tasks completed + emails generated in the selected window. (automated) tag = analyses without an attributed user.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-slate-500 text-center">No activity in this window.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Operator</th>
              <th className="text-right px-4 py-2 font-medium">Tasks completed</th>
              <th className="text-right px-4 py-2 font-medium">Emails generated</th>
              <th className="text-right px-4 py-2 font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const total = r.tasks_completed + r.emails_generated;
              return (
                <tr key={r.operator} className="border-t border-slate-100">
                  <td className="px-4 py-2 truncate max-w-[280px]" title={r.operator}>{r.operator}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.tasks_completed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.emails_generated)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtNum(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// AI cost breakdown bar — shows the per-category split of the
// "AI cost" total in the KPI strip so the director can see whether
// the spend is going to per-shipment analysis (Haiku, cheap), per-
// shipment email drafts (Haiku/Sonnet), or bulk group emails (Opus,
// pricey but rare). Renders nothing when there's zero spend in the
// window — no point showing an empty stack.
function CostBreakdownCard({ data }: { data: OpsMetrics | null }) {
  if (!data) return null;
  const { cost_usd, cost_breakdown } = data.totals;
  if (!cost_usd || cost_usd <= 0) return null;
  // Each category gets its own segment in the bar. We render in
  // order of typical magnitude (per-shipment is highest count;
  // group emails most expensive per call) so the colors stay
  // consistent across windows.
  const segments: { label: string; value: number; tone: string; bar: string }[] = [
    { label: "Per-shipment analysis", value: cost_breakdown.per_shipment_analysis, tone: "text-sky-700", bar: "bg-sky-500" },
    { label: "Per-shipment email",    value: cost_breakdown.email_single,          tone: "text-violet-700", bar: "bg-violet-500" },
    { label: "Bulk group email",      value: cost_breakdown.email_group,           tone: "text-amber-700", bar: "bg-amber-500" },
    { label: "Other (audits, ad-hoc)", value: cost_breakdown.other,                 tone: "text-slate-700", bar: "bg-slate-400" },
  ];
  const total = segments.reduce((s, x) => s + x.value, 0) || cost_usd;
  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <DollarSign className="h-4 w-4 text-amber-600" /> AI cost breakdown
        </h3>
        <span className="text-[11px] text-slate-500">
          window total {fmtUsd(cost_usd)}
        </span>
      </div>
      {/* Stacked bar — proportions only, not to absolute scale across
          dashboards. Mainly an at-a-glance "where does the spend go"
          read; the table below has the dollar values. */}
      <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden flex">
        {segments.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          if (pct < 0.1) return null;
          return (
            <div
              key={s.label}
              className={s.bar}
              style={{ width: `${pct}%` }}
              title={`${s.label}: ${fmtUsd(s.value)}`}
            />
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
        {segments.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <div key={s.label}>
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${s.bar}`} />
                <span className="text-slate-500 truncate">{s.label}</span>
              </div>
              <div className={`mt-0.5 font-semibold tabular-nums ${s.tone}`}>
                {fmtUsd(s.value)}
                <span className="text-[10px] text-slate-400 ml-1">({pct.toFixed(0)}%)</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
