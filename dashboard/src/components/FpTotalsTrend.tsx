import { useEffect, useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import { hostedBrowser, type FpTotals, type FpTotalsPoint, type TaskSnapshot } from "../lib/hostedBrowser";
import { fmtDateTime, fmtRelative } from "../lib/format";

// Trends recorded at the start (before) and end (after) of every scrape run:
//  - FreightPOP's own dashboard totals (Total / Booked / In Transit / Issues / Out for Delivery)
//  - the Tasks board (active, needs attention, each segment, health flags)
//  - shipment dispositions: the status of the shipments behind active tasks
// One small chart per metric, each on its own scale (they differ a lot in
// size — never one shared axis). Single series each, one line colour, text in
// ink colours; hover a point for that run's before → after.

type Snap = { fp: FpTotals | null; tasks: TaskSnapshot | null };
type Metric = { key: string; label: string; get: (s: Snap) => number | null | undefined; goodWhenDown?: boolean; hint?: string };
type Group = { id: string; title: string; metrics: Metric[] };

const fpTile = (k: keyof FpTotals) => (s: Snap) => (s.fp?.[k] as number | undefined);
const seg = (k: string) => (s: Snap) => (s.tasks ? s.tasks.by_segment?.[k] ?? 0 : undefined);
const flag = (k: string) => (s: Snap) => (s.tasks ? s.tasks.by_flag?.[k] ?? 0 : undefined);
const disp = (k: string) => (s: Snap) => (s.tasks ? s.tasks.dispositions?.[k] ?? 0 : undefined);

const GROUPS: Group[] = [
  {
    id: "fp", title: "FreightPOP dashboard",
    metrics: [
      { key: "fp_total", label: "Total", get: fpTile("TOTAL") },
      { key: "fp_booked", label: "Booked", get: fpTile("BOOKED") },
      { key: "fp_transit", label: "In transit", get: fpTile("IN TRANSIT") },
      { key: "fp_issues", label: "Issues", get: fpTile("ISSUES"), goodWhenDown: true },
      { key: "fp_ofd", label: "Out for delivery", get: fpTile("OUT FOR DELIVERY") },
    ],
  },
  {
    id: "tasks", title: "Task board",
    metrics: [
      { key: "t_active", label: "Active tasks", get: (s) => s.tasks?.active, goodWhenDown: true },
      { key: "t_attention", label: "Needs attention", get: (s) => s.tasks?.needs_attention, goodWhenDown: true, hint: "Redelivery, return/claim, storage risk, repeat failures" },
      { key: "t_carrier", label: "Carrier follow-ups", get: seg("carrier"), goodWhenDown: true },
      { key: "t_customer", label: "Customer follow-ups", get: seg("customer"), goodWhenDown: true },
      { key: "t_storage", label: "Storage risk", get: seg("storage_risk"), goodWhenDown: true },
      { key: "t_redelivery", label: "Redelivery", get: seg("redelivery"), goodWhenDown: true },
      { key: "t_return", label: "Return / claim", get: seg("return_claim"), goodWhenDown: true },
      { key: "t_resolved", label: "Likely resolved", get: flag("resolved_upstream"), hint: "Delivered / archived / AI says no — ready to close" },
      { key: "t_stale", label: "Stale data", get: flag("stale"), goodWhenDown: true },
      { key: "t_aging", label: "Aging", get: flag("aging"), goodWhenDown: true, hint: "Open 5+ days" },
    ],
  },
  {
    id: "disp", title: "Shipment dispositions (behind active tasks)",
    metrics: [
      { key: "d_transit", label: "In transit", get: disp("IN TRANSIT") },
      { key: "d_ofd", label: "Out for delivery", get: disp("OUT FOR DELIVERY") },
      { key: "d_issue", label: "Issue", get: disp("ISSUE"), goodWhenDown: true },
      { key: "d_booked", label: "Booked", get: disp("BOOKED") },
      { key: "d_delivered", label: "Delivered", get: disp("DELIVERED"), hint: "Tasks on delivered shipments can usually be closed" },
    ],
  },
];

const LINE = "#7c3aed"; // violet-600, the app's accent
const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

function Delta({ d, goodWhenDown }: { d: number | null; goodWhenDown?: boolean }) {
  if (d == null) return <span className="text-slate-400">—</span>;
  if (d === 0) return <span className="text-slate-500">no change</span>;
  const up = d > 0;
  const tone = !goodWhenDown ? "text-slate-600" : up ? "text-rose-700" : "text-emerald-700";
  return <span className={tone}>{up ? "▲" : "▼"} {Math.abs(d).toLocaleString()}</span>;
}

export function useFpTotals(limit = 60) {
  const [points, setPoints] = useState<FpTotalsPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!hostedBrowser.enabled) return;
    let alive = true;
    const load = () => hostedBrowser.totals(limit).then((r) => { if (alive) setPoints(r.points); }).catch((e) => { if (alive) setErr((e as Error).message); });
    load();
    const id = setInterval(load, 120_000);
    return () => { alive = false; clearInterval(id); };
  }, [limit]);
  return { points, err };
}

type Pt = FpTotalsPoint & { end: Snap; start: Snap };

