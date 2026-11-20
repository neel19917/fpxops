import type { NotExportedRow } from "../../../lib/invoiceFlow";

// Small display helpers shared by the not-exported list and its drawer.

export type NotExportedStatus = NotExportedRow["status"];

export const STATUS_LABEL: Record<NotExportedStatus, string> = {
  no_invoice: "No invoice",
  invoice_not_approved: "Invoice not approved",
  approved_ready: "Approved – ready to export",
};

const STATUS_CLS: Record<NotExportedStatus, string> = {
  no_invoice: "bg-slate-100 text-slate-600 ring-slate-200",
  invoice_not_approved: "bg-amber-50 text-amber-700 ring-amber-200",
  approved_ready: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};

export function StatusPill({ status }: { status: NotExportedStatus | string | null | undefined }) {
  const key = (status && status in STATUS_LABEL ? status : "no_invoice") as NotExportedStatus;
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS_CLS[key]}`}>
      {STATUS_LABEL[key]}
    </span>
  );
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtMoney(n: number | string | null | undefined): string {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return MONEY.format(v);
}

// Ship dates come back as plain YYYY-MM-DD; parse them as local dates so the
// day does not shift by the timezone.
export function fmtDay(s: string | null | undefined): string {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtWhen(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function errorText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return fallback;
}
