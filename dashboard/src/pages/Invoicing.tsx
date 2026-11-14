import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, ChevronRight, FileText, Loader2, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { api, type ScrapeRequest } from "../lib/api";
import { hostedBrowser } from "../lib/hostedBrowser";
import {
  APPROVAL_SCOPE, ERP_MONTH_CHOICES, ERP_TYPE_CHOICES, GET_INVOICE_MAX,
  approvalDate, approvalGroup, asApprovalResult, asPullResult, erpWorker, getInvoiceLabel, isErpRequest,
  requestApprovalCheck, requestErpPull, toApprovalState,
  type ApprovalGroup, type ErpMonths, type ErpShipmentType,
} from "../lib/erpPull";
import { fmtDateTime, fmtNum } from "../lib/format";
import type { ApprovalState, GetInvoiceState, InvoiceAudit, InvoiceAuditDetail, InvoiceAuditRow } from "../lib/types";
import { ErpPullMonitor, type ErpMonitorStatus } from "../components/ErpPullMonitor";
import { ErrorBlock } from "../components/ErrorBlock";
import { ApprovalPill, GetInvoiceModal, InvoicePill, type GetInvoiceItem } from "../components/GetInvoiceModal";
import { LoadingState } from "../components/LoadingState";

// Invoicing: one simple page for the person who sends invoices. It shows the
// latest list of shipments not yet exported to ERP in three plain groups:
// ready to invoice (approved in FreightPOP), waiting on approval, and invoice
// sent. One button refreshes both FreightPOP reads back to back in the hosted
// browser. The detailed table stays on Invoice Audits.

const PAGE_SIZE = 200;
const REFRESH_MS = 10_000;
const CHAIN_KEY = "fpx.invoicing.refresh";
const CHAIN_MAX_AGE_MS = 3 * 60 * 60 * 1000;

type TabKey = "ready" | "waiting" | "sent";
const TAB_KEYS: readonly TabKey[] = ["ready", "waiting", "sent"];
type ReadyFilter = "all" | "edi" | "shaun" | "others";
type SentFilter = "done" | "requested" | "failed";

// ── Rows ──

interface Row {
  id: string;
  shipment: string;
  customer: string;
  carrier: string;
  shippedTs: number | null;
  shippedText: string;
  charge: number | null;
  invoice: number | null;
  status: string;
  flags: string[];
  ap: ApprovalState | null;
  apGroup: ApprovalGroup | null;
  gi: GetInvoiceState | null;
  search: string;
}

// FreightPOP's report values can be numbers or text ("$1,234.50", "(12.00)").
function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const text = String(v).trim();
  const negative = /^\(.*\)$/.test(text);
  const n = Number(text.replace(/[$,\s()]/g, ""));
  if (text === "" || !Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// A date-only string is UTC midnight, which shows as the day before in US time zones.
function toDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return isNaN(d.getTime()) ? null : d;
}

