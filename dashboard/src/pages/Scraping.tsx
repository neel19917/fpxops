import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, LogIn, Maximize2, Minimize2, MonitorPlay, Play, Square, XCircle } from "lucide-react";
import { api, type ScrapeRequest } from "../lib/api";
import { hostedBrowser, type HostedStats, type ScrapeCounts, type FpTotals, type TaskSnapshot } from "../lib/hostedBrowser";
import { FpTotalsTrend, FpBeforeAfter } from "../components/FpTotalsTrend";
import { ModePicker, ALL_MODES, modesText } from "../components/ModePicker";
import { TaskModesInline } from "../components/TaskRulesDialog";
import { ScrapeEmailSubscription } from "../components/ScrapeEmailSubscription";
import { useAuth } from "../lib/auth";
import { showFrame, hideFrame, useFrameState } from "../lib/freightpopFrame";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import { HostedFreightPop } from "../components/HostedFreightPop";
import { ScrapeLog } from "../components/ScrapeLog";
import { SchedulesPane } from "../components/SchedulesPane";
import { Link } from "react-router-dom";

// Scraping: run Refresh All in your own hosted browser, watch it, and see how
// the hosted browser service is being used.
//
// Data sources:
//   - /api/ops/rescrape (Railway API): the request queue + history
//   - browser-service /stats: live browsers, the running job, per-user usage
// Polls every 5s while the tab is visible — this page is watched while a
// scrape runs, unlike the Ops page.

const POLL_MS = 5000;
const POLL_RUNNING_MS = 2000; // faster while a scrape is running, for the live log

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function since(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  return now - new Date(iso).getTime();
}

