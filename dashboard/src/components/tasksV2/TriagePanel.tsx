// AI triage panel: work-first queue, probably-moot tasks, batches.
import type { ReactNode } from "react";
import { AlertTriangle, Ban, ChevronDown, ChevronRight, ExternalLink, Layers, Loader2, Play, Sparkles } from "lucide-react";
import type { TaskBoardRow, TaskTriage, TaskTriageResult } from "../../lib/types";
import { fmtRelative, fmtUsd } from "../../lib/format";
import { ErrorBlock } from "../ErrorBlock";
import { DISPOSITION_LABEL, Pill, SEGMENT_CLS, SEGMENT_SHORT, TrackingLink, isActive, shortTitle } from "./shared";

export function TriagePanel({ result, busy, error, open, onToggle, rowById, people, onOpen, onStart, onDismissOne, onDismissAll, onSelectBatch }: {
  result: TaskTriageResult | null; busy: boolean; error: string | null; open: boolean; onToggle: () => void;
  rowById: Map<string, TaskBoardRow>; people: Record<string, string>;
  onOpen: (id: string) => void; onStart: (id: string) => void;
  onDismissOne: (id: string, disposition: string, reason: string) => void; onDismissAll: () => void;
  onSelectBatch: (ids: string[]) => void;
}) {
  const tri: TaskTriage | null = result?.triage ?? null;
  const has = !!tri && (tri.priority_queue.length || tri.close_candidates.length || tri.batches.length || tri.summary);
  const liveClose = (tri?.close_candidates ?? []).filter((c) => { const r = rowById.get(c.task_id); return r && isActive(r.task.status); });
  return (
    <div className="rounded-2xl ring-1 ring-violet-200 bg-gradient-to-br from-violet-50/70 to-white shadow-sm mb-4">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-violet-500" /> : <ChevronRight className="h-4 w-4 text-violet-500" />}
        <Sparkles className="h-4 w-4 text-violet-600" />
        <span className="font-semibold text-slate-900">AI triage</span>
        {result?.created_at ? (
          <span className="text-xs text-slate-500">
            {fmtRelative(result.created_at)} · {result.model || "model"} · {result.count ?? "?"} tasks{result.cost_usd != null ? ` · ${fmtUsd(result.cost_usd)}` : ""}{result.scope ? ` · ${result.scope}` : ""}
          </span>
        ) : <span className="text-xs text-slate-500">No triage run yet</span>}
        {busy ? <span className="ml-auto text-xs text-violet-700 inline-flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running the heavy model over the board… this can take a minute</span> : null}
      </button>
      {open ? (
        <div className="px-4 pb-4">
          {error ? <div className="mb-3"><ErrorBlock>{error}</ErrorBlock></div> : null}
          {!has && !busy ? (
            <div className="text-sm text-slate-600">
              Run <span className="font-medium">AI triage board</span> to have the heavy model rank what to work first, flag tasks that are probably moot, and batch tasks that should be handled in one call.
            </div>
          ) : null}
          {tri?.summary ? <p className="text-sm text-slate-800 mb-3 leading-relaxed">{tri.summary}</p> : null}
          {tri?.risks?.length ? (
            <ul className="mb-3 space-y-1">
              {tri.risks.map((r, i) => <li key={i} className="text-xs text-amber-900 bg-amber-50 ring-1 ring-amber-200 rounded-md px-2 py-1 inline-flex items-start gap-1.5 mr-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{r}</li>)}
            </ul>
          ) : null}
          {has ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <TriageColumn title={`Work first (${tri!.priority_queue.length})`} tone="violet">
                {tri!.priority_queue.map((p) => {
                  const r = rowById.get(p.task_id);
                  if (!r) return null;
                  return (
                    <div key={p.task_id} className="rounded-lg bg-white ring-1 ring-slate-200 p-2.5 text-xs">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Pill cls="bg-violet-600 text-white ring-violet-600">#{p.rank}</Pill>
                        <Pill cls={SEGMENT_CLS[r.seg.segment]}>{SEGMENT_SHORT[r.seg.segment]}</Pill>
                        <TrackingLink tracking={r.shipment?.tracking_number} carrier={r.shipment?.carrier_name || r.shipment?.carrier} onOpen={() => onOpen(p.task_id)} />
                        <span className="text-slate-500 truncate">{r.shipment?.customer_name || ""}</span>
                      </div>
                      <div className="text-slate-800 font-medium line-clamp-2">{shortTitle(r.task.title)}</div>
                      {p.reason ? <div className="text-slate-600 mt-1"><span className="font-medium text-slate-700">Why:</span> {p.reason}</div> : null}
                      {p.first_action ? <div className="text-slate-600 mt-0.5"><span className="font-medium text-slate-700">First:</span> {p.first_action}</div> : null}
                      <div className="flex items-center gap-1 mt-1.5">
                        {r.task.status === "open" ? <button onClick={() => onStart(p.task_id)} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 text-white px-2 py-1 hover:bg-indigo-700"><Play className="h-3 w-3" /> Start</button> : null}
                        <button onClick={() => onOpen(p.task_id)} className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><ExternalLink className="h-3 w-3" /> Open</button>
                        <span className="ml-auto text-slate-400">{r.task.assigned_to ? (people[r.task.assigned_to] || r.task.assigned_to) : "unassigned"}</span>
                      </div>
                    </div>
                  );
                })}
              </TriageColumn>
              <TriageColumn
                title={`Probably moot (${liveClose.length})`}
                tone="emerald"
                action={liveClose.length ? <button onClick={onDismissAll} className="text-xs inline-flex items-center gap-1 rounded-md bg-emerald-600 text-white px-2 py-1 hover:bg-emerald-700"><Ban className="h-3 w-3" /> Dismiss all {liveClose.length}</button> : undefined}
              >
                {liveClose.map((c) => {
                  const r = rowById.get(c.task_id)!;
                  return (
                    <div key={c.task_id} className="rounded-lg bg-white ring-1 ring-slate-200 p-2.5 text-xs">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Pill cls="bg-emerald-100 text-emerald-800 ring-emerald-200">{DISPOSITION_LABEL[c.disposition] || c.disposition}</Pill>
                        <TrackingLink tracking={r.shipment?.tracking_number} carrier={r.shipment?.carrier_name || r.shipment?.carrier} onOpen={() => onOpen(c.task_id)} />
                        <span className="text-slate-500 truncate">{r.shipment?.customer_name || ""}</span>
                      </div>
                      <div className="text-slate-800 line-clamp-2">{shortTitle(r.task.title)}</div>
                      {c.reason ? <div className="text-slate-600 mt-1">{c.reason}</div> : null}
                      <div className="flex items-center gap-1 mt-1.5">
                        <button onClick={() => onDismissOne(c.task_id, c.disposition, c.reason)} className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><Ban className="h-3 w-3" /> Dismiss</button>
                        <button onClick={() => onOpen(c.task_id)} className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><ExternalLink className="h-3 w-3" /> Check</button>
                      </div>
                    </div>
                  );
                })}
                {tri!.close_candidates.length > liveClose.length ? <div className="text-[11px] text-slate-400">{tri!.close_candidates.length - liveClose.length} already closed since this run.</div> : null}
              </TriageColumn>
              <TriageColumn title={`Work together (${tri!.batches.length})`} tone="sky">
                {tri!.batches.map((b, i) => {
                  const live = b.task_ids.filter((id) => rowById.has(id));
                  return (
                    <div key={i} className="rounded-lg bg-white ring-1 ring-slate-200 p-2.5 text-xs">
                      <div className="font-medium text-slate-800">{b.label} <span className="text-slate-400 font-normal">· {live.length} tasks</span></div>
                      {b.reason ? <div className="text-slate-600 mt-0.5">{b.reason}</div> : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {live.slice(0, 8).map((id) => {
                          const r = rowById.get(id)!;
                          return (
                            <span key={id} className="inline-flex items-center bg-slate-50 ring-1 ring-slate-200 rounded px-1 text-[11px]">
                              <TrackingLink tracking={r.shipment?.tracking_number || id.slice(0, 6)} carrier={r.shipment?.carrier_name || r.shipment?.carrier} onOpen={() => onOpen(id)} />
                            </span>
                          );
                        })}
                        {live.length > 8 ? <span className="text-[11px] text-slate-400">+{live.length - 8}</span> : null}
                      </div>
                      <button onClick={() => onSelectBatch(live)} className="mt-1.5 inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><Layers className="h-3 w-3" /> Select batch</button>
                    </div>
                  );
                })}
              </TriageColumn>
            </div>
          ) : null}
          {result?.truncated ? <div className="text-[11px] text-slate-500 mt-2">Board exceeded the per-run cap; only the first {result.count} tasks were triaged. Narrow to a segment for full coverage.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function TriageColumn({ title, tone, action, children }: { title: string; tone: "violet" | "emerald" | "sky"; action?: ReactNode; children: ReactNode }) {
  const head = tone === "violet" ? "text-violet-800" : tone === "emerald" ? "text-emerald-800" : "text-sky-800";
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className={`text-xs font-semibold uppercase tracking-wide ${head}`}>{title}</div>
        {action}
      </div>
      <div className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-0.5">{children}</div>
    </div>
  );
}
