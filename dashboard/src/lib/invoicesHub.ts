import { useCallback } from "react";
import { apiUrl, getAccessTokenOrWait } from "./api";
import { cachedFetch, invalidateCache } from "./sessionCache";
import { useCached, type Cached } from "./useCached";

// Client calls and shared words for the Invoices page (/invoices): find any
// invoice, and see where every invoice stands. Reads only, except
// processInvoiceDocs, which asks FPX to read a shipment's saved documents.

/** Where a shipment's invoice stands. The API calls this the "bucket". */
export type HubStep = "no_invoice" | "invoice_not_approved" | "approved_ready" | "exported";
export type ApproverKind = "edi" | "person" | "unknown";

export interface HubRow {
  shipment_id: string;
  tracking_number: string | null;
  customer_name: string | null;
  carrier: string | null;
  shipped_date: string | null;
  charge: number | null;
  cost: number | null;
  gross_profit: number | null;
  exported_to_erp: boolean | null;
  approved_invoice_amount: number | null;
  not_approved_invoice_amount: number | null;
  approved: boolean | null;
  approved_by: string | null;
  approved_by_kind: ApproverKind | null;
  approved_date: string | null;
  approved_invoice_number: string | null;
  approved_amount: number | null;
  approval_variance: number | null;
  approval_notes: string | null;
  bucket: HubStep;
  last_seen_at: string | null;
}

export type HubCounts = Record<HubStep, number | null>;

export interface HubList {
  data: HubRow[];
  /** Per step, with the search and "approved by" filter applied (not the step). null = could not be counted. */
  counts: HubCounts;
  totals: { all: number | null; matching: number | null };
  limit: number;
  offset: number;
  /** A search matched more shipments than the server looks at: only the biggest-charge ones are listed and counted. */
  truncated?: boolean;
}

export interface HubListFilters {
  q?: string;
  step?: HubStep | null;
  approvedBy?: ApproverKind | null;
  limit?: number;
  offset?: number;
}

export interface HubSummary {
  transactions: { rows: number; last_seen_at: string | null };
  approvals: { rows: number; last_seen_at: string | null };
}

export interface InvoiceDocLine {
  description: string | null;
  quantity: number | string | null;
  rate: number | string | null;
  amount: number | string | null;
}

/** What FPX read off one saved invoice document. */
export interface InvoiceDoc {
  id: string;
  shipment_id: string | null;
  audit_id: string | null;
  file: string | null;
  doc_type: string | null;
  status: "pending" | "processing" | "done" | "failed" | "skipped";
  error: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  carrier: string | null;
  bill_to: string | null;
  ship_from: string | null;
  ship_to: string | null;
  tracking_number: string | null;
  bol_number: string | null;
  po_number: string | null;
  so_number: string | null;
  terms: string | null;
  currency: string | null;
  subtotal: number | null;
  fuel_surcharge: number | null;
  accessorial_total: number | null;
  total: number | null;
  line_items: InvoiceDocLine[] | null;
  fields: Record<string, string> | null;
  summary: string | null;
  confidence: number | null;
  warnings: string[] | string | null;
  model: string | null;
  extracted_at: string | null;
}

export type InvoiceDocHit = InvoiceDoc & { score?: number | null };

// ── The four steps, in the order the work happens ──

export interface HubStepInfo {
  key: HubStep;
  /** Short name on the step card. */
  title: string;
  /** One plain line under the title. */
  meaning: string;
  /** "What this means", two or three plain sentences. */
  what: string;
  /** "What to do next". */
  next: string;
  /** The one action of the step, a link to the screen where the work is done. */
  action: { label: string; to: string } | null;
  /** Whether "Approved by" can narrow this step's list. */
  approverFilter: boolean;
  /** Said when the step has no shipments. */
  empty: string;
}

