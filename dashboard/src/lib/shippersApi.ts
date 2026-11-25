import { apiUrl, getAccessTokenOrWait } from "./api";
import { impersonateHeaders } from "./impersonate";

// Shippers view: one dashboard per shipper (fpx_shipments.customer_name) with tracking, tasks and emails.
// Shipper key = encodeURIComponent(customer_name); null/blank customer_name → "__none__" ("(No shipper)").

export const SHIPPER_NONE_KEY = "__none__";
export const SHIPPER_NONE_LABEL = "(No shipper)";

export interface ShipperRow {
  key: string;
  customer_name: string;
  shipments: number;
  active: number;
  in_transit: number;
  delivered_30d: number;
  exceptions: number;
  last_scraped_at: string | null;
  last_pickup_date: string | null;
  open_tasks: number;
  overdue_tasks: number;
  email_threads: number | null;
  awaiting_reply: number | null;
  last_email_at: string | null;
}

export interface ShipperTotals {
  shippers: number;
  shipments: number;
  active: number;
  open_tasks: number;
  exceptions: number;
  awaiting_reply: number | null;
}

export interface NameCount {
  name: string;
  count: number;
}

export interface ShipperDetail {
  shipper: ShipperRow;
  carriers: NameCount[];
  modes: NameCount[];
  statuses: NameCount[];
  email_access: "none" | "view" | "draft";
}

export interface ShipperShipment {
  id: string;
  shipment_id: string | null;
  tracking_number: string | null;
  shipment_status: string | null;
  action_required: boolean | null;
  carrier_name: string | null;
  mode: string | null;
  origin: string | null;
  destination: string | null;
  pickup_date: string | null;
  estimated_arrival: string | null;
  delivery_date: string | null;
  scraped_at: string | null;
  archived_at: string | null;
  ai_issue: string | null;
  open_tasks: number;
  email_threads: number | null;
}

export interface ShipperTask {
  id: string;
  shipment_id: string | null;
  tracking_number: string | null;
  title: string;
  status: string;
  priority: string | null;
  assigned_to: string | null;
  due_at: string | null;
  created_at: string;
  completed_at: string | null;
  overdue: boolean;
}

export interface ShipperThread {
  conversation_id: string;
  subject: string | null;
  last_message_at: string | null;
  status: string;
  party: string;
  message_count: number;
  last_from_name: string | null;
  last_from_address: string | null;
  preview: string | null;
  linked_shipment_ids: string[];
}

export interface TimelineEvent {
  at: string;
  kind: "note" | "task_created" | "task_done" | "email" | "status";
  title: string;
  detail: string | null;
  shipment_id: string | null;
  tracking_number: string | null;
  ref_id: string | null;
  actor: string | null;
}

export type ShipperSort = "shipments" | "name" | "open_tasks" | "exceptions" | "awaiting_reply" | "last_email";
export type ShipperShipmentStatus = "active" | "in_transit" | "exceptions" | "delivered" | "all";
export type ShipperTaskStatus = "open" | "done" | "all";
export type ShipperEmailStatus = "all" | "awaiting_reply" | "responded";
export type ShipperEmailDays = 7 | 30 | 90 | "all";

export interface ShipperListParams { q?: string; sort?: ShipperSort | string }
export interface ShipperShipmentsParams { status?: ShipperShipmentStatus; q?: string; limit?: number; offset?: number }
export interface ShipperTasksParams { status?: ShipperTaskStatus; limit?: number }
export interface ShipperEmailsParams { status?: ShipperEmailStatus; days?: ShipperEmailDays; limit?: number }
export interface ShipperTimelineParams { limit?: number }

export interface ShipperListResponse { shippers: ShipperRow[]; totals: ShipperTotals }
export interface ShipperShipmentsResponse { shipments: ShipperShipment[]; total: number }
export interface ShipperTasksResponse {
  tasks: ShipperTask[];
  counts: { open: number; in_progress: number; blocked: number; overdue: number; done_30d: number };
}
export interface ShipperEmailsResponse {
  threads: ShipperThread[];
  counts: { all: number; awaiting_reply: number; responded: number };
}
export interface ShipperTimelineResponse { events: TimelineEvent[] }

/** Thrown by getShipperEmails when the signed-in user has no Support Mailbox access (403 mailbox_no_access). */
export class ShipperEmailForbiddenError extends Error {
  code = "mailbox_no_access" as const;
  constructor(message?: string) {
    super(message || "You don't have access to the Support Mailbox.");
    this.name = "ShipperEmailForbiddenError";
  }
}

/** Error carrying the HTTP status (404 = unknown shipper). */
export class ShipperApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ShipperApiError";
    this.status = status;
    this.code = code;
  }
}

/** Same key rule as the server: blank/null → "__none__", else encodeURIComponent(name). */
export function shipperKeyOf(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n || n === SHIPPER_NONE_LABEL) return SHIPPER_NONE_KEY;
  return encodeURIComponent(n);
}

/** Route to a shipper's dashboard. `key` is already URL-safe (from ShipperRow.key or shipperKeyOf). */
export const shipperHref = (key: string) => `/shippers/${key}`;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Path segment for a key; accepts an encoded key or a decoded name (useParams decodes). */
function keySegment(key: string): string {
  return encodeURIComponent(safeDecode(key));
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = await getAccessTokenOrWait();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/shippers${path}`, {
      method: "GET",
      signal: signal ?? AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, ...impersonateHeaders() },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw e;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error ? String(body.error) : `The server returned ${res.status}`;
    const code = body?.code ? String(body.code) : null;
    if (res.status === 403 && code === "mailbox_no_access") throw new ShipperEmailForbiddenError(body?.error ? String(body.error) : undefined);
    if (res.status === 404 && !body?.error) throw new ShipperApiError("Shipper not found.", 404, code);
    throw new ShipperApiError(msg, res.status, code);
  }
  return res.json() as Promise<T>;
}

export const listShippers = (params: ShipperListParams = {}, signal?: AbortSignal) =>
  get<ShipperListResponse>(`${qs({ q: params.q, sort: params.sort })}`, signal);

export const getShipper = (key: string, signal?: AbortSignal) =>
  get<ShipperDetail>(`/${keySegment(key)}`, signal);

export const getShipperShipments = (key: string, params: ShipperShipmentsParams = {}, signal?: AbortSignal) =>
  get<ShipperShipmentsResponse>(
    `/${keySegment(key)}/shipments${qs({ status: params.status, q: params.q, limit: params.limit, offset: params.offset })}`,
    signal,
  );

export const getShipperTasks = (key: string, params: ShipperTasksParams = {}, signal?: AbortSignal) =>
  get<ShipperTasksResponse>(`/${keySegment(key)}/tasks${qs({ status: params.status, limit: params.limit })}`, signal);

export const getShipperEmails = (key: string, params: ShipperEmailsParams = {}, signal?: AbortSignal) =>
  get<ShipperEmailsResponse>(
    `/${keySegment(key)}/emails${qs({ status: params.status, days: params.days, limit: params.limit })}`,
    signal,
  );

export const getShipperTimeline = (key: string, params: ShipperTimelineParams = {}, signal?: AbortSignal) =>
  get<ShipperTimelineResponse>(`/${keySegment(key)}/timeline${qs({ limit: params.limit })}`, signal);
