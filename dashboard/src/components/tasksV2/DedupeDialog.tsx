// "Clean up duplicates": when a shipment has several active tasks for the
// same audience (carrier / customer), the newest stays and the older ones
// are cancelled as superseded. Opens on a preview; nothing changes until the
// user confirms. Nothing is deleted.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CopyMinus, Loader2, Mail, X } from "lucide-react";
import { api, type DedupeGroup, type DedupePlan, type DedupeTask } from "../../lib/api";
import type { TaskStatus } from "../../lib/types";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { Pill, STATUS_CLS, STATUS_LABEL, shortTitle } from "./shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function DedupeDialog({ taskIds, onClose, onApplied }: {
  // Check only these tasks. Left out = the whole board.
  taskIds?: string[];
  onClose: () => void;
  onApplied: (result: { superseded: number; ids: string[] }) => void;
}) {
  // The scope is fixed when the dialog opens, so the confirm covers exactly
  // what the preview showed even if the caller's selection changes.
  const scope = useRef(taskIds?.length ? { task_ids: [...taskIds] } : {}).current;
  const scoped = "task_ids" in scope;
  const [plan, setPlan] = useState<DedupePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<NonNullable<DedupePlan["result"]> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api.tasks.v2Dedupe({ dry_run: true, ...scope })
      .then((p) => { if (alive.current) setPlan(p); })
      .catch((e) => { if (alive.current) setError((e as Error).message || "Could not check for duplicates."); })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes, except while the change is being saved.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); if (!applying) onClose(); } }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, applying]);

  const groups = plan?.groups ?? [];
  const count = plan?.supersede_count ?? 0;

  async function apply() {
    if (applying || !count) return;
    setApplying(true); setError(null);
    try {
      const r = await api.tasks.v2Dedupe({ dry_run: false, ...scope });
      const result = r.result ?? { superseded: r.supersede_count, carried_queue: 0, failed: 0, ids: r.groups.flatMap((g) => g.supersede.map((t) => t.id)) };
      onApplied({ superseded: result.superseded, ids: result.ids });
      if (alive.current) setDone(result);
    } catch (e) {
      if (alive.current) setError((e as Error).message || "Could not replace the older tasks.");
    } finally {
      if (alive.current) setApplying(false);
    }
  }

  const close = () => { if (!applying) onClose(); };

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4" onClick={close}>
      <div className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl bg-white shadow-xl ring-1 ring-slate-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="font-semibold text-slate-900 inline-flex items-center gap-2"><CopyMinus className="h-4 w-4 text-slate-500" /> Clean up duplicates</h2>
          <button onClick={close} className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="px-5 pb-1 flex-1 min-h-0 overflow-y-auto">
          {done ? (
            <div className="py-6 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-900">Replaced {plural(done.superseded, "older task")}.</p>
              <p className="text-sm text-slate-600 mt-1">
                They are marked dismissed as replaced by a newer task, and stay on record.
                {done.carried_queue ? ` ${plural(done.carried_queue, "newer task")} took over a place in the email queue.` : ""}
              </p>
              {done.failed ? (
                <p className="mt-3 text-sm text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-lg px-3 py-2 inline-flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {plural(done.failed, "task")} could not be changed. Run the check again to see what is left.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600 mb-3">
                <span className="font-medium text-slate-800">Preview. Nothing has changed yet.</span>{" "}
                When a shipment has more than one active task for the carrier, or more than one for the customer, the newest one stays. The older ones are dismissed with a note that a newer task replaced them. Nothing is deleted.
              </p>

              {error ? <div className="mb-3 rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 text-sm px-3 py-2 break-words">{error}</div> : null}

              {loading ? (
                <div className="py-10 text-center text-sm text-slate-500 inline-flex items-center justify-center gap-2 w-full"><Loader2 className="h-4 w-4 animate-spin" /> Checking {scoped ? "the selected tasks" : "the board"} for duplicates…</div>
              ) : plan && !groups.length ? (
                <div className="py-8 text-center text-sm text-slate-600">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500 mx-auto mb-2" />
                  No duplicates. Every shipment has one task per audience.
                </div>
              ) : plan ? (
                <>
                  <p className="text-sm font-medium text-slate-900 mb-2">
                    {plural(count, "older task")} on {plural(plan.shipments, "shipment")} would be replaced by a newer one.
                  </p>
                  <div className="space-y-2 pb-2">
                    {groups.map((g) => <GroupBlock key={`${g.shipment_id}:${g.audience}`} group={g} />)}
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100">
          {done ? (
            <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm bg-slate-900 text-white hover:bg-slate-800">Done</button>
          ) : (
            <>
              <button onClick={close} disabled={applying} className="rounded-lg px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
              <button onClick={apply} disabled={loading || applying || !count} className="rounded-lg px-3 py-2 text-sm bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5">
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CopyMinus className="h-4 w-4" />}
                {applying ? "Replacing…" : `Replace ${plural(count, "older task")}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupBlock({ group: g }: { group: DedupeGroup }) {
  return (
    <div className="rounded-xl ring-1 ring-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-slate-50 text-xs">
        <span className="font-mono font-medium text-slate-900">{g.tracking_number || "No tracking number"}</span>
        <Pill cls={g.audience === "carrier" ? "bg-sky-50 text-sky-800 ring-sky-200" : "bg-violet-50 text-violet-800 ring-violet-200"}>{g.audience === "carrier" ? "Carrier" : "Customer"}</Pill>
        {g.carry_queue ? <span className="inline-flex items-center gap-1 text-slate-600" title="An older task was queued for email. The newer task takes its place."><Mail className="h-3.5 w-3.5" /> Stays in the email queue</span> : null}
        {g.working ? <span className="inline-flex items-center gap-1 text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded px-1.5 py-0.5" title="Someone has started one of the older tasks. Check with them before replacing it."><AlertTriangle className="h-3.5 w-3.5" /> An older one is in progress</span> : null}
      </div>
      <div className="divide-y divide-slate-100">
        <TaskLine task={g.keep} kept />
        {g.supersede.map((t) => <TaskLine key={t.id} task={t} />)}
      </div>
    </div>
  );
}

function TaskLine({ task: t, kept = false }: { task: DedupeTask; kept?: boolean }) {
  const status = t.status as TaskStatus;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
      <span className={`shrink-0 w-28 text-xs font-medium ${kept ? "text-emerald-700" : "text-slate-400"}`}>{kept ? "Keeping (newest)" : "Replaced"}</span>
      <span className={`flex-1 min-w-0 truncate ${kept ? "text-slate-900" : "text-slate-400 line-through"}`} title={t.title}>{shortTitle(t.title) || t.title}</span>
      <span className={`shrink-0 text-xs ${kept ? "text-slate-500" : "text-slate-400"}`} title={`Created ${fmtDateTime(t.created_at)}`}>{fmtRelative(t.created_at)}</span>
      <span className={`shrink-0 ${kept ? "" : "opacity-60"}`}><Pill cls={STATUS_CLS[status] ?? "bg-slate-100 text-slate-700 ring-slate-200"}>{STATUS_LABEL[status] ?? t.status}</Pill></span>
    </div>
  );
}

// Also the default export, for callers that import it that way.
export default DedupeDialog;
