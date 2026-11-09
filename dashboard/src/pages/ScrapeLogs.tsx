import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Download, RefreshCw, ScrollText } from "lucide-react";
import { hostedBrowser, type ScrapeRun } from "../lib/hostedBrowser";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

// Admin: every scrape the hosted browser ran — manual and scheduled, all
// users — with each run's full saved log. Access is enforced by the hosted
// browser service (admins get everyone's runs; it re-checks per log fetch).

function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ScrapeLogsPage() {
  const [runs, setRuns] = useState<ScrapeRun[]>([]);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [user, setUser] = useState("");
  const [source, setSource] = useState("");
  const [ok, setOk] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string | { error: string }>>({});

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await hostedBrowser.runs({ limit: 200, user, source, ok });
      setRuns(r.runs); setIsAdmin(r.isAdmin);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [user, source, ok]);

  useEffect(() => { load(); }, [load]);

  // People list from the unfiltered view (kept once seen so filtering by one
  // person doesn't empty the dropdown).
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    setPeople((cur) => Array.from(new Set([...cur, ...runs.map((r) => r.user)])).sort());
  }, [runs]);

  async function toggle(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (logs[id] === undefined) {
      try { const text = await hostedBrowser.runLogText(id); setLogs((m) => ({ ...m, [id]: text })); }
      catch (e) { setLogs((m) => ({ ...m, [id]: { error: (e as Error).message } })); }
    }
  }

  const totals = useMemo(() => runs.reduce((t, r) => ({
    runs: t.runs + 1, failed: t.failed + (r.ok ? 0 : 1),
    saved: t.saved + (r.counts?.saved || 0), changed: t.changed + (r.counts?.changed || 0),
  }), { runs: 0, failed: 0, saved: 0, changed: 0 }), [runs]);

  if (!hostedBrowser.enabled) {
    return <div className="text-sm text-slate-500">The hosted browser isn't configured for this dashboard (VITE_FPX_BROWSER_URL).</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-slate-600" /> Scrape logs
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">Every Refresh All run — manual and scheduled — with its full log.</p>
        </div>
        <button onClick={load} disabled={loading}
          className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} /> Refresh
        </button>
      </div>

      {err ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-3 text-sm text-rose-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      ) : null}
      {isAdmin === false ? (
        <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-3 text-sm text-amber-900">
          You're not an admin, so you only see your own runs.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={user} onChange={(e) => setUser(e.target.value)} className="px-2 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white">
          <option value="">Everyone</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className="px-2 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white">
          <option value="">Manual + scheduled</option>
          <option value="manual">Manual</option>
          <option value="schedule">Scheduled</option>
        </select>
        <select value={ok} onChange={(e) => setOk(e.target.value)} className="px-2 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white">
          <option value="">Any result</option>
          <option value="true">Finished</option>
          <option value="false">Failed</option>
        </select>
        <span className="text-xs text-slate-500 ml-auto">
          {fmtNum(totals.runs)} runs · {fmtNum(totals.failed)} failed · {fmtNum(totals.saved)} shipments saved · {fmtNum(totals.changed)} with changes
        </span>
      </div>

      <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
              <th className="px-3 py-2 font-medium w-6" />
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium text-right">Took</th>
              <th className="px-3 py-2 font-medium text-right">Scraped</th>
              <th className="px-3 py-2 font-medium text-right">Saved</th>
              <th className="px-3 py-2 font-medium text-right">Changes</th>
              <th className="px-3 py-2 font-medium text-right">Errors</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && !loading ? (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-500">No runs match.</td></tr>
            ) : null}
            {runs.map((r) => {
              const isOpen = open === r.id;
              const log = logs[r.id];
              return (
                <Fragment key={r.id}>
                  <tr onClick={() => toggle(r.id)} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer align-top">
                    <td className="px-3 py-2 text-slate-400">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                    <td className="px-3 py-2 whitespace-nowrap" title={fmtDateTime(r.startedAt)}>{fmtRelative(r.startedAt)}</td>
                    <td className="px-3 py-2 truncate max-w-[200px]">{r.user}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{r.source === "schedule" ? `Scheduled${r.scheduleName ? ` · ${r.scheduleName}` : ""}` : "Manual"}</td>
                    <td className="px-3 py-2">
                      <span className={"text-[11px] font-semibold px-2 py-0.5 rounded-full ring-1 " + (r.ok ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-rose-50 text-rose-700 ring-rose-200")}>
                        {r.ok ? "Finished" : "Failed"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtDuration(r.durationMs)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.counts?.scraped ?? 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.counts?.saved ?? 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.counts?.changed ?? 0)}</td>
                    <td className={"px-3 py-2 text-right tabular-nums " + (r.counts?.uploadErrors ? "text-rose-700" : "")}>{fmtNum(r.counts?.uploadErrors ?? 0)}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <td />
                      <td colSpan={9} className="px-3 py-3 space-y-2">
                        <div className="text-sm text-slate-800 break-words">{r.note || "—"}</div>
                        <div className="flex items-center justify-between text-xs text-slate-500">
                          <span>{fmtDateTime(r.startedAt)} → {fmtDateTime(r.finishedAt)}</span>
                          <button onClick={(e) => { e.stopPropagation(); hostedBrowser.downloadLog(r.id).catch(() => {}); }}
                            className="inline-flex items-center gap-1 hover:text-slate-900 underline">
                            <Download className="h-3.5 w-3.5" /> Download log
                          </button>
                        </div>
                        <pre className="max-h-96 overflow-auto rounded-lg bg-slate-900 text-slate-200 text-[11px] leading-relaxed p-3 whitespace-pre-wrap break-words">
                          {log === undefined ? "Loading…" : typeof log === "string" ? (log.trim() || "No log saved for this run.") : `Couldn't load log: ${log.error}`}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
