// Daily executive summary panel (heavy-model brief over the last N hours).
import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, FileText, Loader2, Wand2 } from "lucide-react";
import type { DailySummaryResult, TaskBoardRow } from "../../lib/types";
import { fmtDateTime, fmtRelative, fmtUsd } from "../../lib/format";
import { ErrorBlock } from "../ErrorBlock";
import { MarkdownLite } from "./MarkdownLite";

export function DailySummaryPanel({ result, busy, error, open, onToggle, onRun, rows, onOpenTask }: {
  result: DailySummaryResult | null; busy: boolean; error: string | null; open: boolean; onToggle: () => void;
  onRun: (hours: number) => void; rows: TaskBoardRow[]; onOpenTask: (taskId: string) => void;
}) {
  const [hours, setHours] = useState(24);
  const [copied, setCopied] = useState(false);
  const digest = result?.digest ?? null;
  // Tracking numbers on the active board → task id, so numbers cited in the
  // brief become links into the drawer.
  const trackingIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) { const tn = (r.shipment?.tracking_number || r.task.tracking_number || "").trim(); if (tn && !m.has(tn)) m.set(tn, r.task.id); }
    return m;
  }, [rows]);
  async function copy() {
    if (!result?.markdown) return;
    try { await navigator.clipboard.writeText(result.markdown); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }
  const chips = digest ? [
    ["Created", digest.tasks.created_count], ["Completed", digest.tasks.completed_count], ["Dismissed", digest.tasks.dismissed_count],
    ["Active", digest.board.active], ["Needs attention", digest.board.needs_attention_count], ["Likely resolved", digest.board.likely_resolved_count],
    ["Scraped", digest.shipments.scraped_in_window], ["Newly flagged", digest.shipments.newly_flagged_count],
    ["AI spend", fmtUsd(digest.ai.cost_usd)],
  ] as [string, string | number][] : [];
  return (
    <div className="rounded-2xl ring-1 ring-slate-200 bg-white shadow-sm mb-4">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={onToggle} className="flex items-center gap-2 text-left min-w-0">
          {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
          <FileText className="h-4 w-4 text-slate-700" />
          <span className="font-semibold text-slate-900">Daily exec summary</span>
          {result?.created_at ? (
            <span className="text-xs text-slate-500 truncate">
              {fmtRelative(result.created_at)} · {result.model || "model"}{result.cost_usd != null ? ` · ${fmtUsd(result.cost_usd)}` : ""}{digest ? ` · ${digest.window.hours}h window` : ""}{result.user_email ? ` · by ${result.user_email}` : ""}
            </span>
          ) : <span className="text-xs text-slate-500">Not generated yet</span>}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="rounded-md border border-slate-200 px-2 py-1 text-xs bg-white" aria-label="Window">
            <option value={24}>Last 24h</option>
            <option value={48}>Last 48h</option>
            <option value={72}>Last 72h</option>
            <option value={168}>Last 7 days</option>
          </select>
          <button onClick={() => onRun(hours)} disabled={busy} className="text-xs inline-flex items-center gap-1 rounded-md bg-violet-600 text-white px-2.5 py-1.5 hover:bg-violet-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />} {busy ? "Writing…" : result?.markdown ? "Regenerate" : "Generate"}
          </button>
          {result?.markdown ? (
            <button onClick={copy} className="text-xs inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2.5 py-1.5 hover:bg-slate-50 text-slate-700" title="Copy as Markdown (paste into Teams / email)">
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="px-4 pb-4">
          {error ? <div className="mb-3"><ErrorBlock>{error}</ErrorBlock></div> : null}
          {busy ? <div className="text-xs text-violet-700 mb-3 inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Collecting the day's digest and writing a ~1,200-word brief with the heavy model. This takes a minute or two.</div> : null}
          {chips.length ? (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {chips.map(([label, value]) => (
                <span key={label} className="inline-flex items-baseline gap-1 rounded-md bg-slate-50 ring-1 ring-slate-200 px-2 py-1 text-xs"><span className="text-slate-500">{label}</span><span className="font-semibold text-slate-900 tabular-nums">{value}</span></span>
              ))}
              {digest?.window ? <span className="text-[11px] text-slate-400 self-center">{fmtDateTime(digest.window.from)} → {fmtDateTime(digest.window.to)}</span> : null}
            </div>
          ) : null}
          {result?.markdown ? (
            <MarkdownLite text={result.markdown} trackingIndex={trackingIndex} onOpenTask={onOpenTask} />
          ) : !busy ? (
            <div className="text-sm text-slate-600">
              Generates a detailed operations brief for the director: headline, KPI table, what moved today, live exposures ranked with next actions, carrier and customer hotspots, per-operator throughput, data health, tomorrow's plan and open questions. Copy it straight into Teams.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
