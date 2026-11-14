import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { RefreshCw, Search } from "lucide-react";
import { api, type ScrapeRequest } from "../lib/api";
import { hostedBrowser } from "../lib/hostedBrowser";
import {
  APPROVAL_SCOPE, ERP_MONTH_CHOICES, ERP_TYPE_CHOICES, GET_INVOICE_MAX,
  asApprovalResult, asPullResult, downloadAuditExcel, erpWorker, isErpRequest,
  requestApprovalCheck, requestErpPull,
  type ErpMonths, type ErpShipmentType,
} from "../lib/erpPull";
import { fmtNum } from "../lib/format";
import type { InvoiceAudit, InvoiceAuditDetail } from "../lib/types";
import { ErpPullMonitor, type ErpMonitorStatus } from "../components/ErpPullMonitor";
import { ErrorBlock } from "../components/ErrorBlock";
import { GetInvoiceModal, type GetInvoiceItem } from "../components/GetInvoiceModal";
import { BucketCards, BucketCardsSkeleton, type BucketCard } from "../components/invoicing/BucketCards";
import { Counted, MenuAction, MoreMenu, ProgressStrip, Segmented, SelectionBar, type StepState } from "../components/invoicing/Controls";
import { ShipmentTable } from "../components/invoicing/ShipmentTable";
import { ago, byCharge, dayLabel, plural, sumCharge, toRow, type BucketKey, type Row } from "../components/invoicing/model";

// Invoicing: one simple page for the person who sends invoices. It shows the
// latest list of shipments not yet exported to ERP in three buckets: approved
// (ready to invoice), not approved, and invoice sent. The bucket rules are in
// components/invoicing/model.ts. One button refreshes both FreightPOP reads
// back to back in the hosted browser. The detailed table stays on Invoice Audits.

const PAGE_SIZE = 200;
const REFRESH_MS = 10_000;
const CHAIN_KEY = "fpx.invoicing.refresh";
const CHAIN_MAX_AGE_MS = 3 * 60 * 60 * 1000;

const BUCKETS: readonly BucketKey[] = ["approved", "not-approved", "sent"];
// Links made before the buckets were renamed still open the right one.
const OLD_TABS: Record<string, BucketKey> = { ready: "approved", waiting: "not-approved" };
type ApprovedFilter = "all" | "shaun" | "edi" | "person" | "none" | "failed";
type WaitingFilter = "received" | "none";
type SentFilter = "done" | "requested";

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

const MONTH_CHOICES = ERP_MONTH_CHOICES.map((m) => [m, `${m} ${m === 1 ? "month" : "months"}`] as const);

// ── Page ──

