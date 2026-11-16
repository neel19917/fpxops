import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Play, Square } from "lucide-react";
import { hostedBrowser, type DetailsCounts, type DetailsState } from "../lib/hostedBrowser";
import { fetchShipmentDetailsList, requestShipmentDetailsSweep, type ShipmentDetailsList } from "../lib/shipmentDetails";
import { fmtDateTime, fmtNum } from "../lib/format";
import { HostedFreightPop } from "../components/HostedFreightPop";
import { DetailsLog } from "../components/DetailsLog";
import { ShipmentDetailsResults } from "../components/ShipmentDetailsResults";

// Shipment details monitor: start a read of every tracked shipment, watch the
// details browser live, read its log, and see what is stored.
//
// Data sources:
//   - browser-service /details/state: the running job, its log, the last run
//   - /api/shipment-details (Railway API): the stored details and the sweep queue
// The job is read only: it changes nothing in FreightPOP.

const POLL_MS = 3000;
const RESULTS_POLL_MS = 30_000; // while a job runs, so rows appear as they are stored
const QUEUED_TIMEOUT_MS = 2 * 60_000;

const QUEUED_TEXT = "Queued. The details browser starts within a few seconds.";
const NOT_STARTED_TEXT = "The read has not started yet. Check the hosted browser, then try again.";
const NOT_SET_UP_TEXT = "The hosted browser is not set up for this dashboard.";

const PRIMARY_BTN = "px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
const SECONDARY_BTN = "px-4 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
const STOP_BTN = "px-4 py-2 rounded-lg bg-white text-rose-700 ring-1 ring-rose-300 hover:bg-rose-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2";

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

function countsText(c: DetailsCounts): string {
  return `${fmtNum(c.done)} of ${fmtNum(c.total)} · ${fmtNum(c.stored)} stored · ${fmtNum(c.failed)} failed`;
}

function statusOf(state: DetailsState | null): { text: string; failed: boolean } {
  const current = state?.current;
  if (current) {
    const head = current.shipment ? `Reading shipment ${current.shipment}` : "Reading";
    return { text: `${head} · ${countsText(current.counts)}${current.stopping ? " · Stopping after this shipment" : ""}`, failed: false };
  }
  const last = state?.last;
  if (last) {
    const head = last.ok ? "Last read finished" : "Last read failed";
    return { text: `${head} ${fmtDateTime(last.finishedAt)} · ${countsText(last.counts)}${last.note ? ` · ${last.note}` : ""}`, failed: !last.ok };
  }
  return { text: "Idle.", failed: false };
}

