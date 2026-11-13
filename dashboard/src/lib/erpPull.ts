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

// Fields the hosted browser adds to /stats for this job. All optional: an
// older hosted browser doesn't send them.
type JobKind = "scrape" | "erp_audit";
type Worker = HostedStats["worker"];
export type ErpCurrent = NonNullable<Worker["current"]> & { kind?: JobKind; paused?: boolean };
export type ErpLastResult = NonNullable<Worker["lastResult"]> & { kind?: JobKind; result?: ErpPullResult | null };
export type ErpWorker = Omit<Worker, "current" | "lastResult"> & {
  current: ErpCurrent | null;
  lastResult: ErpLastResult | null;
  kind?: JobKind;
  paused?: boolean;
  result?: ErpPullResult | null;
};

export function erpWorker(stats: HostedStats | null): ErpWorker | null {
  return (stats?.worker as ErpWorker | undefined) ?? null;
}

export function isErpRequest(r: ScrapeRequest): boolean {
  return (r.scope as string) === ERP_SCOPE;
}

/** Queue the pull. Same endpoint as Refresh All, with scope "erp_audit". */
export function requestErpPull(months: number): Promise<{ request: ScrapeRequest; coalesced?: boolean }> {
  // api.ops.requestRescrape types scope as "all" | "selected" and the low-level
  // request helper in api.ts isn't exported, hence the cast.
  return api.ops.requestRescrape({ scope: ERP_SCOPE, months } as never);
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