export function InvoicingPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: BucketKey = BUCKETS.find((t) => t === tabParam) ?? OLD_TABS[tabParam ?? ""] ?? "approved";
  const setTab = useCallback((t: BucketKey) => {
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

  const [months, setMonths] = useState<ErpMonths>(3);
  const [shipType, setShipType] = useState<ErpShipmentType>("non-parcel");
  const [excel, setExcel] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
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
  const [approvedFilter, setApprovedFilter] = useState<ApprovedFilter>("all");
  const [waitingPick, setWaitingPick] = useState<WaitingFilter | null>(null);
  const [sentPick, setSentPick] = useState<SentFilter>("done");
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
  // The session card normally says when a job ends. This covers the cases where
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
  // An invoice run pauses after its first shipment and waits for a person to
  // press Resume, so its live session opens by itself. A refresh needs nobody:
  // its session stays folded behind the strip.
  useEffect(() => { if (activeKind === "get_invoice") setMonitorOpen(true); }, [activeKind]);

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


  async function downloadExcel() {
    if (!auditId || excel.busy) return;
    setExcel({ busy: true, error: null });
    try {
      await downloadAuditExcel(auditId, "not-exported");
      setExcel({ busy: false, error: null });
    } catch (e) {
      setExcel({ busy: false, error: (e as Error).message || "Could not download the file." });
    }
  }

  // ── Buckets ──

  const rows = useMemo(() => (detail?.rows ?? []).map(toRow), [detail]);
  const lists = useMemo(() => {
    const inBucket = (b: BucketKey) => rows.filter((r) => r.bucket === b).sort(byCharge);
    const approved = inBucket("approved");
    const notApproved = inBucket("not-approved");
    const inSent = inBucket("sent");
    return {
      approved,
      notApproved,
      received: notApproved.filter((r) => r.waiting === "received"),
      noInvoice: notApproved.filter((r) => r.waiting === "none"),
      sent: inSent.filter((r) => r.gi?.status === "done"),
      requested: inSent.filter((r) => r.gi?.status === "requested"),
    };
  }, [rows]);
  const approvedBy = useMemo(() => {
    const n = { shaun: 0, edi: 0, person: 0, none: 0, failed: 0 };
    for (const r of lists.approved) {
      if (r.approver) n[r.approver] += 1;
      if (r.failed) n.failed += 1;
    }
    return n;
  }, [lists.approved]);

  const checkedAt = useMemo(() => {
    const summary = detail?.approval_summary ?? detail?.run.approval_summary ?? null;
    if (summary?.checked_at) return summary.checked_at;
    let latest: string | null = null;
    for (const r of rows) if (r.ap?.checked_at && (!latest || r.ap.checked_at > latest)) latest = r.ap.checked_at;
    return latest;
  }, [detail, rows]);
  const anyChecked = useMemo(() => !!checkedAt || rows.some((r) => !!r.ap), [checkedAt, rows]);

  // A filter whose group is hidden (nobody in it) falls back to the first one.
  const approvedView: ApprovedFilter = (approvedFilter === "person" || approvedFilter === "failed") && !approvedBy[approvedFilter] ? "all" : approvedFilter;
  const waitingView: WaitingFilter = waitingPick ?? (lists.received.length || !lists.noInvoice.length ? "received" : "none");
  const sentView: SentFilter = sentPick === "requested" && !lists.requested.length ? "done" : sentPick;

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const base = tab === "approved"
      ? (approvedView === "all" ? lists.approved
        : approvedView === "failed" ? lists.approved.filter((r) => r.failed)
        : lists.approved.filter((r) => r.approver === approvedView))
      : tab === "not-approved" ? (waitingView === "received" ? lists.received : lists.noInvoice)
      : sentView === "requested" ? lists.requested : lists.sent;
    return q ? base.filter((r) => r.search.includes(q)) : base;
  }, [tab, lists, approvedView, waitingView, sentView, q]);
  useEffect(() => { setLimit(PAGE_SIZE); }, [tab, approvedView, waitingView, sentView, q, auditId]);
  useEffect(() => { setSelected(new Set()); }, [auditId]);

  // Only shipments still approved and unsent count as picked (one just sent drops out by itself).
  const picked = useMemo(() => lists.approved.filter((r) => selected.has(r.id)), [lists.approved, selected]);
  const batch = useMemo(() => (tab === "approved" ? visible.slice(0, GET_INVOICE_MAX) : []), [tab, visible]);
  const batchPicked = batch.length > 0 && batch.every((r) => selected.has(r.id));
  const atCap = picked.length >= GET_INVOICE_MAX;
  const moreAfterBatch = atCap && lists.approved.length > picked.length;

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

  function openModal() {
    if (!picked.length) return;
    setModalItems(picked.map((r: Row) => ({
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
    // The strip now belongs to the invoice run, not to a refresh that already ended.
    if (chainRef.current && chainRef.current.state !== "running") putChain(null);
    setMonitorOpen(true);
    void loadData();
  }

  // ── Header and progress ──

  const run = detail?.run ?? null;
  const files = detail?.files ?? run?.files ?? null;
  const range = run && run.date_from && run.date_to ? `${dayLabel(run.date_from)} – ${dayLabel(run.date_to)}` : null;
  const firstRun = !loading && !detail && !loadError;

  const step1: StepState = chain
    ? (chain.step === 1 ? (chain.state === "running" ? (activeKind === "erp_audit" ? "running" : "queued") : chain.state) : chain.full ? "done" : "idle")
    : activeKind === "erp_audit" ? "running" : "idle";
  const step2: StepState = chain
    ? (chain.step === 2 ? (chain.state === "running" ? (activeKind === "approval_check" ? "running" : "queued") : chain.state)
      : chain.state === "running" ? "idle" : "skipped")
    : activeKind === "approval_check" ? "running" : "idle";
  const invoiceRun = activeKind === "get_invoice" && !chainRunning;
  const stripShown = !!activeKind || !!chain || !!starting;
  const stripTone = activeKind || chainRunning || starting ? "working" as const
    : chain?.state === "failed" ? "failed" as const
    : chain?.state === "stopped" ? "stopped" as const
    : "done" as const;
  const stripText = stripTone === "done" ? "Done. The lists below are up to date."
    : stripTone !== "working" ? (chain?.message ?? "")
    : invoiceRun ? "Pressing Get Invoice in FreightPOP on the shipments you picked, one at a time. It pauses after the first one for you to check."
    : step1 === "running" ? "Reading FreightPOP's History Report in the invoicing session…"
    : step2 === "running" ? "Reading Recently Approved in the invoicing session…"
    : step1 === "queued" || step2 === "queued" ? "Waiting for the invoicing session…"
    : "Starting…";

  const getInvoiceBlocked = activeKind || chainRunning ? "A FreightPOP job is queued or running. Wait for it to finish." : monitor?.blocked ?? null;

  // ── Cards and the selected bucket's panel ──

  const n = fmtNum;
  const approvedParts = [
    approvedBy.shaun ? `${n(approvedBy.shaun)} by Shaun` : "",
    approvedBy.edi ? `${n(approvedBy.edi)} by EDI` : "",
    approvedBy.person ? `${n(approvedBy.person)} by others` : "",
    approvedBy.none ? `${n(approvedBy.none)} approver not listed` : "",
  ].filter(Boolean);
  const cards: BucketCard[] = [
    {
      key: "approved", label: "Approved · ready to invoice", count: lists.approved.length, total: sumCharge(lists.approved),
      breakdown: !lists.approved.length ? "Nothing waiting for its invoice"
        : !anyChecked ? "Approver names appear after a refresh"
        : approvedParts.join(" · "),
    },
    {
      key: "not-approved", label: "Not approved", count: lists.notApproved.length, total: sumCharge(lists.notApproved),
      breakdown: lists.notApproved.length
        ? `${n(lists.received.length)} invoice not approved · ${n(lists.noInvoice.length)} no invoice yet`
        : "Nothing waiting on approval",
    },
    {
      key: "sent", label: "Invoice sent", count: lists.sent.length, total: sumCharge(lists.sent),
      breakdown: lists.requested.length ? `${n(lists.requested.length)} more in progress`
        : lists.sent.length ? "Get Invoice was pressed in FreightPOP"
        : "None sent from this list yet",
    },
  ];

  const count = tab === "approved" ? lists.approved.length : tab === "not-approved" ? lists.notApproved.length : lists.sent.length;
  const heading = tab === "approved"
    ? (count ? `${n(count)} ${plural(count, "shipment is", "shipments are")} approved and ready. Select the ones to invoice.` : "Nothing is approved and ready right now.")
    : tab === "not-approved"
      ? (count ? `${n(count)} ${plural(count, "shipment is", "shipments are")} not approved yet.` : "Nothing is waiting on approval.")
      : (count ? `${n(count)} ${plural(count, "invoice was", "invoices were")} sent from this list.` : "No invoices have been sent from this list yet.");
  const subheading = tab === "approved"
    ? (!count ? "Shipments appear here once their carrier invoice is approved in FreightPOP."
      : !anyChecked ? "FreightPOP's report shows an approved carrier invoice for each. Approver names appear after the next refresh."
      : "FreightPOP shows an approved carrier invoice for each. Nothing is sent until you review the list.")
    : tab === "not-approved"
      ? (!count ? "Every shipment on this list is approved or already invoiced."
        : waitingView === "received" ? "A carrier invoice arrived for these, but nobody has approved it in FreightPOP. Once approved, they move to Approved on the next refresh."
        : "No carrier invoice has arrived for these yet. Nothing to do until one does.")
      : lists.requested.length ? `${n(lists.requested.length)} more ${plural(lists.requested.length, "is", "are")} being sent now.`
      : "Get Invoice was pressed in FreightPOP for these shipments.";

  const shown = visible.slice(0, limit);
  const empty = q ? "Nothing matches that search."
    : tab === "approved" ? (
      approvedView === "all" ? "Nothing is approved and ready right now."
      : approvedView === "shaun" ? "None of the approved shipments were approved by Shaun."
      : approvedView === "edi" ? "None of the approved shipments were approved by EDI."
      : "Nothing here."
    )
    : tab === "not-approved" ? (waitingView === "received" ? "No carrier invoices are waiting on approval." : "Every shipment here has a carrier invoice.")
    : sentView === "done" ? "No invoices have been sent from this list yet." : "Nothing in progress.";

  const refreshButton = (
    <button
      type="button"
      onClick={refreshAll}
      disabled={!!blocked}
      title={blocked || undefined}
      className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
    >
      <RefreshCw className={"h-4 w-4 " + (starting === "refresh" || chainRunning ? "animate-spin" : "")} aria-hidden="true" />
      {starting === "refresh" ? "Starting…" : chainRunning ? "Refreshing…" : "Refresh from FreightPOP"}
    </button>
  );
  const quietLink = "text-sm text-slate-500 hover:text-slate-900 underline underline-offset-2 decoration-slate-300 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50";

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Invoicing</h1>
          <p className="text-sm text-slate-600 mt-1">
            {run
              ? <>Shipments not yet exported to ERP{range ? ` · ${range}` : ""} · updated {ago(run.created_at, now)}</>
              : loading ? "Loading the latest list from FreightPOP…"
              : "See which shipments are approved, and send their invoices in bulk."}
          </p>
          {run ? (
            <div className="mt-2 flex items-center gap-x-4 gap-y-1 flex-wrap">
              {files?.not_exported === true ? (
                <button type="button" onClick={downloadExcel} disabled={excel.busy} className={quietLink}>
                  {excel.busy ? "Downloading…" : "Download Excel (FreightPOP format)"}
                </button>
              ) : null}
              <Link to={`/audits/invoice?run=${encodeURIComponent(run.id)}`} className={quietLink}>Open the full audit</Link>
              {excel.error ? <span className="text-sm text-rose-700">{excel.error}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <MoreMenu>
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-500">What a refresh reads</div>
              <Segmented label="Months to read" value={months} choices={MONTH_CHOICES} onPick={setMonths} disabled={busy} />
              <Segmented label="Shipment type" value={shipType} choices={ERP_TYPE_CHOICES} onPick={setShipType} disabled={busy} />
            </div>
            <div className="border-t border-slate-100 pt-3 space-y-1">
              {run ? (
                <MenuAction
                  title={starting === "approvals" ? "Starting…" : "Check approvals only"}
                  hint={`Quicker: keeps this list and only re-reads who approved what. ${anyChecked && checkedAt ? `Last checked ${ago(checkedAt, now)}.` : "Not checked yet."}`}
                  onClick={approvalsOnly}
                  disabled={!!blocked}
                  disabledReason={blocked || undefined}
                />
              ) : null}
              <MenuAction
                title={monitorOpen ? "Hide the invoicing session" : "Show the invoicing session"}
                hint="The live view of FPX working in FreightPOP, with its log, Pause and Stop."
                onClick={() => setMonitorOpen((v) => !v)}
              />
            </div>
          </MoreMenu>
          {firstRun ? null : refreshButton}
        </div>
      </header>

      {actionError ? <ErrorBlock compact>{actionError}</ErrorBlock> : null}
      {!busy && monitor?.blocked && monitor.blocked !== "Loading…" ? (
        <ErrorBlock tone="warning" compact>
          {monitor.blocked}
          {/sign in/i.test(monitor.blocked) ? <> <Link to="/scraping" className="underline">Open Scraping</Link></> : null}
        </ErrorBlock>
      ) : null}

      {stripShown ? (
        <ProgressStrip
          steps={invoiceRun ? null : [{ title: "Shipment list", state: step1 }, { title: "Approvals", state: step2 }]}
          text={stripText}
          tone={stripTone}
          expanded={monitorOpen}
          onToggle={() => setMonitorOpen((v) => !v)}
          onDismiss={stripTone === "working" ? undefined : () => putChain(null)}
        />
      ) : null}

      {/* Live view, log, Pause / Resume / Stop. Stays mounted even when folded
          away: it is also what tells this page that a job is under way or has ended. */}
      <div className={monitorOpen ? "" : "hidden"}>
        <ErpPullMonitor key={monitorKey} onFinished={onOpenAudit} onSettled={onSettled} started={started} onStatus={setMonitor} />
      </div>

      {loadError ? (
        <ErrorBlock>
          Could not load the list: {loadError}{" "}
          <button type="button" onClick={() => { setLoading(true); void loadData(); }} className="underline ml-1">Try again</button>
        </ErrorBlock>
      ) : null}

      {loading && !detail ? (
        <div role="status" aria-label="Loading the latest list from FreightPOP" className="space-y-6">
          <BucketCardsSkeleton />
          <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-6 space-y-4" aria-hidden="true">
            <div className="h-5 w-96 max-w-full rounded bg-slate-100 animate-pulse" />
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-10 rounded bg-slate-50 animate-pulse" />)}
          </div>
        </div>
      ) : !detail ? (
        firstRun ? (
          <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm px-6 py-20 text-center">
            <h2 className="text-lg font-semibold text-slate-900">Nothing read from FreightPOP yet</h2>
            <p className="mt-2 text-sm text-slate-600 max-w-lg mx-auto leading-relaxed">
              Press the button and FPX reads two things from FreightPOP, one after the other: the shipments not yet exported to ERP,
              and who approved their invoices. You then see which shipments are approved, which are not, and can send the approved ones their invoice in bulk.
            </p>
            <div className="mt-6 flex justify-center">{refreshButton}</div>
            <p className="mt-3 text-xs text-slate-500">It runs in its own invoicing session in the hosted browser, separate from scraping. Nothing is changed in FreightPOP.</p>
          </section>
        ) : null
      ) : (
        <>
          <BucketCards cards={cards} selected={tab} onSelect={setTab} />

          <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm overflow-hidden" aria-label={cards.find((c) => c.key === tab)?.label}>
            <div className="px-6 pt-6 pb-4 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">{heading}</h2>
                <p className="text-sm text-slate-500 mt-1 max-w-3xl">{subheading}</p>
              </div>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                {tab === "approved" ? (
                  <Segmented<ApprovedFilter>
                    label="Approved by"
                    value={approvedView}
                    onPick={setApprovedFilter}
                    choices={[
                      ["all", <Counted n={lists.approved.length}>All</Counted>],
                      ["shaun", <Counted n={approvedBy.shaun}>By Shaun</Counted>],
                      ["edi", <Counted n={approvedBy.edi}>By EDI</Counted>],
                      ...(approvedBy.person ? [["person", <Counted n={approvedBy.person}>By others</Counted>] as const] : []),
                      ["none", <Counted n={approvedBy.none}>Approver not listed</Counted>],
                      ...(approvedBy.failed ? [["failed", <Counted n={approvedBy.failed}>Failed last time</Counted>] as const] : []),
                    ]}
                  />
                ) : tab === "not-approved" ? (
                  <Segmented<WaitingFilter>
                    label="Why not approved"
                    value={waitingView}
                    onPick={setWaitingPick}
                    choices={[
                      ["received", <Counted n={lists.received.length}>Invoice not approved</Counted>],
                      ["none", <Counted n={lists.noInvoice.length}>No invoice yet</Counted>],
                    ]}
                  />
                ) : lists.requested.length ? (
                  <Segmented<SentFilter>
                    label="Invoice status"
                    value={sentView}
                    onPick={setSentPick}
                    choices={[
                      ["done", <Counted n={lists.sent.length}>Sent</Counted>],
                      ["requested", <Counted n={lists.requested.length}>In progress</Counted>],
                    ]}
                  />
                ) : <span />}
                <label className="relative">
                  <span className="sr-only">Search shipment, customer or carrier</span>
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search shipment, customer or carrier"
                    className="pl-9 pr-3 py-2 w-80 max-w-full rounded-lg ring-1 ring-slate-200 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </label>
              </div>
            </div>

            <div className="border-t border-slate-200">
              <ShipmentTable
                bucket={tab}
                rows={shown}
                empty={empty}
                selected={selected}
                atCap={atCap}
                allPicked={batchPicked}
                canPickAll={batch.length > 0}
                capped={visible.length > GET_INVOICE_MAX}
                onToggle={toggleRow}
                onToggleAll={toggleAll}
                footer={visible.length > shown.length ? (
                  <div className="p-4 text-center border-t border-slate-100">
                    <button type="button" onClick={() => setLimit((v) => v + PAGE_SIZE)} className={quietLink}>
                      Show more ({n(shown.length)} of {n(visible.length)} shown)
                    </button>
                  </div>
                ) : null}
              />
            </div>
          </section>

          {picked.length ? (
            <SelectionBar
              count={picked.length}
              total={sumCharge(picked)}
              moreAfterBatch={moreAfterBatch}
              blocked={getInvoiceBlocked}
              onGet={openModal}
              onClear={() => setSelected(new Set())}
            />
          ) : null}
        </>
      )}

      {modalItems && auditId ? (
        <GetInvoiceModal auditId={auditId} items={modalItems} onClose={() => setModalItems(null)} onStarted={onInvoicesStarted} />
      ) : null}
    </div>
  );
}
