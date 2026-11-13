import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle, Ban, CheckCircle2, Clock, Filter, Layers, ListChecks,
  ExternalLink, Loader2, Mail, MailPlus, PanelRightOpen, Play, RefreshCw, Search, UserPlus, X, Wand2, ShieldCheck, Undo2, RotateCcw, FileText, MessageSquareText, HelpCircle,
} from "lucide-react";
import { api } from "../lib/api";
import type {
  DailySummaryResult, TaskBoard, TaskBoardRow, TaskStatus, TaskTriageResult,
} from "../lib/types";
import { KPI } from "../components/KPI";
import { LoadingState } from "../components/LoadingState";
import { FpTotalsTrend } from "../components/FpTotalsTrend";
import { TaskRulesButton } from "../components/TaskRulesDialog";
import { useAuth } from "../lib/auth";
import { ErrorBlock } from "../components/ErrorBlock";
import { UserPicker } from "../components/UserPicker";
import { swrGet, swrSet } from "../lib/swrCache";
import { setTasksView } from "../lib/tasksView";
import {
  BOARD_KEY, OFF_DASHBOARD_WINDOW_MS, PREF_KEY, PRIORITY_WEIGHT, SEGMENT_SHORT, isActive, loadPrefs, looksDelivered,
  type GroupBy, type Prefs, type SortBy,
  taskMode,
  openTasksInTabs, SLOW_TABS,
} from "../components/tasksV2/shared";
import { modeLabel } from "../components/ModePicker";
import { RailItem, RailSection } from "../components/tasksV2/Rail";
import { GroupRows } from "../components/tasksV2/Rows";
import { TriagePanel } from "../components/tasksV2/TriagePanel";
import { DailySummaryPanel } from "../components/tasksV2/DailySummaryPanel";
import { DismissModal } from "../components/tasksV2/DismissModal";
import { GroupEmailComposer, type EmailAudience } from "../components/tasksV2/GroupEmailComposer";
import { PromptsDialog, loadAiNotes, saveAiNotes, type AiNotes } from "../components/tasksV2/PromptsDialog";

// ---------------------------------------------------------------------------
// Tasks v2
// ---------------------------------------------------------------------------
// Why a second page instead of another filter on /tasks: the classic page
// segments by status and by the Carrier/Customer title prefix only. What
// operators actually asked for on 2026-09-22 was to see, at a glance, which
// tasks are moot (shipment delivered / no longer flagged), which are working
// from stale carrier data, which are stacked on the same shipment, and which
// are repeat failures — and then to have the heavy model say what to work
// first. The server does the classification (lib/taskSegments.js); this page
// is the rail + board + triage panel over it. The pieces live in
// components/tasksV2/ (shared, Rail, Rows, TriagePanel, DailySummaryPanel,
// DismissModal); this file owns the state and the layout.
//
// Deliberately no hard-delete here. "Dismiss" cancels with a reason so the
// row stays as a dedup tombstone — a deleted task on a still-flagged
// shipment respawns on the next scrape, which is what produced the
// "duplicates" complaint in the first place.

// ---- deep links ------------------------------------------------------
// The board's view lives in the URL so a link reopens exactly what the
// sender saw: segment, health flags, grouping, sort, search, the owner /
// carrier / mode filters, and an open group email.
//   /tasks/v2?group=carrier&carrier=SAIA&email=carrier&to=SAIA
const SEGS = ["all", "attention", "redelivery", "return_claim", "storage_risk", "carrier", "customer", "other"];
const GROUPS = ["none", "segment", "carrier", "customer", "assignee", "shipment", "mode"];
const SORTS = ["smart", "age", "priority", "scrape"];
const VIEW_PARAMS = ["seg", "flag", "group", "sort", "q", "owner", "carrier", "mode", "email", "to", "tasks"];
const pick = <T extends string>(v: string | null, allowed: string[], fallback: T): T => (v && allowed.includes(v) ? (v as T) : fallback);
// Task ids travel as their first 8 characters to keep links short.
const ID_PREFIX = 8;

interface Emailing { ids: string[]; audience: EmailAudience; to: string | null; whole: boolean }

