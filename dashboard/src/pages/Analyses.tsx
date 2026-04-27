import { useEffect, useMemo, useState } from "react";
import { Sparkles, Coins, Gauge, ArrowDownToLine, ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime, fmtNum, fmtRelative, fmtUsd } from "../lib/format";
import type { AiAnalysis } from "../lib/types";
import { KindBadge } from "../components/Badge";
import { KPI } from "../components/KPI";
import { Drawer, Field, Section } from "../components/Drawer";
import { useNav } from "../lib/nav";

export function AnalysesPage() {
  const nav = useNav();
  const [rows, setRows] = useState<AiAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<AiAnalysis | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.analyses.list({ limit: 2000, kind: kind || undefined });
      setRows(r.data);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [kind]);

  const filtered = useMemo(() => {
    if (!q) return rows;
    const s = q.toLowerCase();
    return rows.filter((r) =>
      [r.tracking_number, r.issue, r.recommendation, r.response_text, r.model]
        .map((x) => (x || "").toLowerCase()).join(" ").includes(s));
  }, [rows, q]);

  const totals = useMemo(() => {
    const cost = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const inTok = rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
    const outTok = rows.reduce((s, r) => s + (r.output_tokens || 0), 0);
    const avgMs = rows.length ? Math.round(rows.reduce((s, r) => s + (r.duration_ms || 0), 0) / rows.length) : 0;
    return { cost, inTok, outTok, avgMs };
  }, [rows]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Analyses" value={rows.length} icon={Sparkles} tone="brand" />
        <KPI label="Total cost" value={`$${totals.cost.toFixed(4)}`} icon={Coins} tone="warn" />
        <KPI label="Tokens (in/out)" value={`${fmtNum(totals.inTok)} / ${fmtNum(totals.outTok)}`} icon={ArrowDownToLine} />
        <KPI label="Avg latency" value={`${totals.avgMs} ms`} icon={Gauge} />
      </div>

      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-100 flex gap-2">
          <input
            className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm"
            placeholder="Search tracking, issue, recommendation…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All kinds</option>
            <option value="per_shipment">Per-shipment</option>
            <option value="summary">Summary</option>
            <option value="gp_audit">GP audit</option>
            <option value="invoice_audit">Invoice audit</option>
            <option value="other">Other</option>
          </select>
          <button onClick={load} className="px-3 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800">Refresh</button>
        </div>
        {err ? <div className="p-4 bg-rose-50 text-rose-800 border-b border-rose-200 text-sm">{err}</div> : null}
        <div className="overflow-auto max-h-[calc(100vh-340px)]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 sticky top-0">
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Tracking</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Issue</th>
                <th className="px-4 py-2.5 font-medium text-right">Cost</th>
                <th className="px-4 py-2.5 font-medium text-right">Tokens</th>
                <th className="px-4 py-2.5 font-medium text-right w-12">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={8} className="p-8 text-center text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="p-8 text-center text-slate-500">No analyses yet. Run the extension to populate.</td></tr>
              ) : filtered.map((a) => (
                <tr key={a.id} className="hover:bg-sky-50/50 cursor-pointer" onClick={() => setSelected(a)}>
                  <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{fmtRelative(a.created_at)}</td>
                  <td className="px-4 py-2.5"><KindBadge kind={a.kind} /></td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {a.shipment_uuid ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); nav.openShipment(a.shipment_uuid as string); }}
                        className="text-sky-700 hover:text-sky-900 hover:underline font-medium"
                        title="Open this shipment in the Tracking tab"
                      >
                        {a.tracking_number || "(no tracking #)"}
                      </button>
                    ) : (a.tracking_number || "—")}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 text-xs">{a.model}</td>
                  <td className="px-4 py-2.5 max-w-[360px] truncate">{a.issue || "—"}</td>
                  <td className="px-4 py-2.5 text-right font-variant-numeric:tabular-nums">{fmtUsd(a.cost_usd)}</td>
                  <td className="px-4 py-2.5 text-right text-slate-500">{a.input_tokens ?? 0}/{a.output_tokens ?? 0}</td>
                  <td className="px-4 py-2.5 text-right">
                    {a.shipment_uuid ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); nav.openShipment(a.shipment_uuid as string); }}
                        className="p-1.5 text-slate-400 hover:text-sky-700 hover:bg-sky-50 rounded-md"
                        title="Open shipment drawer"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.kind} · ${selected.tracking_number || ""}` : ""}
        subtitle={selected ? fmtDateTime(selected.created_at) : undefined}
      >
        {selected ? (
          <>
            {selected.shipment_uuid ? (
              <div className="flex justify-end mb-4">
                <button
                  onClick={() => { nav.openShipment(selected.shipment_uuid as string); setSelected(null); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
                >
                  <ExternalLink className="h-4 w-4" /> View shipment
                </button>
              </div>
            ) : null}
            <Section title="Summary">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Model">{selected.model}</Field>
                <Field label="Duration">{selected.duration_ms ? `${selected.duration_ms} ms` : "—"}</Field>
                <Field label="Cost">{fmtUsd(selected.cost_usd)}</Field>
                <Field label="Tokens (in/out)">{selected.input_tokens ?? 0} / {selected.output_tokens ?? 0}</Field>
                <Field label="Action">{selected.action_required || "—"}</Field>
                <Field label="Source">{selected.source || "—"}</Field>
              </div>
            </Section>
            <Section title="Issue & recommendation">
              <Field label="Issue">{selected.issue}</Field>
              <div className="h-3" />
              <Field label="Recommendation">{selected.recommendation}</Field>
            </Section>
            <Section title="Response">
              <pre className="text-xs bg-slate-900 text-slate-100 p-3 rounded-lg whitespace-pre-wrap max-h-64 overflow-auto">{selected.response_text || ""}</pre>
            </Section>
            <Section title="Prompt">
              <Field label="System">{selected.system_prompt}</Field>
              <div className="h-3" />
              <Field label="User"><pre className="text-xs bg-slate-50 ring-1 ring-slate-200 p-3 rounded-lg whitespace-pre-wrap max-h-64 overflow-auto">{selected.user_message || ""}</pre></Field>
            </Section>
            {selected.error ? (
              <Section title="Error">
                <div className="bg-rose-50 ring-1 ring-rose-200 text-rose-700 text-sm p-3 rounded-lg">{selected.error}</div>
              </Section>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
