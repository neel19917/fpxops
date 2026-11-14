import { approvalDate, approvalGroup, getInvoiceLabel, toApprovalState } from "../../lib/erpPull";
import type { ApprovalState, GetInvoiceState, InvoiceAuditRow } from "../../lib/types";

// What the Invoicing page knows about one shipment, and which of the three
// buckets it is in. A shipment is in exactly one bucket:
//
//   sent          Get Invoice was pressed (done), or is being pressed (requested).
//   approved      Not sent, and FreightPOP shows an approved carrier invoice:
//                 either the History Report does (an invoice amount, and no
//                 "invoice not approved" flag) or the Recently Approved check does.
//   not-approved  Everything else: a carrier invoice that is not approved yet,
//                 or no carrier invoice at all.

export type BucketKey = "approved" | "not-approved" | "sent";
/** Who approved it. "none" = approved per the report, but the approver isn't listed. */
export type ApproverGroup = "shaun" | "edi" | "person" | "none";
/** Why it isn't approved: an invoice arrived but isn't approved, or no invoice yet. */
export type WaitingGroup = "received" | "none";

export const NOT_APPROVED_FLAG = "invoice not approved";

export interface Row {
  id: string;
  shipment: string;
  customer: string;
  carrier: string;
  shippedText: string;
  charge: number | null;
  /** The History Report's invoice amount (approved, else not approved). */
  invoice: number | null;
  cost: number | null;
  /** Not-approved shipments: the invoice that is waiting, and how far it is from the cost. */
  pendingInvoice: number | null;
  pendingDiff: number | null;
  status: string;
  flags: string[];
  ap: ApprovalState | null;
  gi: GetInvoiceState | null;
  bucket: BucketKey;
  approver: ApproverGroup | null;
  approverName: string;
  approvedOn: string;
  /** Notes from FreightPOP's Audit page for this shipment's invoice. */
  notes: string;
  waiting: WaitingGroup | null;
  /** The last Get Invoice try on this shipment failed. */
  failed: boolean;
  search: string;
}

// FreightPOP's report values can be numbers or text ("$1,234.50", "(12.00)").
export function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const text = String(v).trim();
  const negative = /^\(.*\)$/.test(text);
  const n = Number(text.replace(/[$,\s()]/g, ""));
  if (text === "" || !Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// A date-only string is UTC midnight, which shows as the day before in US time zones.
function toDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return isNaN(d.getTime()) ? null : d;
}

export function dayLabel(s: string | null | undefined, withYear = false): string {
  const d = toDate(s);
  if (!d) return s ? String(s) : "";
  return d.toLocaleDateString(undefined, withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
}

function toInvoiceState(v: unknown): GetInvoiceState | null {
  if (!v || typeof v !== "object") return null;
  const state = v as GetInvoiceState;
  return typeof state.status === "string" && getInvoiceLabel(state.status) ? state : null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function toRow(row: InvoiceAuditRow): Row {
  const raw = row.raw ?? {};
  const shipment = row.shipment_id ?? "";
  const customer = row.customer_name ?? "";
  const carrier = row.carrier ?? "";
  const shipped = raw.shipped_date ? String(raw.shipped_date) : null;
  const flags = Array.isArray(raw.flags) ? raw.flags.map(String) : [];
  const ap = toApprovalState(raw.approval);
  const gi = toInvoiceState(raw.get_invoice);

  const sent = gi?.status;
  const flagged = flags.includes(NOT_APPROVED_FLAG);
  const approvedByReport = row.bill_amount != null && !flagged;
  const approvedByCheck = ap?.status === "approved";
  const bucket: BucketKey = sent === "done" || sent === "requested" ? "sent"
    : approvedByReport || approvedByCheck ? "approved"
    : "not-approved";

  // The approver comes from the Recently Approved check only. Approved per the
  // report but not in that list (or listed without a name) = not listed.
  const group = approvedByCheck ? approvalGroup(ap) : null;
  const approver: ApproverGroup | null = bucket !== "approved" ? null
    : group === "edi" || group === "shaun" || group === "person" ? group
    : "none";

  const invoice = toNum(row.bill_amount);
  const cost = toNum(row.shipment_cost);
  const notApprovedAmount = toNum(raw.not_approved_amount);
  const pendingInvoice = flagged ? (notApprovedAmount ? notApprovedAmount : invoice) : null;

  return {
    id: row.id,
    shipment, customer, carrier,
    shippedText: shipped ? dayLabel(shipped, true) : "",
    charge: toNum(raw.charge),
    invoice, cost,
    pendingInvoice,
    pendingDiff: pendingInvoice != null && cost != null ? round2(pendingInvoice - cost) : null,
    status: row.status ?? "",
    flags, ap, gi, bucket, approver,
    approverName: approver === "shaun" || approver === "person" ? String(ap?.approved_by ?? "") : "",
    approvedOn: approvedByCheck ? approvalDate(ap) : "",
    notes: approvedByCheck ? String(ap?.notes ?? "").trim() : "",
    waiting: bucket !== "not-approved" ? null : flagged ? "received" : "none",
    failed: sent === "failed",
    search: `${shipment} ${customer} ${carrier} ${approvedByCheck ? String(ap?.notes ?? "") : ""}`.toLowerCase(),
  };
}

export const byCharge = (a: Row, b: Row) => (b.charge ?? -Infinity) - (a.charge ?? -Infinity) || a.shipment.localeCompare(b.shipment);
export const sumCharge = (rows: Row[]) => rows.reduce((t, r) => t + (r.charge ?? 0), 0);

export function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/** Whole dollars, for the big totals. */
export function fmtDollars(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** "+$45.00" / "−$12.00" / "$0.00". */
export function fmtSigned(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) < 0.005) return fmtMoney(0);
  return (n > 0 ? "+" : "−") + fmtMoney(Math.abs(n));
}

export function ago(s: string | null | undefined, now: number): string {
  const t = s ? Date.parse(s) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} ${day === 1 ? "day" : "days"} ago`;
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
