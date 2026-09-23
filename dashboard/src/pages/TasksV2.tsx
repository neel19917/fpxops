import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronRight, Clock, ExternalLink, Filter, Layers, ListChecks,
  Loader2, Play, RefreshCw, Search, Sparkles, UserPlus, X, Wand2, ShieldCheck, Undo2, RotateCcw,
} from "lucide-react";
import { api } from "../lib/api";
import type {
  TaskBoard, TaskBoardRow, TaskFlag, TaskPriority, TaskSegment, TaskStatus, TaskTriage, TaskTriageResult,
} from "../lib/types";
import { fmtDate, fmtRelative, fmtUsd } from "../lib/format";
import { useNav } from "../lib/nav";
import { KPI } from "../components/KPI";
import { LoadingState } from "../components/LoadingState";
import { ErrorBlock } from "../components/ErrorBlock";
import { UserPicker } from "../components/UserPicker";
import { swrGet, swrSet } from "../lib/swrCache";

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
// is the rail + board + triage panel over it.
//
// Deliberately no hard-delete here. "Dismiss" cancels with a reason so the
// row stays as a dedup tombstone — a deleted task on a still-flagged
// shipment respawns on the next scrape, which is what produced the
// "duplicates" complaint in the first place.

type SegFilter = "all" | "attention" | TaskSegment;
type GroupBy = "none" | "segment" | "carrier" | "customer" | "assignee" | "shipment";
type SortBy = "smart" | "age" | "priority" | "scrape";

