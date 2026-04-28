import { useEffect, useMemo, useState } from "react";
import { Search, ListChecks, X, Mail, Copy, Check, Plus, CircleCheck, Circle, Trash2, Download, ChevronLeft, ChevronRight, Keyboard } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime, fmtRelative, fmtUsd } from "../lib/format";
import type { AiAnalysis, EmailDraft, Shipment, ShipmentTask, TaskStatus } from "../lib/types";
import { ActionBadge } from "../components/Badge";
import { Drawer, Field, Section } from "../components/Drawer";
import { ShareButton } from "../components/ShareButton";
import { ColumnSelector } from "../components/ColumnSelector";
import { UserPicker } from "../components/UserPicker";
import {
  SHIPMENT_COLUMNS,
  loadColumnPrefs,
  saveColumnPrefs,
  type ColumnPrefs,
} from "../lib/shipmentColumns";
import { exportShipmentsXlsx } from "../lib/exportShipments";

// FreightPOP-style stat pills. Pills are mutually exclusive click-to-filter.
// Status matchers run against shipment_status; ISSUES uses action_required.
type PillId = "all" | "booked" | "in_transit" | "issues" | "out_for_delivery" | "delivered";
const STATUS_MATCHERS: Record<Exclude<PillId, "all" | "issues">, (s: string) => boolean> = {
  booked: (s) => /\bbooked\b|\btendered\b|pickup\s*scheduled|\bnew\b/i.test(s),
  in_transit: (s) => /in\s*transit|picked\s*up|en\s*route|departed|\btransit\b/i.test(s),
  out_for_delivery: (s) => /out\s+for\s+delivery|\bofd\b/i.test(s),
  // "Delivered" excludes "Out for Delivery" so the two pills don't double-count.
  delivered: (s) => /\bdelivered\b/i.test(s) && !/out\s+for\s+delivery/i.test(s),
};
function shipmentMatchesPill(r: Shipment, pill: PillId): boolean {
  if (pill === "all") return true;
  if (pill === "issues") return String(r.action_required || "").toUpperCase() === "YES";
  const status = String(r.shipment_status || "");
  return STATUS_MATCHERS[pill](status);
}

