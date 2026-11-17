import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Download, Maximize2, Minimize2, Pause, Play, RotateCcw, Search } from "lucide-react";
import {
  fetchReaderState, fetchReadingLog, processWaiting,
  type LogLine, type ReaderState, type ReadingNow, type ReadingStep,
} from "../lib/invoiceReading";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

// Reading invoices: watch FPX read each saved invoice, BOL, rate confirmation
// and quote with Claude, store what it says and make it searchable.
//
// Data sources (Railway API, /api/invoice-docs):
//   - GET /state: what the reader is doing now on the API server, and counts
//   - GET /log:   every step of every file (fpx_invoice_doc_log), tailed live
//   - POST /process: the two buttons

const LOG_POLL_MS = 2000;
const STATE_POLL_MS = 3000;
const FIRST_LOAD = 500;
const MAX_LINES = 3000;

const PRIMARY_BTN = "px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
const SECONDARY_BTN = "px-4 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
const SMALL_BTN = "px-2.5 py-1 rounded-md bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

const STEPS: { key: ReadingStep; label: string }[] = [
  { key: "downloading", label: "Download" },
  { key: "reading", label: "Read with Claude" },
  { key: "embedding", label: "Make searchable" },
];

const LEVEL_STYLE: Record<LogLine["level"], { row: string; dot: string; label: string }> = {
  info: { row: "text-slate-700", dot: "bg-slate-300", label: "Info" },
  ok: { row: "text-emerald-800", dot: "bg-emerald-500", label: "OK" },
  warn: { row: "text-amber-800 bg-amber-50/60", dot: "bg-amber-500", label: "Note" },
  error: { row: "text-rose-800 bg-rose-50/70", dot: "bg-rose-500", label: "Problem" },
};

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

