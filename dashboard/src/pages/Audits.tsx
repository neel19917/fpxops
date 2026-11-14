import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, CheckCircle2, Download, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtPct, fmtRelative } from "../lib/format";
import type { ApprovalState, ApprovalSummary, GetInvoiceState, GpAudit, GpAuditRow, InvoiceAudit, InvoiceAuditDetail, InvoiceAuditFiles, InvoiceAuditRow } from "../lib/types";
import { Drawer, Field, Section } from "../components/Drawer";
import { ShareButton } from "../components/ShareButton";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";
import { ErpPullMonitor, type ErpMonitorStatus } from "../components/ErpPullMonitor";
import { ApprovalPill, GetInvoiceModal, InvoicePill, type GetInvoiceItem } from "../components/GetInvoiceModal";
import {
  APPROVAL_SCOPE, GET_INVOICE_MAX, approvalDate, approvalGroup, approvalLabel, approvalSourceLabel, downloadAuditExcel, getInvoiceLabel, isShaun,
  requestApprovalCheck, toApprovalState, type ApprovalGroup, type AuditExcelWhich,
} from "../lib/erpPull";

interface ReanalyzeButtonProps {
  busy: boolean;
  onClick: (level: "summary" | "full") => void;
  // Hide "Full" (per-row notes). Used for ERP pulls, which run to thousands of rows.
  summaryOnly?: boolean;
}
function ReanalyzeButton({ busy, onClick, summaryOnly }: ReanalyzeButtonProps) {
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
      {summaryOnly ? null : (
        <button
          disabled={busy}
          onClick={() => onClick("full")}
          className="text-xs px-3 py-1.5 bg-white text-sky-700 hover:bg-sky-50 disabled:opacity-50 border-l border-sky-200"
          title="Re-run summary AND per-row notes (slower, costs more)"
        >
          Full
        </button>
      )}
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
    let cancelled = false;
    api.audits.gp.list()
      .then((r) => { if (!cancelled) { setRows(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); setReanError(null); return; }
    let cancelled = false;
    api.audits.gp.get(openId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
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
          {loading ? <LoadingState variant="row" colSpan={7} />
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
            {reanError ? <div className="mb-3"><ErrorBlock compact>{reanError}</ErrorBlock></div> : null}
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
        ) : <LoadingState variant="inline" />}
      </Drawer>
    </div>
  );
}


// ───────────────────────── Invoice audits ─────────────────────────
// Two kinds of run share this page:
//   • carrier-bill runs — uploaded from the Chrome extension;
//   • ERP pulls (shipment_type "erp_pending") — a hosted browser generates
//     FreightPOP's History Report and audits the shipments not yet exported
//     to ERP. These get a sortable spreadsheet instead of the card list.

const ERP_PENDING = "erp_pending";
const ERP_SOURCE = "FreightPOP History Report";
const ERP_PAGE_SIZE = 200;

function isErpRun(run: InvoiceAudit | null | undefined): boolean {
  return run?.shipment_type === ERP_PENDING;
}

// History Report values can be numbers or the report's own text ("$1,234.50", "(12.00)").
function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const text = String(v).trim();
  const negative = /^\(.*\)$/.test(text);
  const n = Number(text.replace(/[$,\s()]/g, ""));
  if (text === "" || !Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

// A date-only string is parsed as UTC midnight, which shows as the day
// before in US time zones — pin it to local midnight instead.
function shippedDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return isNaN(d.getTime()) ? null : d;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  match: { label: "Match", cls: "bg-emerald-100 text-emerald-700" },
  discrepancy: { label: "Discrepancy", cls: "bg-rose-100 text-rose-700" },
  no_invoice: { label: "No invoice yet", cls: "bg-slate-100 text-slate-700" },
  error: { label: "Error", cls: "bg-amber-100 text-amber-800" },
};
const STATUS_ORDER = ["discrepancy", "no_invoice", "match", "error"];

function statusLabel(status: string): string {
  return STATUS_META[status]?.label ?? (status || "—");
}

interface ErpRow {
  id: string;
  rank: number | null;
  shipment: string;
  customer: string;
  carrier: string;
  shipped: string | null;
  shippedTs: number | null;
  charge: number | null;
  cost: number | null;
  gp: number | null;
  invoice: number | null;
  diff: number | null;
  status: string;
  flags: string[];
  // Get Invoice state (raw.get_invoice); null = never requested.
  gi: GetInvoiceState | null;
  // Who approved the invoice (raw.approval); null = never checked.
  ap: ApprovalState | null;
  apGroup: ApprovalGroup | null;
  notes: string | null;
  search: string;
  source: InvoiceAuditRow;
}

function toInvoiceState(v: unknown): GetInvoiceState | null {
  if (!v || typeof v !== "object") return null;
  const state = v as GetInvoiceState;
  return typeof state.status === "string" && getInvoiceLabel(state.status) ? state : null;
}

// "Not yet requested" also covers a shipment a stopped run never reached.
const notRequested = (r: ErpRow) => !r.gi || r.gi.status === "not_started";
// Failed first, Done last, so a sort brings what needs attention to the top.
const GI_SORT: Record<string, number> = { failed: 0, requested: 1, not_started: 2, done: 3 };

function toErpRow(row: InvoiceAuditRow): ErpRow {
  const raw = row.raw ?? {};
  const shipment = row.shipment_id ?? "";
  const customer = row.customer_name ?? "";
  const carrier = row.carrier ?? "";
  const shipped = raw.shipped_date ? String(raw.shipped_date) : null;
  const ap = toApprovalState(raw.approval);
  return {
    id: row.id,
    rank: toNum(raw.rank),
    shipment,
    customer,
    carrier,
    shipped,
    shippedTs: shippedDate(shipped)?.getTime() ?? null,
    charge: toNum(raw.charge),
    cost: toNum(row.shipment_cost),
    gp: toNum(raw.gross_profit),
    invoice: toNum(row.bill_amount),
    diff: toNum(row.difference),
    status: row.status ?? "",
    flags: Array.isArray(raw.flags) ? raw.flags.map(String) : [],
    gi: toInvoiceState(raw.get_invoice),
    ap,
    apGroup: approvalGroup(ap),
    notes: row.ai_notes,
    search: `${shipment} ${customer} ${carrier}`.toLowerCase(),
    source: row,
  };
}

// Quick filters on who approved the invoice. "person" includes Shaun; "others" is everyone but him.
type ApprovalFilter = "all" | "approved" | "edi" | "shaun" | "person" | "others" | "unknown" | "not_approved";

function matchesApproval(r: ErpRow, filter: ApprovalFilter): boolean {
  const g = r.apGroup;
  switch (filter) {
    case "all": return true;
    case "approved": return g != null && g !== "not_approved";
    case "person": return g === "shaun" || g === "person";
    case "others": return g === "person";
    default: return g === filter;
  }
}

// In the CSV an Unknown approver carries FreightPOP's own text, since there is no hover there.
function approvalCsv(r: ErpRow): string {
  const label = approvalLabel(r.ap);
  return r.apGroup === "unknown" && r.ap?.approved_by_raw ? `${label} (${r.ap.approved_by_raw})` : label;
}

type ErpColKey = "rank" | "shipment" | "customer" | "carrier" | "shipped" | "charge" | "cost" | "gp" | "invoice" | "diff" | "status" | "getInvoice" | "approvedBy" | "flags";

interface ErpCol {
  key: ErpColKey;
  label: string;
  numeric?: boolean;
  // Direction a first click on this header sorts in.
  firstDir: "asc" | "desc";
  sortValue: (r: ErpRow) => number | string | null;
  csvValue: (r: ErpRow) => number | string | null;
  cell: (r: ErpRow) => ReactNode;
}

const cents = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
const money = (pick: (r: ErpRow) => number | null) => ({
  numeric: true,
  firstDir: "desc" as const,
  sortValue: pick,
  csvValue: (r: ErpRow) => cents(pick(r)),
});

const ERP_COLS: ErpCol[] = [
  { key: "rank", label: "Rank", numeric: true, firstDir: "asc", sortValue: (r) => r.rank, csvValue: (r) => r.rank, cell: (r) => <span className="text-slate-500">{r.rank ?? "—"}</span> },
  { key: "shipment", label: "Shipment", firstDir: "asc", sortValue: (r) => r.shipment || null, csvValue: (r) => r.shipment, cell: (r) => <span className="font-medium text-slate-900">{r.shipment || "—"}</span> },
  { key: "customer", label: "Customer", firstDir: "asc", sortValue: (r) => r.customer || null, csvValue: (r) => r.customer, cell: (r) => r.customer || "—" },
  { key: "carrier", label: "Carrier", firstDir: "asc", sortValue: (r) => r.carrier || null, csvValue: (r) => r.carrier, cell: (r) => r.carrier || "—" },
  { key: "shipped", label: "Shipped", firstDir: "desc", sortValue: (r) => r.shippedTs ?? r.shipped, csvValue: (r) => r.shipped, cell: (r) => (r.shippedTs != null ? fmtDate(new Date(r.shippedTs).toISOString()) : r.shipped || "—") },
  { key: "charge", label: "Charge", ...money((r) => r.charge), cell: (r) => <span className="font-medium text-slate-900">{fmtMoney(r.charge)}</span> },
  { key: "cost", label: "Cost", ...money((r) => r.cost), cell: (r) => fmtMoney(r.cost) },
  { key: "gp", label: "Gross profit", ...money((r) => r.gp), cell: (r) => <span className={r.gp != null && r.gp < 0 ? "text-rose-700" : ""}>{fmtMoney(r.gp)}</span> },
  { key: "invoice", label: "Invoice amount", ...money((r) => r.invoice), cell: (r) => fmtMoney(r.invoice) },
  { key: "diff", label: "Difference", ...money((r) => r.diff), cell: (r) => <span className={r.diff ? "text-rose-700" : ""}>{fmtMoney(r.diff)}</span> },
  {
    key: "status", label: "Status", firstDir: "asc",
    sortValue: (r) => statusLabel(r.status), csvValue: (r) => statusLabel(r.status),
    cell: (r) => <span className={"text-xs rounded-full px-2 py-0.5 whitespace-nowrap " + (STATUS_META[r.status]?.cls ?? "bg-slate-100 text-slate-700")}>{statusLabel(r.status)}</span>,
  },
  {
    key: "getInvoice", label: "Invoice", firstDir: "asc",
    sortValue: (r) => (r.gi ? GI_SORT[r.gi.status] ?? null : null),
    csvValue: (r) => (r.gi ? [getInvoiceLabel(r.gi.status), r.gi.status === "failed" ? r.gi.note : null].filter(Boolean).join(": ") : ""),
    cell: (r) => <InvoicePill state={r.gi} />,
  },
  {
    key: "approvedBy", label: "Approved by", firstDir: "asc",
    sortValue: (r) => approvalLabel(r.ap) || null, csvValue: approvalCsv,
    cell: (r) => <ApprovalPill state={r.ap} />,
  },
  {
    key: "flags", label: "Flags", firstDir: "desc",
    sortValue: (r) => r.flags.length, csvValue: (r) => r.flags.join("; "),
    cell: (r) => r.flags.length === 0 ? <span className="text-slate-300">—</span> : (
      <span className="flex flex-wrap gap-1" title={r.flags.join("\n")}>
        {r.flags.slice(0, 3).map((f) => <span key={f} className="text-[11px] rounded-full bg-amber-50 text-amber-800 ring-1 ring-amber-200 px-2 py-0.5 whitespace-nowrap">{f}</span>)}
        {r.flags.length > 3 ? <span className="text-[11px] text-slate-500">+{r.flags.length - 3}</span> : null}
      </span>
    ),
  },
];

// Empty values always sort to the bottom, whichever direction is chosen.
function compareErp(a: ErpRow, b: ErpRow, col: ErpCol, dir: "asc" | "desc"): number {
  const av = col.sortValue(a);
  const bv = col.sortValue(b);
  if (av == null || bv == null) {
    if (av == null && bv == null) return (a.rank ?? Infinity) - (b.rank ?? Infinity);
    return av == null ? 1 : -1;
  }
  const cmp = typeof av === "number" && typeof bv === "number"
    ? av - bv
    : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  if (cmp === 0) return (a.rank ?? Infinity) - (b.rank ?? Infinity);
  return dir === "asc" ? cmp : -cmp;
}

function csvCell(v: number | string | null): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  // A leading = + - @ makes Excel treat the cell as a formula; a quote mark keeps it text.
  const text = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The table shows these in the Approved by pill's hover; the CSV gets them as columns.
const approvedOnly = (r: ErpRow) => (r.apGroup && r.apGroup !== "not_approved" ? r.ap : null);
const ERP_CSV_COLS: Pick<ErpCol, "label" | "csvValue">[] = ERP_COLS.flatMap((c): Pick<ErpCol, "label" | "csvValue">[] => c.key !== "approvedBy" ? [c] : [
  c,
  { label: "Approved date", csvValue: (r) => approvalDate(approvedOnly(r)) },
  { label: "Approved amount", csvValue: (r) => { const a = approvedOnly(r)?.amount; return a == null || a === "" ? null : cents(toNum(a)) ?? String(a); } },
  { label: "Audit notes", csvValue: (r) => approvedOnly(r)?.notes || null },
]);

function downloadErpCsv(rows: ErpRow[], run: InvoiceAudit) {
  const lines = [
    ERP_CSV_COLS.map((c) => csvCell(c.label)).join(","),
    ...rows.map((r) => ERP_CSV_COLS.map((c) => csvCell(c.csvValue(r))).join(",")),
  ];
  // The BOM tells Excel the file is UTF-8, so accented names open cleanly.
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `not-exported-to-erp-${(run.date_to || run.created_at || "").slice(0, 10) || "run"}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const ERP_EXTRA_FIELDS: { label: string; value: (r: InvoiceAuditRow) => unknown }[] = [
  { label: "Invoice #", value: (r) => r.raw?.invoice_number },
  { label: "Tracking", value: (r) => r.raw?.tracking },
  { label: "Service", value: (r) => r.raw?.service },
  { label: "Account manager", value: (r) => r.raw?.account_manager },
  { label: "Shipment status", value: (r) => r.raw?.shipment_status },
  { label: "Transaction type", value: (r) => r.raw?.transaction_type },
  { label: "Audit notes", value: (r) => r.raw?.approval?.notes || null },
  { label: "Invoice uploaded by", value: (r) => r.raw?.approval?.uploaded_by || null },
  { label: "Not approved amount", value: (r) => { const n = toNum(r.raw?.not_approved_amount); return n == null ? null : fmtMoney(n); } },
  { label: "Variance", value: (r) => { const n = toNum(r.raw?.variance); return n == null ? null : fmtMoney(n); } },
  { label: "Customer invoice sent", value: (r) => { const v = r.raw?.customer_invoice_sent; return typeof v === "boolean" ? (v ? "Yes" : "No") : v; } },
  { label: "User", value: (r) => r.raw?.user },
];

function ErpRowDetail({ row }: { row: ErpRow }) {
  const extras = ERP_EXTRA_FIELDS
    .map((f) => ({ label: f.label, value: f.value(row.source) }))
    .filter((f) => f.value != null && f.value !== "");
  const ap = row.ap;
  const apAmount = toNum(ap?.amount);
  const approval = !ap || !row.apGroup ? null
    : row.apGroup === "not_approved"
      ? `Not in FreightPOP's Recently Approved list${ap.checked_at ? ` when checked ${fmtDateTime(ap.checked_at)}` : ""}.`
      : [
        `Approved by ${row.apGroup === "unknown" ? (ap.approved_by_raw ? `"${ap.approved_by_raw}"` : "someone FreightPOP doesn't name") : approvalLabel(ap)}${row.apGroup === "edi" ? " (automatic)" : ""}`,
        approvalDate(ap) ? `on ${approvalDate(ap)}` : null,
        apAmount != null ? `amount ${fmtMoney(apAmount)}` : ap.amount ? `amount ${ap.amount}` : null,
        ap.invoice ? `invoice ${ap.invoice}` : null,
        `from ${approvalSourceLabel(ap)}`,
      ].filter(Boolean).join(" · ");
  return (
    <div className="space-y-2">
      {extras.length ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-x-4 gap-y-2">
          {extras.map((f) => <Field key={f.label} label={f.label}>{String(f.value)}</Field>)}
        </div>
      ) : null}
      {row.flags.length ? <div className="text-xs text-slate-600">Flags: {row.flags.join(" · ")}</div> : null}
      {approval ? <div className="text-xs text-slate-600">{approval}</div> : null}
      {row.notes ? (
        <div className="text-xs bg-sky-50 ring-1 ring-sky-100 text-slate-700 px-2.5 py-1.5 rounded-md whitespace-pre-wrap">
          <span className="font-semibold text-sky-700">AI</span> · {row.notes}
        </div>
      ) : null}
      {!extras.length && !row.flags.length && !row.notes && !approval ? <div className="text-xs text-slate-500">Nothing more recorded for this shipment.</div> : null}
    </div>
  );
}