export const HUB_STEPS: readonly HubStepInfo[] = [
  {
    key: "no_invoice",
    title: "Waiting for the carrier's invoice",
    meaning: "The shipment moved, but the carrier has not billed for it yet.",
    what: "These shipments are in FreightPOP, but no carrier invoice has arrived for them. Until the carrier sends one there is nothing to check or approve.",
    next: "Nothing to do yet. A shipment moves to the next step by itself once its carrier invoice arrives in FreightPOP.",
    action: null,
    approverFilter: false,
    empty: "No shipments are waiting for a carrier invoice.",
  },
  {
    key: "invoice_not_approved",
    title: "Invoice received, not approved yet",
    meaning: "The carrier's invoice is in. Someone needs to check and approve it.",
    what: "The carrier has sent an invoice for each of these shipments, but nobody has approved it in FreightPOP. An invoice usually waits here because its amount does not match what was quoted.",
    next: "Open a shipment below to see its amounts and saved documents, then use Open in FreightPOP to review and approve the invoice there. Once approved, it moves to the next step the next time FPX reads FreightPOP.",
    action: null,
    approverFilter: false,
    empty: "No carrier invoices are waiting to be approved.",
  },
  {
    key: "approved_ready",
    title: "Approved, ready to send",
    meaning: "The carrier's invoice is approved. The customer invoice can go out.",
    what: "The carrier invoice for each of these shipments has been approved, either automatically (EDI) or by a person. They have not been pushed to the ERP yet.",
    next: "Send their invoices. The button below opens the sending screen, where you pick the shipments and FPX sends them in FreightPOP for you.",
    action: { label: "Send these invoices", to: "/invoicing?tab=approved" },
    approverFilter: true,
    empty: "Nothing is approved and waiting to be sent.",
  },
  {
    key: "exported",
    title: "Pushed to the ERP",
    meaning: "Done in FreightPOP. The invoice has gone to NetSuite.",
    what: "FreightPOP has pushed these invoices to the ERP (NetSuite). Nothing more needs doing in FreightPOP.",
    next: "If you want to be sure NetSuite has them, compare the two. The button below opens the screen where you paste invoice numbers from NetSuite and see which ones match.",
    action: { label: "Match with NetSuite", to: "/invoicing/pushed" },
    approverFilter: true,
    empty: "Nothing has been pushed to the ERP yet.",
  },
];

export const HUB_STEP_KEYS: readonly HubStep[] = HUB_STEPS.map((s) => s.key);
export const hubStep = (key: HubStep): HubStepInfo => HUB_STEPS.find((s) => s.key === key) ?? HUB_STEPS[0];
export const isHubStep = (v: string | null | undefined): v is HubStep => !!v && (HUB_STEP_KEYS as readonly string[]).includes(v);
/** The step's position, 1 to 4. */
export const hubStepNumber = (key: HubStep): number => HUB_STEP_KEYS.indexOf(key) + 1;

/** A short status word for a table cell or result row. */
export const HUB_STEP_SHORT: Record<HubStep, { label: string; cls: string }> = {
  no_invoice: { label: "Waiting for invoice", cls: "bg-slate-100 text-slate-700" },
  invoice_not_approved: { label: "Not approved yet", cls: "bg-amber-50 text-amber-800" },
  approved_ready: { label: "Approved, ready to send", cls: "bg-violet-50 text-violet-800" },
  exported: { label: "Pushed to the ERP", cls: "bg-sky-50 text-sky-800" },
};

// ── Words and numbers ──

export const hubMoney = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** "Nov 16", or "Nov 16, 2025" when it is not this year. Date-only values are not shifted by the time zone. */
export function hubDay(s: string | null | undefined): string {
  if (!s) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

// ── How fresh the data is ──

/** ERP data read longer ago than this may be out of date. */
export const STALE_HOURS = 36;

/** Hours since a time, or null when there is no (valid) time. */
export function hoursSince(s: string | null | undefined, now = Date.now()): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 3_600_000);
}

/** True when FPX last read this from FreightPOP more than STALE_HOURS ago. Unknown times are not flagged. */
export function isStale(s: string | null | undefined, now = Date.now()): boolean {
  const h = hoursSince(s, now);
  return h != null && h > STALE_HOURS;
}

