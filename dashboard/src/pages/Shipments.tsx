import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Package, Search, Users, XOctagon } from "lucide-react";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtRelative, fmtUsd } from "../lib/format";
import type { AiAnalysis, Shipment } from "../lib/types";
import { ActionBadge } from "../components/Badge";
import { KPI } from "../components/KPI";
import { Drawer, Field, Section } from "../components/Drawer";
import { ShareButton } from "../components/ShareButton";

export function ShipmentsPage() {
  const [rows, setRows] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");

  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<{ shipment: Shipment; analyses: AiAnalysis[] } | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.shipments.list({ limit: 2000 });
      setRows(r.data);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!drawerId) { setDrawerData(null); return; }
    api.shipments.get(drawerId).then(setDrawerData).catch(() => setDrawerData(null));
  }, [drawerId]);

  const customers = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.customer_name) set.add(r.customer_name);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (actionFilter && String(r.action_required || "").toUpperCase() !== actionFilter) return false;
      if (customerFilter && r.customer_name !== customerFilter) return false;
      if (q) {
        const hay = [r.tracking_number, r.customer_name, r.carrier_name, r.carrier, r.ai_issue, r.shipment_status]
          .map((x) => (x || "").toLowerCase()).join(" ");
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, q, actionFilter, customerFilter]);

  const kpis = useMemo(() => {
    const total = rows.length;
    const action = rows.filter((r) => String(r.action_required || "").toUpperCase() === "YES").length;
    const ontrack = rows.filter((r) => String(r.action_required || "").toUpperCase() === "NO").length;
    const errors = rows.filter((r) => String(r.action_required || "").toUpperCase() === "ERROR").length;
    const custs = new Set(rows.map((r) => r.customer_name).filter(Boolean)).size;
    return { total, action, ontrack, errors, custs };
  }, [rows]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPI label="Shipments" value={kpis.total} icon={Package} tone="brand" />
        <KPI label="Action needed" value={kpis.action} icon={AlertTriangle} tone="danger" />
        <KPI label="On track" value={kpis.ontrack} icon={CheckCircle2} tone="success" />
        <KPI label="Errors" value={kpis.errors} icon={XOctagon} tone="warn" />
        <KPI label="Customers" value={kpis.custs} icon={Users} />
      </div>

      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row gap-2 md:items-center">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
              placeholder="Search tracking, customer, carrier, issue…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">All actions</option>
            <option value="YES">Action needed</option>
            <option value="NO">On track</option>
            <option value="ERROR">Error</option>
          </select>
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm max-w-[220px]"
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
          >
            <option value="">All customers</option>
            {customers.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button
            onClick={load}
            className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800"
          >
            Refresh
          </button>
        </div>

        {err ? (
          <div className="p-4 bg-rose-50 border-b border-rose-200 text-rose-800 text-sm">
            {err}
          </div>
        ) : null}

        <div className="overflow-auto max-h-[calc(100vh-340px)]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 backdrop-blur sticky top-0">
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5 font-medium">Scraped</th>
                <th className="px-4 py-2.5 font-medium">Tracking</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Carrier</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Issue</th>
                <th className="px-4 py-2.5 font-medium">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={8} className="p-8 text-center text-slate-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="p-8 text-center text-slate-500">No shipments match your filters.</td></tr>
              ) : filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setDrawerId(r.id)}
                  className="hover:bg-sky-50/50 cursor-pointer"
                >
                  <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap" title={fmtDateTime(r.scraped_at)}>{fmtRelative(r.scraped_at)}</td>
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap">{r.tracking_number || "—"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{r.customer_name || "—"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{r.carrier_name || r.carrier || "—"}</td>
                  <td className="px-4 py-2.5">{r.shipment_status || "—"}</td>
                  <td className="px-4 py-2.5"><ActionBadge action={r.action_required} size="sm" /></td>
                  <td className="px-4 py-2.5 max-w-[320px] truncate" title={r.ai_issue || ""}>{r.ai_issue || "—"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{fmtDate(r.delivery_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer
        open={!!drawerId}
        onClose={() => setDrawerId(null)}
        title={drawerData?.shipment.tracking_number || "Shipment"}
        subtitle={drawerData?.shipment.customer_name || undefined}
      >
        {drawerData ? (
          <>
            <div className="flex justify-end mb-4">
              <ShareButton
                resourceType="shipment"
                resourceId={drawerData.shipment.id}
                defaultLabel={`Shipment ${drawerData.shipment.tracking_number || ""}`.trim()}
              />
            </div>
            <Section title="Shipment">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Carrier">{drawerData.shipment.carrier_name || drawerData.shipment.carrier}</Field>
                <Field label="Mode">{drawerData.shipment.mode}</Field>
                <Field label="Status">{drawerData.shipment.shipment_status}</Field>
                <Field label="Action"><ActionBadge action={drawerData.shipment.action_required} /></Field>
                <Field label="Pickup">{fmtDateTime(drawerData.shipment.pickup_date)}</Field>
                <Field label="ETA">{fmtDateTime(drawerData.shipment.updated_eta)}</Field>
                <Field label="Delivery">{fmtDateTime(drawerData.shipment.delivery_date)}</Field>
                <Field label="Signed By">{drawerData.shipment.signed_by}</Field>
                <Field label="Origin">{drawerData.shipment.ship_from || drawerData.shipment.origin}</Field>
                <Field label="Destination">{drawerData.shipment.ship_to || drawerData.shipment.destination}</Field>
                <Field label="GP">{drawerData.shipment.shipment_gross_profit}</Field>
                <Field label="Rate (marked up)">{drawerData.shipment.shipment_marked_up_rate}</Field>
              </div>
            </Section>
            <Section title="AI summary">
              <Field label="Issue">{drawerData.shipment.ai_issue}</Field>
              <div className="h-3" />
              <Field label="Recommendation">{drawerData.shipment.ai_recommendation}</Field>
            </Section>
            <Section title={`Analysis history (${drawerData.analyses.length})`}>
              {drawerData.analyses.length === 0 ? (
                <div className="text-sm text-slate-500">No analyses yet.</div>
              ) : drawerData.analyses.map((a) => (
                <div key={a.id} className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 mb-2">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>{fmtDateTime(a.created_at)} · {a.model}</span>
                    <span>{fmtUsd(a.cost_usd)}</span>
                  </div>
                  {a.issue ? <div className="text-sm"><b className="text-slate-700">Issue:</b> {a.issue}</div> : null}
                  {a.recommendation ? <div className="text-sm mt-0.5"><b className="text-slate-700">Rec:</b> {a.recommendation}</div> : null}
                  {a.response_text ? (
                    <pre className="mt-2 text-[11px] bg-white p-2 rounded-lg ring-1 ring-slate-200 whitespace-pre-wrap max-h-40 overflow-auto">{a.response_text}</pre>
                  ) : null}
                </div>
              ))}
            </Section>
            <Section title="Raw scrape">
              <pre className="text-[11px] bg-slate-900 text-slate-100 p-3 rounded-lg whitespace-pre-wrap max-h-60 overflow-auto">
                {JSON.stringify(drawerData.shipment.raw_data, null, 2)}
              </pre>
            </Section>
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>
    </div>
  );
}