// `groups` picks which sections to show (compact = just the numbers).
export function FpTotalsTrend({ compact = false, groups }: { compact?: boolean; groups?: string[] }) {
  const { points, err } = useFpTotals(60);
  const series: Pt[] = useMemo(() => (points || []).slice().reverse().map((p) => ({
    ...p,
    start: { fp: p.before, tasks: p.tasksBefore || null },
    end: { fp: p.after || p.before, tasks: p.tasksAfter || p.tasksBefore || null },
  })), [points]);
  if (!hostedBrowser.enabled) return null;
  if (err) return compact ? null : <div className="text-xs text-rose-700">Couldn't load run trends: {err}</div>;
  if (!points) return compact ? null : <div className="text-xs text-slate-400">Loading run trends…</div>;
  if (!series.length) {
    return compact ? null : (
      <div className="text-sm text-slate-500">FreightPOP's totals, the task board and shipment dispositions are saved at the start and end of every run — the trend starts with the next run.</div>
    );
  }
  const last = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const shown = GROUPS.filter((g) => !groups || groups.includes(g.id))
    .map((g) => ({ ...g, metrics: g.metrics.filter((m) => series.some((p) => m.get(p.end) != null)) }))
    .filter((g) => g.metrics.length);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4 text-violet-600" /> Run trends
        </div>
        <div className="text-xs text-slate-500" title={fmtDateTime(last.finishedAt)}>
          After the last run · {fmtRelative(last.finishedAt)} · change vs the run before · {series.length} run{series.length === 1 ? "" : "s"}
        </div>
      </div>
      {shown.map((g) => (
        <div key={g.id} className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.title}</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {g.metrics.map((m) => {
              const cur = m.get(last.end) ?? null;
              const before = prev ? m.get(prev.end) ?? null : null;
              const d = cur != null && before != null ? cur - before : null;
              return (
                <div key={m.key} className="rounded-xl bg-white ring-1 ring-slate-200 p-3 min-w-0" title={m.hint}>
                  <div className="text-[11px] font-medium text-slate-500 truncate">{m.label}</div>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-xl font-semibold text-slate-900 tabular-nums">{fmt(cur)}</div>
                    <div className="text-xs tabular-nums"><Delta d={d} goodWhenDown={m.goodWhenDown} /></div>
                  </div>
                  {!compact && series.length > 1 ? <Spark metric={m} series={series} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Spark({ metric, series }: { metric: Metric; series: Pt[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 200, H = 44, PAD = 4;
  const vals = series.map((p) => metric.get(p.end) ?? null);
  const known = vals.filter((v): v is number => v != null);
  if (known.length < 2) return <div className="h-11 text-[11px] text-slate-400 flex items-end">Not enough runs yet</div>;
  let lo = Math.min(...known), hi = Math.max(...known);
  if (hi === lo) { lo -= 1; hi += 1; }
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, series.length - 1);
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2);
  let path = "";
  vals.forEach((v, i) => { if (v == null) return; path += `${path ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  const hp = hover != null ? series[hover] : null;
  const hv = hover != null ? vals[hover] : null;

  return (
    <div className="relative mt-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-11 overflow-visible" preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((rel - PAD) / (W - PAD * 2)) * (series.length - 1));
          setHover(Math.max(0, Math.min(series.length - 1, i)));
        }}
        role="img" aria-label={`${metric.label} over the last ${series.length} runs, from ${known[0].toLocaleString()} to ${known[known.length - 1].toLocaleString()}`}>
        <path d={path} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover != null && hv != null ? (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="#cbd5e1" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={y(hv)} r={3.5} fill={LINE} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
      </svg>
      {hp ? (
        <div className="pointer-events-none absolute z-10 -top-2 rounded-lg bg-slate-900 text-white text-[11px] px-2 py-1 shadow whitespace-nowrap"
          style={{ left: `${(x(hover!) / W) * 100}%`, transform: `translate(${hover! > series.length / 2 ? "-100%" : "0"}, -100%)` }}>
          <div className="font-medium">{fmtDateTime(hp.finishedAt || hp.startedAt)}</div>
          <div>{metric.label}: {fmt(metric.get(hp.start))} → {fmt(metric.get(hp.end))}</div>
          <div className="text-slate-300">{hp.source === "schedule" ? `Scheduled${hp.scheduleName ? ` · ${hp.scheduleName}` : ""}` : "Manual"}{hp.ok ? "" : " · failed"}</div>
        </div>
      ) : null}
    </div>
  );
}

// Per run, before → after for the headline numbers (the table view).
const RUN_LINE: Metric[] = [
  GROUPS[0].metrics[0], GROUPS[0].metrics[3],                       // FreightPOP total, issues
  GROUPS[1].metrics[0], GROUPS[1].metrics[1], GROUPS[1].metrics[2], GROUPS[1].metrics[3], GROUPS[1].metrics[7], // tasks
  GROUPS[2].metrics[2], GROUPS[2].metrics[4],                       // dispositions: issue, delivered
];
const RUN_PREFIX: Record<string, string> = { fp_total: "FP total", fp_issues: "FP issues", d_issue: "Issue shipments", d_delivered: "Delivered shipments" };

export function FpBeforeAfter({ before, after, tasksBefore, tasksAfter }: {
  before?: FpTotals | null; after?: FpTotals | null; tasksBefore?: TaskSnapshot | null; tasksAfter?: TaskSnapshot | null;
}) {
  if (!before && !after && !tasksBefore && !tasksAfter) return null;
  const s0: Snap = { fp: before || null, tasks: tasksBefore || null };
  const s1: Snap = { fp: after || null, tasks: tasksAfter || null };
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 tabular-nums">
      {RUN_LINE.map((m) => {
        const b = m.get(s0), a = m.get(s1);
        if (b == null && a == null) return null;
        const d = a != null && b != null ? a - b : null;
        return (
          <span key={m.key}>
            <span className="text-slate-400">{RUN_PREFIX[m.key] || m.label}</span> {fmt(b)} → {fmt(a)}
            {d ? <span className={m.goodWhenDown ? (d > 0 ? " text-rose-700" : " text-emerald-700") : " text-slate-600"}> ({d > 0 ? "+" : ""}{d.toLocaleString()})</span> : null}
          </span>
        );
      })}
    </div>
  );
}
