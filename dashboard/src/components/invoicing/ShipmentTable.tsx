import type { ReactNode } from "react";
import { GET_INVOICE_MAX, approvalHover } from "../../lib/erpPull";
import { fmtDateTime } from "../../lib/format";
import { fmtMoney, fmtSigned, type BucketKey, type Row } from "./model";

// One table, three shapes: the columns follow the selected bucket.

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

function Result({ row }: { row: Row }) {
  const inProgress = row.gi?.status === "requested";
  return (
    <>
      <span className={"inline-block text-xs rounded-full px-2.5 py-1 whitespace-nowrap ring-1 "
        + (inProgress ? "bg-sky-50 text-sky-800 ring-sky-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200")}>
        {inProgress ? "In progress" : "Sent"}
      </span>
      {row.gi?.note ? <div className="text-xs text-slate-500 mt-1 break-words max-w-sm">{row.gi.note}</div> : null}
    </>
  );
}

export function ShipmentTable({ bucket, rows, empty, selected, atCap, allPicked, canPickAll, capped, onToggle, onToggleAll, footer }: {
  bucket: BucketKey;
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
  const colCount = bucket === "approved" ? 7 : bucket === "not-approved" ? 7 : 6;
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
            {bucket === "approved" ? (
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
            return (
              <tr
                key={r.id}
                onClick={pick && !full ? () => onToggle(r.id) : undefined}
                className={(pick ? "cursor-pointer " : "") + (on ? "bg-violet-50/70" : "hover:bg-slate-50/70")}
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
                  <div className="font-medium text-slate-900 whitespace-nowrap">{r.shipment || "—"}</div>
                  {r.failed ? (
                    <div className="text-xs text-rose-700 mt-1 break-words max-w-xs">
                      Last try failed{r.gi?.note ? `: ${r.gi.note}` : ""}
                    </div>
                  ) : null}
                </td>
                <td className={TD + " text-slate-700"}>{r.customer || "—"}</td>
                <td className={TD + " text-slate-500"}>{r.carrier || "—"}</td>
                <td className={MONEY}>{fmtMoney(r.charge)}</td>
                {bucket === "approved" ? (
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
    </div>
  );
}