/** "just now", "5 minutes ago", "3 hours ago", "3 days ago", or "" when unknown. */
export function hubAgo(s: string | null | undefined, now = Date.now()): string {
  const h = hoursSince(s, now);
  if (h == null) return "";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  const min = Math.round(h * 60);
  if (min < 1) return "just now";
  if (min < 60) return plural(min, "minute");
  if (h < 48) return plural(Math.round(h), "hour");
  return plural(Math.round(h / 24), "day");
}

/** The tooltip of the amber dot on a row whose ERP data is old. */
export function staleTitle(s: string | null | undefined): string {
  const ago = hubAgo(s);
  return `Last read from FreightPOP ${ago || "a while ago"}. It may be out of date.`;
}

/** Said when a search fails, whatever the server said. */
export const SEARCH_FAILED_MESSAGE = "Search took too long. Try a shipment, invoice or tracking number.";

/** Where the button that reads FreightPOP again lives. */
export const REFRESH_FROM_FREIGHTPOP_PATH = "/invoicing";

/** Who approved it, in plain words: "EDI", a person's name, or "". */
export function hubApprover(row: Pick<HubRow, "approved_by" | "approved_by_kind">): string {
  if (row.approved_by_kind === "edi") return "EDI";
  return (row.approved_by || "").trim();
}

/** One or two plain sentences saying where this shipment's invoice stands. */
export function hubStatusSentence(row: HubRow): string {
  const amount = row.approved_amount ?? row.approved_invoice_amount;
  const pushed = row.bucket === "exported" || row.exported_to_erp === true;
  const tail = pushed ? "It has been pushed to the ERP." : "Not pushed to the ERP yet.";
  if (row.bucket === "no_invoice" && !pushed) return "The carrier has not sent an invoice for this shipment yet.";
  if (row.bucket === "invoice_not_approved") {
    const amt = row.not_approved_invoice_amount;
    return `The carrier's invoice${amt != null ? ` for ${hubMoney(amt)}` : ""} has arrived, but nobody has approved it yet. ${tail}`;
  }
  const who = hubApprover(row);
  const day = hubDay(row.approved_date);
  if (row.approved || who || day || amount != null) {
    return `Approved${who ? ` by ${who}` : ""}${day ? ` on ${day}` : ""}${amount != null ? ` for ${hubMoney(amount)}` : ""}. ${tail}`;
  }
  return pushed ? "This shipment's invoice has been pushed to the ERP." : tail;
}

// ── Calls ──

// Counting 48,000 shipments per step can be slow on a cold server.
const TIMEOUT_MS = 60_000;

/** The server does not have this endpoint yet, or it is failing: the caller hides that part of the page. */
export class NotAvailableError extends Error {
  constructor() { super("Not available yet"); this.name = "NotAvailableError"; }
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

async function call(path: string, init?: RequestInit & { optional?: boolean }): Promise<Response> {
  const token = await getAccessTokenOrWait();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method: init?.method,
      body: init?.body,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw e;
  }
  if (!res.ok) {
    if (init?.optional && (res.status === 404 || res.status >= 500)) throw new NotAvailableError();
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(String(body.error));
    throw new Error(res.status === 404 ? "The server does not have this page yet. It needs its next update." : `The server returned ${res.status}`);
  }
  return res;
}

// ── Cache ──
// The summary and every list page go through a stale-while-revalidate cache
// (memory + sessionStorage, see sessionCache.ts). The page shows the last
// numbers at once and asks again in the background; list pages and searches
// reuse an answer younger than LIST_FRESH_MS. Anything that changes invoices
// calls invalidateHubCache().

const CACHE_PREFIX = "hub.";
/** A list page or search younger than this is reused without asking the server. */
export const LIST_FRESH_MS = 60_000;

export const hubSummaryKey = (): string => `${CACHE_PREFIX}summary`;