const money = (n: number | null | undefined, digits = 2) => (n == null ? "—" : `$${Number(n).toFixed(digits)}`);
const fileName = (f: string | null) => String(f || "").replace(/^invoices\//, "") || "—";
const fmtMs = (ms: number | null) => (ms == null ? null : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`);
const timeOf = (at: string | null) => {
  if (!at) return "—";
  const d = new Date(at);
  return isNaN(d.getTime()) ? at : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
};
const isProblem = (l: LogLine) => l.level === "warn" || l.level === "error";

function csvOf(lines: LogLine[]): string {
  const cols: (keyof LogLine)[] = ["id", "at", "level", "step", "shipment_id", "file", "doc_type", "message", "ms", "cost_usd", "document_id"];
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...lines.map((l) => cols.map((c) => cell(l[c])).join(","))].join("\r\n");
}

function downloadCsv(lines: LogLine[]) {
  const blob = new Blob([csvOf(lines)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-reading-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

function Alert({ children }: { children: string }) {
  return <div role="alert" className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 text-sm px-3 py-2">{children}</div>;
}

function Stat({ label, value, tone = "slate", hint }: { label: string; value: string; tone?: "slate" | "violet" | "rose" | "emerald"; hint?: string }) {
  const color = { slate: "text-slate-900", violet: "text-violet-700", rose: "text-rose-700", emerald: "text-emerald-700" }[tone];
  return (
    <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2 min-w-0" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={"text-lg font-semibold tabular-nums " + color}>{value}</div>
    </div>
  );
}

function ReadingCard({ r, now }: { r: ReadingNow; now: number }) {
  const idx = STEPS.findIndex((s) => s.key === r.step);
  const secs = Math.max(0, Math.round((now - Date.parse(r.since)) / 1000));
  return (
    <div className="rounded-lg bg-white ring-1 ring-violet-200 p-3 space-y-2 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900 truncate" title={fileName(r.file)}>{fileName(r.file)}</div>
          <div className="text-xs text-slate-500">
            {r.doc_type || "document"} · shipment{" "}
            {r.shipment_id ? (
              <Link to={`/invoices?shipment=${encodeURIComponent(r.shipment_id)}`} className="text-violet-700 hover:underline">{r.shipment_id}</Link>
            ) : "—"}
          </div>
        </div>
        <div className="text-xs text-slate-500 tabular-nums shrink-0">{Number.isFinite(secs) ? `${secs}s` : ""}</div>
      </div>
      <ol className="grid grid-cols-3 gap-1" aria-label="Steps">
        {STEPS.map((s, i) => {
          const state = i < idx ? "done" : i === idx ? "now" : "later";
          return (
            <li key={s.key} className="min-w-0">
              <div className={"h-1.5 rounded-full " + (state === "done" ? "bg-violet-500" : state === "now" ? "bg-violet-400 animate-pulse" : "bg-slate-200")} />
              <div className={"mt-1 text-[11px] truncate " + (state === "now" ? "text-violet-700 font-medium" : state === "done" ? "text-slate-600" : "text-slate-400")}>
                {s.label}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function InvoiceReadingPage() {
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const visible = usePageVisible();

  const [full, setFull] = useState(false);
  const [state, setState] = useState<ReaderState | null>(null);
  const [stateErr, setStateErr] = useState<string | null>(null);

  const [lines, setLines] = useState<LogLine[]>([]);
  const [logLoaded, setLogLoaded] = useState(false);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [q, setQ] = useState("");
  const lastId = useRef<number | null>(null);

  const [busy, setBusy] = useState<null | "read" | "retry">(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; bad: boolean } | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- full screen: an overlay on top of the dashboard; Esc leaves it ----
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full]);

  // ---- state ----
  const pollState = useCallback(async () => {
    try {
      const s = await fetchReaderState();
      if (!alive.current) return;
      setState(s);
      setStateErr(null);
    } catch (e) {
      if (alive.current) setStateErr(errText(e));
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void pollState();
    const t = setInterval(() => { void pollState(); }, STATE_POLL_MS);
    return () => clearInterval(t);
  }, [visible, pollState]);

  // ---- log: the newest lines first, then only what is new ----
  const pollLog = useCallback(async () => {
    try {
      if (lastId.current == null) {
        const page = await fetchReadingLog({ limit: FIRST_LOAD });
        if (!alive.current) return;
        const asc = [...page.data].reverse();
        setLines(asc);
        lastId.current = page.last_id ?? 0;
      } else {
        const page = await fetchReadingLog({ sinceId: lastId.current, limit: 1000 });
        if (!alive.current) return;
        if (page.data.length) {
          const seen = lastId.current;
          const fresh = page.data.filter((l) => l.id > seen);
          setLines((prev) => {
            const next = prev.concat(fresh);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        }
        if (page.last_id != null) lastId.current = Math.max(lastId.current, page.last_id);
      }
      setLogErr(null);
      setLogLoaded(true);
    } catch (e) {
      if (alive.current) setLogErr(errText(e));
    }
  }, []);

  useEffect(() => {
    if (!visible || paused) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await pollLog();
      if (!stop) t = setTimeout(tick, LOG_POLL_MS);
    };
    void tick();
    return () => { stop = true; if (t) clearTimeout(t); };
  }, [visible, paused, pollLog]);

  // ---- what the log shows ----
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return lines.filter((l) => {
      if (problemsOnly && !isProblem(l)) return false;
      if (!term) return true;
      return [l.message, l.shipment_id, l.file, l.doc_type, l.step].some((v) => v && String(v).toLowerCase().includes(term));
    });
  }, [lines, problemsOnly, q]);
  const problemCount = useMemo(() => lines.filter(isProblem).length, [lines]);

  // ---- auto-scroll unless the reader scrolled up ----
  const logRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setScrolledUp(!stick.current);
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown, full]);
  const jumpToNewest = () => {
    const el = logRef.current;
    if (!el) return;
    stick.current = true;
    setScrolledUp(false);
    el.scrollTop = el.scrollHeight;
  };

  // ---- buttons ----
  const run = async (kind: "read" | "retry") => {
    setBusy(kind);
    setActionMsg(null);
    try {
      const r = await processWaiting({ retryFailed: kind === "retry" });
      if (!alive.current) return;
      if (!r.processing) {
        setActionMsg({ text: r.reason || "Reading did not start on this server.", bad: true });
      } else {
        const what = kind === "retry" ? "Failed files will be tried again" : "Reading started";
        setActionMsg({
          text: `${what}. ${r.queued ? `${fmtNum(r.queued)} more file${r.queued === 1 ? "" : "s"} added to the queue.` : "No new files needed adding to the queue."} Watch the log below.`,
          bad: false,
        });
      }
      void pollState();
    } catch (e) {
      if (alive.current) setActionMsg({ text: errText(e), bad: true });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // ---- numbers ----
  const counts = state?.by_status;
  const waiting = state?.queue.pending ?? 0;
  const beingRead = state?.queue.processing ?? 0;
  const failed = state?.queue.failed ?? 0;
  const runInfo = state?.run ?? null;
  const runActive = !!state?.running && !!runInfo && !runInfo.finished_at;
  const runTotal = runInfo ? runInfo.processed + waiting + beingRead : 0;
  const runPct = runTotal > 0 && runInfo ? Math.max(0, Math.min(100, (runInfo.processed / runTotal) * 100)) : 0;
  const lastRead = state?.last_extracted_at ?? null;
  // Re-read `now` so the "ago" text moves every second.
  const lastReadAgo = now && lastRead ? fmtRelative(lastRead) : null;

  const statusText = !state
    ? "Loading…"
    : state.running
      ? `Running${state.reading.length ? ` · reading ${state.reading.length} file${state.reading.length === 1 ? "" : "s"} now` : ""}`
      : `Idle${lastReadAgo ? ` · last file read ${lastReadAgo}` : ""}`;

  return (
    <div className={full ? "fixed inset-0 z-50 bg-slate-50 p-3 overflow-y-auto flex flex-col gap-3" : "flex-1 min-h-0 flex flex-col gap-3"}>
      <header className="shrink-0 rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {!full ? (
              <Link to="/invoices" className="inline-flex items-center gap-1 text-xs text-violet-700 hover:underline mb-1">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to Invoices
              </Link>
            ) : null}
            <h1 className="text-lg font-semibold text-slate-900">Reading invoices</h1>
            <p className="text-xs text-slate-500">
              FPX reads each saved invoice and document with Claude, stores what it says, and makes it searchable.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => run("read")} disabled={busy !== null || state?.enabled === false} className={PRIMARY_BTN}
              title={state?.enabled === false ? "Reading is off on this server" : undefined}>
              <Play className="h-4 w-4" aria-hidden="true" /> {busy === "read" ? "Starting…" : "Read waiting files now"}
            </button>
            {failed > 0 ? (
              <button type="button" onClick={() => run("retry")} disabled={busy !== null || state?.enabled === false} className={SECONDARY_BTN}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" /> {busy === "retry" ? "Starting…" : `Retry failed (${fmtNum(failed)})`}
              </button>
            ) : null}
            <button type="button" onClick={() => setFull((v) => !v)} className={SECONDARY_BTN}>
              {full ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
              {full ? "Exit full screen" : "Full screen"}
            </button>
          </div>
        </div>

        <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
          <span className={
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 " +
            (state?.running ? "bg-violet-50 text-violet-800 ring-violet-200" : "bg-slate-100 text-slate-700 ring-slate-200")
          }>
            <span className={"h-2 w-2 rounded-full " + (state?.running ? "bg-violet-500 animate-pulse" : "bg-slate-400")} />
            {state?.running ? "Running" : state ? "Idle" : "…"}
          </span>
          <span className="text-slate-700 tabular-nums">{statusText}</span>
          {state && !state.enabled ? (
            <span className="text-xs text-amber-800">Reading is off on this server (no Claude key), so nothing new is read here.</span>
          ) : null}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <Stat label="Read" value={fmtNum(counts?.done)} tone="emerald" hint="Files Claude has read and stored" />
          <Stat label="Waiting" value={fmtNum(counts ? waiting : null)} hint="Saved files not read yet" />
          <Stat label="Being read" value={fmtNum(counts ? beingRead : null)} tone="violet" />
          <Stat label="Failed" value={fmtNum(counts ? failed : null)} tone={failed ? "rose" : "slate"} hint="Files that could not be read after every try" />
          <Stat label="Skipped" value={fmtNum(counts?.skipped)} hint="Files that do not need reading (for example screenshots)" />
          <Stat label="Total cost" value={state ? money(state.cost_usd) : "—"} hint="Claude spend on reading, all time" />
          <Stat label="Cost today" value={state ? money(state.cost_today_usd) : "—"} hint="Since midnight UTC" />
        </div>

        {runInfo && (runActive || runTotal > 0) ? (
          <div className="space-y-1">
            <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-600 tabular-nums">
              <span>
                {runActive ? "This run" : `Last run${runInfo.finished_at ? ` (finished ${fmtDateTime(runInfo.finished_at)})` : ""}`}:{" "}
                {fmtNum(runInfo.processed)} of {fmtNum(runTotal)} files
              </span>
              <span>
                {fmtNum(runInfo.done)} read · {fmtNum(runInfo.copied)} copied · {fmtNum(runInfo.unchanged)} unchanged · {fmtNum(runInfo.failed)} failed
              </span>
            </div>
            <div role="progressbar" aria-label="Files read this run" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(runPct)}
              aria-valuetext={`${runInfo.processed} of ${runTotal}`} className="h-1.5 rounded-full bg-violet-100 overflow-hidden">
              <div className="h-full bg-violet-500 transition-all" style={{ width: `${runPct}%` }} />
            </div>
          </div>
        ) : null}

        {actionMsg ? (
          actionMsg.bad ? <Alert>{actionMsg.text}</Alert> : (
            <div role="status" className="rounded-lg bg-violet-50 ring-1 ring-violet-200 text-violet-900 text-sm px-3 py-2">{actionMsg.text}</div>
          )
        ) : null}
        {stateErr ? <Alert>{stateErr}</Alert> : null}
      </header>

      <section className="shrink-0 rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Reading now</h2>
        {state?.reading.length ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {state.reading.map((r) => <ReadingCard key={r.id} r={r} now={now} />)}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No file is being read right now.</p>
        )}
      </section>

      <section className={"rounded-xl bg-white ring-1 ring-slate-200 flex flex-col min-h-0 " + (full ? "flex-1 min-h-[420px]" : "")}>
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900 mr-2">Live log</h2>
          <div className="inline-flex rounded-lg ring-1 ring-slate-300 overflow-hidden text-xs" role="group" aria-label="Which lines">
            <button type="button" onClick={() => setProblemsOnly(false)} aria-pressed={!problemsOnly}
              className={"px-2.5 py-1 " + (!problemsOnly ? "bg-violet-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50")}>
              All
            </button>
            <button type="button" onClick={() => setProblemsOnly(true)} aria-pressed={problemsOnly}
              className={"px-2.5 py-1 border-l border-slate-300 " + (problemsOnly ? "bg-violet-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50")}>
              Problems only{problemCount ? ` (${fmtNum(problemCount)})` : ""}
            </button>
          </div>
          <label className="relative flex-1 min-w-[10rem] max-w-xs">
            <span className="sr-only">Search the log</span>
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shipment, file, message"
              className="w-full rounded-md ring-1 ring-slate-300 pl-7 pr-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500" />
          </label>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-500 tabular-nums">
              {paused ? "Paused" : visible ? "Live" : "Paused while this tab is hidden"} · {fmtNum(shown.length)}
              {shown.length !== lines.length ? ` of ${fmtNum(lines.length)}` : ""} lines
            </span>
            <button type="button" onClick={() => setPaused((p) => !p)} className={SMALL_BTN}>
              {paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={() => downloadCsv(shown)} disabled={!shown.length} className={SMALL_BTN}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download log
            </button>
          </div>
        </div>
        {logErr ? <div className="px-4 pt-3"><Alert>{logErr}</Alert></div> : null}

        <div className="relative flex-1 min-h-0">
          <div ref={logRef} onScroll={onLogScroll}
            className={"overflow-y-auto font-mono text-xs " + (full ? "absolute inset-0" : "h-[28rem]")}
            aria-live="off">
            {!logLoaded && !logErr ? (
              <p className="p-4 text-sm text-slate-500 font-sans">Loading the log…</p>
            ) : lines.length === 0 ? (
              <div className="p-6 text-sm text-slate-600 font-sans space-y-1">
                <p className="font-medium text-slate-800">Nothing in the log yet.</p>
                <p>
                  Lines appear here the next time a Get Invoice run saves files, as FPX downloads each one, reads it with Claude
                  and makes it searchable. You can also press "Read waiting files now" to read anything already saved.
                </p>
              </div>
            ) : shown.length === 0 ? (
              <p className="p-4 text-sm text-slate-500 font-sans">No lines match.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {shown.map((l) => {
                  const st = LEVEL_STYLE[l.level] ?? LEVEL_STYLE.info;
                  const dur = fmtMs(l.ms);
                  return (
                    <li key={l.id} className={"px-4 py-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 " + st.row}>
                      <span className="text-slate-500 tabular-nums shrink-0" title={fmtDateTime(l.at)}>{timeOf(l.at)}</span>
                      <span className={"h-2 w-2 rounded-full shrink-0 self-center " + st.dot} title={st.label} aria-label={st.label} />
                      {l.shipment_id ? (
                        <Link to={`/invoices?shipment=${encodeURIComponent(l.shipment_id)}`} className="text-violet-700 hover:underline shrink-0">
                          {l.shipment_id}
                        </Link>
                      ) : null}
                      {l.file ? <span className="text-slate-500 truncate max-w-[16rem]" title={fileName(l.file)}>{fileName(l.file)}</span> : null}
                      <span className="flex-1 min-w-[12rem] break-words font-sans">{l.message}</span>
                      {dur ? <span className="text-slate-500 tabular-nums shrink-0">{dur}</span> : null}
                      {l.cost_usd != null ? <span className="text-slate-500 tabular-nums shrink-0">{money(l.cost_usd, 4)}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {scrolledUp && shown.length > 0 ? (
            <button type="button" onClick={jumpToNewest} className={SMALL_BTN + " absolute bottom-3 right-4 shadow"}>
              Jump to newest
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
