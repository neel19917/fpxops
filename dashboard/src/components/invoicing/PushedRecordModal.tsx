import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ExternalLink, FileImage, Loader2, X } from "lucide-react";
import { fetchPushedRecords, type PushedRecords, type PushedRow } from "../../lib/erpPushed";
import { openInFreightPop } from "../../lib/freightpopFrame";
import { fmtDateTime } from "../../lib/format";
import { SavedFiles } from "./InvoiceRecordModal";

// One pushed invoice: the screenshots and documents FPX saved for its
// shipment, and a way to open the shipment in FreightPOP itself. Read only.

const money = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));

/** FreightPOP's own Shipment Details page for the shipment, by its quote id. */
function shipmentUrl(row: PushedRow, quoteId: string): string {
  const p = new URLSearchParams({ FromHistory: "true", QuoteID: quoteId, FromEmailLink: "false", IsFromIframe: "false", bh: "true" });
  if (row.charge != null) p.set("Amount", String(row.charge));
  if (row.cost != null) p.set("co", String(row.cost));
  if (row.charge != null && row.cost != null) p.set("pr", (Math.round((row.charge - row.cost) * 100) / 100).toString());
  return `https://app.freightpop.com/ShipmentDetail.html?${p.toString()}`;
}

type State = { status: "loading" } | { status: "ready"; data: PushedRecords } | { status: "error"; message: string };

export function PushedRecordModal({ row, onClose }: { row: PushedRow; onClose: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const id = row.shipment_id || "";

  useEffect(() => {
    let gone = false;
    setState({ status: "loading" });
    fetchPushedRecords(id).then(
      (data) => { if (!gone) setState({ status: "ready", data }); },
      (e: unknown) => { if (!gone) setState({ status: "error", message: (e as Error)?.message || "The saved files could not be loaded." }); },
    );
    return () => { gone = true; };
  }, [id, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const data = state.status === "ready" ? state.data : null;
  // Files are kept per pull; one viewer for each pull that saved any.
  const groups = new Map<string, { files: string[]; at: string | null; by: string | null }>();
  for (const r of data?.records ?? []) {
    if (!r.audit_id || r.files.length === 0) continue;
    const g = groups.get(r.audit_id) ?? { files: [], at: r.captured_at, by: r.captured_by };
    for (const f of r.files) if (!g.files.includes(f)) g.files.push(f);
    groups.set(r.audit_id, g);
  }
  const quoteId = data?.quote_id ?? null;
  const fileId = (id || "shipment").replace(/[^\w.-]+/g, "_");

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="pushed-record-title" className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200">
          <div className="min-w-0">
            <h2 id="pushed-record-title" className="text-lg font-semibold flex items-center gap-2">
              <FileImage className="h-5 w-5 text-violet-600 shrink-0" />
              <span className="break-words">Shipment {id || "—"}</span>
            </h2>
            <p className="text-sm text-slate-600 mt-1">The screenshots and documents FPX saved from FreightPOP for this shipment.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={!quoteId}
              onClick={() => { if (quoteId) { openInFreightPop({ url: shipmentUrl(row, quoteId), label: `Shipment ${id}`, customerName: row.customer_name }); onClose(); } }}
              title={quoteId ? "Open this shipment in FreightPOP, in your hosted browser" : "FreightPOP's quote id for this shipment has not been read, so it cannot be opened from here"}
              className="px-3 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ExternalLink className="h-4 w-4" /> Open in FreightPOP
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 text-sm">
            {([
              ["Customer", row.customer_name], ["Carrier", row.carrier], ["Customer invoice", row.billing_invoice_number], ["Carrier invoice", row.invoice_number],
              ["Charge", money(row.charge)], ["Cost", money(row.cost)], ["Approved amount", money(row.approved_invoice_amount)], ["Pushed", row.pushed_date],
            ] as const).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="text-slate-900 mt-0.5 break-words">{value || "—"}</dd>
              </div>
            ))}
          </dl>

          {state.status === "loading" ? (
            <div role="status" className="rounded-xl ring-1 ring-slate-200 px-6 py-10 text-center text-sm text-slate-500 inline-flex w-full items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the saved files…
            </div>
          ) : state.status === "error" ? (
            <div role="alert" className="rounded-xl p-3 text-sm flex items-start gap-2 ring-1 bg-rose-50 ring-rose-200 text-rose-800">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 break-words">{state.message}</div>
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="shrink-0 text-xs px-2 py-0.5 rounded-md ring-1 ring-rose-300 bg-white hover:bg-rose-100">Try again</button>
            </div>
          ) : groups.size === 0 ? (
            <div className="rounded-xl ring-1 ring-slate-200 px-6 py-10 text-center text-sm text-slate-600">
              <div className="font-medium text-slate-900">Nothing has been saved for this shipment yet.</div>
              <div className="mt-1">FPX only keeps screenshots and documents for shipments a Get Invoice run has opened. Use Open in FreightPOP to see this one live.</div>
            </div>
          ) : (
            [...groups.entries()].map(([auditId, g]) => (
              <section key={auditId} className="space-y-3">
                <div className="text-xs text-slate-500">
                  Saved {g.at ? fmtDateTime(g.at) : "at an unknown time"}{g.by ? ` by ${g.by}` : ""} · {g.files.length} file{g.files.length === 1 ? "" : "s"}
                </div>
                <SavedFiles auditId={auditId} files={g.files} fileId={fileId} />
              </section>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
