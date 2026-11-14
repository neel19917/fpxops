import { api, apiUrl, getAccessTokenOrWait, type ScrapeRequest } from "./api";
import { fmtDate } from "./format";
import type { ApprovalState } from "./types";
import { HOSTED_BROWSER_URL } from "../components/HostedFreightPop";
import type { HostedStats } from "./hostedBrowser";

// Client helpers for the "ERP audit pull": a hosted-browser job that opens
// FreightPOP's Transactions page, generates the History Report and pulls the
// rows not exported to ERP. The hosted browser runs it (and the two jobs below)
// in its own "invoicing" session: a separate window, queue, log, pause and stop
// from the scrape session, so a scrape and an invoicing job can run at the same
// time. Everything here reads and controls the invoicing session only.

export const ERP_SCOPE = "erp_audit";
export const ERP_MONTH_CHOICES = [1, 3, 6] as const;
export type ErpMonths = (typeof ERP_MONTH_CHOICES)[number];

export interface ErpPullResult { audit_id: string; total: number; pending: number }

// "Get Invoice": a second hosted-browser job. A person picks shipments in an
// ERP audit, confirms, and the job presses FreightPOP's GET INVOICE button on
// each one. Same invoicing session, pause and stop as the pull.
export const GET_INVOICE_SCOPE = "get_invoice";
export const GET_INVOICE_MAX = 200;
export interface GetInvoiceCounts { total: number; done: number; ok: number; failed: number }
export interface GetInvoiceResult { audit_id: string; total: number; ok: number; failed: number }

// "Approval check": a third hosted-browser job. It opens FreightPOP's Audit
// page, takes the Recently Approved Excel export, and the server matches it to
// one ERP audit's shipments: was each invoice approved, and by EDI or a person.
export const APPROVAL_SCOPE = "approval_check";
export interface ApprovalCheckResult { audit_id: string; approved_rows: number; matched: number; not_found: number }

// The invoicing session's state: /stats → worker.invoicing. The top-level
// worker fields describe the scrape session and are never read for these jobs.
export const INVOICING_LANE = "invoicing";
export const LANE_NEEDS_UPDATE = "The hosted browser needs its next update before it can run this";
export type JobKind = "scrape" | "erp_audit" | "get_invoice" | "approval_check";
export type ErpJobKind = Exclude<JobKind, "scrape">;
export const ERP_JOB_KINDS: readonly ErpJobKind[] = ["erp_audit", "get_invoice", "approval_check"];
type JobResult = ErpPullResult | GetInvoiceResult | ApprovalCheckResult;
type Worker = HostedStats["worker"];
export type ErpCurrent = NonNullable<Worker["current"]> & { kind?: JobKind; paused?: boolean };
export type ErpLastResult = NonNullable<Worker["lastResult"]> & { kind?: JobKind; result?: JobResult | null };
export interface ErpWorker {
  /** False when the hosted browser doesn't have an invoicing session yet (older version): nothing can be started. */
  ready: boolean;
  enabled: boolean;
  reason: string | null;
  pollSeconds: number;
  busy: boolean;
  current: ErpCurrent | null;
  lastResult: ErpLastResult | null;
  kind: ErpJobKind | null;
  paused: boolean;
  result: JobResult | null;
  /** Invoicing jobs the session has lined up behind the current one. */
  queued: { id?: string; requestId?: string }[];
}

/**
 * The invoicing session, or null before /stats has loaded. A hosted browser
 * without `worker.invoicing` gives an idle, not-ready state; the scrape
 * session's job, result and log are never used in its place.
 */
export function erpWorker(stats: HostedStats | null): ErpWorker | null {
  const worker = stats?.worker;
  if (!worker) return null;
  const lane = worker.invoicing;
  if (!lane) {
    return {
      ready: false, enabled: false, reason: LANE_NEEDS_UPDATE, pollSeconds: worker.pollSeconds, busy: false,
      current: null, lastResult: null, kind: null, paused: false, result: null, queued: [],
    };
  }
  return {
    ready: true,
    enabled: lane.enabled !== false,
    reason: lane.reason ?? worker.reason ?? null,
    pollSeconds: lane.pollSeconds ?? worker.pollSeconds,
    busy: !!lane.busy,
    current: (lane.current as ErpCurrent | null) ?? null,
    lastResult: (lane.lastResult as ErpLastResult | null) ?? null,
    kind: ERP_JOB_KINDS.find((k) => k === lane.kind) ?? null,
    paused: !!lane.paused,
    result: (lane.result as JobResult | null) ?? null,
    queued: Array.isArray(lane.queued) ? lane.queued : [],
  };
}

