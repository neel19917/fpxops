import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtPct } from "../lib/format";
import type { GpAudit, GpAuditRow, InvoiceAudit, InvoiceAuditRow } from "../lib/types";
import { Drawer, Field, Section } from "../components/Drawer";
import { ShareButton } from "../components/ShareButton";

interface ReanalyzeButtonProps {
  busy: boolean;
  onClick: (level: "summary" | "full") => void;
}
function ReanalyzeButton({ busy, onClick }: ReanalyzeButtonProps) {
  return (
    <div className="inline-flex rounded-lg ring-1 ring-sky-200 overflow-hidden">
      <button
        disabled={busy}
        onClick={() => onClick("summary")}
        className="text-xs px-3 py-1.5 bg-sky-50 text-sky-700 hover:bg-sky-100 disabled:opacity-50 inline-flex items-center gap-1.5"
        title="Re-run the executive summary on this audit"
      >
        <Sparkles className={`h-3.5 w-3.5 ${busy ? "animate-pulse" : ""}`} />
        {busy ? "Analyzing…" : "Re-analyze"}
      </button>
      <button
        disabled={busy}
        onClick={() => onClick("full")}
        className="text-xs px-3 py-1.5 bg-white text-sky-700 hover:bg-sky-50 disabled:opacity-50 border-l border-sky-200"
        title="Re-run summary AND per-row notes (slower, costs more)"
      >
        Full
      </button>
    </div>
  );
}

export function GpAuditsPage() {
  const [rows, setRows] = useState<GpAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<{ run: GpAudit; rows: GpAuditRow[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reanBusy, setReanBusy] = useState(false);
  const [reanError, setReanError] = useState<string | null>(null);

  useEffect(() => {
    api.audits.gp.list().then((r) => { setRows(r.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); setReanError(null); return; }
    api.audits.gp.get(openId).then(setDetail).catch(() => setDetail(null));
  }, [openId]);

  async function reanalyze(level: "summary" | "full") {
    if (!openId || reanBusy) return;
    setReanBusy(true);
    setReanError(null);
    try {
      await api.audits.gp.reanalyze(openId, level);
      const fresh = await api.audits.gp.get(openId);
      setDetail(fresh);
      setRows((prev) => prev.map((r) => r.id === fresh.run.id ? fresh.run : r));
    } catch (e) {
      setReanError((e as Error).message);
    } finally {
      setReanBusy(false);
    }
  }

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
            <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
              <ReanalyzeButton busy={reanBusy} onClick={reanalyze} />
              <ShareButton resourceType="gp_audit" resourceId={detail.run.id} defaultLabel={`GP Audit ${fmtDate(detail.run.date_from)}–${fmtDate(detail.run.date_to)}`} />
            </div>
            {reanError ? <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2">{reanError}</div> : null}
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
                  {row.ai_notes ? (
                    <div className="mt-1.5 text-xs bg-sky-50 ring-1 ring-sky-100 text-slate-700 px-2.5 py-1.5 rounded-md whitespace-pre-wrap">
                      <span className="font-semibold text-sky-700">AI</span> · {row.ai_notes}
                    </div>
                  ) : null}
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
  const [reanBusy, setReanBusy] = useState(false);
  const [reanError, setReanError] = useState<string | null>(null);

  useEffect(() => {
    api.audits.invoice.list().then((r) => { setRows(r.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); setReanError(null); return; }
    api.audits.invoice.get(openId).then(setDetail).catch(() => setDetail(null));
  }, [openId]);

  async function reanalyze(level: "summary" | "full") {
    if (!openId || reanBusy) return;
    setReanBusy(true);
    setReanError(null);
    try {
      await api.audits.invoice.reanalyze(openId, level);
      const fresh = await api.audits.invoice.get(openId);
      setDetail(fresh);
      setRows((prev) => prev.map((r) => r.id === fresh.run.id ? fresh.run : r));
    } catch (e) {
      setReanError((e as Error).message);
    } finally {
      setReanBusy(false);
    }
  }

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
            <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
              <ReanalyzeButton busy={reanBusy} onClick={reanalyze} />
              <ShareButton resourceType="invoice_audit" resourceId={detail.run.id} defaultLabel={`Invoice Audit ${fmtDate(detail.run.date_from)}–${fmtDate(detail.run.date_to)}`} />
            </div>
            {reanError ? <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2">{reanError}</div> : null}
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
                  {row.ai_notes ? (
                    <div className="mt-1.5 text-xs bg-sky-50 ring-1 ring-sky-100 text-slate-700 px-2.5 py-1.5 rounded-md whitespace-pre-wrap">
                      <span className="font-semibold text-sky-700">AI</span> · {row.ai_notes}
                    </div>
                  ) : null}
                </div>
              ))}
            </Section>
          </>
        ) : <div className="text-sm text-slate-500">Loading…</div>}
      </Drawer>
    </div>
  );
}
