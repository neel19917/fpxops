// =====================================================================
// Task banner — surfaces the focused task in the shipment drawer when it
// is entered via /tasks/:taskId. It is the compact summary of the task:
// title, priority/status chips, a clamped description, and the Start /
// Complete / Reopen / Block actions the Tasks page exposes, so the rep
// can finish a task without leaving the drawer.
//
// Anything long (description, the current AI read, the sibling list) is
// collapsed by default and expands on click — the banner sits above the
// Overview tab, which already restates the situation in plain English,
// so it must not push that below the fold.
// =====================================================================
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Mail, Pencil, RefreshCw } from "lucide-react";
import { fmtRelative } from "../../lib/format";
import type { Shipment, ShipmentNote, ShipmentTask, TaskStatus } from "../../lib/types";

const TASK_PRIORITY_COLOR: Record<string, string> = {
  low: "bg-slate-100 text-slate-700 ring-slate-200",
  normal: "bg-sky-100 text-sky-800 ring-sky-200",
  high: "bg-amber-100 text-amber-800 ring-amber-200",
  urgent: "bg-rose-100 text-rose-800 ring-rose-200",
};
const TASK_STATUS_TONE: Record<string, string> = {
  open: "bg-sky-50 text-sky-800 ring-sky-200",
  in_progress: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  blocked: "bg-amber-50 text-amber-800 ring-amber-200",
  done: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  cancelled: "bg-slate-50 text-slate-600 ring-slate-200",
};
const TASK_STATUS_LABEL: Record<string, string> = {
  open: "Open", in_progress: "In Progress", blocked: "Blocked", done: "Done", cancelled: "Cancelled",
};

export interface TaskBannerProps {
  task: ShipmentTask;
  // Marks / unmarks the task for Email Studio (hotkey E).
  onToggleEmailQueue?: () => void;
  // The shipment as of the latest scrape/analysis. The task's own title +
  // description are frozen at creation (AI wording from that day), so the
  // banner shows the CURRENT read next to it and offers to refresh the
  // description from it — "the card is still pulling an old one" was the
  // complaint that prompted this.
  shipment?: Shipment | null;
  latestNote?: ShipmentNote | null;
  // Other active tasks on the same shipment (newest first) so the operator
  // can see they're on one of several and hop between them.
  siblings?: ShipmentTask[];
  onOpenTask?: (taskId: string) => void;
  busy: boolean;
  onSetStatus: (status: TaskStatus) => Promise<void> | void;
  // Persists an edited description back to the server. Called from the
  // inline pencil-edit affordance on the description block. Returns a
  // promise so the banner can show its own busy / error state without
  // having to plumb that through onSetStatus's `busy` flag.
  onSaveDescription?: (description: string) => Promise<void> | void;
  // Hands a "create the inverse audience's followup" request back to
  // the parent so a carrier-followup walker can spawn a parallel
  // customer followup (and vice-versa) without leaving the drawer.
  onCreateInverseFollowup?: (kind: "carrier" | "customer") => Promise<void> | void;
}

