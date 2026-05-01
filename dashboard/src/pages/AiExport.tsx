import { useEffect, useMemo, useState } from "react";
import {
  BarChart3, Coins, Sparkles, Gauge, ArrowDownToLine, ThumbsUp, ThumbsDown,
  CircleDashed, RefreshCw, Download, FileJson, Users as UsersIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { fmtNum, fmtUsd } from "../lib/format";
import type { AiAnalysis } from "../lib/types";
import { KPI } from "../components/KPI";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";

// CSV columns we surface in the export. Keeping this list explicit
// (vs. dumping the whole row) lets us flatten metadata and keep the
// header stable across schema changes. Column order matches what the
// finance + prompt-engineering folks asked for: time, identity, shape,
// then cost/perf, then operator feedback.
const EXPORT_COLUMNS: Array<{ key: keyof AiAnalysis | "rating_emoji"; label: string }> = [
  { key: "created_at", label: "created_at" },
  { key: "id", label: "id" },
  { key: "kind", label: "kind" },
  { key: "model", label: "model" },
  { key: "tracking_number", label: "tracking_number" },
  { key: "shipment_uuid", label: "shipment_uuid" },
  { key: "user_email", label: "user_email" },
  { key: "source", label: "source" },
  { key: "input_tokens", label: "input_tokens" },
  { key: "output_tokens", label: "output_tokens" },
  { key: "cost_usd", label: "cost_usd" },
  { key: "duration_ms", label: "duration_ms" },
  { key: "action_required", label: "action_required" },
  { key: "issue", label: "issue" },
  { key: "recommendation", label: "recommendation" },
  { key: "rating", label: "rating" },
  { key: "rating_emoji", label: "rating_emoji" },
  { key: "rating_reason", label: "rating_reason" },
  { key: "rated_by", label: "rated_by" },
  { key: "rated_at", label: "rated_at" },
  { key: "error", label: "error" },
];

function toCsvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  // RFC4180: wrap in quotes if the value contains comma / quote /
  // newline; embedded quotes are doubled.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(a: AiAnalysis): string {
  return EXPORT_COLUMNS.map((col) => {
    if (col.key === "rating_emoji") {
      return toCsvCell(a.rating === "up" ? "👍" : a.rating === "down" ? "👎" : "");
    }
    return toCsvCell(a[col.key as keyof AiAnalysis]);
  }).join(",");
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Default range: last 30 days, expressed in local time so the date
// inputs match what the operator sees in the OS clock.
function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All kinds" },
  { value: "per_shipment", label: "Per-shipment" },
  { value: "summary", label: "Run summary" },
  { value: "gp_audit", label: "GP audit" },
  { value: "invoice_audit", label: "Invoice audit" },
  { value: "other", label: "Other (drafts, etc.)" },
];

const RATING_OPTIONS: Array<{ value: "" | "up" | "down" | "unrated"; label: string }> = [
  { value: "", label: "Any rating" },
  { value: "up", label: "👍 Rated good" },
  { value: "down", label: "👎 Needs work" },
  { value: "unrated", label: "Unrated" },
];

