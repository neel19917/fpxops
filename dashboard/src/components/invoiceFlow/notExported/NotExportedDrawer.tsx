import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Drawer } from "../../Drawer";
import { freightpopTrackingUrl } from "../../../lib/format";
import type { NotExportedRow } from "../../../lib/invoiceFlow";
import { StatusPill, fmtDay, fmtMoney, fmtWhen } from "./format";

// Read-only details of one not-exported shipment.

export default function NotExportedDrawer({ row, onClose }: { row: NotExportedRow | null; onClose: () => void }) {
  const fpUrl = row ? freightpopTrackingUrl(row.tracking) : null;
  return (
    <Drawer
      open={!!row}
      onClose={onClose}
      eyebrow="Not exported to ERP"
      title={row ? `Shipment ${row.shipment_id}` : ""}
      subtitle={row ? [row.customer, row.carrier].filter(Boolean).join(" · ") || undefined : undefined}
    >
      {row ? (
        <div className="p-6 space-y-6">
          <div className="flex items-center gap-3">
            <StatusPill status={row.status} />
            {fpUrl ? (
              <a href={fpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-sky-700 hover:underline">
                Open in FreightPOP <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <Field label="Shipment">{row.shipment_id}</Field>
            <Field label="Status"><StatusPill status={row.status} /></Field>
            <Field label="Customer">{row.customer || "—"}</Field>
            <Field label="Carrier">{row.carrier || "—"}</Field>
            <Field label="Tracking">{row.tracking || "—"}</Field>
            <Field label="Ship date">{fmtDay(row.ship_date)}</Field>
            <Field label="Charge"><span className="tabular-nums">{fmtMoney(row.charge)}</span></Field>
            <Field label="Cost"><span className="tabular-nums">{fmtMoney(row.cost)}</span></Field>
            <Field label="Invoice number">{row.invoice_number || "—"}</Field>
            <Field label="Approved by">{row.approved_by || "—"}</Field>
            <Field label="Documents saved">{row.docs_saved ? "Yes" : "No"}</Field>
            <Field label="Run #">{row.run_number != null ? `#${row.run_number}` : "—"}</Field>
            <Field label="Last pulled">{fmtWhen(row.last_pulled_at)}</Field>
          </dl>
        </div>
      ) : null}
    </Drawer>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</dt>
      <dd className="mt-0.5 text-slate-900 break-words">{children}</dd>
    </div>
  );
}