const BOARD_KEY = "tasks.v2.board";
const PREF_KEY = "fpx.tasks.v2.prefs";

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const PRIORITY_CLS: Record<TaskPriority, string> = {
  urgent: "bg-rose-100 text-rose-800 ring-rose-200",
  high: "bg-amber-100 text-amber-800 ring-amber-200",
  normal: "bg-sky-50 text-sky-800 ring-sky-200",
  low: "bg-slate-100 text-slate-600 ring-slate-200",
};
const STATUS_CLS: Record<TaskStatus, string> = {
  open: "bg-slate-100 text-slate-700 ring-slate-200",
  in_progress: "bg-indigo-100 text-indigo-800 ring-indigo-200",
  blocked: "bg-amber-100 text-amber-800 ring-amber-200",
  done: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  cancelled: "bg-slate-100 text-slate-500 ring-slate-200 line-through",
};
const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open", in_progress: "In progress", blocked: "Blocked", done: "Done", cancelled: "Dismissed",
};
const SEGMENT_CLS: Record<TaskSegment, string> = {
  redelivery: "bg-rose-50 text-rose-800 ring-rose-200",
  return_claim: "bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-200",
  storage_risk: "bg-amber-50 text-amber-900 ring-amber-300",
  carrier: "bg-sky-50 text-sky-800 ring-sky-200",
  customer: "bg-teal-50 text-teal-800 ring-teal-200",
  other: "bg-slate-100 text-slate-700 ring-slate-200",
};
const SEGMENT_SHORT: Record<TaskSegment, string> = {
  redelivery: "Redelivery", return_claim: "Return / claim", storage_risk: "Storage risk", carrier: "Carrier", customer: "Customer", other: "Other",
};
const FLAG_CLS: Record<string, string> = {
  emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
  rose: "bg-rose-50 text-rose-800 ring-rose-200",
  orange: "bg-orange-50 text-orange-800 ring-orange-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};
const DISPOSITION_LABEL: Record<string, string> = {
  resolved: "Resolved upstream", stale: "Stale data", duplicate: "Duplicate", superseded: "Superseded", not_actionable: "Not actionable",
};

function isActive(s: TaskStatus) { return s === "open" || s === "in_progress" || s === "blocked"; }

// Same bucketing rule as the classic page so a status reads the same color
// on both boards.
function shipmentStatusTone(status: string | null | undefined): { label: string; cls: string } {
  const raw = (status || "").trim();
  const s = raw.toLowerCase();
  if (!s) return { label: "no status", cls: "bg-slate-100 text-slate-500 ring-slate-200" };
  if (s.includes("deliver")) return { label: raw, cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" };
  if (s.includes("out for")) return { label: raw, cls: "bg-teal-50 text-teal-800 ring-teal-200" };
  if (s.includes("transit") || s.includes("en route") || s.includes("moving")) return { label: raw, cls: "bg-sky-50 text-sky-800 ring-sky-200" };
  if (s.includes("issue") || s.includes("exception") || s.includes("problem") || s.includes("delay")) return { label: raw, cls: "bg-rose-50 text-rose-800 ring-rose-200" };
  if (s.includes("pickup") || s.includes("booked") || s.includes("scheduled") || s.includes("dispatch")) return { label: raw, cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  return { label: raw, cls: "bg-slate-100 text-slate-700 ring-slate-200" };
}

function Pill({ children, cls, title }: { children: ReactNode; cls: string; title?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 whitespace-nowrap ${cls}`} title={title}>
      {children}
    </span>
  );
}

// Strip the "Carrier followup: Redelivery — " scaffolding so the title
// column shows the actual ask; the segment badge already says the rest.
function shortTitle(title: string): string {
  return title
    .replace(/^(carrier|customer) followup:\s*/i, "")
    .replace(/^(redelivery|return\/claim|storage risk) — /i, "")
    .trim();
}

interface Prefs { seg: SegFilter; flags: TaskFlag[]; groupBy: GroupBy; sortBy: SortBy; triageOpen: boolean; includeClosed: boolean }
const DEFAULT_PREFS: Prefs = { seg: "all", flags: [], groupBy: "none", sortBy: "smart", triageOpen: true, includeClosed: false };
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

export function TasksV2Page() {
  const nav = useNav();
  const navigate = useNavigate();
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }, [prefs]);
  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const [search, setSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [carrierFilter, setCarrierFilter] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [assignTo, setAssignTo] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<{ ids: string[]; disposition: string; reason: string } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [triage, setTriage] = useState<TaskTriageResult | null>(null);
  const [triageBusy, setTriageBusy] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);

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
  useEffect(() => {
    const cached = swrGet<TaskBoard>(BOARD_KEY);
    if (cached?.rows?.length) { setBoard(cached); setLoading(false); load(true); }
    else load();
    loadTriage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(true); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.includeClosed]);

  const rows = board?.rows ?? [];
  const summary = board?.summary;
  const staleDays = board?.stale_days ?? 7;
  const rowById = useMemo(() => new Map(rows.map((r) => [r.task.id, r])), [rows]);

  // Triage rank per task id — feeds the "smart" sort and the rank chip.
  const triageRank = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of triage?.triage?.priority_queue ?? []) m.set(p.task_id, p.rank);
    return m;
  }, [triage]);
  const closeCandidateIds = useMemo(() => new Set((triage?.triage?.close_candidates ?? []).map((c) => c.task_id)), [triage]);

  const visible = useMemo(() => {
    let list = rows;
    if (prefs.seg === "attention") {
      list = list.filter((r) => isActive(r.task.status) && !r.seg.flags.includes("resolved_upstream")
        && (r.seg.segment === "redelivery" || r.seg.segment === "return_claim" || r.seg.segment === "storage_risk" || r.seg.flags.includes("repeat")));
    } else if (prefs.seg !== "all") {
      list = list.filter((r) => r.seg.segment === prefs.seg);
    }
    for (const f of prefs.flags) list = list.filter((r) => r.seg.flags.includes(f));
    if (assigneeFilter) list = list.filter((r) => ((r.task.assigned_to || "").trim() || "(unassigned)") === assigneeFilter);
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
  }, [rows, prefs.seg, prefs.flags, prefs.sortBy, assigneeFilter, carrierFilter, search, triageRank]);

  const groups = useMemo(() => {
    if (prefs.groupBy === "none") return [{ key: "__all", label: "", rows: visible }];
    const keyFn = (r: TaskBoardRow): string => {
      switch (prefs.groupBy) {
        case "segment": return SEGMENT_SHORT[r.seg.segment];
        case "carrier": return (r.shipment?.carrier_name || r.shipment?.carrier || "").trim() || "(unknown carrier)";
        case "customer": return (r.shipment?.customer_name || "").trim() || "(unknown customer)";
        case "assignee": return (r.task.assigned_to || "").trim() || "(unassigned)";
        case "shipment": return r.shipment ? `${r.shipment.tracking_number || "?"} · ${r.shipment.customer_name || ""}` : "(no shipment)";
        default: return "";
      }
    };
    const m = new Map<string, TaskBoardRow[]>();
    for (const r of visible) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
    return Array.from(m.entries()).map(([key, rows]) => ({ key, label: key, rows }))
      .sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
  }, [visible, prefs.groupBy]);

  const visibleIds = useMemo(() => visible.map((r) => r.task.id), [visible]);
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  function toggle(id: string) { setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
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
      if (opts.open) nav.openTask(id);
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
      const r = await api.tasks.v2Triage(scope);
      setTriage(r);
      setPref("triageOpen", true);
    } catch (e) { setTriageError((e as Error).message); }
    finally { setTriageBusy(false); }
  }

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
            Segmented board with health flags. Stale = no scrape in {staleDays}d. Dismiss keeps a record so tasks don't respawn.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => navigate("/tasks")} className="rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-slate-50">
            <Undo2 className="h-4 w-4" /> Classic view
          </button>
          <button onClick={() => load()} className="rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-slate-50" title="Reload board">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button
            onClick={() => runTriage(prefs.seg !== "all" && prefs.seg !== "attention" ? { segment: prefs.seg } : {})}
            disabled={triageBusy || kpi.active === 0}
            className="rounded-lg bg-violet-600 text-white text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title={prefs.seg !== "all" && prefs.seg !== "attention" ? `Triage the ${SEGMENT_SHORT[prefs.seg]} segment with the heavy model` : "Triage every active task with the heavy model"}
          >
            {triageBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {triageBusy ? "Triaging…" : prefs.seg !== "all" && prefs.seg !== "attention" ? `AI triage: ${SEGMENT_SHORT[prefs.seg]}` : "AI triage board"}
          </button>
        </div>
      </div>

      {error ? <div className="mb-4"><ErrorBlock>{error}</ErrorBlock></div> : null}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <KPI label="Active tasks" value={kpi.active} icon={ListChecks} />
        <KPI label="Needs attention" value={kpi.attention} icon={AlertTriangle} tone={kpi.attention ? "danger" : "default"} hint="Redelivery, return/claim, storage risk, repeat failures" />
        <KPI label="Likely resolved" value={kpi.resolved} icon={ShieldCheck} tone={kpi.resolved ? "success" : "default"} hint="Delivered / archived / AI says no" />
        <KPI label="Stale data" value={kpi.stale} icon={Clock} tone={kpi.stale ? "warn" : "default"} hint={`No scrape in ${staleDays}+ days`} />
        <KPI label="Unassigned" value={kpi.unassigned} icon={UserPlus} tone={kpi.unassigned ? "warn" : "default"} />
      </div>

      {/* Triage panel */}
      <TriagePanel
        result={triage}
        busy={triageBusy}
        error={triageError}
        open={prefs.triageOpen}
        onToggle={() => setPref("triageOpen", !prefs.triageOpen)}
        rowById={rowById}
        onOpen={(id) => nav.openTask(id)}
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
              <RailItem key={who} active={assigneeFilter === who} onClick={() => setAssigneeFilter(assigneeFilter === who ? "" : who)} label={who} count={n} />
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
            <label className="inline-flex items-center gap-1.5 text-sm text-slate-600">
              <Filter className="h-4 w-4 text-slate-400" />
              <select value={prefs.groupBy} onChange={(e) => setPref("groupBy", e.target.value as GroupBy)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white" aria-label="Group by">
                <option value="none">No grouping</option>
                <option value="segment">Group: segment</option>
                <option value="carrier">Group: carrier</option>
                <option value="customer">Group: customer</option>
                <option value="assignee">Group: owner</option>
                <option value="shipment">Group: shipment</option>
              </select>
            </label>
            <select value={prefs.sortBy} onChange={(e) => setPref("sortBy", e.target.value as SortBy)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white" aria-label="Sort">
              <option value="smart">Sort: smart (triage → attention → priority)</option>
              <option value="priority">Sort: priority</option>
              <option value="age">Sort: oldest first</option>
              <option value="scrape">Sort: stalest data first</option>
            </select>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 select-none cursor-pointer px-2 py-2 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 ml-auto" title="Include tasks completed or dismissed in the last 7 days">
              <input type="checkbox" checked={prefs.includeClosed} onChange={(e) => setPref("includeClosed", e.target.checked)} className="h-3.5 w-3.5 accent-violet-600 cursor-pointer" />
              <span>Show recently closed</span>
            </label>
            <span className="text-xs text-slate-500">{visible.length} of {rows.length}</span>
          </div>

          {/* Bulk bar */}
          {selected.size ? (
            <div className="mb-3 rounded-xl bg-slate-900 text-white px-4 py-2.5 flex items-center gap-3 flex-wrap text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <span className="text-slate-400">·</span>
              <button disabled={bulkBusy || !selectedActive.length} onClick={() => bulkStatus("in_progress")} className="inline-flex items-center gap-1 rounded-md bg-indigo-500 hover:bg-indigo-400 px-2.5 py-1 disabled:opacity-50"><Play className="h-3.5 w-3.5" /> Start</button>
              <button disabled={bulkBusy || !selectedActive.length} onClick={() => bulkStatus("done")} className="inline-flex items-center gap-1 rounded-md bg-emerald-500 hover:bg-emerald-400 px-2.5 py-1 disabled:opacity-50"><CheckCircle2 className="h-3.5 w-3.5" /> Done</button>
              <button disabled={bulkBusy || !selectedActive.length} onClick={() => openDismiss(selectedActive)} className="inline-flex items-center gap-1 rounded-md bg-slate-600 hover:bg-slate-500 px-2.5 py-1 disabled:opacity-50"><Ban className="h-3.5 w-3.5" /> Dismiss…</button>
              <div className="flex items-center gap-1.5 ml-2">
                <div className="w-56 text-slate-900"><UserPicker value={assignTo} onChange={setAssignTo} placeholder="Assign to…" size="sm" /></div>
                <button disabled={bulkBusy || !(assignTo || "").trim()} onClick={bulkAssign} className="inline-flex items-center gap-1 rounded-md bg-sky-500 hover:bg-sky-400 px-2.5 py-1 disabled:opacity-50"><UserPlus className="h-3.5 w-3.5" /> Assign</button>
              </div>
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
                  <th className="text-left px-3 py-2 w-28">Data</th>
                  <th className="text-left px-3 py-2 w-20">Age</th>
                  <th className="text-left px-3 py-2 w-32">Owner</th>
                  <th className="text-left px-3 py-2 w-24">Status</th>
                  <th className="px-3 py-2 w-36"></th>
                </tr>
              </thead>
              <tbody>
                {loading && !rows.length ? <LoadingState variant="row" colSpan={8} /> : null}
                {!loading && !visible.length ? (
                  <tr><td colSpan={8} className="p-10 text-center text-slate-500">
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
                      selected={selected}
                      toggle={toggle}
                      triageRank={triageRank}
                      closeCandidateIds={closeCandidateIds}
                      staleDays={staleDays}
                      flagsMeta={board?.flags ?? []}
                      onOpen={(id) => nav.openTask(id)}
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

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------
function RailSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl ring-1 ring-slate-200 bg-white p-2 shadow-sm">
      <div className="px-2 pt-1 pb-1.5 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
        {hint ? <div className="text-[10px] text-slate-400">{hint}</div> : null}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function RailItem({ active, onClick, label, count, title, tone, checkbox }: {
  active: boolean; onClick: () => void; label: string; count: number; title?: string; tone?: string; checkbox?: boolean;
}) {
  const dot = tone ? (FLAG_CLS[tone] || FLAG_CLS.slate) : "";
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-left transition ${active ? "bg-violet-50 text-violet-900 ring-1 ring-violet-200" : "text-slate-700 hover:bg-slate-50"}`}
    >
      <span className="inline-flex items-center gap-2 min-w-0">
        {checkbox ? <span className={`h-3.5 w-3.5 rounded ring-1 inline-flex items-center justify-center ${active ? "bg-violet-600 ring-violet-600 text-white" : "bg-white ring-slate-300"}`}>{active ? <CheckCircle2 className="h-3 w-3" /> : null}</span> : null}
        {tone && !checkbox ? <span className={`h-2 w-2 rounded-full ring-1 ${dot}`} /> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className={`text-xs tabular-nums ${count ? "text-slate-600" : "text-slate-300"}`}>{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
function GroupRows({ group, showHeader, collapsed, onToggle, onSelectGroup, selected, toggle, triageRank, closeCandidateIds, staleDays, flagsMeta, onOpen, onStatus, onDismiss }: {
  group: { key: string; label: string; rows: TaskBoardRow[] };
  showHeader: boolean; collapsed: boolean; onToggle: () => void; onSelectGroup: () => void;
  selected: Set<string>; toggle: (id: string) => void;
  triageRank: Map<string, number>; closeCandidateIds: Set<string>; staleDays: number;
  flagsMeta: { id: TaskFlag; label: string; tone: string; description: string }[];
  onOpen: (id: string) => void; onStatus: (id: string, s: TaskStatus, opts?: { open?: boolean }) => void; onDismiss: (id: string) => void;
}) {
  const flagMeta = useMemo(() => new Map(flagsMeta.map((f) => [f.id, f])), [flagsMeta]);
  return (
    <>
      {showHeader ? (
        <tr className="bg-slate-50/70 border-t border-slate-200">
          <td colSpan={8} className="px-3 py-1.5">
            <div className="flex items-center gap-2 text-sm">
              <button onClick={onToggle} className="inline-flex items-center gap-1 font-medium text-slate-800 hover:text-slate-950">
                {collapsed ? <ChevronRight className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                {group.label}
              </button>
              <span className="text-xs text-slate-500">{group.rows.length}</span>
              <button onClick={onSelectGroup} className="ml-auto text-xs text-sky-700 hover:underline">Select group</button>
            </div>
          </td>
        </tr>
      ) : null}
      {!collapsed ? group.rows.map((r) => (
        <TaskRow
          key={r.task.id}
          row={r}
          checked={selected.has(r.task.id)}
          onCheck={() => toggle(r.task.id)}
          rank={triageRank.get(r.task.id)}
          closeCandidate={closeCandidateIds.has(r.task.id)}
          staleDays={staleDays}
          flagMeta={flagMeta}
          onOpen={() => onOpen(r.task.id)}
          onStatus={(s, opts) => onStatus(r.task.id, s, opts)}
          onDismiss={() => onDismiss(r.task.id)}
        />
      )) : null}
    </>
  );
}

function TaskRow({ row, checked, onCheck, rank, closeCandidate, staleDays, flagMeta, onOpen, onStatus, onDismiss }: {
  row: TaskBoardRow; checked: boolean; onCheck: () => void; rank?: number; closeCandidate: boolean; staleDays: number;
  flagMeta: Map<string, { id: TaskFlag; label: string; tone: string; description: string }>;
  onOpen: () => void; onStatus: (s: TaskStatus, opts?: { open?: boolean }) => void; onDismiss: () => void;
}) {
  const { task: t, shipment: s, seg } = row;
  const active = isActive(t.status);
  const moot = seg.flags.includes("resolved_upstream");
  const stale = seg.flags.includes("stale");
  const st = shipmentStatusTone(s?.shipment_status);
  return (
    <tr className={`border-t border-slate-100 align-top ${checked ? "bg-violet-50/40" : moot ? "bg-emerald-50/20" : ""} ${!active ? "opacity-60" : ""}`}>
      <td className="px-3 py-2.5"><input type="checkbox" checked={checked} onChange={onCheck} aria-label="Select task" className="accent-violet-600 mt-0.5" /></td>
      <td className="px-3 py-2.5 min-w-[22rem]">
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          {rank !== undefined ? <Pill cls="bg-violet-600 text-white ring-violet-600" title="AI triage priority rank">#{rank}</Pill> : null}
          <Pill cls={SEGMENT_CLS[seg.segment]}>{SEGMENT_SHORT[seg.segment]}{seg.attempt && seg.attempt > 1 ? ` · attempt ${seg.attempt}` : ""}</Pill>
          <Pill cls={PRIORITY_CLS[t.priority]}>{t.priority}</Pill>
          {seg.flags.filter((f) => f !== "unassigned" && f !== "blocked").map((f) => {
            const m = flagMeta.get(f);
            return <Pill key={f} cls={FLAG_CLS[m?.tone || "slate"]} title={m?.description}>{m?.label || f}</Pill>;
          })}
          {closeCandidate ? <Pill cls="bg-emerald-600 text-white ring-emerald-600" title="AI triage suggests dismissing this task">AI: close</Pill> : null}
        </div>
        <button onClick={onOpen} className="text-left font-medium text-slate-900 hover:text-sky-700 leading-snug line-clamp-2" title={t.title}>{shortTitle(t.title)}</button>
        {seg.health ? <div className="text-xs text-slate-500 mt-0.5">{seg.health}</div> : null}
      </td>
      <td className="px-3 py-2.5 min-w-[14rem]">
        {s ? (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-xs text-slate-800">{s.tracking_number || "—"}</span>
              {s.shipment_id ? <span className="text-[11px] text-slate-400">#{s.shipment_id}</span> : null}
              {s.mode ? <span className="text-[10px] uppercase tracking-wide text-slate-400">{s.mode}</span> : null}
            </div>
            <div className="text-xs text-slate-700 truncate max-w-[16rem]" title={s.customer_name || ""}>{s.customer_name || "—"}</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-slate-500 truncate max-w-[9rem]" title={s.carrier_name || s.carrier || ""}>{s.carrier_name || s.carrier || "—"}</span>
              <Pill cls={st.cls}>{st.label}</Pill>
              {s.delivery_date ? <Pill cls="bg-emerald-100 text-emerald-800 ring-emerald-200" title={`Delivered ${fmtDate(s.delivery_date)}`}>delivered</Pill>
                : s.updated_eta ? <span className="text-[11px] text-slate-500">ETA {fmtDate(s.updated_eta)}</span> : null}
            </div>
          </div>
        ) : <span className="text-xs text-slate-400">no shipment</span>}
      </td>
      <td className="px-3 py-2.5">
        {s ? (
          <div className={`text-xs ${stale ? "text-amber-700 font-medium" : "text-slate-600"}`} title={s.scraped_at ? `Scraped ${fmtDate(s.scraped_at)} · stale after ${staleDays}d` : "Never scraped"}>
            <div>{s.scraped_at ? fmtRelative(s.scraped_at) : "never"}</div>
            <div className="text-[11px] text-slate-400">scraped</div>
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-600" title={`Created ${fmtDate(t.created_at)}`}>{seg.age_days === null ? "—" : seg.age_days === 0 ? "today" : `${seg.age_days}d`}</td>
      <td className="px-3 py-2.5 text-xs">
        {t.assigned_to ? <span className="text-slate-800">{t.assigned_to}</span> : <Pill cls={FLAG_CLS.slate}>unassigned</Pill>}
      </td>
      <td className="px-3 py-2.5"><Pill cls={STATUS_CLS[t.status]}>{STATUS_LABEL[t.status]}</Pill></td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1">
          {t.status === "open" ? (
            <IconBtn title="Start and open" onClick={() => onStatus("in_progress", { open: true })} cls="text-indigo-700 hover:bg-indigo-50"><Play className="h-4 w-4" /></IconBtn>
          ) : null}
          {active ? (
            <IconBtn title="Mark done" onClick={() => onStatus("done")} cls="text-emerald-700 hover:bg-emerald-50"><CheckCircle2 className="h-4 w-4" /></IconBtn>
          ) : (
            <IconBtn title="Reopen" onClick={() => onStatus("open")} cls="text-slate-600 hover:bg-slate-100"><RotateCcw className="h-4 w-4" /></IconBtn>
          )}
          {active ? <IconBtn title="Dismiss with reason" onClick={onDismiss} cls="text-slate-500 hover:bg-slate-100"><Ban className="h-4 w-4" /></IconBtn> : null}
          <IconBtn title="Open shipment" onClick={onOpen} cls="text-sky-700 hover:bg-sky-50"><ExternalLink className="h-4 w-4" /></IconBtn>
        </div>
      </td>
    </tr>
  );
}

function IconBtn({ children, title, onClick, cls }: { children: ReactNode; title: string; onClick: () => void; cls: string }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} className={`p-1.5 rounded-md transition ${cls}`}>{children}</button>;
}

// ---------------------------------------------------------------------------
// Triage panel
// ---------------------------------------------------------------------------
function TriagePanel({ result, busy, error, open, onToggle, rowById, onOpen, onStart, onDismissOne, onDismissAll, onSelectBatch }: {
  result: TaskTriageResult | null; busy: boolean; error: string | null; open: boolean; onToggle: () => void;
  rowById: Map<string, TaskBoardRow>;
  onOpen: (id: string) => void; onStart: (id: string) => void;
  onDismissOne: (id: string, disposition: string, reason: string) => void; onDismissAll: () => void;
  onSelectBatch: (ids: string[]) => void;
}) {
  const tri: TaskTriage | null = result?.triage ?? null;
  const has = !!tri && (tri.priority_queue.length || tri.close_candidates.length || tri.batches.length || tri.summary);
  const liveClose = (tri?.close_candidates ?? []).filter((c) => { const r = rowById.get(c.task_id); return r && isActive(r.task.status); });
  return (
    <div className="rounded-2xl ring-1 ring-violet-200 bg-gradient-to-br from-violet-50/70 to-white shadow-sm mb-4">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-violet-500" /> : <ChevronRight className="h-4 w-4 text-violet-500" />}
        <Sparkles className="h-4 w-4 text-violet-600" />
        <span className="font-semibold text-slate-900">AI triage</span>
        {result?.created_at ? (
          <span className="text-xs text-slate-500">
            {fmtRelative(result.created_at)} · {result.model || "model"} · {result.count ?? "?"} tasks{result.cost_usd != null ? ` · ${fmtUsd(result.cost_usd)}` : ""}{result.scope ? ` · ${result.scope}` : ""}
          </span>
        ) : <span className="text-xs text-slate-500">No triage run yet</span>}
        {busy ? <span className="ml-auto text-xs text-violet-700 inline-flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running the heavy model over the board… this can take a minute</span> : null}
      </button>
      {open ? (
        <div className="px-4 pb-4">
          {error ? <div className="mb-3"><ErrorBlock>{error}</ErrorBlock></div> : null}
          {!has && !busy ? (
            <div className="text-sm text-slate-600">
              Run <span className="font-medium">AI triage board</span> to have the heavy model rank what to work first, flag tasks that are probably moot, and batch tasks that should be handled in one call.
            </div>
          ) : null}
          {tri?.summary ? <p className="text-sm text-slate-800 mb-3 leading-relaxed">{tri.summary}</p> : null}
          {tri?.risks?.length ? (
            <ul className="mb-3 space-y-1">
              {tri.risks.map((r, i) => <li key={i} className="text-xs text-amber-900 bg-amber-50 ring-1 ring-amber-200 rounded-md px-2 py-1 inline-flex items-start gap-1.5 mr-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{r}</li>)}
            </ul>
          ) : null}
          {has ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <TriageColumn title={`Work first (${tri!.priority_queue.length})`} tone="violet">
                {tri!.priority_queue.map((p) => {
                  const r = rowById.get(p.task_id);
                  if (!r) return null;
                  return (
                    <div key={p.task_id} className="rounded-lg bg-white ring-1 ring-slate-200 p-2.5 text-xs">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Pill cls="bg-violet-600 text-white ring-violet-600">#{p.rank}</Pill>
                        <Pill cls={SEGMENT_CLS[r.seg.segment]}>{SEGMENT_SHORT[r.seg.segment]}</Pill>
                        <span className="font-mono text-slate-600">{r.shipment?.tracking_number || ""}</span>
                        <span className="text-slate-500 truncate">{r.shipment?.customer_name || ""}</span>
                      </div>
                      <div className="text-slate-800 font-medium line-clamp-2">{shortTitle(r.task.title)}</div>
                      {p.reason ? <div className="text-slate-600 mt-1"><span className="font-medium text-slate-700">Why:</span> {p.reason}</div> : null}
                      {p.first_action ? <div className="text-slate-600 mt-0.5"><span className="font-medium text-slate-700">First:</span> {p.first_action}</div> : null}
                      <div className="flex items-center gap-1 mt-1.5">
                        {r.task.status === "open" ? <button onClick={() => onStart(p.task_id)} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 text-white px-2 py-1 hover:bg-indigo-700"><Play className="h-3 w-3" /> Start</button> : null}
                        <button onClick={() => onOpen(p.task_id)} className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><ExternalLink className="h-3 w-3" /> Open</button>
                        <span className="ml-auto text-slate-400">{r.task.assigned_to || "unassigned"}</span>
                      </div>
                    </div>
                  );
                })}
              </TriageColumn>
              <TriageColumn
                title={`Probably moot (${liveClose.length})`}
                tone="emerald"
                action={liveClose.length ? <button onClick={onDismissAll} className="text-xs inline-flex items-center gap-1 rounded-md bg-emerald-600 text-white px-2 py-1 hover:bg-emerald-700"><Ban className="h-3 w-3" /> Dismiss all {liveClose.length}</button> : undefined}
              >
                {liveClose.map((c) => {
                  const r = rowById.get(c.task_id)!;
                  return (
                    <div key={c.task_id} className="rounded-lg bg-white ring-1 ring-slate-200 p-2.5 text-xs">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Pill cls="bg-emerald-100 text-emerald-800 ring-emerald-200">{DISPOSITION_LABEL[c.disposition] || c.disposition}</Pill>
                        <span className="font-mono text-slate-600">{r.shipment?.tracking_number || ""}</span>
                        <span className="text-slate-500 truncate">{r.shipment?.customer_name || ""}</span>
                      </div>
                      <div className="text-slate-800 line-clamp-2">{shortTitle(r.task.title)}</div>
                      {c.reason ? <div className="text-slate-600 mt-1">{c.reason}</div> : null}
                      <div className="flex items-center gap-1 mt-1.5">
                        <button onClick={() => onDismissOne(c.task_id, c.disposition, c.reason)} className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><Ban className="h-3 w-3" /> Dismiss</button>
                        <button onClick={() => onOpen(c.task_id)} className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><ExternalLink className="h-3 w-3" /> Check</button>
                      </div>
                    </div>
                  );
                })}
                {tri!.close_candidates.length > liveClose.length ? <div className="text-[11px] text-slate-400">{tri!.close_candidates.length - liveClose.length} already closed since this run.</div> : null}
              </TriageColumn>
              <TriageColumn title={`Work together (${tri!.batches.length})`} tone="sky">
                {tri!.batches.map((b, i) => {
                  const live = b.task_ids.filter((id) => rowById.has(id));
                  return (
                    <div key={i} className="rounded-lg bg-white ring-1 ring-slate-200 p-2.5 text-xs">
                      <div className="font-medium text-slate-800">{b.label} <span className="text-slate-400 font-normal">· {live.length} tasks</span></div>
                      {b.reason ? <div className="text-slate-600 mt-0.5">{b.reason}</div> : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {live.slice(0, 8).map((id) => { const r = rowById.get(id)!; return <span key={id} className="font-mono text-[11px] text-slate-600 bg-slate-50 ring-1 ring-slate-200 rounded px-1">{r.shipment?.tracking_number || id.slice(0, 6)}</span>; })}
                        {live.length > 8 ? <span className="text-[11px] text-slate-400">+{live.length - 8}</span> : null}
                      </div>
                      <button onClick={() => onSelectBatch(live)} className="mt-1.5 inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 px-2 py-1 hover:bg-slate-50 text-slate-700"><Layers className="h-3 w-3" /> Select batch</button>
                    </div>
                  );
                })}
              </TriageColumn>
            </div>
          ) : null}
          {result?.truncated ? <div className="text-[11px] text-slate-500 mt-2">Board exceeded the per-run cap; only the first {result.count} tasks were triaged. Narrow to a segment for full coverage.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function TriageColumn({ title, tone, action, children }: { title: string; tone: "violet" | "emerald" | "sky"; action?: ReactNode; children: ReactNode }) {
  const head = tone === "violet" ? "text-violet-800" : tone === "emerald" ? "text-emerald-800" : "text-sky-800";
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className={`text-xs font-semibold uppercase tracking-wide ${head}`}>{title}</div>
        {action}
      </div>
      <div className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-0.5">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dismiss modal
// ---------------------------------------------------------------------------
function DismissModal({ count, disposition, reason, onChange, onCancel, onConfirm, busy }: {
  count: number; disposition: string; reason: string;
  onChange: (patch: { disposition?: string; reason?: string }) => void;
  onCancel: () => void; onConfirm: () => void; busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-900 inline-flex items-center gap-2"><Ban className="h-4 w-4 text-slate-500" /> Dismiss {count} task{count === 1 ? "" : "s"}</h2>
          <button onClick={onCancel} className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-sm text-slate-600 mb-3">
          Marks the task cancelled and stamps the reason on it. It stays on record, so the auto-task builder won't create the same task again on the next scrape. Nothing is deleted.
        </p>
        <label className="block text-xs font-medium text-slate-600 mb-1">Reason category</label>
        <select value={disposition} onChange={(e) => onChange({ disposition: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white mb-3">
          <option value="dismissed">Dismissed</option>
          <option value="resolved">Resolved upstream (delivered / no longer an issue)</option>
          <option value="stale">Stale data (shipment no longer tracked)</option>
          <option value="duplicate">Duplicate of another task</option>
          <option value="superseded">Superseded by a newer task</option>
          <option value="not_actionable">Not actionable</option>
        </select>
        <label className="block text-xs font-medium text-slate-600 mb-1">Note (optional)</label>
        <textarea value={reason} onChange={(e) => onChange({ reason: e.target.value })} rows={3} placeholder="e.g. Delivered 6/16 per carrier; confirmed with Victor" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none" />
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className="rounded-lg px-3 py-2 text-sm bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
