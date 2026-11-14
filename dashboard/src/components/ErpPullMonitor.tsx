import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Pause, Play, RotateCcw, Square, XCircle } from "lucide-react";
import { api, type ScrapeRequest } from "../lib/api";
import { hostedBrowser, type HostedStats } from "../lib/hostedBrowser";
import {
  ERP_MONTH_CHOICES, EndpointMissingError, erpWorker, isErpRequest, pauseErpPull, requestErpPull, resumeErpPull,
  type ErpMonths,
  ERP_TYPE_CHOICES, type ErpShipmentType,
  asGetInvoiceResult, asPullResult, getInvoiceCounts, getInvoicePauseLine, isGetInvoiceRequest, type ErpJobKind,
} from "../lib/erpPull";
import { fmtNum, fmtRelative } from "../lib/format";
import { HostedFreightPop } from "./HostedFreightPop";
import { ScrapeLog } from "./ScrapeLog";

// ERP audit pull: start it, watch the hosted browser do it, pause, resume or
// stop it. The pull runs in the same hosted browser worker as Refresh All
// (one automation at a time), so this reads the same /stats and request queue
// as the Scraping page and reuses its live view and log.
//
// The same card also shows a "Get Invoice" run (started from an audit's
// shipment table, after a person reviewed the selection): same worker, same
// live view, log, pause and stop. Only one of the two can be under way.

const POLL_MS = 5000;         // queued — same cadence as the Scraping page
const POLL_RUNNING_MS = 2000; // running, for the live log

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** What the page needs to know to enable or disable its own start buttons. */
export interface ErpMonitorStatus {
  /** The job that is queued or running here, if any. */
  active: ErpJobKind | null;
  /** Why a hosted-browser job can't be started right now (not signed in, worker off…). */
  blocked: string | null;
}

interface ErpPullMonitorProps {
  /** "Open the audit" was pressed on a finished pull or invoice run. */
  onFinished?: (auditId: string) => void;
  /** A pull or invoice run that was under way has ended. */
  onSettled?: () => void;
  /** A Get Invoice run the page just queued: the card picks it up and scrolls into view. */
  started?: { requestId: string; auditId: string } | null;
  onStatus?: (status: ErpMonitorStatus) => void;
}

