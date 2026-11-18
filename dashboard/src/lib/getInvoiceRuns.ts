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

/** One run's shipments as an Excel file. */
export function downloadRunExcel(scrapeNumber: number): Promise<void> {
  return download(`${BASE}/${encodeURIComponent(String(scrapeNumber))}/export.xlsx`, `GetInvoice-${scrapeNumber}.xlsx`);
}

/** One run as a ZIP: a folder per shipment with its files, plus the Excel. */
export function downloadRunZip(scrapeNumber: number): Promise<void> {
  return download(`${BASE}/${encodeURIComponent(String(scrapeNumber))}/files.zip`, `GetInvoice-${scrapeNumber}.zip`, ZIP_TIMEOUT_MS);
}

/** Every run's shipments in one Excel file, scrape number first. */
export function downloadAllRunsExcel(): Promise<void> {
  return download(`${BASE}/export.xlsx`, "GetInvoice-all-runs.xlsx", ZIP_TIMEOUT_MS);
}

/** Every run's files in one ZIP: a folder per shipment, plus the Excel of all runs. */
export function downloadAllRunsZip(): Promise<void> {
  return download(`${BASE}/files.zip`, "GetInvoice-all-runs.zip", ZIP_TIMEOUT_MS);
}