export function AiExportPage() {
  const initial = defaultRange();
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [kind, setKind] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [user, setUser] = useState<string>("");
  const [rating, setRating] = useState<"" | "up" | "down" | "unrated">("");
  const [rows, setRows] = useState<AiAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // The same boundary trick the audits page uses — `to` is end-of-day
  // local, `from` is start-of-day local, both converted to ISO before
  // hitting the server. Without this, a user-typed "2026-04-30" range
  // would silently exclude anything created later that day.
  const range = useMemo(() => {
    const fromIso = from ? new Date(from + "T00:00:00").toISOString() : undefined;
    const toIso = to ? new Date(to + "T23:59:59.999").toISOString() : undefined;
    return { fromIso, toIso };
  }, [from, to]);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.analyses.list({
        limit: 5000,
        kind: kind || undefined,
        model: model || undefined,
        user_email: user || undefined,
        rating: rating || undefined,
        from: range.fromIso,
        to: range.toIso,
      });
      setRows(r.data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    api.analyses.list({
      limit: 5000,
      kind: kind || undefined,
      model: model || undefined,
      user_email: user || undefined,
      rating: rating || undefined,
      from: range.fromIso,
      to: range.toIso,
    })
      .then((r) => { if (!cancelled) setRows(r.data); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind, model, user, rating, range.fromIso, range.toIso]);

  const totals = useMemo(() => {
    const cost = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const inTok = rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
    const outTok = rows.reduce((s, r) => s + (r.output_tokens || 0), 0);
    const dur = rows.filter((r) => r.duration_ms != null);
    const avgMs = dur.length ? Math.round(dur.reduce((s, r) => s + (r.duration_ms || 0), 0) / dur.length) : 0;
    const up = rows.filter((r) => r.rating === "up").length;
    const down = rows.filter((r) => r.rating === "down").length;
    const unrated = rows.length - up - down;
    return { cost, inTok, outTok, avgMs, up, down, unrated };
  }, [rows]);

  type Group = { key: string; runs: number; cost: number; in: number; out: number; up: number; down: number };
  function groupBy(getKey: (a: AiAnalysis) => string | null | undefined): Group[] {
    const map = new Map<string, Group>();
    for (const a of rows) {
      const k = (getKey(a) ?? "—") || "—";
      let g = map.get(k);
      if (!g) {
        g = { key: k, runs: 0, cost: 0, in: 0, out: 0, up: 0, down: 0 };
        map.set(k, g);
      }
      g.runs += 1;
      g.cost += Number(a.cost_usd) || 0;
      g.in += a.input_tokens || 0;
      g.out += a.output_tokens || 0;
      if (a.rating === "up") g.up += 1;
      if (a.rating === "down") g.down += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
  }

  const byKind = useMemo(() => groupBy((a) => a.kind), [rows]);
  const byModel = useMemo(() => groupBy((a) => a.model), [rows]);
  const byUser = useMemo(() => groupBy((a) => a.user_email).slice(0, 10), [rows]);

  // Available models for the model filter dropdown — pulled from the
  // current row set so the operator only sees models that actually
  // appear in the slice they're looking at.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.model) set.add(r.model);
    return Array.from(set).sort();
  }, [rows]);

  function exportCsv() {
    const header = EXPORT_COLUMNS.map((c) => c.label).join(",");
    const body = rows.map(rowToCsv).join("\n");
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`ai-analyses-${stamp}.csv`, header + "\n" + body + "\n", "text/csv;charset=utf-8");
  }

  function exportJson() {
    const stamp = new Date().toISOString().slice(0, 10);
    // NDJSON — one row per line. Easier to stream into BigQuery /
    // pandas / whatever than a giant array, and `jq` handles it
    // natively.
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    downloadFile(`ai-analyses-${stamp}.ndjson`, body + "\n", "application/x-ndjson");
  }

  function resetFilters() {
    const d = defaultRange();
    setFrom(d.from); setTo(d.to);
    setKind(""); setModel(""); setUser(""); setRating("");
  }

  const ratedTotal = totals.up + totals.down;
  const goodPct = ratedTotal ? Math.round((totals.up / ratedTotal) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-slate-700" /> AI analytics & export
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Slice every Claude call this team has made — by date, kind, model, operator, or rating —
            then download the slice as CSV or NDJSON for finance review and prompt iteration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-2 text-sm rounded-lg bg-white ring-1 ring-slate-200 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
            title="Re-run with current filters"
          >
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />
            Refresh
          </button>
          <button
            onClick={exportCsv}
            disabled={!rows.length}
            className="px-3 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
            title="Download the filtered slice as CSV"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
          <button
            onClick={exportJson}
            disabled={!rows.length}
            className="px-3 py-2 text-sm rounded-lg bg-white ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
            title="Download the filtered slice as NDJSON (one row per line)"
          >
            <FileJson className="h-4 w-4" /> Export JSON
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span className="font-medium">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span className="font-medium">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span className="font-medium">Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm"
            >
              {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span className="font-medium">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm"
            >
              <option value="">All models</option>
              {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span className="font-medium">Rating</span>
            <select
              value={rating}
              onChange={(e) => setRating(e.target.value as typeof rating)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm"
            >
              {RATING_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span className="font-medium">Operator email</span>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="alice@freightpop.com"
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm"
            />
          </label>
        </div>
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
          <div className="text-xs text-slate-500">
            {loading ? "Loading…" : `${fmtNum(rows.length)} row${rows.length === 1 ? "" : "s"} match current filters`}
            {rows.length === 5000 ? <span className="text-amber-600 ml-2">· capped at 5000 — narrow the date range to see more</span> : null}
          </div>
          <button
            onClick={resetFilters}
            className="text-xs text-slate-500 hover:text-slate-900 hover:underline"
          >Reset filters</button>
        </div>
      </div>

      {err ? <ErrorBlock>{err}</ErrorBlock> : null}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <KPI label="Analyses" value={fmtNum(rows.length)} icon={Sparkles} tone="brand" />
        <KPI label="Total cost" value={`$${totals.cost.toFixed(4)}`} icon={Coins} tone="warn" />
        <KPI label="Tokens in" value={fmtNum(totals.inTok)} icon={ArrowDownToLine} />
        <KPI label="Tokens out" value={fmtNum(totals.outTok)} icon={ArrowDownToLine} />
        <KPI label="Avg latency" value={`${totals.avgMs} ms`} icon={Gauge} />
        <KPI
          label="Rated good"
          value={`${totals.up}${ratedTotal ? ` (${goodPct}%)` : ""}`}
          icon={ThumbsUp}
          tone="success"
          hint={ratedTotal ? `of ${ratedTotal} rated` : "no ratings yet"}
        />
        <KPI label="Needs work" value={totals.down} icon={ThumbsDown} tone="danger" hint={`${totals.unrated} unrated`} />
      </div>

      {/* Breakdown tables */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <BreakdownCard title="By kind" rows={byKind} totalCost={totals.cost} icon={CircleDashed} loading={loading} />
        <BreakdownCard title="By model" rows={byModel} totalCost={totals.cost} icon={Sparkles} loading={loading} />
        <BreakdownCard title="Top operators (cost)" rows={byUser} totalCost={totals.cost} icon={UsersIcon} loading={loading} />
      </div>
    </div>
  );
}

function BreakdownCard({
  title, rows, totalCost, icon: Icon, loading,
}: {
  title: string;
  rows: Array<{ key: string; runs: number; cost: number; in: number; out: number; up: number; down: number }>;
  totalCost: number;
  icon: typeof Sparkles;
  loading: boolean;
}) {
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <Icon className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </div>
      <div className="overflow-auto max-h-80">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/80 sticky top-0">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium text-right">Runs</th>
              <th className="px-3 py-2 font-medium text-right">Cost</th>
              <th className="px-3 py-2 font-medium text-right">% cost</th>
              <th className="px-3 py-2 font-medium text-right">👍 / 👎</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && rows.length === 0 ? (
              <LoadingState variant="row" colSpan={5} />
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400 text-xs">No rows match the filter.</td></tr>
            ) : rows.map((g) => {
              const pct = totalCost ? (g.cost / totalCost) * 100 : 0;
              return (
                <tr key={g.key}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700 truncate max-w-[180px]" title={g.key}>{g.key}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtNum(g.runs)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(g.cost)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{pct.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    <span className="text-emerald-700">{g.up}</span>
                    <span className="text-slate-300 mx-1">/</span>
                    <span className="text-rose-700">{g.down}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
