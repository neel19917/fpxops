import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ListChecks, X, Mail, Copy, Check, Plus, CircleCheck, Circle, Trash2, Download, ChevronLeft, ChevronRight, Keyboard, ExternalLink, ThumbsUp, ThumbsDown, NotebookPen, RefreshCw, Pencil } from "lucide-react";
import { api, type ShipmentRecentDiff } from "../lib/api";
import { fmtDateTime, fmtRelative, fmtUsd } from "../lib/format";
import type { AiAnalysis, EmailDraft, Shipment, ShipmentNote, ShipmentTask, TaskStatus } from "../lib/types";
import { ActionBadge } from "../components/Badge";
import { Drawer, Field, Section } from "../components/Drawer";
import { ShareButton } from "../components/ShareButton";
import { ReanalyzeModal } from "../components/ReanalyzeModal";
import { ColumnSelector } from "../components/ColumnSelector";
import { UserPicker } from "../components/UserPicker";
import { useAuth } from "../lib/auth";
import { showFrame, hideFrame, requestAutoFilter, requestOpenTracking } from "../lib/freightpopFrame";
import { swrGet, swrSet } from "../lib/swrCache";
import {
  SHIPMENT_COLUMNS,
  loadColumnPrefs,
  saveColumnPrefs,
  type ColumnPrefs,
} from "../lib/shipmentColumns";
// exportShipmentsXlsx is dynamically imported below so the xlsx-js-style
// library (~300 KB minified) is only fetched when the operator actually
// clicks "Export all". Keeps the Shipments chunk slim for the
// 99% of page loads where nobody exports.

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
  // When true, the page mounts pre-filtered to shipments that carry an
  // operator note. Powers the dedicated /notes tab so the team has a
  // direct entry point to "everything that has a note attached" without
  // hunting for the toolbar toggle. The user can still toggle it off
  // from the toolbar; the URL stays /notes either way.
  notesMode?: boolean;
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

// Drawer tabs collapsed from 6 → 4: drafts now lives under email (saved
// drafts list rendered below the composer); raw scrape lives under
// history as a collapsible section. Existing /tracking/:id/drafts and
// /tracking/:id/raw URLs still resolve — asDrawerTab() rewrites them
// to their new homes so old bookmarks don't dead-end.
const DRAWER_TABS = ["overview", "tasks", "email", "history"] as const;
type DrawerTabId = typeof DRAWER_TABS[number];
function asDrawerTab(s: string | null | undefined): DrawerTabId {
  // Map removed tabs to their new homes so legacy URLs / nav from
  // outside the drawer keep working.
  if (s === "drafts") return "email";
  if (s === "raw") return "history";
  return DRAWER_TABS.includes(s as DrawerTabId) ? (s as DrawerTabId) : "overview";
}