export function ScrapingPage() {
  const { clientConfig } = useAuth();
  const embedEnabled = !!clientConfig?.embed_freightpop?.enabled;
  const frame = useFrameState();
  const [stats, setStats] = useState<HostedStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [requests, setRequests] = useState<ScrapeRequest[]>([]);
  const [reqErr, setReqErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [watch, setWatch] = useState(true);
  const [full, setFull] = useState(false);
  const [logOpen, setLogOpen] = useState(false); // last run's log disclosure
  // Esc leaves full screen; leaving full screen when the run ends.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setFull(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [s, r] = await Promise.allSettled([
        hostedBrowser.enabled ? hostedBrowser.stats(30) : Promise.reject(new Error("not configured")),
        api.ops.rescrapeRecent(),
      ]);
      if (s.status === "fulfilled") { setStats(s.value); setStatsErr(null); }
      else if (hostedBrowser.enabled) setStatsErr((s.reason as Error).message);
      if (r.status === "fulfilled") { setRequests(r.value.requests); setReqErr(null); }
      else setReqErr((r.reason as Error).message);
    } finally {
      inflight.current = false;
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  const isRunning = !!stats?.worker.current;
  useEffect(() => { if (!isRunning) setFull(false); }, [isRunning]);
  useEffect(() => {
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, isRunning ? POLL_RUNNING_MS : POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(id); clearInterval(tick); };
  }, [load, isRunning]);

  const worker = stats?.worker;
  const me = stats?.me;
  // Invoicing jobs (ERP pull, get invoices, approval check) run in their own
  // session and never hold up a scrape, so they don't count as "queued" here.
  const INVOICING_SCOPES = ["erp_audit", "get_invoice", "approval_check"];
  const pending = requests.filter((r) => (r.status === "pending" || r.status === "claimed") && !INVOICING_SCOPES.includes(r.scope as string));
  // Which FreightPOP modes "Refresh all shipments" covers (remembered per browser).
  const [modes, setModes] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem("fpx.scrape.modes") || "null"); if (Array.isArray(v) && v.length) return v; } catch { /* ignore */ }
    return ALL_MODES;
  });
  useEffect(() => { try { localStorage.setItem("fpx.scrape.modes", JSON.stringify(modes)); } catch { /* ignore */ } }, [modes]);
  const running = worker?.current || null;
  const loggedIn = me?.freightpop?.loggedIn === true;
  const canStart = !!worker?.enabled && loggedIn && !running && !pending.length && !worker?.queued?.length && !starting;

  async function start() {
    setStarting(true); setNotice(null);
    try {
      await api.ops.requestRescrape(modes.length === ALL_MODES.length ? { scope: "all" } : { scope: "all", modes });
      await load();
    } catch (e) { setNotice((e as Error).message); }
    finally { setStarting(false); }
  }

  async function stop() {
    setStopping(true);
    try { await hostedBrowser.stopScrape(); await load(); }
    catch (e) { setNotice((e as Error).message); }
    finally { setStopping(false); }
  }

  function openMyFreightPop() {
    // In hosted mode the overlay streams the user's own browser; the URL only
    // has to be non-empty (url_template may contain per-shipment placeholders).
    showFrame({ url: "https://app.freightpop.com/", shipmentId: null, shipmentLabel: "My hosted browser", trackingNumber: null });
  }

  const startDisabledReason = !hostedBrowser.enabled ? "Hosted browser isn't configured for this dashboard"
    : !worker ? "Loading…"
    : !worker.enabled ? `Scrape worker is off (${worker.reason})`
    : !loggedIn ? "Log in to FreightPOP in your hosted browser first"
    : running ? "A scrape is already running"
    : pending.length ? "A scrape is already queued"
    : null;

  const totals = stats?.usage.users.reduce(
    (t, u) => ({ connectedMs: t.connectedMs + u.connectedMs, scrapes: t.scrapes + u.scrapes, errors: t.errors + u.scrapeErrors }),
    { connectedMs: 0, scrapes: 0, errors: 0 },
  );

  const lastRun = worker?.lastResult || null;
  // One list from both sources, de-duplicated (a manual run has the same id
  // in both), newest first; queued/running requests stay on top.
  const recentRuns = useMemo(() => {
    type Row = { id: string; status: ScrapeRequest["status"]; note: string; at: string; user: string | null;
      source: "manual" | "schedule"; scheduleName?: string | null; durationMs: number | null; saved: number | null; hasLog: boolean;
      fpBefore?: FpTotals | null; fpAfter?: FpTotals | null; tasksBefore?: TaskSnapshot | null; tasksAfter?: TaskSnapshot | null; modes?: string[] | null };
    const rows = new Map<string, Row>();
    for (const r of stats?.runs || []) {
      rows.set(r.id, {
        id: r.id, status: r.ok ? "done" : "error", note: r.note || "—", at: r.startedAt, user: r.user,
        source: r.source, scheduleName: r.scheduleName, durationMs: r.durationMs, saved: r.counts?.saved ?? null, hasLog: true,
        fpBefore: r.fpBefore ?? null, fpAfter: r.fpAfter ?? null, tasksBefore: r.tasksBefore ?? null, tasksAfter: r.tasksAfter ?? null, modes: r.modes ?? null,
      });
    }
    for (const q of requests) {
      if (rows.has(q.id) && q.status !== "pending" && q.status !== "claimed") continue;
      const prior = rows.get(q.id);
      rows.set(q.id, {
        id: q.id, status: q.status,
        note: q.note || (q.status === "pending" ? "Waiting to start" : q.status === "claimed" ? "Running…" : "—"),
        at: q.requested_at, user: q.requested_by, source: "manual", scheduleName: null,
        durationMs: q.completed_at && q.claimed_at ? new Date(q.completed_at).getTime() - new Date(q.claimed_at).getTime() : null,
        saved: q.result_count, hasLog: prior?.hasLog || false,
        fpBefore: prior?.fpBefore ?? null, fpAfter: prior?.fpAfter ?? null, tasksBefore: prior?.tasksBefore ?? null, tasksAfter: prior?.tasksAfter ?? null,
      });
    }
    const active = (r: Row) => (r.status === "pending" || r.status === "claimed" ? 1 : 0);
    return [...rows.values()]
      .sort((x, y) => active(y) - active(x) || new Date(y.at).getTime() - new Date(x.at).getTime())
      .slice(0, 8);
  }, [stats?.runs, requests]);

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <MonitorPlay className="h-5 w-5 text-violet-600" /> Scraping
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">Refresh every shipment from FreightPOP using your own login.</p>
      </div>

      {!hostedBrowser.enabled ? (
        <Banner tone="warn">This dashboard isn't connected to a hosted browser (<code className="font-mono">VITE_FPX_BROWSER_URL</code> is unset).</Banner>
      ) : statsErr ? (
        <Banner tone="danger">Can't reach the hosted browser: {statsErr}</Banner>
      ) : null}
      {reqErr ? <Banner tone="danger">Can't load scrape history: {reqErr}</Banner> : null}
      {notice ? <Banner tone="danger">{notice}</Banner> : null}

      {/* Main card: one status line, one button, one state box. */}
      <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm">
            {!me ? (
              <span className="text-slate-500">{loading ? "Loading…" : "—"}</span>
            ) : loggedIn ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                <CheckCircle2 className="h-4 w-4" /> Signed in to FreightPOP
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-amber-800">
                <LogIn className="h-4 w-4" /> Sign in to FreightPOP first
              </span>
            )}
            {me && embedEnabled ? (
              frame.visible ? (
                <button onClick={hideFrame} className="ml-3 text-xs text-slate-600 hover:text-slate-900 underline">Hide FreightPOP</button>
              ) : (
                <button onClick={openMyFreightPop} className="ml-3 text-xs text-violet-700 hover:text-violet-900 underline inline-flex items-center gap-1">
                  <ExternalLink className="h-3 w-3" /> {loggedIn ? "Open FreightPOP" : "Open & sign in"}
                </button>
              )
            ) : null}
          </div>
          {running ? (
            <button
              onClick={stop}
              disabled={stopping}
              className="px-4 py-2 rounded-lg ring-1 ring-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-50"
            >
              <Square className="h-4 w-4" /> {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <div className="flex items-center gap-3 flex-wrap justify-end">
            <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-2 gap-y-1.5">
              <span className="text-[11px] uppercase font-semibold text-slate-500 text-right">Refresh</span>
              <ModePicker value={modes} onChange={setModes} disabled={starting} />
              <span />
              {stats?.isAdmin ? (
                <>
                  <span className="text-[11px] uppercase font-semibold text-slate-500 text-right">Tasks</span>
                  <TaskModesInline />
                </>
              ) : null}
            </div>
            <button
              onClick={start}
              disabled={!canStart}
              title={startDisabledReason || undefined}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play className="h-4 w-4" /> {starting ? "Queuing…" : modes.length === ALL_MODES.length ? "Refresh all shipments" : `Refresh ${modesText(modes)}`}
            </button>
            </div>
          )}
        </div>

        {running ? (
          <div className="rounded-xl bg-violet-50 ring-1 ring-violet-200 p-4 space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-violet-900 inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" />
                {running.source === "schedule" ? `Scheduled run${running.scheduleName ? ` "${running.scheduleName}"` : ""}` : "Running"}
                {running.user !== me?.user ? <span className="font-normal text-violet-700">for {running.user}</span> : null}
              </span>
              <span className="text-violet-800 tabular-nums">
                {fmtDuration(since(running.startedAt, now))}
                {worker?.queued?.length ? <span className="text-violet-600"> · {worker.queued.length} waiting</span> : null}
              </span>
            </div>
            <div className="text-sm text-violet-900 break-words">{running.status}</div>
            {running.fpCounts ? <FpTiles counts={running.fpCounts} at={running.fpCountsAt ?? null} /> : null}
            <ProgressBar processed={running.counts?.processed ?? 0} total={running.total ?? null} startedAt={running.startedAt} now={now} />
            {running.counts ? <CountsStrip counts={running.counts} /> : null}
            <div className="flex items-center gap-3">
              {running.user === me?.user ? (
                <button onClick={() => setWatch((v) => !v)} className="text-xs text-violet-700 hover:text-violet-900 underline">
                  {watch ? "Hide live view" : "Watch live"}
                </button>
              ) : null}
              <button onClick={() => setFull(true)} className="text-xs text-violet-700 hover:text-violet-900 inline-flex items-center gap-1">
                <Maximize2 className="h-3.5 w-3.5" /> Full screen
              </button>
            </div>
            {/* One container for both modes so the stream doesn't reconnect
                when toggling full screen. */}
            <div className={full
              ? "fixed inset-0 z-50 bg-slate-950 p-4 flex flex-col gap-3"
              : ""}>
              {full ? (
                <div className="flex items-center justify-between gap-3 text-sm text-slate-200">
                  <div className="min-w-0">
                    <div className="font-medium inline-flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
                      {running.source === "schedule" ? `Scheduled run${running.scheduleName ? ` "${running.scheduleName}"` : ""}` : "Refresh All"} · {fmtDuration(since(running.startedAt, now))}
                    </div>
                    <div className="text-xs text-slate-400 truncate">{running.status}</div>
                    <div className="mt-1 max-w-md [&_*]:!text-slate-300"><ProgressBar processed={running.counts?.processed ?? 0} total={running.total ?? null} startedAt={running.startedAt} now={now} /></div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {running.counts ? <div className="hidden md:block [&_*]:!text-slate-300"><CountsStrip counts={running.counts} /></div> : null}
                    <button onClick={() => setFull(false)} className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10" title="Exit full screen (Esc)" aria-label="Exit full screen">
                      <Minimize2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ) : null}
              <div className={"grid gap-3 " + (full ? "flex-1 min-h-0 " : "") + (watch && running.user === me?.user ? (full ? "lg:grid-cols-[7fr_3fr]" : "lg:grid-cols-[3fr_2fr]") : "")}>
                {watch && running.user === me?.user ? (
                  <div className={(full ? "h-full min-h-[300px]" : "h-[420px]") + " rounded-lg overflow-hidden ring-1 ring-violet-200 bg-slate-900"}>
                    <HostedFreightPop key={running.requestId} target="scrape" />
                  </div>
                ) : null}
                <ScrapeLog lines={running.log || []} total={running.logTotal} live tall={full} />
              </div>
            </div>
          </div>
        ) : pending.length || worker?.queued?.length ? (
          <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-4 text-sm text-amber-900 flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {worker?.queued?.length
              ? `Starting scheduled run${worker.queued[0].scheduleName ? ` "${worker.queued[0].scheduleName}"` : ""} for ${worker.queued[0].user}…`
              : `Starting within ${worker?.pollSeconds ?? 30}s…`}
          </div>
        ) : lastRun ? (
          <div className={"rounded-xl p-4 text-sm ring-1 " + (lastRun.ok ? "bg-emerald-50 ring-emerald-200 text-emerald-900" : "bg-rose-50 ring-rose-200 text-rose-900")}>
            <div className="font-medium inline-flex items-center gap-2">
              {lastRun.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {lastRun.ok ? "Last run finished" : "Last run failed"} {fmtRelative(lastRun.finishedAt)} · took {fmtDuration(lastRun.durationMs)}
            </div>
            {lastRun.note ? <div className="mt-1 break-words">{lastRun.note}</div> : null}
            {lastRun.counts ? <div className="mt-2"><CountsStrip counts={lastRun.counts} /></div> : null}
            {lastRun.log?.length ? (
              <details className="mt-2" open={logOpen} onToggle={(e) => setLogOpen(e.currentTarget.open)}>
                <summary className="text-xs cursor-pointer underline opacity-80 hover:opacity-100">{logOpen ? "Hide" : "Show"} log ({fmtNum(lastRun.logTotal ?? lastRun.log.length)} lines)</summary>
                {/* Rendered only while open, so it can start at the newest line. */}
                {logOpen ? <div className="mt-2"><ScrapeLog lines={lastRun.log} total={lastRun.logTotal} /></div> : null}
              </details>
            ) : null}
          </div>
        ) : startDisabledReason && worker ? (
          <div className="text-sm text-slate-500">{startDisabledReason}</div>
        ) : null}
      </section>

      {/* Scheduling */}
      {stats && hostedBrowser.enabled ? (
        <SchedulesPane schedules={stats.schedules || []} me={me?.user} isAdmin={!!stats.isAdmin} onChanged={load} />
      ) : null}

      {/* Email when a scrape finishes (per person) */}
      <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm px-5 py-3">
        <ScrapeEmailSubscription />
      </section>

      <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5">
        <FpTotalsTrend />
      </section>

      {/* Recent runs: the hosted browser's saved history (manual + scheduled,
          with logs) merged with the API's request queue, which also holds
          runs from before that history existed and anything queued/running. */}
      <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-slate-900">Recent runs</h2>
          {stats?.isAdmin ? <Link to="/admin/scrape-logs" className="text-xs text-violet-700 hover:underline">All logs →</Link> : null}
        </div>
        {recentRuns.length === 0 ? (
          <div className="text-sm text-slate-500">No runs yet.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recentRuns.map((r) => (
              <li key={r.id} className="py-2 flex items-start gap-3 text-sm">
                <StatusPill status={r.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-slate-800 break-words">{r.note}</div>
                  <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-2" title={fmtDateTime(r.at)}>
                    <span>{fmtRelative(r.at)}</span>
                    <span>· {r.source === "schedule" ? `Scheduled${r.scheduleName ? ` (${r.scheduleName})` : ""}` : "Manual"}</span>
                    {r.user && r.user !== me?.user ? <span>· {r.user}</span> : null}
                    {r.modes?.length ? <span className="text-violet-700">· {modesText(r.modes)}</span> : null}
                    {r.durationMs != null ? <span>· took {fmtDuration(r.durationMs)}</span> : null}
                    {r.saved != null ? <span>· {fmtNum(r.saved)} saved</span> : null}
                    {r.hasLog ? (
                      <button onClick={() => hostedBrowser.downloadLog(r.id).catch(() => {})} className="underline hover:text-slate-800">log</button>
                    ) : null}
                  </div>
                  <FpBeforeAfter before={r.fpBefore} after={r.fpAfter} tasksBefore={r.tasksBefore} tasksAfter={r.tasksAfter} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Usage: one line, details on demand. */}
      {stats ? (
        <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Usage · last 30 days</h2>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Scrapes" value={fmtNum(totals?.scrapes ?? 0)} sub={totals?.errors ? `${totals.errors} failed` : "none failed"} />
            <Stat label="Time in FreightPOP" value={fmtDuration(totals?.connectedMs ?? 0)} sub={`${stats.usage.users.length} ${stats.usage.users.length === 1 ? "person" : "people"}`} />
            <Stat label="Browsers running" value={`${stats.live.browsers} / ${stats.limits.maxBrowsers}`} sub={`${fmtNum(stats.live.memoryMb)} MB memory`} />
          </div>
          {stats.usage.users.length ? (
            <details className="mt-4">
              <summary className="text-xs text-slate-600 cursor-pointer hover:text-slate-900">By person</summary>
              <table className="w-full text-sm mt-2">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="py-1 font-medium">Person</th>
                    <th className="py-1 font-medium text-right">Scrapes</th>
                    <th className="py-1 font-medium text-right">Time in FreightPOP</th>
                    <th className="py-1 font-medium text-right">Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {stats.usage.users.map((u) => (
                    <tr key={u.email}>
                      <td className="py-1.5 text-slate-800 truncate max-w-[220px]">{u.email}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {fmtNum(u.scrapes)}{u.scrapeErrors ? <span className="text-rose-600"> ({u.scrapeErrors} failed)</span> : null}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{fmtDuration(u.connectedMs)}</td>
                      <td className="py-1.5 text-right text-slate-600">{u.lastActive}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

// "Processed 120 of 659" + bar + time left. The total comes from the Kendo
// grid's pager at the bottom of FreightPOP's dashboard.
function ProgressBar({ processed, total, startedAt, now }: { processed: number; total: number | null; startedAt: string; now: number }) {
  if (total == null) {
    return <div className="text-xs text-violet-800">Processed <span className="font-semibold tabular-nums">{fmtNum(processed)}</span> · reading total from the grid…</div>;
  }
  const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const elapsed = now - new Date(startedAt).getTime();
  const left = processed > 5 && total > processed ? (elapsed / processed) * (total - processed) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs text-violet-900">
        <span>Processed <span className="font-semibold tabular-nums">{fmtNum(processed)}</span> of <span className="font-semibold tabular-nums">{fmtNum(total)}</span> shipments in the grid</span>
        <span className="tabular-nums text-violet-700">{pct.toFixed(0)}%{left != null ? ` · ~${fmtDuration(left)} left` : ""}</span>
      </div>
      <div className="h-1.5 rounded-full bg-violet-100 overflow-hidden">
        <div className="h-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// FreightPOP's own dashboard tiles, read live from the page being scraped
// (refreshed every ~10s), so the team sees today's real shipment totals.
const FP_TILE_ORDER = ["TOTAL", "BOOKED", "IN TRANSIT", "ISSUES", "OUT FOR DELIVERY"];
function FpTiles({ counts, at }: { counts: Record<string, number>; at: string | null }) {
  return (
    <div>
      <div className="grid grid-cols-5 gap-2">
        {FP_TILE_ORDER.filter((k) => counts[k] != null).map((k) => (
          <div key={k} className={"rounded-lg px-2 py-1.5 text-center ring-1 " + (k === "ISSUES" ? "bg-rose-50 ring-rose-200" : k === "OUT FOR DELIVERY" ? "bg-emerald-50 ring-emerald-200" : "bg-white ring-violet-200")}>
            <div className="text-[10px] font-semibold tracking-wide text-slate-500 truncate">{k}</div>
            <div className="text-lg font-semibold tabular-nums text-slate-900">{fmtNum(counts[k])}</div>
          </div>
        ))}
      </div>
      {at ? <div className="text-[10px] text-violet-700 mt-1">FreightPOP dashboard totals · live · updated {fmtRelative(at)}</div> : null}
    </div>
  );
}

// Scraped → saved totals for a run. "Saved" counts rows the API confirmed.
function CountsStrip({ counts }: { counts: ScrapeCounts }) {
  const items: [string, number, string][] = [
    ["Scraped", counts.scraped, "text-slate-900"],
    ["Saved to dashboard", counts.saved, "text-emerald-700"],
    ["With changes", counts.changed, "text-sky-700"],
    ["Grid data only", counts.partial, counts.partial ? "text-amber-700" : "text-slate-400"],
    ["Upload errors", counts.uploadErrors, counts.uploadErrors ? "text-rose-700" : "text-slate-400"],
    ["Archived", counts.archived, "text-slate-700"],
  ];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {items.map(([label, n, cls]) => (
        <span key={label} className="text-slate-500">{label} <span className={"font-semibold tabular-nums " + cls}>{fmtNum(n)}</span></span>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-semibold text-slate-900 tabular-nums">{value}</div>
      {sub ? <div className="text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

type Tone = "default" | "success" | "warn" | "danger" | "brand";
const PILL: Record<Tone, string> = {
  default: "bg-slate-50 text-slate-600 ring-slate-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-rose-200",
  brand: "bg-violet-50 text-violet-700 ring-violet-200",
};

function Pill({ tone = "default", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ring-1 ${PILL[tone]}`}>{children}</span>;
}

function StatusPill({ status }: { status: ScrapeRequest["status"] }) {
  const map: Record<ScrapeRequest["status"], [Tone, string]> = {
    pending: ["warn", "Queued"],
    claimed: ["brand", "Running"],
    done: ["success", "Done"],
    error: ["danger", "Failed"],
  };
  const [tone, label] = map[status] || ["default", status];
  return <Pill tone={tone}>{label}</Pill>;
}

function Banner({ tone, children }: { tone: "warn" | "danger"; children: React.ReactNode }) {
  return (
    <div className={"rounded-xl p-3 text-sm flex items-start gap-2 ring-1 " + (tone === "danger" ? "bg-rose-50 ring-rose-200 text-rose-800" : "bg-amber-50 ring-amber-200 text-amber-900")}>
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> <div>{children}</div>
    </div>
  );
}
