import { useEffect, useMemo, useState } from "react";
import { Sparkles, Coins, Gauge, ArrowDownToLine, ExternalLink, AlertTriangle, ChevronDown } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime, fmtNum, fmtRelative, fmtUsd } from "../lib/format";
import type { AiAnalysis, AnalysesStats } from "../lib/types";
import { KPI } from "../components/KPI";
import { Drawer, Field, Section } from "../components/Drawer";
import { useNav } from "../lib/nav";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";

// ---------------------------------------------------------------------------
// AI Analyses
// ---------------------------------------------------------------------------
// Two data paths on purpose:
//   - KPIs + cost breakdown come from /api/analyses/stats, an exact SQL
//     aggregate over every matching row. PostgREST caps a select at 1000
//     rows, so summing the list client-side read "1000 analyses / $4.47"
//     against a real $197 all-time.
//   - The table is the newest page (≤1000) with a "Load more" cursor.
//
// "kind" on the row is coarse (per_shipment / other / …); the heavy-model
// runs all live under other + metadata.subkind, so the filter and the badge
// work on kind:subkind and each subkind gets a human label + a one-line
// summary pulled from its own payload.

type KindKey = string; // "" | "per_shipment" | "other" | "other:task_triage" | …

const KIND_OPTIONS: { value: KindKey; label: string }[] = [
  { value: "", label: "All kinds" },
  { value: "per_shipment", label: "Per-shipment analysis" },
  { value: "other:plain_summary", label: "Plain-English brief (drawer)" },
  { value: "other:task_triage", label: "Task triage (Tasks v2)" },
  { value: "other:daily_summary", label: "Daily exec summary" },
  { value: "other:email_draft_carrier", label: "Email draft — carrier" },
  { value: "other:email_draft_customer", label: "Email draft — customer" },
  { value: "other:email_draft_carrier_group", label: "Email draft — carrier group" },
  { value: "other:email_draft_customer_group", label: "Email draft — customer group" },
  { value: "summary", label: "Executive summary (legacy)" },
  { value: "gp_audit", label: "GP audit" },
  { value: "invoice_audit", label: "Invoice audit" },
  { value: "other", label: "Other (all)" },
];

const WINDOWS: { value: number | null; label: string }[] = [
  { value: 1, label: "Last 24h" }, { value: 7, label: "Last 7 days" }, { value: 30, label: "Last 30 days" }, { value: null, label: "All time" },
];

const SUBKIND_LABEL: Record<string, { label: string; cls: string }> = {
  plain_summary:               { label: "Plain brief",     cls: "bg-emerald-100 text-emerald-800 ring-emerald-200" },
  task_triage:                 { label: "Task triage",     cls: "bg-violet-100 text-violet-800 ring-violet-200" },
  daily_summary:               { label: "Daily brief",     cls: "bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200" },
  email_draft_carrier:         { label: "Email · carrier", cls: "bg-amber-100 text-amber-800 ring-amber-200" },
  email_draft_customer:        { label: "Email · customer", cls: "bg-amber-100 text-amber-800 ring-amber-200" },
  email_draft_carrier_group:   { label: "Email · carrier group", cls: "bg-amber-100 text-amber-800 ring-amber-200" },
  email_draft_customer_group:  { label: "Email · customer group", cls: "bg-amber-100 text-amber-800 ring-amber-200" },
};
const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  per_shipment:  { label: "Per-shipment", cls: "bg-sky-100 text-sky-800 ring-sky-200" },
  summary:       { label: "Summary",      cls: "bg-violet-100 text-violet-800 ring-violet-200" },
  gp_audit:      { label: "GP audit",     cls: "bg-emerald-100 text-emerald-800 ring-emerald-200" },
  invoice_audit: { label: "Invoice audit", cls: "bg-amber-100 text-amber-800 ring-amber-200" },
  other:         { label: "Other",        cls: "bg-slate-100 text-slate-700 ring-slate-200" },
};