function hubListParams(f: HubListFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.step) p.set("bucket", f.step);
  if (f.approvedBy) p.set("approved_by_kind", f.approvedBy);
  p.set("limit", String(f.limit ?? 50));
  if (f.offset) p.set("offset", String(f.offset));
  return p;
}

/** The cache key of one list call: the same filters give the same key. */
export const hubListKey = (f: HubListFilters): string => `${CACHE_PREFIX}list?${hubListParams(f).toString()}`;

/**
 * Something changed invoices (sent, approved, read): every cached count and
 * list is marked stale. It keeps showing, and the next look asks the server.
 * `except` leaves one key alone (the answer that just showed the change).
 */
export function invalidateHubCache(except?: string): void {
  invalidateCache(CACHE_PREFIX, except);
}

async function loadHubSummary(signal: AbortSignal): Promise<HubSummary> {
  return (await call("/api/audits/erp/summary", { signal })).json();
}

async function loadHubList(f: HubListFilters, signal: AbortSignal): Promise<HubList> {
  return (await call(`/api/audits/erp/invoicing?${hubListParams(f).toString()}`, { signal })).json();
}

/** How much FPX holds from FreightPOP and when it last read it. Always asks the server (shared with a call in flight). */
export function fetchHubSummary(signal?: AbortSignal): Promise<HubSummary> {
  return cachedFetch(hubSummaryKey(), loadHubSummary, { signal });
}

/** One page of shipments (biggest charge first), with the count in each step. Reuses an answer younger than LIST_FRESH_MS. */
export function fetchHubList(f: HubListFilters, signal?: AbortSignal, opts: { maxAgeMs?: number } = {}): Promise<HubList> {
  return cachedFetch(hubListKey(f), (s) => loadHubList(f, s), { signal, maxAgeMs: opts.maxAgeMs ?? LIST_FRESH_MS });
}

/** The summary, shown from the cache at once and refreshed in the background. */
export function useHubSummary(): Cached<HubSummary> {
  return useCached(hubSummaryKey(), loadHubSummary);
}

/** One list call, shown from the cache at once and refreshed in the background. */
export function useHubList(f: HubListFilters): Cached<HubList> {
  const key = hubListKey(f);
  // The key holds every filter, so a fetcher made for this key is right for it.
  const fetcher = useCallback((s: AbortSignal) => loadHubList(f, s), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useCached(key, fetcher);
}

/** One shipment by its exact shipment number, or null when FPX does not know it. */
export async function fetchHubShipment(shipmentId: string, signal?: AbortSignal): Promise<HubRow | null> {
  const list = await fetchHubList({ q: shipmentId, limit: 25 }, signal);
  const want = shipmentId.trim().toUpperCase();
  return list.data.find((r) => String(r.shipment_id).toUpperCase() === want) ?? null;
}

/** Search the text FPX read off saved invoice documents. Throws NotAvailableError when the server cannot do it yet. */
export async function searchInvoiceDocs(q: string, limit = 8, signal?: AbortSignal): Promise<{ data: InvoiceDocHit[]; mode: string | null }> {
  const p = new URLSearchParams({ q: q.trim(), limit: String(limit) });
  const body = await (await call(`/api/invoice-docs/search?${p.toString()}`, { signal, optional: true })).json();
  return { data: Array.isArray(body?.data) ? body.data : [], mode: body?.mode ?? null };
}

/** What FPX read off the saved documents of one shipment. Throws NotAvailableError when the server cannot do it yet. */
export async function fetchInvoiceDocs(shipmentId: string, signal?: AbortSignal): Promise<InvoiceDoc[]> {
  const body = await (await call(`/api/invoice-docs?shipment_id=${encodeURIComponent(shipmentId)}`, { signal, optional: true })).json();
  return Array.isArray(body?.data) ? body.data : [];
}

/** Ask FPX to read this shipment's saved documents now. */
export async function processInvoiceDocs(shipmentId: string): Promise<void> {
  await call("/api/invoice-docs/process", { method: "POST", body: JSON.stringify({ shipment_id: shipmentId }) });
  invalidateHubCache();
}
