import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Keyboard, ListChecks, Pencil, RefreshCw, Trash2, CheckCircle2, Circle, ExternalLink, UserPlus, X, Play, Ban, Rocket, LayoutGrid, Table as TableIcon, Truck, Mail, Copy, Check, Send, Search, Plus, ThumbsUp, ThumbsDown } from "lucide-react";
import { api, type GroupEmailDraft } from "../lib/api";
import type { CarrierFollowupShipment, Shipment, ShipmentTask, TaskStatus, TaskPriority } from "../lib/types";
import { fmtRelative } from "../lib/format";
import { useNav } from "../lib/nav";
import { UserPicker } from "../components/UserPicker";
import { requestAutoFilter } from "../lib/freightpopFrame";
import { swrGet, swrSet } from "../lib/swrCache";

// Convention-based detector: a task is a "Carrier Followup" when its
// title contains both "carrier" and "follow" (case-insensitive). Mirrors
// the server-side check in routes/tasks.js so the panel and the
// /carrier-followups endpoint agree on which tasks belong here.
function isCarrierFollowupTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return t.includes("carrier") && t.includes("follow");
}

// Color-coded chip for shipment_status. Buckets free-text statuses
// (FreightPOP emits a long tail) into 5 visual categories so the
// followup panels and group-email modal share one rendering rule and
// operators can scan a list in one glance.
function shipmentStatusTone(status: string | null | undefined): { label: string; cls: string } {
  const raw = (status || "").trim();
  const s = raw.toLowerCase();
  if (!s) return { label: "no status", cls: "bg-slate-100 text-slate-500 ring-slate-200" };
  if (s.includes("deliver")) return { label: raw, cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" };
  if (s.includes("out for")) return { label: raw, cls: "bg-teal-50 text-teal-800 ring-teal-200" };
  if (s.includes("transit") || s.includes("en route") || s.includes("moving"))
    return { label: raw, cls: "bg-sky-50 text-sky-800 ring-sky-200" };
  if (s.includes("issue") || s.includes("exception") || s.includes("problem") || s.includes("delay"))
    return { label: raw, cls: "bg-rose-50 text-rose-800 ring-rose-200" };
  if (s.includes("pickup") || s.includes("booked") || s.includes("scheduled") || s.includes("dispatch"))
    return { label: raw, cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  return { label: raw, cls: "bg-slate-100 text-slate-700 ring-slate-200" };
}

function ShipmentStatusPill({ status, className = "" }: { status: string | null | undefined; className?: string }) {
  const { label, cls } = shipmentStatusTone(status);
  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 whitespace-nowrap ${cls} ${className}`}
      title={label}
    >
      {label}
    </span>
  );
}

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
  { keys: ["n"], label: "Walk to next task (opens its shipment)" },
  { keys: ["p"], label: "Walk to previous task (opens its shipment)" },
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
const VIEW_KEY   = "fpx.tasks.view";   // "table" | "kanban"

// Kanban columns. Order = left-to-right reading order = the workflow
// progression. Cancelled is intentionally excluded (rare, hide it from the
// daily flow; still reachable via the Table view's filter).
const KANBAN_COLS: { id: TaskStatus; label: string; tone: string; chip: string }[] = [
  { id: "open",        label: "Open",        tone: "bg-sky-50 ring-sky-200",         chip: "bg-sky-100 text-sky-800" },
  { id: "in_progress", label: "In Progress", tone: "bg-indigo-50 ring-indigo-200",   chip: "bg-indigo-100 text-indigo-800" },
  { id: "blocked",     label: "Blocked",     tone: "bg-amber-50 ring-amber-200",     chip: "bg-amber-100 text-amber-800" },
  { id: "done",        label: "Done",        tone: "bg-emerald-50 ring-emerald-200", chip: "bg-emerald-100 text-emerald-800" },
];

export function TasksPage() {
  const nav = useNav();
  const [tasks, setTasks] = useState<ShipmentTask[]>([]);
  const [loading, setLoading] = useState(true);
  // First-visit default = "active" (open + in_progress). Otherwise restore
  // whatever the user last picked so the view sticks across reloads.
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    try { return localStorage.getItem(FILTER_KEY) ?? "active"; } catch { return "active"; }
  });
  // Free-text filter, applied AFTER the status filter. Matches against
  // shipment_external_id (FreightPOP-side, e.g. "13583467"),
  // tracking_number, title, description, and assigned_to. Persisted
  // intentionally NOT — search is a transient navigation tool, not a
  // saved view; resetting on reload matches what users expect.
  const [search, setSearch] = useState("");
  // Shipment-mode filter (LTL / Parcel / etc.) joined into the task by
  // /api/tasks. "" = all modes. Persisted across reloads alongside the
  // status filter — operators tend to live in one mode for hours at a
  // time, so the saved view sticks.
  const [modeFilter, setModeFilter] = useState<string>(() => {
    try { return localStorage.getItem("fpx.tasks.modeFilter") ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    try { localStorage.setItem("fpx.tasks.modeFilter", modeFilter); } catch {}
  }, [modeFilter]);
  const [viewMode, setViewMode] = useState<"table" | "kanban">(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === "kanban" ? "kanban" : "table";
    } catch { return "table"; }
  });
  // Whether to load the FreightPOP iframe alongside the task drawer when
  // walking through tasks. Shares the `fpx.shipments.splitView` key so
  // toggling here also flips the panel toggle on the Shipments page —
  // operators have one mental "embed on/off" switch, not two.
  const [embedEnabled, setEmbedEnabled] = useState<boolean>(() => {
    try { return (localStorage.getItem("fpx.shipments.splitView") ?? "1") !== "0"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("fpx.shipments.splitView", embedEnabled ? "1" : "0"); } catch {}
  }, [embedEnabled]);
  // Page-level sub-tab is route-driven so reps can deep-link / bookmark
  // a specific view (carrier followups, customer followups, all tasks).
  // /tasks                       → "all"
  // /tasks/carrier-followups     → "carrier"
  // /tasks/customer-followups    → "customer"
  const location = useLocation();
  const navigate = useNavigate();
  const pageTab: "all" | "carrier" | "customer" =
    location.pathname.startsWith("/tasks/carrier-followups") ? "carrier"
    : location.pathname.startsWith("/tasks/customer-followups") ? "customer"
    : "all";
  function setPageTab(next: "all" | "carrier" | "customer") {
    if (next === "carrier") navigate("/tasks/carrier-followups");
    else if (next === "customer") navigate("/tasks/customer-followups");
    else navigate("/tasks");
  }
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try { localStorage.setItem(FILTER_KEY, statusFilter); } catch {}
  }, [statusFilter]);
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, viewMode); } catch {}
  }, [viewMode]);

  // Bulk selection + assign state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState<string>("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Keyboard-driven navigation. focusedId is the row the next shortcut acts on.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editingAssigneeId, setEditingAssigneeId] = useState<string | null>(null);
  const lastGAt = useRef<number>(0); // for the gg jump-to-top sequence
  // visibleIds tracks the *currently rendered* rows so select-all /
  // focused navigation only act on what the user sees. Mirrors the
  // status + search filtering applied to visibleTasks below — kept in
  // a separate memo so it materializes before visibleTasks (we need
  // visibleIds in the keyboard-nav effects which run higher up).
  const visibleIds = useMemo(() => {
    let list = tasks;
    if (statusFilter === "active") list = list.filter((t) => t.status === "open" || t.status === "in_progress");
    else if (statusFilter) list = list.filter((t) => t.status === statusFilter);
    if (modeFilter) {
      const want = modeFilter.toLowerCase();
      list = list.filter((t) => {
        const m = (t.shipment_mode || "").trim().toLowerCase();
        if (want === "__none__") return !m;
        return m === want;
      });
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((t) => {
        const hay = [t.shipment_external_id, t.tracking_number, t.title, t.description, t.assigned_to]
          .filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return list.map((t) => t.id);
  }, [tasks, statusFilter, modeFilter, search]);
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
      await load(true);
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
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkDelete() {
    if (!selected.size || bulkBusy) return;
    const ids = Array.from(selected);
    if (!confirm(`Delete ${ids.length} task${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setBulkBusy(true);
    setError(null);
    try {
      const r = await api.tasks.bulkDelete({ ids });
      clearSelection();
      if (r.deleted !== ids.length) {
        setError(`Deleted ${r.deleted} of ${ids.length} tasks.`);
      }
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // `silent=true` skips the loading flag so a post-bulk-mutation reload
  // doesn't blank the entire task list to LoadingState. The previous rows
  // stay visible until the new data lands and the swap is invisible.
  async function load(silent = false) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      // Always pull the full set so the KPI strip can show real totals
      // regardless of which filter is active. Filtering happens below.
      const r = await api.tasks.list({ limit: 1000, include_archived: 1 });
      setTasks(r.data);
      swrSet("tasks.list", r.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Visible rows after applying status + search filters. KPIs above use
  // the raw `tasks` list so totals stay honest no matter which chip is
  // selected. Search runs over the union of identifiers an operator
  // would actually paste into the box: FreightPOP shipment id,
  // tracking number, title, description, assignee. Case-insensitive
  // substring; whitespace-trimmed query; empty string short-circuits.
  const visibleTasks = useMemo(() => {
    let list = tasks;
    if (statusFilter === "active") list = list.filter((t) => t.status === "open" || t.status === "in_progress");
    else if (statusFilter) list = list.filter((t) => t.status === statusFilter);
    if (modeFilter) {
      const want = modeFilter.toLowerCase();
      list = list.filter((t) => {
        const m = (t.shipment_mode || "").trim().toLowerCase();
        if (want === "__none__") return !m;
        return m === want;
      });
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((t) => {
        const hay = [
          t.shipment_external_id,
          t.tracking_number,
          t.title,
          t.description,
          t.assigned_to,
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [tasks, statusFilter, modeFilter, search]);

  // Distinct shipment modes present in the current task list — drives the
  // mode filter dropdown. Always includes LTL + Parcel even if empty so
  // the operator's mental model matches what the dropdown shows; any
  // additional modes (truckload, ocean, intermodal) appear dynamically.
  const availableModes = useMemo(() => {
    const set = new Set<string>(["LTL", "Parcel"]);
    let hasNoMode = false;
    for (const t of tasks) {
      const m = (t.shipment_mode || "").trim();
      if (m) set.add(m); else hasNoMode = true;
    }
    return { modes: Array.from(set).sort((a, b) => a.localeCompare(b)), hasNoMode };
  }, [tasks]);

  // Filter changes are now client-side over the already-loaded list, so we
  // only fetch on mount + on explicit Refresh. Stale-while-revalidate:
  // paint instantly from the last successful response (if any) and let
  // the live fetch swap in silently — the table never blanks to
  // "Loading…" when we already have something showable.
  useEffect(() => {
    const cached = swrGet<ShipmentTask[]>("tasks.list");
    if (cached?.length) {
      setTasks(cached);
      setLoading(false);
      load(true);
    } else {
      load();
    }
  }, []);

  async function setStatus(t: ShipmentTask, status: TaskStatus, opts: { openDrawer?: boolean } = {}) {
    try {
      const { task } = await api.tasks.update(t.id, { status });
      setTasks((prev) => prev.map((p) => (p.id === task.id ? task : p)));
      // Starting a task means starting work on the shipment — pop the drawer
      // open so the user lands directly in context. Other transitions
      // (Complete / Reopen) stay where they are.
      // openDrawer means "begin work on this task" — route through task-walk
      // so the drawer's prev/next chevrons step through tasks instead of
      // shipments.
      if (opts.openDrawer && t.shipment_id) nav.openTask(t.id);
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
        if (t.shipment_id) { e.preventDefault(); nav.openTask(t.id); }
        return;
      }
      // Walk-through: n / p step through the visible task list and open
      // each task in task-walk mode.
      if (e.key === "n" || e.key === "p") {
        e.preventDefault();
        const dir = e.key === "n" ? 1 : -1;
        const start = idx < 0 ? 0 : idx + dir;
        // Find the next task that has a shipment; skip orphans.
        for (let i = start; i >= 0 && i < visibleTasks.length; i += dir) {
          const cand = visibleTasks[i];
          setFocusedId(cand.id);
          if (cand.shipment_id) { nav.openTask(cand.id); break; }
        }
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
          <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white overflow-hidden">
            <button
              onClick={() => setViewMode("table")}
              className={"px-3 py-2 text-sm inline-flex items-center gap-1.5 transition " + (viewMode === "table" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50")}
              title="Table view"
              aria-pressed={viewMode === "table"}
            >
              <TableIcon className="h-4 w-4 shrink-0" />
              <span>Table</span>
            </button>
            <button
              onClick={() => setViewMode("kanban")}
              className={"px-3 py-2 text-sm inline-flex items-center gap-1.5 border-l border-slate-200 transition " + (viewMode === "kanban" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50")}
              title="Kanban view"
              aria-pressed={viewMode === "kanban"}
            >
              <LayoutGrid className="h-4 w-4 shrink-0" />
              <span>Kanban</span>
            </button>
          </div>
          {/* Combined "Start & walk through" — one click bulk-starts every
              open task in the walk scope (moves them to In Progress) and
              then opens the first task's drawer so the operator can step
              through them with n / p. Walk scope mirrors what's visible
              under the current filter, falling back to the active set
              (open + in_progress) when the filter has nothing to walk so
              the button is never dead from a Done / Blocked filter. */}
          {(() => {
            const activeTasks = tasks.filter((t) => t.status === "open" || t.status === "in_progress");
            const walkScope = visibleTasks.length > 0 ? visibleTasks : activeTasks;
            const walkCount = walkScope.length;
            const fallbackHint = visibleTasks.length === 0 && activeTasks.length > 0;
            const openInScope = walkScope.filter((t) => t.status === "open").map((t) => t.id);
            return (
              <button
                onClick={async () => {
                  if (bulkBusy) return;
                  const first = walkScope.find((t) => t.shipment_id);
                  if (!first) { setError("No task with a shipment to walk through."); return; }
                  // Bulk-start any open tasks in scope first so the walk
                  // begins with everything already In Progress. Skipped
                  // when the scope has no open tasks (e.g. walking the
                  // Done filter as a review queue).
                  if (openInScope.length > 0) {
                    setBulkBusy(true);
                    setError(null);
                    try {
                      const r = await api.tasks.bulkUpdate({ ids: openInScope, status: "in_progress" });
                      if (r.updated !== openInScope.length) {
                        setError(`Started ${r.updated} of ${openInScope.length} tasks.`);
                      }
                      await load(true);
                    } catch (e) {
                      setError((e as Error).message);
                      setBulkBusy(false);
                      return;
                    }
                    setBulkBusy(false);
                  }
                  if (fallbackHint) setStatusFilter("active");
                  setFocusedId(first.id);
                  nav.openTask(first.id);
                }}
                disabled={walkCount === 0 || bulkBusy}
                className="rounded-lg bg-violet-600 text-white text-sm px-3 py-2 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title={openInScope.length > 0
                  ? `Start ${openInScope.length} open task${openInScope.length === 1 ? "" : "s"} and walk through ${walkCount}`
                  : fallbackHint
                    ? `Current filter has no tasks — walking the ${walkCount} active task${walkCount === 1 ? "" : "s"} instead`
                    : `Walk through ${walkCount} task${walkCount === 1 ? "" : "s"} with n / p`}
              >
                <Rocket className="h-4 w-4 shrink-0" />
                <span>{bulkBusy ? "Starting…" : `Start & walk (${walkCount})`}</span>
              </button>
            );
          })()}
          {/* Mini toggle: load the FreightPOP iframe alongside the task
              drawer? Shared with the Shipments-page panel toggle via
              localStorage so reps have one switch, not two. */}
          <label
            className="inline-flex items-center gap-1.5 text-xs text-slate-600 select-none cursor-pointer px-2 py-2 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50"
            title="Load the FreightPOP grid in the left pane while walking tasks"
          >
            <input
              type="checkbox"
              checked={embedEnabled}
              onChange={(e) => setEmbedEnabled(e.target.checked)}
              className="h-3.5 w-3.5 accent-violet-600 cursor-pointer"
            />
            <span>FreightPOP embed</span>
          </label>
          {/* Free-text filter. Searches Shipment ID (FreightPOP), tracking
              number, title, description, and assignee in a single box. */}
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shipment id, tracking, title…"
              className="rounded-lg border border-slate-200 pl-8 pr-8 py-2 text-sm bg-white w-72 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none"
              aria-label="Search tasks"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
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
          <select
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
            title="Filter by shipment mode (LTL, Parcel, etc.)"
          >
            <option value="">All modes</option>
            {availableModes.modes.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {availableModes.hasNoMode ? <option value="__none__">(no mode)</option> : null}
          </select>
          <button
            onClick={() => setHelpOpen(true)}
            className="rounded-lg bg-white border border-slate-200 text-slate-700 text-sm px-3 py-2 flex items-center gap-1.5 hover:bg-slate-50"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-4 w-4" /> Shortcuts
          </button>
          <button
            onClick={() => load()}
            className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 flex items-center gap-1.5 hover:bg-slate-800"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Page-level sub-tabs. "All" is the default — KPIs + bulk +
          Kanban/Table on the full task list. Carrier / Customer focus
          the entire page on one followup panel without the surrounding
          chrome, so the operator can work a single audience without
          the kanban scrolling underneath. */}
      <div className="flex items-center gap-1 border-b border-slate-200 mb-4 -mx-1 px-1 overflow-x-auto">
        {([
          { id: "all" as const,      label: "All Tasks",          count: tasks.length, tone: "border-slate-900 text-slate-900" },
          { id: "carrier" as const,  label: "Carrier Followups",  count: tasks.filter((t) => isCarrierFollowupTitle(t.title) && (t.status === "open" || t.status === "in_progress")).length, tone: "border-violet-600 text-violet-700" },
          { id: "customer" as const, label: "Customer Followups", count: tasks.filter((t) => {
            const ti = (t.title || "").toLowerCase();
            const isCarrier = ti.includes("carrier") && ti.includes("follow");
            const isCustomer = ti.includes("customer") && ti.includes("follow") && !ti.includes("carrier");
            return isCustomer && !isCarrier && (t.status === "open" || t.status === "in_progress");
          }).length, tone: "border-sky-600 text-sky-700" },
        ]).map((t) => (
          <button
            key={t.id}
            onClick={() => setPageTab(t.id)}
            className={
              "px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition inline-flex items-center gap-1.5 " +
              (pageTab === t.id
                ? t.tone
                : "border-transparent text-slate-500 hover:text-slate-900")
            }
          >
            {t.label}
            <span className={
              "text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums " +
              (pageTab === t.id
                ? t.id === "carrier" ? "bg-violet-100 text-violet-700"
                : t.id === "customer" ? "bg-sky-100 text-sky-700"
                : "bg-slate-100 text-slate-700"
                : "bg-slate-100 text-slate-600")
            }>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {pageTab === "carrier" ? (
        <FollowupsPanel kind="carrier" onTaskClick={(taskId) => nav.openTask(taskId)} />
      ) : pageTab === "customer" ? (
        <FollowupsPanel kind="customer" onTaskClick={(taskId) => nav.openTask(taskId)} />
      ) : (
      <>

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
            <span className="ml-auto" />
            <button
              onClick={bulkDelete}
              disabled={bulkBusy}
              className="rounded-lg bg-white ring-1 ring-rose-200 text-rose-700 text-sm px-3 py-1.5 hover:bg-rose-50 disabled:opacity-50 inline-flex items-center gap-1.5"
              title="Delete selected tasks"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
        </div>
      ) : null}

      {/* Followup panels are now driven by the page-level sub-tabs
          above (Carrier / Customer). Removed from the All view so the
          Kanban / Table doesn't have to scroll past them every time. */}

      {viewMode === "kanban" ? (
        // Same loading treatment as the table view below — without this,
        // a still-pending (or hung) fetch renders four empty columns that
        // read as "no tasks exist" instead of "still loading".
        loading ? (
          <div className="bg-white border border-slate-200 rounded-xl text-center text-slate-400 py-8 text-sm">Loading…</div>
        ) : (
        <KanbanBoard
          tasks={tasks}
          focusedId={focusedId}
          onFocus={setFocusedId}
          onSetStatus={(t, s) => setStatus(t, s, { openDrawer: s === "in_progress" && t.status === "open" })}
          onOpenTask={(taskId) => nav.openTask(taskId)}
        />
        )
      ) : (
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
                {tasks.length === 0 ? (
                  "No tasks yet. Open a shipment and add one."
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <div>
                      No {statusFilter === "active" ? "active" : statusFilter || ""} tasks
                      {modeFilter ? ` in ${modeFilter === "__none__" ? "(no mode)" : modeFilter}` : ""}
                      {search.trim() ? ` matching "${search.trim()}"` : ""}
                      {" "}— {tasks.length} total loaded.
                    </div>
                    <button
                      onClick={() => { setStatusFilter(""); setModeFilter(""); setSearch(""); }}
                      className="rounded-md bg-slate-900 text-white text-xs px-3 py-1.5 hover:bg-slate-800"
                    >
                      Clear all filters
                    </button>
                  </div>
                )}
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
                    onClick={() => setStatus(t, nextStatus, { openDrawer: t.status === "open" })}
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
                      onClick={(e) => { e.stopPropagation(); nav.openTask(t.id); }}
                      className={"text-left w-full hover:text-sky-700 " + (t.status === "done" ? "line-through text-slate-400" : "text-slate-900 font-medium")}
                      title="Open in task-walk mode"
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
                      onClick={(e) => { e.stopPropagation(); nav.openTask(t.id); }}
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
                  {t.shipment_id && t.tracking_number ? (
                    <button
                      onClick={() => { requestAutoFilter(); nav.openTask(t.id); }}
                      className="px-2 py-1 mr-1 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-1"
                      title={`Load shipment ${t.tracking_number} — opens the task drawer and filters the FreightPOP grid by Tracking Number`}
                    >
                      <Truck className="h-3.5 w-3.5" /> Load shipment
                    </button>
                  ) : null}
                  {t.shipment_id ? (
                    <button
                      onClick={() => nav.openTask(t.id)}
                      className="p-1.5 text-slate-400 hover:text-sky-700 hover:bg-sky-50 rounded-md mr-1"
                      title="Open in task-walk mode"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  ) : null}
                  {t.status !== "cancelled" ? (
                    <button
                      onClick={() => setStatus(t, "cancelled")}
                      className="p-1.5 text-slate-400 hover:text-amber-700 hover:bg-amber-50 rounded-md mr-1"
                      title="Clear (mark as cancelled — keeps history)"
                    >
                      <X className="h-4 w-4" />
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
      )}

      <p className="text-xs text-slate-500 mt-3 text-center">
        Press <kbd className="px-1.5 py-0.5 rounded bg-white ring-1 ring-slate-200 font-mono text-[10px]">?</kbd> for keyboard shortcuts.
      </p>
      </>
      )}

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

// ===========================================================================
// Kanban
// ===========================================================================

interface KanbanBoardProps {
  tasks: ShipmentTask[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  onSetStatus: (t: ShipmentTask, status: TaskStatus) => void;
  // Routes through /tasks/:taskId so the drawer enters task-walk mode.
  onOpenTask: (taskId: string) => void;
}

// Drag/drop dataTransfer key for a kanban card. Custom MIME so we
// don't collide with browser-native drags (e.g. dragging a link). We
// also set "text/plain" with the same id for compat with some
// browsers that demand plain text to fire dragover.
const KANBAN_DT = "application/x-fpx-task-id";

function KanbanBoard({ tasks, focusedId, onFocus, onSetStatus, onOpenTask }: KanbanBoardProps) {
  const grouped = useMemo(() => {
    const m: Record<TaskStatus, ShipmentTask[]> = {
      open: [], in_progress: [], blocked: [], done: [], cancelled: [],
    };
    for (const t of tasks) m[t.status]?.push(t);
    return m;
  }, [tasks]);

  // Tracks which column is currently the drop target for visual
  // feedback. Cleared on drop, dragend, or dragleave-from-board.
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  // Tracks the source column of the in-flight drag so we can dim it
  // and skip the highlight when hovering back over the original.
  const [draggingFrom, setDraggingFrom] = useState<TaskStatus | null>(null);
  // Map id → task so the drop handler can resolve the dragged task
  // without scanning the full list each time.
  const byId = useMemo(() => {
    const m = new Map<string, ShipmentTask>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  function handleDrop(targetStatus: TaskStatus, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    setDraggingFrom(null);
    const id = e.dataTransfer.getData(KANBAN_DT) || e.dataTransfer.getData("text/plain");
    if (!id) return;
    const task = byId.get(id);
    if (!task) return;
    if (task.status === targetStatus) return;
    onSetStatus(task, targetStatus);
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      {KANBAN_COLS.map((col) => {
        const items = grouped[col.id] || [];
        const isTarget = dragOver === col.id && draggingFrom !== col.id;
        return (
          <div
            key={col.id}
            onDragOver={(e) => {
              // Allow drops by preventing default; set effect so the
              // cursor shows "move" instead of the deny circle.
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOver !== col.id) setDragOver(col.id);
            }}
            onDragLeave={(e) => {
              // Only clear when the pointer leaves the column entirely
              // (relatedTarget falls outside this DOM subtree). Without
              // this guard, hovering over child elements re-fires
              // dragleave and the highlight flickers off.
              const next = e.relatedTarget as Node | null;
              if (!next || !(e.currentTarget as HTMLElement).contains(next)) {
                setDragOver((cur) => (cur === col.id ? null : cur));
              }
            }}
            onDrop={(e) => handleDrop(col.id, e)}
            className={
              `rounded-xl ring-1 ${col.tone} flex flex-col min-h-[200px] transition ` +
              (isTarget ? "ring-2 ring-offset-2 ring-sky-500 shadow-md" : "")
            }
            aria-dropeffect="move"
          >
            <div className="px-3 py-2.5 flex items-center justify-between border-b border-white/60">
              <span className="text-sm font-semibold text-slate-800">{col.label}</span>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${col.chip}`}>
                {items.length}
              </span>
            </div>
            <div className="p-2 space-y-2 flex-1">
              {items.length === 0 ? (
                <div className={"text-xs text-center py-6 " + (isTarget ? "text-sky-600 font-medium" : "text-slate-400")}>
                  {isTarget ? `Drop to mark ${col.label}` : "Nothing here"}
                </div>
              ) : items.map((t) => (
                <KanbanCard
                  key={t.id}
                  task={t}
                  focused={focusedId === t.id}
                  onFocus={onFocus}
                  onSetStatus={onSetStatus}
                  onOpenTask={onOpenTask}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(KANBAN_DT, t.id);
                    e.dataTransfer.setData("text/plain", t.id);
                    setDraggingFrom(t.status);
                  }}
                  onDragEnd={() => {
                    setDragOver(null);
                    setDraggingFrom(null);
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface KanbanCardProps {
  task: ShipmentTask;
  focused: boolean;
  onFocus: (id: string) => void;
  onSetStatus: (t: ShipmentTask, s: TaskStatus) => void;
  onOpenTask: (taskId: string) => void;
  // Drag handlers fed in from KanbanBoard so the board can track which
  // column the card was lifted from (for highlight-skip + drop logic).
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

function KanbanCard({ task, focused, onFocus, onSetStatus, onOpenTask, onDragStart, onDragEnd }: KanbanCardProps) {
  // Action choices per column. Open → Start. In Progress → Done | Block.
  // Blocked → Reopen. Done → Reopen. Keeps the card terse — at most two
  // buttons.
  const actions: { label: string; status: TaskStatus; tone: string; icon: React.ReactNode }[] = (() => {
    if (task.status === "open") return [
      { label: "Start", status: "in_progress", tone: "bg-indigo-600 text-white hover:bg-indigo-700", icon: <Play className="h-3 w-3" /> },
    ];
    if (task.status === "in_progress") return [
      { label: "Done",  status: "done",    tone: "bg-emerald-600 text-white hover:bg-emerald-700", icon: <CheckCircle2 className="h-3 w-3" /> },
      { label: "Block", status: "blocked", tone: "bg-white text-amber-700 ring-1 ring-amber-200 hover:bg-amber-50", icon: <Ban className="h-3 w-3" /> },
    ];
    if (task.status === "blocked") return [
      { label: "Reopen", status: "open", tone: "bg-white text-sky-700 ring-1 ring-sky-200 hover:bg-sky-50", icon: <Circle className="h-3 w-3" /> },
    ];
    if (task.status === "done") return [
      { label: "Reopen", status: "open", tone: "bg-white text-sky-700 ring-1 ring-sky-200 hover:bg-sky-50", icon: <Circle className="h-3 w-3" /> },
    ];
    return [];
  })();

  // Track whether the card itself is being dragged so we can dim it.
  // Local state (vs hoisting to KanbanBoard) keeps the prop surface
  // narrow and limits re-renders to the dragged card.
  const [dragging, setDragging] = useState(false);
  return (
    <div
      onClick={() => onFocus(task.id)}
      draggable
      onDragStart={(e) => {
        // Don't initiate the drag if the user grabbed an interactive
        // child (button, link). HTML5 fires dragstart on the outer
        // draggable element regardless, but cancelling here keeps the
        // click semantics on those children intact.
        const target = e.target as HTMLElement | null;
        if (target && target.closest("button, a, input, textarea, select")) {
          e.preventDefault();
          return;
        }
        setDragging(true);
        onDragStart?.(e);
      }}
      onDragEnd={(e) => {
        setDragging(false);
        onDragEnd?.(e);
      }}
      className={
        "bg-white rounded-lg ring-1 p-2.5 cursor-grab active:cursor-grabbing transition " +
        (focused ? "ring-2 ring-sky-400 shadow-sm" : "ring-slate-200 hover:ring-slate-300") +
        (dragging ? " opacity-50" : "") +
        (task.status === "done" ? " opacity-70" : "")
      }
    >
      <div className={
        "text-sm font-medium leading-snug line-clamp-3 " +
        (task.status === "done" ? "line-through text-slate-400" : "text-slate-900")
      }>
        {task.title}
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${PRIORITY_COLOR[task.priority] || PRIORITY_COLOR.normal}`}>
          {task.priority}
        </span>
        {task.tracking_number && task.shipment_id ? (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTask(task.id); }}
            className="text-[11px] font-mono text-sky-700 hover:text-sky-900 hover:underline truncate"
            title="Open shipment drawer (task-walk mode)"
          >
            {task.tracking_number}
          </button>
        ) : task.tracking_number ? (
          <span className="text-[11px] font-mono text-slate-500 truncate">{task.tracking_number}</span>
        ) : null}
      </div>
      {task.assigned_to ? (
        <div className="mt-1.5 text-[11px] text-slate-500 truncate">{task.assigned_to}</div>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {task.shipment_id && task.tracking_number ? (
          <button
            onClick={(e) => { e.stopPropagation(); requestAutoFilter(); onOpenTask(task.id); }}
            className="text-[11px] font-semibold rounded-md px-2 py-1 bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-1"
            title={`Load shipment ${task.tracking_number} — opens the task drawer and filters the FreightPOP grid`}
          >
            <Truck className="h-3 w-3" /> Load
          </button>
        ) : null}
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={(e) => { e.stopPropagation(); onSetStatus(task, a.status); }}
            className={`text-[11px] font-semibold rounded-md px-2 py-1 inline-flex items-center gap-1 ${a.tone}`}
          >
            {a.icon} {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// Followups panels — surfaces tasks whose titles flag them as carrier or
// customer follow-ups, grouped by carrier name / customer name. Each card
// lists the shipments and exposes a "Group email" button that drafts ONE
// Claude email covering every shipment for that group (Opus by default).
// Carrier and Customer panels share the same component, parameterized by
// `kind` so we don't fork ~200 lines of identical layout/state code.
// ===========================================================================

type FollowupKind = "carrier" | "customer";
interface FollowupItem { task: ShipmentTask; shipment: CarrierFollowupShipment; }
// Internal normalized group shape so the renderer doesn't need to switch
// on `kind` for `g.carrier` vs `g.customer` — both come in as `name`.
interface FollowupGroup { name: string; items: FollowupItem[] }

// Module-level TTL cache for the followups fetch so toggling sub-tabs
// (carrier ↔ customer) within a 30-second window doesn't re-hit the
// API. Each kind has its own slot. Refresh button + creating a new
// followup task both bust the cache for the relevant kind.
const FOLLOWUPS_TTL_MS = 30_000;
const followupsCache: Record<FollowupKind, { ts: number; data: { groups: FollowupGroup[]; total: number } } | null> = {
  carrier: null,
  customer: null,
};
function readFollowupsCache(kind: FollowupKind): { groups: FollowupGroup[]; total: number } | null {
  const slot = followupsCache[kind];
  if (!slot) return null;
  if (Date.now() - slot.ts > FOLLOWUPS_TTL_MS) return null;
  return slot.data;
}
function writeFollowupsCache(kind: FollowupKind, data: { groups: FollowupGroup[]; total: number }) {
  followupsCache[kind] = { ts: Date.now(), data };
}
function bustFollowupsCache(kind?: FollowupKind) {
  if (kind) followupsCache[kind] = null;
  else { followupsCache.carrier = null; followupsCache.customer = null; }
}

const FOLLOWUP_KIND_CONFIG: Record<FollowupKind, {
  title: string;          // "Carrier Followups"
  groupNoun: string;      // "carrier" / "customer"
  emptyExample: string;   // example title to show in empty state
  fetch: () => Promise<{ groups: FollowupGroup[]; total: number }>;
  emailDraft: (body: { name: string; task_ids: string[]; notes?: string }) =>
    Promise<{ subject: string; body: string; count: number; model: string | null }>;
  // Prior-drafts list — used by the Group Email modal so the operator
  // can see every email we've ever drafted for this group.
  emailDraftsList: (name: string) => Promise<{ drafts: GroupEmailDraft[] }>;
  ringTone: string;       // tailwind ring class
  bgTone: string;         // tailwind bg class
  chipTone: string;
  textTone: string;
  iconTone: string;
  buttonTone: string;
}> = {
  carrier: {
    title: "Carrier Followups",
    groupNoun: "carrier",
    emptyExample: "Carrier followup: missing POD",
    fetch: async () => {
      const cached = readFollowupsCache("carrier");
      if (cached) return cached;
      const r = await api.tasks.carrierFollowups();
      const out = { total: r.total, groups: r.groups.map((g) => ({ name: g.carrier, items: g.items })) };
      writeFollowupsCache("carrier", out);
      return out;
    },
    emailDraft: ({ name, task_ids, notes }) =>
      api.tasks.carrierEmailDraft({ carrier: name, task_ids, notes }),
    emailDraftsList: (name) => api.tasks.carrierEmailDrafts(name),
    ringTone: "ring-violet-200",
    bgTone: "bg-violet-50/40",
    chipTone: "bg-violet-100 text-violet-800",
    textTone: "text-violet-900",
    iconTone: "text-violet-700",
    buttonTone: "bg-violet-600 hover:bg-violet-700",
  },
  customer: {
    title: "Customer Followups",
    groupNoun: "customer",
    emptyExample: "Customer followup: needs ETA",
    fetch: async () => {
      const cached = readFollowupsCache("customer");
      if (cached) return cached;
      const r = await api.tasks.customerFollowups();
      const out = { total: r.total, groups: r.groups.map((g) => ({ name: g.customer, items: g.items })) };
      writeFollowupsCache("customer", out);
      return out;
    },
    emailDraft: ({ name, task_ids, notes }) =>
      api.tasks.customerEmailDraft({ customer: name, task_ids, notes }),
    emailDraftsList: (name) => api.tasks.customerEmailDrafts(name),
    ringTone: "ring-sky-200",
    bgTone: "bg-sky-50/40",
    chipTone: "bg-sky-100 text-sky-800",
    textTone: "text-sky-900",
    iconTone: "text-sky-700",
    buttonTone: "bg-sky-600 hover:bg-sky-700",
  },
};

function FollowupsPanel({ kind, onTaskClick }: {
  kind: FollowupKind;
  onTaskClick: (taskId: string) => void;
}) {
  const cfg = FOLLOWUP_KIND_CONFIG[kind];
  const [groups, setGroups] = useState<FollowupGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [emailFor, setEmailFor] = useState<FollowupGroup | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load(force = false) {
    if (force) bustFollowupsCache(kind);
    setLoading(true); setErr(null);
    try {
      const r = await cfg.fetch();
      setGroups(r.groups);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  // Effect-driven load (initial + kind switch). Carries a cancel flag so a
  // slow carrier-fetch landing after a switch to customer (or vice versa)
  // doesn't overwrite the wrong panel's data.
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    cfg.fetch()
      .then((r) => { if (!cancelled) setGroups(r.groups); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [kind]);

  // Stale-while-revalidate: only show the loading banner on the first
  // mount (groups still empty). Switching carrier↔customer keeps the
  // previous panel visible until the new data lands.
  if (loading && groups.length === 0) {
    return (
      <div className={`mb-4 rounded-xl ring-1 ${cfg.ringTone} ${cfg.bgTone} px-4 py-3 text-sm ${cfg.textTone}`}>
        Loading {cfg.groupNoun} follow-ups…
      </div>
    );
  }
  if (err) {
    return (
      <div className="mb-4 rounded-xl ring-1 ring-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
        Couldn't load {cfg.groupNoun} follow-ups: {err}
      </div>
    );
  }
  // Empty state still shows an Add button so operators can create the first
  // followup without having to hunt down the Tasks page detail view.
  if (groups.length === 0) {
    return (
      <>
        <div className="mb-4 rounded-xl ring-1 ring-slate-200 bg-white px-4 py-2.5 text-[12px] text-slate-500 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <span className="font-semibold text-slate-700">{cfg.title}</span>
            <span className="mx-1.5">·</span>
            No active {cfg.groupNoun}-follow-up tasks. Use <span className="font-semibold">+ Add</span> or tag a task title with
            <span className="font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded mx-1">{cfg.emptyExample}</span>
            and it'll surface here grouped by {cfg.groupNoun}.
          </div>
          <button
            onClick={() => setAddOpen(true)}
            className={`text-xs font-semibold rounded-md px-2.5 py-1.5 text-white inline-flex items-center gap-1.5 ${cfg.buttonTone}`}
            title={`Create a ${cfg.groupNoun}-followup task`}
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {addOpen ? (
          <AddFollowupTaskModal kind={kind} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); load(true); }} />
        ) : null}
      </>
    );
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className={`mb-4 rounded-xl ring-1 ${cfg.ringTone} ${cfg.bgTone}`}>
      <div className={`px-4 py-2.5 flex items-center justify-between border-b ${cfg.ringTone}`}>
        <div className="flex items-center gap-2">
          <Mail className={`h-4 w-4 ${cfg.iconTone}`} />
          <span className="text-sm font-semibold text-slate-800">{cfg.title}</span>
          <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${cfg.chipTone}`}>
            {total} task{total === 1 ? "" : "s"} · {groups.length} {cfg.groupNoun}{groups.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAddOpen(true)}
            className={`text-xs font-semibold rounded-md px-2 py-1 text-white inline-flex items-center gap-1 ${cfg.buttonTone}`}
            title={`Create a ${cfg.groupNoun}-followup task`}
          >
            <Plus className="h-3 w-3" /> Add
          </button>
          <button
            onClick={() => load(true)}
            className={`text-[11px] ${cfg.iconTone} hover:opacity-80 inline-flex items-center gap-1`}
            title={`Refresh ${cfg.groupNoun} followups (busts the 30s client cache)`}
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>
      <div className="p-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {groups.map((g) => (
          <FollowupGroupCard
            key={g.name}
            group={g}
            kind={kind}
            onTaskClick={onTaskClick}
            onEmail={() => setEmailFor(g)}
            onSetStatus={async (task, status) => {
              // Same code path as the per-row Status button on the
              // table view: PATCH the task, then refetch (cache-bust)
              // so the panel reflects the new state. Done tasks fall
              // out of the "active" set and the card recomputes.
              try {
                await api.tasks.update(task.id, { status });
              } finally { load(true); }
            }}
          />
        ))}
      </div>

      {emailFor ? (
        <FollowupGroupEmailModal
          group={emailFor}
          kind={kind}
          onClose={() => setEmailFor(null)}
        />
      ) : null}
      {addOpen ? (
        <AddFollowupTaskModal kind={kind} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); load(); }} />
      ) : null}
    </div>
  );
}

function FollowupGroupCard({ group, kind, onTaskClick, onEmail, onSetStatus }: {
  group: FollowupGroup;
  kind: FollowupKind;
  onTaskClick: (taskId: string) => void;
  onEmail: () => void;
  onSetStatus: (task: ShipmentTask, status: TaskStatus) => Promise<void> | void;
}) {
  const cfg = FOLLOWUP_KIND_CONFIG[kind];
  // Per-row busy guard so the operator can't double-click the action
  // before the server responds. Keyed on task.id so simultaneous
  // actions on different rows still work.
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  // Defense-in-depth: server already filters /carrier-followups and
  // /customer-followups to active statuses, but we double-filter here
  // so the panel collapses a row instantly when the user marks Done
  // without waiting for the cache-bust + refetch round-trip.
  const activeItems = useMemo(
    () => group.items.filter((it) => it.task.status === "open" || it.task.status === "in_progress"),
    [group.items],
  );
  function nextAction(t: ShipmentTask): { label: string; status: TaskStatus; tone: string } | null {
    if (t.status === "open") return { label: "Start", status: "in_progress", tone: "bg-indigo-600 text-white hover:bg-indigo-700" };
    if (t.status === "in_progress") return { label: "Complete", status: "done", tone: "bg-emerald-600 text-white hover:bg-emerald-700" };
    if (t.status === "blocked") return { label: "Reopen", status: "open", tone: "bg-white text-sky-700 ring-1 ring-sky-200 hover:bg-sky-50" };
    return null;
  }
  const groupNounCap = cfg.groupNoun.charAt(0).toUpperCase() + cfg.groupNoun.slice(1);
  return (
    <div className={`rounded-lg bg-white ring-1 ${cfg.ringTone} shadow-sm flex flex-col`}>
      <div className={`px-3 py-2 border-b ${cfg.ringTone} flex items-center justify-between gap-2`}>
        <div className="min-w-0">
          <div className={`text-[10px] uppercase tracking-wider font-bold ${cfg.iconTone}`}>{groupNounCap}</div>
          <div className="text-sm font-semibold text-slate-900 truncate" title={group.name}>
            {group.name}
          </div>
        </div>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${cfg.chipTone} shrink-0`}>
          {activeItems.length}
        </span>
      </div>
      <ul className={`px-3 py-2 space-y-1.5 max-h-80 overflow-y-auto`}>
        {activeItems.map((it) => {
          const action = nextAction(it.task);
          const rowBusy = busyTaskId === it.task.id;
          return (
            <li
              key={it.task.id}
              className={`text-xs rounded-md ring-1 ring-transparent hover:ring-slate-200 hover:bg-slate-50 ${rowBusy ? "opacity-60" : ""}`}
            >
              <div className="flex items-stretch">
                {/* Clickable text region — opens task-walk mode for the
                    operator to drill in. Click bubbles up only when the
                    operator hits the body of the row, not the action
                    buttons we render to the right. */}
                <button
                  onClick={() => { requestAutoFilter(); onTaskClick(it.task.id); }}
                  className="flex-1 text-left px-2 py-1.5 min-w-0"
                  title={`Open ${it.shipment.tracking_number || it.task.title} in task-walk mode`}
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span className="font-semibold text-slate-900 truncate text-sm">
                      {it.shipment.shipment_id || "(no shipment id)"}
                    </span>
                    <span className="text-slate-600 shrink-0 font-mono text-[11px]">
                      {it.shipment.tracking_number || ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                    <ShipmentStatusPill status={it.shipment.shipment_status} />
                    <span className="text-[11px] text-slate-600 truncate">
                      {it.shipment.customer_name || "—"}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 truncate mt-0.5">
                    {it.task.title}
                  </div>
                </button>
                {/* Per-row status action — Start / Done / Reopen
                    depending on the task's current status. Same shape
                    as the per-row button on the table view so the
                    affordance feels familiar. */}
                {action ? (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      setBusyTaskId(it.task.id);
                      try { await onSetStatus(it.task, action.status); }
                      finally { setBusyTaskId(null); }
                    }}
                    disabled={rowBusy}
                    className={`text-[11px] font-semibold rounded-md px-2 py-1 inline-flex items-center self-center mr-1 ${action.tone} disabled:opacity-50`}
                    title={`Mark this task as ${action.status.replace("_", " ")}`}
                  >
                    {rowBusy ? "…" : action.label}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className={`px-3 py-2 border-t ${cfg.ringTone} flex items-center gap-2`}>
        <button
          onClick={onEmail}
          className={`text-xs font-semibold rounded-md px-2.5 py-1.5 text-white inline-flex items-center gap-1.5 ${cfg.buttonTone}`}
          title={`Draft one consolidated email to ${group.name} covering all ${group.items.length} shipment(s)`}
        >
          <Send className="h-3.5 w-3.5" /> Group email
        </button>
        <span className="text-[11px] text-slate-500 leading-snug">
          One email · all shipments · Opus model
        </span>
      </div>
    </div>
  );
}

// Modal: previews the group's task list, fires the bulk email-draft
// endpoint on demand, and renders the resulting subject/body with copy
// + mailto helpers. We don't auto-generate on open — bulk Opus calls
// cost money and the operator may just be browsing.
function FollowupGroupEmailModal({ group, kind, onClose }: {
  group: FollowupGroup;
  kind: FollowupKind;
  onClose: () => void;
}) {
  const cfg = FOLLOWUP_KIND_CONFIG[kind];
  const [busy, setBusy] = useState(false);
  // Live list of drafts for this group, freshest-first. Includes both
  // historical drafts pulled on open AND any new drafts the operator
  // generates inside this session — we prepend new ones rather than
  // replacing the list so the history stays intact.
  const [drafts, setDrafts] = useState<GroupEmailDraft[]>([]);
  // Selected draft id within `drafts`. Null until the list loads or
  // a fresh generate fires. Driven by the buttons in the prior-drafts
  // strip on the left.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [copied, setCopied] = useState(false);
  // Task ids the operator has X'd out of the next Generate — those
  // shipments don't get sent to the LLM. Excluding doesn't touch the
  // task itself; it only scopes this email round.
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  function toggleExclude(taskId: string) {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      return next;
    });
  }
  // Sort + filter controls so the operator can scope a large group
  // before generating. Sort options ordered by frequency-of-use
  // (oldest-first wins for "follow up on the one that's been
  // sitting longest"); status filter mostly used to hide blocked
  // shipments; the search box scopes by free text against the
  // shipment id / tracking / customer / origin / destination.
  type SortKey = "task_oldest" | "task_newest" | "shipment_status" | "customer";
  const [sortKey, setSortKey] = useState<SortKey>("task_oldest");
  const [search, setSearch] = useState("");
  const visibleItems = useMemo(() => {
    // First: drop tasks that have been marked Done since the modal
    // opened. These can't be in the email anyway (server enforces
    // the same filter) — hiding them up front matches the panel.
    let list = group.items.filter((it) => it.task.status === "open" || it.task.status === "in_progress");
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((it) => {
        const hay = [
          it.shipment.shipment_id,
          it.shipment.tracking_number,
          it.shipment.customer_name,
          it.shipment.origin,
          it.shipment.destination,
          it.shipment.ship_from,
          it.shipment.ship_to,
          it.shipment.shipment_status,
          it.task.title,
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    const sorted = [...list];
    switch (sortKey) {
      case "task_newest":
        sorted.sort((a, b) => +new Date(b.task.created_at) - +new Date(a.task.created_at));
        break;
      case "shipment_status":
        sorted.sort((a, b) => (a.shipment.shipment_status || "").localeCompare(b.shipment.shipment_status || ""));
        break;
      case "customer":
        sorted.sort((a, b) => (a.shipment.customer_name || "").localeCompare(b.shipment.customer_name || ""));
        break;
      case "task_oldest":
      default:
        sorted.sort((a, b) => +new Date(a.task.created_at) - +new Date(b.task.created_at));
    }
    return sorted;
  }, [group.items, search, sortKey]);
  // Items actually sent to the LLM = visible (status-active + filter-
  // matching) minus the ones the operator X'd out individually.
  const includedItems = visibleItems.filter((it) => !excludedIds.has(it.task.id));
  // How many were dropped before the operator even saw them — surfaced
  // in the header so they don't wonder where the count went.
  const droppedDoneCount = group.items.length - group.items.filter((it) => it.task.status === "open" || it.task.status === "in_progress").length;

  // Fetch the prior drafts for this group on mount. We always render
  // them — even if the operator never clicks Generate inside this
  // modal session, the prior drafts give them something to copy.
  useEffect(() => {
    let cancelled = false;
    setLoadingDrafts(true);
    cfg.emailDraftsList(group.name)
      .then((r) => {
        if (cancelled) return;
        setDrafts(r.drafts || []);
        if (r.drafts && r.drafts.length) setSelectedId(r.drafts[0].id);
      })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); })
      .finally(() => { if (!cancelled) setLoadingDrafts(false); });
    return () => { cancelled = true; };
  }, [group.name, cfg]);

  const selected = drafts.find((d) => d.id === selectedId) || null;

  async function generate() {
    if (!includedItems.length) { setErr("Include at least one shipment."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await cfg.emailDraft({
        name: group.name,
        task_ids: includedItems.map((it) => it.task.id),
        notes: notes.trim() || undefined,
      });
      // Default-copy the freshly generated draft to the clipboard so
      // the rep can paste straight into their mail client. The Copy
      // button stays usable for re-copying after edits or when the
      // initial write was blocked (focus loss, perms).
      try {
        await navigator.clipboard.writeText(`Subject: ${r.subject || ""}\n\n${r.body || ""}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* clipboard blocked — manual Copy button remains */ }
      // Refetch the list — the server just inserted a new analyses
      // row and we want the modal to reflect it (new draft, accurate
      // timestamps, future drafts also pickable).
      const list = await cfg.emailDraftsList(group.name);
      setDrafts(list.drafts || []);
      // Select the freshest draft. Match on subject+body since the
      // generate response doesn't include the analyses row id.
      const fresh = (list.drafts || []).find(
        (d) => d.subject === r.subject && d.body === r.body,
      );
      setSelectedId(fresh ? fresh.id : ((list.drafts || [])[0]?.id || null));
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function copy() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${selected.subject || ""}\n\n${selected.body || ""}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  // Toggle rating on the selected draft. Clicking the same thumb that's
  // already active clears the rating (mistaken click). Updates the
  // local list optimistically; on error, refetches from the server.
  const [rateBusy, setRateBusy] = useState(false);
  // Local mirror of rating_reason for the selected draft. Synced when
  // the user picks a different draft so the textarea reflects what's
  // actually persisted on that row.
  const [draftReason, setDraftReason] = useState<string>("");
  const [draftReasonSaved, setDraftReasonSaved] = useState<string>("");
  const [draftReasonSaving, setDraftReasonSaving] = useState(false);
  useEffect(() => {
    setDraftReason(selected?.rating_reason || "");
    setDraftReasonSaved(selected?.rating_reason || "");
  }, [selected?.id, selected?.rating, selected?.rating_reason]);
  async function rateDraft(rating: "up" | "down") {
    if (!selected || rateBusy) return;
    const next = selected.rating === rating ? null : rating;
    const reasonForRequest = next ? (draftReason.trim() || undefined) : undefined;
    setRateBusy(true);
    // Optimistic local update so the click feels instant.
    setDrafts((prev) => prev.map((d) => d.id === selected.id ? {
      ...d,
      rating: next,
      rated_by: d.rated_by,
      rated_at: next ? new Date().toISOString() : null,
      rating_reason: next ? (draftReason.trim() || null) : null,
    } : d));
    try {
      const r = await api.analyses.rate(selected.id, { rating: next, reason: reasonForRequest });
      setDrafts((prev) => prev.map((d) => d.id === selected.id ? {
        ...d,
        rating: r.analysis.rating,
        rated_by: r.analysis.rated_by,
        rated_at: r.analysis.rated_at,
        rating_reason: r.analysis.rating_reason,
      } : d));
      setDraftReasonSaved(r.analysis.rating_reason || "");
    } catch (e) {
      setErr((e as Error).message);
      // Roll back by refetching the canonical list.
      try {
        const list = await cfg.emailDraftsList(group.name);
        setDrafts(list.drafts || []);
      } catch { /* leave optimistic state in place */ }
    } finally {
      setRateBusy(false);
    }
  }
  // Persist the reason on blur if the operator actually changed it.
  // Server clears rating_reason whenever rating is null, so we don't
  // bother sending a reason without an active rating.
  async function saveDraftReason() {
    if (!selected || !selected.rating) return;
    const trimmed = draftReason.trim();
    if (trimmed === (draftReasonSaved || "").trim()) return;
    setDraftReasonSaving(true);
    try {
      const r = await api.analyses.rate(selected.id, { rating: selected.rating, reason: trimmed });
      setDrafts((prev) => prev.map((d) => d.id === selected.id ? {
        ...d,
        rating: r.analysis.rating,
        rated_by: r.analysis.rated_by,
        rated_at: r.analysis.rated_at,
        rating_reason: r.analysis.rating_reason,
      } : d));
      setDraftReasonSaved(r.analysis.rating_reason || "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDraftReasonSaving(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Mail className={`h-5 w-5 ${cfg.iconTone}`} />
              Group email · {group.name}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {includedItems.length} of {visibleItems.length} active shipment{visibleItems.length === 1 ? "" : "s"} included
              {droppedDoneCount > 0 ? <> · {droppedDoneCount} done excluded server-side</> : null}
              {" · "}prior drafts on the left · prompts editable in Settings
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-2 rounded-lg hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[260px_1fr] divide-x divide-slate-200">
          {/* Prior drafts strip — newest first. Selecting one pulls
              its subject + body into the right pane. */}
          <div className="overflow-y-auto p-3">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Drafts ({drafts.length})
            </div>
            {loadingDrafts ? (
              <div className="text-xs text-slate-500 px-2 py-1">Loading…</div>
            ) : drafts.length === 0 ? (
              <div className="text-xs text-slate-500 px-2 py-3 leading-relaxed">
                No drafts yet for {cfg.groupNoun} <span className="font-semibold">{group.name}</span>. Click <span className="font-semibold">Generate</span> below.
              </div>
            ) : (
              <ul className="space-y-1">
                {drafts.map((d) => {
                  const active = d.id === selectedId;
                  return (
                    <li key={d.id}>
                      <button
                        onClick={() => setSelectedId(d.id)}
                        className={
                          "w-full text-left rounded-lg px-3 py-2 text-xs transition " +
                          (active
                            ? `${cfg.bgTone} ring-1 ${cfg.ringTone}`
                            : "hover:bg-slate-50 ring-1 ring-transparent")
                        }
                        title={d.subject || "(no subject)"}
                      >
                        <div className={"font-medium truncate " + (active ? "text-slate-900" : "text-slate-700")}>
                          {d.subject || "(no subject)"}
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                          <span>{fmtRelative(d.created_at)}</span>
                          {d.model ? <span className="font-mono">{d.model}</span> : null}
                          {d.count ? <span>· {d.count} ship.</span> : null}
                          {d.rating === "up" ? (
                            <ThumbsUp className="h-3 w-3 text-emerald-600" aria-label="Rated good" />
                          ) : d.rating === "down" ? (
                            <ThumbsDown className="h-3 w-3 text-rose-600" aria-label="Rated needs work" />
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Right pane: shipments-included + notes input + selected
              draft preview. Stacked vertically so the operator can
              scroll the right side independently of the drafts list. */}
          <div className="overflow-y-auto p-5 space-y-4">
            <div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 flex items-center justify-between gap-3 flex-wrap">
                <span>
                  Shipments included ({includedItems.length} / {visibleItems.length}
                  {droppedDoneCount > 0 ? <> · {droppedDoneCount} done excluded</> : null}
                  )
                </span>
                {excludedIds.size > 0 ? (
                  <button
                    onClick={() => setExcludedIds(new Set())}
                    className="text-[11px] font-medium text-sky-700 hover:text-sky-900 normal-case"
                  >
                    Restore all
                  </button>
                ) : null}
              </div>
              {/* Sort + filter controls — keep this row terse so the
                  Shipments list directly below stays the focal point. */}
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter by id, tracking, customer, status…"
                    className="w-full text-xs pl-7 pr-2 py-1.5 rounded ring-1 ring-slate-200 focus:ring-sky-400 focus:outline-none"
                    aria-label="Filter included shipments"
                  />
                </div>
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
                  className="text-xs px-2 py-1.5 rounded ring-1 ring-slate-200 bg-white"
                  title="Sort the included shipments"
                >
                  <option value="task_oldest">Oldest first</option>
                  <option value="task_newest">Newest first</option>
                  <option value="shipment_status">By shipment status</option>
                  <option value="customer">By customer</option>
                </select>
              </div>
              <div className="rounded-lg ring-1 ring-slate-200 bg-slate-50 max-h-64 overflow-y-auto">
                {visibleItems.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-slate-500 text-center">
                    {search.trim() ? "No shipments match your filter." : "No active shipments left in this group."}
                  </div>
                ) : (
                <ul className="divide-y divide-slate-200">
                  {visibleItems.map((it) => {
                    const excluded = excludedIds.has(it.task.id);
                    const route = `${(it.shipment.origin || it.shipment.ship_from) || "?"} → ${(it.shipment.destination || it.shipment.ship_to) || "?"}`;
                    return (
                      <li key={it.task.id} className={`px-3 py-2 text-xs flex items-start gap-2 ${excluded ? "opacity-50" : ""}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`font-medium text-slate-900 shrink-0 ${excluded ? "line-through" : ""}`}>
                              {it.shipment.shipment_id || "(no shipment id)"}
                            </span>
                            <ShipmentStatusPill status={it.shipment.shipment_status} />
                            <span className="text-slate-600 ml-auto shrink-0 font-mono text-[11px]">
                              {it.shipment.tracking_number || ""}
                            </span>
                          </div>
                          <div className="text-slate-500 truncate mt-0.5">
                            {it.shipment.customer_name || "—"} · {route}
                          </div>
                          <div className="text-slate-700 truncate mt-0.5 flex items-center gap-2">
                            <span className="truncate">{it.task.title}</span>
                            <span className="shrink-0 text-[10px] text-slate-400" title={`Task created ${new Date(it.task.created_at).toLocaleString()}`}>
                              {fmtRelative(it.task.created_at)}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() => toggleExclude(it.task.id)}
                          className={
                            "shrink-0 p-1 rounded transition " +
                            (excluded
                              ? "text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                              : "text-slate-400 hover:text-rose-600 hover:bg-rose-50")
                          }
                          title={excluded ? "Re-include this shipment" : "Exclude this shipment from the next Generate"}
                          aria-label={excluded ? "Include shipment" : "Exclude shipment"}
                        >
                          {excluded ? <Plus className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                )}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
                Operator notes (optional, applied to next Generate)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the model should emphasize across the whole batch."
                className="w-full text-sm px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-sky-400 focus:outline-none min-h-[50px]"
              />
            </div>

            {err ? (
              <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800">{err}</div>
            ) : null}

            {selected ? (
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Subject</div>
                  <div className="text-sm font-medium text-slate-900 px-3 py-2 rounded-lg bg-slate-50 ring-1 ring-slate-200">
                    {selected.subject || "(no subject — model returned non-JSON)"}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Body</div>
                  <pre className="text-sm whitespace-pre-wrap text-slate-800 px-3 py-3 rounded-lg bg-slate-50 ring-1 ring-slate-200 leading-relaxed">{selected.body || selected.raw || "(empty)"}</pre>
                </div>
                <div className="text-[11px] text-slate-500 flex items-center gap-3 flex-wrap">
                  <span>Generated {fmtRelative(selected.created_at)}</span>
                  {selected.model ? <span>· <span className="font-mono">{selected.model}</span></span> : null}
                  {selected.cost_usd ? <span>· cost ${Number(selected.cost_usd).toFixed(4)}</span> : null}
                </div>
                {/* Prompt-quality rating. Reps mark drafts 👍 / 👎 so
                    the team can iterate. Clicking the active thumb
                    clears the rating. Both icon + label so the
                    affordance is unambiguous. The reason textarea is
                    only shown once a rating is set — the server
                    clears rating_reason whenever rating is null. */}
                <div className="flex flex-col gap-2 rounded-lg ring-1 ring-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-[11px] text-slate-500 leading-snug">
                      <span className="font-semibold text-slate-700">Was this draft useful?</span>
                      <span> Your feedback helps us tune the prompts.</span>
                      {selected.rated_by ? (
                        <span className="block text-slate-400 mt-0.5">
                          Last rated by {selected.rated_by} {selected.rated_at ? fmtRelative(selected.rated_at) : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => rateDraft("up")}
                        disabled={rateBusy}
                        className={
                          "inline-flex items-center gap-1 text-xs font-semibold rounded-md px-2.5 py-1.5 ring-1 transition disabled:opacity-50 " +
                          (selected.rating === "up"
                            ? "bg-emerald-600 text-white ring-emerald-700"
                            : "bg-white text-slate-700 ring-slate-200 hover:bg-emerald-50 hover:text-emerald-700 hover:ring-emerald-200")
                        }
                        aria-pressed={selected.rating === "up"}
                        title={selected.rating === "up" ? "Click again to clear" : "Mark this draft as useful"}
                      >
                        <ThumbsUp className="h-3.5 w-3.5" /> Good
                      </button>
                      <button
                        onClick={() => rateDraft("down")}
                        disabled={rateBusy}
                        className={
                          "inline-flex items-center gap-1 text-xs font-semibold rounded-md px-2.5 py-1.5 ring-1 transition disabled:opacity-50 " +
                          (selected.rating === "down"
                            ? "bg-rose-600 text-white ring-rose-700"
                            : "bg-white text-slate-700 ring-slate-200 hover:bg-rose-50 hover:text-rose-700 hover:ring-rose-200")
                        }
                        aria-pressed={selected.rating === "down"}
                        title={selected.rating === "down" ? "Click again to clear" : "Mark this draft as not useful"}
                      >
                        <ThumbsDown className="h-3.5 w-3.5" /> Needs work
                      </button>
                    </div>
                  </div>
                  {selected.rating ? (
                    <div className="flex items-start gap-2">
                      <textarea
                        value={draftReason}
                        onChange={(e) => setDraftReason(e.target.value.slice(0, 500))}
                        onBlur={saveDraftReason}
                        disabled={rateBusy || draftReasonSaving}
                        rows={2}
                        placeholder={selected.rating === "up"
                          ? "What worked? (optional) — feeds the next prompt iteration"
                          : "What was wrong? (optional) — feeds the next prompt iteration"}
                        className="w-full text-xs text-slate-700 rounded-md ring-1 ring-slate-200 bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50 resize-y"
                      />
                      {draftReasonSaving ? (
                        <span className="text-[10px] text-slate-400 mt-1.5 shrink-0">Saving…</span>
                      ) : draftReason.trim() && draftReason.trim() !== (draftReasonSaved || "").trim() ? (
                        <span className="text-[10px] text-slate-400 mt-1.5 shrink-0">Unsaved</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : !loadingDrafts && !busy ? (
              <div className="text-sm text-slate-500">
                No draft selected. Click <span className="font-semibold">Generate</span> below to write the first one for this {cfg.groupNoun}.
              </div>
            ) : null}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-between gap-3">
          <button
            onClick={generate}
            disabled={busy}
            className={`px-4 py-2 rounded-lg text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50 ${cfg.buttonTone}`}
          >
            {busy ? (
              <><RefreshCw className="h-4 w-4 animate-spin" /> Drafting…</>
            ) : drafts.length ? (
              <><RefreshCw className="h-4 w-4" /> Generate new draft</>
            ) : (
              <><Send className="h-4 w-4" /> Generate</>
            )}
          </button>
          {selected ? (
            <div className="flex items-center gap-3">
              <a
                href={`mailto:?subject=${encodeURIComponent(selected.subject || "")}&body=${encodeURIComponent(selected.body || "")}`}
                className="text-sm text-sky-700 hover:text-sky-900 font-medium"
              >Open in mail client →</a>
              <button
                onClick={copy}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 flex items-center gap-2"
              >
                {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Add-followup-task modal — opens from the "+ Add" button on a
// Followups panel. Picks a shipment via a search-driven combo, then
// creates a task whose title is auto-prefixed with the followup
// convention so it lands in the panel that triggered the modal.
// Status dropdown lets the operator drop the task directly into "In
// Progress" / "Blocked" instead of always starting at Open.
// =====================================================================
function AddFollowupTaskModal({ kind, onClose, onCreated }: {
  kind: FollowupKind;
  onClose: () => void;
  onCreated: () => void;
}) {
  const cfg = FOLLOWUP_KIND_CONFIG[kind];
  // Title prefix the panel matches against. We literally prepend this
  // so even if the operator types a barebones title ("missing POD"),
  // it'll still be detected by isCarrier/CustomerFollowupTitle on the
  // server. Hyphenated form not used because the matcher tolerates
  // both "follow up" and "followup".
  const titlePrefix = kind === "carrier" ? "Carrier followup: " : "Customer followup: ";
  const [shipmentQuery, setShipmentQuery] = useState("");
  const [shipmentResults, setShipmentResults] = useState<Shipment[]>([]);
  const [shipmentSearching, setShipmentSearching] = useState(false);
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [titleSuffix, setTitleSuffix] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [status, setStatus] = useState<"open" | "in_progress" | "blocked">("open");
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Debounced shipment search. Hits the existing /api/shipments?q=
  // search and shows the top hits; user clicks to lock one in.
  useEffect(() => {
    if (shipment) return; // already chose one — don't keep searching
    const q = shipmentQuery.trim();
    if (q.length < 2) { setShipmentResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setShipmentSearching(true);
      try {
        const r = await api.shipments.list({ q, limit: 25 });
        if (!cancelled) setShipmentResults(r.data || []);
      } catch (e) { if (!cancelled) setErr((e as Error).message); }
      finally { if (!cancelled) setShipmentSearching(false); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [shipmentQuery, shipment]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!shipment) { setErr("Pick a shipment first."); return; }
    const finalTitle = titlePrefix + (titleSuffix.trim() || (kind === "carrier" ? "follow-up needed" : "status update needed"));
    setBusy(true); setErr(null);
    try {
      await api.tasks.create(shipment.id, {
        title: finalTitle,
        description: description.trim() || undefined,
        priority,
        status,
        assigned_to: assignedTo || undefined,
      });
      onCreated();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Plus className={`h-5 w-5 ${cfg.iconTone}`} />
              Add {cfg.groupNoun} followup
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Title is auto-prefixed with <span className="font-mono">{titlePrefix.trim()}</span> so it lands in the {cfg.title} panel.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-2 rounded-lg hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {/* Shipment picker — type to filter, click a row to lock in. */}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
              Shipment
            </label>
            {shipment ? (
              <div className="flex items-center justify-between gap-2 rounded-lg ring-1 ring-slate-200 bg-slate-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900">
                    {shipment.shipment_id || shipment.tracking_number || "(no id)"}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {shipment.customer_name || "—"} · {shipment.carrier_name || shipment.carrier || "—"} · {shipment.shipment_status || "no status"}
                  </div>
                </div>
                <button
                  onClick={() => { setShipment(null); setShipmentQuery(""); }}
                  className="text-xs text-slate-500 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-100"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="search"
                    autoFocus
                    value={shipmentQuery}
                    onChange={(e) => setShipmentQuery(e.target.value)}
                    placeholder="Search by Shipment ID, tracking, customer, carrier…"
                    className="w-full rounded-lg border border-slate-200 pl-8 pr-3 py-2 text-sm focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none"
                  />
                </div>
                <div className="mt-2 rounded-lg ring-1 ring-slate-200 bg-white max-h-60 overflow-y-auto">
                  {shipmentSearching ? (
                    <div className="px-3 py-3 text-xs text-slate-500">Searching…</div>
                  ) : shipmentQuery.trim().length < 2 ? (
                    <div className="px-3 py-3 text-xs text-slate-500">Start typing to find a shipment.</div>
                  ) : shipmentResults.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-slate-500">No matches.</div>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {shipmentResults.map((s) => (
                        <li key={s.id}>
                          <button
                            onClick={() => setShipment(s)}
                            className="w-full text-left px-3 py-2 text-xs hover:bg-sky-50"
                          >
                            <div className="flex items-center justify-between gap-2 min-w-0">
                              <span className="font-semibold text-slate-900 truncate">
                                {s.shipment_id || "(no id)"}
                              </span>
                              <span className="text-slate-600 shrink-0 font-mono text-[11px]">
                                {s.tracking_number || ""}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 truncate">
                              {s.customer_name || "—"} · {s.carrier_name || s.carrier || "—"} · {s.shipment_status || "no status"}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Title — operator types only the meat; prefix is auto-prepended. */}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
              Title
            </label>
            <div className="flex items-stretch rounded-lg ring-1 ring-slate-200 overflow-hidden focus-within:ring-1 focus-within:ring-sky-200 focus-within:border-sky-400">
              <span className="px-3 py-2 text-sm font-mono text-slate-500 bg-slate-50 border-r border-slate-200 whitespace-nowrap">
                {titlePrefix.trim()}
              </span>
              <input
                type="text"
                value={titleSuffix}
                onChange={(e) => setTitleSuffix(e.target.value)}
                placeholder={kind === "carrier" ? "missing POD / pickup confirmation / ETA…" : "needs ETA / appointment / status update…"}
                className="flex-1 px-3 py-2 text-sm focus:outline-none"
              />
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Final title: <span className="font-mono">{titlePrefix}{titleSuffix.trim() || (kind === "carrier" ? "follow-up needed" : "status update needed")}</span>
            </div>
          </div>

          {/* Description, priority, status, assignee — three-up grid for the
              two enums + one text textarea on its own row. */}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything the assignee should know — context, blockers, due dates."
              className="w-full text-sm px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-sky-400 focus:outline-none min-h-[80px]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
              >
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
                Assignee
              </label>
              <UserPicker
                value={assignedTo}
                onChange={setAssignedTo}
                placeholder="Defaults to scraper"
                size="sm"
                className="w-full"
              />
            </div>
          </div>

          {err ? (
            <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800">{err}</div>
          ) : null}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !shipment}
            className={`px-4 py-2 rounded-lg text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${cfg.buttonTone}`}
          >
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {busy ? "Creating…" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Re-export so future modules can build on the same predicate without
// duplicating the rule.
export { isCarrierFollowupTitle };
