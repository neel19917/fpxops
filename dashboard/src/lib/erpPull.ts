import { api, getAccessTokenOrWait, type ScrapeRequest } from "./api";
import { HOSTED_BROWSER_URL } from "../components/HostedFreightPop";
import type { HostedStats } from "./hostedBrowser";

// Client helpers for the "ERP audit pull": a hosted-browser job that opens
// FreightPOP's Transactions page, generates the History Report and pulls the
// rows not exported to ERP. It shares the scrape queue, worker and log with
// Refresh All (one automation at a time), so most of the plumbing is
// lib/hostedBrowser.ts; this file adds the parts that are new for the pull.

export const ERP_SCOPE = "erp_audit";
export const ERP_MONTH_CHOICES = [1, 3, 6] as const;
export type ErpMonths = (typeof ERP_MONTH_CHOICES)[number];

export interface ErpPullResult { audit_id: string; total: number; pending: number }

// "Get Invoice": a second hosted-browser job. A person picks shipments in an
// ERP audit, confirms, and the job presses FreightPOP's GET INVOICE button on
// each one. Same queue, worker, pause and stop as the pull.
export const GET_INVOICE_SCOPE = "get_invoice";
export const GET_INVOICE_MAX = 200;
export interface GetInvoiceCounts { total: number; done: number; ok: number; failed: number }
export interface GetInvoiceResult { audit_id: string; total: number; ok: number; failed: number }

// Fields the hosted browser adds to /stats for these jobs. All optional: an
// older hosted browser doesn't send them.
export type JobKind = "scrape" | "erp_audit" | "get_invoice";
export type ErpJobKind = Exclude<JobKind, "scrape">;
type JobResult = ErpPullResult | GetInvoiceResult;
type Worker = HostedStats["worker"];
export type ErpCurrent = NonNullable<Worker["current"]> & { kind?: JobKind; paused?: boolean };
export type ErpLastResult = NonNullable<Worker["lastResult"]> & { kind?: JobKind; result?: JobResult | null };
export type ErpWorker = Omit<Worker, "current" | "lastResult"> & {
  current: ErpCurrent | null;
  lastResult: ErpLastResult | null;
  kind?: JobKind | null;
  paused?: boolean;
  result?: JobResult | null;
};

export function erpWorker(stats: HostedStats | null): ErpWorker | null {
  return (stats?.worker as ErpWorker | undefined) ?? null;
}

export function isErpRequest(r: ScrapeRequest): boolean {
  return (r.scope as string) === ERP_SCOPE;
}

export function isGetInvoiceRequest(r: ScrapeRequest): boolean {
  return (r.scope as string) === GET_INVOICE_SCOPE;
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

export const pauseErpPull = () => post<{ ok: boolean; paused: boolean }>("/scrape/pause");
export const resumeErpPull = () => post<{ ok: boolean; paused: boolean }>("/scrape/resume");
