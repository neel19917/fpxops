import { apiUrl, getAccessTokenOrWait } from "./api";

// Client calls for the "Pushed to ERP" page: the invoices FreightPOP has
// already exported to the ERP (NetSuite), from /api/audits/erp/pushed.
// Read only.

export type PushedDateSource = "freightpop_export_date" | "first_seen_exported" | "unknown";

export interface PushedRow {
  /** null for an approved carrier invoice with no shipment row (match results only). */
  shipment_id: string | null;
  tracking_number: string | null;
  customer_name: string | null;
  carrier: string | null;
  shipped_date: string | null;
  /** The customer invoice number. */
  billing_invoice_number: string | null;
  /** The carrier invoice number of the approval that stands. */
  invoice_number: string | null;
  /** Every carrier invoice number approved for the shipment. */
  invoice_numbers: string[];
  approved_invoice_amount: number | null;
  charge: number | null;
  cost: number | null;
  gross_profit: number | null;
  pushed: boolean;
  pushed_date: string | null;
  pushed_date_source: PushedDateSource;
  /** FreightPOP's own "Exported" flag of the carrier invoice; null when it did not say. */
  carrier_invoice_exported: boolean | null;
  approved_date: string | null;
  approved_by: string | null;
  batch_number: string | null;
  gl_code: string | null;
  internal_vendor_id: string | null;
  po_number: string | null;
  so_number: string | null;
  bol_number: string | null;
  payee: string | null;
  /** When the row was last read from FreightPOP. */
  last_seen_at: string | null;
  /** Files (screenshots, documents) FPX has saved for the shipment; list rows only. */
  saved_files?: number;
}

export interface PushedTotals {
  count: number;
  dated: number;
  undated: number;
  charge: number;
  cost: number;
  gross_profit: number;
  approved_invoice_amount: number;
}

export interface PushedList {
  data: PushedRow[];
  totals: PushedTotals;
  per_day: { date: string; count: number; charge: number }[];
  limit: number;
  offset: number;
  read_at: string;
}

export interface PushedFilters {
  from?: string;
  to?: string;
  /** Leave out invoices with no known push date. */
  datedOnly?: boolean;
  q?: string;
  carrier?: string;
  customer?: string;
  limit?: number;
  offset?: number;
}

export type MatchedOn = "shipment_id" | "billing_invoice_number" | "invoice_number" | "bol_number" | "tracking_number";

export interface MatchResult {
  input: string;
  found: boolean;
  pushed: boolean;
  matched_on: MatchedOn | null;
  row: PushedRow | null;
  /** Other shipments the same value also matched. */
  others: number;
}

export interface MatchResponse {
  results: MatchResult[];
  summary: { total: number; pushed: number; not_pushed: number; not_found: number };
  max: number;
  read_at: string;
}

export const MATCH_MAX = 5000;

export const PUSHED_SOURCE_LABEL: Record<PushedDateSource, string> = {
  freightpop_export_date: "FreightPOP export date",
  first_seen_exported: "First seen exported",
  unknown: "Not known",
};

export const PUSHED_SOURCE_HINT: Record<PushedDateSource, string> = {
  freightpop_export_date: "The Exported Date FreightPOP shows for the carrier invoice on its Audit page.",
  first_seen_exported: "The day FPX first read this shipment as exported. It was pushed on or shortly before this day.",
  unknown: "It was already exported the first time FPX read it, and FreightPOP gave no export date.",
};

export const MATCHED_ON_LABEL: Record<MatchedOn, string> = {
  shipment_id: "Shipment ID",
  billing_invoice_number: "Customer invoice number",
  invoice_number: "Carrier invoice number",
  bol_number: "BOL number",
  tracking_number: "Tracking number",
};

// The first read after a quiet minute goes through every stored shipment, so
// these calls are given longer than the usual 20 seconds.
const TIMEOUT_MS = 90_000;
const BASE = "/api/audits/erp/pushed";

function queryOf(f: PushedFilters, paging: boolean): string {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.datedOnly) p.set("dated", "1");
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.carrier?.trim()) p.set("carrier", f.carrier.trim());
  if (f.customer?.trim()) p.set("customer", f.customer.trim());
  if (paging) {
    if (f.limit != null) p.set("limit", String(f.limit));
    if (f.offset) p.set("offset", String(f.offset));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

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

/** One page of pushed invoices, with totals and per-day counts of everything the filter matches. */
export async function fetchPushed(filters: PushedFilters, signal?: AbortSignal): Promise<PushedList> {
  const res = await call(`${BASE}${queryOf(filters, true)}`, signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) } : undefined);
  return res.json();
}

export interface PushedRecord { kind: string; audit_id: string | null; files: string[]; captured_at: string | null; captured_by: string | null }
export interface PushedRecords { shipment_id: string; quote_id: string | null; records: PushedRecord[] }
/** The screenshots and documents FPX has saved for one shipment. */
export async function fetchPushedRecords(shipmentId: string): Promise<PushedRecords> {
  const res = await call(`${BASE}/records/${encodeURIComponent(shipmentId)}`);
  return res.json();
}

/** Every pushed invoice the filter matches, as an Excel file. */
export async function downloadPushedExcel(filters: PushedFilters): Promise<void> {
  const res = await call(`${BASE}/export${queryOf(filters, false)}`);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/i.exec(res.headers.get("content-disposition") || "")?.[1] || "PushedToERP.xlsx";
  saveBlob(blob, name);
}

/** Look up invoice numbers and/or shipment ids pasted from NetSuite. */
export async function matchPushed(invoices: string[]): Promise<MatchResponse> {
  const res = await call(`${BASE}/match`, { method: "POST", body: JSON.stringify({ invoices }) });
  return res.json();
}

/** The text of the paste box → one value per entry, blanks and repeats dropped. */
export function splitPasted(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\n\r,;\t]+/)) {
    const v = part.trim().replace(/^["']+|["']+$/g, "").trim();
    const k = v.toUpperCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One group of match results as a CSV file (opens in Excel). */
export function matchCsv(results: MatchResult[]): Blob {
  const head = ["Pasted value", "Result", "Matched on", "Shipment ID", "Customer invoice number", "Carrier invoice number", "Tracking number", "Customer", "Carrier", "Pushed date", "Charge", "Cost", "Approved invoice amount"];
  const lines = results.map((m) => {
    const r = m.row;
    return [
      m.input,
      m.pushed ? "Pushed to ERP" : m.found ? "In FreightPOP, not pushed" : "Not found",
      m.matched_on ? MATCHED_ON_LABEL[m.matched_on] : "",
      r?.shipment_id, r?.billing_invoice_number, r?.invoice_number, r?.tracking_number, r?.customer_name, r?.carrier,
      r?.pushed_date, r?.charge, r?.cost, r?.approved_invoice_amount,
    ].map(csvCell).join(",");
  });
  // The BOM makes Excel read the file as UTF-8.
  return new Blob(["﻿" + [head.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
}
