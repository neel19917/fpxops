import { apiUrl, getAccessTokenOrWait } from "./api";
import { saveBlob } from "./erpPushed";

// Client calls for the "Get Invoice runs" page: every time the hosted browser
// clicks GET INVOICE in FreightPOP for chosen shipments it gets a scrape
// number. From /api/get-invoice-runs. Read only.

export type RunStatus = "pending" | "claimed" | "done" | "error";
/** "rerun": a later run replaced this result; later_run holds its scrape number. */
export type RunRowStatus = "done" | "failed" | "requested" | "not_started" | "not_reached" | "rerun";

export interface Run {
  id: string;
  scrape_number: number | null;
  status: RunStatus | string;
  requested_at: string;
  completed_at: string | null;
  requested_by: string | null;
  audit_id: string | null;
  /** Shipments asked for. */
  requested: number;
  /** Shipments where GET INVOICE was clicked; null when not known yet. */
  clicked: number | null;
  done: number;
  failed: number;
  waiting: number;
  /** Files saved for the run. */
  files: number;
  note: string | null;
  buttons: string | null;
}

export interface RunRow {
  scrape_number: number;
  shipment_id: string;
  status: RunRowStatus | string;
  note: string | null;
  clicked_at: string | null;
  customer_name: string | null;
  carrier: string | null;
  tracking_number: string | null;
  /** The customer invoice number. */
  billing_invoice_number: string | null;
  charge: number | null;
  cost: number | null;
  approved_invoice_amount: number | null;
  exported_to_erp: string | null;
  files: string[];
  /** What Claude read from the saved invoice document. */
  read_invoice_number: string | null;
  read_total: number | null;
  read_carrier: string | null;
  /** A newer scrape number re-ran this shipment. */
  later_run: number | null;
}

export interface RunDetail {
  run: Run;
  rows: RunRow[];
}

const TIMEOUT_MS = 60_000;
// A ZIP holds every saved file of the run and can be tens of MB.
const ZIP_TIMEOUT_MS = 5 * 60_000;
const BASE = "/api/get-invoice-runs";

async function call(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const token = await getAccessTokenOrWait();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw e;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(String(body.error));
    throw new Error(res.status === 404 ? "The server does not have this page yet. It needs its next update." : `The server returned ${res.status}`);
  }
  return res;
}

async function download(path: string, fallback: string, timeoutMs = TIMEOUT_MS): Promise<void> {
  const res = await call(path, undefined, timeoutMs);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/i.exec(res.headers.get("content-disposition") || "")?.[1] || fallback;
  saveBlob(blob, name);
}

/** Every Get Invoice run, newest first. */
export async function fetchRuns(): Promise<Run[]> {
  const res = await call(BASE);
  const body = (await res.json()) as { runs?: Run[] };
  return body.runs ?? [];
}

/** One run and its shipments. */
export async function fetchRun(scrapeNumber: number): Promise<RunDetail> {
  const res = await call(`${BASE}/${encodeURIComponent(String(scrapeNumber))}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// The Excel layout: which columns, in what order, with what headers, sorted
// how and which rows. Kept in this browser; every Excel (and the one inside a
// ZIP) is built with it.
// ---------------------------------------------------------------------------
export interface ExportColumn { key: string; label: string; default: boolean }
export interface ExportLayout {
  columns: { key: string; label: string }[]; // in order; label "" keeps the column's own header
  sort: string; // column key, or "" for the run's own order
  dir: "asc" | "desc";
  statuses: string[]; // [] = every status
  latest: boolean; // one row per shipment, its newest run
}
export const EXPORT_STATUSES: { key: string; label: string }[] = [
  { key: "done", label: "Done" }, { key: "failed", label: "Failed" }, { key: "rerun", label: "Re-run later" },
  { key: "not_reached", label: "Not reached" }, { key: "requested", label: "Waiting" },
];

/** The columns the server can put in the Excel. */
export async function fetchExportColumns(): Promise<ExportColumn[]> {
  const res = await call(`${BASE}/columns`);
  const body = (await res.json()) as { columns?: ExportColumn[] };
  return body.columns ?? [];
}

export function defaultLayout(cols: ExportColumn[]): ExportLayout {
  return { columns: cols.filter((c) => c.default).map((c) => ({ key: c.key, label: "" })), sort: "", dir: "asc", statuses: [], latest: false };
}

const LAYOUT_KEY = "fpx.getInvoiceRuns.excelLayout.v1";
export function loadLayout(): ExportLayout | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null") as ExportLayout | null;
    return v && Array.isArray(v.columns) ? v : null;
  } catch { return null; }
}
export function saveLayout(layout: ExportLayout | null): void {
  try {
    if (layout) localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    else localStorage.removeItem(LAYOUT_KEY);
  } catch { /* storage blocked: the layout lasts until the page is left */ }
}

/** The layout as the query string the export routes read ("" for none). */
export function layoutQuery(layout: ExportLayout | null): string {
  if (!layout) return "";
  const p = new URLSearchParams();
  if (layout.columns.length) p.set("columns", layout.columns.map((c) => c.key).join(","));
  for (const c of layout.columns) if (c.label.trim()) p.set(`label.${c.key}`, c.label.trim());
  if (layout.sort) { p.set("sort", layout.sort); p.set("dir", layout.dir); }
  if (layout.statuses.length) p.set("status", layout.statuses.join(","));
  if (layout.latest) p.set("latest", "1");
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** One run's shipments as an Excel file. */
export function downloadRunExcel(scrapeNumber: number, layout: ExportLayout | null = null): Promise<void> {
  return download(`${BASE}/${encodeURIComponent(String(scrapeNumber))}/export.xlsx${layoutQuery(layout)}`, `GetInvoice-${scrapeNumber}.xlsx`);
}

/** One run in FreightPOP's own export format, laid out for the AP master file:
 *  no Customer Id, no Appointment Set through Customer Audit, Scrape # last. */
export function downloadRunMaster(scrapeNumber: number): Promise<void> {
  return download(`${BASE}/${encodeURIComponent(String(scrapeNumber))}/master.xlsx`, `GetInvoice-Scrape-${scrapeNumber}-MasterFile.xlsx`, ZIP_TIMEOUT_MS);
}

/** Every run in master-file layout, each shipment with its newest scrape number. */
export function downloadAllRunsMaster(): Promise<void> {
  return download(`${BASE}/master.xlsx`, "GetInvoice-AllScrapes-MasterFile.xlsx", ZIP_TIMEOUT_MS);
}

/** One run as a ZIP: a folder per shipment with its files, plus the Excel. */
export function downloadRunZip(scrapeNumber: number, layout: ExportLayout | null = null): Promise<void> {
  return download(`${BASE}/${encodeURIComponent(String(scrapeNumber))}/files.zip${layoutQuery(layout)}`, `GetInvoice-${scrapeNumber}.zip`, ZIP_TIMEOUT_MS);
}

/** Every run's shipments in one Excel file, scrape number first. */
export function downloadAllRunsExcel(layout: ExportLayout | null = null): Promise<void> {
  return download(`${BASE}/export.xlsx${layoutQuery(layout)}`, "GetInvoice-all-runs.xlsx", ZIP_TIMEOUT_MS);
}

/** Every run's files in one ZIP: a folder per shipment, plus the Excel of all runs. */
export function downloadAllRunsZip(layout: ExportLayout | null = null): Promise<void> {
  return download(`${BASE}/files.zip${layoutQuery(layout)}`, "GetInvoice-all-runs.zip", ZIP_TIMEOUT_MS);
}
