import { apiUrl, getAccessTokenOrWait } from "./api";

// Client calls for the "Reading invoices" page: the invoice reader's live
// state and its step-by-step log, from /api/invoice-docs/state and /log,
// plus the buttons (POST /process) and, in batch mode, the Message Batches
// the reader sends to Claude (GET /batches, POST /batches/submit and /poll).

export type LogLevel = "info" | "ok" | "warn" | "error";
export type LogStep =
  | "started" | "downloaded" | "unchanged" | "copied" | "sent" | "read" | "embedded" | "done" | "failed" | "run"
  | "batched" | "submitted" | "waiting";

export interface LogLine {
  id: number;
  at: string | null;
  document_id: string | null;
  shipment_id: string | null;
  file: string | null;
  doc_type: string | null;
  step: LogStep | string | null;
  level: LogLevel;
  message: string;
  /** How long the step took, in milliseconds. */
  ms: number | null;
  cost_usd: number | null;
}

export interface LogPage {
  data: LogLine[];
  last_id: number | null;
}

export type ReadingStep = "downloading" | "reading" | "embedding";

export interface ReadingNow {
  id: string;
  shipment_id: string | null;
  file: string | null;
  doc_type: string | null;
  step: ReadingStep;
  /** When the current step began. */
  since: string;
}

export interface ReaderRun {
  started_at: string;
  finished_at?: string;
  processed: number;
  done: number;
  copied: number;
  unchanged: number;
  failed: number;
}

export interface ReaderState {
  /** Whether this API server reads files (it has a Claude key). */
  enabled: boolean;
  running: boolean;
  run: ReaderRun | null;
  reading: ReadingNow[];
  total: number;
  by_status: { pending: number; processing: number; done: number; failed: number; skipped: number };
  by_doc_type: Record<string, number>;
  last_extracted_at: string | null;
  cost_usd: number;
  queue: { pending: number; processing: number; failed: number };
  /** null when the log could not be read. */
  cost_today_usd: number | null;
  // Batch mode. Optional: an older server does not send these.
  /** "batch": waiting files go to Claude together every few minutes; "direct": each file is read as soon as it is saved. */
  mode?: ReaderMode;
  batch_every_minutes?: number;
  /** When the next automatic batch goes out; null in direct mode or when the worker is off. */
  next_submit_at?: string | null;
  /** Batches sent and not yet finished; null if unknown. */
  open_batches?: number | null;
  /** A batch is being sent or checked right now. */
  batch_busy?: boolean;
}

export type ReaderMode = "batch" | "direct";

export interface ProcessResult {
  queued: number;
  processing: boolean;
  reason?: string;
  mode?: ReaderMode;
  next_submit_at?: string | null;
}

export type BatchStatus = "sending" | "in_progress" | "canceling" | "ended" | "failed";

export interface Batch {
  id: string;
  anthropic_batch_id: string | null;
  status: BatchStatus;
  request_count: number;
  succeeded: number;
  errored: number;
  expired: number;
  canceled: number;
  model: string | null;
  submitted_at: string | null;
  ended_at: string | null;
  /** Set once every result is saved; the batch is finished for the user. */
  results_applied_at: string | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
}

export interface BatchSubmitResult {
  sent_docs: number;
  batches: { id: string; anthropic_batch_id: string | null; request_count: number }[];
  unchanged: number;
  copied: number;
  failed: number;
  claimed: number;
}

export interface BatchPollResult {
  checked: number;
  ended: number;
  applied_docs: number;
  failed_docs: number;
  still_open: number;
}

/** An error from the server that keeps its HTTP status (0 when there was no answer). */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 30_000;
const BASE = "/api/invoice-docs";

async function call(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessTokenOrWait();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw e;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new ApiError(String(body.error), res.status);
    throw new ApiError(res.status === 404 ? "The server does not have this page yet. It needs its next update." : `The server returned ${res.status}`, res.status);
  }
  return res;
}

const withTimeout = (signal?: AbortSignal): RequestInit | undefined =>
  signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) } : undefined;

export interface LogFilters {
  /** Only lines after this id, oldest first. Without it: the newest lines, newest first. */
  sinceId?: number | null;
  documentId?: string;
  shipmentId?: string;
  /** One level or several. */
  level?: LogLevel | LogLevel[];
  limit?: number;
}

export async function fetchReadingLog(f: LogFilters = {}, signal?: AbortSignal): Promise<LogPage> {
  const p = new URLSearchParams();
  if (f.sinceId != null) p.set("since_id", String(f.sinceId));
  if (f.documentId) p.set("document_id", f.documentId);
  if (f.shipmentId) p.set("shipment_id", f.shipmentId);
  if (f.level) p.set("level", Array.isArray(f.level) ? f.level.join(",") : f.level);
  if (f.limit) p.set("limit", String(f.limit));
  const qs = p.toString();
  const res = await call(`${BASE}/log${qs ? `?${qs}` : ""}`, withTimeout(signal));
  return res.json();
}

export async function fetchReaderState(signal?: AbortSignal): Promise<ReaderState> {
  const res = await call(`${BASE}/state`, withTimeout(signal));
  return res.json();
}

/**
 * Queue every saved file that has not been read and start reading. In batch
 * mode the files go in the next batch unless `direct` is set, which reads
 * them now with the direct API (with `shipmentId`: only that shipment's files).
 */
export async function processWaiting(opts: { retryFailed?: boolean; direct?: boolean; shipmentId?: string } = {}): Promise<ProcessResult> {
  const body: Record<string, unknown> = {};
  if (opts.retryFailed) body.retry_failed = true;
  if (opts.direct) body.direct = true;
  if (opts.shipmentId) body.shipment_id = opts.shipmentId;
  const res = await call(`${BASE}/process`, { method: "POST", body: JSON.stringify(body) });
  return res.json();
}

/** The newest batches first. Returns null when the server has no batches page yet (older server). */
export async function fetchBatches(limit = 50, signal?: AbortSignal): Promise<Batch[] | null> {
  try {
    const res = await call(`${BASE}/batches?limit=${encodeURIComponent(String(limit))}`, withTimeout(signal));
    const body = (await res.json()) as { data?: Batch[] };
    return Array.isArray(body?.data) ? body.data : [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Send every waiting file to Claude now as a batch. */
export async function submitBatchNow(): Promise<BatchSubmitResult> {
  const res = await call(`${BASE}/batches/submit`, { method: "POST" });
  return res.json();
}

/** Ask Claude now whether the open batches are finished, and save any results. */
export async function checkBatchesNow(): Promise<BatchPollResult> {
  const res = await call(`${BASE}/batches/poll`, { method: "POST" });
  return res.json();
}