export function isErpRequest(r: ScrapeRequest): boolean {
  return (r.scope as string) === ERP_SCOPE;
}

export function isGetInvoiceRequest(r: ScrapeRequest): boolean {
  return (r.scope as string) === GET_INVOICE_SCOPE;
}

export function isApprovalRequest(r: ScrapeRequest): boolean {
  return (r.scope as string) === APPROVAL_SCOPE;
}

/** Which of the three jobs a queue request is, or null for a regular scrape. */
export function requestKind(r: ScrapeRequest): ErpJobKind | null {
  return isGetInvoiceRequest(r) ? "get_invoice" : isApprovalRequest(r) ? "approval_check" : isErpRequest(r) ? "erp_audit" : null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function asPullResult(v: unknown): ErpPullResult | null {
  const r = v as Partial<ErpPullResult> | null | undefined;
  return r && typeof r === "object" && "pending" in r ? { audit_id: String(r.audit_id ?? ""), total: num(r.total), pending: num(r.pending) } : null;
}

export function asGetInvoiceResult(v: unknown): GetInvoiceResult | null {
  const r = v as Partial<GetInvoiceResult> | null | undefined;
  return r && typeof r === "object" && "ok" in r ? { audit_id: String(r.audit_id ?? ""), total: num(r.total), ok: num(r.ok), failed: num(r.failed) } : null;
}

export function asApprovalResult(v: unknown): ApprovalCheckResult | null {
  const r = v as Partial<ApprovalCheckResult> | null | undefined;
  return r && typeof r === "object" && "matched" in r
    ? { audit_id: String(r.audit_id ?? ""), approved_rows: num(r.approved_rows), matched: num(r.matched), not_found: num(r.not_found) }
    : null;
}

/** A Get Invoice job reports { total, done, ok, failed } where a scrape reports its own counts. */
export function getInvoiceCounts(job: { counts?: unknown } | null | undefined): GetInvoiceCounts | null {
  const c = job?.counts as Partial<GetInvoiceCounts> | null | undefined;
  if (!c || typeof c !== "object" || typeof c.total !== "number") return null;
  return { total: num(c.total), done: num(c.done), ok: num(c.ok), failed: num(c.failed) };
}

/**
 * Why a Get Invoice job paused itself, taken from its log: the check after the
 * first invoice, or a FreightPOP prompt it won't answer. Null when the latest
 * such line was already resumed past, or when a person pressed Pause.
 */
export function getInvoicePauseLine(log: { text: string }[] | null | undefined): string | null {
  if (!log?.length) return null;
  for (let i = log.length - 1; i >= Math.max(0, log.length - 60); i--) {
    const text = String(log[i].text ?? "");
    const m = text.match(/(First invoice done.*|Needs a decision.*)/i);
    if (m) return m[1].trim();
    if (/\bresum(ed|ing)\b/i.test(text)) return null;
  }
  return null;
}

export function getInvoiceLabel(status: string | null | undefined): string {
  switch (status) {
    case "requested": return "Requested";
    case "done": return "Done";
    case "failed": return "Failed";
    case "not_started": return "Not started";
    default: return "";
  }
}

/** Queue the pull. Same endpoint as Refresh All, with scope "erp_audit". */
export const ERP_TYPE_CHOICES = [["non-parcel", "Non-Parcel"], ["parcel", "Parcel"], ["both", "Both"]] as const;
export type ErpShipmentType = (typeof ERP_TYPE_CHOICES)[number][0];

export function requestErpPull(months: number, shipment_type: ErpShipmentType = "non-parcel"): Promise<{ request: ScrapeRequest; coalesced?: boolean }> {
  // api.ops.requestRescrape types scope as "all" | "selected" and the low-level
  // request helper in api.ts isn't exported, hence the cast.
  return api.ops.requestRescrape({ scope: ERP_SCOPE, months, shipment_type } as never);
}

/** Queue a Get Invoice run for the picked shipments of one ERP audit. */
export function requestGetInvoices(auditId: string, shipmentIds: string[], pauseAfterFirst: boolean): Promise<{ request: ScrapeRequest }> {
  return api.ops.requestRescrape({
    scope: GET_INVOICE_SCOPE, audit_id: auditId, shipment_ids: shipmentIds, pause_after_first: pauseAfterFirst,
  } as never);
}

/** Queue an approval check for one ERP audit. The API answers 409 when one is already queued or running. */
export function requestApprovalCheck(auditId: string): Promise<{ request: ScrapeRequest }> {
  return api.ops.requestRescrape({ scope: APPROVAL_SCOPE, audit_id: auditId } as never);
}

// ── Reading a row's approval (raw.approval) ──

export const isShaun = (name: string | null | undefined) => /shaun/i.test(String(name ?? ""));

/** "shaun" is a person too; he is split out because the team asks about him by name. */
export type ApprovalGroup = "edi" | "shaun" | "person" | "unknown" | "not_approved";

export function toApprovalState(v: unknown): ApprovalState | null {
  if (!v || typeof v !== "object") return null;
  const state = v as ApprovalState;
  return state.status === "approved" || state.status === "not_found" ? state : null;
}

/** null = this shipment was never checked. */
export function approvalGroup(state: ApprovalState | null | undefined): ApprovalGroup | null {
  if (!state) return null;
  if (state.status !== "approved") return "not_approved";
  if (state.approved_by_kind === "edi") return "edi";
  if (state.approved_by_kind === "person" && state.approved_by) return isShaun(state.approved_by) ? "shaun" : "person";
  return "unknown";
}

export function approvalLabel(state: ApprovalState | null | undefined): string {
  switch (approvalGroup(state)) {
    case "edi": return "EDI";
    case "shaun":
    case "person": return String(state?.approved_by ?? "");
    case "unknown": return "Unknown";
    case "not_approved": return "Not approved";
    default: return "";
  }
}

/** The approved date as FreightPOP gave it, tidied when it parses as a date. */
export function approvalDate(state: ApprovalState | null | undefined): string {
  const s = String(state?.approved_at ?? "").trim();
  if (!s) return "";
  // A date-only string is UTC midnight, which shows as the day before in US time zones.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return isNaN(d.getTime()) ? s : fmtDate(d.toISOString());
}

// ── FreightPOP's own Excel files, kept with each pull ──

export type AuditExcelWhich = "not-exported" | "full" | "recently-approved";

/** Fetch one of a pull's .xlsx files (signed in) and save it under the name the server gives. */
export async function downloadAuditExcel(auditId: string, which: AuditExcelWhich): Promise<void> {
  const token = await getAccessTokenOrWait();
  const res = await fetch(`${apiUrl}/api/audits/invoice/${encodeURIComponent(auditId)}/excel?which=${which}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(String(body.error));
    throw new Error(res.status === 404 ? "No Excel file was kept for this pull." : `The server returned ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1];
  let name = /filename="([^"]+)"/i.exec(cd)?.[1] || /filename=([^;]+)/i.exec(cd)?.[1]?.trim() || "";
  if (star) { try { name = decodeURIComponent(star.trim().replace(/^"|"$/g, "")); } catch { /* keep the plain name */ } }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name || `freightpop-${which}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** The hosted browser doesn't have this endpoint yet (older version). */
export class EndpointMissingError extends Error {
  constructor() {
    super("The hosted browser hasn't been updated with this feature yet.");
    this.name = "EndpointMissingError";
  }
}

async function post<T>(path: string): Promise<T> {
  if (!HOSTED_BROWSER_URL) throw new Error("Hosted browser not configured (VITE_FPX_BROWSER_URL)");
  const token = await getAccessTokenOrWait();
  const res = await fetch(`${HOSTED_BROWSER_URL}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(`Hosted browser: ${body.error}`);
    if (res.status === 404 || res.status === 405) throw new EndpointMissingError();
    throw new Error(`Hosted browser returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Pause, resume, stop and the full log, for the invoicing session only. The
// scrape session's job is never touched.
const LANE_QS = `lane=${INVOICING_LANE}`;
export const pauseErpPull = () => post<{ ok: boolean; paused: boolean }>(`/scrape/pause?${LANE_QS}`);
export const resumeErpPull = () => post<{ ok: boolean; paused: boolean }>(`/scrape/resume?${LANE_QS}`);
export const stopErpPull = () => post<{ stopping: boolean }>(`/scrape/stop?${LANE_QS}`);

/** The invoicing session's full log (the running job, else the last one) as a .log download. */
export async function downloadErpLog(): Promise<void> {
  if (!HOSTED_BROWSER_URL) throw new Error("Hosted browser not configured (VITE_FPX_BROWSER_URL)");
  const token = await getAccessTokenOrWait();
  const res = await fetch(`${HOSTED_BROWSER_URL}/scrape/log?${LANE_QS}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ? `Hosted browser: ${body.error}` : `Hosted browser returned ${res.status}`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "invoicing.log";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
