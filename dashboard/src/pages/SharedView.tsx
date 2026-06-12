import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Lock, Package, ReceiptText, Sparkles, TrendingUp, Copy, Check, ExternalLink } from "lucide-react";
import { publicShare } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtPct, fmtUsd } from "../lib/format";
import { ActionBadge } from "../components/Badge";
import type { AiAnalysis, GpAudit, GpAuditRow, InvoiceAudit, InvoiceAuditRow, Shipment } from "../lib/types";

// Default FreightPOP URL the public share page embeds. No public deep-link
// route per shipment, so we drop the recipient on the dashboard with the
// tracking number front-and-center for one-click paste into the grid's
// search. Hardcoded here (rather than fetched from fpx_settings via auth)
// because the share page is intentionally unauthed — keeping this static
// avoids leaking tenant settings to anonymous viewers.
const FREIGHTPOP_PUBLIC_URL = "https://app.freightpop.com/dashboard";

// Same permissions-policy bundle the in-app overlay uses so login flows
// and copy/paste work for whoever opens the share link.
const EMBED_ALLOW = [
  "storage-access *",
  "publickey-credentials-get *",
  "publickey-credentials-create *",
  "clipboard-read *",
  "clipboard-write *",
  "forms *",
  "autoplay *",
  "fullscreen *",
].join("; ");

interface Props { token: string }

export function SharedViewPage({ token }: Props) {
  const [meta, setMeta] = useState<{ label?: string; resource_type: string; requires_password?: boolean; created_at: string } | null>(null);
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // Guard against React StrictMode firing the effect twice in dev — the
  // peek is idempotent but `publicShare.view(token)` is a side-effecting
  // POST that bumps the view counter, so we'd double-increment without
  // this. Keyed by token so a different share link in the same session
  // still records its first view.
  const viewedRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    publicShare.peek(token).then((r) => {
      if (cancelled) return;
      setMeta(r.meta);
      if (r.data) {
        setData(r.data);
        if (viewedRef.current !== token) {
          viewedRef.current = token;
          publicShare.view(token).then(() => {}).catch(() => {});
        }
      }
    }).catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [token]);

  async function submitPassword() {
    setBusy(true); setError(null);
    try {
      const r = await publicShare.view(token, password);
      setData(r.data);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (error) return <FullPageMessage icon={<AlertTriangle className="h-7 w-7" />} title="Link unavailable" subtitle={error} tone="danger" />;
  if (!meta) return <FullPageMessage title="Loading…" />;
  if (meta.requires_password && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl ring-1 ring-slate-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-600"><Lock className="h-5 w-5" /></div>
            <div>
              <h1 className="text-lg font-semibold">{meta.label || "Protected link"}</h1>
              <p className="text-sm text-slate-500">This link is password-protected.</p>
            </div>
          </div>
          <input
            type="password"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitPassword(); }}
          />
          <button
            onClick={submitPassword}
            disabled={busy || !password}
            className="mt-4 w-full px-4 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Checking…" : "View"}
          </button>
          {error ? <div className="mt-3 text-sm text-rose-600">{error}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-[1200px] mx-auto px-6 py-3 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center">
            <Package className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold">{meta.label || formatType(meta.resource_type)}</div>
            <div className="text-xs text-slate-500">Shared via FPX Control Station · {fmtDateTime(meta.created_at)}</div>
          </div>
        </div>
      </header>
      <main className="max-w-[1200px] mx-auto p-6">
        {meta.resource_type === "shipment"      && <SharedShipment data={data as { shipment: Shipment; analyses: AiAnalysis[] }} />}
        {meta.resource_type === "gp_audit"      && <SharedGp data={data as { run: GpAudit; rows: GpAuditRow[] }} />}
        {meta.resource_type === "invoice_audit" && <SharedInv data={data as { run: InvoiceAudit; rows: InvoiceAuditRow[] }} />}
        {meta.resource_type === "analysis"      && <SharedAnalysis data={data as { analysis: AiAnalysis }} />}
      </main>
    </div>
  );
}