export function ShipmentsPage({ initialShipmentId, drawerSection, onShipmentConsumed, onDrawerChange, taskWalk, notesMode = false }: ShipmentsPageProps = {}) {
  const { clientConfig } = useAuth();
  const embedCfg = clientConfig?.embed_freightpop;
  // Master parcel switch (admin, default OFF). When off, parcel-mode rows
  // are hidden from the Tracking page across the board — the list, mode
  // dropdown, and pill counts all derive from `baseRows` so the view stays
  // internally consistent. The shipments still exist server-side; this is
  // purely a view filter, mirrored by the server's auto-task gate.
  const showParcels = clientConfig?.tracking_ui?.show_parcels ?? false;
  const [rows, setRows] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [modeFilter, setModeFilter] = useState<string>(() => {
    try { return localStorage.getItem("fpx.shipments.modeFilter") ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    try { localStorage.setItem("fpx.shipments.modeFilter", modeFilter); } catch {}
  }, [modeFilter]);
  // A "Parcel" filter persisted from before the parcel switch was turned
  // off can only match rows that baseRows hides, so it silently empties
  // the table. Clear it — but only once clientConfig has loaded: it
  // arrives async, and until then showParcels reads its false default,
  // which would wipe a legitimate Parcel filter on tenants that have
  // parcels enabled.
  useEffect(() => {
    if (clientConfig && !showParcels && modeFilter.trim().toLowerCase() === "parcel") {
      setModeFilter("");
    }
  }, [clientConfig, showParcels, modeFilter]);
  const [pillFilter, setPillFilter] = useState<PillId>("all");
  // "With notes" toggle — narrows the table to shipments that carry an
  // operator note. The note column itself stays available in the column
  // selector; this filter is just the cross-shipment notes view the team
  // wanted as a one-click navigable + exportable surface.
  const [notesOnly, setNotesOnly] = useState<boolean>(notesMode);

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
  const [drawerData, setDrawerData] = useState<{ shipment: Shipment; analyses: AiAnalysis[]; tasks: ShipmentTask[]; recent_diff: ShipmentRecentDiff | null } | null>(null);
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
  const [bulkReOpen, setBulkReOpen] = useState(false);
  const [bulkReBusy, setBulkReBusy] = useState(false);
  // True dataset-wide counts for the status pills (the loaded page is only a
  // slice). statsNonce lets Refresh / bulk ops force a re-fetch.
  const [stats, setStats] = useState<{ total: number; issues: number; statuses: Record<string, number> } | null>(null);
  const [statsNonce, setStatsNonce] = useState(0);
  const [rescrapeBusy, setRescrapeBusy] = useState(false);
  const [reAllOpen, setReAllOpen] = useState(false);
  const [reAllBusy, setReAllBusy] = useState(false);
  // Transient success banner for fire-and-forget actions (rescrape, batch
  // re-analyze) whose result lands later, not in the request response.
  const [notice, setNotice] = useState<string | null>(null);
  function flashNotice(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(null), 6000);
  }
  async function requestRescrape() {
    if (rescrapeBusy) return;
    setRescrapeBusy(true); setErr(null);
    try {
      const r = await api.ops.requestRescrape({ scope: "all" });
      flashNotice(r.coalesced
        ? "Rescrape already queued — the extension will pick it up on its next run."
        : "Rescrape requested — the extension will re-pull FreightPOP on its next run, then Refresh.");
    } catch (e) { setErr((e as Error).message); }
    finally { setRescrapeBusy(false); }
  }
  async function submitBulkReanalyze() {
    if (bulkReBusy || selectedIds.size === 0) return;
    setBulkReBusy(true); setErr(null);
    try {
      const r = await api.shipments.bulkReanalyze(Array.from(selectedIds));
      setBulkReOpen(false);
      clearSelection();
      flashNotice(`Re-analyzing ${r.queued} shipment${r.queued === 1 ? "" : "s"} in the background — Refresh in a minute to see updated verdicts.`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBulkReBusy(false); }
  }
  async function submitReanalyzeAll() {
    if (reAllBusy) return;
    setReAllBusy(true); setErr(null);
    try {
      const r = await api.shipments.reanalyzeAll();
      setReAllOpen(false);
      flashNotice(`Re-analyzing all ${r.queued} shipment${r.queued === 1 ? "" : "s"} in the background${r.capped ? " (capped at 5000)" : ""} — this runs for a while; Refresh periodically to see updated verdicts.`);
    } catch (e) { setErr((e as Error).message); }
    finally { setReAllBusy(false); }
  }

  // Per-shipment tasks shown inside the drawer.
  const [drawerTasks, setDrawerTasks] = useState<ShipmentTask[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskBusy, setNewTaskBusy] = useState(false);

  // Drawer notes — append-only log. notesDraft is the new-entry text;
  // notesLog is the running history (newest first); notesBusy gates the add.
  const [notesDraft, setNotesDraft] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesLog, setNotesLog] = useState<ShipmentNote[]>([]);

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
  // overrideModal also carries two booleans for "also create a carrier
  // followup task" / "also create a customer followup task". Both can
  // be true — applyOverride will create both tasks in the same submit.
  // Reason doubles as the suffix for any auto-created followup task
  // titles (so the operator only types once). autoDraftEmail piggybacks
  // off the same submit: when true, the AI email-draft modal opens
  // immediately after the override applies, defaulting to the audience
  // implied by the selected followup checkboxes (carrier wins ties).
  const [overrideModal, setOverrideModal] = useState<null | {
    value: "YES" | "NO" | "RESOLVED" | null;
    reason: string;
    busy: boolean;
    createCarrierFollowup: boolean;
    createCustomerFollowup: boolean;
    autoDraftEmail: boolean;
  }>(null);

  // Re-analyze button state — busy flag prevents double-click during a Claude
  // round-trip (typically 2-3s).
  const [reanalyzeOpen, setReanalyzeOpen] = useState(false);

  // Task-walk: tracks whether the focused task's status update is in flight,
  // Tracks whether an action-disposition mutation is in flight. Drives
  // the disabled state on the popover buttons inside ActionDispositionControl.
  const [taskBusy, setTaskBusy] = useState(false);
  const [actionEditBusy, setActionEditBusy] = useState(false);

  // Split-view: render the FreightPOP iframe in the left "gray screen" area
  // while the drawer is open, so reps see the live FreightPOP grid + the
  // shipment details side-by-side. Default on when the embed is enabled;
  // toggle persists in localStorage so users who can't get FreightPOP to
  // load (CSP / X-Frame-Options) can collapse it permanently.
  const [splitView, setSplitView] = useState<boolean>(() => {
    try { return (localStorage.getItem("fpx.shipments.splitView") ?? "1") !== "0"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("fpx.shipments.splitView", splitView ? "1" : "0"); } catch {}
  }, [splitView]);

  // Drive the singleton FreightPOP overlay. Mounting the iframe at App
  // scope means its login session survives every route change; pages
  // (this one) only push visibility + context updates. We keep the URL
  // stable when the template has no per-shipment placeholders so the
  // iframe never reloads on prev/next walks.
  useEffect(() => {
    if (!embedCfg?.enabled || !splitView || !drawerId) {
      hideFrame();
      return;
    }
    if (!drawerData) return;
    const ship = drawerData.shipment;
    const url = (embedCfg.url_template || "")
      .replace(/\{tracking_number\}/g, encodeURIComponent(ship.tracking_number || ""))
      .replace(/\{shipment_id\}/g, encodeURIComponent(ship.shipment_id || ship.id))
      .replace(/\{order_number\}/g, encodeURIComponent(ship.order_number || ""));
    showFrame({
      url,
      shipmentId: ship.id,
      shipmentLabel: ship.shipment_id || null,
      trackingNumber: ship.tracking_number || null,
      customerName: ship.customer_name || null,
    });
  }, [embedCfg?.enabled, embedCfg?.url_template, splitView, drawerId, drawerData]);

  // Closing the page (unmount) clears the frame so it doesn't linger
  // on top of other routes.
  useEffect(() => {
    return () => { hideFrame(); };
  }, []);

  // "Export all" pulls every shipment fresh (ignores filters / pill / search)
  // so the workbook reflects the database, not the current view.
  const [exporting, setExporting] = useState(false);
  async function exportAll() {
    if (exporting) return;
    setExporting(true); setErr(null);
    try {
      // Pull the data + the (heavy) xlsx-js-style library in parallel
      // so the click→download latency is bounded by the slower of
      // the two. Vite splits exportShipments into its own chunk
      // because we use dynamic import here.
      const [r, mod] = await Promise.all([
        api.shipments.list({ limit: 5000 }),
        import("../lib/exportShipments"),
      ]);
      if (!r.data?.length) {
        setErr("No shipments to export.");
        return;
      }
      mod.exportShipmentsXlsx(r.data);
    } catch (e) { setErr((e as Error).message); }
    finally { setExporting(false); }
  }

  // Cursor for the next page on "Load more". Null = no more rows OR
  // we haven't fetched yet. The server returns this as scraped_at of
  // the last row on the current page.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    setErr(null);
    try {
      // Initial render is what users feel — keep it tight. Daily volume
      // typically sits around 200 rows; smaller initial fetch makes the
      // page paint faster on slow connections, and "Load more" pulls
      // the next 500 if the operator wants more history.
      const r = await api.shipments.list({ limit: 200 });
      setRows(r.data);
      setNextCursor(r.next_cursor);
      swrSet("shipments.list", { data: r.data, next_cursor: r.next_cursor });
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.shipments.list({ limit: 500, before: nextCursor });
      // Append rather than replace so the existing scroll position
      // and selection state stay intact.
      setRows((prev) => [...prev, ...r.data]);
      setNextCursor(r.next_cursor);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoadingMore(false); }
  }
  // True counts for the pills, fetched separately from the paged list. Keyed on
  // parcel visibility (the count must match what the grid shows) and statsNonce
  // (bumped by Refresh / bulk ops). Non-fatal — pills fall back to page counts.
  useEffect(() => {
    let alive = true;
    api.shipments.stats(showParcels).then((s) => { if (alive) setStats(s); }).catch(() => {});
    return () => { alive = false; };
  }, [showParcels, statsNonce]);
  // Stale-while-revalidate: paint instantly from the last successful
  // response, then let the live fetch swap in silently instead of
  // blanking the table to a spinner on every visit.
  useEffect(() => {
    const cached = swrGet<{ data: Shipment[]; next_cursor: string | null }>("shipments.list");
    if (cached?.data?.length) {
      setRows(cached.data);
      setNextCursor(cached.next_cursor);
      setLoading(false);
      load(true);
    } else {
      load();
    }
  }, []);

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
      setNotesLog([]);
      return;
    }
    // Cancel guard so a slower response for the previous shipment can't
    // overwrite drawerData after the user has walked to a different one.
    // Especially important during task-walk prev/next on a slow connection.
    let cancelled = false;
    api.shipments.get(drawerId)
      .then((d) => {
        if (cancelled) return;
        setDrawerData(d);
        setDrawerTasks(d.tasks || []);
        setNotesLog(d.notes_log || []);
        setNotesDraft("");
      })
      .catch(() => { if (!cancelled) { setDrawerData(null); setDrawerTasks([]); } });
    return () => { cancelled = true; };
  }, [drawerId]);

  // Re-fetch the focused shipment and mirror the result into the
  // table row + drawer data. Used after any single-shipment action
  // that the server side-effects (override, reanalyze, notes save,
  // etc.) so both the drawer and the row in the table reflect the
  // new state without an extra round trip per consumer. Returns the
  // refreshed shipment so callers can chain on it if they need to.
  // Patch a single analysis row inside drawerData.analyses by id —
  // used by AnalysisThumbs to apply a rating change without
  // refetching the whole drawer.
  function patchAnalysisLocal(id: string, patch: Partial<AiAnalysis>) {
    setDrawerData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        analyses: prev.analyses.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      };
    });
  }

  async function refreshDrawer(id: string = drawerId || "") {
    if (!id) return null;
    const r = await api.shipments.get(id);
    setDrawerData(r);
    setDrawerTasks(r.tasks || []);
    setRows((prev) => prev.map((row) => (row.id === id ? r.shipment : row)));
    return r;
  }

  // Append a new entry to the notes log. Immutable — there's no edit/
  // overwrite; each save is its own timestamped, attributed line.
  async function addNote() {
    const body = notesDraft.trim();
    if (!drawerId || notesBusy || !body) return;
    setNotesBusy(true);
    try {
      const r = await api.shipments.addNote(drawerId, body);
      setNotesLog((prev) => [r.note, ...prev]);
      setNotesDraft("");
      // Mirror the denormalized latest-note onto the table row + drawer so
      // the "With notes" filter/count and any list display stay in sync.
      if (r.shipment) {
        const ship = r.shipment;
        setDrawerData((p) => p ? { ...p, shipment: ship } : p);
        setRows((prev) => prev.map((row) => row.id === ship.id ? { ...row, notes: ship.notes } : row));
      }
    } catch (e) { setErr((e as Error).message); }
    finally { setNotesBusy(false); }
  }

  async function addDrawerTask(opts: { prefix?: "carrier" | "customer" } = {}) {
    if (!drawerId) return;
    const typed = newTaskTitle.trim();
    // For followup quick-buttons, allow an empty input — fall back to a
    // sensible default suffix so the followup matcher still detects the
    // task and the operator can refine the title later if they want.
    if (!opts.prefix && !typed) return;
    let finalTitle: string;
    if (opts.prefix === "carrier") {
      finalTitle = `Carrier followup: ${typed || "follow-up needed"}`;
    } else if (opts.prefix === "customer") {
      finalTitle = `Customer followup: ${typed || "status update needed"}`;
    } else {
      finalTitle = typed;
    }
    setNewTaskBusy(true);
    try {
      const r = await api.tasks.create(drawerId, { title: finalTitle });
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
  async function openEmailDraft(audience: "carrier" | "customer", notes?: string) {
    if (!drawerId) return;
    setEmailModal({ audience, data: null, loading: true, copied: false });
    try {
      const draft = await api.emailDraft.generate(drawerId, audience, notes);
      // Default-copy to clipboard so the rep can paste straight into
      // their mail client without an extra click. clipboard.writeText
      // rejects if the document isn't transient-activated or perms
      // are blocked — fall back to the manual Copy button in that
      // case (still rendered in the footer).
      let copied = false;
      try {
        await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
        copied = true;
      } catch { /* clipboard blocked — manual Copy button remains */ }
      setEmailModal({ audience, data: draft, loading: false, copied });
      if (copied) {
        setTimeout(() => setEmailModal((m) => (m ? { ...m, copied: false } : m)), 2000);
      }
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
    const m = overrideModal;
    setOverrideModal({ ...m, busy: true });
    try {
      // Step 1: apply the override.
      const r = await api.shipments.overrideAction(drawerId, {
        action_required: m.value,
        reason: m.reason || undefined,
      });
      setDrawerData((prev) => prev ? { ...prev, shipment: r.shipment } : prev);
      setRows((prev) => prev.map((row) => row.id === r.shipment.id ? r.shipment : row));

      // Step 2: create followup tasks for whichever audiences were
      // checked. Reason field doubles as the title suffix so the
      // operator only types once. Falls back to a sensible default
      // suffix so the matcher always picks the task up.
      const reason = m.reason.trim();
      const tasksToCreate: { title: string }[] = [];
      if (m.createCarrierFollowup) {
        tasksToCreate.push({ title: `Carrier followup: ${reason || "follow-up needed"}` });
      }
      if (m.createCustomerFollowup) {
        tasksToCreate.push({ title: `Customer followup: ${reason || "status update needed"}` });
      }
      const createdTasks = await Promise.all(
        tasksToCreate.map((body) => api.tasks.create(drawerId, body)),
      );
      if (createdTasks.length) {
        // Prepend so the new task is visible immediately on the Tasks tab.
        setDrawerTasks((p) => [...createdTasks.map((t) => t.task), ...p]);
      }

      // Step 3: optionally auto-draft an email. Audience is implied by
      // the followup checkboxes — if both, carrier wins (matches the
      // operational sequence: chase the carrier first, brief the
      // customer second). If neither was checked but the operator
      // still asked for a draft, default to carrier.
      if (m.autoDraftEmail) {
        const audience: "carrier" | "customer" =
          m.createCarrierFollowup ? "carrier"
          : m.createCustomerFollowup ? "customer"
          : "carrier";
        // Close override first so the email modal stacks cleanly.
        setOverrideModal(null);
        await openEmailDraft(audience, reason || undefined);
        return;
      }
      setOverrideModal(null);
    } catch (e) {
      setOverrideModal({ ...m, busy: false });
      setErr((e as Error).message);
    }
  }

  // Tracking-page view base: drops parcel-mode rows unless the admin has
  // enabled parcel tracking. Everything the page renders (list, dropdown,
  // counts) flows from here so parcels can't leak in via one path.
  const baseRows = useMemo(
    () => (showParcels ? rows : rows.filter((r) => String(r.mode || "").trim().toLowerCase() !== "parcel")),
    [rows, showParcels]
  );

  const customers = useMemo(() => {
    const set = new Set<string>();
    for (const r of baseRows) if (r.customer_name) set.add(r.customer_name);
    return Array.from(set).sort();
  }, [baseRows]);

  const availableModes = useMemo(() => {
    // Seed "Parcel" only when parcel tracking is on — otherwise the dropdown
    // would offer a mode that can never match a (hidden) row.
    const set = new Set<string>(showParcels ? ["LTL", "Parcel"] : ["LTL"]);
    let hasNoMode = false;
    for (const r of baseRows) {
      const m = (r.mode || "").trim();
      if (!m) { hasNoMode = true; continue; }
      set.add(m);
    }
    return { modes: Array.from(set).sort((a, b) => a.localeCompare(b)), hasNoMode };
  }, [baseRows, showParcels]);

  const filtered = useMemo(() => {
    return baseRows.filter((r) => {
      if (!shipmentMatchesPill(r, pillFilter)) return false;
      if (actionFilter && String(r.action_required || "").toUpperCase() !== actionFilter) return false;
      if (customerFilter && r.customer_name !== customerFilter) return false;
      if (sourceFilter && r.action_source !== sourceFilter) return false;
      if (modeFilter) {
        const m = (r.mode || "").trim().toLowerCase();
        if (modeFilter === "__none__") {
          if (m) return false;
        } else if (m !== modeFilter.toLowerCase()) return false;
      }
      if (notesOnly && !(r.notes && r.notes.trim())) return false;
      if (q) {
        // shipment_id is the FreightPOP-side unique id (e.g. "13583467")
        // and is the operator's primary handle; included alongside the
        // existing tracking + customer + carrier search axes.
        const hay = [r.shipment_id, r.tracking_number, r.customer_name, r.carrier_name, r.carrier, r.ai_issue, r.shipment_status]
          .map((x) => (x || "").toLowerCase()).join(" ");
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [baseRows, q, actionFilter, customerFilter, sourceFilter, modeFilter, pillFilter, notesOnly]);

  const notesCount = useMemo(
    () => rows.reduce((n, r) => n + (r.notes && r.notes.trim() ? 1 : 0), 0),
    [rows],
  );

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
      // Drafts and raw are no longer tabs; they live under email/history
      // respectively, so 4 is now Analysis.
      const tabMap: Record<string, DrawerTabId> = {
        "1": "overview",
        "2": "tasks",
        "3": "email",
        "4": "history",
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
            createCarrierFollowup: false,
            createCustomerFollowup: false,
            autoDraftEmail: false,
          });
        }
        return;
      }
      if (e.key === "r") {
        e.preventDefault();
        if (!drawerId) return;
        setReanalyzeOpen(true);
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerId, drawerHelpOpen, drawerPrev, drawerNext, drawerData, taskWalk]);

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

  const pillCounts = useMemo(() => {
    // Prefer true dataset-wide counts. Fold the server's per-status tally
    // through the SAME matchers the list uses, so the booked/in-transit/etc.
    // logic is single-sourced. Fall back to page counts until stats arrive.
    if (stats) {
      let booked = 0, in_transit = 0, out_for_delivery = 0, delivered = 0;
      for (const [st, n] of Object.entries(stats.statuses)) {
        if (STATUS_MATCHERS.booked(st)) booked += n;
        if (STATUS_MATCHERS.in_transit(st)) in_transit += n;
        if (STATUS_MATCHERS.out_for_delivery(st)) out_for_delivery += n;
        if (STATUS_MATCHERS.delivered(st)) delivered += n;
      }
      return { total: stats.total, booked, in_transit, issues: stats.issues, out_for_delivery, delivered };
    }
    return {
      total: baseRows.length,
      booked: baseRows.filter((r) => shipmentMatchesPill(r, "booked")).length,
      in_transit: baseRows.filter((r) => shipmentMatchesPill(r, "in_transit")).length,
      issues: baseRows.filter((r) => shipmentMatchesPill(r, "issues")).length,
      out_for_delivery: baseRows.filter((r) => shipmentMatchesPill(r, "out_for_delivery")).length,
      delivered: baseRows.filter((r) => shipmentMatchesPill(r, "delivered")).length,
    };
  }, [stats, baseRows]);

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
              placeholder="Search shipment id, tracking, customer, carrier…"
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
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value)}
            title="Filter by shipment mode (LTL, Parcel, etc.)"
          >
            <option value="">All modes</option>
            {availableModes.modes.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {availableModes.hasNoMode ? <option value="__none__">(no mode)</option> : null}
          </select>
          <button
            onClick={() => setNotesOnly((v) => !v)}
            title={notesOnly ? "Showing only shipments with operator notes" : "Show only shipments with operator notes"}
            className={
              "px-3 py-2 text-sm font-medium rounded-lg ring-1 inline-flex items-center gap-1.5 " +
              (notesOnly
                ? "bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100"
                : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")
            }
          >
            <NotebookPen className="h-4 w-4" />
            With notes
            <span className={"ml-1 rounded-full px-1.5 text-[11px] font-semibold " + (notesOnly ? "bg-amber-200 text-amber-900" : "bg-slate-100 text-slate-600")}>
              {notesCount}
            </span>
          </button>
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
            onClick={() => setReAllOpen(true)}
            title="Re-run AI on every shipment and replace stored verdicts"
            className="px-3 py-2 text-sm font-medium rounded-lg bg-white text-violet-700 ring-1 ring-violet-300 hover:bg-violet-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw className="h-4 w-4" />
            Re-analyze all
          </button>
          <button
            onClick={requestRescrape}
            disabled={rescrapeBusy}
            title="Ask the FreightPOP extension to re-pull fresh data on its next run (not an instant reload)"
            className="px-3 py-2 text-sm font-medium rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            <RefreshCw className={"h-4 w-4 " + (rescrapeBusy ? "animate-spin" : "")} />
            {rescrapeBusy ? "Requesting…" : "Rescrape"}
          </button>
          <button
            onClick={() => { load(); setStatsNonce((n) => n + 1); }}
            title="Reload the latest data already in the database"
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

        {notice ? (
          <div className="p-3 bg-emerald-50 border-b border-emerald-200 text-emerald-800 text-sm">
            {notice}
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
              onClick={() => setBulkReOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-medium hover:bg-violet-700 flex items-center gap-1.5"
            >
              <RefreshCw className="h-4 w-4" /> Bulk re-analyze
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
        {/* Load-more strip — only renders when the server says there
            are more rows. The "Showing N rows" line gives the
            operator a sense of scope before they choose to fetch
            another 500. */}
        <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>
            Showing {baseRows.length} row{baseRows.length === 1 ? "" : "s"}
            {baseRows.length !== filtered.length ? <> · {filtered.length} after filters</> : null}
          </span>
          {nextCursor ? (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-medium disabled:opacity-50"
              title="Fetch the next 500 older shipments from the server"
            >
              <Download className="h-3.5 w-3.5" />
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : (
            <span className="text-slate-400">End of list</span>
          )}
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

      {bulkReOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={() => !bulkReBusy && setBulkReOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1 flex items-center gap-2 text-violet-700">
              <RefreshCw className="h-5 w-5" /> Re-analyze {selectedIds.size} shipment{selectedIds.size === 1 ? "" : "s"}?
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              This re-runs the AI on each selected shipment and <strong>replaces</strong> the stored verdict (issue, recommendation, action). Manual overrides are kept. It runs in the background and costs one model call per shipment — Refresh in a minute to see the updated verdicts.
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setBulkReOpen(false)}
                disabled={bulkReBusy}
                className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100"
              >Cancel</button>
              <button
                onClick={submitBulkReanalyze}
                disabled={bulkReBusy}
                className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <RefreshCw className={"h-4 w-4 " + (bulkReBusy ? "animate-spin" : "")} />
                {bulkReBusy ? "Queuing…" : `Re-analyze ${selectedIds.size}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {reAllOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={() => !reAllBusy && setReAllOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1 flex items-center gap-2 text-violet-700">
              <RefreshCw className="h-5 w-5" /> Re-analyze all {pillCounts.total.toLocaleString()} shipments?
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              This re-runs the AI on <strong>every</strong> shipment and <strong>replaces</strong> each stored verdict (issue, recommendation, action). Manual overrides are kept; analysis history is preserved. It runs in the background — roughly <strong>${Math.max(1, Math.round(pillCounts.total * 0.004))}</strong> and <strong>~{Math.max(1, Math.ceil(pillCounts.total * 2 / 4 / 60))} min</strong> — so Refresh periodically rather than waiting.
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setReAllOpen(false)}
                disabled={reAllBusy}
                className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100"
              >Cancel</button>
              <button
                onClick={submitReanalyzeAll}
                disabled={reAllBusy}
                className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <RefreshCw className={"h-4 w-4 " + (reAllBusy ? "animate-spin" : "")} />
                {reAllBusy ? "Queuing…" : `Re-analyze all ${pillCounts.total.toLocaleString()}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Drawer
        open={!!drawerId}
        onClose={() => setDrawerId(null)}
        // Shipment ID is the unique identifier in the operator's mental
        // map, so we lead with it. Tracking number + customer follow as
        // secondary context. Falls back gracefully when shipment_id isn't
        // populated on legacy rows.
        title={drawerData?.shipment.shipment_id || drawerData?.shipment.tracking_number || "Shipment"}
        subtitle={drawerData ? [
          drawerData.shipment.shipment_id ? `Tracking ${drawerData.shipment.tracking_number || "—"}` : null,
          drawerData.shipment.customer_name || null,
        ].filter(Boolean).join(" · ") || undefined : undefined}
        // Suppress the dimmed backdrop when the FreightPOP overlay is
        // visible — the overlay (mounted at App scope) takes over the
        // gray space.
        suppressBackdrop={!!(embedCfg?.enabled && splitView && drawerId)}
      >
        {drawerData ? (
          <>
            {/* High-level summary card. Pinned above every drawer tab so
                the operator always has the five identifiers / status they
                need to talk about the shipment, no matter which tab they
                navigate to. The Action control is rendered inline so an
                operator can override / Modify without scrolling to the
                Overview tab. */}
            <ShipmentSummaryHeader
              shipment={drawerData.shipment}
              onOverrideClick={() =>
                setOverrideModal({
                  value: drawerData.shipment.action_required === "YES" ? "NO" : "YES",
                  reason: "",
                  busy: false,
                  createCarrierFollowup: false,
                  createCustomerFollowup: false,
                  autoDraftEmail: false,
                })
              }
              actionEditBusy={actionEditBusy}
              onSetAction={async (v) => {
                if (!drawerId) return;
                setActionEditBusy(true);
                try {
                  await api.shipments.overrideAction(drawerId, { action_required: v });
                  await refreshDrawer();
                } catch (e) { setErr((e as Error).message); }
                finally { setActionEditBusy(false); }
              }}
              onRevertToAi={async () => {
                if (!drawerId) return;
                setActionEditBusy(true);
                try {
                  await api.shipments.overrideAction(drawerId, { action_required: null });
                  await refreshDrawer();
                } catch (e) { setErr((e as Error).message); }
                finally { setActionEditBusy(false); }
              }}
            />
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
                {embedCfg?.enabled && drawerData?.shipment.tracking_number ? (
                  <button
                    type="button"
                    onClick={() => {
                      // If split-view is off, turn it on so the iframe is
                      // actually visible to receive the filter; the
                      // overlay will fire the postMessage as soon as it's
                      // mounted and the bridge is ready.
                      if (!splitView) setSplitView(true);
                      requestAutoFilter();
                    }}
                    className="text-xs px-2.5 py-1.5 rounded-md ring-1 ring-violet-600 bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-1.5"
                    title={`Load shipment ${drawerData.shipment.tracking_number} in FreightPOP and filter the grid`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Load in FreightPOP
                  </button>
                ) : null}
                {/* Sibling option to "Load in FreightPOP": triggers FP's
                    native tracking modal *inside* the embedded iframe.
                    The overlay forwards a postMessage to the FPXpress
                    extension which filters by tracking number then
                    simulates a click on the row's tracking link — same
                    UI path a rep takes manually, just one click. */}
                {embedCfg?.enabled && drawerData?.shipment.tracking_number ? (
                  <button
                    type="button"
                    onClick={() => {
                      // Make sure the iframe is actually on-screen first;
                      // overlay only forwards the message when the
                      // bridge has greeted us, which only happens once
                      // the iframe is mounted + visible.
                      if (!splitView) setSplitView(true);
                      requestOpenTracking();
                    }}
                    className="text-xs px-2.5 py-1.5 rounded-md ring-1 ring-slate-300 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
                    title={`Open the FreightPOP tracking modal for ${drawerData.shipment.tracking_number} in the embedded panel`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open tracking #
                  </button>
                ) : null}
                {embedCfg?.enabled ? (
                  <button
                    type="button"
                    onClick={() => setSplitView((v) => !v)}
                    className={"text-xs px-2.5 py-1.5 rounded-md ring-1 inline-flex items-center gap-1.5 " + (splitView
                      ? "bg-white text-violet-700 ring-violet-200 hover:bg-violet-50"
                      : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}
                    title={splitView ? "Hide FreightPOP side panel" : "Show FreightPOP side panel"}
                    aria-pressed={splitView}
                  >
                    {splitView ? "Panel: on" : "Panel: off"}
                  </button>
                ) : null}
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
                {
                  id: "email",
                  label: "Email",
                  // Show saved-draft count on the Email tab pill since
                  // drafts now live underneath the composer.
                  count: drawerData.analyses.filter((a) => a.kind === "other" && typeof (a.metadata as Record<string, unknown>)?.subkind === "string" && String((a.metadata as Record<string, unknown>).subkind).startsWith("email_draft_")).length,
                },
                { id: "history", label: "Analysis", count: drawerData.analyses.filter((a) => a.kind === "per_shipment" || a.kind === "summary").length },
              ] as { id: typeof DRAWER_TABS[number]; label: string; count: number | null }[]).map((t) => (
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
                onSaveDescription={async (description) => {
                  if (!taskWalk?.task) return;
                  await api.tasks.update(taskWalk.task.id, { description });
                  // Reuse the status-change refresh hook so the banner
                  // re-renders with the persisted description and any
                  // server-side mutations (updated_at, etc.) settle.
                  taskWalk.onTaskStatusChanged?.(taskWalk.task.status);
                }}
                onCreateInverseFollowup={async (kind) => {
                  // Add a parallel followup to the OTHER audience for the
                  // same shipment, so the operator can chase carrier and
                  // brief customer in one motion. Reuses the existing
                  // drawer-task path so the new task lands in the correct
                  // panel automatically (matcher pattern).
                  await addDrawerTask({ prefix: kind });
                }}
              />
            ) : null}

            {drawerTab === "overview" && (
              <>
                {/* Notes is an append-only log hoisted to the top of
                    Overview — it's the field a rep touches most during a
                    walk-through. Each save is an immutable, timestamped,
                    attributed entry; the full history renders below the
                    add box (newest first). Ctrl/⌘+Enter submits. */}
                <Section title="Notes">
                  <textarea
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); addNote(); } }}
                    placeholder="Add a note… (⌘/Ctrl+Enter to save)"
                    rows={3}
                    maxLength={5000}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
                  />
                  <div className="mt-2 flex items-center justify-end">
                    <button
                      onClick={addNote}
                      disabled={notesBusy || !notesDraft.trim()}
                      className="text-xs px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" /> {notesBusy ? "Adding…" : "Add note"}
                    </button>
                  </div>
                  {notesLog.length > 0 ? (
                    <ul className="mt-3 space-y-2.5">
                      {notesLog.map((n) => (
                        <li key={n.id} className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2">
                          <div className="text-sm text-slate-800 whitespace-pre-wrap break-words">{n.body}</div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            {n.created_by || "system"} · <span title={fmtDateTime(n.created_at)}>{fmtRelative(n.created_at)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-xs text-slate-400">No notes yet — add the first one above.</p>
                  )}
                </Section>
                <Section title="Shipment">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Carrier">{drawerData.shipment.carrier_name || drawerData.shipment.carrier}</Field>
                    <Field label="Mode">{drawerData.shipment.mode}</Field>
                    <Field label="Status">{drawerData.shipment.shipment_status}</Field>
                    <div className="flex flex-col gap-0.5">
                      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Action</div>
                      <ActionDispositionControl
                        shipment={drawerData.shipment}
                        actionEditBusy={actionEditBusy}
                        onSetAction={async (v) => {
                          if (!drawerId) return;
                          setActionEditBusy(true);
                          try {
                            await api.shipments.overrideAction(drawerId, { action_required: v });
                            await refreshDrawer();
                          } catch (e) { setErr((e as Error).message); }
                          finally { setActionEditBusy(false); }
                        }}
                        onRevertToAi={async () => {
                          if (!drawerId) return;
                          setActionEditBusy(true);
                          try {
                            await api.shipments.overrideAction(drawerId, { action_required: null });
                            await refreshDrawer();
                          } catch (e) { setErr((e as Error).message); }
                          finally { setActionEditBusy(false); }
                        }}
                        onOverrideClick={() => setOverrideModal({ value: drawerData.shipment.action_required === "YES" ? "NO" : "YES", reason: "", busy: false, createCarrierFollowup: false, createCustomerFollowup: false, autoDraftEmail: false })}
                      />
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
                      disabled={!drawerId}
                      onClick={() => { if (drawerId) setReanalyzeOpen(true); }}
                      className="text-xs px-2.5 py-1 rounded-md bg-sky-50 text-sky-700 ring-1 ring-sky-200 hover:bg-sky-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                      title="Re-analyze on a chosen model and review before replacing"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Re-analyze
                    </button>
                  </div>
                  <Field label="Issue">{drawerData.shipment.ai_issue}</Field>
                  <div className="h-3" />
                  <Field label="Recommendation">{drawerData.shipment.ai_recommendation}</Field>
                </Section>
              </>
            )}

            {drawerTab === "tasks" && (
              <Section title={`Tasks (${drawerTasks.length})`}>
                <div className="flex gap-2 mb-2">
                  <input
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addDrawerTask(); }}
                    placeholder="New task title…"
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm"
                  />
                  <button
                    onClick={() => addDrawerTask()}
                    disabled={!newTaskTitle.trim() || newTaskBusy}
                    className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Plus className="h-4 w-4" /> Add
                  </button>
                </div>
                {/* Quick-add buttons for followup-tagged tasks. Title input
                    above is optional — leaving it blank uses a sensible
                    default suffix so the followup matcher (carrier or
                    customer) still picks the task up on the Tasks page. */}
                <div className="flex gap-2 mb-4 flex-wrap">
                  <button
                    onClick={() => addDrawerTask({ prefix: "carrier" })}
                    disabled={newTaskBusy}
                    className="px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-semibold hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                    title="Create a task tagged Carrier followup: <suffix>. Surfaces in the Carrier Followups panel on /tasks."
                  >
                    <Plus className="h-3.5 w-3.5" /> Add carrier followup
                  </button>
                  <button
                    onClick={() => addDrawerTask({ prefix: "customer" })}
                    disabled={newTaskBusy}
                    className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                    title="Create a task tagged Customer followup: <suffix>. Surfaces in the Customer Followups panel on /tasks."
                  >
                    <Plus className="h-3.5 w-3.5" /> Add customer followup
                  </button>
                  <span className="text-[11px] text-slate-500 self-center leading-snug">
                    Type the suffix above, then click. Empty = sensible default.
                  </span>
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

            {drawerTab === "email" && (() => {
              const drafts = drawerData.analyses
                .filter((a) => a.kind === "other" && typeof (a.metadata as Record<string, unknown>)?.subkind === "string" && String((a.metadata as Record<string, unknown>).subkind).startsWith("email_draft_"))
                .map((a) => ({ a, parsed: parseAnalysis(a) }));
              return (
                <>
                  <Section title="Compose">
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
                  <Section title={`Saved drafts (${drafts.length})`}>
                    {drafts.length === 0 ? (
                      <div className="text-sm text-slate-500">No saved drafts yet. Generate one above.</div>
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
                      <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
                        <AnalysisThumbs
                          analysis={a}
                          onRated={(patch) => patchAnalysisLocal(a.id, patch)}
                        />
                        <div className="flex items-center gap-3">
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
                    </div>
                  ))}
                  </Section>
                </>
              );
            })()}

            {drawerTab === "history" && (() => {
              const items = drawerData.analyses
                .filter((a) => a.kind === "per_shipment" || a.kind === "summary")
                .map((a) => ({ a, parsed: parseAnalysis(a) }));
              return (
                <>
                  <RecentChangeLog diff={drawerData.recent_diff} />
                  <div className="flex justify-end mb-2">
                    <button
                      disabled={!drawerId}
                      onClick={() => { if (drawerId) setReanalyzeOpen(true); }}
                      className="text-xs px-2.5 py-1 rounded-md bg-sky-50 text-sky-700 ring-1 ring-sky-200 hover:bg-sky-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                      title="Re-analyze on a chosen model and review before replacing"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Re-analyze
                    </button>
                  </div>
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
                      {parsed.flavor === "shipment" ? (
                        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                          <span className="text-[11px] text-slate-500 leading-snug">
                            Was this analysis useful? <span className="text-slate-400">Feedback feeds the next AI run on this shipment.</span>
                          </span>
                          <AnalysisThumbs
                            analysis={a}
                            onRated={(patch) => patchAnalysisLocal(a.id, patch)}
                          />
                        </div>
                      ) : null}
                    </div>
                    ))}
                  </Section>
                  {/* Raw scrape collapsed under Analysis — was its own tab,
                      now folded here behind a <details> so it stays out
                      of the way for normal use. */}
                  <details className="mb-6 rounded-xl ring-1 ring-slate-200 bg-white">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-900 px-4 py-3 select-none">
                      Raw scrape
                    </summary>
                    <pre className="text-[11px] bg-slate-900 text-slate-100 p-3 rounded-b-xl whitespace-pre-wrap max-h-[60vh] overflow-auto">
                      {JSON.stringify(drawerData.shipment.raw_data, null, 2)}
                    </pre>
                  </details>
                </>
              );
            })()}
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>

      {reanalyzeOpen && drawerId && drawerData ? (
        <ReanalyzeModal
          shipmentId={drawerId}
          current={{
            ai_issue: drawerData.shipment.ai_issue,
            ai_recommendation: drawerData.shipment.ai_recommendation,
            action_required: drawerData.shipment.action_required,
            // action_confidence is a DB-only column, not on the Shipment type.
            action_confidence: null,
            action_source: drawerData.shipment.action_source,
          }}
          currentModel={drawerData.analyses.find((a) => a.kind === "per_shipment")?.model ?? null}
          onClose={() => setReanalyzeOpen(false)}
          onReplaced={() => { void refreshDrawer(drawerId); }}
        />
      ) : null}

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
              placeholder="Why are you overriding the AI? (also used as the followup task suffix)"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm mb-3"
              maxLength={500}
            />
            {/* Combo actions: create followup task(s) + optionally auto-
                draft an AI email in the same submit. Both followup
                boxes can be checked → both tasks created. autoDraftEmail
                opens the email modal targeted at carrier (preferred)
                or customer when only the customer box is ticked. */}
            <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-2.5 mb-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Also do</div>
              <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={overrideModal.createCarrierFollowup}
                  onChange={(e) => setOverrideModal({ ...overrideModal, createCarrierFollowup: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="font-medium text-slate-900">Create Carrier Followup task</span>
                  <span className="text-[11px] text-slate-500 block">Title: <span className="font-mono">Carrier followup: {overrideModal.reason.trim() || "follow-up needed"}</span></span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={overrideModal.createCustomerFollowup}
                  onChange={(e) => setOverrideModal({ ...overrideModal, createCustomerFollowup: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="font-medium text-slate-900">Create Customer Followup task</span>
                  <span className="text-[11px] text-slate-500 block">Title: <span className="font-mono">Customer followup: {overrideModal.reason.trim() || "status update needed"}</span></span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer select-none border-t border-slate-200 pt-2 mt-1">
                <input
                  type="checkbox"
                  checked={overrideModal.autoDraftEmail}
                  onChange={(e) => setOverrideModal({ ...overrideModal, autoDraftEmail: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="font-medium text-slate-900">Auto-draft email with AI</span>
                  <span className="text-[11px] text-slate-500 block">
                    Opens the email-draft modal after override. Targets <span className="font-semibold">{overrideModal.createCustomerFollowup && !overrideModal.createCarrierFollowup ? "customer" : "carrier"}</span> (carrier wins ties).
                  </span>
                </span>
              </label>
            </div>
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
              >{overrideModal.busy ? "Saving…" : (overrideModal.value === null && !overrideModal.createCarrierFollowup && !overrideModal.createCustomerFollowup && !overrideModal.autoDraftEmail ? "Clear override" : "Apply")}</button>
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

// =====================================================================
// High-level shipment summary header. Renders the five identifiers
// operators reference constantly — Shipment ID, Tracking Number,
// Customer, Carrier, Status — as a labeled key/value grid pinned at
// the top of the drawer body. We surface it on EVERY drawer tab (not
// just Overview) because the rep often jumps to Email / Drafts /
// Analysis and still needs these top-of-mind without scrolling back.
// Also embeds the Action control (override / Modify) so the rep can
// flip the action state without scrolling to the Overview tab.
// =====================================================================
interface ShipmentSummaryHeaderProps {
  shipment: Shipment;
  onOverrideClick: () => void;
  actionEditBusy: boolean;
  onSetAction: (v: "YES" | "NO" | "RESOLVED") => void | Promise<void>;
  onRevertToAi: () => void | Promise<void>;
}

// =====================================================================
// RecentChangeLog — surfaces the field-level diff from the most recent
// scrape (the same `recent_changes` block the per-shipment AI prompt
// now sees). Renders nothing when there's no diff (first scrape, or
// no material changes since last time). Helps reps eyeball "what
// moved" so they can sanity-check the AI's verdict against the real
// change.
// =====================================================================
function RecentChangeLog({ diff }: { diff: ShipmentRecentDiff | null }) {
  if (!diff || !diff.diff || typeof diff.diff !== "object") return null;
  const entries = Object.entries(diff.diff);
  if (entries.length === 0) return null;

  function fmtVal(v: unknown): string {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v.trim() || "—";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  return (
    <Section title="What changed since last scrape">
      <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-3 mb-3 text-xs">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            {entries.length} field{entries.length === 1 ? "" : "s"} changed
          </span>
          <span className="text-[11px] text-amber-700">
            scraped {fmtRelative(diff.scraped_at)}{diff.scraped_by ? ` by ${diff.scraped_by}` : ""}
          </span>
        </div>
        <div className="space-y-1.5">
          {entries.map(([field, change]) => {
            const prev = change && typeof change === "object" && "prev" in change ? change.prev : undefined;
            const next = change && typeof change === "object" && "next" in change ? change.next : undefined;
            return (
              <div key={field} className="grid grid-cols-[140px_1fr] gap-2 items-start">
                <div className="text-[11px] font-mono font-semibold text-slate-700 truncate" title={field}>
                  {field}
                </div>
                <div className="text-[11px] flex items-center gap-1.5 flex-wrap">
                  <span className="line-through text-slate-500 break-all">{fmtVal(prev)}</span>
                  <span className="text-slate-400">→</span>
                  <span className="text-slate-900 font-medium break-all">{fmtVal(next)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 pt-2 border-t border-amber-200/80 text-[10px] text-amber-700/80 leading-snug">
          The per-shipment AI sees this same change-log when it re-analyzes — flags
          and recommendations should reflect what just moved.
        </div>
      </div>
    </Section>
  );
}

// =====================================================================
// AnalysisThumbs — 👍 / 👎 buttons for any AI analysis (per-shipment
// analysis, single-shipment email draft, etc.). Posts the rating to
// /api/analyses/:id/rating, calls onRated() so the parent can update
// its local drawerData and the prior_ai_analysis prompt context picks
// up the rating on the next per-shipment AI re-run. Clicking the
// active thumb clears the rating (mistaken click).
// =====================================================================
function AnalysisThumbs({ analysis, onRated }: {
  analysis: AiAnalysis;
  onRated: (next: Partial<AiAnalysis>) => void;
}) {
  const [busy, setBusy] = useState(false);
  // Local mirror of rating_reason so the textarea stays editable
  // without round-tripping every keystroke. Synced from the prop
  // whenever the parent's analysis row changes (rating cleared,
  // refetch, etc.).
  const [reason, setReason] = useState<string>(analysis.rating_reason || "");
  const [savedReason, setSavedReason] = useState<string>(analysis.rating_reason || "");
  const [reasonSaving, setReasonSaving] = useState(false);
  useEffect(() => {
    setReason(analysis.rating_reason || "");
    setSavedReason(analysis.rating_reason || "");
  }, [analysis.id, analysis.rating, analysis.rating_reason]);

  async function rate(target: "up" | "down") {
    if (busy) return;
    const next = analysis.rating === target ? null : target;
    setBusy(true);
    // Optimistic local update — parent state mutates instantly so the
    // active thumb flips before the request returns. Roll back on
    // error by reverting to whatever the row had before.
    onRated({
      rating: next,
      rated_by: null,
      rated_at: next ? new Date().toISOString() : null,
      rating_reason: next ? (reason || null) : null,
    });
    try {
      const r = await api.analyses.rate(analysis.id, { rating: next, reason: next ? (reason || undefined) : undefined });
      onRated({
        rating: r.analysis.rating,
        rated_by: r.analysis.rated_by,
        rated_at: r.analysis.rated_at,
        rating_reason: r.analysis.rating_reason,
      });
    } catch {
      // Revert on failure.
      onRated({
        rating: analysis.rating ?? null,
        rated_by: analysis.rated_by ?? null,
        rated_at: analysis.rated_at ?? null,
        rating_reason: analysis.rating_reason ?? null,
      });
    } finally { setBusy(false); }
  }

  // Save the reason on blur if it actually changed and there's a
  // rating to attach it to. Server clears rating_reason when rating
  // is null, so writing a reason without a rating is a no-op.
  async function saveReason() {
    if (!analysis.rating) return;
    const trimmed = reason.trim();
    if (trimmed === (savedReason || "").trim()) return;
    setReasonSaving(true);
    try {
      const r = await api.analyses.rate(analysis.id, { rating: analysis.rating, reason: trimmed });
      setSavedReason(r.analysis.rating_reason || "");
      onRated({
        rating: r.analysis.rating,
        rated_by: r.analysis.rated_by,
        rated_at: r.analysis.rated_at,
        rating_reason: r.analysis.rating_reason,
      });
    } catch {
      // Leave the textarea contents alone so the rep can retry.
    } finally { setReasonSaving(false); }
  }

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <div className="inline-flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => rate("up")}
          disabled={busy}
          className={
            "inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-2 py-1 ring-1 transition disabled:opacity-50 " +
            (analysis.rating === "up"
              ? "bg-emerald-600 text-white ring-emerald-700"
              : "bg-white text-slate-600 ring-slate-200 hover:bg-emerald-50 hover:text-emerald-700 hover:ring-emerald-200")
          }
          aria-pressed={analysis.rating === "up"}
          title={analysis.rating === "up" ? "Click again to clear" : "Mark this AI output as useful"}
        >
          <ThumbsUp className="h-3 w-3" /> Good
        </button>
        <button
          onClick={() => rate("down")}
          disabled={busy}
          className={
            "inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-2 py-1 ring-1 transition disabled:opacity-50 " +
            (analysis.rating === "down"
              ? "bg-rose-600 text-white ring-rose-700"
              : "bg-white text-slate-600 ring-slate-200 hover:bg-rose-50 hover:text-rose-700 hover:ring-rose-200")
          }
          aria-pressed={analysis.rating === "down"}
          title={analysis.rating === "down" ? "Click again to clear" : "Mark this AI output as not useful — feeds into the next analysis"}
        >
          <ThumbsDown className="h-3 w-3" /> Needs work
        </button>
        {analysis.rated_by ? (
          <span className="text-[10px] text-slate-400 ml-1" title={`Rated ${analysis.rated_at ? fmtRelative(analysis.rated_at) : ""}`}>
            by {analysis.rated_by}
          </span>
        ) : null}
      </div>
      {analysis.rating ? (
        <div className="flex items-start gap-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            onBlur={saveReason}
            disabled={busy || reasonSaving}
            rows={2}
            placeholder={analysis.rating === "up"
              ? "What worked? (optional) — feeds the next analysis on this shipment"
              : "What was wrong? (optional) — feeds the next analysis on this shipment"}
            className="w-full text-[11px] text-slate-700 rounded-md ring-1 ring-slate-200 bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50 resize-y"
          />
          {reasonSaving ? (
            <span className="text-[10px] text-slate-400 mt-1.5 shrink-0">Saving…</span>
          ) : reason.trim() && reason.trim() !== (savedReason || "").trim() ? (
            <span className="text-[10px] text-slate-400 mt-1.5 shrink-0">Unsaved</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// =====================================================================
// ActionDispositionControl — clickable ActionBadge + popover. Replaces
// the previous two-step "tick Modify, then click chip" flow with a
// single click on the badge that opens a tiny menu of disposition
// options (Action needed / On track / Resolved). Click-outside closes
// it. The full Override modal (with reason + followup creation) is
// still reachable via the "More options…" link inside the popover.
// =====================================================================
interface ActionDispositionControlProps {
  shipment: Shipment;
  actionEditBusy: boolean;
  onSetAction: (v: "YES" | "NO" | "RESOLVED") => void | Promise<void>;
  onRevertToAi: () => void | Promise<void>;
  onOverrideClick: () => void;
}

function ActionDispositionControl({ shipment, actionEditBusy, onSetAction, onRevertToAi, onOverrideClick }: ActionDispositionControlProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape. Both anchored to the wrapping div
  // so clicks on the badge or inside the popover don't trip close.
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isManual = shipment.action_source === "manual";

  return (
    <div ref={wrapRef} className="relative mt-0.5">
      <div className="flex items-center gap-2 flex-wrap">
        <ActionBadge
          action={shipment.action_required}
          onClick={() => setOpen((v) => !v)}
          title="Click to disposition this shipment"
        />
        {isManual ? (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800 ring-1 ring-amber-200"
            title={`Overridden by ${shipment.action_overridden_by || "?"}${shipment.action_override_reason ? ` — ${shipment.action_override_reason}` : ""}`}
          >Manual</span>
        ) : (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-600" title="Set by AI">From AI</span>
        )}
      </div>

      {open ? (
        <div
          role="menu"
          className="absolute z-30 mt-1.5 left-0 min-w-[220px] rounded-lg ring-1 ring-slate-200 bg-white shadow-lg p-1.5"
        >
          <div className="px-2 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Set disposition
          </div>
          {(["YES", "NO", "RESOLVED"] as const).map((v) => {
            const active = shipment.action_required === v;
            const tone =
              v === "YES" ? "text-rose-700 hover:bg-rose-50"
              : v === "NO" ? "text-emerald-700 hover:bg-emerald-50"
              : "text-violet-700 hover:bg-violet-50";
            const label = v === "YES" ? "Action needed" : v === "NO" ? "On track" : "Manually resolved";
            return (
              <button
                key={v}
                role="menuitem"
                disabled={actionEditBusy || active}
                onClick={async () => {
                  await onSetAction(v);
                  setOpen(false);
                }}
                className={`w-full text-left text-sm rounded-md px-2 py-1.5 inline-flex items-center justify-between gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
                title={active ? "Already set" : `Set action to ${label}`}
              >
                <span className="font-medium">{label}</span>
                {active ? <Check className="h-3.5 w-3.5 text-slate-400" /> : null}
              </button>
            );
          })}
          <div className="my-1 border-t border-slate-100" />
          <button
            role="menuitem"
            disabled={actionEditBusy || !isManual}
            onClick={async () => {
              await onRevertToAi();
              setOpen(false);
            }}
            className="w-full text-left text-xs rounded-md px-2 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            title={isManual ? "Clear override and let the AI value stand" : "Already on the AI value"}
          >
            Revert to AI
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onOverrideClick(); }}
            className="w-full text-left text-xs rounded-md px-2 py-1.5 text-sky-700 hover:bg-sky-50"
            title="Open the full override dialog (add a reason, create followups, draft an email)"
          >
            More options…
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ShipmentSummaryHeader({
  shipment,
  onOverrideClick,
  actionEditBusy,
  onSetAction,
  onRevertToAi,
}: ShipmentSummaryHeaderProps) {
  const status = shipment.shipment_status || "—";
  const carrier = shipment.carrier_name || shipment.carrier || "—";
  // Tone the status pill based on common-case strings; default to slate.
  // Best-effort match — FreightPOP's status vocabulary is open-ended and
  // we don't want to invent a regex per phrase.
  const s = status.toLowerCase();
  const statusTone =
    /deliver/.test(s) ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
    : /transit|in.?route/.test(s) ? "bg-sky-100 text-sky-800 ring-sky-200"
    : /pick|tender/.test(s) ? "bg-violet-100 text-violet-800 ring-violet-200"
    : /delay|late|hold|except/.test(s) ? "bg-amber-100 text-amber-800 ring-amber-200"
    : /cancel|fail/.test(s) ? "bg-rose-100 text-rose-800 ring-rose-200"
    : "bg-slate-100 text-slate-700 ring-slate-200";
  return (
    <div className="mb-4 rounded-xl ring-1 ring-slate-200 bg-gradient-to-br from-white to-slate-50 px-4 py-3">
      <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Shipment ID</div>
          <div className="text-base font-bold text-slate-900 truncate" title={shipment.shipment_id || ""}>
            {shipment.shipment_id || "—"}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Tracking #</div>
          <div className="text-sm font-mono font-semibold text-slate-900 truncate" title={shipment.tracking_number || ""}>
            {shipment.tracking_number || "—"}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Customer</div>
          <div className="text-sm font-medium text-slate-900 truncate" title={shipment.customer_name || ""}>
            {shipment.customer_name || "—"}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Carrier</div>
          <div className="text-sm font-medium text-slate-900 truncate" title={carrier}>
            {carrier}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Status</div>
          <div className="mt-0.5">
            <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ${statusTone}`}>
              {status}
            </span>
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Action</div>
          <ActionDispositionControl
            shipment={shipment}
            actionEditBusy={actionEditBusy}
            onSetAction={onSetAction}
            onRevertToAi={onRevertToAi}
            onOverrideClick={onOverrideClick}
          />
        </div>
      </div>
    </div>
  );
}

function TaskBanner({ task, busy, onSetStatus, onSaveDescription, onCreateInverseFollowup }: {
  task: ShipmentTask;
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
}) {
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
          {descError ? <div className="text-[11px] text-rose-700 mt-1">{descError}</div> : null}
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
          <div className="text-xs text-slate-600 leading-snug whitespace-pre-wrap flex-1 min-w-0">{task.description}</div>
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
      <div className="flex items-center justify-between gap-2 mt-2.5 flex-wrap">
        <div className="text-[11px] text-slate-500">
          {task.assigned_to ? <span className="mr-2">{task.assigned_to}</span> : null}
          <span>created {new Date(task.created_at).toLocaleDateString()}</span>
        </div>
        <div className="inline-flex items-center gap-1.5 flex-wrap">
          {inverseAudience ? (
            <button
              type="button"
              disabled={inverseBusy}
              onClick={handleInverse}
              className={
                "text-xs font-semibold rounded-md px-2.5 py-1 inline-flex items-center gap-1 ring-1 transition disabled:opacity-50 " +
                (inverseDone
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : inverseAudience === "carrier"
                  ? "bg-white text-violet-700 ring-violet-200 hover:bg-violet-50"
                  : "bg-white text-sky-700 ring-sky-200 hover:bg-sky-50")
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
          {task.tracking_number ? (
            <button
              type="button"
              onClick={() => requestAutoFilter()}
              className="text-xs font-semibold rounded-md px-2.5 py-1 bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-1"
              title={`Filter the embedded FreightPOP grid to ${task.tracking_number}`}
            >
              Load in FreightPOP
            </button>
          ) : null}
          {task.tracking_number ? (
            <button
              type="button"
              onClick={() => requestOpenTracking()}
              className="text-xs font-semibold rounded-md px-2.5 py-1 ring-1 ring-slate-300 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              title={`Open the FreightPOP tracking modal for ${task.tracking_number} in the embedded panel`}
            >
              Open tracking #
            </button>
          ) : null}
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

// The previous in-page FreightPopEmbed and split-view sidebar were
// retired in favor of the singleton FreightPopOverlay (mounted at App
// scope) so the iframe survives route changes and keeps the user
// logged into FreightPOP across every prev/next walk.