export function ErpPullMonitor({ onFinished, onSettled, started, onStatus }: ErpPullMonitorProps) {
  const [stats, setStats] = useState<HostedStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [requests, setRequests] = useState<ScrapeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState<ErpMonths>(3);
  const [shipType, setShipType] = useState<ErpShipmentType>("non-parcel");
  // The request this panel started (the hosted browser may not label jobs yet).
  const [reqId, setReqId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pauseNote, setPauseNote] = useState<string | null>(null);
  const [watch, setWatch] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [s, r] = await Promise.allSettled([
        hostedBrowser.enabled ? hostedBrowser.stats(30) : Promise.reject(new Error("not configured")),
        api.ops.rescrapeRecent(),
      ]);
      if (!alive.current) return;
      if (s.status === "fulfilled") { setStats(s.value); setStatsErr(null); }
      else if (hostedBrowser.enabled) setStatsErr((s.reason as Error).message);
      if (r.status === "fulfilled") setRequests(r.value.requests);
    } finally {
      inflight.current = false;
      if (alive.current) { setLoading(false); setNow(Date.now()); }
    }
  }, []);

  const worker = erpWorker(stats);
  const me = stats?.me;
  const loggedIn = me?.freightpop?.loggedIn === true;

  // Which of this card's two jobs is it? The hosted browser says so (`kind`);
  // when it doesn't, go by the request it came from.
  const kindOfId = (id: string): ErpJobKind | null => {
    if (id === reqId) return "erp_audit";
    if (id === started?.requestId) return "get_invoice";
    const r = requests.find((x) => x.id === id);
    return !r ? null : isGetInvoiceRequest(r) ? "get_invoice" : isErpRequest(r) ? "erp_audit" : null;
  };
  const kindOf = (j: { kind?: string; requestId: string }): ErpJobKind | null =>
    j.kind ? (j.kind === "erp_audit" || j.kind === "get_invoice" ? j.kind : null) : kindOfId(j.requestId);

  const current = worker?.current ?? null;
  const running = current && kindOf(current) ? current : null;
  const waiting = requests.find((r) => (r.status === "pending" || r.status === "claimed") && kindOfId(r.id)) || null;
  const queued = !running && !!waiting;
  const last = !running && !queued && worker?.lastResult && kindOf(worker.lastResult) ? worker.lastResult : null;
  const jobKind: ErpJobKind | null = running ? kindOf(running) : waiting ? kindOfId(waiting.id) : last ? kindOf(last) : null;
  const gi = jobKind === "get_invoice";
  const lastResult = last?.ok ? (last.result ?? worker?.result ?? null) : null;
  const result = gi ? null : asPullResult(lastResult);
  const giResult = gi ? asGetInvoiceResult(lastResult) : null;
  const giCounts = gi ? getInvoiceCounts(running ?? last) : null;
  const paused = !!(running?.paused ?? (running ? worker?.paused : false));
  // Set when the invoice run paused itself and is waiting for a person.
  const pauseLine = gi && paused ? getInvoicePauseLine(running?.log) : null;
  const labelled = !!current?.kind; // hosted browser knows about these jobs
  const mine = !!running && running.user === me?.user;
  // The audit a Get Invoice run belongs to, for the "Open the audit" button.
  const giJobId = running?.requestId ?? waiting?.id ?? last?.requestId ?? null;
  const giAuditId = !gi ? null
    : giResult?.audit_id
      || (giJobId && giJobId === started?.requestId ? started.auditId : null)
      // The API keeps the audit in the request's note: "audit=<uuid>;from=…".
      || /(?:^|;)audit=([0-9a-f-]{36})/i.exec(String((requests.find((r) => r.id === giJobId) as { note?: string | null } | undefined)?.note ?? ""))?.[1]
      || null;
  const noun = gi ? "invoice run" : "pull";

  // Poll only while something is queued or running; one load on mount finds a
  // pull that is already under way.
  const active = !!running || queued;
  const isRunning = !!running;
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, isRunning ? POLL_RUNNING_MS : POLL_MS);
    const tick = isRunning ? setInterval(() => setNow(Date.now()), 1000) : null;
    return () => { clearInterval(id); if (tick) clearInterval(tick); };
  }, [load, active, isRunning]);
  useEffect(() => {
    if (!isRunning) { setStopRequested(false); setConfirmStop(false); setPauseNote(null); }
  }, [isRunning]);
  // A job that was under way has ended (finished, failed or stopped): let the
  // page refresh its list and the open run.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) onSettled?.();
    wasActive.current = active;
  }, [active, onSettled]);
  // The page just queued a Get Invoice run: find it and come into view.
  const startedId = started?.requestId ?? null;
  useEffect(() => {
    if (!startedId) return;
    setError(null);
    void load();
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [startedId, load]);

  const startDisabledReason = !hostedBrowser.enabled ? "Hosted browser isn't configured for this dashboard"
    : !worker ? (statsErr ? "Can't reach the hosted browser" : "Loading…")
    : !worker.enabled ? `Hosted browser worker is off (${worker.reason})`
    : !loggedIn ? "Sign in to FreightPOP in your hosted browser first (Scraping page)"
    // A hosted browser that knows this job always reports `kind` (null when idle).
    : worker.kind === undefined ? "The hosted browser needs its next update before it can run this"
    : null;

  const activeKind = active ? jobKind : null;
  useEffect(() => { onStatus?.({ active: activeKind, blocked: startDisabledReason }); }, [onStatus, activeKind, startDisabledReason]);

  async function start() {
    setStarting(true); setError(null);
    try {
      const res = await requestErpPull(months, shipType);
      if (!isErpRequest(res.request)) {
        // An API that doesn't know this job yet answers with a regular scrape request.
        setError("The server queued a regular scrape instead of the ERP pull. The ERP pull needs the next server update.");
      } else {
        setReqId(res.request.id);
      }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { if (alive.current) setStarting(false); }
  }

  async function togglePause() {
    setToggling(true); setError(null); setPauseNote(null);
    try {
      await (paused ? resumeErpPull() : pauseErpPull());
      await load();
    } catch (e) {
      if (e instanceof EndpointMissingError) setPauseNote("Pause needs the next hosted browser update");
      else setError((e as Error).message);
    } finally { if (alive.current) setToggling(false); }
  }

  async function stop() {
    setStopping(true); setError(null); setConfirmStop(false);
    try { await hostedBrowser.stopScrape(); setStopRequested(true); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { if (alive.current) setStopping(false); }
  }

  const lastError = last && !last.ok
    ? ([...(last.log || [])].reverse().find((l) => l.level === "error")?.text || last.note || `The ${noun} failed.`)
    : null;

  const pauseButton = (
    <button
      onClick={togglePause}
      disabled={toggling || stopping || stopRequested}
      className={"px-3 py-1.5 rounded-lg ring-1 inline-flex items-center gap-1.5 text-sm font-medium disabled:opacity-50 shrink-0 "
        + (paused ? "bg-amber-500 text-white ring-amber-500 hover:bg-amber-600" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")}
    >
      {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
      {toggling ? (paused ? "Resuming…" : "Pausing…") : paused ? "Resume" : "Pause"}
    </button>
  );

  return (
    <section ref={sectionRef} className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-4 scroll-mt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">{active && gi ? "Getting invoices" : "Pull from FreightPOP"}</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {active && gi
              ? "Pressing Get Invoice in FreightPOP on the shipments you picked, one at a time."
              : "Runs FreightPOP's History Report for every customer and brings in the rows not exported to ERP."}
          </p>
        </div>
        {!active ? (
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase font-semibold text-slate-500">Last</span>
              <div className="inline-flex rounded-lg ring-1 ring-slate-200 overflow-hidden" role="group" aria-label="Months to pull">
                {ERP_MONTH_CHOICES.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMonths(m)}
                    disabled={starting}
                    aria-pressed={months === m}
                    className={"px-2.5 py-1.5 text-xs font-medium " + (months === m ? "bg-violet-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50")}
                  >
                    {m} {m === 1 ? "month" : "months"}
                  </button>
                ))}
              </div>
            </div>
            <div className="inline-flex rounded-lg ring-1 ring-slate-200 overflow-hidden" role="group" aria-label="Shipment type">
              {ERP_TYPE_CHOICES.map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setShipType(id)}
                  disabled={starting}
                  aria-pressed={shipType === id}
                  className={"px-2.5 py-1.5 text-xs font-medium " + (shipType === id ? "bg-violet-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50")}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={start}
              disabled={!!startDisabledReason || starting}
              title={startDisabledReason || undefined}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play className="h-4 w-4" /> {starting ? "Queuing…" : "Pull from FreightPOP"}
            </button>
          </div>
        ) : null}
      </div>

      {statsErr && hostedBrowser.enabled ? <Note tone="danger">Can't reach the hosted browser: {statsErr}</Note> : null}
      {error ? <Note tone="danger">{error}</Note> : null}

      {running ? (
        <div className={"rounded-xl p-4 space-y-3 ring-1 " + (paused ? "bg-amber-50 ring-amber-300" : "bg-violet-50 ring-violet-200")}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className={"text-sm font-medium inline-flex items-center gap-2 " + (paused ? "text-amber-900" : "text-violet-900")}>
              {paused ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ring-1 bg-amber-100 text-amber-900 ring-amber-300">
                  <Pause className="h-3 w-3" /> Paused
                </span>
              ) : (
                <><span className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" /> {stopRequested ? "Stopping…" : "Running"}</>
              )}
              {!mine && running.user ? <span className="font-normal opacity-80">for {running.user}</span> : null}
              <span className="font-normal tabular-nums opacity-80">· {fmtDuration(now - new Date(running.startedAt).getTime())}</span>
            </div>
            <div className="flex items-center gap-2">
              {gi && giAuditId && onFinished ? (
                <button onClick={() => onFinished(giAuditId)} className="text-xs text-violet-700 hover:text-violet-900 underline mr-1">
                  Open the audit
                </button>
              ) : null}
              {/* When the run is waiting on a person, Resume sits next to the reason below. */}
              {pauseLine ? null : pauseButton}
              <button
                onClick={() => setConfirmStop(true)}
                disabled={stopping || stopRequested || confirmStop}
                className="px-3 py-1.5 rounded-lg ring-1 ring-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 inline-flex items-center gap-1.5 text-sm font-medium disabled:opacity-50"
              >
                <Square className="h-4 w-4" /> {stopping ? "Stopping…" : "Stop"}
              </button>
            </div>
          </div>

          {confirmStop ? (
            <div className="rounded-lg bg-white ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-900 flex items-center justify-between gap-3 flex-wrap">
              <span>{gi ? "Stop the invoice run? Shipments already done stay done; the rest are left untouched." : "Stop the pull? Rows pulled so far may not be saved."}</span>
              <span className="flex items-center gap-2">
                <button onClick={stop} disabled={stopping} className="px-3 py-1 rounded-md bg-rose-600 text-white hover:bg-rose-700 text-xs font-medium disabled:opacity-50">Stop the {noun}</button>
                <button onClick={() => setConfirmStop(false)} className="px-3 py-1 rounded-md ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-medium">Keep going</button>
              </span>
            </div>
          ) : null}
          {pauseNote ? <div className="text-xs text-amber-800">{pauseNote}</div> : null}

          {giCounts ? (
            <div>
              <div className={"text-sm font-medium tabular-nums " + (paused ? "text-amber-900" : "text-violet-900")}>
                {fmtNum(giCounts.done)} of {fmtNum(giCounts.total)} · {fmtNum(giCounts.ok)} done · <span className={giCounts.failed ? "text-rose-700" : ""}>{fmtNum(giCounts.failed)} failed</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-white ring-1 ring-violet-200 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={giCounts.total} aria-valuenow={giCounts.done}>
                <div className={"h-full " + (paused ? "bg-amber-400" : "bg-violet-500")} style={{ width: `${giCounts.total ? Math.min(100, (giCounts.done / giCounts.total) * 100) : 0}%` }} />
              </div>
            </div>
          ) : null}

          {pauseLine ? (
            <div role="status" className="rounded-lg bg-amber-100 ring-1 ring-amber-400 px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-2 min-w-0 text-amber-950">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold break-words">{pauseLine}</div>
                  {/first invoice/i.test(pauseLine) ? (
                    <div className="text-xs mt-0.5">If nobody presses Resume within 30 minutes, the run stops and the rest are left untouched.</div>
                  ) : null}
                </div>
              </div>
              {pauseButton}
            </div>
          ) : (
            <div className={"text-sm break-words " + (paused ? "text-amber-900" : "text-violet-900")}>
              {paused ? "Paused. Press Resume to carry on from here. " : ""}{running.status}
            </div>
          )}

          {mine ? (
            <button onClick={() => setWatch((v) => !v)} className="text-xs text-violet-700 hover:text-violet-900 underline">
              {watch ? "Hide live view" : "Watch live"}
            </button>
          ) : null}
          <div className={"grid gap-3 " + (watch && mine ? "lg:grid-cols-[3fr_2fr]" : "")}>
            {watch && mine ? (
              <div className={"h-[420px] rounded-lg overflow-hidden ring-1 bg-slate-900 " + (paused ? "ring-amber-300" : "ring-violet-200")}>
                <HostedFreightPop key={running.requestId} target="scrape" />
              </div>
            ) : null}
            <ScrapeLog lines={running.log || []} total={running.logTotal} live />
          </div>
          {!labelled ? (
            <div className="text-[11px] text-slate-500">The hosted browser is on an older version, so pausing may not be available yet.</div>
          ) : null}
        </div>
      ) : queued ? (
        <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-4 text-sm text-amber-900 flex items-center gap-2">
          <Clock className="h-4 w-4 shrink-0" />
          {current || worker?.queued?.length
            ? `Waiting for the current scrape to finish. The ${noun} starts right after.`
            : `Starting within ${worker?.pollSeconds ?? 30}s…`}
        </div>
      ) : last?.ok && gi ? (
        <div className={"rounded-xl p-4 text-sm ring-1 " + (giResult?.failed ? "bg-amber-50 ring-amber-200 text-amber-900" : "bg-emerald-50 ring-emerald-200 text-emerald-900")}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="font-medium inline-flex items-center gap-2">
              {giResult?.failed ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
              {giResult
                ? `Pressed Get Invoice on ${fmtNum(giResult.ok)} ${giResult.ok === 1 ? "shipment" : "shipments"} (${fmtNum(giResult.failed)} failed)`
                : "Invoice run finished"}
            </div>
            {giAuditId && onFinished ? (
              <button
                onClick={() => onFinished(giAuditId)}
                className={"px-3 py-1.5 rounded-lg text-white text-sm font-medium " + (giResult?.failed ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-600 hover:bg-emerald-700")}
              >
                Open the audit
              </button>
            ) : null}
          </div>
          <div className="mt-1 text-xs opacity-80">
            {giResult && giResult.total !== giResult.ok + giResult.failed ? `${fmtNum(giResult.total)} picked · ` : ""}finished {fmtRelative(last.finishedAt)} · took {fmtDuration(last.durationMs)}
          </div>
          {giResult?.failed ? <div className="mt-1 text-xs">Open the audit and hover a Failed pill to see why.</div> : null}
          {!giResult && last.note ? <div className="mt-1 break-words">{last.note}</div> : null}
          <LastLog log={last.log} total={last.logTotal} open={logOpen} setOpen={setLogOpen} />
        </div>
      ) : last?.ok ? (
        <div className="rounded-xl p-4 text-sm ring-1 bg-emerald-50 ring-emerald-200 text-emerald-900">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="font-medium inline-flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {result
                ? `Pulled ${fmtNum(result.pending)} ${result.pending === 1 ? "row" : "rows"} not exported to ERP`
                : "Pull finished"}
            </div>
            {result?.audit_id && onFinished ? (
              <button
                onClick={() => onFinished(result.audit_id)}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 text-sm font-medium"
              >
                Open the audit
              </button>
            ) : null}
          </div>
          <div className="mt-1 text-xs opacity-80">
            {result ? `${fmtNum(result.total)} rows in the report · ` : ""}finished {fmtRelative(last.finishedAt)} · took {fmtDuration(last.durationMs)}
          </div>
          {!result && last.note ? <div className="mt-1 break-words">{last.note}</div> : null}
          <LastLog log={last.log} total={last.logTotal} open={logOpen} setOpen={setLogOpen} />
        </div>
      ) : last ? (
        <div className="rounded-xl p-4 text-sm ring-1 bg-rose-50 ring-rose-200 text-rose-900">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="font-medium inline-flex items-center gap-2">
              <XCircle className="h-4 w-4 shrink-0" /> {gi ? "Invoice run didn't finish" : "Pull failed"} {fmtRelative(last.finishedAt)}
            </div>
            {gi ? (
              // No blind retry: the person picks and reviews the shipments again.
              giAuditId && onFinished ? (
                <button onClick={() => onFinished(giAuditId)} className="px-3 py-1.5 rounded-lg ring-1 ring-rose-300 bg-white text-rose-800 hover:bg-rose-100 text-sm font-medium">
                  Open the audit
                </button>
              ) : null
            ) : (
              <button
                onClick={start}
                disabled={!!startDisabledReason || starting}
                title={startDisabledReason || undefined}
                className="px-3 py-1.5 rounded-lg ring-1 ring-rose-300 bg-white text-rose-800 hover:bg-rose-100 inline-flex items-center gap-1.5 text-sm font-medium disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" /> {starting ? "Queuing…" : "Retry"}
              </button>
            )}
          </div>
          <div className="mt-1 break-words">{lastError}</div>
          {giCounts ? (
            <div className="mt-1 text-xs tabular-nums">
              Got through {fmtNum(giCounts.done)} of {fmtNum(giCounts.total)} · {fmtNum(giCounts.ok)} done · {fmtNum(giCounts.failed)} failed. The pills in the audit show which.
            </div>
          ) : null}
          <LastLog log={last.log} total={last.logTotal} open={logOpen} setOpen={setLogOpen} />
        </div>
      ) : startDisabledReason && !loading ? (
        <div className="text-sm text-slate-500">{startDisabledReason}</div>
      ) : null}
    </section>
  );
}

function LastLog({ log, total, open, setOpen }: {
  log?: React.ComponentProps<typeof ScrapeLog>["lines"]; total?: number; open: boolean; setOpen: (v: boolean) => void;
}) {
  if (!log?.length) return null;
  return (
    <details className="mt-2" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="text-xs cursor-pointer underline opacity-80 hover:opacity-100">{open ? "Hide" : "Show"} log ({fmtNum(total ?? log.length)} lines)</summary>
      {open ? <div className="mt-2"><ScrapeLog lines={log} total={total} /></div> : null}
    </details>
  );
}

function Note({ tone, children }: { tone: "warn" | "danger"; children: React.ReactNode }) {
  return (
    <div className={"rounded-xl p-3 text-sm flex items-start gap-2 ring-1 " + (tone === "danger" ? "bg-rose-50 ring-rose-200 text-rose-800" : "bg-amber-50 ring-amber-200 text-amber-900")}>
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> <div>{children}</div>
    </div>
  );
}
