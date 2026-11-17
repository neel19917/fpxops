import { useState, type ReactNode } from "react";
import { ExternalLink, FileImage } from "lucide-react";
import { openInFreightPop } from "../../lib/freightpopFrame";
import { GET_INVOICE_MAX, approvalHover } from "../../lib/erpPull";
import { fmtDateTime } from "../../lib/format";
import { InvoiceRecordModal } from "./InvoiceRecordModal";
import { fmtMoney, fmtSigned, type BucketKey, type Row } from "./model";

// One table, four shapes: the columns follow the selected bucket.

const TH = "px-4 py-3 font-medium whitespace-nowrap";
const TD = "px-4 py-3.5 align-top";
const MONEY = TD + " text-right tabular-nums whitespace-nowrap text-slate-900";

/** Who approved the invoice. Shaun is the name the team asks about, so he stands out. */
function ApproverPill({ row }: { row: Row }) {
  const base = "inline-block text-xs rounded-full px-2.5 py-1 whitespace-nowrap ";
  // "Approved by Shaun Zimmerman on Nov 13 · from Audit History"
  const title = approvalHover(row.ap) || undefined;
  switch (row.approver) {
    case "shaun":
      return <span title={title} className={base + "bg-violet-600 text-white font-medium"}>{row.approverName}</span>;
    case "person":
      return <span title={title} className={base + "bg-violet-50 text-violet-800 ring-1 ring-violet-200"}>{row.approverName}</span>;
    case "edi":
      return <span title={title ?? "Approved automatically by EDI"} className={base + "bg-sky-50 text-sky-800 ring-1 ring-sky-200"}>EDI</span>;
    default:
      return (
        <span
          title="FreightPOP's report shows an approved invoice, but the shipment is not in its Recently Approved list, so the approver's name isn't available."
          className="text-xs text-slate-400 whitespace-nowrap"
        >
          Approver not listed
        </span>
      );
  }
}

/**
 * Opens the saved screenshots of the invoice. Only for rows that have some.
 * Outside the list you tick from, a click anywhere on the row does the same;
 * this small button is what the keyboard reaches, and what a ticking row uses.
 */
function RecordButton({ row, onOpen }: { row: Row; onOpen: (row: Row) => void }) {
  if (row.shots.length === 0) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(row); }}
      aria-label={`View invoice record for shipment ${row.shipment}`}
      title="View the invoice record: the screenshot FPX saved of the invoice FreightPOP showed"
      className="inline-flex items-center justify-center h-6 w-6 rounded-md text-violet-700 hover:bg-violet-100 hover:text-violet-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
    >
      <FileImage className="h-4 w-4 shrink-0" aria-hidden="true" />
    </button>
  );
}