interface ErpRowsTableProps {
  run: InvoiceAudit;
  rows: InvoiceAuditRow[];
  /** Why a Get Invoice run can't be started right now; null = it can. */
  getInvoiceBlocked?: string | null;
  /** A Get Invoice run was queued for this audit (request id). */
  onInvoicesStarted?: (requestId: string) => void;
  /** The last approval check on this pull; null = never checked. */
  approvalSummary?: ApprovalSummary | null;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// "Approved: 212 of 1,307 · by EDI 180 · by Shaun 20 · by others 12 · not
// approved yet 1,095 · checked 5m ago". Each figure filters the table.
function ApprovalStrip({ summary, value, onPick }: { summary: ApprovalSummary; value: ApprovalFilter; onPick: (f: ApprovalFilter) => void }) {
  const [namesOpen, setNamesOpen] = useState(false);
  const people = Object.entries(summary.by_person ?? {}).map(([name, n]) => [name, count(n)] as const).sort((a, b) => b[1] - a[1]);
  const shauns = people.filter(([name]) => isShaun(name));
  const others = people.filter(([name]) => !isShaun(name));
  const othersTotal = others.reduce((t, [, n]) => t + n, 0);
  const matched = count(summary.matched);
  const notFound = count(summary.not_found);
  const unknown = count(summary.by_unknown);
  const bySource = summary.by_source ?? null;
  const figure = (filter: ApprovalFilter, n: number, hint: string, strong = false) => (
    <button
      onClick={() => onPick(value === filter ? "all" : filter)}
      aria-pressed={value === filter}
      title={value === filter ? "Show all shipments again" : hint}
      className={"tabular-nums rounded px-1 -mx-0.5 underline decoration-dotted underline-offset-2 " + (value === filter ? "bg-sky-600 text-white no-underline" : "text-slate-900 hover:bg-slate-200") + (strong ? " font-semibold" : " font-medium")}
    >
      {fmtNum(n)}
    </button>
  );
  const dot = <span className="text-slate-300" aria-hidden="true">·</span>;
  return (
    <div className="shrink-0 mb-2 rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2 text-xs text-slate-600">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span><span className="font-medium text-slate-700">Approved:</span> {figure("approved", matched, "Show the approved shipments", true)} of {fmtNum(matched + notFound)}</span>
        {dot}
        <span>by EDI {figure("edi", count(summary.by_edi), "Show the ones EDI approved automatically")}</span>
        {dot}
        {shauns.length === 0 ? (
          <span>by Shaun {figure("shaun", 0, "Show the ones Shaun approved")}</span>
        ) : shauns.map(([name, n], i) => (
          <Fragment key={name}>
            {i > 0 ? dot : null}
            <span>by <span className="font-medium text-violet-700">{name}</span> {figure("shaun", n, `Show the ones ${name} approved`)}</span>
          </Fragment>
        ))}
        {dot}
        <span title={others.length ? others.map(([name, n]) => `${name}: ${fmtNum(n)}`).join("\n") : "Nobody else approved any of these"}>
          by others {figure("others", othersTotal, "Show the ones other people approved")}
          {others.length ? (
            <button onClick={() => setNamesOpen((v) => !v)} aria-expanded={namesOpen} className="ml-1 text-sky-700 hover:text-sky-900 underline">
              {namesOpen ? "hide names" : "who?"}
            </button>
          ) : null}
        </span>
        {unknown > 0 ? <>{dot}<span title="Approved, but FreightPOP's list doesn't say clearly by whom. Hover a grey Unknown pill to see its text.">unknown {figure("unknown", unknown, "Show the approved ones with no clear approver")}</span></> : null}
        {dot}
        <span>not approved yet {figure("not_approved", notFound, "Show the ones not in Recently Approved")}</span>
        {summary.checked_at ? <>{dot}<span title={fmtDateTime(summary.checked_at)}>checked {fmtRelative(summary.checked_at)}</span></> : null}
        {bySource ? (
          <>{dot}<span className="text-slate-400" title="Which of FreightPOP's Audit tabs each approved shipment was found on">{fmtNum(count(bySource.recently_approved))} from Recently Approved, {fmtNum(count(bySource.history))} from History</span></>
        ) : null}
      </div>
      {namesOpen && others.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {others.map(([name, n]) => (
            <span key={name} className="rounded-full bg-violet-100 text-violet-700 px-2 py-0.5 whitespace-nowrap">{name} <span className="tabular-nums font-medium">{fmtNum(n)}</span></span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ErpRowsTable({ run, rows, getInvoiceBlocked, onInvoicesStarted, approvalSummary }: ErpRowsTableProps) {
  const all = useMemo(() => rows.map(toErpRow), [rows]);
  const [sortKey, setSortKey] = useState<ErpColKey>("charge");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [limit, setLimit] = useState(ERP_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notRequestedOnly, setNotRequestedOnly] = useState(false);
  const [approval, setApproval] = useState<ApprovalFilter>("all");
  // Shipments ticked for Get Invoice (audit row ids). Survives filter changes.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null); // last row ticked, for shift-click
  const [capNote, setCapNote] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a[0]);
      const bi = STATUS_ORDER.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [all]);
  const flaggedCount = useMemo(() => all.filter((r) => r.flags.length > 0).length, [all]);
  const notRequestedCount = useMemo(() => all.filter(notRequested).length, [all]);
  // Shipments per approver group, for the quick filters. Empty until a check has run.
  const approvalCounts = useMemo(() => {
    const c = { checked: 0, edi: 0, shaun: 0, person: 0, not_approved: 0 };
    for (const r of all) {
      if (!r.apGroup) continue;
      c.checked++;
      if (r.apGroup === "edi") c.edi++;
      else if (r.apGroup === "shaun") { c.shaun++; c.person++; }
      else if (r.apGroup === "person") c.person++;
      else if (r.apGroup === "not_approved") c.not_approved++;
    }
    return c;
  }, [all]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const col = ERP_COLS.find((c) => c.key === sortKey) ?? ERP_COLS[0];
    return all
      .filter((r) => (status === "all" || r.status === status) && (!flaggedOnly || r.flags.length > 0) && (!notRequestedOnly || notRequested(r)) && matchesApproval(r, approval) && (!q || r.search.includes(q)))
      .sort((a, b) => compareErp(a, b, col, sortDir));
  }, [all, query, status, flaggedOnly, notRequestedOnly, approval, sortKey, sortDir]);

  const totals = useMemo(() => shown.reduce((t, r) => ({ charge: t.charge + (r.charge ?? 0), cost: t.cost + (r.cost ?? 0) }), { charge: 0, cost: 0 }), [shown]);

  // Any change to what is shown starts again from the first page.
  useEffect(() => { setLimit(ERP_PAGE_SIZE); }, [query, status, flaggedOnly, notRequestedOnly, approval, sortKey, sortDir]);

  // ── Selection for Get Invoice ──
  const selectedRows = useMemo(() => all.filter((r) => selected.has(r.id)), [all, selected]);
  const selCount = selectedRows.length;
  const selCharge = useMemo(() => selectedRows.reduce((t, r) => t + (r.charge ?? 0), 0), [selectedRows]);
  // The header checkbox covers the filtered rows, except ones already Done.
  const headerRows = useMemo(() => shown.filter((r) => r.shipment && r.gi?.status !== "done"), [shown]);
  const headerOn = headerRows.filter((r) => selected.has(r.id)).length;
  const headerAll = headerRows.length > 0 && (headerOn === headerRows.length || (headerOn > 0 && selCount >= GET_INVOICE_MAX));

  function applySelection(ids: string[], on: boolean) {
    // Start from the rows still in the run, so the cap counts what is really ticked.
    const next = new Set(selectedRows.map((r) => r.id));
    let left = 0;
    for (const id of ids) {
      if (!on) next.delete(id);
      else if (next.has(id)) continue;
      else if (next.size >= GET_INVOICE_MAX) left++;
      else next.add(id);
    }
    setSelected(next);
    setCapNote(left ? `One run takes up to ${GET_INVOICE_MAX} shipments, so ${fmtNum(left)} more ${left === 1 ? "was" : "were"} left unticked. Run these first, then pick the next batch.` : null);
  }
  function toggleRow(r: ErpRow, shift: boolean) {
    const on = !selected.has(r.id);
    let ids = [r.id];
    if (shift && anchorId) {
      const a = shown.findIndex((x) => x.id === anchorId);
      const b = shown.findIndex((x) => x.id === r.id);
      if (a >= 0 && b >= 0) ids = shown.slice(Math.min(a, b), Math.max(a, b) + 1).filter((x) => x.shipment).map((x) => x.id);
    }
    applySelection(ids, on);
    setAnchorId(r.id);
  }
  function toggleHeader() {
    if (headerAll) applySelection(shown.map((r) => r.id), false);
    else applySelection(headerRows.map((r) => r.id), true);
  }
  const modalItems = useMemo<GetInvoiceItem[]>(() => selectedRows.map((r) => ({
    id: r.id, shipment: r.shipment, customer: r.customer, carrier: r.carrier, charge: r.charge, invoice: r.invoice,
    status: r.status, statusLabel: statusLabel(r.status), statusCls: STATUS_META[r.status]?.cls ?? "bg-slate-100 text-slate-700",
    flags: r.flags, invoiceState: r.gi, approval: r.ap,
  })), [selectedRows]);
  const getDisabledReason = selCount === 0 ? "Tick the shipments you want invoices for first" : getInvoiceBlocked || null;
  const colCount = ERP_COLS.length + 1;

  function sortBy(col: ErpCol) {
    if (col.key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(col.key); setSortDir(col.firstDir); }
  }

  const chip = (active: boolean) =>
    "text-xs px-2.5 py-1 rounded-full ring-1 " + (active ? "bg-sky-600 text-white ring-sky-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50");
  const visible = shown.slice(0, limit);
  const filtered = shown.length !== all.length;

  const approvalChips: [ApprovalFilter, string, number][] = [
    ["edi", "Approved by EDI", approvalCounts.edi],
    ["shaun", "Approved by Shaun", approvalCounts.shaun],
    ["person", "Approved by a person", approvalCounts.person],
    ["not_approved", "Not approved yet", approvalCounts.not_approved],
  ];

  return (
    <>
      {approvalSummary ? <ApprovalStrip summary={approvalSummary} value={approval} onPick={setApproval} /> : null}
      {approvalSummary || approvalCounts.checked > 0 ? (
        <div className="shrink-0 flex flex-wrap items-center gap-2 mb-2">
          {approvalChips.map(([key, label, n]) => (
            <button key={key} className={chip(approval === key)} aria-pressed={approval === key} onClick={() => setApproval(approval === key ? "all" : key)}>
              {label} {fmtNum(n)}
            </button>
          ))}
          {approval !== "all" ? <button onClick={() => setApproval("all")} className="text-xs text-slate-500 underline hover:text-slate-900">Clear</button> : null}
        </div>
      ) : null}
      <div className="shrink-0 flex flex-wrap items-center gap-2 mb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by shipment, customer or carrier"
          aria-label="Filter by shipment, customer or carrier"
          className="text-sm w-72 max-w-full rounded-lg ring-1 ring-slate-200 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-sky-300"
        />
        <button className={chip(status === "all")} onClick={() => setStatus("all")}>All {fmtNum(all.length)}</button>
        {statusCounts.map(([key, count]) => (
          <button key={key || "none"} className={chip(status === key)} onClick={() => setStatus(status === key ? "all" : key)}>
            {statusLabel(key)} {fmtNum(count)}
          </button>
        ))}
        <label className="text-xs text-slate-600 inline-flex items-center gap-1.5 ml-1 cursor-pointer">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} className="rounded border-slate-300 text-sky-600" />
          Flagged only ({fmtNum(flaggedCount)})
        </label>
        <label className="text-xs text-slate-600 inline-flex items-center gap-1.5 ml-1 cursor-pointer" title="Shipments nobody has asked FPX to get an invoice for yet">
          <input type="checkbox" checked={notRequestedOnly} onChange={(e) => setNotRequestedOnly(e.target.checked)} className="rounded border-slate-300 text-sky-600" />
          Not yet requested ({fmtNum(notRequestedCount)})
        </label>
        <button
          onClick={() => downloadErpCsv(shown, run)}
          disabled={shown.length === 0}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
          title="Downloads the rows below as a CSV, with the current filters and sort order. For FreightPOP's own Excel file, use Download Excel (FreightPOP format) at the top."
        >
          <Download className="h-3.5 w-3.5" />
          Download this table (CSV)
        </button>
      </div>
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-500 mb-2">
        <span>
          {filtered ? `${fmtNum(shown.length)} of ${fmtNum(all.length)} shipments` : `${fmtNum(all.length)} shipments`}
          {" · "}Total charges <span className="font-medium text-slate-700">{fmtMoney(totals.charge)}</span>
          {" · "}Total cost <span className="font-medium text-slate-700">{fmtMoney(totals.cost)}</span>
        </span>
        <span className="ml-auto inline-flex flex-wrap items-center gap-2">
          {selCount > 0 ? (
            <>
              <span className="text-slate-700" aria-live="polite">
                <span className="font-semibold">{fmtNum(selCount)}</span> selected · <span className="font-semibold">{fmtMoney(selCharge)}</span> in charges
              </span>
              <button onClick={() => { setSelected(new Set()); setCapNote(null); setAnchorId(null); }} className="underline hover:text-slate-900">Clear</button>
            </>
          ) : (
            <span>Tick shipments to get their invoices (up to {GET_INVOICE_MAX} at a time)</span>
          )}
          <button
            onClick={() => setModalOpen(true)}
            disabled={!!getDisabledReason}
            title={getDisabledReason || "Review the ticked shipments, then start"}
            className="px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Get invoices…
          </button>
        </span>
      </div>
      {capNote ? (
        <div className="shrink-0 mb-2 text-xs text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-lg px-3 py-2">{capNote}</div>
      ) : null}
      {selCount > 0 && getInvoiceBlocked ? (
        <div className="shrink-0 mb-2 text-xs text-slate-600 bg-slate-50 ring-1 ring-slate-200 rounded-lg px-3 py-2">Can't start yet: {getInvoiceBlocked}.</div>
      ) : null}

      <div className="flex-1 min-h-[320px] overflow-auto rounded-xl ring-1 ring-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgb(226_232_240)]">
            <tr className="text-[11px] uppercase tracking-wide text-slate-500">
              <th className="pl-3 pr-1 py-2 w-8 text-left">
                <input
                  type="checkbox"
                  ref={(el) => { if (el) el.indeterminate = headerOn > 0 && !headerAll; }}
                  checked={headerAll}
                  onChange={toggleHeader}
                  disabled={headerRows.length === 0}
                  aria-label="Select the shipments shown"
                  title={`Select the shipments shown (up to ${GET_INVOICE_MAX}). Ones already Done are skipped.`}
                  className="rounded border-slate-300 text-violet-600"
                />
              </th>
              {ERP_COLS.map((c) => {
                const active = c.key === sortKey;
                return (
                  <th key={c.key} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className={"px-3 py-2 font-medium whitespace-nowrap " + (c.numeric ? "text-right" : "text-left")}>
                    <button onClick={() => sortBy(c)} className={"inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-900 " + (active ? "text-slate-900" : "")} title={`Sort by ${c.label.toLowerCase()}`}>
                      {c.label}
                      {active ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.length === 0 ? (
              <tr><td colSpan={colCount} className="p-8 text-center text-slate-500">{all.length === 0 ? "This run has no shipments." : "No shipments match these filters."}</td></tr>
            ) : visible.map((r) => (
              <Fragment key={r.id}>
                <tr className={"cursor-pointer " + (expandedId === r.id ? "bg-sky-50/60" : selected.has(r.id) ? "bg-violet-50/60 hover:bg-violet-50" : "hover:bg-sky-50/50")} onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
                  <td className="pl-3 pr-1 py-2 align-top select-none" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      disabled={!r.shipment}
                      onChange={(e) => toggleRow(r, (e.nativeEvent as MouseEvent).shiftKey === true)}
                      aria-label={`Select shipment ${r.shipment}`}
                      title={r.shipment ? "Shift-click to select a range" : "No shipment number on this row"}
                      className="rounded border-slate-300 text-violet-600"
                    />
                  </td>
                  {ERP_COLS.map((c) => (
                    <td key={c.key} className={"px-3 py-2 align-top " + (c.numeric ? "text-right tabular-nums whitespace-nowrap" : "")}>{c.cell(r)}</td>
                  ))}
                </tr>
                {expandedId === r.id ? (
                  <tr className="bg-slate-50/60"><td colSpan={colCount} className="px-3 py-3"><ErpRowDetail row={r} /></td></tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
        {shown.length > visible.length ? (
          <div className="p-3 text-center border-t border-slate-100">
            <button onClick={() => setLimit((n) => n + ERP_PAGE_SIZE)} className="text-xs px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50">
              Show {fmtNum(Math.min(ERP_PAGE_SIZE, shown.length - visible.length))} more
            </button>
            <span className="ml-2 text-xs text-slate-500">Showing {fmtNum(visible.length)} of {fmtNum(shown.length)}. The download includes all {fmtNum(shown.length)}.</span>
          </div>
        ) : null}
      </div>
      {modalOpen && selCount > 0 ? (
        <GetInvoiceModal
          auditId={run.id}
          items={modalItems}
          onClose={() => setModalOpen(false)}
          onStarted={(request) => {
            setModalOpen(false);
            setSelected(new Set());
            setCapNote(null);
            onInvoicesStarted?.(request.id);
          }}
        />
      ) : null}
    </>
  );
}

// The shared Drawer is 720px wide — too narrow for a 12-column spreadsheet —
// so ERP pulls open in this wider panel with the same look.
function WidePanel({ open, onClose, title, subtitle, children }: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-20 bg-slate-900/30 backdrop-blur-sm transition-opacity ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      />
      <aside className={`fixed top-0 right-0 z-30 h-full w-full lg:w-[94vw] max-w-[1600px] bg-white shadow-2xl ring-1 ring-slate-200 flex flex-col transform transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="shrink-0 border-b border-slate-200 flex items-start justify-between gap-3 px-6 pt-5 pb-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">Invoice audit</div>
            <h2 className="text-lg font-semibold truncate">{title}</h2>
            {subtitle ? <div className="text-sm text-slate-500 truncate">{subtitle}</div> : null}
          </div>
          <button onClick={onClose} className="h-9 w-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 shrink-0" aria-label="Close" title="Close (Esc)">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col">{children}</div>
      </aside>
    </>
  );
}

// FreightPOP's own .xlsx files, kept with each pull: same columns as FreightPOP's
// export, so they drop straight into the team's macros and workbooks.
function ExcelDownloads({ auditId, files }: { auditId: string; files: InvoiceAuditFiles | null }) {
  const [busy, setBusy] = useState<AuditExcelWhich | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function download(which: AuditExcelWhich) {
    if (busy) return;
    setBusy(which); setError(null);
    try { await downloadAuditExcel(auditId, which); }
    catch (e) { setError((e as Error).message || "Could not download the file."); }
    finally { setBusy(null); }
  }
  const kept = files?.not_exported === true;
  const link = "text-xs text-sky-700 hover:text-sky-900 underline disabled:opacity-50";
  return (
    <>
      <button
        onClick={() => download("not-exported")}
        disabled={!kept || !!busy}
        title={kept
          ? "FreightPOP's own Excel export for this pull: only the rows with Exported to ERP = false, sorted by charge, same columns as FreightPOP"
          : "No Excel file was kept for this pull — run a new pull"}
        className="px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download className="h-3.5 w-3.5" />
        {busy === "not-exported" ? "Downloading…" : "Download Excel (FreightPOP format)"}
      </button>
      {files?.full ? (
        <button onClick={() => download("full")} disabled={!!busy} className={link} title="The whole report FreightPOP exported, including rows already exported to ERP (.xlsx)">
          {busy === "full" ? "Downloading…" : "Full report"}
        </button>
      ) : null}
      {files?.recently_approved ? (
        <button onClick={() => download("recently-approved")} disabled={!!busy} className={link} title="FreightPOP's Recently Approved export from the last approval check (.xlsx)">
          {busy === "recently-approved" ? "Downloading…" : "Recently approved"}
        </button>
      ) : null}
      {files?.audit_history ? (
        <button onClick={() => download("audit-history")} disabled={!!busy} className={link} title="FreightPOP's Audit History export from the last approval check (.xlsx)">
          {busy === "audit-history" ? "Downloading…" : "Audit history (Excel)"}
        </button>
      ) : null}
      {!kept ? <span className="text-xs text-slate-500">No Excel file was kept for this pull — run a new pull</span> : null}
      {error ? <span role="alert" className="text-xs text-rose-700 break-words">{error}</span> : null}
    </>
  );
}

export function InvoiceAuditsPage() {
  const [rows, setRows] = useState<InvoiceAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<InvoiceAuditDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reanBusy, setReanBusy] = useState(false);
  const [reanError, setReanError] = useState<string | null>(null);
  // Bumped to re-fetch the open run (a pull that just finished may already be open).
  const [detailNonce, setDetailNonce] = useState(0);
  // A run we know is an ERP pull before the list or the run itself has loaded.
  const [erpHintId, setErpHintId] = useState<string | null>(null);
  // What the monitor card is doing, and the Get Invoice run or approval check this page last queued.
  const [monitor, setMonitor] = useState<ErpMonitorStatus | null>(null);
  const [invoiceRun, setInvoiceRun] = useState<{ requestId: string; auditId: string; kind: "get_invoice" | "approval_check" } | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // The open run lives in the URL (?run=<id>) so it can be linked to.
  const [params, setParams] = useSearchParams();
  const openId = params.get("run");
  const setOpenId = useCallback((id: string | null) => {
    setParams((p) => { const n = new URLSearchParams(p); if (id) n.set("run", id); else n.delete("run"); return n; }, { replace: true });
  }, [setParams]);
  const close = useCallback(() => setOpenId(null), [setOpenId]);

  const loadList = useCallback(() => {
    return api.audits.invoice.list()
      .then((r) => setRows(r.data))
      .catch(() => { /* keep whatever is already listed */ })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    setReanError(null);
    setDetailError(null);
    setApprovalError(null);
    if (!openId) { setDetail(null); return; }
    setDetail((prev) => (prev && prev.run.id === openId ? prev : null));
    let cancelled = false;
    api.audits.invoice.get(openId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) { setDetail(null); setDetailError((e as Error).message || "Could not load this run."); } });
    return () => { cancelled = true; };
  }, [openId, detailNonce]);

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

  // Re-read the open run without blanking it (pills move from Requested to Done,
  // and the Approved by column fills in when an approval check finishes).
  const refreshOpenRun = useCallback(() => {
    if (!openId) return;
    api.audits.invoice.get(openId)
      .then((d) => setDetail((cur) => (cur && cur.run.id === d.run.id ? d : cur)))
      .catch(() => { /* keep what is shown; the next refresh tries again */ });
  }, [openId]);
  const onSettled = useCallback(() => { void loadList(); refreshOpenRun(); }, [loadList, refreshOpenRun]);
  const approvalsRunning = monitor?.active === "approval_check";
  const jobUpdatingRows = monitor?.active === "get_invoice" || approvalsRunning;
  useEffect(() => {
    if (!jobUpdatingRows || !openId) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") refreshOpenRun(); }, 10_000);
    return () => clearInterval(id);
  }, [jobUpdatingRows, openId, refreshOpenRun]);

  // The person confirmed the modal: step out of the run so the monitor card,
  // which sits behind the panel, is what they see.
  function onInvoicesStarted(requestId: string) {
    if (openId) setInvoiceRun({ requestId, auditId: openId, kind: "get_invoice" });
    setOpenId(null);
  }
  // One hosted-browser job at a time: a pull, an invoice run or an approval check.
  const getInvoiceBlocked = monitor?.active === "get_invoice" ? "An invoice run is already queued or running"
    : monitor?.active === "erp_audit" ? "A pull from FreightPOP is queued or running. Wait for it to finish"
    : monitor?.active === "approval_check" ? "An approval check is queued or running. Wait for it to finish"
    : monitor?.blocked ?? null;

  // Unlike Get Invoice, the run stays open: the check changes nothing in
  // FreightPOP, and the table fills in by itself when it finishes.
  async function checkApprovals() {
    if (!openId || approvalBusy) return;
    const auditId = openId;
    setApprovalBusy(true); setApprovalError(null);
    try {
      const res = await requestApprovalCheck(auditId);
      if ((res.request?.scope as string) !== APPROVAL_SCOPE) {
        // A server that doesn't know this job yet answers with a regular scrape request.
        setApprovalError("The server queued a regular scrape instead of the approval check. Check approvals needs the next server update.");
      } else {
        setInvoiceRun({ requestId: res.request.id, auditId, kind: "approval_check" });
      }
    } catch (e) {
      setApprovalError((e as Error).message || "Could not start the approval check.");
    } finally {
      setApprovalBusy(false);
    }
  }

  function onPullFinished(auditId: string) {
    setErpHintId(auditId);
    void loadList();
    setOpenId(auditId);
    setDetailNonce((n) => n + 1);
  }

  const openRun = openId ? (detail?.run.id === openId ? detail.run : rows.find((r) => r.id === openId)) : undefined;
  const erpOpen = !!openId && (openRun ? isErpRun(openRun) : erpHintId === openId);
  const erpDetail = erpOpen && detail && detail.run.id === openId ? detail : null;
  const erpFiles = erpDetail ? erpDetail.files ?? erpDetail.run.files ?? null : null;
  const approvalSummary = erpDetail ? erpDetail.approval_summary ?? erpDetail.run.approval_summary ?? null : null;
  const approvalBlocked = approvalsRunning ? "An approval check is already queued or running" : getInvoiceBlocked;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 max-w-3xl">
        Invoice audits compare what was billed with what each shipment cost. Runs come from a carrier bill uploaded
        with the extension, or from a pull of the shipments not yet exported to ERP, audited from the highest charge down.
        Open a run to see its shipments.
      </p>
      {/* The monitor is its own card, with its own heading and controls. */}
      <ErpPullMonitor onFinished={onPullFinished} onSettled={onSettled} started={invoiceRun} onStatus={setMonitor} />
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5 font-medium">Run</th>
              <th className="px-4 py-2.5 font-medium">Source</th>
              <th className="px-4 py-2.5 font-medium">Date Range</th>
              <th className="px-4 py-2.5 font-medium text-right">Rows</th>
              <th className="px-4 py-2.5 font-medium text-right">Match</th>
              <th className="px-4 py-2.5 font-medium text-right">Discrep.</th>
              <th className="px-4 py-2.5 font-medium text-right">Unmatched</th>
              <th className="px-4 py-2.5 font-medium">Run By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? <LoadingState variant="row" colSpan={8} />
              : rows.length === 0 ? <tr><td colSpan={8} className="p-8 text-center text-slate-500">No invoice audits yet.</td></tr>
                : rows.map((r) => {
                  const erp = isErpRun(r);
                  return (
                    <tr key={r.id} className="hover:bg-sky-50/50 cursor-pointer" onClick={() => setOpenId(r.id)}>
                      <td className="px-4 py-2.5 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                      <td className="px-4 py-2.5">
                        {erp ? (
                          <>
                            <span className="text-xs rounded-full bg-sky-100 text-sky-700 px-2 py-0.5 whitespace-nowrap">Not exported to ERP</span>
                            <div className="text-xs text-slate-500 mt-0.5">{r.carrier_bill_file || ERP_SOURCE}</div>
                          </>
                        ) : (
                          <span className="text-slate-600">{r.carrier_bill_file || "Carrier bill"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{fmtDate(r.date_from)} → {fmtDate(r.date_to)}</td>
                      <td className="px-4 py-2.5 text-right">{fmtNum(r.total_rows)}</td>
                      <td className="px-4 py-2.5 text-right">{fmtNum(r.match_count)}</td>
                      <td className="px-4 py-2.5 text-right">{fmtNum(r.discrepancy_count)}</td>
                      <td className="px-4 py-2.5 text-right" title={erp ? "Shipments with no invoice yet" : undefined}>
                        {fmtNum(r.unmatched_count)}
                        {erp ? <div className="text-[11px] text-slate-500 whitespace-nowrap">no invoice yet</div> : null}
                      </td>
                      <td className="px-4 py-2.5">{r.run_by || "—"}</td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      <Drawer open={!!openId && !erpOpen} onClose={close} title="Invoice Audit" subtitle={detail ? fmtDateTime(detail.run.created_at) : undefined}>
        {detail && !erpOpen ? (
          <>
            <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
              <ReanalyzeButton busy={reanBusy} onClick={reanalyze} />
              <ShareButton resourceType="invoice_audit" resourceId={detail.run.id} defaultLabel={`Invoice Audit ${fmtDate(detail.run.date_from)}–${fmtDate(detail.run.date_to)}`} />
            </div>
            {reanError ? <div className="mb-3"><ErrorBlock compact>{reanError}</ErrorBlock></div> : null}
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
        ) : detailError && !erpOpen ? <ErrorBlock compact>{detailError}</ErrorBlock> : <LoadingState variant="inline" />}
      </Drawer>

      <WidePanel
        open={erpOpen}
        onClose={close}
        title="Shipments not exported to ERP"
        subtitle={erpDetail ? `${erpDetail.run.carrier_bill_file || ERP_SOURCE} · ${fmtDateTime(erpDetail.run.created_at)}` : undefined}
      >
        {erpDetail ? (
          <>
            <div className="shrink-0">
              <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
                <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
                  <ExcelDownloads key={erpDetail.run.id} auditId={erpDetail.run.id} files={erpFiles} />
                  <button
                    onClick={checkApprovals}
                    disabled={!!approvalBlocked || approvalBusy}
                    title={approvalBlocked || "Takes FreightPOP's Recently Approved list and shows who approved each invoice here: EDI or a person. Nothing is changed in FreightPOP."}
                    className="text-xs px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 font-medium inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className={`h-3.5 w-3.5 ${approvalsRunning ? "animate-pulse" : ""}`} />
                    {approvalBusy ? "Queuing…" : approvalsRunning ? "Checking approvals…" : approvalSummary ? "Check approvals again" : "Check approvals"}
                  </button>
                  <ReanalyzeButton busy={reanBusy} onClick={reanalyze} summaryOnly />
                </div>
                <ShareButton resourceType="invoice_audit" resourceId={erpDetail.run.id} defaultLabel={`Not exported to ERP ${fmtDate(erpDetail.run.date_from)}–${fmtDate(erpDetail.run.date_to)}`} />
              </div>
              {reanError ? <div className="mb-3"><ErrorBlock compact>{reanError}</ErrorBlock></div> : null}
              {approvalError ? <div className="mb-3"><ErrorBlock compact>{approvalError}</ErrorBlock></div> : null}
              {approvalsRunning ? (
                <div role="status" className="mb-3 text-xs text-violet-900 bg-violet-50 ring-1 ring-violet-200 rounded-lg px-3 py-2">
                  Checking approvals in the invoicing session. The Approved by column fills in when it finishes. Close this panel to watch it or stop it.
                </div>
              ) : approvalBlocked && !approvalSummary ? (
                <div className="mb-3 text-xs text-slate-500">Check approvals can't start yet: {approvalBlocked}.</div>
              ) : null}
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-4">
                <Field label="Range">{fmtDate(erpDetail.run.date_from)} → {fmtDate(erpDetail.run.date_to)}</Field>
                <Field label="Shipments">{fmtNum(erpDetail.run.total_rows)}</Field>
                <Field label="Match">{fmtNum(erpDetail.run.match_count)}</Field>
                <Field label="Discrepancy">{fmtNum(erpDetail.run.discrepancy_count)}</Field>
                <Field label="No invoice yet">{fmtNum(erpDetail.run.unmatched_count)}</Field>
                <Field label="Run by">{erpDetail.run.run_by || "—"}</Field>
              </div>
              {erpDetail.run.exec_summary ? (
                <details className="mb-4 rounded-lg ring-1 ring-slate-200 bg-slate-50">
                  <summary className="px-3 py-2 text-xs font-medium text-slate-700 cursor-pointer">Summary</summary>
                  <pre className="px-3 pb-3 text-xs whitespace-pre-wrap">{erpDetail.run.exec_summary}</pre>
                </details>
              ) : null}
              {erpDetail.run.total_rows != null && erpDetail.rows.length < erpDetail.run.total_rows ? (
                <div className="mb-3 text-xs text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-lg px-3 py-2">
                  Only {fmtNum(erpDetail.rows.length)} of this run's {fmtNum(erpDetail.run.total_rows)} shipments were loaded. The table, totals and download cover those {fmtNum(erpDetail.rows.length)}.
                </div>
              ) : null}
            </div>
            <ErpRowsTable key={erpDetail.run.id} run={erpDetail.run} rows={erpDetail.rows} getInvoiceBlocked={getInvoiceBlocked} onInvoicesStarted={onInvoicesStarted} approvalSummary={approvalSummary} />
          </>
        ) : detailError && erpOpen ? <ErrorBlock compact>{detailError}</ErrorBlock> : <LoadingState variant="inline" />}
      </WidePanel>
    </div>
  );
}
