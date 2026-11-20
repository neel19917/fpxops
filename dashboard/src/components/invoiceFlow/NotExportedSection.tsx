import { RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorBlock } from "../ErrorBlock";
import { LoadingState } from "../LoadingState";
import { listNotExported, type FlowSummary, type NotExportedRow } from "../../lib/invoiceFlow";
import NotExportedDrawer from "./notExported/NotExportedDrawer";
import { STATUS_LABEL, StatusPill, errorText, fmtDay, fmtMoney, type NotExportedStatus } from "./notExported/format";

// Every shipment FreightPOP has not exported to the ERP, across all pulls.
// One list, biggest charge first, 50 at a time. Read only.

const PAGE = 50;
const COLS = 9;

type Filter = "all" | NotExportedStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "no_invoice", label: STATUS_LABEL.no_invoice },
  { key: "invoice_not_approved", label: STATUS_LABEL.invoice_not_approved },
  { key: "approved_ready", label: STATUS_LABEL.approved_ready },
];

const TH = "text-[11px] uppercase tracking-wide text-slate-500 font-medium px-4 py-2.5 whitespace-nowrap text-left";
const TD = "px-4 py-2.5 whitespace-nowrap";
const QUIET_BUTTON = "px-3 py-1.5 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed";

export default function NotExportedSection({ summary, onChanged }: { summary?: FlowSummary; onChanged?: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<NotExportedRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<NotExportedRow | null>(null);

  // Search waits 300ms after the last keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(input.trim()), 300);
    return () => window.clearTimeout(t);
  }, [input]);

  // A new filter or search starts at the first page.
  const filterKey = `${filter}|${q}`;
  const lastKey = useRef(filterKey);
  let shownPage = page;
  if (lastKey.current !== filterKey) shownPage = 0;
  useEffect(() => {
    if (lastKey.current !== filterKey) { lastKey.current = filterKey; setPage(0); }
  }, [filterKey]);

  // Reload when a new pull lands (the summary changes).
  const summaryKey = summary?.last_pull_at ?? "";

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    listNotExported({ status: filter, q, limit: PAGE, offset: shownPage * PAGE }).then(
      (res) => {
        if (!alive) return;
        setRows(res.rows ?? []);
        setTotal(res.total ?? 0);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        console.warn("[FPX] not-exported list failed:", e);
        setError(errorText(e, "The shipments could not be loaded. Try again in a moment."));
        setLoading(false);
      },
    );
    return () => { alive = false; };
  }, [filter, q, shownPage, attempt, summaryKey]);

  const counts = summary?.not_exported;
  const countFor = (k: Filter): number | null => {
    if (!counts) return null;
    if (k === "all") return counts.total;
    return counts[k];
  };

  const from = total ? shownPage * PAGE + 1 : 0;
  const to = total ? Math.min(total, shownPage * PAGE + rows.length) : 0;
  const lastPage = total ? Math.max(0, Math.ceil(total / PAGE) - 1) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const n = countFor(f.key);
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition ${
                active ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {f.label}
              {n != null ? (
                <span className={`tabular-nums text-xs ${active ? "text-slate-300" : "text-slate-500"}`}>{n.toLocaleString()}</span>
              ) : null}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search shipment, customer, carrier, tracking"
              className="w-72 max-w-full rounded-lg ring-1 ring-slate-300 bg-white pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>
          <button
            type="button"
            className={QUIET_BUTTON}
            title="Refresh"
            aria-label="Refresh"
            onClick={() => { setAttempt((a) => a + 1); onChanged?.(); }}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {counts ? (
        <div className="text-sm text-slate-500">
          Total charge not exported: <span className="tabular-nums font-medium text-slate-800">{fmtMoney(counts.charge_total)}</span>
        </div>
      ) : null}

      {error ? (
        <ErrorBlock>
          {error}{" "}
          <button type="button" className="underline font-medium" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
        </ErrorBlock>
      ) : null}

      <div className="rounded-2xl ring-1 ring-slate-200 bg-white overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className={TH}>Shipment</th>
              <th className={TH}>Customer</th>
              <th className={TH}>Carrier</th>
              <th className={TH}>Ship date</th>
              <th className={`${TH} text-right`}>Charge</th>
              <th className={`${TH} text-right`}>Cost</th>
              <th className={TH}>Status</th>
              <th className={TH}>Docs saved</th>
              <th className={`${TH} text-right`}>Run #</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && rows.length === 0 ? (
              <LoadingState variant="row" colSpan={COLS} />
            ) : rows.length === 0 && !error ? (
              <tr>
                <td colSpan={COLS} className="p-8 text-center text-slate-500">
                  {q ? "No shipments match this search." : "Nothing here. Every shipment in this group has been exported to the ERP."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.shipment_id}
                  onClick={() => setOpen(r)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(r); } }}
                  tabIndex={0}
                  className={`cursor-pointer hover:bg-slate-50 focus:outline-none focus-visible:bg-sky-50 ${loading ? "opacity-60" : ""}`}
                >
                  <td className={`${TD} font-medium text-slate-900`}>{r.shipment_id}</td>
                  <td className={`${TD} text-slate-700 max-w-[16rem] truncate`} title={r.customer || undefined}>{r.customer || "—"}</td>
                  <td className={`${TD} text-slate-700 max-w-[12rem] truncate`} title={r.carrier || undefined}>{r.carrier || "—"}</td>
                  <td className={`${TD} text-slate-700`}>{fmtDay(r.ship_date)}</td>
                  <td className={`${TD} text-right tabular-nums text-slate-900`}>{fmtMoney(r.charge)}</td>
                  <td className={`${TD} text-right tabular-nums text-slate-700`}>{fmtMoney(r.cost)}</td>
                  <td className={TD}><StatusPill status={r.status} /></td>
                  <td className={`${TD} ${r.docs_saved ? "text-emerald-700" : "text-slate-500"}`}>{r.docs_saved ? "Yes" : "No"}</td>
                  <td className={`${TD} text-right tabular-nums text-slate-700`}>{r.run_number != null ? `#${r.run_number}` : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total != null && total > 0 ? (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span className="tabular-nums">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
          <div className="flex items-center gap-2">
            <button type="button" className={QUIET_BUTTON} disabled={loading || shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous</button>
            <button type="button" className={QUIET_BUTTON} disabled={loading || shownPage >= lastPage} onClick={() => setPage(shownPage + 1)}>Next</button>
          </div>
        </div>
      ) : null}

      <NotExportedDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
