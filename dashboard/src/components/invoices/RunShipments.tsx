import { useState } from "react";
import { isFlagged, type RunDetail, type RunRow } from "../../lib/getInvoiceRuns";
import { fmtNum } from "../../lib/format";
import { Alert, Chip, FlagChips, SMALL_BTN, TH, money } from "./runUi";

// One Get Invoice run's shipments (shown when a run is opened), with each
// shipment's flags and a toggle to show only the flagged ones.

export type DetailState = { loading: boolean; data?: RunDetail; error?: string };

const ROW_STATUS: Record<string, { label: string; cls: string }> = {
  done: { label: "Done", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  failed: { label: "Failed", cls: "bg-rose-50 text-rose-800 ring-rose-200" },
  requested: { label: "Waiting", cls: "bg-violet-50 text-violet-800 ring-violet-200" },
  not_started: { label: "Not started", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
  not_reached: { label: "Not reached", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
};

export function RunShipments({ state, onRetry }: { state: DetailState | undefined; onRetry: () => void }) {
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  if (!state || (state.loading && !state.data)) return <p className="text-sm text-slate-500 px-2 py-2">Loading shipments…</p>;
  if (state.error && !state.data) {
    return (
      <div className="space-y-2 px-2 py-2">
        <Alert>{state.error}</Alert>
        <button type="button" onClick={onRetry} className={SMALL_BTN}>Try again</button>
      </div>
    );
  }
  const rows = state.data?.rows ?? [];
  if (!rows.length) return <p className="text-sm text-slate-500 px-2 py-2">No shipments in this run.</p>;
  const flagged = rows.filter(isFlagged);
  const errors = flagged.filter((r) => r.flag_level === "error").length;
  const shown = onlyFlagged ? flagged : rows;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-xs text-slate-600">
          {flagged.length
            ? <>{fmtNum(flagged.length)} of {fmtNum(rows.length)} shipments need a look{errors ? <> ({fmtNum(errors)} with an error)</> : null}.</>
            : <>No shipment needs a look.</>}
        </p>
        <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
          <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)}
            disabled={!flagged.length && !onlyFlagged} className="h-4 w-4 accent-violet-600" />
          Show only flagged
        </label>
      </div>
      <div className="rounded-lg bg-white ring-1 ring-slate-200 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500 text-left bg-slate-50">
            <tr>
              <th scope="col" className={"pl-3 " + TH}>Shipment</th>
              <th scope="col" className={TH}>Customer</th>
              <th scope="col" className={TH}>Carrier</th>
              <th scope="col" className={TH}>Customer invoice #</th>
              <th scope="col" className={TH} title="The invoice number Claude read from the saved document">Invoice # read</th>
              <th scope="col" className={TH + " text-right"}>Charge</th>
              <th scope="col" className={TH + " text-right"} title="The total Claude read from the saved customer invoice">Total read</th>
              <th scope="col" className={TH}>Status</th>
              <th scope="col" className={TH} title="Whether the GET INVOICE button was pushed for this shipment in this run">Pushed</th>
              <th scope="col" className={TH + " text-right"}>Files</th>
              <th scope="col" className={TH} title="What to check: red is an error, amber needs a look, grey is a note">Flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums">
            {shown.map((row) => <ShipmentRow key={row.shipment_id} row={row} />)}
            {!shown.length ? (
              <tr><td colSpan={11} className="px-3 py-3 text-slate-500">No flagged shipments.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const hasFlag = (row: RunRow, ...codes: string[]) => (row.flags ?? []).some((f) => codes.includes(f.code));

function ShipmentRow({ row }: { row: RunRow }) {
  const grey = "bg-slate-100 text-slate-700 ring-slate-200";
  const st = row.status === "rerun"
    ? { label: row.later_run != null ? `Re-run in #${row.later_run}` : "Re-run", cls: grey }
    : ROW_STATUS[row.status] ?? { label: row.status || "—", cls: grey };
  const bar = row.flag_level === "error" ? "border-l-2 border-rose-400" : row.flag_level === "warn" ? "border-l-2 border-amber-400" : "border-l-2 border-transparent";
  const bad = "text-rose-700 font-medium";
  return (
    <tr className="align-top">
      <td className={"py-1.5 pl-3 pr-3 font-medium text-slate-900 whitespace-nowrap " + bar}>
        {row.shipment_id}
        {row.later_run != null && row.status !== "rerun" ? <div className="text-[11px] font-normal text-amber-700">re-run in #{row.later_run}</div> : null}
      </td>
      <td className="py-1.5 pr-3 text-slate-700 max-w-[14rem] truncate" title={row.customer_name || undefined}>{row.customer_name || "—"}</td>
      <td className="py-1.5 pr-3 text-slate-700 max-w-[12rem] truncate" title={row.carrier || undefined}>{row.carrier || "—"}</td>
      <td className="py-1.5 pr-3 text-slate-700 whitespace-nowrap">{row.billing_invoice_number || "—"}</td>
      <td className={"py-1.5 pr-3 whitespace-nowrap " + (hasFlag(row, "invoice_number_mismatch") ? bad : "text-slate-700")}>{row.read_invoice_number || "—"}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{money(row.charge)}</td>
      <td className={"py-1.5 pr-3 text-right whitespace-nowrap " + (hasFlag(row, "total_mismatch") ? bad : "")}>{money(row.read_total)}</td>
      <td className="py-1.5 pr-3">
        <Chip label={st.label} cls={st.cls} title={row.note || undefined} />
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">
        {row.pushed == null ? "—" : row.pushed ? <span className="text-emerald-700 font-medium">Yes</span> : <span className="text-slate-500">No</span>}
      </td>
      <td className="py-1.5 pr-3 text-right">{fmtNum(row.files.length)}</td>
      <td className="py-1.5 pr-3"><FlagChips flags={row.flags} /></td>
    </tr>
  );
}
