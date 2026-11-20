import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, Loader2, Play, RefreshCw, XCircle } from "lucide-react";
import { apiUrl, getAccessTokenOrWait } from "../lib/api";
import { impersonateHeaders } from "../lib/impersonate";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

// "Is FreightPOP data flowing into FPX?" One row per data set from
// GET /api/ops/lookback, plus a small form that queues a lookback
// (POST /api/ops/lookback) with the signed-in person's FreightPOP login.

export interface FlowJobResult {
  at: string;
  by: string | null;
  rows?: number | null;
  note: string | null;
  id: string;
  via: "request" | "run" | "schedule";
}

export interface FlowActiveJob {
  request_id: string;
  status: "pending" | "claimed";
  requested_by: string | null;
  requested_at: string;
  claimed_at: string | null;
  note: string | null;
}

export interface FlowDataset {
  key: "tracking" | "erp_transactions" | "audit_approvals" | "shipment_details";
  label: string;
  newest_data_at: string | null;
  age_hours: number | null;
  threshold_hours: number;
  stale: boolean;
  stale_reason: string | null;
  failing: boolean;
  last_success: FlowJobResult | null;
  last_failure: FlowJobResult | null;
  active: FlowActiveJob[];
}

export interface FlowHealth {
  generated_at: string;
  ok: boolean;
  thresholds_hours: Record<string, number>;
  datasets: FlowDataset[];
  warnings?: string[];
}

type LookbackJob = "erp" | "shipment_details" | "tracking";
type ShipmentType = "non-parcel" | "parcel" | "both";

interface LookbackResult {
  run_as: string;
  run_as_source: string;
  queued: { job: string; request_id: string; coalesced: boolean; scope: string; status: string }[];
  skipped: { job: string; reason: string }[];
}

const PATH = "/api/ops/lookback";
const TIMEOUT_MS = 20_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// api.ts keeps its `request` private, so this mirrors its headers, deadline
// and error wording for the two calls this panel makes.
async function flowFetch<T>(init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  const token = await getAccessTokenOrWait();
  let resp: Response;
  try {
    resp = await fetch(`${apiUrl}${PATH}`, {
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...impersonateHeaders(),
      },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`Request timed out after ${TIMEOUT_MS / 1000}s: ${PATH}`);
    }
    throw e;
  }
  if (!resp.ok) {
    const text = await resp.text();
    let message = `${resp.status}: ${text.slice(0, 200)}`;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body?.error === "string" && body.error) message = body.error;
    } catch { /* not JSON: keep "<status>: <text>" */ }
    throw new HttpError(resp.status, message);
  }
  return resp.json() as Promise<T>;
}

const JOB_LABELS: Record<string, string> = {
  erp: "ERP transactions",
  shipment_details: "Shipment details",
  tracking: "Tracking scrape",
};
const jobLabel = (job: string) => JOB_LABELS[job] || job;

const SHIPMENT_TYPES: { value: ShipmentType; label: string }[] = [
  { value: "non-parcel", label: "Non-parcel" },
  { value: "parcel", label: "Parcel" },
  { value: "both", label: "Both" },
];

function exact(iso: string | null | undefined): string | undefined {
  return iso ? fmtDateTime(iso) : undefined;
}

type LoadError = { kind: "missing" } | { kind: "error"; text: string };

