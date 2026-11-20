import { apiUrl, getAccessTokenOrWait } from "./api";
import { saveBlob } from "./erpPushed";

// Client for the one Invoices workflow: Pull → Runs → Not exported → Report for
// Isaac → Push to ERP. From /api/invoice-flow.
//
// "Exported to ERP" is FreightPOP's own flag. Get Invoice clicks are "Documents
// saved", never "pushed".

export type RunStage = "pulled" | "approvals" | "documents" | "done" | "failed";
export type ApprovalStatus = "queued" | "running" | "done" | "error";
export type NotExportedStatus = "no_invoice" | "invoice_not_approved" | "approved_ready";
export type NotExportedFilter = "all" | NotExportedStatus;
export type PullMonths = 1 | 3 | 6 | 12;
export type PullShipmentType = "non-parcel" | "parcel" | "both";

/** One pull from FreightPOP and everything that followed it. */
export interface Run {
  audit_id: string;
  run_number: number;
  started_at: string;
  finished_at: string | null;
  months: number | null;
  shipment_type: string | null;
  date_from: string | null;
  date_to: string | null;
  /** Rows in FreightPOP's Transactions History Report. */
  report_rows: number | null;
  /** The run's shipments that were not exported to the ERP. */
  not_exported: number | null;
  stage: RunStage | string;
  approval_status: ApprovalStatus | string | null;
  docs_total: number;
  docs_done: number;
  docs_failed: number;
  report_emailed_at: string | null;
  report_email_error: string | null;
  error: string | null;
  requested_by: string | null;
}

export interface NotExportedRow {
  shipment_id: string;
  status: NotExportedStatus;
  customer: string | null;
  carrier: string | null;
  tracking: string | null;
  ship_date: string | null;
  charge: number | null;
  cost: number | null;
  invoice_number: string | null;
  approved_by: string | null;
  docs_saved: boolean;
  last_pulled_at: string | null;
  run_number: number | null;
}

export interface FlowSummary {
  not_exported: {
    total: number;
    no_invoice: number;
    invoice_not_approved: number;
    approved_ready: number;
    charge_total: number;
  };
  exported_total: number;
  latest_run: Run | null;
  active: { stage: RunStage | string; run_number: number | null; message: string } | null;
  last_pull_at: string | null;
  report: { recipients: string[]; last_emailed_at: string | null };
}

export interface RunFile {
  name: string;
  label: string;
  url: string;
}

export interface RunFiles {
  run: Run;
  files: RunFile[];
  /** Saved invoice documents for the run, when the server counts them. */
  docs?: number;
  docs_count?: number;
}

export interface ReportEmailResult {
  sent: boolean;
  recipients: string[];
  error?: string;
}

export const STATUS_LABELS: Record<NotExportedStatus, string> = {
  no_invoice: "No invoice",
  invoice_not_approved: "Invoice not approved",
  approved_ready: "Approved – ready to export",
};

const TIMEOUT_MS = 60_000;
const LONG_TIMEOUT_MS = 5 * 60_000;
const BASE = "/api/invoice-flow";

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

async function download(path: string, fallback: string, timeoutMs = LONG_TIMEOUT_MS): Promise<void> {
  const res = await call(path, undefined, timeoutMs);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/i.exec(res.headers.get("content-disposition") || "")?.[1] || fallback;
  saveBlob(blob, name);
}

/** Counts, the newest run, the run in progress and the report's recipients. */
export async function getFlowSummary(signal?: AbortSignal): Promise<FlowSummary> {
  const res = await call(`${BASE}/summary`, signal ? { signal } : undefined);
  return res.json();
}

/** Runs, newest first. */
export async function listRuns(limit = 20, offset = 0): Promise<{ runs: Run[]; total: number }> {
  const res = await call(`${BASE}/runs?limit=${limit}&offset=${offset}`);
  const body = (await res.json()) as { runs?: Run[]; total?: number };
  return { runs: body.runs ?? [], total: body.total ?? body.runs?.length ?? 0 };
}

