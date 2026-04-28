import { useEffect, useMemo, useState } from "react";
import { ListChecks, RefreshCw, Trash2, CheckCircle2, Circle, ExternalLink, UserPlus, X } from "lucide-react";
import { api } from "../lib/api";
import type { ShipmentTask, TaskStatus } from "../lib/types";
import { useNav } from "../lib/nav";

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

  async function remove(t: ShipmentTask) {
    if (!confirm(`Delete task "${t.title}"?`)) return;
    try {
      await api.tasks.remove(t.id);
      setTasks((prev) => prev.filter((p) => p.id !== t.id));
    } catch (e) { setError((e as Error).message); }
  }

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
                onClick={() => t.shipment_id && nav.openShipment(t.shipment_id)}
                className={"border-t border-slate-100 hover:bg-sky-50/50 " + (t.shipment_id ? "cursor-pointer" : "") + (selected.has(t.id) ? " bg-sky-50/40" : "")}
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
                <td className="px-4 py-3 text-slate-600">{t.assigned_to || "—"}</td>
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
    </div>
  );
}
