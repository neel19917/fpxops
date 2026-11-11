import { useCallback, useEffect, useState } from "react";
import { Sparkles, Copy, Check, KeyRound, ShieldCheck, Trash2, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { fmtRelative } from "../lib/format";

// Connect Claude: each person makes their own read-only FPX connector for
// Claude (claude.ai / the Claude desktop app). The URL carries their personal
// key — shown once; making a new one revokes the old.

const TOOLS = [
  ["search_shipments", "Find shipments by number, customer, carrier, place or a described problem"],
  ["get_shipment", "Everything about one shipment — status, ETA, AI issue, tasks, latest note"],
  ["focus_list", "Open tasks ranked by urgency — what to work on"],
  ["dashboard_summary", "Shipments on the FreightPOP dashboard by status and carrier"],
  ["task_board", "The Tasks board in numbers — segments, health flags, owners"],
  ["list_tasks", "Active tasks filtered by segment, flag, owner or carrier"],
  ["run_trends", "FreightPOP totals and the task board before / after each scrape run"],
];

export function ConnectClaudePage() {
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.me.connector>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => { api.me.connector().then(setSt).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    if (st?.active && !confirm("Make a new connector URL? Your current one stops working — you'll paste the new URL into Claude.")) return;
    setBusy(true); setErr(null);
    try { const r = await api.me.createConnector(); setMade({ url: r.url }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function revoke() {
    if (!confirm("Disconnect Claude? Your connector URL stops working right away.")) return;
    setBusy(true); setErr(null);
    try { await api.me.revokeConnector(); setMade(null); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function copy() {
    if (!made) return;
    try { await navigator.clipboard.writeText(made.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2"><Sparkles className="h-5 w-5 text-violet-600" /> Connect Claude</h1>
        <p className="text-sm text-slate-500 mt-0.5">Ask Claude about your shipments and tasks from claude.ai or the Claude desktop app. Read-only — Claude can look things up in FPX but can't change anything.</p>
      </div>
      {err ? <div className="rounded-xl p-3 text-sm ring-1 bg-rose-50 ring-rose-200 text-rose-800">{err}</div> : null}

      <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-violet-600" />
            <div className="font-medium text-slate-900">Your connector</div>
            {st ? (st.active
              ? <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Active · {st.key_prefix}… · {st.last_used_at ? `last used ${fmtRelative(st.last_used_at)}` : "not used yet"}</span>
              : <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 ring-1 ring-slate-200">Not set up</span>) : null}
          </div>
          <div className="flex items-center gap-2">
            {st?.active ? (
              <button onClick={revoke} disabled={busy} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-rose-200 text-rose-700 bg-white hover:bg-rose-50 disabled:opacity-50">
                <Trash2 className="h-4 w-4" /> Disconnect
              </button>
            ) : null}
            <button onClick={create} disabled={busy} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
              <Sparkles className="h-4 w-4" /> {st?.active ? "Make a new URL" : "Create my connector URL"}
            </button>
          </div>
        </div>

        {made ? (
          <div className="rounded-xl bg-violet-50 ring-1 ring-violet-200 p-3 space-y-2">
            <div className="text-sm font-medium text-violet-900">Your connector URL — copy it now, it's shown only once</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-xs bg-white ring-1 ring-violet-200 rounded-lg px-2 py-1.5">{made.url}</code>
              <button onClick={copy} className="inline-flex items-center gap-1 text-sm px-2.5 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700">
                {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
              </button>
            </div>
            <div className="text-xs text-violet-900 flex items-start gap-1.5"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> Treat it like a password: anyone with this URL can read FPX shipment data as you. Don't share it; make a new one if it leaks.</div>
          </div>
        ) : null}

        <ol className="text-sm text-slate-700 list-decimal list-inside space-y-1">
          <li>Click <b>Create my connector URL</b> and copy it.</li>
          <li>In Claude (claude.ai or the desktop app): <b>Settings → Connectors → Add custom connector</b>.</li>
          <li>Name it <b>FPX</b>, paste the URL, and click <b>Add</b>.</li>
          <li>In a chat, turn on <b>FPX</b> from the tools menu and ask, e.g. <i>"What should Victor focus on today?"</i> or <i>"Which ABF shipments are stuck at a terminal?"</i></li>
        </ol>
      </section>

      <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5">
        <div className="font-medium text-slate-900 mb-2 flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600" /> What Claude can do (read-only)</div>
        <ul className="divide-y divide-slate-100">
          {TOOLS.map(([name, what]) => (
            <li key={name} className="py-1.5 flex gap-3 text-sm">
              <code className="text-xs text-violet-700 w-40 shrink-0 pt-0.5">{name}</code>
              <span className="text-slate-600">{what}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500 mt-3">Every lookup is recorded in AI Governance under your name. The URL only works for this connector — not for the rest of FPX — and stops working if your account is disabled.</p>
      </section>
    </div>
  );
}