export function DataFlowHealth({ className, compact = false, pollMs = 60_000 }: {
  className?: string;
  compact?: boolean;
  pollMs?: number;
}) {
  const [data, setData] = useState<FlowHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [result, setResult] = useState<LookbackResult | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setRefreshing(true);
    try {
      const next = await flowFetch<FlowHealth>();
      if (!alive.current || mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      setError(e instanceof HttpError && e.status === 404
        ? { kind: "missing" }
        : { kind: "error", text: (e as Error).message || "Could not load data flow status." });
    } finally {
      if (alive.current && mine === seq.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  // Load on mount, then poll while the tab is visible. Coming back to the tab
  // refetches straight away so the panel is never a stale minute behind.
  useEffect(() => {
    alive.current = true;
    void load();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => {
      stop();
      if (pollMs > 0) timer = setInterval(() => { if (!document.hidden) void load(); }, pollMs);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else { void load(); start(); }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, pollMs]);

  const datasets = data?.datasets ?? [];
  const attention = datasets.filter((d) => d.stale || d.failing).length;
  const warnings = (data?.warnings ?? []).filter(Boolean);

  return (
    <section className={"rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm space-y-3 " + (compact ? "p-4" : "p-5") + (className ? " " + className : "")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-2">
            <Activity className="h-4 w-4 text-slate-500" /> Data flow
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            {data ? (
              attention === 0 ? (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" /> All current
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" /> {attention} need{attention === 1 ? "s" : ""} attention
                </span>
              )
            ) : null}
            {data ? <span title={exact(data.generated_at)}>checked {fmtRelative(data.generated_at)}</span> : null}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {data && !formOpen ? (
            <button onClick={() => { setFormOpen(true); setResult(null); }}
              className="text-xs px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 inline-flex items-center gap-1">
              <Play className="h-3.5 w-3.5" /> Run lookback now
            </button>
          ) : null}
          <button onClick={() => void load()} disabled={refreshing} title="Refresh" aria-label="Refresh data flow status"
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40">
            <RefreshCw className={"h-3.5 w-3.5" + (refreshing ? " animate-spin" : "")} />
          </button>
        </div>
      </div>

      {error?.kind === "missing" ? (
        <div className="text-xs text-slate-500">Data flow status isn't available on this server yet.</div>
      ) : error ? (
        <div role="alert" className="text-xs rounded-lg px-3 py-2 ring-1 bg-rose-50 ring-rose-200 text-rose-800 flex items-start justify-between gap-3">
          <span className="min-w-0 break-words">
            Couldn't {data ? "refresh" : "load"} data flow status: {error.text}
            {data ? " Showing the last result." : ""}
          </span>
          <button onClick={() => void load()} disabled={refreshing} className="shrink-0 font-medium underline hover:no-underline disabled:opacity-50">
            Retry
          </button>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="text-sm text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking data flow…
        </div>
      ) : null}

      {formOpen ? (
        <LookbackForm
          onCancel={() => setFormOpen(false)}
          onQueued={(r) => { setResult(r); setFormOpen(false); void load(); }}
        />
      ) : null}

      {result ? <LookbackOutcome result={result} onDismiss={() => setResult(null)} /> : null}

      {data && datasets.length === 0 ? (
        <div className="text-sm text-slate-500">No data sets reported.</div>
      ) : null}

      {datasets.length ? (
        <ul className="divide-y divide-slate-100">
          {datasets.map((d) => <DatasetRow key={d.key} d={d} compact={compact} />)}
        </ul>
      ) : null}

      {warnings.length ? (
        <p className="text-[11px] text-slate-400">{warnings.join(" · ")}</p>
      ) : null}
    </section>
  );
}

function DatasetRow({ d, compact }: { d: FlowDataset; compact: boolean }) {
  const running = d.active.filter((a) => a.status === "claimed");
  const pending = d.active.filter((a) => a.status === "pending");
  const fail = d.failing ? d.last_failure : null;
  const ok = d.last_success;
  const readOnly = d.key === "audit_approvals";

  return (
    <li className={"flex items-start justify-between gap-3 " + (compact ? "py-2" : "py-3")}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-900">
          <span className="font-medium">{d.label}</span>
          <span className="text-slate-500" title={exact(d.newest_data_at)}>
            {" · "}{d.newest_data_at ? `data arrived ${fmtRelative(d.newest_data_at)}` : "no data received yet"}
          </span>
        </div>
        <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {fail ? (
            <span className="inline-flex items-center gap-1 text-rose-700 min-w-0 max-w-full" title={fail.note || undefined}>
              <XCircle className="h-3 w-3 shrink-0" />
              <span className="shrink-0">Last run failed {fmtRelative(fail.at)}</span>
              {fail.note ? <span className={"truncate " + (compact ? "max-w-[12rem]" : "max-w-[28rem]")}>· {fail.note}</span> : null}
            </span>
          ) : d.failing ? (
            <span className="inline-flex items-center gap-1 text-rose-700">
              <XCircle className="h-3 w-3" /> Last run failed
            </span>
          ) : null}
          {ok ? (
            <span className={"inline-flex items-center gap-1 " + (d.failing ? "" : "text-emerald-700")} title={exact(ok.at)}>
              {d.failing ? null : <CheckCircle2 className="h-3 w-3" />}
              Last {d.failing ? "success" : "ran"} {fmtRelative(ok.at)}
              {ok.rows != null ? ` · ${fmtNum(ok.rows)} rows` : ""}
              {!compact && ok.by ? <span className="text-slate-500"> · {ok.by}</span> : null}
            </span>
          ) : !d.failing ? (
            <span>No completed run yet</span>
          ) : null}
          {!compact && fail?.by ? <span>by {fail.by}</span> : null}
          {!compact && readOnly ? <span>Refreshed by the daily invoicing run</span> : null}
        </div>
        {d.stale && d.stale_reason ? (
          <div className={"mt-1 text-xs inline-flex items-start gap-1 rounded px-1.5 py-0.5 ring-1 " + (d.failing ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200")}>
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {d.stale_reason}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1">
        {d.stale ? (
          <Chip tone={d.failing ? "rose" : "amber"} title={d.stale_reason || undefined}>
            <AlertTriangle className="h-3 w-3" /> Stale
          </Chip>
        ) : d.failing ? (
          <Chip tone="rose" title={fail?.note || undefined}><XCircle className="h-3 w-3" /> Failing</Chip>
        ) : (
          <Chip tone="emerald"><CheckCircle2 className="h-3 w-3" /> Current</Chip>
        )}
        {running.length ? (
          <Chip tone="violet" title={activeTitle(running)}>
            <Loader2 className="h-3 w-3 animate-spin" /> Running
          </Chip>
        ) : null}
        {pending.length ? (
          <Chip tone="slate" title={activeTitle(pending)}>
            <Clock className="h-3 w-3" /> Queued{pending.length > 1 ? ` (${pending.length})` : ""}
          </Chip>
        ) : null}
      </div>
    </li>
  );
}

function activeTitle(jobs: FlowActiveJob[]): string {
  return jobs.map((a) => {
    const when = a.status === "claimed" && a.claimed_at ? `started ${fmtRelative(a.claimed_at)}` : `requested ${fmtRelative(a.requested_at)}`;
    return [when, a.requested_by ? `by ${a.requested_by}` : null, a.note].filter(Boolean).join(" · ");
  }).join("\n");
}

const CHIP_TONES = {
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  slate: "bg-slate-50 text-slate-600 ring-slate-200",
} as const;

function Chip({ tone, title, children }: { tone: keyof typeof CHIP_TONES; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={"text-[11px] px-1.5 py-0.5 rounded ring-1 inline-flex items-center gap-1 whitespace-nowrap " + CHIP_TONES[tone]}>
      {children}
    </span>
  );
}

function LookbackForm({ onCancel, onQueued }: { onCancel: () => void; onQueued: (r: LookbackResult) => void }) {
  const [months, setMonths] = useState(1);
  const [shipmentType, setShipmentType] = useState<ShipmentType>("non-parcel");
  const [details, setDetails] = useState(false);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setPosting(true); setErr(null);
    const jobs: LookbackJob[] = details ? ["erp", "shipment_details"] : ["erp"];
    try {
      const r = await flowFetch<LookbackResult>({
        method: "POST",
        body: { jobs, months: Math.min(12, Math.max(1, Math.round(months) || 1)), shipment_type: shipmentType },
      });
      onQueued(r);
    } catch (e) {
      setErr(e instanceof HttpError && e.status === 404
        ? "Lookbacks can't be started from this server yet."
        : (e as Error).message || "Could not queue the lookback.");
      setPosting(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-4 space-y-3">
      <p className="text-xs text-slate-500">
        Pulls FreightPOP's Transactions History Report again for the months you choose, using your FreightPOP login.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-[11px] uppercase font-semibold text-slate-500">Months back</span>
          <input type="number" min={1} max={12} step={1} value={months} disabled={posting}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="mt-1 block w-20 text-sm px-2 py-1.5 rounded border border-slate-200 bg-white" />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase font-semibold text-slate-500">Shipment type</span>
          <select value={shipmentType} disabled={posting} onChange={(e) => setShipmentType(e.target.value as ShipmentType)}
            className="mt-1 block text-sm px-2 py-1.5 rounded border border-slate-200 bg-white">
            {SHIPMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={details} disabled={posting} onChange={(e) => setDetails(e.target.checked)}
          className="mt-0.5 rounded border-slate-300 text-violet-600" />
        <span>
          Also re-read shipment details
          <span className="block text-xs text-slate-500">Opens every tracked shipment's details page again. This takes longer.</span>
        </span>
      </label>
      {err ? <div role="alert" className="text-xs text-rose-700 break-words">{err}</div> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={posting} className="text-sm px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={posting}
          className="text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5">
          {posting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {posting ? "Queuing…" : "Run lookback"}
        </button>
      </div>
    </form>
  );
}

function LookbackOutcome({ result, onDismiss }: { result: LookbackResult; onDismiss: () => void }) {
  const fresh = result.queued.filter((q) => !q.coalesced);
  const already = result.queued.filter((q) => q.coalesced);
  const nothingQueued = result.queued.length === 0;
  return (
    <div role="status" className={"text-xs rounded-lg px-3 py-2 ring-1 flex items-start justify-between gap-3 " + (nothingQueued ? "bg-amber-50 ring-amber-200 text-amber-800" : "bg-emerald-50 ring-emerald-200 text-emerald-800")}>
      <div className="min-w-0 space-y-0.5">
        {fresh.length ? (
          <div>Queued: {fresh.map((q) => jobLabel(q.job)).join(", ")}. {fresh.length === 1 ? "It starts" : "They start"} as soon as the service is free.</div>
        ) : null}
        {already.length ? (
          <div>Already queued or running: {already.map((q) => jobLabel(q.job)).join(", ")}. Nothing new was added for {already.length === 1 ? "it" : "them"}.</div>
        ) : null}
        {result.skipped.map((s, i) => (
          <div key={i} className="text-amber-800">Skipped {jobLabel(s.job)}: {s.reason}</div>
        ))}
        {nothingQueued && result.skipped.length === 0 ? <div>Nothing was queued.</div> : null}
        {result.run_as && !nothingQueued ? <div className="opacity-80">Runs with the FreightPOP login for {result.run_as}.</div> : null}
      </div>
      <button onClick={onDismiss} className="shrink-0 underline hover:no-underline">Dismiss</button>
    </div>
  );
}
