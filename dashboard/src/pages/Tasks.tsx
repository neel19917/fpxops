import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, ListChecks, Pencil, RefreshCw, Trash2, CheckCircle2, Circle, ExternalLink, UserPlus, X, Play, Ban, Rocket } from "lucide-react";
import { api } from "../lib/api";
import type { ShipmentTask, TaskStatus, TaskPriority } from "../lib/types";
import { useNav } from "../lib/nav";
import { UserPicker } from "../components/UserPicker";

// Keyboard shortcut catalog — kept here so the help modal renders the same
// thing the handler implements. Order matters; this is the help-modal order.
const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["j", "↓"], label: "Move down" },
  { keys: ["k", "↑"], label: "Move up" },
  { keys: ["g g"], label: "Jump to top" },
  { keys: ["G"], label: "Jump to bottom" },
  { keys: ["space", "x"], label: "Toggle done" },
  { keys: ["s"], label: "Cycle status (open → in-progress → done → blocked → cancelled)" },
  { keys: ["1"], label: "Priority: low" },
  { keys: ["2"], label: "Priority: normal" },
  { keys: ["3"], label: "Priority: high" },
  { keys: ["4"], label: "Priority: urgent" },
  { keys: ["enter"], label: "Open shipment drawer" },
  { keys: ["a"], label: "Add to bulk-select (toggle)" },
  { keys: ["e"], label: "Edit assignee inline" },
  { keys: ["d", "delete"], label: "Delete task (with confirm)" },
  { keys: ["r"], label: "Refresh list" },
  { keys: ["esc"], label: "Clear bulk-select / close help" },
  { keys: ["?"], label: "Show this help" },
];