function Progress({ counts }: { counts: DetailsCounts }) {
  const pct = counts.total > 0 ? Math.max(0, Math.min(100, (counts.done / counts.total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label="Shipments read"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={`${fmtNum(counts.done)} of ${fmtNum(counts.total)}`}
      className="h-1.5 rounded-full bg-violet-100 overflow-hidden"
    >
      <div className="h-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Alert({ children }: { children: string }) {
  return <div role="alert" className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 text-sm px-3 py-2">{children}</div>;
}

export function ShipmentDetailsMonitorPage() {
  const enabled = hostedBrowser.enabled;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);

  const [state, setState] = useState<DetailsState | null>(null);
  const [stateErr, setStateErr] = useState<string | null>(null);
  const [results, setResults] = useState<ShipmentDetailsList | null>(null);
  const [resultsLoading, setResultsLoading] = useState(true);
  const [resultsErr, setResultsErr] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  // Set after a successful start, until the service picks the job up.
  // lastId = the previous run's id when we queued, to notice a run that started
  // and finished between two polls.
  const [queued, setQueued] = useState<{ at: number; lastId: string | null } | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopErr, setStopErr] = useState<string | null>(null);

  const [full, setFull] = useState(false);
  const [fullErr, setFullErr] = useState<string | null>(null);
  const [userToggled, setUserToggled] = useState(false);
  const [userOpen, setUserOpen] = useState(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // ---- job state: every 3s while the page is visible, never overlapping ----
  const polling = useRef(false);
  const pollState = useCallback(async () => {
    if (!enabled || polling.current) return;
    polling.current = true;
    try {
      const s = await hostedBrowser.detailsState();
      if (!alive.current) return;
      setState(s);
      setStateErr(null);
    } catch (e) {
      if (!alive.current) return;
      setStateErr(errText(e)); // the last good state stays on screen
    } finally {
      polling.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void pollState();
    const id = setInterval(() => { if (!document.hidden) void pollState(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void pollState(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, pollState]);

  // ---- stored results ----
  const loadingResults = useRef(false);
  const loadResults = useCallback(async () => {
    if (loadingResults.current) return;
    loadingResults.current = true;
    try {
      const r = await fetchShipmentDetailsList();
      if (!alive.current) return;
      setResults(r);
      setResultsErr(null);
    } catch (e) {
      if (!alive.current) return;
      setResultsErr(errText(e));
    } finally {
      loadingResults.current = false;
      if (alive.current) setResultsLoading(false);
    }
  }, []);

  const retryResults = useCallback(() => {
    setResultsLoading(true);
    setResultsErr(null);
    void loadResults();
  }, [loadResults]);

  useEffect(() => { void loadResults(); }, [loadResults]);

  const busy = !!state?.current;
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) void loadResults(); // the job just finished
    wasBusy.current = busy;
    if (!busy) return;
    const id = setInterval(() => { if (!document.hidden) void loadResults(); }, RESULTS_POLL_MS);
    return () => clearInterval(id);
  }, [busy, loadResults]);

  // ---- queued flag: it must not stick ----
  const lastId = state?.last?.requestId ?? null;
  useEffect(() => {
    if (!queued) return;
    if (busy || lastId !== queued.lastId) { setQueued(null); return; }
    const id = setTimeout(() => {
      if (!alive.current) return;
      setQueued(null);
      setStartErr(NOT_STARTED_TEXT);
    }, Math.max(0, queued.at + QUEUED_TIMEOUT_MS - Date.now()));
    return () => clearTimeout(id);
  }, [queued, busy, lastId]);

  const start = async () => {
    if (starting || queued || busy || !enabled) return;
    setStarting(true);
    setStartErr(null);
    try {
      await requestShipmentDetailsSweep();
      if (!alive.current) return;
      setQueued({ at: Date.now(), lastId });
      void pollState();
    } catch (e) {
      if (!alive.current) return;
      setStartErr(errText(e));
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  const stop = async () => {
    if (stopBusy) return;
    setStopBusy(true);
    setStopErr(null);
    try {
      await hostedBrowser.stopDetails();
      if (!alive.current) return;
      void pollState();
    } catch (e) {
      if (!alive.current) return;
      setStopErr(errText(e));
    } finally {
      if (alive.current) setStopBusy(false);
    }
  };

  // ---- full screen: the browser's own, on this page's root ----
  useEffect(() => {
    const onChange = () => setFull(!!rootRef.current && document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFull = async () => {
    setFullErr(null);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch (e) {
      if (!alive.current) return;
      setFullErr(errText(e));
    }
  };

  const current = state?.current ?? null;
  const last = state?.last ?? null;
  const status = statusOf(state);
  const resultsOpen = userToggled ? userOpen : !busy;
  const paneHeight = full ? "h-[calc(100vh-9rem)] min-h-[420px]" : "h-[calc(100vh-15rem)] min-h-[420px]";
  const logLines = current ? current.log : last ? last.log : [];
  const logNote = !current && last ? `This is the log of the previous run, finished ${fmtDateTime(last.finishedAt)}.` : null;

  return (
    <div
      ref={rootRef}
      className={(full ? "h-screen w-screen bg-slate-50 p-3 overflow-y-auto" : "flex-1 min-h-0") + " flex flex-col gap-3"}
    >
      <header className="shrink-0 rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-900">Shipment details</h1>
            <p className="text-xs text-slate-500">Read only: nothing is changed in FreightPOP.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={start} disabled={!enabled || busy || !!queued || starting} className={PRIMARY_BTN}>
              <Play className="h-4 w-4" aria-hidden="true" /> Read all tracked shipments
            </button>
            {current ? (
              <button type="button" onClick={stop} disabled={stopBusy || current.stopping} className={STOP_BTN}>
                <Square className="h-4 w-4" aria-hidden="true" /> {current.stopping ? "Stopping" : "Stop"}
              </button>
            ) : null}
            {document.fullscreenEnabled ? (
              <button type="button" onClick={toggleFull} className={SECONDARY_BTN}>
                {full ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
                {full ? "Exit full screen" : "Full screen"}
              </button>
            ) : null}
          </div>
        </div>

        <div role="status" className={"text-sm tabular-nums " + (status.failed ? "text-rose-700 font-medium" : "text-slate-700")}>
          {enabled ? status.text : NOT_SET_UP_TEXT}
        </div>
        {current ? <Progress counts={current.counts} /> : null}

        {queued && !busy ? (
          <div role="status" className="rounded-lg bg-violet-50 ring-1 ring-violet-200 text-violet-900 text-sm px-3 py-2">{QUEUED_TEXT}</div>
        ) : null}
        {stateErr ? <Alert>{stateErr}</Alert> : null}
        {startErr ? <Alert>{startErr}</Alert> : null}
        {stopErr ? <Alert>{stopErr}</Alert> : null}
        {fullErr ? <Alert>{fullErr}</Alert> : null}
      </header>

      <div className="shrink-0 grid gap-3 lg:grid-cols-[3fr_2fr]">
        {current ? (
          <div className={paneHeight + " min-w-0 rounded-lg overflow-hidden ring-1 ring-violet-200 bg-slate-900"}>
            <HostedFreightPop key={current.requestId} target="details" onEnded={() => { void pollState(); }} />
          </div>
        ) : (
          <div className={paneHeight + " min-w-0 rounded-lg ring-1 ring-slate-200 bg-white flex items-center justify-center p-6 text-center text-sm text-slate-500"}>
            The details browser only runs while a read is in progress.
          </div>
        )}
        <div className={paneHeight + " min-w-0"}>
          <DetailsLog className="h-full" lines={logLines} live={busy} note={logNote} />
        </div>
      </div>

      <section className="shrink-0 rounded-xl bg-white ring-1 ring-slate-200">
        <h2>
          <button
            type="button"
            aria-expanded={resultsOpen}
            aria-controls="shipment-details-stored"
            onClick={() => { setUserToggled(true); setUserOpen(!resultsOpen); }}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-slate-900 rounded-xl hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <span>Stored details</span>
            <ChevronDown className={"h-4 w-4 text-slate-500 transition-transform " + (resultsOpen ? "rotate-180" : "")} aria-hidden="true" />
          </button>
        </h2>
        <div id="shipment-details-stored" hidden={!resultsOpen} className="px-4 pb-4">
          <ShipmentDetailsResults data={results} loading={resultsLoading} error={resultsErr} onRetry={retryResults} />
        </div>
      </section>
    </div>
  );
}