// Clamps its children to three lines with a "Show more / Show less"
// toggle. The toggle only appears when the text actually overflows —
// measured, not guessed from character count, because the drawer width
// (and so the wrap point) changes with the split-view panel.
function Clamp({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // Collapse again when the content changes (next task in the walk, a
  // saved edit) so one task's expanded state doesn't leak into the next.
  useEffect(() => { setExpanded(false); }, [resetKey]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    // Re-measure when the drawer is resized (split view toggled, window
    // resized). Guarded: ResizeObserver is missing in some test envs.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [resetKey, expanded]);
  return (
    <div>
      <div ref={ref} className={expanded ? "" : "line-clamp-3"}>{children}</div>
      {overflows || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-0.5 text-[11px] font-medium text-violet-700 hover:text-violet-900 hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function TaskBanner({ task, shipment, latestNote, siblings = [], onOpenTask, busy, onSetStatus, onToggleEmailQueue, onSaveDescription, onCreateInverseFollowup }: TaskBannerProps) {
  // Detect which audience this task addresses (if any) so we can offer
  // a one-click "also create a parallel followup" for the other side.
  // Mirrors isCarrierFollowupTitle/isCustomerFollowupTitle on the
  // server — kept inline here so the drawer doesn't need to import
  // them from the Tasks page module (which would pull in unrelated
  // state).
  const titleLower = (task.title || "").toLowerCase();
  const isCarrierFollowup = titleLower.includes("carrier") && titleLower.includes("follow");
  const isCustomerFollowup = !isCarrierFollowup && titleLower.includes("customer") && titleLower.includes("follow");
  // The inverse audience — what's missing right now.
  const inverseAudience: "carrier" | "customer" | null =
    isCarrierFollowup ? "customer"
    : isCustomerFollowup ? "carrier"
    : null;
  const [inverseBusy, setInverseBusy] = useState(false);
  const [inverseDone, setInverseDone] = useState(false);

  // Inline description editor. Reset the draft whenever the focused
  // task changes (drawer-walk forward, server-side reload) so we never
  // ship one task's edits into another's body.
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description || "");
  const [descBusy, setDescBusy] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);
  useEffect(() => {
    setEditingDesc(false);
    setDescDraft(task.description || "");
    setDescError(null);
  }, [task.id, task.description]);

  // Sibling list starts collapsed to a single line; re-collapse on every
  // task so walking with j/k keeps the banner the same height.
  const [siblingsOpen, setSiblingsOpen] = useState(false);
  useEffect(() => { setSiblingsOpen(false); }, [task.id]);

  async function saveDescription() {
    if (!onSaveDescription) return;
    const next = descDraft.trim();
    if (next === (task.description || "").trim()) {
      setEditingDesc(false);
      return;
    }
    setDescBusy(true);
    setDescError(null);
    try {
      await onSaveDescription(next);
      setEditingDesc(false);
    } catch (e) {
      setDescError((e as Error).message || "Couldn't save description.");
    } finally {
      setDescBusy(false);
    }
  }

  // Is the task's text older than the shipment's latest analysis? Then the
  // AI has re-read the shipment since this task was written and the card
  // may be describing yesterday's problem.
  const analyzedAt = shipment?.last_analyzed_at ? Date.parse(shipment.last_analyzed_at) : NaN;
  const taskAt = Date.parse(task.updated_at || task.created_at);
  const textIsStale = Number.isFinite(analyzedAt) && Number.isFinite(taskAt) && analyzedAt - taskAt > 6 * 3_600_000;
  const currentRead = [shipment?.ai_issue, shipment?.ai_recommendation].filter(Boolean).join("\n\n");
  // The "Now" box only earns its space when it says something the task
  // text doesn't: the AI has re-read the shipment since the task was
  // written (stale), or a rep has left a note. When the task text is
  // current, the AI issue/recommendation would just repeat the
  // description above and the plain-English card below.
  const showCurrentRead = textIsStale && !!currentRead;
  const showNowBox = !!shipment && (showCurrentRead || !!latestNote);
  const [refreshBusy, setRefreshBusy] = useState(false);
  async function refreshFromAnalysis() {
    if (!onSaveDescription || !currentRead) return;
    setRefreshBusy(true);
    setDescError(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await onSaveDescription(`${currentRead}\n\n[${stamp} refreshed from latest analysis]`);
      setEditingDesc(false);
    } catch (e) {
      setDescError((e as Error).message || "Couldn't refresh description.");
    } finally {
      setRefreshBusy(false);
    }
  }

  async function handleInverse() {
    if (!inverseAudience || !onCreateInverseFollowup) return;
    setInverseBusy(true);
    try {
      await onCreateInverseFollowup(inverseAudience);
      setInverseDone(true);
      setTimeout(() => setInverseDone(false), 2500);
    } catch { /* parent surfaces the error */ }
    finally { setInverseBusy(false); }
  }

  // Build the action set per current status so the banner only shows
  // moves that make sense (matches the per-row status button on Tasks).
  // The first entry is the primary move and renders first in the row.
  const actions: { label: string; status: TaskStatus; tone: string }[] = (() => {
    if (task.status === "open") return [
      { label: "Start", status: "in_progress", tone: "bg-indigo-600 text-white hover:bg-indigo-700" },
    ];
    if (task.status === "in_progress") return [
      { label: "Mark done", status: "done",    tone: "bg-emerald-600 text-white hover:bg-emerald-700" },
      { label: "Block",     status: "blocked", tone: "bg-white text-amber-700 ring-1 ring-amber-200 hover:bg-amber-50" },
    ];
    if (task.status === "blocked") return [
      { label: "Reopen", status: "open", tone: "bg-white text-sky-700 ring-1 ring-sky-200 hover:bg-sky-50" },
    ];
    if (task.status === "done") return [
      { label: "Reopen", status: "open", tone: "bg-white text-sky-700 ring-1 ring-sky-200 hover:bg-sky-50" },
    ];
    return [];
  })();

  // The auto-task description ends with a "Change log:" block of raw
  // field diffs (ISO timestamps etc.). Keep the human text visible and
  // fold the diff behind a disclosure.
  const description = task.description || "";
  const changeLogIdx = description.indexOf("Change log:");
  const humanText = changeLogIdx >= 0 ? description.slice(0, changeLogIdx).trim() : description;
  const changeLog = changeLogIdx >= 0 ? description.slice(changeLogIdx).trim() : "";

  return (
    <div className="mb-4 rounded-xl bg-violet-50 ring-1 ring-violet-200 px-4 py-3">
      <div className="flex items-center justify-between gap-3 mb-1">
        {/* Who/when rides on the eyebrow line instead of taking a row of
            its own next to the action buttons. */}
        <div className="min-w-0 truncate text-[11px] text-slate-500">
          <span className="text-[10px] font-bold uppercase tracking-wider text-violet-700">Task</span>
          {task.assigned_to ? <span className="ml-2">{task.assigned_to}</span> : null}
          <span className="ml-2">created {new Date(task.created_at).toLocaleDateString()}</span>
          {task.updated_at && task.updated_at !== task.created_at ? <span className="ml-2 text-slate-400">edited {fmtRelative(task.updated_at)}</span> : null}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ring-1 ${TASK_PRIORITY_COLOR[task.priority] || TASK_PRIORITY_COLOR.normal}`}>
            {task.priority}
          </span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ring-1 ${TASK_STATUS_TONE[task.status] || TASK_STATUS_TONE.open}`}>
            {TASK_STATUS_LABEL[task.status] || task.status}
          </span>
        </div>
      </div>
      <div className="text-sm font-medium text-slate-900 leading-snug">{task.title}</div>
      {editingDesc ? (
        <div className="mt-1.5">
          <textarea
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditingDesc(false);
                setDescDraft(task.description || "");
                setDescError(null);
              } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void saveDescription();
              }
            }}
            rows={Math.min(8, Math.max(3, descDraft.split("\n").length + 1))}
            maxLength={5000}
            disabled={descBusy}
            placeholder="Add task description…"
            className="w-full text-xs rounded-md border border-violet-200 bg-white px-2 py-1.5 leading-snug focus:ring-2 focus:ring-violet-400 focus:border-violet-400 disabled:opacity-60"
            autoFocus
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={saveDescription}
              disabled={descBusy}
              className="text-[11px] font-semibold rounded-md px-2.5 py-1 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {descBusy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingDesc(false);
                setDescDraft(task.description || "");
                setDescError(null);
              }}
              disabled={descBusy}
              className="text-[11px] font-semibold rounded-md px-2.5 py-1 ring-1 ring-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <span className="text-[10px] text-slate-500">⌘/Ctrl+Enter saves · Esc cancels</span>
          </div>
        </div>
      ) : task.description ? (
        <div className="group relative mt-1 flex items-start gap-1.5">
          <div className="text-xs text-slate-600 leading-snug flex-1 min-w-0">
            {humanText ? (
              <Clamp resetKey={`${task.id}:${humanText}`}>
                <div className="whitespace-pre-wrap">{humanText}</div>
              </Clamp>
            ) : null}
            {changeLog ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-800 select-none">What changed between scrapes</summary>
                <pre className="mt-1 text-[11px] text-slate-500 whitespace-pre-wrap font-mono bg-white/70 rounded-md p-2 ring-1 ring-slate-200">{changeLog}</pre>
              </details>
            ) : null}
          </div>
          {onSaveDescription ? (
            <button
              type="button"
              onClick={() => setEditingDesc(true)}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition shrink-0 p-1 rounded text-slate-500 hover:text-violet-700 hover:bg-violet-100"
              title="Edit description"
              aria-label="Edit description"
            >
              <Pencil className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ) : onSaveDescription ? (
        <button
          type="button"
          onClick={() => setEditingDesc(true)}
          className="mt-1 text-[11px] text-violet-700 hover:text-violet-900 hover:underline inline-flex items-center gap-1"
          title="Add a description for this task"
        >
          <Pencil className="h-3 w-3" /> Add description
        </button>
      ) : null}
      {/* Shown outside the editor too: a failed "Refresh task text" has no
          textarea open to hang its error under. */}
      {descError ? <div className="text-[11px] text-rose-700 mt-1">{descError}</div> : null}
      {/* Current read: what the shipment looks like NOW, next to the
          frozen task text. Only rendered when there is something newer
          to show than the task itself (see showNowBox). */}
      {shipment && showNowBox ? (
        <div className={`mt-2 rounded-lg px-3 py-2 ring-1 text-xs ${showCurrentRead ? "bg-amber-50 ring-amber-200" : "bg-white/70 ring-violet-100"}`}>
          {showCurrentRead ? (
            <>
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                  Now{shipment.shipment_status ? <span className="ml-1.5 font-semibold normal-case tracking-normal text-slate-500">· {shipment.shipment_status}</span> : null}
                </div>
                <div className="text-[10px] text-slate-500">
                  {shipment.last_analyzed_at ? `analyzed ${fmtRelative(shipment.last_analyzed_at)}` : ""}
                  <span className="ml-1.5 text-amber-800 font-semibold">task text is older than this</span>
                </div>
              </div>
              <Clamp resetKey={`${task.id}:${currentRead}`}>
                {shipment.ai_issue ? <div className="text-slate-800 leading-snug">{shipment.ai_issue}</div> : null}
                {shipment.ai_recommendation ? <div className="text-slate-600 leading-snug mt-1">{shipment.ai_recommendation}</div> : null}
              </Clamp>
            </>
          ) : null}
          {latestNote ? (
            <div className={"text-slate-700 " + (showCurrentRead ? "mt-1.5 pt-1.5 border-t border-slate-200/70" : "")}>
              <span className="font-semibold text-slate-600">Last note</span>
              <span className="text-slate-400"> · {latestNote.created_by || "—"} · {fmtRelative(latestNote.created_at)}</span>
              <Clamp resetKey={`${task.id}:${latestNote.id}:${latestNote.body}`}>
                <div className="whitespace-pre-wrap leading-snug">{latestNote.body}</div>
              </Clamp>
            </div>
          ) : null}
          {onSaveDescription && showCurrentRead ? (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={refreshFromAnalysis}
                disabled={refreshBusy || descBusy}
                className="text-[11px] font-semibold rounded-md px-2 py-1 bg-white text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1"
                title="Replace the task description with the current AI issue + recommendation (the old text stays in the audit log)"
              >
                <RefreshCw className={`h-3 w-3 ${refreshBusy ? "animate-spin" : ""}`} /> {refreshBusy ? "Refreshing…" : "Refresh task text from latest analysis"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {siblings.length ? (
        <div className="mt-2 text-[11px] text-slate-600">
          <button
            type="button"
            onClick={() => setSiblingsOpen((v) => !v)}
            aria-expanded={siblingsOpen}
            className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-slate-900"
          >
            {siblingsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {siblings.length} other active task{siblings.length === 1 ? "" : "s"} on this shipment
          </button>
          {siblingsOpen ? (
            // Expanded shows every sibling (the old list stopped at four);
            // capped in height so a busy shipment can't take over the drawer.
            <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
              {siblings.map((s) => (
                <li key={s.id} className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold ring-1 shrink-0 ${TASK_STATUS_TONE[s.status] || TASK_STATUS_TONE.open}`}>{TASK_STATUS_LABEL[s.status] || s.status}</span>
                  {onOpenTask ? (
                    <button type="button" onClick={() => onOpenTask(s.id)} className="truncate text-left text-sky-700 hover:underline" title={s.title}>{s.title}</button>
                  ) : <span className="truncate" title={s.title}>{s.title}</span>}
                  <span className="text-slate-400 shrink-0">{new Date(s.created_at).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* One action row: the status move first and strongest, then the
          email mark, then the parallel-followup shortcut as a quiet text
          link. "Load in FreightPOP" / "Open tracking #" live in the drawer
          header toolbar, which is pinned above this on every tab. */}
      <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            disabled={busy}
            onClick={() => onSetStatus(a.status)}
            className={`text-xs font-semibold rounded-md px-3 py-1 ${a.tone} disabled:opacity-50`}
          >
            {busy ? "…" : a.label}
          </button>
        ))}
        {onToggleEmailQueue && task.status !== "done" && task.status !== "cancelled" ? (
          <button
            type="button"
            disabled={busy}
            onClick={onToggleEmailQueue}
            aria-pressed={!!task.email_queued_at}
            title={task.email_queued_at ? "Queued for Email Studio. Press E to take it out." : "Mark for email: it collects in Email Studio, grouped by carrier or customer (E)"}
            className={"text-xs font-semibold rounded-md px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-50 " + (task.email_queued_at ? "bg-violet-600 text-white hover:bg-violet-700" : "bg-white text-violet-700 ring-1 ring-violet-200 hover:bg-violet-50")}
          >
            <Mail className="h-3.5 w-3.5" /> {task.email_queued_at ? "Queued for email" : "Mark for email"}
            <kbd className={"ml-0.5 px-1 rounded text-[10px] font-mono " + (task.email_queued_at ? "bg-violet-500" : "bg-violet-100")}>E</kbd>
          </button>
        ) : null}
        {inverseAudience ? (
          <button
            type="button"
            disabled={inverseBusy}
            onClick={handleInverse}
            className={
              "ml-auto text-xs font-medium px-1 py-1 hover:underline disabled:opacity-50 disabled:no-underline " +
              (inverseDone ? "text-emerald-700" : "text-slate-600 hover:text-slate-900")
            }
            title={`Create a parallel ${inverseAudience} followup task for this shipment so the ${inverseAudience} side has a pending follow-up too.`}
          >
            {inverseBusy
              ? "Creating…"
              : inverseDone
              ? `${inverseAudience === "carrier" ? "Carrier" : "Customer"} followup added`
              : `+ Add ${inverseAudience} followup`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
