import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight, Download, FileArchive, FileSpreadsheet, RefreshCw, SlidersHorizontal } from "lucide-react";
import {
  downloadAllRunsExcel, downloadAllRunsMaster, downloadAllRunsZip, downloadRunExcel, downloadRunMaster, downloadRunZip, fetchRun, fetchRuns,
  loadLayout, saveLayout, type ExportLayout,
  type Run, type RunDetail, type RunRow,
} from "../lib/getInvoiceRuns";
import { fmtDateTime, fmtNum } from "../lib/format";
import { ExcelLayoutModal } from "../components/invoices/ExcelLayoutModal";

// Get Invoice runs: every time the hosted browser clicks GET INVOICE in
// FreightPOP for chosen shipments, the run gets a scrape number. Each run can
// be downloaded as Excel (for the master spreadsheet) or as a ZIP with every
// saved invoice file, one folder per shipment.
//
// Data source (Railway API, /api/get-invoice-runs):
//   - GET /                         the runs, newest first
//   - GET /:n                       one run and its shipments (on expand)
//   - GET /:n/export.xlsx, /:n/files.zip, /export.xlsx   downloads

const POLL_MS = 10_000;

const PRIMARY_BTN = "px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
const SECONDARY_BTN = "px-4 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
const SMALL_BTN = "px-2.5 py-1 rounded-md bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";
const TH = "py-2 pr-3 font-medium whitespace-nowrap";

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

const money = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
const isRunning = (r: Run) => r.status === "pending" || r.status === "claimed";

function Alert({ children }: { children: string }) {
  return <div role="alert" className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 text-sm px-3 py-2">{children}</div>;
}

