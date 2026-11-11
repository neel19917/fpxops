import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Activity, Globe, MonitorPlay, Database, Sparkles, ListChecks, Search, MessageSquare, Mail, ShieldCheck, TrendingUp, ArrowDown, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { hostedBrowser } from "../lib/hostedBrowser";
import { fmtRelative } from "../lib/format";

// Data Flow: how a shipment moves through FPX — FreightPOP → scrape → AI
// analysis → tasks → search index + embeddings → Ask FPX — with the live
// state of each step. Side outputs (emails, run trends, governance) hang off
// the step that feeds them.

type Pipeline = Awaited<ReturnType<typeof api.governance.pipeline>>;
type Hosted = Awaited<ReturnType<typeof hostedBrowser.pipeline>>;
type Tone = "ok" | "warn" | "busy" | "off";

const TONE: Record<Tone, { dot: string; label: string }> = {
  ok: { dot: "bg-emerald-500", label: "Healthy" },
  busy: { dot: "bg-violet-500 animate-pulse", label: "Running" },
  warn: { dot: "bg-amber-500", label: "Check" },
  off: { dot: "bg-slate-300", label: "No data" },
};

function Step({ icon: Icon, title, what, stats, tone, side }: {
  icon: ComponentType<{ className?: string }>; title: string; what: string;
  stats: { label: string; value: string }[]; tone: Tone;
  side?: { icon: ComponentType<{ className?: string }>; title: string; what: string }[];
}) {
  const t = TONE[tone];
  return (
    <div className="flex flex-col lg:flex-row gap-3 items-stretch">
      <div className="flex-1 rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-4 min-w-0">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 shrink-0 rounded-xl bg-violet-50 ring-1 ring-violet-100 flex items-center justify-center">
            <Icon className="h-5 w-5 text-violet-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-slate-900">{title}</div>
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span className={"h-2 w-2 rounded-full " + t.dot} />{t.label}</span>
            </div>
            <div className="text-sm text-slate-500 mt-0.5">{what}</div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
              {stats.map((s) => (
                <div key={s.label} className="text-sm"><span className="text-slate-500">{s.label}</span> <span className="font-semibold text-slate-900 tabular-nums">{s.value}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {side?.length ? (
        <div className="lg:w-72 shrink-0 flex flex-col gap-2 justify-center">
          {side.map((x) => (
            <div key={x.title} className="flex items-start gap-2 rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-2">
              <span className="text-slate-400 hidden lg:inline">⟶</span>
              <x.icon className="h-4 w-4 mt-0.5 text-slate-500 shrink-0" />
              <div className="min-w-0"><div className="text-sm font-medium text-slate-800">{x.title}</div><div className="text-xs text-slate-500">{x.what}</div></div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pl-6 py-1 text-xs text-slate-400">
      <ArrowDown className="h-4 w-4" /> {label}
    </div>
  );
}

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

export function DataFlowPage() {
  const [p, setP] = useState<Pipeline | null>(null);
  const [h, setH] = useState<Hosted | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState(0);

  const load = useCallback(() => {
    setErr(null);
    api.governance.pipeline().then(setP).catch((e) => setErr((e as Error).message));
    if (hostedBrowser.enabled) hostedBrowser.pipeline().then(setH).catch(() => setH(null));
    setAt(Date.now());
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id); }, [load]);

  const last = h?.scrape.lastRun;
  const idx = h?.assistant?.index;
  const emb = h?.assistant?.embeddings;
  const embeddedPct = p && p.index.rows ? Math.round((p.index.embedded / p.index.rows) * 100) : null;

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Activity className="h-5 w-5 text-violet-600" /> Data Flow</h1>
          <p className="text-sm text-slate-500 mt-0.5">How a shipment moves through FPX, with the live state of each step. Updates every 30s.</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50">
          <RefreshCw className="h-4 w-4" /> Refresh {at ? <span className="text-xs text-slate-400">· {fmtRelative(new Date(at).toISOString())}</span> : null}
        </button>
      </div>
      {err ? <div className="rounded-xl p-3 text-sm ring-1 bg-rose-50 ring-rose-200 text-rose-800">{err}</div> : null}

      <Step icon={Globe} title="FreightPOP" tone="ok"
        what="The source: each rep's FreightPOP dashboard grid (In Transit, Booked, Issues, Out for Delivery)."
        stats={[{ label: "Logins kept alive", value: "renewed before the 12h expiry" }]} />
      <Arrow label="Hosted browser signs in as the rep and opens every shipment (Refresh All)" />

      <Step icon={MonitorPlay} title="Scrape" tone={h?.scrape.running ? "busy" : last ? (last.ok ? "ok" : "warn") : "off"}
        what="Scheduled (6 AM, 11 AM, 1 PM PST) or Refresh all shipments. One scrape at a time."
        stats={[
          { label: "Last run", value: last ? `${fmtRelative(last.finishedAt)} · ${last.ok ? "done" : "failed"}` : "—" },
          { label: "Saved", value: num(last?.saved) },
          { label: "Now", value: h?.scrape.running ? "running" : "idle" },
        ]}
        side={[{ icon: TrendingUp, title: "Run trends", what: "FreightPOP totals + task board saved before / after each run" }]} />
      <Arrow label="Each shipment row is uploaded" />

      <Step icon={Database} title="Shipments database" tone={p ? (p.scraped_24h ? "ok" : "warn") : "off"}
        what="Supabase: every shipment's latest status, ETA, comments, history and notes."
        stats={[{ label: "Updated in 24h", value: num(p?.scraped_24h) }]} />
      <Arrow label="Changed shipments are analyzed" />

      <Step icon={Sparkles} title="AI analysis" tone={p ? (p.analyses_24h ? "ok" : "warn") : "off"}
        what="Claude reads each changed shipment: is action needed, what's the issue, who to contact."
        stats={[{ label: "AI calls in 24h", value: num(p?.analyses_24h) }]}
        side={[{ icon: ShieldCheck, title: "AI Governance", what: "Every AI call, cost, prompt change and review is logged" }]} />
      <Arrow label="Action needed → a task for the rep" />

      <Step icon={ListChecks} title="Tasks" tone={p ? "ok" : "off"}
        what="Carrier / customer follow-ups, storage risk, redelivery, return/claim — assigned and worked on the Tasks board."
        stats={[{ label: "Open tasks", value: num(p?.open_tasks) }]}
        side={[
          { icon: Mail, title: "Email drafts", what: "Single + group emails (Email Studio prompts)" },
          { icon: Activity, title: "Daily exec summary", what: "AI brief of the board and the run trends" },
        ]} />
      <Arrow label="After every scrape (and every 5 min): rebuild the index, embed what changed" />

      <Step icon={Search} title="Search index + embeddings (RAG)"
        tone={emb?.running ? "busy" : p ? (p.index.rows && embeddedPct != null && embeddedPct >= 95 ? "ok" : "warn") : "off"}
        what="One compact record per shipment on the dashboard or with open tasks — searchable by id, keyword, fuzzy name and meaning (gte-small embeddings)."
        stats={[
          { label: "Records", value: num(p?.index.rows) },
          { label: "Embedded", value: p ? `${num(p.index.embedded)}${embeddedPct != null ? ` (${embeddedPct}%)` : ""}` : "—" },
          { label: "Rebuilt", value: p?.index.built_at ? fmtRelative(p.index.built_at) : idx?.at ? fmtRelative(new Date(idx.at).toISOString()) : "—" },
          ...(emb?.running ? [{ label: "Embedding", value: "in progress" }] : []),
          ...(emb?.lastError ? [{ label: "Last error", value: emb.lastError.slice(0, 60) }] : []),
        ]} />
      <Arrow label="Each question searches the index (one query, ~25 ms)" />

      <Step icon={MessageSquare} title="Ask FPX chat" tone={p ? "ok" : "off"}
        what="Answers from the index plus a pre-loaded brief, so most questions take one AI call. Every turn's cost is logged."
        stats={[
          { label: "Chats (30d)", value: num(p?.chat_30d.turns) },
          { label: "People", value: num(p?.chat_30d.people) },
          { label: "Cost (30d)", value: p ? `$${p.chat_30d.cost_usd.toFixed(2)}` : "—" },
          { label: "Avg answer", value: p?.chat_30d.avg_ms ? `${(p.chat_30d.avg_ms / 1000).toFixed(1)}s` : "—" },
        ]} />
    </div>
  );
}
