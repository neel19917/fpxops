import { useEffect, useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import { hostedBrowser, FP_TILES, type FpTile, type FpTotalsPoint } from "../lib/hostedBrowser";
import { fmtDateTime, fmtRelative } from "../lib/format";

// FreightPOP dashboard totals (TOTAL / BOOKED / IN TRANSIT / ISSUES /
// OUT FOR DELIVERY) recorded at the start and end of every scrape run.
// One small chart per total — they differ ~5× in size, so each gets its own
// scale (never one shared axis). Single series each: one line colour, text in
// ink colours, hover a point for that run's before → after.

const LABEL: Record<FpTile, string> = {
  TOTAL: "Total", BOOKED: "Booked", "IN TRANSIT": "In transit", ISSUES: "Issues", "OUT FOR DELIVERY": "Out for delivery",
};
const LINE = "#7c3aed"; // violet-600, the app's accent
const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

function Delta({ d, goodWhenDown }: { d: number | null; goodWhenDown?: boolean }) {
  if (d == null) return <span className="text-slate-400">—</span>;
  if (d === 0) return <span className="text-slate-500">no change</span>;
  const up = d > 0;
  const good = goodWhenDown ? !up : null;
  const tone = good == null ? "text-slate-600" : good ? "text-emerald-700" : "text-rose-700";
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

export function FpTotalsTrend({ compact = false }: { compact?: boolean }) {
  const { points, err } = useFpTotals(60);
  // Oldest → newest, runs that captured an end snapshot (or at least a start).
  const series = useMemo(() => (points || []).slice().reverse().map((p) => ({ ...p, v: p.after || p.before })).filter((p) => p.v), [points]);
  if (!hostedBrowser.enabled) return null;
  if (err) return compact ? null : <div className="text-xs text-rose-700">Couldn't load FreightPOP totals: {err}</div>;
  if (!points) return compact ? null : <div className="text-xs text-slate-400">Loading FreightPOP totals…</div>;
  if (!series.length) {
    return compact ? null : (
      <div className="text-sm text-slate-500">FreightPOP's dashboard totals are saved at the start and end of every run — the trend starts with the next run.</div>
    );
  }
  const last = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : null;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4 text-violet-600" /> FreightPOP dashboard totals
        </div>
        <div className="text-xs text-slate-500" title={fmtDateTime(last.finishedAt)}>
          After the last run · {fmtRelative(last.finishedAt)} · change vs the run before · {series.length} run{series.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {FP_TILES.map((k) => {
          const cur = last.v?.[k] ?? null;
          const before = prev?.v?.[k] ?? null;
          const d = cur != null && before != null ? cur - before : null;
          return (
            <div key={k} className="rounded-xl bg-white ring-1 ring-slate-200 p-3 min-w-0">
              <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{LABEL[k]}</div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-xl font-semibold text-slate-900 tabular-nums">{fmt(cur)}</div>
                <div className="text-xs tabular-nums"><Delta d={d} goodWhenDown={k === "ISSUES"} /></div>
              </div>
              {!compact && series.length > 1 ? <Spark tile={k} series={series} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Spark({ tile, series }: { tile: FpTile; series: (FpTotalsPoint & { v: FpTotalsPoint["after"] })[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 200, H = 44, PAD = 4;
  const vals = series.map((p) => p.v?.[tile] ?? null);
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
        role="img" aria-label={`${LABEL[tile]} over the last ${series.length} runs, from ${known[0].toLocaleString()} to ${known[known.length - 1].toLocaleString()}`}>
        <path d={path} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover != null && hv != null ? (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="#cbd5e1" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={y(hv)} r={3.5} fill={LINE} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
      </svg>
      {hp ? (
        <div className="pointer-events-none absolute z-10 -top-2 -translate-y-full rounded-lg bg-slate-900 text-white text-[11px] px-2 py-1 shadow whitespace-nowrap"
          style={{ left: `${(x(hover!) / W) * 100}%`, transform: `translate(${hover! > series.length / 2 ? "-100%" : "0"}, -100%)` }}>
          <div className="font-medium">{fmtDateTime(hp.finishedAt || hp.startedAt)}</div>
          <div>{LABEL[tile]}: {fmt(hp.before?.[tile])} → {fmt(hp.after?.[tile])}</div>
          <div className="text-slate-300">{hp.source === "schedule" ? `Scheduled${hp.scheduleName ? ` · ${hp.scheduleName}` : ""}` : "Manual"}{hp.ok ? "" : " · failed"}</div>
        </div>
      ) : null}
    </div>
  );
}

// One line per run: each total before → after, for the run list.
export function FpBeforeAfter({ before, after }: { before?: FpTotalsPoint["before"]; after?: FpTotalsPoint["after"] }) {
  if (!before && !after) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 tabular-nums">
      {FP_TILES.map((k) => {
        const b = before?.[k], a = after?.[k];
        if (b == null && a == null) return null;
        const d = a != null && b != null ? a - b : null;
        return (
          <span key={k}>
            <span className="text-slate-400">{LABEL[k]}</span> {fmt(b)} → {fmt(a)}
            {d ? <span className={k === "ISSUES" ? (d > 0 ? " text-rose-700" : " text-emerald-700") : " text-slate-600"}> ({d > 0 ? "+" : ""}{d.toLocaleString()})</span> : null}
          </span>
        );
      })}
    </div>
  );
}