interface StatPillProps {
  label: string;
  count: number;
  active: boolean;
  tone: "gray" | "blue" | "green" | "teal";
  onClick: () => void;
}
function StatPill({ label, count, active, tone, onClick }: StatPillProps) {
  const TONES = {
    gray: { active: "bg-slate-900 text-white ring-slate-900", idle: "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50" },
    blue: { active: "bg-sky-600 text-white ring-sky-600", idle: "bg-white text-sky-700 ring-sky-200 hover:bg-sky-50" },
    green: { active: "bg-emerald-600 text-white ring-emerald-600", idle: "bg-white text-emerald-700 ring-emerald-200 hover:bg-emerald-50" },
    teal: { active: "bg-teal-600 text-white ring-teal-600", idle: "bg-white text-teal-700 ring-teal-200 hover:bg-teal-50" },
  } as const;
  const cls = active ? TONES[tone].active : TONES[tone].idle;
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-full ring-1 text-xs font-semibold uppercase tracking-wide shadow-sm transition ${cls}`}
    >
      <span>{label}</span>
      <span className={`tabular-nums text-sm font-bold ${active ? "text-white" : "text-slate-900"}`}>{count}</span>
    </button>
  );
}

interface ShipmentsPageProps {
  initialShipmentId?: string | null;
  drawerSection?: string | null;
  onShipmentConsumed?: () => void;
  onDrawerChange?: (id: string | null, section: string | null) => void;
  // When the drawer was entered via a /tasks/:taskId URL, the task-walk
  // context drives prev/next instead of the local `filtered` shipments list.
  // taskId is the focused task; prev / next are sibling task ids resolved
  // server-side. onWalk navigates to the sibling /tasks/:id route.
  taskWalk?: {
    taskId: string;
    task: ShipmentTask | null;
    prevTaskId: string | null;
    nextTaskId: string | null;
    index: number;
    total: number;
    onWalk: (taskId: string) => void;
    // Called after the task's status changes so the route can refresh the
    // sibling lookup (a Done task may drop out of the active scope, etc.).
    onTaskStatusChanged?: (status: TaskStatus) => void;
  } | null;
}

const DRAWER_TABS = ["overview", "tasks", "email", "drafts", "history", "raw"] as const;
type DrawerTabId = typeof DRAWER_TABS[number];
function asDrawerTab(s: string | null | undefined): DrawerTabId {
  return DRAWER_TABS.includes(s as DrawerTabId) ? (s as DrawerTabId) : "overview";
}

export function ShipmentsPage({ initialShipmentId, drawerSection, onShipmentConsumed, onDrawerChange, taskWalk }: ShipmentsPageProps = {}) {
  const [rows, setRows] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [pillFilter, setPillFilter] = useState<PillId>("all");

  const [columnPrefs, setColumnPrefs] = useState<ColumnPrefs>(() => loadColumnPrefs());
  useEffect(() => { saveColumnPrefs(columnPrefs); }, [columnPrefs]);
  const visibleColumns = useMemo(() => {
    const visible = new Set(columnPrefs.visibleIds);
    const byId = new Map(SHIPMENT_COLUMNS.map((c) => [c.id, c] as const));
    const out = [];
    for (const id of columnPrefs.orderIds) {
      const col = byId.get(id);
      if (col && visible.has(col.id)) out.push(col);
    }
    return out;
  }, [columnPrefs]);

  const [drawerId, setDrawerIdState] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<{ shipment: Shipment; analyses: AiAnalysis[]; tasks: ShipmentTask[] } | null>(null);
  // Wrap state changes so opening / closing the drawer also updates the URL.
  function setDrawerId(next: string | null) {
    setDrawerIdState(next);
    onDrawerChange?.(next, null);
  }

  // Bulk selection for "create task on N shipments at once".
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTitle, setBulkTitle] = useState("");
  const [bulkPriority, setBulkPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);

  // Per-shipment tasks shown inside the drawer.
  const [drawerTasks, setDrawerTasks] = useState<ShipmentTask[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskBusy, setNewTaskBusy] = useState(false);

  // Drawer notes — local draft, saved on demand.
  const [notesDraft, setNotesDraft] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  // CRM-style drawer keyboard navigation.
  const [drawerHelpOpen, setDrawerHelpOpen] = useState(false);

  // Email draft modal.
  const [emailModal, setEmailModal] = useState<{
    audience: "carrier" | "customer";
    data: EmailDraft | null;
    loading: boolean;
    copied: boolean;
  } | null>(null);

  // Action override modal (manual YES/NO/clear).
  const [overrideModal, setOverrideModal] = useState<null | { value: "YES" | "NO" | "RESOLVED" | null; reason: string; busy: boolean }>(null);

  // Re-analyze button state — busy flag prevents double-click during a Claude
  // round-trip (typically 2-3s).
  const [reanalyzing, setReanalyzing] = useState(false);

  // Task-walk: tracks whether the focused task's status update is in flight,
  // and whether the user has opted in to inline action overrides on the
  // shipment. Default off — clicking the checkbox reveals YES / NO / Resolved
  // quick buttons next to the existing "Override" link.
  const [taskBusy, setTaskBusy] = useState(false);
  const [actionEditOptIn, setActionEditOptIn] = useState(false);
  const [actionEditBusy, setActionEditBusy] = useState(false);

  // "Export all" pulls every shipment fresh (ignores filters / pill / search)
  // so the workbook reflects the database, not the current view.
  const [exporting, setExporting] = useState(false);
  async function exportAll() {
    if (exporting) return;
    setExporting(true); setErr(null);
    try {
      const r = await api.shipments.list({ limit: 5000 });
      if (!r.data?.length) {
        setErr("No shipments to export.");
        return;
      }
      exportShipmentsXlsx(r.data);
    } catch (e) { setErr((e as Error).message); }
    finally { setExporting(false); }
  }

  async function load() {
    setLoading(true); setErr(null);
    try {
      // Initial render is what users feel — keep it tight. Daily volume sits
      // around 200 rows; 500 is generous headroom. Export pulls the full
      // 5000-cap separately so this doesn't bound that workflow.
      const r = await api.shipments.list({ limit: 500 });
      setRows(r.data);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // When the URL says a shipment is open, mirror it into local state. The
  // initialShipmentId / drawerSection props are sourced from useParams in App.tsx.
  // We use the raw setter here so syncing FROM the URL doesn't push back to it.
  useEffect(() => {
    if (initialShipmentId !== undefined) {
      setDrawerIdState(initialShipmentId || null);
      onShipmentConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialShipmentId]);

  // Drawer-level tab navigation. The URL drives this — `drawerSection` is the
  // route param, and we mirror it locally so existing handlers don't need to
  // round-trip through navigate() to read the current sub-tab.
  const [drawerTab, setDrawerTabState] = useState<DrawerTabId>(asDrawerTab(drawerSection));
  useEffect(() => {
    setDrawerTabState(asDrawerTab(drawerSection));
  }, [drawerSection]);
  function setDrawerTab(next: DrawerTabId) {
    setDrawerTabState(next);
    if (drawerId) onDrawerChange?.(drawerId, next === "overview" ? null : next);
  }

  useEffect(() => {
    if (!drawerId) {
      setDrawerData(null);
      setDrawerTasks([]);
      setDrawerTabState("overview");
      setEmailModal(null);
      setNewTaskTitle("");
      setNotesDraft("");
      setNotesSaved(false);
      return;
    }
    api.shipments.get(drawerId)
      .then((d) => {
        setDrawerData(d);
        setDrawerTasks(d.tasks || []);
        setNotesDraft(d.shipment.notes || "");
        setNotesSaved(false);
      })
      .catch(() => { setDrawerData(null); setDrawerTasks([]); });
  }, [drawerId]);

  async function saveNotes() {
    if (!drawerId || notesBusy) return;
    setNotesBusy(true);
    setNotesSaved(false);
    try {
      const r = await api.shipments.updateNotes(drawerId, notesDraft.trim() ? notesDraft : null);
      setDrawerData((p) => p ? { ...p, shipment: r.shipment } : p);
      setRows((prev) => prev.map((row) => row.id === r.shipment.id ? { ...row, notes: r.shipment.notes } : row));
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 1800);
    } catch (e) { setErr((e as Error).message); }
    finally { setNotesBusy(false); }
  }

  async function addDrawerTask() {
    if (!drawerId || !newTaskTitle.trim()) return;
    setNewTaskBusy(true);
    try {
      const r = await api.tasks.create(drawerId, { title: newTaskTitle.trim() });
      setDrawerTasks((p) => [r.task, ...p]);
      setNewTaskTitle("");
    } catch (e) { setErr((e as Error).message); }
    finally { setNewTaskBusy(false); }
  }
  async function toggleDrawerTask(t: ShipmentTask) {
    const status: TaskStatus = t.status === "done" ? "open" : "done";
    try {
      const r = await api.tasks.update(t.id, { status });
      setDrawerTasks((p) => p.map((x) => (x.id === r.task.id ? r.task : x)));
    } catch (e) { setErr((e as Error).message); }
  }
  async function openEmailDraft(audience: "carrier" | "customer") {
    if (!drawerId) return;
    setEmailModal({ audience, data: null, loading: true, copied: false });
    try {
      const draft = await api.emailDraft.generate(drawerId, audience);
      setEmailModal({ audience, data: draft, loading: false, copied: false });
    } catch (e) {
      setEmailModal({ audience, data: { subject: "Error", body: (e as Error).message }, loading: false, copied: false });
    }
  }
  async function copyEmail() {
    if (!emailModal?.data) return;
    const txt = `Subject: ${emailModal.data.subject}\n\n${emailModal.data.body}`;
    try { await navigator.clipboard.writeText(txt); } catch {}
    setEmailModal({ ...emailModal, copied: true });
    setTimeout(() => setEmailModal((m) => (m ? { ...m, copied: false } : m)), 1500);
  }

  // Parse a stored AI analysis row into a friendly shape for rendering.
  // Email drafts get their JSON parsed; per-shipment analyses surface
  // issue + recommendation instead of dumping the raw JSON response.
  function parseAnalysis(a: AiAnalysis): {
    flavor: "email_draft" | "shipment" | "summary" | "raw";
    audience?: "carrier" | "customer";
    subject?: string;
    body?: string;
    issue?: string | null;
    recommendation?: string | null;
    raw?: string;
  } {
    const meta = (a.metadata || {}) as Record<string, unknown>;
    const subkind = typeof meta.subkind === "string" ? meta.subkind : "";
    if (a.kind === "other" && subkind.startsWith("email_draft_")) {
      let subject = "";
      let body = "";
      if (a.response_text) {
        const m = a.response_text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const obj = JSON.parse(m[0]);
            subject = String(obj.subject || "");
            body = String(obj.body || "");
          } catch { body = a.response_text; }
        } else { body = a.response_text; }
      }
      return { flavor: "email_draft", audience: subkind.includes("carrier") ? "carrier" : "customer", subject, body };
    }
    if (a.kind === "per_shipment") {
      return { flavor: "shipment", issue: a.issue, recommendation: a.recommendation };
    }
    if (a.kind === "summary") {
      return { flavor: "summary", body: a.response_text || "" };
    }
    return { flavor: "raw", raw: a.response_text || "" };
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  async function applyOverride() {
    if (!drawerId || !overrideModal) return;
    setOverrideModal({ ...overrideModal, busy: true });
    try {
      const r = await api.shipments.overrideAction(drawerId, {
        action_required: overrideModal.value,
        reason: overrideModal.reason || undefined,
      });
      // Refresh drawer + table
      setDrawerData((prev) => prev ? { ...prev, shipment: r.shipment } : prev);
      setRows((prev) => prev.map((row) => row.id === r.shipment.id ? r.shipment : row));
      setOverrideModal(null);
    } catch (e) {
      setOverrideModal({ ...overrideModal, busy: false });
      setErr((e as Error).message);
    }
  }

  const customers = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.customer_name) set.add(r.customer_name);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!shipmentMatchesPill(r, pillFilter)) return false;
      if (actionFilter && String(r.action_required || "").toUpperCase() !== actionFilter) return false;
      if (customerFilter && r.customer_name !== customerFilter) return false;
      if (sourceFilter && r.action_source !== sourceFilter) return false;
      if (q) {
        const hay = [r.tracking_number, r.customer_name, r.carrier_name, r.carrier, r.ai_issue, r.shipment_status]
          .map((x) => (x || "").toLowerCase()).join(" ");
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, q, actionFilter, customerFilter, sourceFilter, pillFilter]);

  // Drawer position within the filtered list, used for "X of Y" + prev/next.
  // When taskWalk is active the position comes from the task list instead.
  const drawerIndex = useMemo(() => {
    if (taskWalk) return taskWalk.index;
    if (!drawerId) return -1;
    return filtered.findIndex((r) => r.id === drawerId);
  }, [filtered, drawerId, taskWalk]);
  // In task-walk mode prev/next is a thin shim — clicking the chevron just
  // navigates to the sibling /tasks/:id; the route loader does the resolution.
  const drawerHasPrev = taskWalk ? !!taskWalk.prevTaskId : drawerIndex > 0;
  const drawerHasNext = taskWalk ? !!taskWalk.nextTaskId : (drawerIndex >= 0 && drawerIndex < filtered.length - 1);
  const drawerTotal = taskWalk ? taskWalk.total : filtered.length;
  const drawerPrev = !taskWalk && drawerIndex > 0 ? filtered[drawerIndex - 1] : null;
  const drawerNext = !taskWalk && drawerIndex >= 0 && drawerIndex < filtered.length - 1 ? filtered[drawerIndex + 1] : null;
  function walkPrev() {
    if (taskWalk?.prevTaskId) { taskWalk.onWalk(taskWalk.prevTaskId); return; }
    if (drawerPrev) setDrawerId(drawerPrev.id);
  }
  function walkNext() {
    if (taskWalk?.nextTaskId) { taskWalk.onWalk(taskWalk.nextTaskId); return; }
    if (drawerNext) setDrawerId(drawerNext.id);
  }

  // Keyboard shortcuts that fire only while the drawer is open. CRM-style:
  // step through the filtered list, jump to a tab, run the common drawer
  // actions (re-analyze, override, share), close. Pause whenever the user
  // is typing in any input/textarea so notes editing isn't disrupted.
  useEffect(() => {
    if (!drawerId) return;
    function isTypingInField(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (drawerHelpOpen) {
        if (e.key === "Escape") { e.preventDefault(); setDrawerHelpOpen(false); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingInField(e.target)) return;

      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setDrawerHelpOpen(true);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDrawerId(null);
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown" || e.key === "n" || e.key === "ArrowRight") {
        e.preventDefault();
        walkNext();
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp" || e.key === "p" || e.key === "ArrowLeft") {
        e.preventDefault();
        walkPrev();
        return;
      }
      // Tab shortcuts — match the order in the drawer's tab bar.
      const tabMap: Record<string, DrawerTabId> = {
        "1": "overview",
        "2": "tasks",
        "3": "email",
        "4": "drafts",
        "5": "history",
        "6": "raw",
      };
      if (tabMap[e.key]) {
        e.preventDefault();
        setDrawerTab(tabMap[e.key]);
        return;
      }
      // Quick actions on the focused shipment.
      if (e.key === "o") {
        e.preventDefault();
        if (drawerData) {
          setOverrideModal({
            value: drawerData.shipment.action_required === "YES" ? "NO" : "YES",
            reason: "",
            busy: false,
          });
        }
        return;
      }
      if (e.key === "r") {
        e.preventDefault();
        if (!drawerId || reanalyzing) return;
        setReanalyzing(true);
        api.shipments.reanalyze(drawerId)
          .then((r) => {
            setDrawerData((p) => p ? { ...p, shipment: r.shipment } : p);
            setRows((prev) => prev.map((row) => row.id === r.shipment.id ? r.shipment : row));
          })
          .catch((err) => setErr((err as Error).message))
          .finally(() => setReanalyzing(false));
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerId, drawerHelpOpen, drawerPrev, drawerNext, drawerData, reanalyzing, taskWalk]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id));
  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) for (const r of filtered) next.delete(r.id);
      else for (const r of filtered) next.add(r.id);
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }

  async function submitBulk() {
    if (!bulkTitle.trim() || selectedIds.size === 0) return;
    setBulkSubmitting(true); setBulkResult(null);
    try {
      const r = await api.tasks.bulkCreate({
        shipment_ids: Array.from(selectedIds),
        title: bulkTitle.trim(),
        priority: bulkPriority,
        assigned_to: bulkAssignee.trim() || undefined,
      });
      setBulkResult(`Created ${r.created} task${r.created === 1 ? "" : "s"}` + (r.missing.length ? ` · ${r.missing.length} not found` : ""));
      setBulkTitle(""); setBulkAssignee("");
      clearSelection();
      setTimeout(() => { setBulkOpen(false); setBulkResult(null); }, 1500);
    } catch (e) {
      setBulkResult("Error: " + (e as Error).message);
    } finally {
      setBulkSubmitting(false);
    }
  }

  const pillCounts = useMemo(() => ({
    total: rows.length,
    booked: rows.filter((r) => shipmentMatchesPill(r, "booked")).length,
    in_transit: rows.filter((r) => shipmentMatchesPill(r, "in_transit")).length,
    issues: rows.filter((r) => shipmentMatchesPill(r, "issues")).length,
    out_for_delivery: rows.filter((r) => shipmentMatchesPill(r, "out_for_delivery")).length,
    delivered: rows.filter((r) => shipmentMatchesPill(r, "delivered")).length,
  }), [rows]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <StatPill label="Total"            count={pillCounts.total}            tone="gray"  active={pillFilter === "all"}              onClick={() => setPillFilter("all")} />
        <StatPill label="Booked"           count={pillCounts.booked}           tone="blue"  active={pillFilter === "booked"}           onClick={() => setPillFilter(pillFilter === "booked" ? "all" : "booked")} />
        <StatPill label="In Transit"       count={pillCounts.in_transit}       tone="blue"  active={pillFilter === "in_transit"}       onClick={() => setPillFilter(pillFilter === "in_transit" ? "all" : "in_transit")} />
        <StatPill label="Issues"           count={pillCounts.issues}           tone="blue"  active={pillFilter === "issues"}           onClick={() => setPillFilter(pillFilter === "issues" ? "all" : "issues")} />
        <StatPill label="Out for Delivery" count={pillCounts.out_for_delivery} tone="green" active={pillFilter === "out_for_delivery"} onClick={() => setPillFilter(pillFilter === "out_for_delivery" ? "all" : "out_for_delivery")} />
        <StatPill label="Delivered"        count={pillCounts.delivered}        tone="teal"  active={pillFilter === "delivered"}        onClick={() => setPillFilter(pillFilter === "delivered" ? "all" : "delivered")} />
      </div>

      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row gap-2 md:items-center">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
              placeholder="Search tracking, customer, carrier, issue…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">All actions</option>
            <option value="YES">Action needed</option>
            <option value="NO">On track</option>
            <option value="ERROR">Error</option>
          </select>
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm max-w-[220px]"
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
          >
            <option value="">All customers</option>
            {customers.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            title="Action set by AI vs. manually overridden"
          >
            <option value="">All sources</option>
            <option value="ai">From AI</option>
            <option value="manual">Manual override</option>
          </select>
          <ColumnSelector prefs={columnPrefs} onChange={setColumnPrefs} />
          <button
            onClick={exportAll}
            disabled={exporting}
            title="Download every shipment as a branded XLSX"
            className="px-3 py-2 text-sm font-semibold rounded-lg text-white bg-gradient-to-br from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 shadow-sm ring-1 ring-sky-600/20 disabled:opacity-60 disabled:cursor-default inline-flex items-center gap-1.5"
          >
            <Download className="h-4 w-4" />
            {exporting ? "Exporting…" : "Export all"}
          </button>
          <button
            onClick={load}
            className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800"
          >
            Refresh
          </button>
        </div>

        {err ? (
          <div className="p-4 bg-rose-50 border-b border-rose-200 text-rose-800 text-sm">
            {err}
          </div>
        ) : null}

        {selectedIds.size > 0 ? (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-sky-50 border-b border-sky-200 text-sm">
            <span className="font-medium text-sky-900">{selectedIds.size} selected</span>
            <button
              onClick={() => setBulkOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 flex items-center gap-1.5"
            >
              <ListChecks className="h-4 w-4" /> Bulk-create task
            </button>
            <button
              onClick={() => setBulkDeleteOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-medium hover:bg-rose-700 flex items-center gap-1.5"
            >
              <Trash2 className="h-4 w-4" /> Bulk delete
            </button>
            <button onClick={clearSelection} className="text-xs text-sky-700 hover:text-sky-900 flex items-center gap-1">
              <X className="h-3.5 w-3.5" /> Clear selection
            </button>
          </div>
        ) : null}

        <div className="overflow-auto max-h-[calc(100vh-340px)]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 backdrop-blur sticky top-0">
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    aria-label="Select all"
                    className="cursor-pointer"
                  />
                </th>
                {visibleColumns.map((col) => (
                  <th key={col.id} className="px-4 py-2.5 font-medium">{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={visibleColumns.length + 1} className="p-8 text-center text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={visibleColumns.length + 1} className="p-8 text-center text-slate-500">No shipments match your filters.</td></tr>
              ) : filtered.map((r) => (
                <tr
                  key={r.id}
                  className={(selectedIds.has(r.id) ? "bg-sky-50/70 " : "") + "hover:bg-sky-50/50"}
                >
                  <td className="px-3 py-2.5 w-10" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      aria-label={`Select ${r.tracking_number}`}
                      className="cursor-pointer"
                    />
                  </td>
                  {visibleColumns.map((col) => (
                    <td
                      key={col.id}
                      onClick={() => setDrawerId(r.id)}
                      className={"px-4 py-2.5 cursor-pointer " + (col.tdClass || "")}
                      title={col.title?.(r)}
                    >
                      {col.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {bulkOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={() => !bulkSubmitting && setBulkOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1">Bulk-create task</h2>
            <p className="text-sm text-slate-500 mb-4">Creates one task on each of the {selectedIds.size} selected shipments. If no assignee is set, each task auto-assigns to whoever scraped that shipment.</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">Title</label>
                <input
                  value={bulkTitle}
                  onChange={(e) => setBulkTitle(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="e.g. Follow up with carrier on missed delivery"
                  required
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Priority</label>
                  <select
                    value={bulkPriority}
                    onChange={(e) => setBulkPriority(e.target.value as typeof bulkPriority)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Assignee (override)</label>
                  <UserPicker
                    value={bulkAssignee || null}
                    onChange={(v) => setBulkAssignee(v || "")}
                    placeholder="(blank = runner)"
                  />
                </div>
              </div>
              {bulkResult ? <div className="text-sm text-emerald-700">{bulkResult}</div> : null}
              <div className="flex gap-2 justify-end pt-2">
                <button
                  onClick={() => setBulkOpen(false)}
                  disabled={bulkSubmitting}
                  className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100"
                >Cancel</button>
                <button
                  onClick={submitBulk}
                  disabled={bulkSubmitting || !bulkTitle.trim()}
                  className="px-4 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                >{bulkSubmitting ? "Creating…" : `Create ${selectedIds.size} task${selectedIds.size === 1 ? "" : "s"}`}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {bulkDeleteOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={() => !bulkDeleteBusy && setBulkDeleteOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1 flex items-center gap-2 text-rose-700">
              <Trash2 className="h-5 w-5" /> Delete {selectedIds.size} shipment{selectedIds.size === 1 ? "" : "s"}?
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              This permanently removes the selected shipments and any open tasks attached to them. AI analysis history is kept (the shipment link is just cleared). This cannot be undone — if these tracking numbers re-scrape later they'll come back as fresh rows.
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setBulkDeleteOpen(false)}
                disabled={bulkDeleteBusy}
                className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100"
              >Cancel</button>
              <button
                onClick={async () => {
                  setBulkDeleteBusy(true);
                  try {
                    const r = await api.shipments.bulkDelete(Array.from(selectedIds));
                    setRows((prev) => prev.filter((row) => !selectedIds.has(row.id)));
                    clearSelection();
                    setBulkDeleteOpen(false);
                    setBulkResult(`Deleted ${r.deleted} shipment${r.deleted === 1 ? "" : "s"}.`);
                    setTimeout(() => setBulkResult(null), 4000);
                  } catch (e) { setErr((e as Error).message); }
                  setBulkDeleteBusy(false);
                }}
                disabled={bulkDeleteBusy}
                className="px-4 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Trash2 className="h-4 w-4" />
                {bulkDeleteBusy ? "Deleting…" : `Delete ${selectedIds.size}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Drawer
        open={!!drawerId}
        onClose={() => setDrawerId(null)}
        title={drawerData?.shipment.tracking_number || "Shipment"}
        subtitle={drawerData?.shipment.customer_name || undefined}
      >
        {drawerData ? (
          <>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div className="inline-flex items-center rounded-lg ring-1 ring-slate-200 bg-white">
                <button
                  type="button"
                  onClick={walkPrev}
                  disabled={!drawerHasPrev}
                  title={drawerHasPrev ? (taskWalk ? "Previous task (k / ←)" : `Previous: ${drawerPrev?.tracking_number || ""} (k / ←)`) : "No previous"}
                  className="px-2 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed rounded-l-lg"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="px-2 text-xs text-slate-600 tabular-nums whitespace-nowrap select-none border-x border-slate-200 self-stretch flex items-center">
                  {taskWalk ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-violet-700 font-semibold">Task</span>
                      <span>{drawerIndex + 1} of {drawerTotal}</span>
                    </span>
                  ) : (
                    drawerIndex >= 0 ? `${drawerIndex + 1} of ${drawerTotal}` : "—"
                  )}
                </div>
                <button
                  type="button"
                  onClick={walkNext}
                  disabled={!drawerHasNext}
                  title={drawerHasNext ? (taskWalk ? "Next task (j / →)" : `Next: ${drawerNext?.tracking_number || ""} (j / →)`) : "No next"}
                  className="px-2 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed rounded-r-lg"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDrawerHelpOpen(true)}
                  className="text-xs px-2.5 py-1.5 rounded-md bg-white ring-1 ring-slate-200 text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5"
                  title="Keyboard shortcuts (?)"
                >
                  <Keyboard className="h-3.5 w-3.5" /> Shortcuts
                </button>
                <ShareButton
                  resourceType="shipment"
                  resourceId={drawerData.shipment.id}
                  defaultLabel={`Shipment ${drawerData.shipment.tracking_number || ""}`.trim()}
                />
              </div>
            </div>
            <div className="flex gap-1 border-b border-slate-200 mb-5 -mx-1 px-1 overflow-x-auto">
              {([
                { id: "overview", label: "Overview", count: null },
                { id: "tasks", label: "Tasks", count: drawerTasks.length },
                { id: "email", label: "Email", count: null },
                { id: "drafts", label: "Drafts", count: drawerData.analyses.filter((a) => a.kind === "other" && typeof (a.metadata as Record<string, unknown>)?.subkind === "string" && String((a.metadata as Record<string, unknown>).subkind).startsWith("email_draft_")).length },
                { id: "history", label: "Analysis", count: drawerData.analyses.filter((a) => a.kind === "per_shipment" || a.kind === "summary").length },
                { id: "raw", label: "Raw", count: null },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setDrawerTab(t.id)}
                  className={
                    "px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition " +
                    (drawerTab === t.id
                      ? "border-sky-500 text-sky-700"
                      : "border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300")
                  }
                >
                  {t.label}
                  {t.count != null && t.count > 0 ? (
                    <span className="ml-1.5 inline-flex items-center justify-center text-[10px] font-semibold bg-slate-200 text-slate-700 rounded-full px-1.5 py-0.5 min-w-[18px]">{t.count}</span>
                  ) : null}
                </button>
              ))}
            </div>

            {taskWalk?.task ? (
              <TaskBanner
                task={taskWalk.task}
                busy={taskBusy}
                onSetStatus={async (status) => {
                  if (!taskWalk?.task) return;
                  setTaskBusy(true);
                  try {
                    await api.tasks.update(taskWalk.task.id, { status });
                    taskWalk.onTaskStatusChanged?.(status);
                  } catch (e) { setErr((e as Error).message); }
                  finally { setTaskBusy(false); }
                }}
              />
            ) : null}

            {drawerTab === "overview" && (
              <>
                <Section title="Shipment">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Carrier">{drawerData.shipment.carrier_name || drawerData.shipment.carrier}</Field>
                    <Field label="Mode">{drawerData.shipment.mode}</Field>
                    <Field label="Status">{drawerData.shipment.shipment_status}</Field>
                    <div className="flex flex-col gap-0.5">
                      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Action</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <ActionBadge action={drawerData.shipment.action_required} />
                        <span className={
                          "text-[10px] px-2 py-0.5 rounded-full font-medium " +
                          (drawerData.shipment.action_source === "manual"
                            ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
                            : "bg-slate-100 text-slate-600")
                        } title={
                          drawerData.shipment.action_source === "manual"
                            ? `Overridden by ${drawerData.shipment.action_overridden_by || "?"}${drawerData.shipment.action_override_reason ? ` — ${drawerData.shipment.action_override_reason}` : ""}`
                            : "Set by AI"
                        }>
                          {drawerData.shipment.action_source === "manual" ? "Manual" : "From AI"}
                        </span>
                        <button
                          onClick={() => setOverrideModal({ value: drawerData.shipment.action_required === "YES" ? "NO" : "YES", reason: "", busy: false })}
                          className="text-[11px] text-sky-700 hover:text-sky-900 underline"
                        >Override</button>
                        {/* Opt-in to inline modify — keeps accidental clicks
                            from flipping the action. Once ticked, three
                            single-click quick actions appear below. */}
                        <label className="inline-flex items-center gap-1 text-[11px] text-slate-500 cursor-pointer select-none ml-1">
                          <input
                            type="checkbox"
                            checked={actionEditOptIn}
                            onChange={(e) => setActionEditOptIn(e.target.checked)}
                            className="h-3 w-3 rounded border-slate-300"
                          />
                          Modify
                        </label>
                      </div>
                      {actionEditOptIn ? (
                        <div className="mt-1.5 inline-flex items-center gap-1.5 flex-wrap">
                          {(["YES", "NO", "RESOLVED"] as const).map((v) => {
                            const active = drawerData.shipment.action_required === v;
                            const tone = v === "YES"
                              ? "bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100"
                              : v === "NO"
                              ? "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100"
                              : "bg-violet-50 text-violet-700 ring-violet-200 hover:bg-violet-100";
                            return (
                              <button
                                key={v}
                                disabled={actionEditBusy || active}
                                onClick={async () => {
                                  if (!drawerId) return;
                                  setActionEditBusy(true);
                                  try {
                                    await api.shipments.overrideAction(drawerId, { action_required: v });
                                    const r = await api.shipments.get(drawerId);
                                    setDrawerData(r);
                                    setRows((prev) => prev.map((row) => row.id === drawerId ? r.shipment : row));
                                  } catch (e) { setErr((e as Error).message); }
                                  finally { setActionEditBusy(false); }
                                }}
                                className={`text-[11px] font-semibold rounded-md px-2 py-0.5 ring-1 transition ${tone} disabled:opacity-50 disabled:cursor-not-allowed`}
                                title={active ? "Already set" : `Set action to ${v}`}
                              >
                                {v === "RESOLVED" ? "Resolved" : v}
                              </button>
                            );
                          })}
                          <button
                            disabled={actionEditBusy || drawerData.shipment.action_source !== "manual"}
                            onClick={async () => {
                              if (!drawerId) return;
                              setActionEditBusy(true);
                              try {
                                await api.shipments.overrideAction(drawerId, { action_required: null });
                                const r = await api.shipments.get(drawerId);
                                setDrawerData(r);
                                setRows((prev) => prev.map((row) => row.id === drawerId ? r.shipment : row));
                              } catch (e) { setErr((e as Error).message); }
                              finally { setActionEditBusy(false); }
                            }}
                            className="text-[11px] text-slate-600 hover:text-slate-900 underline disabled:opacity-40 disabled:no-underline"
                            title="Clear override and let the AI value stand"
                          >
                            Revert to AI
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <Field label="Pickup">{fmtDateTime(drawerData.shipment.pickup_date)}</Field>
                    <Field label="ETA">{fmtDateTime(drawerData.shipment.updated_eta)}</Field>
                    <Field label="Delivery">{fmtDateTime(drawerData.shipment.delivery_date)}</Field>
                    <Field label="Signed By">{drawerData.shipment.signed_by}</Field>
                    <Field label="Origin">{drawerData.shipment.ship_from || drawerData.shipment.origin}</Field>
                    <Field label="Destination">{drawerData.shipment.ship_to || drawerData.shipment.destination}</Field>
                    <Field label="GP">{drawerData.shipment.shipment_gross_profit}</Field>
                    <Field label="Rate (marked up)">{drawerData.shipment.shipment_marked_up_rate}</Field>
                  </div>
                </Section>
                <Section title="AI summary">
                  <div className="flex justify-end mb-2">
                    <button
                      disabled={reanalyzing || !drawerId}
                      onClick={async () => {
                        if (!drawerId || reanalyzing) return;
                        setReanalyzing(true);
                        try {
                          const r = await api.shipments.reanalyze(drawerId);
                          setDrawerData((p) => p ? { ...p, shipment: r.shipment } : p);
                          setRows((prev) => prev.map((row) => row.id === r.shipment.id ? r.shipment : row));
                        } catch (e) { setErr((e as Error).message); }
                        finally { setReanalyzing(false); }
                      }}
                      className="text-xs px-2.5 py-1 rounded-md bg-sky-50 text-sky-700 ring-1 ring-sky-200 hover:bg-sky-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                      title="Run per-shipment AI analysis again"
                    >
                      <span className={reanalyzing ? "inline-block animate-spin" : ""}>↻</span>
                      {reanalyzing ? "Analyzing…" : "Re-analyze"}
                    </button>
                  </div>
                  <Field label="Issue">{drawerData.shipment.ai_issue}</Field>
                  <div className="h-3" />
                  <Field label="Recommendation">{drawerData.shipment.ai_recommendation}</Field>
                </Section>
                <Section title="Notes">
                  <textarea
                    value={notesDraft}
                    onChange={(e) => { setNotesDraft(e.target.value); setNotesSaved(false); }}
                    placeholder="Add operator notes for this shipment…"
                    rows={4}
                    maxLength={5000}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
                  />
                  <div className="mt-2 flex items-center justify-end gap-3">
                    {notesSaved ? <span className="text-xs text-emerald-600">Saved</span> : null}
                    <button
                      onClick={saveNotes}
                      disabled={notesBusy || (notesDraft || "") === (drawerData.shipment.notes || "")}
                      className="text-xs px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {notesBusy ? "Saving…" : "Save notes"}
                    </button>
                  </div>
                </Section>
              </>
            )}

            {drawerTab === "tasks" && (
              <Section title={`Tasks (${drawerTasks.length})`}>
                <div className="flex gap-2 mb-4">
                  <input
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addDrawerTask(); }}
                    placeholder="New task title…"
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm"
                  />
                  <button
                    onClick={addDrawerTask}
                    disabled={!newTaskTitle.trim() || newTaskBusy}
                    className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Plus className="h-4 w-4" /> Add
                  </button>
                </div>
                {drawerTasks.length === 0 ? (
                  <div className="text-sm text-slate-500 text-center py-6">No tasks yet. Auto-assigned to <b>{drawerData.shipment.created_by || "—"}</b> when created here.</div>
                ) : (
                  <ul className="space-y-2">
                    {drawerTasks.map((t) => (
                      <li key={t.id} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 ring-1 ring-slate-200">
                        <button
                          onClick={() => toggleDrawerTask(t)}
                          className="text-slate-500 hover:text-slate-900 mt-0.5"
                          aria-label={t.status === "done" ? "Mark incomplete" : "Mark done"}
                        >
                          {t.status === "done"
                            ? <CircleCheck className="h-5 w-5 text-emerald-600" />
                            : <Circle className="h-5 w-5" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className={"text-sm " + (t.status === "done" ? "line-through text-slate-400" : "text-slate-900 font-medium")}>{t.title}</div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {t.assigned_to ? <>Assigned to <b>{t.assigned_to}</b> · </> : null}
                            {t.priority} · {fmtRelative(t.created_at)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            {drawerTab === "email" && (
              <Section title="Email drafts">
                <p className="text-sm text-slate-500 mb-4">Generate a Claude-drafted follow-up email using this shipment's context.</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => openEmailDraft("carrier")}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
                  >
                    <Mail className="h-4 w-4" /> Email carrier
                  </button>
                  <button
                    onClick={() => openEmailDraft("customer")}
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-sky-600 text-white text-sm font-medium hover:bg-sky-700"
                  >
                    <Mail className="h-4 w-4" /> Email customer
                  </button>
                </div>
                <div className="mt-4 text-xs text-slate-500">
                  Drafts use the shipment status, dates, addresses, and AI issue context. You can copy or send via your default mail client after generation.
                </div>
              </Section>
            )}

            {drawerTab === "drafts" && (() => {
              const drafts = drawerData.analyses
                .filter((a) => a.kind === "other" && typeof (a.metadata as Record<string, unknown>)?.subkind === "string" && String((a.metadata as Record<string, unknown>).subkind).startsWith("email_draft_"))
                .map((a) => ({ a, parsed: parseAnalysis(a) }));
              return (
                <Section title={`Saved email drafts (${drafts.length})`}>
                  {drafts.length === 0 ? (
                    <div className="text-sm text-slate-500">No saved drafts. Generate one from the Email tab.</div>
                  ) : drafts.map(({ a, parsed }) => (
                    <div key={a.id} className="rounded-xl bg-white ring-1 ring-slate-200 p-4 mb-3">
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                        <div className="flex items-center gap-2">
                          <span className={"text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full " + (parsed.audience === "carrier" ? "bg-slate-200 text-slate-700" : "bg-sky-100 text-sky-700")}>
                            {parsed.audience === "carrier" ? "Carrier" : "Customer"}
                          </span>
                          <span>{fmtDateTime(a.created_at)}</span>
                        </div>
                        <span className="text-slate-500">{fmtUsd(a.cost_usd)}</span>
                      </div>
                      {parsed.subject ? (
                        <div className="text-sm font-semibold text-slate-900 mb-2">{parsed.subject}</div>
                      ) : null}
                      <pre className="text-sm whitespace-pre-wrap font-sans text-slate-700 leading-relaxed bg-slate-50 ring-1 ring-slate-200 rounded-lg p-3 max-h-72 overflow-auto">{parsed.body || "(empty)"}</pre>
                      <div className="flex items-center justify-end gap-3 mt-2">
                        {parsed.subject || parsed.body ? (
                          <a
                            href={`mailto:?subject=${encodeURIComponent(parsed.subject || "")}&body=${encodeURIComponent(parsed.body || "")}`}
                            className="text-xs text-sky-700 hover:text-sky-900 font-medium"
                          >Open in mail →</a>
                        ) : null}
                        <button
                          onClick={() => copyText(`Subject: ${parsed.subject || ""}\n\n${parsed.body || ""}`)}
                          className="text-xs px-2 py-1 rounded-lg bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1"
                        >
                          <Copy className="h-3 w-3" /> Copy
                        </button>
                      </div>
                    </div>
                  ))}
                </Section>
              );
            })()}

            {drawerTab === "history" && (() => {
              const items = drawerData.analyses
                .filter((a) => a.kind === "per_shipment" || a.kind === "summary")
                .map((a) => ({ a, parsed: parseAnalysis(a) }));
              return (
                <Section title={`Analysis history (${items.length})`}>
                  {items.length === 0 ? (
                    <div className="text-sm text-slate-500">No analyses yet. Run the extension on this shipment.</div>
                  ) : items.map(({ a, parsed }) => (
                    <div key={a.id} className="rounded-xl bg-white ring-1 ring-slate-200 p-4 mb-3">
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">
                            {parsed.flavor === "summary" ? "Run summary" : "Per-shipment"}
                          </span>
                          <span>{fmtDateTime(a.created_at)}</span>
                          <span className="text-slate-400">·</span>
                          <span className="text-slate-400">{a.model}</span>
                        </div>
                        <span>{fmtUsd(a.cost_usd)}</span>
                      </div>
                      {parsed.flavor === "shipment" ? (
                        <>
                          {parsed.issue ? (
                            <div className="text-sm mb-2">
                              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-0.5">Issue</div>
                              <div className="text-slate-800">{parsed.issue}</div>
                            </div>
                          ) : null}
                          {parsed.recommendation ? (
                            <div className="text-sm">
                              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-0.5">Recommendation</div>
                              <div className="text-slate-800">{parsed.recommendation}</div>
                            </div>
                          ) : null}
                          {!parsed.issue && !parsed.recommendation ? (
                            <div className="text-sm text-slate-500 italic">No structured fields parsed from this run.</div>
                          ) : null}
                        </>
                      ) : (
                        <pre className="text-sm whitespace-pre-wrap font-sans text-slate-800 leading-relaxed">{parsed.body || "(empty)"}</pre>
                      )}
                      {a.input_tokens != null && a.output_tokens != null ? (
                        <div className="text-[11px] text-slate-400 mt-2">
                          {a.input_tokens.toLocaleString()} in / {a.output_tokens.toLocaleString()} out tokens
                          {a.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(1)}s` : ""}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Section>
              );
            })()}

            {drawerTab === "raw" && (
              <Section title="Raw scrape">
                <pre className="text-[11px] bg-slate-900 text-slate-100 p-3 rounded-lg whitespace-pre-wrap max-h-[60vh] overflow-auto">
                  {JSON.stringify(drawerData.shipment.raw_data, null, 2)}
                </pre>
              </Section>
            )}
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>

      {drawerHelpOpen ? (
        <div
          className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setDrawerHelpOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Keyboard className="h-5 w-5 text-slate-700" /> Drawer shortcuts
              </h3>
              <button
                onClick={() => setDrawerHelpOpen(false)}
                className="p-1.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="px-5 py-4 space-y-2">
              {([
                { keys: ["j", "↓", "n", "→"], label: "Next shipment" },
                { keys: ["k", "↑", "p", "←"], label: "Previous shipment" },
                { keys: ["1"], label: "Overview tab" },
                { keys: ["2"], label: "Tasks tab" },
                { keys: ["3"], label: "Email tab" },
                { keys: ["4"], label: "Drafts tab" },
                { keys: ["5"], label: "Analysis tab" },
                { keys: ["6"], label: "Raw tab" },
                { keys: ["o"], label: "Open override modal" },
                { keys: ["r"], label: "Re-analyze" },
                { keys: ["esc"], label: "Close drawer" },
                { keys: ["?"], label: "Show this help" },
              ] as const).map((s) => (
                <li key={s.label} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-700">{s.label}</span>
                  <span className="flex gap-1 shrink-0">
                    {s.keys.map((k) => (
                      <kbd key={k} className="px-1.5 py-0.5 rounded bg-slate-100 ring-1 ring-slate-200 font-mono text-[11px] text-slate-700">{k}</kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <div className="px-5 py-3 border-t border-slate-100 text-[11px] text-slate-500">
              Shortcuts pause while you're typing in a field (notes, override reason, task title, etc.).
            </div>
          </div>
        </div>
      ) : null}

      {overrideModal && drawerData ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
          onClick={() => !overrideModal.busy && setOverrideModal(null)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1">Override action</h2>
            <p className="text-sm text-slate-500 mb-4">Manually set this shipment's action. The AI's classification will be ignored on subsequent scrapes until you clear the override.</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {(["YES", "NO", "RESOLVED"] as const).map((v) => {
                const selected = overrideModal.value === v;
                const selectedCls =
                  v === "YES" ? "bg-rose-600 text-white ring-rose-700"
                  : v === "NO" ? "bg-emerald-600 text-white ring-emerald-700"
                  : "bg-violet-600 text-white ring-violet-700";
                return (
                  <button
                    key={v}
                    onClick={() => setOverrideModal({ ...overrideModal, value: v })}
                    className={
                      "py-2.5 rounded-xl text-sm font-semibold ring-1 transition " +
                      (selected ? selectedCls : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")
                    }
                  >
                    {v === "YES" ? "Action needed" : v === "NO" ? "On track" : "Manually resolved"}
                  </button>
                );
              })}
              <button
                onClick={() => setOverrideModal({ ...overrideModal, value: null })}
                className={
                  "py-2.5 rounded-xl text-sm font-semibold ring-1 transition " +
                  (overrideModal.value === null
                    ? "bg-slate-700 text-white ring-slate-800"
                    : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")
                }
              >
                Clear override
              </button>
            </div>
            <label className="text-xs text-slate-500 block mb-1">Reason (optional)</label>
            <input
              value={overrideModal.reason}
              onChange={(e) => setOverrideModal({ ...overrideModal, reason: e.target.value })}
              placeholder="Why are you overriding the AI?"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm mb-4"
              maxLength={500}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOverrideModal(null)}
                disabled={overrideModal.busy}
                className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100"
              >Cancel</button>
              <button
                onClick={applyOverride}
                disabled={overrideModal.busy}
                className="px-4 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
              >{overrideModal.busy ? "Saving…" : (overrideModal.value === null ? "Clear override" : "Apply override")}</button>
            </div>
          </div>
        </div>
      ) : null}

      {emailModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
          onClick={() => setEmailModal(null)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Mail className="h-5 w-5 text-slate-700" />
                  {emailModal.audience === "carrier" ? "Email to carrier" : "Email to customer"}
                </h2>
                {drawerData ? <p className="text-xs text-slate-500 mt-0.5">{drawerData.shipment.tracking_number}</p> : null}
              </div>
              <button onClick={() => setEmailModal(null)} className="text-slate-500 hover:text-slate-900 p-2 rounded-lg hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1">
              {emailModal.loading ? (
                <div className="text-center text-slate-500 py-12">Generating draft with Claude…</div>
              ) : emailModal.data ? (
                <>
                  <div className="text-xs text-slate-500 uppercase mb-1">Subject</div>
                  <div className="text-sm font-medium text-slate-900 mb-4 px-3 py-2 rounded-lg bg-slate-50 ring-1 ring-slate-200">
                    {emailModal.data.subject}
                  </div>
                  <div className="text-xs text-slate-500 uppercase mb-1">Body</div>
                  <pre className="text-sm whitespace-pre-wrap text-slate-800 px-3 py-3 rounded-lg bg-slate-50 ring-1 ring-slate-200 leading-relaxed">{emailModal.data.body}</pre>
                </>
              ) : null}
            </div>
            {emailModal.data && !emailModal.loading ? (
              <div className="p-4 border-t border-slate-200 flex items-center justify-between gap-3">
                <a
                  href={`mailto:?subject=${encodeURIComponent(emailModal.data.subject)}&body=${encodeURIComponent(emailModal.data.body)}`}
                  className="text-sm text-sky-700 hover:text-sky-900 font-medium"
                >Open in mail client →</a>
                <button
                  onClick={copyEmail}
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 flex items-center gap-2"
                >
                  {emailModal.copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// =====================================================================
// Task banner — surfaces the focused task in the drawer when entered via
// /tasks/:taskId. Title, priority/status chips, and the same Start /
// Complete / Reopen / Block actions the Tasks page exposes, so the rep
// can finish a task without leaving the drawer.
// =====================================================================
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

function TaskBanner({ task, busy, onSetStatus }: {
  task: ShipmentTask;
  busy: boolean;
  onSetStatus: (status: TaskStatus) => Promise<void> | void;
}) {
  // Build the action set per current status so the banner only shows
  // moves that make sense (matches the per-row status button on Tasks).
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

  return (
    <div className="mb-4 rounded-xl bg-violet-50 ring-1 ring-violet-200 px-4 py-3">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-violet-700">Task</div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ring-1 ${TASK_PRIORITY_COLOR[task.priority] || TASK_PRIORITY_COLOR.normal}`}>
            {task.priority}
          </span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ring-1 ${TASK_STATUS_TONE[task.status] || TASK_STATUS_TONE.open}`}>
            {TASK_STATUS_LABEL[task.status] || task.status}
          </span>
        </div>
      </div>
      <div className="text-sm font-medium text-slate-900 leading-snug">{task.title}</div>
      {task.description ? (
        <div className="text-xs text-slate-600 mt-1 leading-snug whitespace-pre-wrap">{task.description}</div>
      ) : null}
      <div className="flex items-center justify-between gap-2 mt-2.5 flex-wrap">
        <div className="text-[11px] text-slate-500">
          {task.assigned_to ? <span className="mr-2">{task.assigned_to}</span> : null}
          <span>created {new Date(task.created_at).toLocaleDateString()}</span>
        </div>
        <div className="inline-flex items-center gap-1.5 flex-wrap">
          {actions.map((a) => (
            <button
              key={a.label}
              disabled={busy}
              onClick={() => onSetStatus(a.status)}
              className={`text-xs font-semibold rounded-md px-2.5 py-1 ${a.tone} disabled:opacity-50`}
            >
              {busy ? "…" : a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
