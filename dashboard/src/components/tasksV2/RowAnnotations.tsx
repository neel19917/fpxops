// Expanded detail under a task row: why the task exists, what the AI
// suggests, what each badge means, and a box to add a note. Everything shown
// comes from the board payload; notes are appended to the shipment's notes
// log (the same log the shipment drawer shows).
import { useState, type ReactNode } from "react";
import { Loader2, StickyNote } from "lucide-react";
import { api } from "../../lib/api";
import type { TaskBoardRow, TaskFlag } from "../../lib/types";
import { fmtDate } from "../../lib/format";
import { FLAG_CLS, Pill, SEGMENT_CLS, SEGMENT_SHORT } from "./shared";

export function RowAnnotations({ row, rank, closeCandidate, staleDays, flagMeta, segmentHelp }: {
  row: TaskBoardRow; rank?: number; closeCandidate: boolean; staleDays: number;
  flagMeta: Map<string, { id: TaskFlag; label: string; tone: string; description: string }>;
  segmentHelp: Record<string, string>;
}) {
  const { task: t, shipment: s, seg } = row;
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function addNote() {
    const body = note.trim();
    if (!body || !s) return;
    setSaving(true); setErr(null);
    try { await api.shipments.addNote(s.id, body); setAdded((a) => [body, ...a]); setNote(""); }
    catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  const conf = s?.action_confidence != null && s.action_confidence !== "" ? Number(s.action_confidence) : null;
  return (
    <div className="grid md:grid-cols-3 gap-4 text-xs text-slate-700">
      <div className="space-y-2">
        <Field label="Why this task exists">{s?.ai_issue || t.description || "No AI finding recorded for this shipment."}</Field>
        <Field label="Suggested next step">
          {s?.ai_recommendation || "—"}
          {s?.action_target || (conf != null && Number.isFinite(conf)) ? (
            <div className="text-[11px] text-slate-400 mt-0.5">
              {s?.action_target ? `Contact: ${s.action_target}` : ""}{s?.action_target && conf != null ? " · " : ""}{conf != null && Number.isFinite(conf) ? `AI confidence ${Math.round(conf * 100)}%` : ""}
            </div>
          ) : null}
        </Field>
        {t.description && s?.ai_issue && t.description !== s.ai_issue ? <Field label="Task details">{t.description}</Field> : null}
      </div>
      <div className="space-y-2">
        <Field label="Latest carrier update">{s?.tracking_comments || "—"}</Field>
        <Field label="Route">{s ? `${s.origin || "?"} → ${s.destination || "?"}` : "—"}</Field>
        <Field label="Dates">
          Task created {fmtDate(t.created_at)}
          {s?.scraped_at ? ` · shipment last scraped ${fmtDate(s.scraped_at)}` : " · shipment never scraped"}
          {s?.delivery_date ? ` · delivered ${fmtDate(s.delivery_date)}` : s?.updated_eta ? ` · ETA ${fmtDate(s.updated_eta)}` : ""}
        </Field>
      </div>
      <div className="space-y-2">
        <Field label="What the badges mean">
          <ul className="space-y-1">
            <li><Pill cls={SEGMENT_CLS[seg.segment]}>{SEGMENT_SHORT[seg.segment]}</Pill> <span className="ml-1">{segmentHelp[seg.segment] || "Task type."}{seg.attempt && seg.attempt > 1 ? ` This is attempt ${seg.attempt}.` : ""}</span></li>
            {seg.flags.map((f) => {
              const m = flagMeta.get(f);
              return <li key={f}><Pill cls={FLAG_CLS[m?.tone || "slate"]}>{m?.label || f}</Pill> <span className="ml-1">{m?.description || ""}{f === "stale" ? ` (no scrape in ${staleDays}+ days)` : ""}</span></li>;
            })}
            {rank !== undefined ? <li><Pill cls="bg-violet-600 text-white ring-violet-600">#{rank}</Pill> <span className="ml-1">Position in the AI triage "work first" list.</span></li> : null}
            {closeCandidate ? <li><Pill cls="bg-emerald-600 text-white ring-emerald-600">AI: close</Pill> <span className="ml-1">AI triage thinks this task is no longer needed. Check, then dismiss.</span></li> : null}
          </ul>
        </Field>
        {s ? (
          <div>
            <div className="text-[11px] uppercase font-semibold text-slate-500 flex items-center gap-1"><StickyNote className="h-3 w-3" /> Add a note</div>
            {added.map((a, i) => <div key={i} className="mt-1 rounded-md bg-amber-50 ring-1 ring-amber-200 px-2 py-1 text-amber-900">{a} <span className="text-amber-700/70">· just now</span></div>)}
            <div className="mt-1 flex items-start gap-1.5">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. Called ABF, redelivery set for Thursday"
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addNote(); }}
                className="flex-1 rounded-lg ring-1 ring-slate-200 p-1.5 outline-none focus:ring-2 focus:ring-violet-400" />
              <button onClick={addNote} disabled={saving || !note.trim()} className="rounded-lg bg-violet-600 text-white px-2.5 py-1.5 hover:bg-violet-700 disabled:opacity-40 inline-flex items-center gap-1">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save
              </button>
            </div>
            {err ? <div className="text-rose-700 mt-1">{err}</div> : <div className="text-[11px] text-slate-400 mt-1">Saved to the shipment's notes. Open the shipment to see earlier notes.</div>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase font-semibold text-slate-500">{label}</div>
      <div className="mt-0.5 leading-relaxed whitespace-pre-wrap break-words">{children}</div>
    </div>
  );
}
