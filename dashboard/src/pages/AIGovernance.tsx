import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronRight, X as XIcon, AlertTriangle } from "lucide-react";
import { api, type GovCall, type GovEvent, type GovFeature } from "../lib/api";
import { fmtDateTime, fmtRelative } from "../lib/format";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";

// AI Governance: what FPX's AI is used for, by whom, on which models, at what
// cost — plus the governance trail (prompt / model changes with before →
// after, AI rewrites, previews, human reviews) and every AI call with its
// full prompt and response.

const FEATURE_LABELS: Record<string, string> = {
  per_shipment: "Shipment analysis",
  plain_summary: "Plain-English summary",
  email_draft_carrier: "Email draft → carrier",
  email_draft_customer: "Email draft → customer",
  email_draft_carrier_group: "Group email → carrier",
  email_draft_customer_group: "Group email → customer",
  email_studio_rewrite: "Email Studio · AI rewrite",
  email_studio_preview: "Email Studio · preview",
  daily_summary: "Daily summary",
  task_triage: "Task triage",
  gp: "GP audit",
  invoice: "Invoice audit",
  summary: "Cross-shipment summary",
  priority: "Priority analysis",
};
const featureLabel = (f: string | null) => (f ? FEATURE_LABELS[f] || f.replace(/[._]/g, " ") : "—");