interface InlineAssigneeProps {
  value: string | null;
  onSave: (next: string | null) => Promise<void>;
  // When set, the parent is requesting we enter edit mode (e.g. user pressed
  // `e` on a focused row). The callback fires whenever the editing state
  // changes so the parent can clear its request.
  requestEdit?: boolean;
  onEditingChange?: (editing: boolean) => void;
}
function InlineAssignee({ value, onSave, requestEdit, onEditingChange }: InlineAssigneeProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (requestEdit && !editing) setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestEdit]);
  useEffect(() => {
    onEditingChange?.(editing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  async function commit(next: string | null) {
    if ((next || "") === (value || "")) { setEditing(false); return; }
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!editing) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        className="group inline-flex items-center gap-1.5 text-left text-slate-600 hover:text-sky-700"
        title="Edit assignee"
      >
        <span>{value || <span className="text-slate-400">—</span>}</span>
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }
  return (
    <div onClick={(e) => e.stopPropagation()} className={busy ? "opacity-60 pointer-events-none" : ""}>
      <UserPicker
        value={value}
        onChange={(next) => commit(next)}
        placeholder="email or name"
        size="sm"
        autoFocus
        className="min-w-[220px]"
      />
    </div>
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const PRIORITY_COLOR: Record<string, string> = {
  low: "text-slate-500 bg-slate-100",
  normal: "text-sky-700 bg-sky-100",
  high: "text-amber-700 bg-amber-100",
  urgent: "text-red-700 bg-red-100",
};

// statusFilter values:
//   ""           → all (raw, no filter)
//   "active"     → synthetic: open + in_progress (default landing view)
//   "open" / "in_progress" / "blocked" / "done" / "cancelled"
//                → real status filter, sent to the server
const FILTER_KEY = "fpx.tasks.statusFilter";

export function TasksPage() {
  const nav = useNav();
  const [tasks, setTasks] = useState<ShipmentTask[]>([]);
  const [loading, setLoading] = useState(true);
  // First-visit default = "active" (open + in_progress). Otherwise restore
  // whatever the user last picked so the view sticks across reloads.
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    try { return localStorage.getItem(FILTER_KEY) ?? "active"; } catch { return "active"; }
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try { localStorage.setItem(FILTER_KEY, statusFilter); } catch {}
  }, [statusFilter]);

  // Bulk selection + assign state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState<string>("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Keyboard-driven navigation. focusedId is the row the next shortcut acts on.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editingAssigneeId, setEditingAssigneeId] = useState<string | null>(null);
  const lastGAt = useRef<number>(0); // for the gg jump-to-top sequence
  // visibleIds tracks the *currently rendered* rows so select-all / focused
  // navigation only act on what the user sees.
  const visibleIds = useMemo(
    () => (statusFilter === "active"
      ? tasks.filter((t) => t.status === "open" || t.status === "in_progress")
      : statusFilter
        ? tasks.filter((t) => t.status === statusFilter)
        : tasks).map((t) => t.id),
    [tasks, statusFilter],
  );
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      if (visibleIds.every((id) => prev.has(id))) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelected(new Set()); }

  async function bulkAssign() {
    if (!selected.size || bulkBusy) return;
    const target = assignee.trim();
    if (!target) { setError("Enter an assignee email or name."); return; }
    setBulkBusy(true);
    setError(null);
    try {
      const ids = Array.from(selected);
      const r = await api.tasks.bulkUpdate({ ids, assigned_to: target });
      clearSelection();
      setAssignee("");
      if (r.updated !== ids.length) {
        setError(`Assigned ${r.updated} of ${ids.length} tasks.`);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkSetStatus(status: TaskStatus) {
    if (!selected.size || bulkBusy) return;
    setBulkBusy(true);
    setError(null);
    try {
      const ids = Array.from(selected);
      const r = await api.tasks.bulkUpdate({ ids, status });
      clearSelection();
      if (r.updated !== ids.length) {
        setError(`Updated ${r.updated} of ${ids.length} tasks.`);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // "Start all open" — one-click bulk-start of every currently visible
  // open task. Acts on the local filtered list so it matches what the user
  // sees on screen.
  async function startAllOpen() {
    if (bulkBusy) return;
    const ids = tasks.filter((t) => t.status === "open").map((t) => t.id);
    if (!ids.length) { setError("No open tasks to start."); return; }
    if (!confirm(`Start ${ids.length} open task${ids.length === 1 ? "" : "s"}? Each moves to "In Progress".`)) return;
    setBulkBusy(true);
    setError(null);
    try {
      const r = await api.tasks.bulkUpdate({ ids, status: "in_progress" });
      if (r.updated !== ids.length) {
        setError(`Started ${r.updated} of ${ids.length} tasks.`);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Always pull the full set so the KPI strip can show real totals
      // regardless of which filter is active. Filtering happens below.
      const r = await api.tasks.list({});
      setTasks(r.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Visible rows after applying the current filter. KPIs above use the raw
  // `tasks` list so totals stay honest no matter which chip is selected.
  const visibleTasks = useMemo(() => {
    if (!statusFilter) return tasks;
    if (statusFilter === "active") return tasks.filter((t) => t.status === "open" || t.status === "in_progress");
    return tasks.filter((t) => t.status === statusFilter);
  }, [tasks, statusFilter]);

  // Filter changes are now client-side over the already-loaded list, so we
  // only fetch on mount + on explicit Refresh.
  useEffect(() => { load(); }, []);

  async function setStatus(t: ShipmentTask, status: TaskStatus) {
    try {
      const { task } = await api.tasks.update(t.id, { status });
      setTasks((prev) => prev.map((p) => (p.id === task.id ? task : p)));
    } catch (e) { setError((e as Error).message); }
  }
  async function updateAssignee(t: ShipmentTask, assigned_to: string | null) {
    const { task } = await api.tasks.update(t.id, { assigned_to });
    setTasks((prev) => prev.map((p) => (p.id === task.id ? task : p)));
  }

  async function remove(t: ShipmentTask) {
    if (!confirm(`Delete task "${t.title}"?`)) return;
    try {
      await api.tasks.remove(t.id);
      setTasks((prev) => prev.filter((p) => p.id !== t.id));
    } catch (e) { setError((e as Error).message); }
  }
  async function setPriority(t: ShipmentTask, priority: TaskPriority) {
    try {
      const { task } = await api.tasks.update(t.id, { priority });
      setTasks((prev) => prev.map((p) => (p.id === task.id ? task : p)));
    } catch (e) { setError((e as Error).message); }
  }

  // Keep the focused row valid as the list mutates (load, delete, filter).
  // Anchored on visibleTasks so changing the filter snaps focus to the new
  // top of the visible list rather than something off-screen.
  useEffect(() => {
    if (!visibleTasks.length) { setFocusedId(null); return; }
    if (!focusedId || !visibleTasks.some((t) => t.id === focusedId)) {
      setFocusedId(visibleTasks[0].id);
    }
  }, [visibleTasks, focusedId]);

  // Scroll the focused row into view as the user moves through the list.
  useEffect(() => {
    if (!focusedId) return;
    const row = document.querySelector<HTMLElement>(`tr[data-task-id="${focusedId}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [focusedId]);

  // Keyboard shortcuts. Bound to document so they work no matter where focus
  // happens to be — except when the user is typing into an input/textarea
  // (we don't want `j`/`k` interrupting an assignee edit).
  useEffect(() => {
    function isTypingInField(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (el.isContentEditable) return true;
      return false;
    }

    function onKey(e: KeyboardEvent) {
      // Help modal: Esc closes; never swallow the user's typing.
      if (helpOpen) {
        if (e.key === "Escape") { e.preventDefault(); setHelpOpen(false); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingInField(e.target)) return;

      // Help — `?` (which is Shift+/) and the literal `?` key on macOS.
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (e.key === "Escape") {
        if (selected.size) { e.preventDefault(); clearSelection(); }
        return;
      }
      if (e.key === "r") {
        e.preventDefault();
        load();
        return;
      }

      const idx = focusedId ? visibleTasks.findIndex((t) => t.id === focusedId) : -1;
      const moveDown = () => {
        if (!visibleTasks.length) return;
        const next = idx < 0 ? 0 : Math.min(idx + 1, visibleTasks.length - 1);
        setFocusedId(visibleTasks[next].id);
      };
      const moveUp = () => {
        if (!visibleTasks.length) return;
        const next = idx <= 0 ? 0 : idx - 1;
        setFocusedId(visibleTasks[next].id);
      };

      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveDown(); return; }
      if (e.key === "k" || e.key === "ArrowUp")   { e.preventDefault(); moveUp(); return; }

      // `gg` to top — vim-style two-keystroke combo within 600ms.
      if (e.key === "g" && !e.shiftKey) {
        e.preventDefault();
        const now = Date.now();
        if (now - lastGAt.current < 600 && visibleTasks.length) {
          setFocusedId(visibleTasks[0].id);
          lastGAt.current = 0;
        } else {
          lastGAt.current = now;
        }
        return;
      }
      if (e.key === "G" || (e.key === "g" && e.shiftKey)) {
        e.preventDefault();
        if (visibleTasks.length) setFocusedId(visibleTasks[visibleTasks.length - 1].id);
        return;
      }

      // Per-row actions need a focused row.
      if (idx < 0) return;
      const t = visibleTasks[idx];

      if (e.key === " " || e.key === "x") {
        e.preventDefault();
        setStatus(t, t.status === "done" ? "open" : "done");
        return;
      }
      if (e.key === "Enter") {
        if (t.shipment_id) { e.preventDefault(); nav.openShipment(t.shipment_id); }
        return;
      }
      if (e.key === "a") {
        e.preventDefault();
        toggle(t.id);
        return;
      }
      if (e.key === "e") {
        e.preventDefault();
        setEditingAssigneeId(t.id);
        return;
      }
      if (e.key === "d" || e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove(t);
        return;
      }
      if (e.key === "s") {
        e.preventDefault();
        const cycle: TaskStatus[] = ["open", "in_progress", "done", "blocked", "cancelled"];
        const next = cycle[(cycle.indexOf(t.status) + 1) % cycle.length];
        setStatus(t, next);
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") {
        e.preventDefault();
        const map: Record<string, TaskPriority> = { "1": "low", "2": "normal", "3": "high", "4": "urgent" };
        setPriority(t, map[e.key]);
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // setStatus / remove / nav / load are stable enough — listing them
    // would re-bind every render without changing behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTasks, focusedId, helpOpen, selected.size]);

  // Status counts across the currently loaded list — drives the KPI strip
  // and the "Start all" enable/disable.
  const counts = useMemo(() => ({
    open: tasks.filter((t) => t.status === "open").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    done: tasks.filter((t) => t.status === "done").length,
    cancelled: tasks.filter((t) => t.status === "cancelled").length,
  }), [tasks]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ListChecks className="h-6 w-6 text-slate-700" /> Tasks</h1>
          <p className="text-sm text-slate-500 mt-0.5">Follow-ups across shipments. Auto-assigned to whoever scraped the shipment.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={startAllOpen}
            disabled={bulkBusy || counts.open === 0}
            className="rounded-lg bg-sky-600 text-white text-sm px-3 py-2 flex items-center gap-1.5 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Mark every open task as In Progress"
          >
            <Rocket className="h-4 w-4" /> {bulkBusy ? "Starting…" : `Start all open (${counts.open})`}
          </button>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
          >
            <option value="active">Active (open + in progress)</option>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="blocked">Blocked</option>
            <option value="done">Done</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button
            onClick={() => setHelpOpen(true)}
            className="rounded-lg bg-white border border-slate-200 text-slate-700 text-sm px-3 py-2 flex items-center gap-1.5 hover:bg-slate-50"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-4 w-4" /> Shortcuts
          </button>
          <button
            onClick={load}
            className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 flex items-center gap-1.5 hover:bg-slate-800"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-4">
        {([
          { id: "active",      label: "Active",      count: counts.open + counts.in_progress, tone: "bg-violet-50 text-violet-800 ring-violet-200" },
          { id: "",            label: "All",         count: tasks.length,        tone: "bg-slate-50 text-slate-700 ring-slate-200" },
          { id: "open",        label: "Open",        count: counts.open,         tone: "bg-sky-50 text-sky-800 ring-sky-200" },
          { id: "in_progress", label: "In Progress", count: counts.in_progress,  tone: "bg-indigo-50 text-indigo-800 ring-indigo-200" },
          { id: "blocked",     label: "Blocked",     count: counts.blocked,      tone: "bg-amber-50 text-amber-800 ring-amber-200" },
          { id: "done",        label: "Done",        count: counts.done,         tone: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
        ] as { id: string; label: string; count: number; tone: string }[]).map((kpi) => (
          <button
            key={kpi.label}
            onClick={() => setStatusFilter(kpi.id)}
            className={`rounded-xl ring-1 px-3 py-2 text-left transition ${kpi.tone} ${statusFilter === kpi.id ? "ring-2 ring-offset-1" : "hover:ring-2"}`}
          >
            <div className="text-[11px] uppercase tracking-wide opacity-80">{kpi.label}</div>
            <div className="text-xl font-semibold">{kpi.count}</div>
          </button>
        ))}
      </div>

      {error ? <div className="mb-4 rounded-lg bg-red-50 text-red-700 px-4 py-2 text-sm">{error}</div> : null}

      {selected.size > 0 ? (
        <div className="mb-3 rounded-xl bg-sky-50 ring-1 ring-sky-200 px-4 py-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <UserPlus className="h-4 w-4 text-sky-700" />
            <span className="text-sm font-medium text-sky-900">{selected.size} selected</span>
            <UserPicker
              value={assignee || null}
              onChange={(v) => setAssignee(v || "")}
              placeholder="Assign to…"
              size="sm"
              className="flex-1 min-w-[220px]"
            />
            <button
              onClick={bulkAssign}
              disabled={bulkBusy || !assignee.trim()}
              className="rounded-lg bg-sky-600 text-white text-sm px-3 py-1.5 hover:bg-sky-700 disabled:opacity-50"
            >
              {bulkBusy ? "Assigning…" : "Assign"}
            </button>
            <button
              onClick={clearSelection}
              className="rounded-lg text-sky-700 text-sm px-2 py-1.5 hover:bg-sky-100 inline-flex items-center gap-1"
              title="Clear selection"
            >
              <X className="h-4 w-4" /> Clear
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-sky-100">
            <span className="text-xs uppercase tracking-wide text-sky-700/80 font-semibold">Bulk status:</span>
            <button
              onClick={() => bulkSetStatus("in_progress")}
              disabled={bulkBusy}
              className="rounded-lg bg-white ring-1 ring-sky-200 text-sky-800 text-sm px-3 py-1.5 hover:bg-sky-100 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Play className="h-3.5 w-3.5" /> Start
            </button>
            <button
              onClick={() => bulkSetStatus("done")}
              disabled={bulkBusy}
              className="rounded-lg bg-white ring-1 ring-emerald-200 text-emerald-800 text-sm px-3 py-1.5 hover:bg-emerald-50 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark done
            </button>
            <button
              onClick={() => bulkSetStatus("blocked")}
              disabled={bulkBusy}
              className="rounded-lg bg-white ring-1 ring-amber-200 text-amber-800 text-sm px-3 py-1.5 hover:bg-amber-50 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Ban className="h-3.5 w-3.5" /> Block
            </button>
            <button
              onClick={() => bulkSetStatus("open")}
              disabled={bulkBusy}
              className="rounded-lg bg-white ring-1 ring-slate-200 text-slate-700 text-sm px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Circle className="h-3.5 w-3.5" /> Reopen
            </button>
          </div>
        </div>
      ) : null}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  aria-label="Select all"
                  className="h-4 w-4 rounded border-slate-300"
                />
              </th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Title</th>
              <th className="text-left px-4 py-3">Priority</th>
              <th className="text-left px-4 py-3">Tracking</th>
              <th className="text-left px-4 py-3">Assigned</th>
              <th className="text-left px-4 py-3">Created</th>
              <th className="text-right px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">Loading…</td></tr>
            ) : visibleTasks.length === 0 ? (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">
                {tasks.length === 0
                  ? "No tasks yet. Open a shipment and add one."
                  : `No ${statusFilter === "active" ? "active" : statusFilter || ""} tasks — try a different filter.`}
              </td></tr>
            ) : visibleTasks.map((t) => {
              // Status circle is the primary per-row action button:
              //   open → in_progress (Start)
              //   in_progress → done   (Complete)
              //   done → open          (Reopen)
              //   blocked / cancelled → open (Reopen)
              const nextStatus: TaskStatus =
                t.status === "open" ? "in_progress"
                : t.status === "in_progress" ? "done"
                : "open";
              const statusLabel =
                t.status === "open" ? "Start"
                : t.status === "in_progress" ? "Complete"
                : t.status === "done" ? "Reopen"
                : "Reopen";
              return (
              <tr
                key={t.id}
                data-task-id={t.id}
                onClick={() => setFocusedId(t.id)}
                className={
                  "border-t border-slate-100 hover:bg-sky-50/50 " +
                  (selected.has(t.id) ? "bg-sky-50/40 " : "") +
                  (focusedId === t.id ? "ring-2 ring-inset ring-sky-400 bg-sky-50/30" : "")
                }
              >
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggle(t.id)}
                    aria-label={`Select task ${t.title}`}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                </td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => setStatus(t, nextStatus)}
                    title={`${statusLabel} (currently ${STATUS_LABEL[t.status]})`}
                    className={
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ring-1 transition " +
                      (t.status === "done"
                        ? "text-emerald-700 ring-emerald-200 bg-emerald-50 hover:bg-emerald-100"
                        : t.status === "in_progress"
                        ? "text-indigo-700 ring-indigo-200 bg-indigo-50 hover:bg-indigo-100"
                        : t.status === "blocked"
                        ? "text-amber-700 ring-amber-200 bg-amber-50 hover:bg-amber-100"
                        : "text-sky-700 ring-sky-200 bg-sky-50 hover:bg-sky-100")
                    }
                  >
                    {t.status === "done"
                      ? <CheckCircle2 className="h-4 w-4" />
                      : t.status === "in_progress"
                      ? <Play className="h-4 w-4" />
                      : t.status === "blocked"
                      ? <Ban className="h-4 w-4" />
                      : <Circle className="h-4 w-4" />}
                    <span className="text-[11px] font-semibold">{statusLabel}</span>
                  </button>
                </td>
                <td className="px-4 py-3">
                  {t.shipment_id ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); nav.openShipment(t.shipment_id); }}
                      className={"text-left w-full hover:text-sky-700 " + (t.status === "done" ? "line-through text-slate-400" : "text-slate-900 font-medium")}
                      title="Open shipment drawer"
                    >
                      {t.title}
                    </button>
                  ) : (
                    <div className={t.status === "done" ? "line-through text-slate-400" : "text-slate-900 font-medium"}>{t.title}</div>
                  )}
                  {t.description ? <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{t.description}</div> : null}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_COLOR[t.priority] || PRIORITY_COLOR.normal}`}>{t.priority}</span>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {t.shipment_id ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); nav.openShipment(t.shipment_id); }}
                      className="text-sky-700 hover:text-sky-900 hover:underline font-medium"
                    >
                      {t.tracking_number || "(no tracking #)"}
                    </button>
                  ) : (t.tracking_number || "—")}
                </td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <InlineAssignee
                    value={t.assigned_to}
                    onSave={(next) => updateAssignee(t, next)}
                    requestEdit={editingAssigneeId === t.id}
                    onEditingChange={(isEditing) => {
                      if (!isEditing && editingAssigneeId === t.id) setEditingAssigneeId(null);
                    }}
                  />
                </td>
                <td className="px-4 py-3 text-slate-500 text-xs">{new Date(t.created_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {t.shipment_id ? (
                    <button
                      onClick={() => nav.openShipment(t.shipment_id)}
                      className="p-1.5 text-slate-400 hover:text-sky-700 hover:bg-sky-50 rounded-md mr-1"
                      title="Open shipment drawer"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  ) : null}
                  <button onClick={() => remove(t)} className="text-slate-400 hover:text-red-600" title="Delete">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500 mt-3 text-center">
        Press <kbd className="px-1.5 py-0.5 rounded bg-white ring-1 ring-slate-200 font-mono text-[10px]">?</kbd> for keyboard shortcuts.
      </p>

      {helpOpen ? (
        <div
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Keyboard className="h-5 w-5 text-slate-700" /> Keyboard shortcuts
              </h3>
              <button
                onClick={() => setHelpOpen(false)}
                className="p-1.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="px-5 py-4 space-y-2">
              {SHORTCUTS.map((s) => (
                <li key={s.label} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-700">{s.label}</span>
                  <span className="flex gap-1 shrink-0">
                    {s.keys.map((k) => (
                      <kbd key={k} className="px-1.5 py-0.5 rounded bg-slate-100 ring-1 ring-slate-200 font-mono text-[11px] text-slate-700">
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <div className="px-5 py-3 border-t border-slate-100 text-[11px] text-slate-500">
              Shortcuts pause while you're typing in an input. <kbd className="px-1 py-0.5 rounded bg-white ring-1 ring-slate-200 font-mono">esc</kbd> closes this.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