function dayLabel(s: string | null | undefined, withYear = false): string {
  const d = toDate(s);
  if (!d) return s ? String(s) : "";
  return d.toLocaleDateString(undefined, withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
}

function toInvoiceState(v: unknown): GetInvoiceState | null {
  if (!v || typeof v !== "object") return null;
  const state = v as GetInvoiceState;
  return typeof state.status === "string" && getInvoiceLabel(state.status) ? state : null;
}

function toRow(row: InvoiceAuditRow): Row {
  const raw = row.raw ?? {};
  const shipment = row.shipment_id ?? "";
  const customer = row.customer_name ?? "";
  const carrier = row.carrier ?? "";
  const shipped = raw.shipped_date ? String(raw.shipped_date) : null;
  const ap = toApprovalState(raw.approval);
  return {
    id: row.id,
    shipment, customer, carrier,
    shippedTs: toDate(shipped)?.getTime() ?? null,
    shippedText: shipped ? dayLabel(shipped, true) : "",
    charge: toNum(raw.charge),
    invoice: toNum(row.bill_amount),
    status: row.status ?? "",
    flags: Array.isArray(raw.flags) ? raw.flags.map(String) : [],
    ap,
    apGroup: approvalGroup(ap),
    gi: toInvoiceState(raw.get_invoice),
    search: `${shipment} ${customer} ${carrier}`.toLowerCase(),
  };
}

// The three lists. A shipment is in at most one of ready / waiting / sent.
const isApproved = (r: Row) => r.ap?.status === "approved";
const isReady = (r: Row) => isApproved(r) && r.gi?.status !== "done" && r.gi?.status !== "requested";
const isWaiting = (r: Row) => !isApproved(r) && r.gi?.status !== "done" && r.gi?.status !== "requested";
const isSent = (r: Row) => r.gi?.status === "done";
const isRequested = (r: Row) => r.gi?.status === "requested";
const isFailed = (r: Row) => r.gi?.status === "failed";

const byCharge = (a: Row, b: Row) => (b.charge ?? -Infinity) - (a.charge ?? -Infinity) || a.shipment.localeCompare(b.shipment);
const sumCharge = (rows: Row[]) => rows.reduce((t, r) => t + (r.charge ?? 0), 0);

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function ago(s: string | null | undefined, now: number): string {
  const t = s ? Date.parse(s) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} ${day === 1 ? "day" : "days"} ago`;
}

// The audit result of each shipment, in the words the review step uses.
const AUDIT_STATUS: Record<string, { label: string; cls: string }> = {
  match: { label: "Match", cls: "bg-emerald-100 text-emerald-700" },
  discrepancy: { label: "Discrepancy", cls: "bg-rose-100 text-rose-700" },
  no_invoice: { label: "No invoice yet", cls: "bg-slate-100 text-slate-700" },
  error: { label: "Error", cls: "bg-amber-100 text-amber-800" },
};

// ── The two-step refresh ──

// What this page started in the hosted browser: step 1 is the list of
// shipments not exported to ERP, step 2 the Recently Approved check.
interface Chain {
  step: 1 | 2;
  state: "running" | "done" | "failed" | "stopped";
  /** Started with "Refresh from FreightPOP" (both steps) rather than "Check approvals only". */
  full: boolean;
  requestId: string | null;
  auditId: string | null;
  startedAt: number;
  message?: string;
}

function readChain(): Chain | null {
  try {
    const c = JSON.parse(sessionStorage.getItem(CHAIN_KEY) || "null") as Chain | null;
    return c && c.state === "running" && c.requestId && Date.now() - c.startedAt < CHAIN_MAX_AGE_MS ? c : null;
  } catch { return null; }
}

interface Outcome { ok: boolean; stopped: boolean; note: string; auditId: string | null }

/** How an invoicing-session job ended, or null while it is still queued or running. Reads the invoicing session only. */
async function jobOutcome(requestId: string): Promise<Outcome | null> {
  const stats = hostedBrowser.enabled ? await hostedBrowser.stats(1).catch(() => null) : null;
  const worker = erpWorker(stats);
  if (worker?.current?.requestId === requestId) return null;
  const last = worker?.lastResult;
  if (last && last.requestId === requestId) {
    const result = last.result ?? null;
    const note = String(last.note ?? "");
    return {
      ok: last.ok === true,
      // A job stopped part-way still reports "ok"; its note says it was stopped.
      stopped: /^stopped/i.test(note),
      note,
      auditId: asPullResult(result)?.audit_id || asApprovalResult(result)?.audit_id || null,
    };
  }
  // The invoicing session has moved on (or can't be reached): go by the queue.
  const { requests } = await api.ops.rescrapeRecent();
  const r = requests.find((x: ScrapeRequest) => x.id === requestId);
  if (!r) return { ok: false, stopped: false, note: "FPX lost track of this job.", auditId: null };
  if (r.status === "pending" || r.status === "claimed") return null;
  const note = String(r.note ?? "");
  return { ok: r.status === "done", stopped: /^stopped/i.test(note), note, auditId: null };
}

type StepState = "idle" | "queued" | "running" | "done" | "failed" | "stopped" | "skipped";

function Step({ n, title, state, detail }: { n: number; title: string; state: StepState; detail: string }) {
  const live = state === "running" || state === "queued";
  const bubble = state === "done" ? "bg-emerald-600 text-white"
    : live ? "bg-violet-600 text-white"
    : state === "failed" ? "bg-rose-600 text-white"
    : state === "stopped" ? "bg-amber-500 text-white"
    : "bg-slate-100 text-slate-500";
  return (
    <div className="flex items-start gap-3 min-w-0 flex-1" aria-current={live ? "step" : undefined}>
      <span className={"h-7 w-7 shrink-0 rounded-full inline-flex items-center justify-center text-sm font-semibold " + bubble}>
        {state === "done" ? <Check className="h-4 w-4" /> : live ? <Loader2 className="h-4 w-4 animate-spin" /> : state === "failed" ? <X className="h-4 w-4" /> : n}
      </span>
      <div className="min-w-0">
        <div className={"text-sm font-medium " + (state === "skipped" ? "text-slate-400" : "text-slate-900")}>{title}</div>
        <div className={"text-xs mt-0.5 break-words " + (state === "failed" ? "text-rose-700" : state === "stopped" ? "text-amber-800" : "text-slate-500")}>{detail}</div>
      </div>
    </div>
  );
}

function Segmented<T extends string | number>({ label, value, choices, onPick, disabled }: {
  label: string; value: T; choices: readonly (readonly [T, string])[]; onPick: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg ring-1 ring-slate-200 overflow-hidden" role="group" aria-label={label}>
      {choices.map(([id, text]) => (
        <button
          key={String(id)}
          onClick={() => onPick(id)}
          disabled={disabled}
          aria-pressed={value === id}
          className={"px-2.5 py-1.5 text-xs font-medium " + (value === id ? "bg-violet-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={"px-3 py-1 rounded-full text-xs font-medium ring-1 whitespace-nowrap " + (on ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")}
    >
      {children}
    </button>
  );
}

const MONTH_CHOICES = ERP_MONTH_CHOICES.map((m) => [m, `${m} ${m === 1 ? "month" : "months"}`] as const);

// ── Page ──

export function InvoicingPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabKey = TAB_KEYS.find((t) => t === tabParam) ?? "ready";
  const setTab = useCallback((t: TabKey) => {
    setParams((p) => { const n = new URLSearchParams(p); n.set("tab", t); return n; }, { replace: true });
  }, [setParams]);

  const [detail, setDetail] = useState<InvoiceAuditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [monitor, setMonitor] = useState<ErpMonitorStatus | null>(null);
  const [monitorKey, setMonitorKey] = useState(0);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [started, setStarted] = useState<{ requestId: string; auditId: string; kind: "get_invoice" | "approval_check" } | null>(null);
  const monitorWrap = useRef<HTMLDivElement>(null);

  const [months, setMonths] = useState<ErpMonths>(3);
  const [shipType, setShipType] = useState<ErpShipmentType>("non-parcel");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [starting, setStarting] = useState<"refresh" | "approvals" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [chain, setChainState] = useState<Chain | null>(readChain);
  const chainRef = useRef<Chain | null>(chain);
  const putChain = useCallback((c: Chain | null) => {
    chainRef.current = c;
    setChainState(c);
    try {
      if (c && c.state === "running") sessionStorage.setItem(CHAIN_KEY, JSON.stringify(c));
      else sessionStorage.removeItem(CHAIN_KEY);
    } catch { /* private mode: the refresh just doesn't survive a reload */ }
  }, []);

  const [query, setQuery] = useState("");
  const [readyFilter, setReadyFilter] = useState<ReadyFilter>("all");
  const [sentFilter, setSentFilter] = useState<SentFilter>("done");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [modalItems, setModalItems] = useState<GetInvoiceItem[] | null>(null);

  // While step 1 is under way the new list is still being filled in: keep
  // showing the list the person was looking at until it has finished.
  const shownId = useRef<string | null>(null);
  const hold = useRef(false);
  hold.current = monitor?.active === "erp_audit" || (chain?.step === 1 && chain.state === "running");
  const loadSeq = useRef(0);

  /** Loads the latest list from FreightPOP. Returns that list's run, or null. */
  const loadData = useCallback(async (force = false): Promise<InvoiceAudit | null> => {
    const seq = ++loadSeq.current;
    try {
      const list = await api.audits.invoice.list();
      const latest = list.data
        .filter((r) => r.shipment_type === "erp_pending")
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
      if (!latest) {
        if (seq === loadSeq.current) { shownId.current = null; setDetail(null); setLoadError(null); }
        return null;
      }
      const id = !force && hold.current && shownId.current ? shownId.current : latest.id;
      const d = await api.audits.invoice.get(id) as InvoiceAuditDetail;
      if (seq === loadSeq.current) { shownId.current = d.run.id; setDetail(d); setLoadError(null); }
      return latest;
    } catch (e) {
      if (seq === loadSeq.current) setLoadError((e as Error).message || "Could not load the list.");
      return null;
    } finally {
      if (seq === loadSeq.current) { setLoading(false); setNow(Date.now()); }
    }
  }, []);
  useEffect(() => { void loadData(); }, [loadData]);

  const auditId = detail?.run.id ?? null;

  /** Step 2: queue the Recently Approved check for one list. */
  const startApprovals = useCallback(async (forAudit: string, full: boolean) => {
    try {
      const res = await requestApprovalCheck(forAudit);
      if ((res.request?.scope as string) !== APPROVAL_SCOPE) {
        // A server that doesn't know this job yet answers with a regular scrape request.
        throw new Error("The server queued a regular scrape instead of the approval check. It needs the next server update.");
      }
      setStarted({ requestId: res.request.id, auditId: forAudit, kind: "approval_check" });
      setMonitorOpen(true);
      putChain({ step: 2, state: "running", full, requestId: res.request.id, auditId: forAudit, startedAt: Date.now() });
    } catch (e) {
      const message = (e as Error).message || "Could not start the approval check.";
      if (full) putChain({ step: 2, state: "failed", full, requestId: null, auditId: forAudit, startedAt: Date.now(), message: `The list was pulled, but the approval check could not start. ${message}` });
      else setActionError(message);
    }
  }, [putChain]);

  // Look at how the job this page is waiting on ended, and move on: after a
  // good pull start the approval check; never after a failed or stopped one.
  const resolving = useRef(false);
  const resolveJob = useCallback(async () => {
    const c = chainRef.current;
    if (!c || c.state !== "running" || !c.requestId || resolving.current) return;
    resolving.current = true;
    try {
      const out = await jobOutcome(c.requestId);
      if (!out || chainRef.current !== c) return;
      if (c.step === 2) {
        putChain({
          ...c,
          state: out.stopped ? "stopped" : out.ok ? "done" : "failed",
          message: out.stopped ? "The approval check was stopped. The list keeps what the last check found."
            : out.ok ? undefined : `The approval check did not finish. ${out.note}`.trim(),
        });
        void loadData(true);
        return;
      }
      if (!out.ok || out.stopped) {
        putChain({
          ...c,
          state: out.stopped ? "stopped" : "failed",
          message: out.stopped ? "The pull was stopped, so approvals were not checked."
            : `The pull did not finish, so approvals were not checked. ${out.note}`.trim(),
        });
        void loadData(true);
        return;
      }
      const latest = await loadData(true);
      if (chainRef.current !== c) return;
      const pulled = out.auditId || (latest && Date.parse(latest.created_at) >= c.startedAt - 60_000 ? latest.id : null);
      if (!pulled) {
        putChain({ ...c, state: "failed", message: "The pull finished, but no new list came back, so approvals were not checked." });
        return;
      }
      await startApprovals(pulled, true);
    } catch {
      /* could not tell yet; the next check tries again */
    } finally {
      resolving.current = false;
    }
  }, [loadData, putChain, startApprovals]);

  const onSettled = useCallback(() => { void loadData(true); void resolveJob(); }, [loadData, resolveJob]);
  const onOpenAudit = useCallback((id: string) => navigate(`/audits/invoice?run=${encodeURIComponent(id)}`), [navigate]);

  // While a job is under way the lists change underneath: re-read them.
  const activeKind = monitor?.active ?? null;
  useEffect(() => {
    if (!activeKind) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") void loadData(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [activeKind, loadData]);
  // The card below normally says when a job ends. This covers the cases where
  // it never saw the job (it ended at once, or the page was reloaded).
  const chainRunning = chain?.state === "running";
  useEffect(() => {
    if (!chainRunning || activeKind) return;
    const id = setInterval(() => { void resolveJob(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [chainRunning, activeKind, resolveJob]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { if (activeKind) setMonitorOpen(true); }, [activeKind]);
  useEffect(() => {
    if (monitorKey > 0) monitorWrap.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [monitorKey]);

  const busy = !!activeKind || chainRunning || !!starting;
  const blocked = busy ? "A FreightPOP job is already queued or running. Wait for it to finish."
    : !monitor ? "Loading…"
    : monitor.blocked;

  async function refreshAll() {
    if (blocked) return;
    setStarting("refresh"); setActionError(null);
    try {
      const res = await requestErpPull(months, shipType);
      if (!isErpRequest(res.request)) {
        setActionError("The server queued a regular scrape instead of the pull from FreightPOP. It needs the next server update.");
        return;
      }
      const requestedAt = Date.parse(res.request.requested_at);
      putChain({ step: 1, state: "running", full: true, requestId: res.request.id, auditId: null, startedAt: Number.isFinite(requestedAt) ? requestedAt : Date.now() });
      setStarted(null);
      setMonitorOpen(true);
      // A fresh card finds the job in the queue and starts following it.
      setMonitorKey((k) => k + 1);
    } catch (e) {
      setActionError((e as Error).message || "Could not start the refresh.");
    } finally {
      setStarting(null);
    }
  }

  async function approvalsOnly() {
    if (blocked || !auditId) return;
    setStarting("approvals"); setActionError(null);
    await startApprovals(auditId, false);
    setStarting(null);
  }

  // ── Lists ──

  const rows = useMemo(() => (detail?.rows ?? []).map(toRow), [detail]);
  const anyChecked = useMemo(() => rows.some((r) => !!r.ap), [rows]);
  const lists = useMemo(() => ({
    ready: rows.filter(isReady).sort(byCharge),
    waiting: rows.filter(isWaiting).sort(byCharge),
    sent: rows.filter(isSent).sort(byCharge),
    requested: rows.filter(isRequested).sort(byCharge),
    failed: rows.filter(isFailed).sort(byCharge),
  }), [rows]);
  const readyCounts = useMemo(() => ({
    edi: lists.ready.filter((r) => r.apGroup === "edi").length,
    shaun: lists.ready.filter((r) => r.apGroup === "shaun").length,
    others: lists.ready.filter((r) => r.apGroup === "person" || r.apGroup === "unknown").length,
  }), [lists.ready]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const base = tab === "ready"
      ? lists.ready.filter((r) => readyFilter === "all" || (readyFilter === "others" ? r.apGroup === "person" || r.apGroup === "unknown" : r.apGroup === readyFilter))
      : tab === "waiting" ? lists.waiting
      : sentFilter === "failed" ? lists.failed : sentFilter === "requested" ? lists.requested : lists.sent;
    return q ? base.filter((r) => r.search.includes(q)) : base;
  }, [tab, lists, readyFilter, sentFilter, q]);
  useEffect(() => { setLimit(PAGE_SIZE); }, [tab, readyFilter, sentFilter, q, auditId]);
  useEffect(() => { setSelected(new Set()); }, [auditId]);
  // The group a filter points at can empty out (a failed one is retried).
  useEffect(() => {
    if (sentFilter === "failed" && !lists.failed.length) setSentFilter("done");
    else if (sentFilter === "requested" && !lists.requested.length) setSentFilter("done");
  }, [sentFilter, lists.failed.length, lists.requested.length]);

  // Only shipments still ready count as picked (one just sent drops out by itself).
  const picked = useMemo(() => lists.ready.filter((r) => selected.has(r.id)), [lists.ready, selected]);
  const batch = useMemo(() => visible.slice(0, GET_INVOICE_MAX), [visible]);
  const batchPicked = tab === "ready" && batch.length > 0 && batch.every((r) => selected.has(r.id));
  const atCap = picked.length >= GET_INVOICE_MAX;
  const moreAfterBatch = atCap && lists.ready.length > picked.length;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(picked.map((r) => r.id));
      if (prev.has(id) && next.has(id)) next.delete(id);
      else if (next.size < GET_INVOICE_MAX) next.add(id);
      return next;
    });
  }
  // Highest charges first, up to one run's worth.
  function toggleAll() {
    setSelected(batchPicked ? new Set() : new Set(batch.map((r) => r.id)));
  }
  function retryFailed(r: Row) {
    setSelected(() => {
      const next = new Set(picked.map((x) => x.id));
      if (next.size < GET_INVOICE_MAX) next.add(r.id);
      return next;
    });
    setReadyFilter("all");
    setQuery("");
    setTab("ready");
  }

  function openModal() {
    if (!picked.length) return;
    setModalItems(picked.map((r) => ({
      id: r.id, shipment: r.shipment, customer: r.customer, carrier: r.carrier, charge: r.charge, invoice: r.invoice,
      status: r.status,
      statusLabel: AUDIT_STATUS[r.status]?.label ?? (r.status || "—"),
      statusCls: AUDIT_STATUS[r.status]?.cls ?? "bg-slate-100 text-slate-700",
      flags: r.flags, invoiceState: r.gi, approval: r.ap,
    })));
  }
  function onInvoicesStarted(request: ScrapeRequest) {
    if (auditId) setStarted({ requestId: request.id, auditId, kind: "get_invoice" });
    setModalItems(null);
    setSelected(new Set());
    setMonitorOpen(true);
    void loadData();
  }

  // ── Header and steps ──

  const run = detail?.run ?? null;
  const checkedAt = useMemo(() => {
    const summary = detail?.approval_summary ?? detail?.run.approval_summary ?? null;
    if (summary?.checked_at) return summary.checked_at;
    let latest: string | null = null;
    for (const r of rows) if (r.ap?.checked_at && (!latest || r.ap.checked_at > latest)) latest = r.ap.checked_at;
    return latest;
  }, [detail, rows]);
  const range = run && run.date_from && run.date_to ? `${dayLabel(run.date_from)} – ${dayLabel(run.date_to)}` : null;
  const approvalsLine = !anyChecked ? "approvals not checked yet" : checkedAt ? `approvals checked ${ago(checkedAt, now)}` : "approvals checked";

  const step1: StepState = chain
    ? (chain.step === 1 ? (chain.state === "running" ? (activeKind === "erp_audit" ? "running" : "queued") : chain.state) : chain.full ? "done" : "idle")
    : activeKind === "erp_audit" ? "running" : "idle";
  const step2: StepState = chain
    ? (chain.step === 2 ? (chain.state === "running" ? (activeKind === "approval_check" ? "running" : "queued") : chain.state)
      : chain.state === "running" ? "idle" : "skipped")
    : activeKind === "approval_check" ? "running" : "idle";
  const step1Detail = step1 === "running" ? "Reading FreightPOP's History Report in the invoicing session…"
    : step1 === "queued" ? "Waiting for the invoicing session…"
    : step1 === "failed" || step1 === "stopped" ? (chain?.message ?? "")
    : step1 === "done" ? "Done"
    : run ? `Last pulled ${ago(run.created_at, now)}` : "Not pulled yet";
  const step2Detail = step2 === "running" ? "Reading Recently Approved in the invoicing session…"
    : step2 === "queued" ? "Waiting for the invoicing session…"
    : step2 === "failed" || step2 === "stopped" ? (chain?.message ?? "")
    : step2 === "done" ? "Done. The lists below are up to date."
    : step2 === "skipped" ? "Not started"
    : chain?.step === 1 && chain.state === "running" ? "Starts by itself when step 1 finishes"
    : anyChecked && checkedAt ? `Last checked ${ago(checkedAt, now)}` : "Not checked yet";

  const tabs: { key: TabKey; label: string; hint: string; rows: Row[]; accent: string }[] = [
    { key: "ready", label: "Ready to invoice", hint: "Approved in FreightPOP, invoice not sent", rows: lists.ready, accent: "text-emerald-700" },
    { key: "waiting", label: "Waiting on approval", hint: anyChecked ? "Not approved in FreightPOP yet" : "Approvals not checked yet", rows: lists.waiting, accent: "text-amber-700" },
    { key: "sent", label: "Invoice sent", hint: lists.failed.length ? `${fmtNum(lists.failed.length)} failed, see inside` : "Get Invoice was pressed", rows: lists.sent, accent: "text-slate-900" },
  ];
  const shown = visible.slice(0, limit);
  const showApproval = tab !== "waiting";
  const showResult = tab === "sent";
  const colCount = 5 + (tab === "ready" ? 1 : 0) + (showApproval ? 2 : 0) + (showResult ? 1 : 0);
  const getInvoiceBlocked = activeKind || chainRunning ? "A FreightPOP job is queued or running. Wait for it to finish." : monitor?.blocked ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-900">Invoicing</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            {run ? (
              <>From FreightPOP{range ? ` · ${range}` : ""} · pulled {ago(run.created_at, now)} · {approvalsLine}</>
            ) : loading ? "Loading the latest list from FreightPOP…" : "Shipments that are approved and ready for their invoice."}
          </p>
        </div>
        {run ? (
          <Link to={`/audits/invoice?run=${encodeURIComponent(run.id)}`} className="text-sm text-sky-700 hover:text-sky-900 underline whitespace-nowrap">
            Open the full audit
          </Link>
        ) : null}
      </div>

      {/* Refresh: both FreightPOP reads, one after the other. */}
      <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3 flex-1 min-w-[280px] flex-wrap sm:flex-nowrap">
            <Step n={1} title="Shipments not exported to ERP" state={step1} detail={step1Detail} />
            <ChevronRight className="h-4 w-4 text-slate-300 mt-1.5 shrink-0 hidden sm:block" />
            <Step n={2} title="Recently approved" state={step2} detail={step2Detail} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {run ? (
              <button
                onClick={approvalsOnly}
                disabled={!!blocked}
                title={blocked || "Use this when the list was pulled recently"}
                className="px-3 py-2 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ShieldCheck className="h-4 w-4" /> {starting === "approvals" ? "Starting…" : "Check approvals only"}
              </button>
            ) : null}
            <button
              onClick={refreshAll}
              disabled={!!blocked}
              title={blocked || undefined}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw className={"h-4 w-4 " + (starting === "refresh" ? "animate-spin" : "")} /> {starting === "refresh" ? "Starting…" : "Refresh from FreightPOP"}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap text-xs text-slate-500">
          <button onClick={() => setOptionsOpen((v) => !v)} aria-expanded={optionsOpen} className="underline hover:text-slate-800">
            {optionsOpen ? "Hide options" : "Options"}
          </button>
          {optionsOpen ? (
            <>
              <span className="inline-flex items-center gap-2">Last <Segmented label="Months to pull" value={months} choices={MONTH_CHOICES} onPick={setMonths} disabled={busy} /></span>
              <Segmented label="Shipment type" value={shipType} choices={ERP_TYPE_CHOICES} onPick={setShipType} disabled={busy} />
            </>
          ) : (
            <span>Last {months} {months === 1 ? "month" : "months"} · {ERP_TYPE_CHOICES.find(([id]) => id === shipType)?.[1]}</span>
          )}
          <button onClick={() => setMonitorOpen((v) => !v)} className="underline hover:text-slate-800 ml-auto" disabled={!!activeKind}>
            {monitorOpen || activeKind ? (activeKind ? "The invoicing session is shown below" : "Hide the invoicing session") : "Show the invoicing session"}
          </button>
        </div>

        {actionError ? <ErrorBlock compact>{actionError}</ErrorBlock> : null}
        {!busy && monitor?.blocked && monitor.blocked !== "Loading…" ? (
          <ErrorBlock tone="warning" compact>
            {monitor.blocked}
            {/sign in/i.test(monitor.blocked) ? <> <Link to="/scraping" className="underline">Open Scraping</Link></> : null}
          </ErrorBlock>
        ) : null}
      </section>

      {/* Live view, log, Pause / Resume / Stop. Stays mounted: it is also what
          tells this page that a job is under way or has ended. */}
      <div ref={monitorWrap} className={"scroll-mt-4 " + (monitorOpen || activeKind ? "" : "hidden")}>
        <ErpPullMonitor key={monitorKey} onFinished={onOpenAudit} onSettled={onSettled} started={started} onStatus={setMonitor} />
      </div>

      {loadError ? <ErrorBlock>Could not load the list: {loadError} <button onClick={() => { setLoading(true); void loadData(); }} className="underline ml-1">Try again</button></ErrorBlock> : null}

      {loading && !detail ? (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm"><LoadingState label="Loading the latest list from FreightPOP…" /></div>
      ) : !detail ? (
        loadError ? null : (
          <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-10 text-center">
            <FileText className="h-8 w-8 text-slate-300 mx-auto" />
            <h2 className="mt-3 text-base font-semibold text-slate-900">Nothing pulled from FreightPOP yet</h2>
            <p className="mt-1 text-sm text-slate-600 max-w-xl mx-auto">
              This page shows which shipments are approved and ready for their invoice, which are still waiting on approval,
              and which already had their invoice sent. Press <span className="font-medium">Refresh from FreightPOP</span> above:
              FPX reads the shipments not exported to ERP and the Recently Approved list in its own invoicing session in the hosted browser, one after the other, separate from scraping.
            </p>
          </div>
        )
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3" role="tablist" aria-label="Shipments">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={"text-left rounded-2xl p-4 ring-1 shadow-sm transition-colors " + (tab === t.key ? "bg-white ring-2 ring-violet-500" : "bg-white ring-slate-200 hover:bg-slate-50")}
              >
                <div className="text-sm font-medium text-slate-700">{t.label}</div>
                <div className="mt-1 flex items-baseline gap-2 flex-wrap">
                  <span className={"text-3xl font-semibold tabular-nums " + t.accent}>{t.key === "waiting" && !anyChecked ? "—" : fmtNum(t.rows.length)}</span>
                  <span className="text-sm text-slate-600 tabular-nums">{t.key === "waiting" && !anyChecked ? "" : fmtMoney(sumCharge(t.rows))}</span>
                </div>
                <div className="text-xs text-slate-500 mt-1">{t.hint}</div>
              </button>
            ))}
          </div>

          <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm">
            <div className="p-4 flex items-center justify-between gap-3 flex-wrap border-b border-slate-100">
              <div className="flex items-center gap-2 flex-wrap">
                {tab === "ready" ? (
                  <>
                    <Chip on={readyFilter === "all"} onClick={() => setReadyFilter("all")}>All {fmtNum(lists.ready.length)}</Chip>
                    <Chip on={readyFilter === "edi"} onClick={() => setReadyFilter("edi")}>Approved by EDI {fmtNum(readyCounts.edi)}</Chip>
                    <Chip on={readyFilter === "shaun"} onClick={() => setReadyFilter("shaun")}>Approved by Shaun {fmtNum(readyCounts.shaun)}</Chip>
                    <Chip on={readyFilter === "others"} onClick={() => setReadyFilter("others")}>Approved by others {fmtNum(readyCounts.others)}</Chip>
                  </>
                ) : tab === "sent" ? (
                  <>
                    <Chip on={sentFilter === "done"} onClick={() => setSentFilter("done")}>Sent {fmtNum(lists.sent.length)}</Chip>
                    {lists.requested.length ? <Chip on={sentFilter === "requested"} onClick={() => setSentFilter("requested")}>In progress {fmtNum(lists.requested.length)}</Chip> : null}
                    {lists.failed.length ? <Chip on={sentFilter === "failed"} onClick={() => setSentFilter("failed")}>Failed {fmtNum(lists.failed.length)}</Chip> : null}
                  </>
                ) : (
                  <span className="text-sm text-slate-600">Shipments FreightPOP has not approved yet. Nothing to do here until they are.</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="relative">
                  <span className="sr-only">Search shipment, customer or carrier</span>
                  <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search shipment, customer or carrier"
                    className="pl-8 pr-3 py-1.5 w-72 max-w-full rounded-lg ring-1 ring-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                  />
                </label>
                {tab === "ready" ? (
                  <button
                    onClick={openModal}
                    disabled={!picked.length || !!getInvoiceBlocked}
                    title={getInvoiceBlocked || (!picked.length ? "Tick the shipments to invoice first" : undefined)}
                    className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <FileText className="h-4 w-4" /> Get invoices ({fmtNum(picked.length)})
                  </button>
                ) : null}
              </div>
            </div>

            {tab === "ready" && picked.length ? (
              <div className="px-4 py-2 text-sm bg-violet-50 text-violet-900 flex items-center justify-between gap-3 flex-wrap">
                <span>
                  {moreAfterBatch
                    ? `${fmtNum(GET_INVOICE_MAX)} selected — run the next batch after this one`
                    : `${fmtNum(picked.length)} selected`} · {fmtMoney(sumCharge(picked))} in charges
                </span>
                <button onClick={() => setSelected(new Set())} className="text-xs underline hover:text-violet-700">Clear</button>
              </div>
            ) : null}
            {tab === "sent" && sentFilter === "failed" ? (
              <div className="px-4 py-2 text-sm bg-rose-50 text-rose-900">
                Get Invoice did not go through on these. The reason is next to each one. Use Try again to put it back on the Ready list, ticked.
              </div>
            ) : null}

            {tab === "waiting" && !anyChecked ? (
              <div className="p-10 text-center">
                <AlertTriangle className="h-7 w-7 text-amber-500 mx-auto" />
                <h2 className="mt-3 text-base font-semibold text-slate-900">Approvals have not been checked yet</h2>
                <p className="mt-1 text-sm text-slate-600 max-w-xl mx-auto">
                  FPX has the {fmtNum(rows.length)} {rows.length === 1 ? "shipment" : "shipments"} not exported to ERP, but has not yet looked at FreightPOP's
                  Recently Approved list to see which of them are approved.
                </p>
                <button
                  onClick={approvalsOnly}
                  disabled={!!blocked}
                  title={blocked || undefined}
                  className="mt-4 px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ShieldCheck className="h-4 w-4" /> {starting === "approvals" ? "Starting…" : "Check approvals"}
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                      {tab === "ready" ? (
                        <th className="px-4 py-2.5 w-8">
                          <input
                            type="checkbox"
                            checked={batchPicked}
                            onChange={toggleAll}
                            disabled={!batch.length}
                            aria-label={visible.length > GET_INVOICE_MAX ? `Select the ${GET_INVOICE_MAX} highest charges` : "Select all"}
                            title={visible.length > GET_INVOICE_MAX ? `Selects the ${GET_INVOICE_MAX} highest charges: one run's worth` : "Select all"}
                            className="rounded border-slate-300 text-violet-600"
                          />
                        </th>
                      ) : null}
                      <th className="px-4 py-2.5 font-medium">Shipment</th>
                      <th className="px-4 py-2.5 font-medium">Customer</th>
                      <th className="px-4 py-2.5 font-medium">Carrier</th>
                      <th className="px-4 py-2.5 font-medium">Shipped</th>
                      <th className="px-4 py-2.5 font-medium text-right">Charge</th>
                      {showApproval ? <th className="px-4 py-2.5 font-medium whitespace-nowrap">Approved by</th> : null}
                      {showApproval ? <th className="px-4 py-2.5 font-medium whitespace-nowrap">Approved on</th> : null}
                      {showResult ? <th className="px-4 py-2.5 font-medium">Result</th> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.length === 0 ? (
                      <tr>
                        <td colSpan={colCount} className="p-8 text-center text-slate-500">
                          {q ? "Nothing matches that search."
                            : tab === "ready" ? (anyChecked ? "Nothing is ready to invoice right now." : "Approvals have not been checked yet, so nothing is marked ready. Press Check approvals only above.")
                            : tab === "waiting" ? "Nothing is waiting on approval."
                            : sentFilter === "done" ? "No invoices sent from this list yet." : "Nothing here."}
                        </td>
                      </tr>
                    ) : shown.map((r) => {
                      const on = tab === "ready" && selected.has(r.id);
                      const full = tab === "ready" && !on && atCap;
                      const when = r.gi?.at || r.gi?.requested_at;
                      return (
                        <tr
                          key={r.id}
                          onClick={tab === "ready" && !full ? () => toggleRow(r.id) : undefined}
                          className={(tab === "ready" ? "cursor-pointer " : "") + (on ? "bg-violet-50/60" : "hover:bg-slate-50")}
                        >
                          {tab === "ready" ? (
                            <td className="px-4 py-2">
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={full}
                                onChange={() => toggleRow(r.id)}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Select shipment ${r.shipment}`}
                                title={full ? `Up to ${GET_INVOICE_MAX} at a time` : undefined}
                                className="rounded border-slate-300 text-violet-600"
                              />
                            </td>
                          ) : null}
                          <td className="px-4 py-2 font-medium text-slate-900 whitespace-nowrap">
                            {r.shipment || "—"}
                            {tab === "ready" && isFailed(r) ? <span className="ml-2"><InvoicePill state={r.gi} /></span> : null}
                          </td>
                          <td className="px-4 py-2">{r.customer || "—"}</td>
                          <td className="px-4 py-2">{r.carrier || "—"}</td>
                          <td className="px-4 py-2 whitespace-nowrap text-slate-600">{r.shippedText || "—"}</td>
                          <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{fmtMoney(r.charge)}</td>
                          {showApproval ? <td className="px-4 py-2">{r.ap ? <ApprovalPill state={r.ap} /> : <span className="text-slate-400 text-xs">Not checked</span>}</td> : null}
                          {showApproval ? <td className="px-4 py-2 whitespace-nowrap text-slate-600">{isApproved(r) ? approvalDate(r.ap) || "—" : "—"}</td> : null}
                          {showResult ? (
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <InvoicePill state={r.gi} />
                                {when ? <span className="text-xs text-slate-500 whitespace-nowrap">{fmtDateTime(when)}</span> : null}
                                {sentFilter === "failed" ? (
                                  isReady(r)
                                    ? <button onClick={() => retryFailed(r)} className="text-xs text-sky-700 hover:text-sky-900 underline whitespace-nowrap">Try again</button>
                                    : <span className="text-xs text-slate-500 whitespace-nowrap">Not approved yet</span>
                                ) : null}
                              </div>
                              {r.gi?.note ? <div className={"text-xs mt-0.5 break-words max-w-md " + (sentFilter === "failed" ? "text-rose-700" : "text-slate-500")}>{r.gi.note}</div> : null}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {visible.length > shown.length ? (
              <div className="p-3 text-center border-t border-slate-100">
                <button onClick={() => setLimit((n) => n + PAGE_SIZE)} className="text-sm text-sky-700 hover:text-sky-900 underline">
                  Show more ({fmtNum(shown.length)} of {fmtNum(visible.length)} shown)
                </button>
              </div>
            ) : null}
          </section>
        </>
      )}

      {modalItems && auditId ? (
        <GetInvoiceModal auditId={auditId} items={modalItems} onClose={() => setModalItems(null)} onStarted={onInvoicesStarted} />
      ) : null}
    </div>
  );
}