const EVENT_LABELS: Record<string, { label: string; tone: string }> = {
  prompt_change: { label: "Prompt changed", tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  model_change: { label: "Model changed", tone: "bg-sky-50 text-sky-700 ring-sky-200" },
  ai_setting_change: { label: "AI setting changed", tone: "bg-slate-50 text-slate-700 ring-slate-200" },
  logging_change: { label: "Logging changed", tone: "bg-amber-50 text-amber-800 ring-amber-200" },
  ai_rewrite: { label: "AI rewrite (suggested)", tone: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200" },
  ai_preview: { label: "Preview", tone: "bg-slate-50 text-slate-600 ring-slate-200" },
  human_review: { label: "Human review", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

const money = (v: number | string | null | undefined) => {
  const n = Number(v || 0);
  return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
};
const num = (n: number) => n.toLocaleString();

export function AIGovernancePage() {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<{ logging: boolean; features: GovFeature[]; changes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [tab, setTab] = useState<"log" | "calls">("log");
  const [callFilter, setCallFilter] = useState<{ feature?: string; by?: string; user?: string; errors?: string }>({});
  const [logKey, setLogKey] = useState(0);

  const load = useCallback(() => {
    setErr(null);
    api.governance.summary(days).then(setSummary).catch((e) => setErr((e as Error).message));
  }, [days]);
  useEffect(() => { load(); }, [load]);

  async function toggleLogging() {
    if (!summary) return;
    const next = !summary.logging;
    if (!next && !confirm("Turn OFF the AI governance log?\n\nPrompt/model changes, AI rewrites and reviews will stop being recorded (turning it off is itself recorded). AI calls are still logged.")) return;
    setToggling(true);
    try {
      await api.settings.update("ai.governance.logging", next);
      load(); setLogKey((k) => k + 1);
    } catch (e) { alert((e as Error).message); }
    finally { setToggling(false); }
  }

  if (err) return <ErrorBlock>{err} <button onClick={load} className="underline ml-1">Retry</button></ErrorBlock>;
  if (!summary) return <LoadingState />;

  const f = summary.features;
  const tot = {
    calls: f.reduce((a, x) => a + Number(x.calls), 0),
    cost: f.reduce((a, x) => a + Number(x.cost_usd), 0),
    errors: f.reduce((a, x) => a + Number(x.errors), 0),
    system: f.reduce((a, x) => a + Number(x.system_calls), 0),
    reviewed: f.reduce((a, x) => a + Number(x.rated_up) + Number(x.rated_down), 0),
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-violet-600" /> AI Governance</h1>
          <p className="text-sm text-slate-500 mt-0.5">What FPX's AI does, who uses it, which models, what it costs — and every change to how it behaves.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 bg-white">
            <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
          </select>
          <button onClick={toggleLogging} disabled={toggling} role="switch" aria-checked={summary.logging}
            title="Records prompt/model changes (before → after), AI rewrites, previews and human reviews"
            className={"inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg ring-1 " + (summary.logging ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-300")}>
            <span className={"relative inline-block h-5 w-9 rounded-full transition " + (summary.logging ? "bg-emerald-600" : "bg-slate-300")}>
              <span className={"absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all " + (summary.logging ? "left-[18px]" : "left-0.5")} />
            </span>
            Governance logging: {summary.logging ? "Enabled" : "Off"}
          </button>
        </div>
      </div>

      {!summary.logging ? (
        <div className="rounded-xl p-3 text-sm ring-1 bg-amber-50 ring-amber-200 text-amber-900 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" /> Governance logging is off — prompt and model changes are not being recorded. AI calls are still logged below.
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="AI calls" value={num(tot.calls)} sub={`${num(tot.system)} automatic`} />
        <Tile label="AI cost" value={money(tot.cost)} sub={`last ${days} days`} />
        <Tile label="Errors" value={num(tot.errors)} sub={tot.calls ? `${((tot.errors / tot.calls) * 100).toFixed(2)}% of calls` : "—"} warn={tot.errors > 0} />
        <Tile label="Human-reviewed" value={num(tot.reviewed)} sub="👍 / 👎 ratings" />
        <Tile label="Prompt & model changes" value={num(summary.changes)} sub={`last ${days} days`} />
      </div>

      <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">AI feature</th>
              <th className="px-4 py-2 font-medium text-right">Calls</th>
              <th className="px-4 py-2 font-medium text-right">People</th>
              <th className="px-4 py-2 font-medium text-right">Automatic</th>
              <th className="px-4 py-2 font-medium">Models</th>
              <th className="px-4 py-2 font-medium text-right">Cost</th>
              <th className="px-4 py-2 font-medium text-right">Errors</th>
              <th className="px-4 py-2 font-medium text-right">👍 / 👎</th>
              <th className="px-4 py-2 font-medium">Last used</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {f.map((x) => (
              <tr key={x.feature + x.by} className="hover:bg-slate-50 cursor-pointer"
                onClick={() => { setCallFilter({ feature: x.feature, by: x.by }); setTab("calls"); }} title="Show these AI calls">
                <td className="px-4 py-2 font-medium text-slate-800">{featureLabel(x.feature)}</td>
                <td className="px-4 py-2 text-right">{num(Number(x.calls))}</td>
                <td className="px-4 py-2 text-right">{num(Number(x.users))}</td>
                <td className="px-4 py-2 text-right">{num(Number(x.system_calls))}</td>
                <td className="px-4 py-2 text-xs text-slate-600">{(x.models || []).join(", ")}</td>
                <td className="px-4 py-2 text-right">{money(x.cost_usd)}</td>
                <td className={"px-4 py-2 text-right " + (Number(x.errors) ? "text-rose-700" : "")}>{num(Number(x.errors))}</td>
                <td className="px-4 py-2 text-right">{num(Number(x.rated_up))} / {num(Number(x.rated_down))}</td>
                <td className="px-4 py-2 text-slate-500">{fmtRelative(x.last_at)}</td>
              </tr>
            ))}
            {!f.length ? <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400">No AI calls in this period.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {([["log", "Governance log"], ["calls", "AI calls"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={"px-3 py-2 text-sm -mb-px border-b-2 " + (tab === id ? "border-violet-600 text-violet-700 font-medium" : "border-transparent text-slate-600 hover:text-slate-900")}>{label}</button>
        ))}
      </div>
      {tab === "log" ? <GovLog key={logKey} /> : <CallLog filter={callFilter} features={f} onFilter={setCallFilter} />}
    </div>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={"text-xl font-semibold " + (warn ? "text-rose-700" : "text-slate-900")}>{value}</div>
      {sub ? <div className="text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}

const show = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));

function GovLog() {
  const [type, setType] = useState("");
  const [rows, setRows] = useState<GovEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(true);

  const load = useCallback(async (before?: string) => {
    setErr(null);
    try {
      const r = await api.governance.events({ type: type || undefined, limit: 100, before });
      setRows((prev) => (before ? [...(prev || []), ...r.data] : r.data));
      setMore(r.data.length === 100);
    } catch (e) { setErr((e as Error).message); }
  }, [type]);
  useEffect(() => { setRows(null); load(); }, [load]);

  return (
    <div className="space-y-2">
      <select value={type} onChange={(e) => setType(e.target.value)} className="text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 bg-white">
        <option value="">All events</option>
        <option value="prompt_change,model_change,ai_setting_change,logging_change">Prompt / model / setting changes</option>
        {Object.entries(EVENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      {err ? <ErrorBlock>{err}</ErrorBlock> : null}
      {!rows ? <LoadingState /> : (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm divide-y divide-slate-100">
          {rows.map((r) => {
            const ev = EVENT_LABELS[r.event_type] || { label: r.event_type, tone: "bg-slate-50 text-slate-600 ring-slate-200" };
            const hasDiff = r.before != null || r.after != null || r.metadata;
            return (
              <div key={r.id}>
                <button onClick={() => setOpen(open === r.id ? null : r.id)} className="w-full text-left px-4 py-2.5 flex items-start gap-3 hover:bg-slate-50">
                  {hasDiff ? (open === r.id ? <ChevronDown className="h-4 w-4 mt-0.5 text-slate-400" /> : <ChevronRight className="h-4 w-4 mt-0.5 text-slate-400" />) : <span className="w-4" />}
                  <span className={"text-xs px-2 py-0.5 rounded-full ring-1 whitespace-nowrap " + ev.tone}>{ev.label}</span>
                  <span className="flex-1 min-w-0 text-sm text-slate-800">
                    {r.summary || r.setting_key}
                    <span className="block text-xs text-slate-500">{featureLabel(r.feature)}{r.setting_key ? ` · ${r.setting_key}` : ""}</span>
                  </span>
                  <span className="text-xs text-slate-500 text-right whitespace-nowrap">{r.actor_email || r.actor_source || "system"}<span className="block" title={fmtDateTime(r.created_at)}>{fmtRelative(r.created_at)}</span></span>
                </button>
                {open === r.id ? (
                  <div className="px-4 pb-3 grid gap-2 md:grid-cols-2">
                    {r.before != null ? <Block title="Before" text={show(r.before)} /> : null}
                    {r.after != null ? <Block title="After" text={show(r.after)} /> : null}
                    {r.metadata && Object.keys(r.metadata).length ? <Block title="Details" text={show(r.metadata)} /> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {!rows.length ? <div className="px-4 py-6 text-center text-sm text-slate-400">No governance events yet. Prompt and model changes, Email Studio rewrites and previews, and ratings show up here.</div> : null}
          {rows.length && more ? <button onClick={() => load(rows[rows.length - 1].created_at)} className="w-full py-2 text-sm text-violet-700 hover:bg-slate-50">Load more</button> : null}
        </div>
      )}
    </div>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-slate-500 mb-1">{title}</div>
      <pre className="text-xs bg-slate-50 ring-1 ring-slate-200 rounded-lg p-2 whitespace-pre-wrap break-words max-h-80 overflow-auto font-mono">{text || "(empty)"}</pre>
    </div>
  );
}

function CallLog({ filter, features, onFilter }: {
  filter: { feature?: string; by?: string; user?: string; errors?: string };
  features: GovFeature[];
  onFilter: (f: { feature?: string; by?: string; user?: string; errors?: string }) => void;
}) {
  const [rows, setRows] = useState<GovCall[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);

  const load = useCallback(async (before?: string) => {
    setErr(null);
    try {
      const r = await api.governance.calls({ ...filter, limit: 100, before });
      setRows((prev) => (before ? [...(prev || []), ...r.data] : r.data));
      setMore(r.data.length === 100);
    } catch (e) { setErr((e as Error).message); }
  }, [filter]);
  useEffect(() => { setRows(null); load(); }, [load]);

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap items-center">
        <select value={filter.feature ? `${filter.by}|${filter.feature}` : ""}
          onChange={(e) => { const [by, feature] = e.target.value.split("|"); onFilter({ ...filter, feature: feature || undefined, by: feature ? by : undefined }); }}
          className="text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 bg-white">
          <option value="">All features</option>
          {features.map((x) => <option key={x.by + x.feature} value={`${x.by}|${x.feature}`}>{featureLabel(x.feature)}</option>)}
        </select>
        <select value={filter.user || ""} onChange={(e) => onFilter({ ...filter, user: e.target.value || undefined })} className="text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 bg-white">
          <option value="">People + automatic</option>
          <option value="system">Automatic only</option>
        </select>
        <label className="text-sm inline-flex items-center gap-1.5">
          <input type="checkbox" className="accent-violet-600" checked={filter.errors === "1"} onChange={(e) => onFilter({ ...filter, errors: e.target.checked ? "1" : undefined })} /> Errors only
        </label>
      </div>
      {err ? <ErrorBlock>{err}</ErrorBlock> : null}
      {!rows ? <LoadingState /> : (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Feature</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Shipment</th>
                <th className="px-3 py-2 font-medium text-right">Cost</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => {
                const stop = c.metadata?.stop_reason as string | undefined;
                const sub = (c.metadata?.subkind as string | undefined) || c.kind;
                return (
                  <tr key={c.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setDetail(c.id)}>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap" title={fmtDateTime(c.created_at)}>{fmtRelative(c.created_at)}</td>
                    <td className="px-3 py-2">{featureLabel(sub)}</td>
                    <td className="px-3 py-2 text-slate-600">{c.user_email || <span className="text-slate-400">automatic</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{c.model}</td>
                    <td className="px-3 py-2 font-mono text-xs">{c.tracking_number || "—"}</td>
                    <td className="px-3 py-2 text-right">{c.cost_usd != null ? money(c.cost_usd) : "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      {c.error ? <span className="text-rose-700 inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> error</span>
                        : stop === "max_tokens" ? <span className="text-amber-700">cut off</span>
                        : stop === "refusal" ? <span className="text-amber-700">refused</span>
                        : <span className="text-emerald-700">ok</span>}
                      {c.rating ? <span className="ml-1">{c.rating === "up" ? "👍" : "👎"}</span> : null}
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No AI calls match.</td></tr> : null}
            </tbody>
          </table>
          {rows.length && more ? <button onClick={() => load(rows[rows.length - 1].created_at)} className="w-full py-2 text-sm text-violet-700 hover:bg-slate-50 border-t border-slate-100">Load more</button> : null}
        </div>
      )}
      {detail ? <CallDetail id={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}

function CallDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [c, setC] = useState<Awaited<ReturnType<typeof api.governance.call>>["call"] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.governance.call(id).then((r) => setC(r.call)).catch((e) => setErr((e as Error).message)); }, [id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-3xl h-full bg-white shadow-xl overflow-auto p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">AI call</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><XIcon className="h-5 w-5" /></button>
        </div>
        {err ? <ErrorBlock>{err}</ErrorBlock> : !c ? <LoadingState /> : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <span className="text-slate-500">When</span><span>{fmtDateTime(c.created_at)}</span>
              <span className="text-slate-500">Feature</span><span>{featureLabel((c.metadata?.subkind as string) || c.kind)}</span>
              <span className="text-slate-500">Who</span><span>{c.user_email || "automatic"}</span>
              <span className="text-slate-500">Model</span><span>{c.model}</span>
              <span className="text-slate-500">Tokens</span><span>{num(c.input_tokens || 0)} in · {num(c.output_tokens || 0)} out</span>
              <span className="text-slate-500">Cost · time</span><span>{c.cost_usd != null ? money(c.cost_usd) : "—"} · {c.duration_ms != null ? `${(c.duration_ms / 1000).toFixed(1)}s` : "—"}</span>
              <span className="text-slate-500">Stop reason</span><span>{String(c.metadata?.stop_reason || "—")}</span>
              {c.tracking_number ? <><span className="text-slate-500">Shipment</span><span className="font-mono">{c.tracking_number}</span></> : null}
              {c.rating ? <><span className="text-slate-500">Review</span><span>{c.rating === "up" ? "👍" : "👎"} by {c.rated_by}</span></> : null}
            </div>
            {c.error ? <Block title="Error" text={c.error} /> : null}
            <Block title="Instructions (system prompt)" text={c.system_prompt || ""} />
            <Block title="Input" text={c.user_message || ""} />
            <Block title="AI output" text={c.response_text || ""} />
          </>
        )}
      </div>
    </div>
  );
}