function FullPageMessage({ icon, title, subtitle, tone }: { icon?: React.ReactNode; title: string; subtitle?: string; tone?: "danger" }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl ring-1 ring-slate-200 p-8 text-center">
        {icon ? <div className={"mx-auto h-14 w-14 rounded-2xl flex items-center justify-center mb-4 " + (tone === "danger" ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-500")}>{icon}</div> : null}
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle ? <p className="text-sm text-slate-500 mt-1">{subtitle}</p> : null}
      </div>
    </div>
  );
}

function formatType(t: string) {
  if (t === "gp_audit") return "GP Audit";
  if (t === "invoice_audit") return "Invoice Audit";
  return t.replace(/_/g, " ");
}

function SharedShipment({ data }: { data: { shipment: Shipment; analyses: AiAnalysis[] } }) {
  const s = data.shipment;
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Tracking number</div>
            <div className="text-xl font-semibold">{s.tracking_number || "—"}</div>
          </div>
          <ActionBadge action={s.action_required} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <Stat label="Customer" value={s.customer_name} />
          <Stat label="Carrier" value={s.carrier_name || s.carrier} />
          <Stat label="Mode" value={s.mode} />
          <Stat label="Status" value={s.shipment_status} />
          <Stat label="Pickup" value={fmtDate(s.pickup_date)} />
          <Stat label="Delivery" value={fmtDate(s.delivery_date)} />
          <Stat label="Origin" value={s.ship_from || s.origin} />
          <Stat label="Destination" value={s.ship_to || s.destination} />
          <Stat label="Signed by" value={s.signed_by} />
        </div>
        {s.ai_issue || s.ai_recommendation ? (
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-4">
            <h3 className="text-sm font-semibold flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-sky-500" /> AI summary</h3>
            <div className="mt-2 text-sm"><b className="text-slate-700">Issue:</b> {s.ai_issue || "—"}</div>
            <div className="mt-1 text-sm"><b className="text-slate-700">Recommendation:</b> {s.ai_recommendation || "—"}</div>
          </div>
        ) : null}
        {data.analyses.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold mb-2">Analysis history ({data.analyses.length})</h3>
            <div className="space-y-2">
              {data.analyses.map((a) => (
                <div key={a.id} className="rounded-lg bg-slate-50 ring-1 ring-slate-200 p-3 text-sm">
                  <div className="text-xs text-slate-500 mb-0.5">{fmtDateTime(a.created_at)} · {a.model}</div>
                  {a.issue && <div><b>Issue:</b> {a.issue}</div>}
                  {a.recommendation && <div><b>Rec:</b> {a.recommendation}</div>}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <SharedFreightPopEmbed shipment={s} />
    </div>
  );
}

// FreightPOP embed for the public share page. The recipient is typically
// not an FPX rep, so the Chrome-extension bridge that drives the in-app
// overlay's auto-filter doesn't apply here. We surface the tracking
// number prominently for paste-into-search and let the iframe load the
// generic FreightPOP dashboard. Collapsed by default — the recipient
// opts in via the toggle, so the iframe's third-party-cookie probe
// doesn't fire on every share-link open.
function SharedFreightPopEmbed({ shipment }: { shipment: Shipment }) {
  const tracking = shipment.tracking_number || "";
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyTracking() {
    if (!tracking) return;
    try {
      await navigator.clipboard.writeText(tracking);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — no-op */ }
  }

  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Package className="h-4 w-4 text-sky-600" /> Track this shipment in FreightPOP
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Open the live FreightPOP grid below (sign-in required) and paste the tracking number to jump to this shipment.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tracking ? (
            <button
              onClick={copyTracking}
              className="text-xs px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
              title="Copy tracking number"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : `Copy ${tracking}`}
            </button>
          ) : null}
          <a
            href={FREIGHTPOP_PUBLIC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" /> New tab
          </a>
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 inline-flex items-center gap-1.5"
            aria-pressed={open}
          >
            {open ? "Hide embed" : "Show embed"}
          </button>
        </div>
      </div>
      {open ? (
        <div className="border-t border-slate-200 bg-slate-50 px-3 pt-3 pb-3 sm:px-6 sm:pb-6">
          {tracking ? (
            <div className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 mb-3 flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 shrink-0">Tracking #</span>
              <span className="font-mono text-sm font-semibold text-slate-900 truncate flex-1">{tracking}</span>
              <button
                onClick={copyTracking}
                className="inline-flex items-center gap-1 text-[11px] text-sky-700 hover:text-sky-900 px-1.5 py-0.5 rounded hover:bg-sky-50"
                title="Copy tracking number"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : null}
          <div className="rounded-lg ring-1 ring-slate-200 overflow-hidden bg-white" style={{ height: "70vh" }}>
            <iframe
              src={FREIGHTPOP_PUBLIC_URL}
              className="w-full h-full block"
              title="FreightPOP shipment view"
              allow={EMBED_ALLOW}
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
          <p className="text-[11px] text-slate-500 mt-2 leading-snug">
            FreightPOP doesn't expose a deep-link URL per shipment — paste the tracking number above into the grid's search to jump
            to this shipment. If the panel is blank, FreightPOP is blocking iframe embedding for this origin
            (X-Frame-Options / CSP); use the <span className="font-medium">New tab</span> link instead.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm">{value || "—"}</div>
    </div>
  );
}

function SharedGp({ data }: { data: { run: GpAudit; rows: GpAuditRow[] } }) {
  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
      <h2 className="text-lg font-semibold flex items-center gap-2"><TrendingUp className="h-5 w-5 text-emerald-600" /> GP Audit</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3 text-sm">
        <Stat label="Date range" value={`${fmtDate(data.run.date_from)} → ${fmtDate(data.run.date_to)}`} />
        <Stat label="Rows" value={fmtNum(data.run.total_rows)} />
        <Stat label="Outliers" value={fmtNum(data.run.outlier_count)} />
        <Stat label="Mean GP%" value={fmtPct(data.run.mean_gp_pct)} />
      </div>
      {data.run.exec_summary ? (
        <pre className="mt-4 text-xs bg-slate-50 ring-1 ring-slate-200 p-3 rounded-lg whitespace-pre-wrap">{data.run.exec_summary}</pre>
      ) : null}
      <h3 className="text-sm font-semibold mt-5 mb-2">Rows ({data.rows.length})</h3>
      <div className="divide-y divide-slate-100">
        {data.rows.map((r) => (
          <div key={r.id} className="py-2 text-sm flex justify-between">
            <div>{r.customer_name || r.shipment_id}</div>
            <div className="text-slate-500">GP {r.gross_profit ?? "—"} · {fmtPct(r.gp_pct)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SharedInv({ data }: { data: { run: InvoiceAudit; rows: InvoiceAuditRow[] } }) {
  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
      <h2 className="text-lg font-semibold flex items-center gap-2"><ReceiptText className="h-5 w-5 text-amber-600" /> Invoice Audit</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3 text-sm">
        <Stat label="Date range" value={`${fmtDate(data.run.date_from)} → ${fmtDate(data.run.date_to)}`} />
        <Stat label="Match" value={fmtNum(data.run.match_count)} />
        <Stat label="Discrepancy" value={fmtNum(data.run.discrepancy_count)} />
        <Stat label="Unmatched" value={fmtNum(data.run.unmatched_count)} />
      </div>
      {data.run.exec_summary ? (
        <pre className="mt-4 text-xs bg-slate-50 ring-1 ring-slate-200 p-3 rounded-lg whitespace-pre-wrap">{data.run.exec_summary}</pre>
      ) : null}
      <h3 className="text-sm font-semibold mt-5 mb-2">Rows ({data.rows.length})</h3>
      <div className="divide-y divide-slate-100">
        {data.rows.map((r) => (
          <div key={r.id} className="py-2 text-sm flex justify-between">
            <div>{r.shipment_id} <span className="text-slate-500">· {r.status}</span></div>
            <div className="text-slate-500">bill ${r.bill_amount ?? 0} / cost ${r.shipment_cost ?? 0} · Δ ${r.difference ?? 0}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SharedAnalysis({ data }: { data: { analysis: AiAnalysis } }) {
  const a = data.analysis;
  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6 space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2"><Sparkles className="h-5 w-5 text-sky-600" /> AI analysis</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <Stat label="When" value={fmtDateTime(a.created_at)} />
        <Stat label="Model" value={a.model} />
        <Stat label="Tokens (in/out)" value={`${a.input_tokens ?? 0} / ${a.output_tokens ?? 0}`} />
        <Stat label="Cost" value={fmtUsd(a.cost_usd)} />
      </div>
      {a.issue ? <div><b>Issue:</b> {a.issue}</div> : null}
      {a.recommendation ? <div><b>Recommendation:</b> {a.recommendation}</div> : null}
      <pre className="text-xs bg-slate-900 text-slate-100 p-3 rounded-lg whitespace-pre-wrap max-h-96 overflow-auto">{a.response_text || ""}</pre>
    </div>
  );
}