/** One run and its files (signed links, good for an hour). */
export async function getRun(auditId: string): Promise<RunFiles> {
  const res = await call(`${BASE}/runs/${encodeURIComponent(auditId)}`);
  const body = (await res.json()) as RunFiles;
  return { ...body, files: body.files ?? [] };
}

/** The path of a run's documents ZIP (needs the auth header; use downloadRunDocumentsZip). */
export function runDocumentsZipUrl(auditId: string): string {
  return `${apiUrl}${BASE}/runs/${encodeURIComponent(auditId)}/documents.zip`;
}

/** Download every saved invoice document of a run as one ZIP. */
export function downloadRunDocumentsZip(auditId: string, runNumber?: number | null): Promise<void> {
  return download(
    `${BASE}/runs/${encodeURIComponent(auditId)}/documents.zip`,
    `FPX-run-${runNumber ?? auditId.slice(0, 8)}-documents.zip`,
  );
}

/** All-time shipments not exported to the ERP, biggest charge first. */
export async function listNotExported(params: {
  status?: NotExportedFilter;
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: NotExportedRow[]; total: number }> {
  const p = new URLSearchParams();
  p.set("status", params.status ?? "all");
  if (params.q?.trim()) p.set("q", params.q.trim());
  p.set("limit", String(params.limit ?? 50));
  p.set("offset", String(params.offset ?? 0));
  const res = await call(`${BASE}/not-exported?${p.toString()}`);
  const body = (await res.json()) as { rows?: NotExportedRow[]; total?: number };
  return { rows: body.rows ?? [], total: body.total ?? 0 };
}

/** The not-exported Excel (the report Isaac gets). */
export function downloadNotExportedXlsx(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  return download(`${BASE}/not-exported.xlsx`, `FPX-not-exported-to-ERP-${today}.xlsx`);
}

/** Start a pull of FreightPOP's Transactions History Report. Fails if one is already running. */
export async function startPull(months: PullMonths, shipmentType: PullShipmentType): Promise<{ request: unknown }> {
  const res = await call(`${BASE}/pull`, { method: "POST", body: JSON.stringify({ months, shipment_type: shipmentType }) });
  return res.json();
}

/** Email the not-exported report to its recipients now. */
export async function emailReportNow(): Promise<ReportEmailResult> {
  const res = await call(`${BASE}/report/email`, { method: "POST", body: JSON.stringify({}) }, LONG_TIMEOUT_MS);
  return res.json();
}

/** Admins: who gets the report. */
export async function setReportRecipients(recipients: string[]): Promise<{ recipients: string[] }> {
  const res = await call(`${BASE}/report/recipients`, { method: "PUT", body: JSON.stringify({ recipients }) });
  return res.json();
}

// ---------------------------------------------------------------------------
// Plain words for a run's progress.
// ---------------------------------------------------------------------------

/** A run is still moving (not done, not failed). */
export function isRunActive(run: Pick<Run, "stage"> | null | undefined): boolean {
  return !!run && run.stage !== "done" && run.stage !== "failed";
}

/** "Pulling report", "Checking approvals", "Saving documents 340 of 765", "Done", "Failed — …". */
export function runStageText(run: Pick<Run, "stage" | "docs_done" | "docs_total" | "error">): string {
  switch (run.stage) {
    case "pulled": return "Pulling report";
    case "approvals": return "Checking approvals";
    case "documents":
      return run.docs_total > 0
        ? `Saving documents ${run.docs_done.toLocaleString()} of ${run.docs_total.toLocaleString()}`
        : "Saving documents";
    case "done": return "Done";
    case "failed": return run.error ? `Failed — ${run.error}` : "Failed";
    default: return String(run.stage);
  }
}

export function shipmentTypeLabel(t: string | null | undefined): string {
  if (t === "parcel") return "Parcel";
  if (t === "both") return "Parcel + non-parcel";
  if (t === "non-parcel" || t === "non_parcel") return "Non-parcel";
  return t || "—";
}

export function monthsLabel(m: number | null | undefined): string {
  if (!m) return "—";
  return m === 1 ? "1 month" : `${m} months`;
}
