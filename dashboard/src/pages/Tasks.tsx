import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, ListChecks, Pencil, RefreshCw, Trash2, CheckCircle2, Circle, ExternalLink, UserPlus, X } from "lucide-react";
import { api } from "../lib/api";
import type { ShipmentTask, TaskStatus, TaskPriority } from "../lib/types";
import { useNav } from "../lib/nav";

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
  const [draft, setDraft] = useState(value || "");
  const [busy, setBusy] = useState(false);
  // External request to enter edit mode (keyboard shortcut).
  useEffect(() => {
    if (requestEdit && !editing) {
      setDraft(value || "");
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestEdit]);
  useEffect(() => {
    onEditingChange?.(editing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  async function commit() {
    const next = draft.trim();
    if (next === (value || "").trim()) { setEditing(false); return; }
    setBusy(true);
    try {
      await onSave(next === "" ? null : next);
      setEditing(false);
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!editing) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setDraft(value || ""); setEditing(true); }}
        className="group inline-flex items-center gap-1.5 text-left text-slate-600 hover:text-sky-700"
        title="Edit assignee"
      >
        <span>{value || <span className="text-slate-400">—</span>}</span>
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value || ""); setEditing(false); }
      }}
      disabled={busy}
      placeholder="email or name"
      className="text-sm px-2 py-1 rounded-md border border-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-300 min-w-[180px]"
    />
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

export function TasksPage() {
  const nav = useNav();
  const [tasks, setTasks] = useState<ShipmentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Bulk selection + assign state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState<string>("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Keyboard-driven navigation. focusedId is the row the next shortcut acts on.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editingAssigneeId, setEditingAssigneeId] = useState<string | null>(null);
  const lastGAt = useRef<number>(0); // for the gg jump-to-top sequence
  const visibleIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
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
      // Optimistic local patch — server route returns just a count.
      setTasks((prev) => prev.map((t) => selected.has(t.id) ? { ...t, assigned_to: target } : t));
      clearSelection();
      setAssignee("");
      if (r.updated !== ids.length) {
        setError(`Assigned ${r.updated} of ${ids.length} tasks.`);
      }
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
      const params: { status?: string } = {};
      if (statusFilter) params.status = statusFilter;
      const r = await api.tasks.list(params);
      setTasks(r.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [statusFilter]);

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
  useEffect(() => {
    if (!tasks.length) { setFocusedId(null); return; }
    if (!focusedId || !tasks.some((t) => t.id === focusedId)) {
      setFocusedId(tasks[0].id);
    }
  }, [tasks, focusedId]);

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

      const idx = focusedId ? tasks.findIndex((t) => t.id === focusedId) : -1;
      const moveDown = () => {
        if (!tasks.length) return;
        const next = idx < 0 ? 0 : Math.min(idx + 1, tasks.length - 1);
        setFocusedId(tasks[next].id);
      };
      const moveUp = () => {
        if (!tasks.length) return;
        const next = idx <= 0 ? 0 : idx - 1;
        setFocusedId(tasks[next].id);
      };

      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveDown(); return; }
      if (e.key === "k" || e.key === "ArrowUp")   { e.preventDefault(); moveUp(); return; }

      // `gg` to top — vim-style two-keystroke combo within 600ms.
      if (e.key === "g" && !e.shiftKey) {
        e.preventDefault();
        const now = Date.now();
        if (now - lastGAt.current < 600 && tasks.length) {
          setFocusedId(tasks[0].id);
          lastGAt.current = 0;
        } else {
          lastGAt.current = now;
        }
        return;
      }
      if (e.key === "G" || (e.key === "g" && e.shiftKey)) {
        e.preventDefault();
        if (tasks.length) setFocusedId(tasks[tasks.length - 1].id);
        return;
      }

      // Per-row actions need a focused row.
      if (idx < 0) return;
      const t = tasks[idx];

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
  }, [tasks, focusedId, helpOpen, selected.size]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ListChecks className="h-6 w-6 text-slate-700" /> Tasks</h1>
          <p className="text-sm text-slate-500 mt-0.5">Follow-ups across shipments. Auto-assigned to whoever scraped the shipment.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
          >
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

      {error ? <div className="mb-4 rounded-lg bg-red-50 text-red-700 px-4 py-2 text-sm">{error}</div> : null}

      {selected.size > 0 ? (
        <div className="mb-3 rounded-xl bg-sky-50 ring-1 ring-sky-200 px-4 py-3 flex flex-wrap items-center gap-3">
          <UserPlus className="h-4 w-4 text-sky-700" />
          <span className="text-sm font-medium text-sky-900">{selected.size} selected</span>
          <input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Assign to (email or name)…"
            className="flex-1 min-w-[220px] rounded-lg border border-sky-200 bg-white px-3 py-1.5 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
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
            ) : tasks.length === 0 ? (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">No tasks yet. Open a shipment and add one.</td></tr>
            ) : tasks.map((t) => (
              <tr
                key={t.id}
                data-task-id={t.id}
                onClick={() => {
                  setFocusedId(t.id);
                  if (t.shipment_id) nav.openShipment(t.shipment_id);
                }}
                className={
                  "border-t border-slate-100 hover:bg-sky-50/50 " +
                  (t.shipment_id ? "cursor-pointer " : "") +
                  (selected.has(t.id) ? "bg-sky-50/40 " : "") +
                  (focusedId === t.id ? "ring-2 ring-inset ring-sky-400 bg-sky-50/30" : "")
                }
                title={t.shipment_id ? "Open shipment drawer" : undefined}
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
                    onClick={() => setStatus(t, t.status === "done" ? "open" : "done")}
                    title={STATUS_LABEL[t.status]}
                    className="text-slate-500 hover:text-slate-900"
                  >
                    {t.status === "done"
                      ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      : <Circle className="h-5 w-5" />}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <div className={t.status === "done" ? "line-through text-slate-400" : "text-slate-900 font-medium"}>{t.title}</div>
                  {t.description ? <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{t.description}</div> : null}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_COLOR[t.priority] || PRIORITY_COLOR.normal}`}>{t.priority}</span>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {t.shipment_id ? (
                    <span className="text-sky-700 group-hover:text-sky-900 hover:underline font-medium">
                      {t.tracking_number || "(no tracking #)"}
                    </span>
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
            ))}
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