export function TasksV2Page() {
  const { profile: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const navigate = useNavigate();
  const location = useLocation();
  // The link this page was opened with. A link that sets any part of the
  // view sets all of it: what it leaves out is the default, not this
  // browser's saved preference.
  const link = useRef(new URLSearchParams(location.search)).current;
  const linked = VIEW_PARAMS.some((k) => link.has(k));
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const saved = loadPrefs();
    if (!linked) return saved;
    return {
      ...saved,
      seg: pick<Prefs["seg"]>(link.get("seg"), SEGS, "all"),
      flags: (link.get("flag") || "").split(",").filter(Boolean) as Prefs["flags"],
      groupBy: pick<GroupBy>(link.get("group"), GROUPS, "none"),
      sortBy: pick<SortBy>(link.get("sort"), SORTS, "smart"),
    };
  });
  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }, [prefs]);
  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const [search, setSearch] = useState(() => link.get("q") || "");
  const [assigneeFilter, setAssigneeFilter] = useState<string>(() => link.get("owner") || "");
  const [carrierFilter, setCarrierFilter] = useState<string>(() => link.get("carrier") || "");
  const [modeFilter, setModeFilter] = useState(() => link.get("mode") || "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [assignTo, setAssignTo] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<{ ids: string[]; disposition: string; reason: string } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Group email composer: the tasks it was opened on, and who it addresses.
  const [emailing, setEmailing] = useState<Emailing | null>(null);
  // A linked group email can only be rebuilt once the board has loaded.
  const pendingEmail = useRef<{ audience: EmailAudience; to: string | null; tasks: string[] } | null>(
    link.get("email") === "carrier" || link.get("email") === "customer"
      ? { audience: link.get("email") as EmailAudience, to: link.get("to"), tasks: (link.get("tasks") || "").split(",").filter(Boolean) }
      : null);

  const [triage, setTriage] = useState<TaskTriageResult | null>(null);
  const [triageBusy, setTriageBusy] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [daily, setDaily] = useState<DailySummaryResult | null>(null);
  const [dailyBusy, setDailyBusy] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  // Per-user extra instructions sent with each AI run (AI prompts dialog).
  const [aiNotes, setAiNotes] = useState<AiNotes>(loadAiNotes);
  useEffect(() => { saveAiNotes(aiNotes); }, [aiNotes]);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(() => { try { return localStorage.getItem("fpx.tasks.v2.guide") !== "hidden"; } catch { return true; } });
  const setGuide = (open: boolean) => { setGuideOpen(open); try { localStorage.setItem("fpx.tasks.v2.guide", open ? "shown" : "hidden"); } catch { /* ignore */ } };

  async function load(silent = false) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const b = await api.tasks.v2Board({ include_closed: prefs.includeClosed ? 1 : 0 });
      setBoard(b);
      swrSet(BOARD_KEY, b);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  }
  async function loadTriage() {
    try { setTriage(await api.tasks.v2TriageLatest()); } catch { /* panel just shows "no triage yet" */ }
  }
  async function loadDaily() {
    try { setDaily(await api.tasks.v2DailySummaryLatest()); } catch { /* panel shows "not generated yet" */ }
  }
  async function runDaily(hours: number) {
    if (dailyBusy) return;
    setDailyBusy(true); setDailyError(null);
    try {
      const r = await api.tasks.v2DailySummary({ hours, notes: aiNotes.daily.trim() || undefined });
      setDaily(r);
      setPref("dailyOpen", true);
    } catch (e) { setDailyError((e as Error).message); }
    finally { setDailyBusy(false); }
  }
  useEffect(() => {
    const cached = swrGet<TaskBoard>(BOARD_KEY);
    if (cached?.rows?.length) { setBoard(cached); setLoading(false); load(true); }
    else load();
    loadTriage();
    loadDaily();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(true); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.includeClosed]);

  const rows = board?.rows ?? [];
  const summary = board?.summary;
  const staleDays = board?.stale_days ?? 7;
  // Owners are stored as emails; show the person's name everywhere.
  const people = board?.people ?? {};
  const nameOf = (who: string | null | undefined) => {
    const k = (who || "").trim();
    if (!k) return "";
    return people[k] || people[k.toLowerCase()] || k;
  };
  const rowById = useMemo(() => new Map(rows.map((r) => [r.task.id, r])), [rows]);
  const queuedCount = useMemo(() => rows.filter((r) => r.task.email_queued_at && isActive(r.task.status)).length, [rows]);

  // Reopen a linked group email: the listed tasks, or else every active task
  // on the board for that carrier / customer.
  useEffect(() => {
    const want = pendingEmail.current;
    if (!want || !rows.length) return;
    pendingEmail.current = null;
    const nameOf2 = (r: TaskBoardRow) => (want.audience === "carrier" ? (r.shipment?.carrier_name || r.shipment?.carrier || "") : (r.shipment?.customer_name || "")).trim();
    const ids = want.tasks.length
      ? rows.filter((r) => want.tasks.some((t) => r.task.id.startsWith(t))).map((r) => r.task.id)
      : want.to ? rows.filter((r) => isActive(r.task.status) && nameOf2(r).toLowerCase() === want.to!.toLowerCase()).map((r) => r.task.id) : [];
    if (ids.length) setEmailing({ ids, audience: want.audience, to: want.to, whole: !want.tasks.length });
    else setError("That link points to a group email whose tasks are no longer on the board.");
  }, [rows]);

  // Keep the address bar in step with the view (replace, so Back still
  // leaves the page instead of undoing one filter at a time).
  useEffect(() => {
    if (pendingEmail.current) return; // don't drop the link before it's restored
    const p = new URLSearchParams(location.search);
    const set = (k: string, v: string | null | undefined, dflt = "") => { if (v && v !== dflt) p.set(k, v); else p.delete(k); };
    set("seg", prefs.seg, "all");
    set("flag", prefs.flags.join(","));
    set("group", prefs.groupBy, "none");
    set("sort", prefs.sortBy, "smart");
    set("q", search.trim());
    set("owner", assigneeFilter);
    set("carrier", carrierFilter);
    set("mode", modeFilter);
    set("email", emailing?.audience);
    set("to", emailing?.to);
    set("tasks", emailing && !emailing.whole ? emailing.ids.slice(0, 60).map((id) => id.slice(0, ID_PREFIX)).join(",") : "");
    const next = p.toString();
    if (next !== new URLSearchParams(location.search).toString()) navigate({ search: next ? `?${next}` : "" }, { replace: true, state: location.state });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.seg, prefs.flags, prefs.groupBy, prefs.sortBy, search, assigneeFilter, carrierFilter, modeFilter, emailing]);

  // Triage rank per task id — feeds the "smart" sort and the rank chip.
  const triageRank = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of triage?.triage?.priority_queue ?? []) m.set(p.task_id, p.rank);
    return m;
  }, [triage]);
  const closeCandidateIds = useMemo(() => new Set((triage?.triage?.close_candidates ?? []).map((c) => c.task_id)), [triage]);

  // Newest scrape across the board, and which rows' shipments weren't seen
  // near it (= no longer on FreightPOP's dashboard).
  // Tasks to skip: shipment left the dashboard, or it's delivered and the
  // task isn't post-delivery work.
  const { offDashboardIds, offCounts } = useMemo(() => {
    const seen = rows.map((r) => (r.shipment?.scraped_at ? Date.parse(r.shipment.scraped_at) : NaN)).filter(Number.isFinite);
    const cutoff = seen.length ? Math.max(...seen) - OFF_DASHBOARD_WINDOW_MS : -Infinity;
    const ids = new Set<string>();
    let left = 0, delivered = 0;
    for (const r of rows) {
      if (!isActive(r.task.status)) continue;
      if (r.shipment?.scraped_at && Date.parse(r.shipment.scraped_at) < cutoff) { ids.add(r.task.id); left++; }
      else if (looksDelivered(r)) { ids.add(r.task.id); delivered++; }
    }
    return { offDashboardIds: ids, offCounts: { left, delivered } };
  }, [rows]);

  const visible = useMemo(() => {
    let list = rows;
    if (prefs.onDashboardOnly) list = list.filter((r) => !offDashboardIds.has(r.task.id));
    if (prefs.seg === "attention") {
      list = list.filter((r) => isActive(r.task.status) && !r.seg.flags.includes("resolved_upstream")
        && (r.seg.segment === "redelivery" || r.seg.segment === "return_claim" || r.seg.segment === "storage_risk" || r.seg.flags.includes("repeat")));
    } else if (prefs.seg !== "all") {
      list = list.filter((r) => r.seg.segment === prefs.seg);
    }
    for (const f of prefs.flags) list = list.filter((r) => r.seg.flags.includes(f));
    if (assigneeFilter) list = list.filter((r) => ((r.task.assigned_to || "").trim() || "(unassigned)") === assigneeFilter);
    if (modeFilter) list = list.filter((r) => (taskMode(r) || "(none)") === modeFilter);
    if (carrierFilter) list = list.filter((r) => ((r.shipment?.carrier_name || r.shipment?.carrier || "").trim() || "(unknown)") === carrierFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => [
        r.task.title, r.task.description, r.task.assigned_to, r.task.tracking_number,
        r.shipment?.shipment_id, r.shipment?.customer_name, r.shipment?.carrier_name, r.shipment?.destination,
      ].filter(Boolean).join(" ").toLowerCase().includes(q));
    }
    const sorted = [...list];
    const age = (r: TaskBoardRow) => Date.parse(r.task.created_at) || 0;
    const scrape = (r: TaskBoardRow) => (r.shipment?.scraped_at ? Date.parse(r.shipment.scraped_at) : 0);
    if (prefs.sortBy === "age") sorted.sort((a, b) => age(a) - age(b));
    else if (prefs.sortBy === "priority") sorted.sort((a, b) => PRIORITY_WEIGHT[a.task.priority] - PRIORITY_WEIGHT[b.task.priority] || age(a) - age(b));
    else if (prefs.sortBy === "scrape") sorted.sort((a, b) => scrape(a) - scrape(b));
    else {
      // smart: triage rank → needs-attention → moot last → priority → oldest
      const score = (r: TaskBoardRow) => {
        const rank = triageRank.get(r.task.id);
        if (rank !== undefined) return rank;
        let s = 1000;
        if (r.seg.flags.includes("resolved_upstream")) s += 5000;
        if (!isActive(r.task.status)) s += 9000;
        if (r.seg.segment === "redelivery" || r.seg.segment === "return_claim" || r.seg.segment === "storage_risk" || r.seg.flags.includes("repeat")) s -= 500;
        s += PRIORITY_WEIGHT[r.task.priority] * 100;
        return s;
      };
      sorted.sort((a, b) => score(a) - score(b) || age(a) - age(b));
    }
    return sorted;
  }, [rows, prefs.seg, prefs.flags, prefs.sortBy, prefs.onDashboardOnly, offDashboardIds, assigneeFilter, carrierFilter, modeFilter, search, triageRank]);

  // Open a task in the drawer. Router state tells the /tasks/:id route we
  // came from v2 and hands it the board's current active order, so the
  // drawer's prev/next chevrons walk THIS list and closing the drawer
  // returns here instead of the classic Tasks page.
  const openTask = (id: string) => navigate(`/tasks/v2/${id}`, {
    state: { from: `/tasks/v2${location.search}`, walkIds: visible.filter((r) => isActive(r.task.status)).map((r) => r.task.id) },
  });

  const groups = useMemo(() => {
    if (prefs.groupBy === "none") return [{ key: "__all", label: "", rows: visible }];
    const keyFn = (r: TaskBoardRow): string => {
      switch (prefs.groupBy) {
        case "segment": return SEGMENT_SHORT[r.seg.segment];
        case "carrier": return (r.shipment?.carrier_name || r.shipment?.carrier || "").trim() || "(unknown carrier)";
        case "customer": return (r.shipment?.customer_name || "").trim() || "(unknown customer)";
        case "assignee": return nameOf(r.task.assigned_to) || "(unassigned)";
        case "mode": return taskMode(r) ? modeLabel(taskMode(r)) : "(no mode)";
        case "shipment": return r.shipment ? `${r.shipment.tracking_number || "?"} · ${r.shipment.customer_name || ""}` : "(no shipment)";
        default: return "";
      }
    };
    const m = new Map<string, TaskBoardRow[]>();
    for (const r of visible) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
    return Array.from(m.entries()).map(([key, rows]) => ({ key, label: key, rows }))
      .sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, prefs.groupBy, people]);

  // Shipment mode: counts for the filter (active tasks) and bulk-complete of
  // whatever the mode filter currently shows.
  const modeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (isActive(r.task.status)) { const k = taskMode(r) || "(none)"; m.set(k, (m.get(k) || 0) + 1); }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const modeActiveIds = useMemo(() => (modeFilter ? visible.filter((r) => isActive(r.task.status)).map((r) => r.task.id) : []), [visible, modeFilter]);
  async function completeMode() {
    if (!modeActiveIds.length || bulkBusy) return;
    const label = modeFilter === "(none)" ? "no-mode" : modeLabel(modeFilter);
    if (!window.confirm(`Mark ${modeActiveIds.length} ${label} task${modeActiveIds.length === 1 ? "" : "s"} as done?\n\nThis covers the tasks currently listed (other filters and search apply). You can reopen them from "Show recently closed".`)) return;
    setBulkBusy(true); setError(null);
    try {
      for (let i = 0; i < modeActiveIds.length; i += 200) await api.tasks.bulkUpdate({ ids: modeActiveIds.slice(i, i + 200), status: "done" });
      setSelected(new Set()); await load(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBulkBusy(false); }
  }

  const visibleIds = useMemo(() => visible.map((r) => r.task.id), [visible]);
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  // Shift-click ticks everything between this row and the last one ticked.
  const lastTicked = useRef<string | null>(null);
  function toggle(id: string, shift = false) {
    const from = lastTicked.current;
    lastTicked.current = id;
    setSelected((p) => {
      const n = new Set(p);
      const a = shift && from ? visibleIds.indexOf(from) : -1;
      const b = visibleIds.indexOf(id);
      if (a >= 0 && b >= 0 && a !== b) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(visibleIds[i]); return n; }
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  // Selected tasks in board order.
  const selectedInOrder = () => visibleIds.filter((id) => selected.has(id));
  // Open the selection in the drawer: prev / next steps through just these.
  function walkSelection() {
    const ids = selectedInOrder();
    if (ids.length) navigate(`/tasks/v2/${ids[0]}`, { state: { from: `/tasks/v2${location.search}`, walkIds: ids } });
  }
  // Open every selected task in its own browser tab.
  function openSelectionInTabs() {
    const ids = selectedInOrder();
    const blocked = openTasksInTabs(ids);
    if (blocked) setError(`Your browser blocked ${blocked} of ${ids.length} tabs. Allow pop-ups for this site, or use “Open ${ids.length}” to step through them in the drawer.`);
  }
  function toggleAll() {
    setSelected((p) => {
      const n = new Set(p);
      if (visibleIds.every((id) => n.has(id))) visibleIds.forEach((id) => n.delete(id));
      else visibleIds.forEach((id) => n.add(id));
      return n;
    });
  }
  // Keep selection honest as the board reloads.
  useEffect(() => { setSelected((p) => new Set(Array.from(p).filter((id) => rowById.has(id)))); }, [rowById]);

  // ---- mutations -----------------------------------------------------
  function patchLocal(updated: Partial<TaskBoardRow["task"]> & { id: string }) {
    setBoard((b) => b ? { ...b, rows: b.rows.map((r) => (r.task.id === updated.id ? { ...r, task: { ...r.task, ...updated } } : r)) } : b);
  }
  async function setStatus(id: string, status: TaskStatus, opts: { open?: boolean } = {}) {
    try {
      const { task } = await api.tasks.update(id, { status });
      patchLocal(task);
      if (opts.open) openTask(id);
    } catch (e) { setError((e as Error).message); }
  }
  async function bulk(fn: () => Promise<unknown>) {
    if (bulkBusy) return;
    setBulkBusy(true); setError(null);
    try { await fn(); setSelected(new Set()); await load(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBulkBusy(false); }
  }
  const bulkStatus = (status: TaskStatus) => bulk(() => api.tasks.bulkUpdate({ ids: Array.from(selected), status }));
  const bulkAssign = () => { const who = (assignTo || "").trim(); if (!who) return; bulk(() => api.tasks.bulkUpdate({ ids: Array.from(selected), assigned_to: who })); };
  function openDismiss(ids: string[], disposition = "dismissed", reason = "") {
    if (!ids.length) return;
    setDismissing({ ids, disposition, reason });
  }
  async function confirmDismiss() {
    if (!dismissing) return;
    const { ids, disposition, reason } = dismissing;
    setDismissing(null);
    await bulk(() => api.tasks.v2Dismiss({ ids, disposition, reason }));
  }

  async function runTriage(scope: { segment?: string; ids?: string[] } = {}) {
    if (triageBusy) return;
    setTriageBusy(true); setTriageError(null);
    try {
      const r = await api.tasks.v2Triage({ ...scope, notes: aiNotes.triage.trim() || undefined });
      setTriage(r);
      setPref("triageOpen", true);
    } catch (e) {
      const msg = (e as Error).message;
      setTriageError(/No active tasks in scope/i.test(msg)
        ? "Nothing to triage: the selected segment has no open, in-progress or blocked tasks. Pick another segment or run it on the whole board."
        : msg);
    }
    finally { setTriageBusy(false); }
  }
  // What "AI triage" would run over from the current rail selection — a
  // named segment, or the whole active board. Drives the button's enabled
  // state so an empty segment can't fire a request that 400s.
  const triageScope = useMemo(() => {
    const segment = prefs.seg !== "all" && prefs.seg !== "attention" ? prefs.seg : null;
    const active = rows.filter((r) => isActive(r.task.status) && (!segment || r.seg.segment === segment));
    return { segment, count: active.length };
  }, [rows, prefs.seg]);

  // Dismiss every close candidate the model named, grouped by disposition
  // so each tombstone carries the model's reason.
  async function dismissAllCandidates() {
    const cands = (triage?.triage?.close_candidates ?? []).filter((c) => rowById.has(c.task_id) && isActive(rowById.get(c.task_id)!.task.status));
    if (!cands.length) return;
    if (!confirm(`Dismiss ${cands.length} task${cands.length === 1 ? "" : "s"} the triage flagged as moot? They stay on record as cancelled.`)) return;
    setBulkBusy(true); setError(null);
    try {
      const byDisp = new Map<string, string[]>();
      for (const c of cands) { if (!byDisp.has(c.disposition)) byDisp.set(c.disposition, []); byDisp.get(c.disposition)!.push(c.task_id); }
      for (const [disposition, ids] of byDisp) await api.tasks.v2Dismiss({ ids, disposition, reason: "AI triage close candidate" });
      setSelected(new Set());
      await load(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBulkBusy(false); }
  }

  // ---- derived for KPIs + rail ----------------------------------------
  const kpi = useMemo(() => {
    const active = rows.filter((r) => isActive(r.task.status));
    return {
      active: active.length,
      attention: summary?.needs_attention ?? 0,
      resolved: active.filter((r) => r.seg.flags.includes("resolved_upstream")).length,
      stale: active.filter((r) => r.seg.flags.includes("stale")).length,
      unassigned: active.filter((r) => r.seg.flags.includes("unassigned")).length,
    };
  }, [rows, summary]);
  const assignees = useMemo(() => Object.entries(summary?.by_assignee ?? {}).sort((a, b) => b[1] - a[1]), [summary]);
  const carriers = useMemo(() => Object.entries(summary?.by_carrier ?? {}).sort((a, b) => b[1] - a[1]), [summary]);

  const segmentHelp = useMemo(() => Object.fromEntries((board?.segments ?? []).map((x) => [x.id, x.description])), [board]);

  const selectedActive = Array.from(selected).filter((id) => { const r = rowById.get(id); return r && isActive(r.task.status); });

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Layers className="h-6 w-6 text-slate-700" /> Tasks <span className="text-xs font-semibold uppercase tracking-wide bg-violet-100 text-violet-800 ring-1 ring-violet-200 rounded px-1.5 py-0.5">v2</span>
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Follow-ups the AI raised from the latest scrapes. Filter on the left, open a row to see why it exists, then start, finish or dismiss it.
            {!guideOpen ? <button onClick={() => setGuide(true)} className="ml-2 text-violet-700 hover:underline inline-flex items-center gap-1"><HelpCircle className="h-3.5 w-3.5" /> How this works</button> : null}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => { setTasksView("legacy"); navigate("/tasks/legacy"); }}
            className="rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-slate-50"
            title="Open the legacy Tasks list and make it your default until you switch back"
          >
            <Undo2 className="h-4 w-4" /> Legacy view
          </button>
          {isAdmin ? <TaskRulesButton /> : null}
          <button onClick={() => setPromptsOpen(true)} className="rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-slate-50"
            title={aiNotes.triage || aiNotes.daily ? "Your extra instructions are on for the next AI run" : "See or change what the AI is told for triage and the daily summary"}>
            <MessageSquareText className="h-4 w-4" /> AI prompts
            {aiNotes.triage || aiNotes.daily ? <span className="h-2 w-2 rounded-full bg-violet-500" aria-label="Extra instructions on" /> : null}
          </button>
          <button onClick={() => load()} className="rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-slate-50" title="Reload board">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button
            onClick={() => runTriage(triageScope.segment ? { segment: triageScope.segment } : {})}
            disabled={triageBusy || triageScope.count === 0}
            className="rounded-lg bg-violet-600 text-white text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title={triageScope.count === 0
              ? (triageScope.segment ? `No active ${SEGMENT_SHORT[triageScope.segment]} tasks to triage` : "No active tasks to triage")
              : triageScope.segment ? `Triage the ${triageScope.count} active ${SEGMENT_SHORT[triageScope.segment]} task(s) with the heavy model` : `Triage all ${triageScope.count} active tasks with the heavy model`}
          >
            {triageBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {triageBusy ? "Triaging…" : triageScope.segment ? `AI triage: ${SEGMENT_SHORT[triageScope.segment]} (${triageScope.count})` : `AI triage board (${triageScope.count})`}
          </button>
          <button
            onClick={() => runDaily(24)}
            disabled={dailyBusy}
            className="rounded-lg ring-1 ring-violet-300 bg-white text-violet-800 text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Generate the detailed daily executive summary for the last 24h with the heavy model"
          >
            {dailyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            {dailyBusy ? "Writing brief…" : "Daily exec summary"}
          </button>
        </div>
      </div>

      {error ? <div className="mb-4"><ErrorBlock>{error}</ErrorBlock></div> : null}

      {/* First-visit guide */}
      {guideOpen ? (
        <div className="mb-4 rounded-2xl ring-1 ring-violet-200 bg-violet-50/60 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold text-slate-900 text-sm inline-flex items-center gap-1.5"><HelpCircle className="h-4 w-4 text-violet-600" /> How this board works</div>
            <button onClick={() => setGuide(false)} className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"><X className="h-3.5 w-3.5" /> Got it, hide</button>
          </div>
          <ol className="grid md:grid-cols-4 gap-3 text-xs text-slate-700">
            <li><span className="font-semibold text-slate-900">1. Pick what to look at.</span> The left side filters by task type, health and owner. "Needs attention" is redeliveries, returns/claims, storage risk and repeat failures.</li>
            <li><span className="font-semibold text-slate-900">2. See why.</span> Click "Why this task?" on a row for the AI's finding, the suggested next step, what each badge means, and a box to add a note.</li>
            <li><span className="font-semibold text-slate-900">3. Act.</span> ▶ starts a task, ✓ marks it done, ⊘ dismisses it with a reason. Dismissed tasks stay on record, so they aren't created again on the next scrape.</li>
            <li><span className="font-semibold text-slate-900">4. Let the AI sort it.</span> "AI triage" ranks what to work first and lists tasks that are probably no longer needed. "AI prompts" lets you add your own instructions.</li>
          </ol>
          <div className="text-[11px] text-slate-500 mt-2">Stale = the shipment hasn't been scraped in {staleDays}+ days, so the task may be working from old data.</div>
        </div>
      ) : null}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <KPI label="Active tasks" value={kpi.active} icon={ListChecks} />
        <KPI label="Needs attention" value={kpi.attention} icon={AlertTriangle} tone={kpi.attention ? "danger" : "default"} hint="Redelivery, return/claim, storage risk, repeat failures" />
        <KPI label="Likely resolved" value={kpi.resolved} icon={ShieldCheck} tone={kpi.resolved ? "success" : "default"} hint="Delivered / archived / AI says no" />
        <KPI label="Stale data" value={kpi.stale} icon={Clock} tone={kpi.stale ? "warn" : "default"} hint={`No scrape in ${staleDays}+ days`} />
        <KPI label="Unassigned" value={kpi.unassigned} icon={UserPlus} tone={kpi.unassigned ? "warn" : "default"} />
      </div>

      {/* FreightPOP dashboard totals from the last scrape runs */}
      <div className="mb-4"><FpTotalsTrend compact groups={["fp", "disp"]} /></div>

      {/* Daily executive summary */}
      <DailySummaryPanel
        result={daily}
        busy={dailyBusy}
        error={dailyError}
        open={prefs.dailyOpen}
        onToggle={() => setPref("dailyOpen", !prefs.dailyOpen)}
        onRun={runDaily}
        rows={rows}
        onOpenTask={(id) => openTask(id)}
      />

      {/* Triage panel */}
      <TriagePanel
        result={triage}
        busy={triageBusy}
        error={triageError}
        open={prefs.triageOpen}
        onToggle={() => setPref("triageOpen", !prefs.triageOpen)}
        rowById={rowById}
        people={people}
        onOpen={(id) => openTask(id)}
        onStart={(id) => setStatus(id, "in_progress", { open: true })}
        onDismissOne={(id, disposition, reason) => openDismiss([id], disposition, reason)}
        onDismissAll={dismissAllCandidates}
        onSelectBatch={(ids) => setSelected(new Set(ids.filter((id) => rowById.has(id))))}
      />

      <div className="flex gap-4 items-start">
        {/* Rail */}
        <aside className="w-60 shrink-0 space-y-4">
          <RailSection title="Segments">
            <RailItem active={prefs.seg === "all"} onClick={() => setPref("seg", "all")} label="All" count={summary?.total ?? 0} />
            <RailItem active={prefs.seg === "attention"} onClick={() => setPref("seg", "attention")} label="Needs attention" count={summary?.needs_attention ?? 0} tone="rose" />
            {(board?.segments ?? []).map((s) => (
              <RailItem key={s.id} active={prefs.seg === s.id} onClick={() => setPref("seg", s.id)} label={s.label} count={summary?.by_segment?.[s.id] ?? 0} title={s.description} />
            ))}
          </RailSection>
          <RailSection title="Health" hint="Filters stack">
            {(board?.flags ?? []).map((f) => {
              const on = prefs.flags.includes(f.id);
              return (
                <RailItem
                  key={f.id}
                  active={on}
                  onClick={() => setPref("flags", on ? prefs.flags.filter((x) => x !== f.id) : [...prefs.flags, f.id])}
                  label={f.label}
                  count={summary?.by_flag?.[f.id] ?? 0}
                  title={f.description}
                  tone={f.tone}
                  checkbox
                />
              );
            })}
          </RailSection>
          <RailSection title="Owner">
            <RailItem active={!assigneeFilter} onClick={() => setAssigneeFilter("")} label="Everyone" count={summary?.total ?? 0} />
            {assignees.map(([who, n]) => (
              <RailItem key={who} active={assigneeFilter === who} onClick={() => setAssigneeFilter(assigneeFilter === who ? "" : who)} label={who === "(unassigned)" ? who : nameOf(who)} count={n} title={who} />
            ))}
          </RailSection>
        </aside>

        {/* Board */}
        <div className="flex-1 min-w-0">
          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tracking, customer, carrier, title…"
                className="rounded-lg border border-slate-200 pl-8 pr-8 py-2 text-sm bg-white w-72 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none"
                aria-label="Search tasks"
              />
              {search ? <button type="button" onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Clear search"><X className="h-3.5 w-3.5" /></button> : null}
            </div>
            <select value={carrierFilter} onChange={(e) => setCarrierFilter(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white max-w-[14rem]" aria-label="Carrier">
              <option value="">All carriers</option>
              {carriers.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
            </select>
            <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white" aria-label="Shipment mode">
              <option value="">All modes</option>
              {modeCounts.map(([m, n]) => <option key={m} value={m}>{m === "(none)" ? "No mode" : modeLabel(m)} ({n})</option>)}
            </select>
            {modeFilter && modeActiveIds.length ? (
              <button type="button" disabled={bulkBusy} onClick={completeMode}
                title="Marks every open, in-progress or blocked task in the list below as done"
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white px-3 py-2 text-sm hover:bg-emerald-700 disabled:opacity-50">
                <CheckCircle2 className="h-4 w-4" /> Complete all {modeActiveIds.length} {modeFilter === "(none)" ? "no-mode" : modeLabel(modeFilter)} shown
              </button>
            ) : null}
            <label className="inline-flex items-center gap-1.5 text-sm text-slate-600">
              <Filter className="h-4 w-4 text-slate-400" />
              <select value={prefs.groupBy} onChange={(e) => setPref("groupBy", e.target.value as GroupBy)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white" aria-label="Group by">
                <option value="none">No grouping</option>
                <option value="segment">Group: segment</option>
                <option value="carrier">Group: carrier</option>
                <option value="customer">Group: customer</option>
                <option value="assignee">Group: owner</option>
                <option value="mode">Group: mode</option>
                <option value="shipment">Group: shipment</option>
              </select>
            </label>
            <select value={prefs.sortBy} onChange={(e) => setPref("sortBy", e.target.value as SortBy)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white" aria-label="Sort">
              <option value="smart">Sort: recommended (AI rank, then urgent)</option>
              <option value="priority">Sort: priority</option>
              <option value="age">Sort: oldest first</option>
              <option value="scrape">Sort: stalest data first</option>
            </select>
            <label
              className="inline-flex items-center gap-1.5 text-xs text-slate-600 select-none cursor-pointer px-2 py-2 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 ml-auto"
              title={`Hides tasks whose shipment left the FreightPOP dashboard (${offCounts.left}) or is delivered (${offCounts.delivered}). Claim, damage, return and redelivery tasks are kept.`}
            >
              <input type="checkbox" checked={prefs.onDashboardOnly} onChange={(e) => setPref("onDashboardOnly", e.target.checked)} className="h-3.5 w-3.5 accent-violet-600 cursor-pointer" />
              <span>Hide delivered &amp; off-dashboard{offDashboardIds.size ? <span className="text-slate-400"> ({offDashboardIds.size})</span> : null}</span>
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 select-none cursor-pointer px-2 py-2 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50" title="Include tasks completed or dismissed in the last 7 days">
              <input type="checkbox" checked={prefs.includeClosed} onChange={(e) => setPref("includeClosed", e.target.checked)} className="h-3.5 w-3.5 accent-violet-600 cursor-pointer" />
              <span>Show recently closed</span>
            </label>
            <span className="text-xs text-slate-500">{visible.length} of {rows.length}</span>
            {queuedCount ? (
              <button type="button" onClick={() => navigate("/email-studio")} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-violet-50 text-violet-800 ring-1 ring-violet-200 hover:bg-violet-100" title="Open Email Studio to group and draft these">
                <Mail className="h-3.5 w-3.5" /> {queuedCount} queued for email
              </button>
            ) : null}
          </div>

          {/* Bulk bar */}
          {selected.size ? (
            <div className="mb-3 rounded-xl bg-slate-900 text-white px-4 py-2.5 flex items-center gap-3 flex-wrap text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <span className="text-slate-400">·</span>
              <button onClick={walkSelection} className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2.5 py-1" title="Open these in the drawer and step through them with the arrows (j / k)"><PanelRightOpen className="h-3.5 w-3.5" /> Open {selected.size}</button>
              <button onClick={openSelectionInTabs} className="inline-flex items-center gap-1 rounded-md bg-white/10 hover:bg-white/20 px-2.5 py-1" title={selected.size > SLOW_TABS ? `Open all ${selected.size} in their own browser tabs. That many will take a second to load.` : "Open each one in its own browser tab"}><ExternalLink className="h-3.5 w-3.5" /> Open all in tabs</button>
              <button disabled={bulkBusy || !selectedActive.length} onClick={() => bulkStatus("in_progress")} className="inline-flex items-center gap-1 rounded-md bg-indigo-500 hover:bg-indigo-400 px-2.5 py-1 disabled:opacity-50"><Play className="h-3.5 w-3.5" /> Start</button>
              <button disabled={bulkBusy || !selectedActive.length} onClick={() => bulkStatus("done")} className="inline-flex items-center gap-1 rounded-md bg-emerald-500 hover:bg-emerald-400 px-2.5 py-1 disabled:opacity-50"><CheckCircle2 className="h-3.5 w-3.5" /> Done</button>
              <button disabled={bulkBusy || !selectedActive.length} onClick={() => openDismiss(selectedActive)} className="inline-flex items-center gap-1 rounded-md bg-slate-600 hover:bg-slate-500 px-2.5 py-1 disabled:opacity-50"><Ban className="h-3.5 w-3.5" /> Dismiss…</button>
              <div className="flex items-center gap-1.5 ml-2">
                <div className="w-56 text-slate-900"><UserPicker value={assignTo} onChange={setAssignTo} placeholder="Assign to…" size="sm" /></div>
                <button disabled={bulkBusy || !(assignTo || "").trim()} onClick={bulkAssign} className="inline-flex items-center gap-1 rounded-md bg-sky-500 hover:bg-sky-400 px-2.5 py-1 disabled:opacity-50"><UserPlus className="h-3.5 w-3.5" /> Assign</button>
              </div>
              <button disabled={bulkBusy || !selectedActive.length} onClick={() => bulk(() => api.tasks.bulkUpdate({ ids: selectedActive, email_queued: true }))} className="inline-flex items-center gap-1 rounded-md bg-slate-600 hover:bg-slate-500 px-2.5 py-1 disabled:opacity-50" title="Mark these for email. They collect in Email Studio, grouped by carrier or customer."><MailPlus className="h-3.5 w-3.5" /> Queue for email</button>
              <button disabled={!selectedActive.length} onClick={() => setEmailing({ ids: selectedActive, audience: prefs.groupBy === "customer" ? "customer" : "carrier", to: null, whole: false })} className="inline-flex items-center gap-1 rounded-md bg-fuchsia-500 hover:bg-fuchsia-400 px-2.5 py-1 disabled:opacity-50" title="Draft one email per carrier (or customer) covering every selected shipment"><Mail className="h-3.5 w-3.5" /> Email {prefs.groupBy === "customer" ? "customer" : "carrier"}…</button>
              <button disabled={bulkBusy} onClick={() => runTriage({ ids: Array.from(selected) })} className="inline-flex items-center gap-1 rounded-md bg-violet-500 hover:bg-violet-400 px-2.5 py-1 disabled:opacity-50" title="Triage only the selected tasks"><Wand2 className="h-3.5 w-3.5" /> Triage selection</button>
              <button onClick={() => setSelected(new Set())} className="ml-auto text-slate-300 hover:text-white inline-flex items-center gap-1"><X className="h-3.5 w-3.5" /> Clear</button>
            </div>
          ) : null}

          {/* Table */}
          <div className="rounded-2xl ring-1 ring-slate-200 bg-white overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 w-8"><input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all visible" className="accent-violet-600" /></th>
                  <th className="text-left px-3 py-2">Task</th>
                  <th className="text-left px-3 py-2">Shipment</th>
                  <th className="text-left px-3 py-2 w-20" title="Shipment mode from FreightPOP (LTL, FTL, Parcel)">Mode</th>
                  <th className="text-left px-3 py-2 w-28" title="When this shipment was last read from FreightPOP">Last scraped</th>
                  <th className="text-left px-3 py-2 w-20">Age</th>
                  <th className="text-left px-3 py-2 w-32">Owner</th>
                  <th className="text-left px-3 py-2 w-24">Status</th>
                  <th className="px-3 py-2 w-36"></th>
                </tr>
              </thead>
              <tbody>
                {loading && !rows.length ? <LoadingState variant="row" colSpan={9} /> : null}
                {!loading && !visible.length ? (
                  <tr><td colSpan={9} className="p-10 text-center text-slate-500">
                    {rows.length ? "No tasks match these filters." : "No active tasks. 🎉"}
                    {(prefs.flags.length || prefs.seg !== "all" || assigneeFilter || carrierFilter || search) ? (
                      <div className="mt-2"><button onClick={() => { setPref("seg", "all"); setPref("flags", []); setAssigneeFilter(""); setCarrierFilter(""); setSearch(""); }} className="text-sky-700 hover:underline inline-flex items-center gap-1 text-sm"><RotateCcw className="h-3.5 w-3.5" /> Reset filters</button></div>
                    ) : null}
                  </td></tr>
                ) : null}
                {groups.map((g) => {
                  const collapsed = collapsedGroups.has(g.key);
                  return (
                    <GroupRows
                      key={g.key}
                      group={g}
                      showHeader={prefs.groupBy !== "none"}
                      collapsed={collapsed}
                      onToggle={() => setCollapsedGroups((p) => { const n = new Set(p); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}
                      onSelectGroup={() => setSelected((p) => { const n = new Set(p); g.rows.forEach((r) => n.add(r.task.id)); return n; })}
                      // Carrier / customer groups get a one-click "Email group".
                      // If some of the group is ticked, the email covers just those.
                      emailLabel={prefs.groupBy === "carrier" || prefs.groupBy === "customer" ? prefs.groupBy : undefined}
                      onEmailGroup={() => {
                        const active = g.rows.filter((r) => isActive(r.task.status)).map((r) => r.task.id);
                        const ticked = active.filter((id) => selected.has(id));
                        setEmailing({ ids: ticked.length ? ticked : active, audience: prefs.groupBy === "customer" ? "customer" : "carrier", to: g.label, whole: !ticked.length });
                      }}
                      selected={selected}
                      toggle={toggle}
                      triageRank={triageRank}
                      closeCandidateIds={closeCandidateIds}
                      staleDays={staleDays}
                      flagsMeta={board?.flags ?? []}
                      segmentHelp={segmentHelp}
                      people={people}
                      onOpen={(id) => openTask(id)}
                      onStatus={setStatus}
                      onDismiss={(id) => openDismiss([id])}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {promptsOpen ? <PromptsDialog notes={aiNotes} onNotes={setAiNotes} isAdmin={isAdmin} onClose={() => setPromptsOpen(false)} /> : null}

      {emailing ? (
        <GroupEmailComposer
          rows={emailing.ids.map((id) => rowById.get(id)).filter((r): r is TaskBoardRow => !!r)}
          initialAudience={emailing.audience}
          initialTo={emailing.to}
          onView={(audience, to) => setEmailing((e) => (e && (e.audience !== audience || e.to !== to) ? { ...e, audience, to, whole: e.whole && e.audience === audience && e.to === to } : e))}
          onClose={() => setEmailing(null)}
          onTasksChanged={() => { void load(true); }}
        />
      ) : null}

      {dismissing ? (
        <DismissModal
          count={dismissing.ids.length}
          disposition={dismissing.disposition}
          reason={dismissing.reason}
          onChange={(patch) => setDismissing((d) => (d ? { ...d, ...patch } : d))}
          onCancel={() => setDismissing(null)}
          onConfirm={confirmDismiss}
          busy={bulkBusy}
        />
      ) : null}
    </div>
  );
}