function runChip(r: Run): { label: string; cls: string; dot?: string } {
  if (isRunning(r)) return { label: "Running", cls: "bg-violet-50 text-violet-800 ring-violet-200", dot: "bg-violet-500 animate-pulse" };
  if (r.status === "error") return { label: "Problem", cls: "bg-rose-50 text-rose-800 ring-rose-200" };
  if (r.status === "done" && r.failed > 0) return { label: "Done, some failed", cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  if (r.status === "done") return { label: "Done", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" };
  return { label: r.status || "—", cls: "bg-slate-100 text-slate-700 ring-slate-200" };
}

const ROW_STATUS: Record<string, { label: string; cls: string }> = {
  done: { label: "Done", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  failed: { label: "Failed", cls: "bg-rose-50 text-rose-800 ring-rose-200" },
  requested: { label: "Waiting", cls: "bg-violet-50 text-violet-800 ring-violet-200" },
  not_started: { label: "Not started", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
  not_reached: { label: "Not reached", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
};

function Chip({ label, cls, dot }: { label: string; cls: string; dot?: string }) {
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 whitespace-nowrap " + cls}>
      {dot ? <span className={"h-1.5 w-1.5 rounded-full " + dot} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

type DetailState = { loading: boolean; data?: RunDetail; error?: string };

export function GetInvoiceRunsPage() {
  const alive = useRef(true);
  // Set on every mount: React's development mode mounts twice, and a flag
  // only ever cleared would drop every answer after the first unmount.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const [runs, setRuns] = useState<Run[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  // Keys like "57:xlsx", "57:zip", "all".
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [dlErr, setDlErr] = useState<string | null>(null);
  // The Excel layout chosen in "Customize Excel" (null = the standard sheet).
  const [layout, setLayout] = useState<ExportLayout | null>(() => loadLayout());
  const [customizing, setCustomizing] = useState(false);
  const changeLayout = (l: ExportLayout | null) => { setLayout(l); saveLayout(l); };

  const loadRuns = useCallback(async () => {
    try {
      const list = await fetchRuns();
      if (!alive.current) return;
      setRuns(list);
      setListErr(null);
    } catch (e) {
      if (alive.current) setListErr(errText(e));
    }
  }, []);

  const loadDetail = useCallback(async (n: number, quiet = false) => {
    if (!quiet) setDetails((d) => ({ ...d, [n]: { ...d[n], loading: true, error: undefined } }));
    try {
      const data = await fetchRun(n);
      if (alive.current) setDetails((d) => ({ ...d, [n]: { loading: false, data } }));
    } catch (e) {
      if (alive.current) setDetails((d) => ({ ...d, [n]: { ...d[n], loading: false, error: errText(e) } }));
    }
  }, []);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const anyRunning = !!runs?.some(isRunning);
  const expandedRunning = expanded != null && !!runs?.some((r) => r.scrape_number === expanded && isRunning(r));

  // Poll while a run is still going, so its counts (and the open shipment list) move.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => {
      void loadRuns();
      if (expanded != null && expandedRunning) void loadDetail(expanded, true);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, expanded, expandedRunning, loadRuns, loadDetail]);

  async function refresh() {
    setRefreshing(true);
    await loadRuns();
    if (expanded != null) await loadDetail(expanded, true);
    if (alive.current) setRefreshing(false);
  }

  function toggle(n: number | null) {
    if (n == null) return;
    if (expanded === n) { setExpanded(null); return; }
    setExpanded(n);
    if (!details[n]?.data) void loadDetail(n);
  }

  async function runDownload(key: string, fn: () => Promise<void>) {
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true }));
    setDlErr(null);
    try {
      await fn();
    } catch (e) {
      if (alive.current) setDlErr(errText(e) || "The file could not be downloaded.");
    } finally {
      if (alive.current) setBusy((b) => { const next = { ...b }; delete next[key]; return next; });
    }
  }

  const zipBusy = Object.keys(busy).some((k) => k.endsWith(":zip") || k === "allzip");
  const anyFiles = !!runs?.some((r) => r.files > 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <header className="shrink-0 rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link to="/invoices" className="inline-flex items-center gap-1 text-xs text-violet-700 hover:underline mb-1">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to Invoices
            </Link>
            <h1 className="text-lg font-semibold text-slate-900">Get Invoice runs</h1>
            <p className="text-xs text-slate-500">
              Every time FPX clicks Get Invoice in FreightPOP it gets a scrape number. Download a run as Excel for your spreadsheet, or as a ZIP with every invoice file.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => runDownload("all", () => downloadAllRunsExcel(layout))} disabled={!!busy.all || !runs?.length} className={PRIMARY_BTN}>
              <Download className="h-4 w-4" aria-hidden="true" /> {busy.all ? "Preparing the file…" : "Download all runs (Excel)"}
            </button>
            <button type="button" onClick={() => runDownload("allmaster", downloadAllRunsMaster)} disabled={!!busy.allmaster || !runs?.length} className={SECONDARY_BTN}
              title="FreightPOP's own export without Customer Id and Appointment Set through Customer Audit, with Scrape # as the last column: ready to paste into the master file">
              <FileSpreadsheet className="h-4 w-4" aria-hidden="true" /> {busy.allmaster ? "Preparing the file…" : "All runs, master-file format"}
            </button>
            <button type="button" onClick={() => runDownload("allzip", () => downloadAllRunsZip(layout))} disabled={!!busy.allzip || !anyFiles} className={SECONDARY_BTN}
              title={runs && !anyFiles ? "No files have been saved by any run yet" : undefined}>
              <FileArchive className="h-4 w-4" aria-hidden="true" /> {busy.allzip ? "Building the ZIP…" : "Download all files (ZIP)"}
            </button>
            <button type="button" onClick={() => setCustomizing(true)} className={SECONDARY_BTN}
              title="Choose the Excel's columns, their order and headers, the sort and which rows">
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Customize Excel
              {layout ? <span className="rounded-full bg-violet-100 text-violet-800 px-1.5 text-[11px]">custom</span> : null}
            </button>
            <button type="button" onClick={refresh} disabled={refreshing} className={SECONDARY_BTN}>
              <RefreshCw className={"h-4 w-4" + (refreshing ? " animate-spin" : "")} aria-hidden="true" /> Refresh
            </button>
          </div>
        </div>
        {zipBusy ? (
          <div role="status" className="rounded-lg bg-violet-50 ring-1 ring-violet-200 text-violet-900 text-sm px-3 py-2">
            Building the ZIP… This can take a few minutes for a big run. Keep this page open.
          </div>
        ) : null}
        {dlErr ? <Alert>{dlErr}</Alert> : null}
        {customizing ? <ExcelLayoutModal layout={layout} onSave={changeLayout} onClose={() => setCustomizing(false)} /> : null}
        {listErr ? <Alert>{listErr}</Alert> : null}
      </header>

      <section className="rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 space-y-2 min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Runs</h2>
          <span className="text-xs text-slate-500">
            {anyRunning ? "A run is still going. This list updates every 10 seconds." : "Click a run to see its shipments."}
          </span>
        </div>

        {runs === null && !listErr ? (
          <p className="text-sm text-slate-500">Loading runs…</p>
        ) : runs && runs.length === 0 ? (
          <p className="text-sm text-slate-500">No Get Invoice runs yet.</p>
        ) : runs ? (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500 text-left">
                <tr>
                  <th scope="col" className={TH}><span className="sr-only">Open</span></th>
                  <th scope="col" className={TH}>Scrape #</th>
                  <th scope="col" className={TH}>Requested</th>
                  <th scope="col" className={TH}>By</th>
                  <th scope="col" className={TH + " text-right"}>Shipments</th>
                  <th scope="col" className={TH + " text-right"}>Clicked</th>
                  <th scope="col" className={TH + " text-right"}>Failed</th>
                  <th scope="col" className={TH + " text-right"}>Files</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH + " pr-0"}><span className="sr-only">Downloads</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {runs.map((r) => {
                  const n = r.scrape_number;
                  const open = n != null && expanded === n;
                  const chip = runChip(r);
                  return (
                    <Fragment key={r.id}>
                      <tr
                        onClick={() => toggle(n)}
                        className={(n != null ? "cursor-pointer hover:bg-slate-50 " : "") + (open ? "bg-slate-50" : "")}
                      >
                        <td className="py-2 pr-1 w-6">
                          {n != null ? (
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`${open ? "Hide" : "Show"} shipments of run #${n}`}
                              onClick={(e) => { e.stopPropagation(); toggle(n); }}
                              className="rounded p-0.5 text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                            >
                              {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                            </button>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 font-semibold text-slate-900 whitespace-nowrap">{n != null ? `#${n}` : "—"}</td>
                        <td className="py-2 pr-3 text-slate-700 whitespace-nowrap">{fmtDateTime(r.requested_at)}</td>
                        <td className="py-2 pr-3 text-slate-700 max-w-[12rem] truncate" title={r.requested_by || undefined}>{r.requested_by || "—"}</td>
                        <td className="py-2 pr-3 text-right">{fmtNum(r.requested)}</td>
                        <td className="py-2 pr-3 text-right">{fmtNum(r.clicked)}</td>
                        <td className={"py-2 pr-3 text-right " + (r.failed ? "text-rose-700 font-medium" : "")}>{fmtNum(r.failed)}</td>
                        <td className="py-2 pr-3 text-right">{fmtNum(r.files)}</td>
                        <td className="py-2 pr-3">
                          <span title={r.note || undefined}><Chip {...chip} /></span>
                        </td>
                        <td className="py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          {n != null ? (
                            <div className="inline-flex gap-1.5">
                              <button type="button" className={SMALL_BTN} disabled={!!busy[`${n}:xlsx`]}
                                onClick={() => runDownload(`${n}:xlsx`, () => downloadRunExcel(n, layout))}>
                                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" /> {busy[`${n}:xlsx`] ? "Preparing…" : "Excel"}
                              </button>
                              <button type="button" className={SMALL_BTN} disabled={!!busy[`${n}:master`]}
                                title="FreightPOP's own export for this run, ready to paste into the master file (Customer Id and Appointment Set through Customer Audit removed, Scrape # last)"
                                onClick={() => runDownload(`${n}:master`, () => downloadRunMaster(n))}>
                                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" /> {busy[`${n}:master`] ? "Preparing…" : "Master file"}
                              </button>
                              <button type="button" className={SMALL_BTN} disabled={!!busy[`${n}:zip`] || r.files === 0}
                                title={r.files === 0 ? "No files were saved for this run" : undefined}
                                onClick={() => runDownload(`${n}:zip`, () => downloadRunZip(n, layout))}>
                                <FileArchive className="h-3.5 w-3.5" aria-hidden="true" /> {busy[`${n}:zip`] ? "Building the ZIP…" : "ZIP"}
                              </button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                      {open ? (
                        <tr className="bg-slate-50">
                          <td colSpan={10} className="px-2 pb-3 pt-1">
                            <RunShipments state={details[n]} onRetry={() => loadDetail(n)} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function RunShipments({ state, onRetry }: { state: DetailState | undefined; onRetry: () => void }) {
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
  return (
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
            <th scope="col" className={TH + " text-right"} title="The total Claude read from the saved document">Total read</th>
            <th scope="col" className={TH}>Status</th>
            <th scope="col" className={TH} title="Whether the GET INVOICE button was pushed for this shipment in this run">Pushed</th>
            <th scope="col" className={TH + " text-right"}>Files</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 tabular-nums">
          {rows.map((row) => <ShipmentRow key={row.shipment_id} row={row} />)}
        </tbody>
      </table>
    </div>
  );
}

function ShipmentRow({ row }: { row: RunRow }) {
  const grey = "bg-slate-100 text-slate-700 ring-slate-200";
  const st = row.status === "rerun"
    ? { label: row.later_run != null ? `Re-run in #${row.later_run}` : "Re-run", cls: grey }
    : ROW_STATUS[row.status] ?? { label: row.status || "—", cls: grey };
  return (
    <tr className="align-top">
      <td className="py-1.5 pl-3 pr-3 font-medium text-slate-900 whitespace-nowrap">
        {row.shipment_id}
        {row.later_run != null && row.status !== "rerun" ?<div className="text-[11px] font-normal text-amber-700">re-run in #{row.later_run}</div> : null}
      </td>
      <td className="py-1.5 pr-3 text-slate-700 max-w-[14rem] truncate" title={row.customer_name || undefined}>{row.customer_name || "—"}</td>
      <td className="py-1.5 pr-3 text-slate-700 max-w-[12rem] truncate" title={row.carrier || undefined}>{row.carrier || "—"}</td>
      <td className="py-1.5 pr-3 text-slate-700 whitespace-nowrap">{row.billing_invoice_number || "—"}</td>
      <td className="py-1.5 pr-3 text-slate-700 whitespace-nowrap">{row.read_invoice_number || "—"}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{money(row.charge)}</td>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">{money(row.read_total)}</td>
      <td className="py-1.5 pr-3">
        <span title={row.note || undefined}><Chip label={st.label} cls={st.cls} /></span>
        {row.note && row.status === "failed" ? <div className="mt-0.5 text-[11px] text-rose-700 max-w-[16rem] break-words">{row.note}</div> : null}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">
        {row.pushed == null ? "—" : row.pushed ? <span className="text-emerald-700 font-medium">Yes</span> : <span className="text-slate-500">No</span>}
      </td>
      <td className="py-1.5 pr-3 text-right">{fmtNum(row.files.length)}</td>
    </tr>
  );
}
