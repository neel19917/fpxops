import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtPct } from "../lib/format";
import type { GpAudit, GpAuditRow, InvoiceAudit, InvoiceAuditRow } from "../lib/types";
import { Drawer, Field, Section } from "../components/Drawer";

export function GpAuditsPage() {
  const [rows, setRows] = useState<GpAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ run: GpAudit; rows: GpAuditRow[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    api.audits.gp.list().then((r) => { setRows(r.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    api.audits.gp.get(openId).then(setDetail).catch(() => setDetail(null));
  }, [openId]);

  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50">
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2.5 font-medium">Run</th>
            <th className="px-4 py-2.5 font-medium">Date Range</th>
            <th className="px-4 py-2.5 font-medium">Type</th>
            <th className="px-4 py-2.5 font-medium text-right">Rows</th>
            <th className="px-4 py-2.5 font-medium text-right">Outliers</th>
            <th className="px-4 py-2.5 font-medium text-right">Mean GP%</th>
            <th className="px-4 py-2.5 font-medium">Run By</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading ? <tr><td colSpan={7} className="p-8 text-center text-slate-500">Loading…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-slate-500">No GP audits yet.</td></tr>
              : rows.map((r) => (
                <tr key={r.id} className="hover:bg-sky-50/50 cursor-pointer" onClick={() => setOpenId(r.id)}>
                  <td className="px-4 py-2.5">{fmtDateTime(r.created_at)}</td>
                  <td className="px-4 py-2.5">{fmtDate(r.date_from)} → {fmtDate(r.date_to)}</td>
                  <td className="px-4 py-2.5">{r.shipment_type || "—"}</td>
                  <td className="px-4 py-2.5 text-right">{fmtNum(r.total_rows)}</td>
                  <td className="px-4 py-2.5 text-right">{fmtNum(r.outlier_count)}</td>
                  <td className="px-4 py-2.5 text-right">{fmtPct(r.mean_gp_pct)}</td>
                  <td className="px-4 py-2.5">{r.run_by || "—"}</td>
                </tr>
              ))}
        </tbody>
      </table>

      <Drawer open={!!openId} onClose={() => setOpenId(null)} title="GP Audit" subtitle={detail ? fmtDateTime(detail.run.created_at) : undefined}>
        {detail ? (
          <>
            <Section title="Run">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Range">{fmtDate(detail.run.date_from)} → {fmtDate(detail.run.date_to)}</Field>
                <Field label="Rows">{fmtNum(detail.run.total_rows)}</Field>
                <Field label="Outliers">{fmtNum(detail.run.outlier_count)}</Field>
                <Field label="Mean GP%">{fmtPct(detail.run.mean_gp_pct)}</Field>
                <Field label="Stdev">{detail.run.stdev_gp_pct?.toFixed(2) ?? "—"}</Field>
                <Field label="Run by">{detail.run.run_by}</Field>
              </div>
              {detail.run.exec_summary ? (
                <pre className="mt-3 text-xs bg-slate-50 ring-1 ring-slate-200 p-3 rounded-lg whitespace-pre-wrap">{detail.run.exec_summary}</pre>
              ) : null}
            </Section>
            <Section title={`Rows (${detail.rows.length})`}>
              {detail.rows.map((row) => (
                <div key={row.id} className="py-2 border-b border-slate-100 last:border-0">
                  <div className="flex justify-between">
                    <span className="font-medium">{row.customer_name || row.shipment_id}</span>
                    {row.is_outlier ? <span className="text-xs rounded-full bg-rose-100 text-rose-700 px-2 py-0.5">outlier</span> : null}
                  </div>
                  <div className="text-xs text-slate-500">
                    GP {row.gross_profit ?? "—"} · {fmtPct(row.gp_pct)} · inv {row.invoice_number || "—"}
                  </div>
                </div>
              ))}
            </Section>
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>
    </div>
  );
}

export function InvoiceAuditsPage() {
  const [rows, setRows] = useState<InvoiceAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ run: InvoiceAudit; rows: InvoiceAuditRow[] } | null>(null);

  useEffect(() => {
    api.audits.invoice.list().then((r) => { setRows(r.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    api.audits.invoice.get(openId).then(setDetail).catch(() => setDetail(null));
  }, [openId]);

  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50">
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2.5 font-medium">Run</th>
            <th className="px-4 py-2.5 font-medium">Date Range</th>
            <th className="px-4 py-2.5 font-medium text-right">Rows</th>
            <th className="px-4 py-2.5 font-medium text-right">Match</th>
            <th className="px-4 py-2.5 font-medium text-right">Discrep.</th>
            <th className="px-4 py-2.5 font-medium text-right">Unmatched</th>
            <th className="px-4 py-2.5 font-medium">Run By</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading ? <tr><td colSpan={7} className="p-8 text-center text-slate-500">Loading…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-slate-500">No invoice audits yet.</td></tr>
              : rows.map((r) => (
                <tr key={r.id} className="hover:bg-sky-50/50 cursor-pointer" onClick={() => setOpenId(r.id)}>
                  <td className="px-4 py-2.5">{fmtDateTime(r.created_at)}</td>
                  <td className="px-4 py-2.5">{fmtDate(r.date_from)} → {fmtDate(r.date_to)}</td>
                  <td className="px-4 py-2.5 text-right">{fmtNum(r.total_rows)}</td>
                  <td className="px-4 py-2.5 text-right">{fmtNum(r.match_count)}</td>
                  <td className="px-4 py-2.5 text-right">{fmtNum(r.discrepancy_count)}</td>
                  <td className="px-4 py-2.5 text-right">{fmtNum(r.unmatched_count)}</td>
                  <td className="px-4 py-2.5">{r.run_by || "—"}</td>
                </tr>
              ))}
        </tbody>
      </table>

      <Drawer open={!!openId} onClose={() => setOpenId(null)} title="Invoice Audit" subtitle={detail ? fmtDateTime(detail.run.created_at) : undefined}>
        {detail ? (
          <>
            <Section title="Run">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Range">{fmtDate(detail.run.date_from)} → {fmtDate(detail.run.date_to)}</Field>
                <Field label="Match">{fmtNum(detail.run.match_count)}</Field>
                <Field label="Discrepancy">{fmtNum(detail.run.discrepancy_count)}</Field>
                <Field label="Unmatched">{fmtNum(detail.run.unmatched_count)}</Field>
              </div>
              {detail.run.exec_summary ? (
                <pre className="mt-3 text-xs bg-slate-50 ring-1 ring-slate-200 p-3 rounded-lg whitespace-pre-wrap">{detail.run.exec_summary}</pre>
              ) : null}
            </Section>
            <Section title={`Rows (${detail.rows.length})`}>
              {detail.rows.map((row) => (
                <div key={row.id} className="py-2 border-b border-slate-100 last:border-0">
                  <div className="flex justify-between">
                    <span className="font-medium">{row.shipment_id}</span>
                    <span className={
                      "text-xs rounded-full px-2 py-0.5 " +
                      (row.status === "discrepancy" ? "bg-rose-100 text-rose-700" : row.status === "match" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700")
                    }>{row.status}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Bill ${row.bill_amount ?? 0} vs cost ${row.shipment_cost ?? 0} · Δ ${row.difference ?? 0}
                  </div>
                </div>
              ))}
            </Section>
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>
    </div>
  );
}
