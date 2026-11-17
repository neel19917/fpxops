import { apiUrl, getAccessTokenOrWait } from "./api";

// Client calls for the "Reading invoices" page: the invoice reader's live
// state and its step-by-step log, from /api/invoice-docs/state and /log,
// plus the two buttons (POST /process).

export type LogLevel = "info" | "ok" | "warn" | "error";
export type LogStep = "started" | "downloaded" | "unchanged" | "copied" | "sent" | "read" | "embedded" | "done" | "failed" | "run";

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
}

export interface ProcessResult {
  queued: number;
  processing: boolean;
  reason?: string;
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
    if (body?.error) throw new Error(String(body.error));
    throw new Error(res.status === 404 ? "The server does not have this page yet. It needs its next update." : `The server returned ${res.status}`);
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

/** Queue every saved file that has not been read and start reading. */
export async function processWaiting(opts: { retryFailed?: boolean } = {}): Promise<ProcessResult> {
  const res = await call(`${BASE}/process`, {
    method: "POST",
    body: JSON.stringify(opts.retryFailed ? { retry_failed: true } : {}),
  });
  return res.json();
}