/** Why a try at getting an invoice did not work, in plain words. The job's own note stays behind Details. */
function plainReason(note: string | null | undefined): string {
  const t = String(note ?? "");
  if (/stopp/i.test(t)) return "The run was stopped before this one finished";
  if (/sign(ed)?[ -]?in|log[ -]?in/i.test(t)) return "FreightPOP asked to sign in again";
  if (/time[d]?[ -]?out|took too long/i.test(t)) return "FreightPOP took too long to answer";
  if (/not approved/i.test(t)) return "The invoice is not approved in FreightPOP";
  if (/not found|could ?n[o']t find|no (matching )?(row|shipment)/i.test(t)) return "Could not find the shipment in FreightPOP";
  if (/could ?n[o']t open|did ?n[o']t open|failed to open/i.test(t)) return "Could not open the shipment";
  return "Could not get the invoice";
}

/** The job's own step-by-step note, folded away: useful when something needs explaining, noise otherwise. */
function RawNote({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <details className="mt-1 text-xs text-slate-500" onClick={(e) => e.stopPropagation()}>
      <summary className="cursor-pointer select-none w-fit text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500">Details</summary>
      <div className="mt-1 break-words max-w-sm">{note}</div>
    </details>
  );
}

/** FreightPOP's own Shipment Details page for a shipment, by its quote id. */
function shipmentUrl(row: Row): string | null {
  const q = row.check?.quote_id;
  if (!q) return null;
  const p = new URLSearchParams({ FromHistory: "true", QuoteID: q, FromEmailLink: "false", IsFromIframe: "false", bh: "true" });
  if (row.charge != null) p.set("Amount", String(row.charge));
  if (row.cost != null) p.set("co", String(row.cost));
  if (row.charge != null && row.cost != null) p.set("pr", (Math.round((row.charge - row.cost) * 100) / 100).toString());
  return `https://app.freightpop.com/ShipmentDetail.html?${p.toString()}`;
}
function openShipment(row: Row) {
  const url = shipmentUrl(row);
  if (url) openInFreightPop({ url, label: `Shipment ${row.shipment}`, customerName: row.customer });
}

/** The approval check of one shipment: its score, then what is missing, wrong or worth a look. */
function CheckCells({ row }: { row: Row }) {
  const c = row.check;
  if (!c) return <><td className={TD + " text-slate-300"}>—</td><td className={TD + " pr-6 text-slate-300"}>—</td></>;
  const tone = c.confidence >= 90 ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : c.confidence >= 70 ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-rose-50 text-rose-800 ring-rose-200";
  const groups: [string, string[], string][] = [
    ["Does not match", c.issues, "text-rose-700"],
    ["Missing", c.missing, "text-slate-700"],
    ["Check", c.cautions, "text-amber-800"],
  ];
  return (
    <>
      <td className={TD + " whitespace-nowrap"}>
        <span className={"inline-block text-xs font-medium rounded-full px-2.5 py-1 tabular-nums ring-1 " + tone}>{c.confidence}%</span>
      </td>
      <td className={TD + " pr-6 max-w-[34rem]"}>
        {groups.filter(([, list]) => list.length).map(([label, list, cls]) => (
          <div key={label} className="text-xs leading-5 break-words">
            <span className="text-slate-500">{label}: </span>
            <span className={cls}>{list.join(" · ")}</span>
          </div>
        ))}
      </td>
    </>
  );
}

function Result({ row }: { row: Row }) {
  const inProgress = row.gi?.status === "requested";
  return (
    <>
      <span className={"inline-block text-xs rounded-full px-2.5 py-1 whitespace-nowrap ring-1 "
        + (inProgress ? "bg-sky-50 text-sky-800 ring-sky-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200")}>
        {inProgress ? "Sending now" : "Invoice sent"}
      </span>
      <div className="text-xs text-slate-500 mt-1">
        {inProgress ? "FPX is working on this one" : row.shots.length ? "Record saved. Click the row to see it." : "No record was saved"}
      </div>
      <RawNote note={row.gi?.note} />
    </>
  );
}

export function ShipmentTable({ bucket, auditId, rows, empty, selected, atCap, allPicked, canPickAll, capped, onToggle, onToggleAll, footer }: {
  bucket: BucketKey;
  /** The pull these rows belong to: the saved invoice screenshots are fetched from it. */
  auditId: string | null;
  rows: Row[];
  /** Shown in place of the rows when there are none. */
  empty: ReactNode;
  selected: Set<string>;
  /** A full run's worth is already ticked: the rest can't be added. */
  atCap: boolean;
  allPicked: boolean;
  canPickAll: boolean;
  /** "Select all" takes only the highest charges, one run's worth. */
  capped: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  footer?: ReactNode;
}) {
  const pick = bucket === "approved";
  // The shipment whose saved invoice record is open, if any.
  const [record, setRecord] = useState<Row | null>(null);
  const colCount = bucket === "approved" ? 7 : bucket === "not-approved" ? 7 : 6;
  const review = bucket === "review";
  return (
    <div className="max-h-[72vh] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-[1] bg-white shadow-[inset_0_-1px_0_var(--color-slate-200)]">
          <tr className="text-left text-xs text-slate-500">
            {pick ? (
              <th className="pl-6 pr-2 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={onToggleAll}
                  disabled={!canPickAll}
                  aria-label={capped ? `Select the ${GET_INVOICE_MAX} highest charges` : "Select all"}
                  title={capped ? `Selects the ${GET_INVOICE_MAX} highest charges: one run's worth` : "Select all"}
                  className="h-4 w-4 rounded border-slate-300 accent-violet-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                />
              </th>
            ) : null}
            <th className={TH + (pick ? "" : " pl-6")}>Shipment</th>
            <th className={TH}>Customer</th>
            <th className={TH}>Carrier</th>
            <th className={TH + " text-right"}>Charge</th>
            {review ? (
              <>
                <th className={TH}>Score</th>
                <th className={TH + " pr-6"}>What is missing or needs a look</th>
              </>
            ) : bucket === "approved" ? (
              <>
                <th className={TH}>Approved by</th>
                <th className={TH}>Approved on</th>
                <th className={TH + " pr-6"}>Notes</th>
              </>
            ) : bucket === "not-approved" ? (
              <>
                <th className={TH + " text-right"}>Invoice amount</th>
                <th className={TH + " text-right"}>Difference</th>
                <th className={TH + " pr-6"}>Shipped</th>
              </>
            ) : (
              <>
                <th className={TH}>Result</th>
                <th className={TH + " pr-6"}>When</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr><td colSpan={colCount} className="px-6 py-16 text-center text-sm text-slate-500">{empty}</td></tr>
          ) : rows.map((r) => {
            const on = pick && selected.has(r.id);
            const full = pick && !on && atCap;
            const when = r.gi?.at || r.gi?.requested_at;
            // What a click on the row does: tick it in the list you send from;
            // elsewhere open its saved invoice record, or (needs a second look,
            // nothing saved) the shipment in FreightPOP.
            const hasRecord = r.shots.length > 0;
            const canOpen = review && !!shipmentUrl(r);
            const onRow = pick ? (full ? undefined : () => onToggle(r.id))
              : hasRecord ? () => setRecord(r)
              : canOpen ? () => openShipment(r)
              : undefined;
            const rowTitle = pick ? undefined
              : hasRecord ? "Open the saved invoice record"
              : canOpen ? "Open this shipment in FreightPOP (your hosted browser)"
              : review ? "FreightPOP's quote id for this shipment is not known yet, so it can't be opened from here"
              : undefined;
            return (
              <tr
                key={r.id}
                onClick={onRow}
                title={rowTitle}
                className={(pick || onRow ? "cursor-pointer " : "") + (on ? "bg-violet-50/70" : "hover:bg-slate-50/70")}
              >
                {pick ? (
                  <td className="pl-6 pr-2 py-3.5 align-top">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={full}
                      onChange={() => onToggle(r.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select shipment ${r.shipment}`}
                      title={full ? `Up to ${GET_INVOICE_MAX} at a time` : undefined}
                      className="h-4 w-4 mt-0.5 rounded border-slate-300 accent-violet-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                    />
                  </td>
                ) : null}
                <td className={TD + (pick ? "" : " pl-6")}>
                  <div className="flex items-center gap-1.5 font-medium text-slate-900 whitespace-nowrap">
                    {r.shipment || "—"}
                    <RecordButton row={r} onOpen={setRecord} />
                  </div>
                  {r.failed ? (
                    <>
                      <div className="text-xs text-rose-700 mt-1 break-words max-w-xs">Last try did not work. {plainReason(r.gi?.note)}.</div>
                      <RawNote note={r.gi?.note} />
                    </>
                  ) : null}
                  {review && shipmentUrl(r) ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); openShipment(r); }}
                      className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-violet-700 hover:text-violet-900 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" /> Open in FreightPOP
                    </button>
                  ) : null}
                  {review ? <div className="text-xs text-slate-500 mt-1 whitespace-nowrap">{r.bucket === "sent" ? "Invoice sent" : "Ready to invoice"}{r.approverName ? ` · ${r.approverName}` : ""}</div> : null}
                </td>
                <td className={TD + " text-slate-700"}>{r.customer || "—"}</td>
                <td className={TD + " text-slate-500"}>{r.carrier || "—"}</td>
                <td className={MONEY}>{fmtMoney(r.charge)}</td>
                {review ? <CheckCells row={r} /> : bucket === "approved" ? (
                  <>
                    <td className={TD}><ApproverPill row={r} /></td>
                    <td className={TD + " whitespace-nowrap text-slate-500"}>{r.approvedOn || "—"}</td>
                    <td className={TD + " pr-6 text-slate-600 max-w-[22rem]"}>
                      {r.notes ? <span className="line-clamp-2" title={r.notes}>{r.notes}</span> : <span className="text-slate-300">—</span>}
                    </td>
                  </>
                ) : bucket === "not-approved" ? (
                  <>
                    <td className={MONEY}>{r.pendingInvoice == null ? <span className="text-slate-300">—</span> : fmtMoney(r.pendingInvoice)}</td>
                    <td className={TD + " text-right tabular-nums whitespace-nowrap"}>
                      {r.waiting === "received" && r.pendingDiff != null ? (
                        <>
                          <div className={r.pendingDiff > 0.005 ? "text-rose-700" : r.pendingDiff < -0.005 ? "text-emerald-700" : "text-slate-500"}>
                            {fmtSigned(r.pendingDiff)}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">cost {fmtMoney(r.cost)}</div>
                        </>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className={TD + " pr-6 whitespace-nowrap text-slate-500"}>{r.shippedText || "—"}</td>
                  </>
                ) : (
                  <>
                    <td className={TD}><Result row={r} /></td>
                    <td className={TD + " pr-6 whitespace-nowrap text-slate-500"}>{when ? fmtDateTime(when) : "—"}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer}
      {record && auditId ? <InvoiceRecordModal auditId={auditId} row={record} onClose={() => setRecord(null)} /> : null}
    </div>
  );
}