function subkindOf(a: AiAnalysis): string {
  const m = a.metadata as { subkind?: unknown } | null;
  return typeof m?.subkind === "string" ? m.subkind : "";
}
function kindLabel(a: AiAnalysis) {
  return SUBKIND_LABEL[subkindOf(a)] || KIND_LABEL[a.kind] || KIND_LABEL.other;
}
function labelForKey(kind: string, subkind: string) {
  return (subkind && SUBKIND_LABEL[subkind]?.label) || KIND_LABEL[kind]?.label || `${kind}${subkind ? `:${subkind}` : ""}`;
}

// One line for the table when the row has no per-shipment issue: pulled
// from each payload's own shape.
function summaryLine(a: AiAnalysis): string {
  if (a.issue) return a.issue;
  const sk = subkindOf(a);
  const text = a.response_text || "";
  const json = (() => { try { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } })() as Record<string, unknown> | null;
  const meta = (a.metadata || {}) as Record<string, unknown>;
  switch (sk) {
    case "plain_summary": return typeof json?.headline === "string" ? json.headline : "Plain-English brief";
    case "task_triage": {
      const pq = Array.isArray(json?.priority_queue) ? json.priority_queue.length : null;
      const cc = Array.isArray(json?.close_candidates) ? json.close_candidates.length : null;
      const summary = typeof json?.summary === "string" ? json.summary : "";
      return `Triage over ${meta.count ?? "?"} tasks (${meta.scope ?? "all"})${pq !== null ? ` — ${pq} to work first, ${cc ?? 0} to dismiss` : ""}${summary ? `: ${summary}` : ""}`;
    }
    case "daily_summary": {
      const first = text.split("\n").find((l) => l.startsWith("# "))?.replace(/^#\s*/, "");
      const c = (meta.counts || {}) as Record<string, unknown>;
      return `${first || "Daily operations brief"} — ${c.active ?? "?"} active, ${c.created ?? "?"} created, ${c.completed ?? "?"} completed`;
    }
    case "email_draft_carrier": case "email_draft_customer": case "email_draft_carrier_group": case "email_draft_customer_group":
      return typeof json?.subject === "string" ? `Subject: ${json.subject}` : "Email draft";
    default:
      return a.error ? `Error: ${a.error}` : (text.slice(0, 160) || "—");
  }
}

export function AnalysesPage() {
  const nav = useNav();
  const [rows, setRows] = useState<AiAnalysis[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kindKey, setKindKey] = useState<KindKey>("");
  const [days, setDays] = useState<number | null>(7);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<AiAnalysis | null>(null);
  const [stats, setStats] = useState<AnalysesStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  const [kind, subkind] = useMemo(() => {
    const [k, s] = kindKey.split(":");
    return [k || undefined, s || undefined] as [string | undefined, string | undefined];
  }, [kindKey]);

  async function loadPage(reset: boolean) {
    if (reset) { setLoading(true); setErr(null); } else setLoadingMore(true);
    try {
      const r = await api.analyses.list({ limit: 500, kind, subkind, before: reset ? undefined : nextBefore || undefined });
      setRows((prev) => (reset ? r.data : [...prev, ...r.data]));
      setNextBefore(r.next_before ?? null);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); setLoadingMore(false); }
  }
  async function loadStats() {
    setStatsErr(null);
    try { setStats((await api.analyses.stats({ kind, subkind, days: days ?? undefined })).stats); }
    catch (e) { setStatsErr((e as Error).message); }
  }
  useEffect(() => { void loadPage(true); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindKey]);
  useEffect(() => { void loadStats(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindKey, days]);

  const filtered = useMemo(() => {
    if (!q) return rows;
    const s = q.toLowerCase();
    return rows.filter((r) =>
      [r.tracking_number, r.issue, r.recommendation, r.response_text, r.model, subkindOf(r)]
        .map((x) => (x || "").toLowerCase()).join(" ").includes(s));
  }, [rows, q]);

  const windowLabel = WINDOWS.find((w) => w.value === days)?.label || "";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-slate-500">
          Exact totals over every analysis {windowLabel.toLowerCase()}{kindKey ? ` · ${KIND_OPTIONS.find((o) => o.value === kindKey)?.label}` : ""}
          {stats?.errors ? <span className="ml-2 inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />{stats.errors} failed call{stats.errors === 1 ? "" : "s"}</span> : null}
        </div>
        <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white overflow-hidden">
          {WINDOWS.map((w) => (
            <button key={String(w.value)} onClick={() => setDays(w.value)} className={`px-3 py-1.5 text-xs ${days === w.value ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{w.label}</button>
          ))}
        </div>
      </div>
      {statsErr ? <ErrorBlock compact>{statsErr}</ErrorBlock> : null}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Analyses" value={stats ? fmtNum(stats.count) : "…"} icon={Sparkles} tone="brand" hint={stats?.last_at ? `latest ${fmtRelative(stats.last_at)}` : undefined} />
        <KPI label="Total cost" value={stats ? `$${Number(stats.cost_usd).toFixed(2)}` : "…"} icon={Coins} tone="warn" hint={stats && stats.count ? `${fmtUsd(Number(stats.cost_usd) / stats.count)} per call` : undefined} />
        <KPI label="Tokens (in/out)" value={stats ? `${fmtNum(stats.input_tokens)} / ${fmtNum(stats.output_tokens)}` : "…"} icon={ArrowDownToLine} />
        <KPI label="Avg latency" value={stats ? `${fmtNum(stats.avg_duration_ms)} ms` : "…"} icon={Gauge} />
      </div>

      {/* Cost by kind — where the money goes in this window. */}
      {stats?.by_kind?.length ? (
        <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
          <button onClick={() => setBreakdownOpen((v) => !v)} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left">
            <ChevronDown className={`h-4 w-4 text-slate-400 transition ${breakdownOpen ? "" : "-rotate-90"}`} />
            <span className="font-medium text-slate-800">Cost by kind</span>
            <span className="text-xs text-slate-500">{stats.by_kind.length} kinds · top: {labelForKey(stats.by_kind[0].kind, stats.by_kind[0].subkind)} {fmtUsd(stats.by_kind[0].cost_usd)}</span>
          </button>
          {breakdownOpen ? (
            <table className="w-full text-sm border-t border-slate-100">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr><th className="text-left px-4 py-2 font-medium">Kind</th><th className="text-right px-4 py-2 font-medium">Calls</th><th className="text-right px-4 py-2 font-medium">Cost</th><th className="text-right px-4 py-2 font-medium">Per call</th><th className="text-right px-4 py-2 font-medium">Share</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stats.by_kind.map((k) => (
                  <tr key={`${k.kind}:${k.subkind}`} className="hover:bg-slate-50 cursor-pointer" onClick={() => setKindKey(k.subkind ? `${k.kind}:${k.subkind}` : k.kind)}>
                    <td className="px-4 py-2">{labelForKey(k.kind, k.subkind)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtNum(k.count)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtUsd(k.cost_usd)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{k.count ? fmtUsd(k.cost_usd / k.count) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{stats.cost_usd ? `${Math.round((k.cost_usd / Number(stats.cost_usd)) * 100)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-100 flex gap-2">
          <input
            className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm"
            placeholder="Search tracking, issue, recommendation, response…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select className="px-3 py-2 rounded-lg border border-slate-300 text-sm" value={kindKey} onChange={(e) => setKindKey(e.target.value)}>
            {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={() => { void loadPage(true); void loadStats(); }} className="px-3 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800">Refresh</button>
        </div>
        {err ? <div className="p-4 border-b border-rose-200"><ErrorBlock compact>{err}</ErrorBlock></div> : null}
        <div className="overflow-auto max-h-[calc(100vh-420px)]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 sticky top-0">
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Tracking</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Summary</th>
                <th className="px-4 py-2.5 font-medium text-right">Cost</th>
                <th className="px-4 py-2.5 font-medium text-right">Tokens</th>
                <th className="px-4 py-2.5 font-medium text-right w-12">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && rows.length === 0 ? (
                <LoadingState variant="row" colSpan={8} />
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="p-8 text-center text-slate-500">No analyses match.</td></tr>
              ) : filtered.map((a) => {
                const kl = kindLabel(a);
                return (
                  <tr key={a.id} className={`hover:bg-sky-50/50 cursor-pointer ${a.error ? "bg-rose-50/40" : ""}`} onClick={() => setSelected(a)}>
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap" title={fmtDateTime(a.created_at)}>{fmtRelative(a.created_at)}</td>
                    <td className="px-4 py-2.5"><span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 whitespace-nowrap ${kl.cls}`}>{kl.label}</span></td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {a.shipment_uuid ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); nav.openShipment(a.shipment_uuid as string); }}
                          className="text-sky-700 hover:text-sky-900 hover:underline font-medium"
                          title="Open this shipment in the Tracking tab"
                        >
                          {a.tracking_number || "(no tracking #)"}
                        </button>
                      ) : (a.tracking_number || <span className="text-slate-400">board</span>)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 text-xs whitespace-nowrap">{a.model}</td>
                    <td className="px-4 py-2.5 max-w-[420px] truncate" title={summaryLine(a)}>{summaryLine(a)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmtUsd(a.cost_usd)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-500 tabular-nums">{fmtNum(a.input_tokens ?? 0)}/{fmtNum(a.output_tokens ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {a.shipment_uuid ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); nav.openShipment(a.shipment_uuid as string); }}
                          className="p-1.5 text-slate-400 hover:text-sky-700 hover:bg-sky-50 rounded-md"
                          title="Open shipment drawer"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span>Showing {fmtNum(filtered.length)}{q ? ` of ${fmtNum(rows.length)} loaded` : ""}{stats ? ` · ${fmtNum(stats.count)} total ${windowLabel.toLowerCase()}` : ""}</span>
          {nextBefore ? (
            <button onClick={() => loadPage(false)} disabled={loadingMore} className="px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {loadingMore ? "Loading…" : "Load 500 more"}
            </button>
          ) : <span>End of list</span>}
        </div>
      </div>

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${kindLabel(selected).label} · ${selected.tracking_number || "board-level"}` : ""}
        subtitle={selected ? fmtDateTime(selected.created_at) : undefined}
      >
        {selected ? (
          <>
            {selected.shipment_uuid ? (
              <div className="flex justify-end mb-4">
                <button
                  onClick={() => { nav.openShipment(selected.shipment_uuid as string); setSelected(null); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
                >
                  <ExternalLink className="h-4 w-4" /> View shipment
                </button>
              </div>
            ) : null}
            <Section title="Summary">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Model">{selected.model}</Field>
                <Field label="Duration">{selected.duration_ms ? `${fmtNum(selected.duration_ms)} ms` : "—"}</Field>
                <Field label="Cost">{fmtUsd(selected.cost_usd)}</Field>
                <Field label="Tokens (in/out)">{fmtNum(selected.input_tokens ?? 0)} / {fmtNum(selected.output_tokens ?? 0)}</Field>
                <Field label="Action">{selected.action_required || "—"}</Field>
                <Field label="Requested by">{selected.user_email || selected.source || "—"}</Field>
              </div>
            </Section>
            <Section title={selected.issue ? "Issue & recommendation" : "What this run produced"}>
              {selected.issue ? (
                <>
                  <Field label="Issue">{selected.issue}</Field>
                  <div className="h-3" />
                  <Field label="Recommendation">{selected.recommendation}</Field>
                </>
              ) : <div className="text-sm text-slate-700">{summaryLine(selected)}</div>}
            </Section>
            <Section title="Response">
              <pre className="text-xs bg-slate-900 text-slate-100 p-3 rounded-lg whitespace-pre-wrap max-h-64 overflow-auto">{selected.response_text || ""}</pre>
            </Section>
            <Section title="Prompt">
              <Field label="System">{selected.system_prompt}</Field>
              <div className="h-3" />
              <Field label="User"><pre className="text-xs bg-slate-50 ring-1 ring-slate-200 p-3 rounded-lg whitespace-pre-wrap max-h-64 overflow-auto">{selected.user_message || ""}</pre></Field>
            </Section>
            {selected.error ? (
              <Section title="Error">
                <ErrorBlock compact>{selected.error}</ErrorBlock>
              </Section>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
