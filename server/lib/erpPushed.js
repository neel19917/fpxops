// "Pushed to ERP": which invoices FreightPOP has already exported to the ERP
// (NetSuite), read from the two tables the invoicing pulls keep current:
//   fpx_erp_transactions  one row per shipment; exported_to_erp is FreightPOP's
//                         "Exported to ERP" column of the History Report
//   fpx_audit_approvals   one row per approved carrier invoice; exported_date is
//                         FreightPOP's "Exported Date" on the Audit page
// A shipment counts as pushed when exported_to_erp is true. Everything here is
// pure (no network): the route loads the rows and hands them in.
import { trackingKey } from "./erpStore.js";

export const PAGE_SIZE = 1000;       // PostgREST's cap on one select
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;
export const MAX_MATCH = 5000;

// The columns read from each table. `data` (every FreightPOP column) is not
// read whole: only the few fields shown.
export const TX_SELECT = [
  "shipment_id", "tracking_number", "tracking_key", "customer_name", "carrier", "shipped_date",
  "billing_invoice_number", "charge", "cost", "gross_profit", "approved_invoice_amount",
  "invoice_approved_date", "exported_to_erp", "exported_changed_at", "first_seen_at", "last_seen_at",
  "batch_number",
].join(", ");
export const AP_SELECT = [
  "approval_key", "tracking_number", "tracking_key", "invoice_number", "carrier", "approved_date", "approved_by",
  "invoice_amount", "exported_date", "last_seen_at",
  "exported", "gl_code", "internal_vendor_id", "po_number", "so_number", "bol_number", "payee",
].join(", ");

const one = (v) => (Array.isArray(v) ? v[0] : v);
const text = (v) => { const s = String(v ?? "").trim(); return s || null; };
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const cents = (n) => Math.round(n * 100) / 100;

// "2026-11-17" or null. Takes a date, a timestamp or anything else.
export function dayOf(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// The query string of GET / and GET /export → the filter, or { error }.
export function parseFilters(query = {}) {
  const day = (name) => {
    const raw = String(one(query[name]) ?? "").trim();
    if (!raw) return { value: null };
    const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? dayOf(raw) : null;
    return value ? { value } : { error: `${name} must be a date like 2026-11-17` };
  };
  const from = day("from");
  if (from.error) return { error: from.error };
  const to = day("to");
  if (to.error) return { error: to.error };
  if (from.value && to.value && from.value > to.value) return { error: "from must not be after to" };
  const word = (name) => String(one(query[name]) ?? "").trim().slice(0, 100);
  const int = (name, fallback) => {
    const n = Number.parseInt(String(one(query[name]) ?? ""), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    from: from.value,
    to: to.value,
    dated: ["1", "true", "yes"].includes(String(one(query.dated) ?? "").trim().toLowerCase()),
    q: word("q"),
    carrier: word("carrier"),
    customer: word("customer"),
    limit: Math.min(MAX_LIMIT, Math.max(1, int("limit", DEFAULT_LIMIT))),
    offset: Math.max(0, int("offset", 0)),
  };
}

// The approval that stands for a shipment with several: the one FreightPOP
// dated as exported (the latest such), else the latest approved.
export function pickApproval(approvals) {
  let best = null;
  const rank = (a) => [a.exported_date ? "1" : "0", String(a.exported_date || ""), String(a.approved_date || ""), String(a.last_seen_at || "")].join("|");
  for (const a of approvals || []) if (!best || rank(a) > rank(best)) best = a;
  return best;
}

// When was it pushed, and how do we know.
//   freightpop_export_date  FreightPOP's own Exported Date of the carrier invoice
//   first_seen_exported     the pull on which we saw "Exported to ERP" turn on
//                           (it was pushed on or shortly before that day, UTC)
//   unknown                 already exported the first time we read it
export function pushedDate(tx, approval) {
  const fromFp = dayOf(approval?.exported_date);
  if (fromFp) return { pushed_date: fromFp, pushed_date_source: "freightpop_export_date" };
  const seen = tx?.exported_to_erp === true ? dayOf(tx.exported_changed_at) : null;
  if (seen) return { pushed_date: seen, pushed_date_source: "first_seen_exported" };
  return { pushed_date: null, pushed_date_source: "unknown" };
}

const yesNo = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return ["yes", "true", "y", "1"].includes(s) ? true : ["no", "false", "n", "0"].includes(s) ? false : null;
};

// One row of the list: a shipment (tx, may be null for an approved invoice
// with no shipment row) with its approvals.
export function shapeRow(tx, approvals = []) {
  const a = pickApproval(approvals);
  const invoiceNumbers = [...new Set((approvals || []).map((x) => text(x.invoice_number)).filter(Boolean))];
  // An approved invoice with no shipment row: FreightPOP's export date on the invoice says it was pushed.
  const pushed = tx ? tx.exported_to_erp === true : (approvals || []).some((x) => x?.exported_date);
  const seen = [tx?.last_seen_at, a?.last_seen_at].filter(Boolean).sort();
  return {
    shipment_id: tx ? String(tx.shipment_id) : null,
    tracking_number: text(tx?.tracking_number) ?? text(a?.tracking_number),
    customer_name: text(tx?.customer_name),
    carrier: text(tx?.carrier) ?? text(a?.carrier),
    shipped_date: dayOf(tx?.shipped_date),
    billing_invoice_number: text(tx?.billing_invoice_number),
    invoice_number: text(a?.invoice_number),
    invoice_numbers: invoiceNumbers,
    approved_invoice_amount: num(tx?.approved_invoice_amount) ?? num(a?.invoice_amount),
    charge: num(tx?.charge),
    cost: num(tx?.cost),
    gross_profit: num(tx?.gross_profit),
    pushed,
    ...pushedDate(tx, a),
    // FreightPOP's own "Exported" flag of the carrier invoice (Audit page); null when it did not say.
    carrier_invoice_exported: a ? (yesNo(a.exported) ?? (a.exported_date ? true : null)) : null,
    approved_date: dayOf(a?.approved_date) ?? dayOf(tx?.invoice_approved_date),
    approved_by: text(a?.approved_by),
    batch_number: text(tx?.batch_number),
    gl_code: text(a?.gl_code),
    internal_vendor_id: text(a?.internal_vendor_id),
    po_number: text(a?.po_number),
    so_number: text(a?.so_number),
    bol_number: text(a?.bol_number),
    payee: text(a?.payee),
    // When the shipment row was last read from FreightPOP (the approval's, when there is no shipment row).
    last_seen_at: tx?.last_seen_at ?? seen[seen.length - 1] ?? null,
  };
}

// approvals → Map(tracking_key → approvals[])
export function approvalsByKey(approvals) {
  const by = new Map();
  for (const a of approvals || []) {
    const k = a.tracking_key || trackingKey(a.tracking_number);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(a);
  }
  return by;
}

// Shipments joined to their approvals. pushedOnly drops shipments not exported.
export function buildRows(transactions, approvals, { pushedOnly = true } = {}) {
  const by = approvalsByKey(approvals);
  const out = [];
  for (const tx of transactions || []) {
    if (pushedOnly && tx.exported_to_erp !== true) continue;
    out.push(shapeRow(tx, by.get(tx.tracking_key || trackingKey(tx.tracking_number)) || []));
  }
  return out;
}

const has = (value, needle) => String(value ?? "").toLowerCase().includes(needle);

export function filterRows(rows, f = {}) {
  const q = String(f.q || "").toLowerCase();
  const carrier = String(f.carrier || "").toLowerCase();
  const customer = String(f.customer || "").toLowerCase();
  return (rows || []).filter((r) => {
    if (r.pushed_date) {
      if (f.from && r.pushed_date < f.from) return false;
      if (f.to && r.pushed_date > f.to) return false;
    } else if (f.dated) return false;
    if (carrier && !has(r.carrier, carrier)) return false;
    if (customer && !has(r.customer_name, customer)) return false;
    if (q && ![r.shipment_id, r.tracking_number, r.billing_invoice_number, r.customer_name, r.carrier, ...(r.invoice_numbers || [])].some((v) => has(v, q))) return false;
    return true;
  });
}

// Newest push first; rows with no known push date last (newest shipped first).
export function sortRows(rows) {
  const desc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? 1 : -1);
  return [...(rows || [])].sort((x, y) =>
    desc(x.pushed_date, y.pushed_date) || desc(x.shipped_date, y.shipped_date) || desc(x.shipment_id, y.shipment_id));
}

export function totalsOf(rows) {
  const t = { count: 0, dated: 0, undated: 0, charge: 0, cost: 0, gross_profit: 0, approved_invoice_amount: 0 };
  for (const r of rows || []) {
    t.count++;
    if (r.pushed_date) t.dated++; else t.undated++;
    for (const k of ["charge", "cost", "gross_profit", "approved_invoice_amount"]) t[k] += r[k] || 0;
  }
  for (const k of ["charge", "cost", "gross_profit", "approved_invoice_amount"]) t[k] = cents(t[k]);
  return t;
}

// [{ date, count, charge }] oldest day first; rows with no known date are left out.
export function perDay(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r.pushed_date) continue;
    const d = by.get(r.pushed_date) || { date: r.pushed_date, count: 0, charge: 0 };
    d.count++;
    d.charge += r.charge || 0;
    by.set(r.pushed_date, d);
  }
  return [...by.values()].map((d) => ({ ...d, charge: cents(d.charge) })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The whole answer of GET /: every pushed row → the page asked for, with
// totals and per-day counts of everything the filter matches.
export function listPushed(rows, filters) {
  const matched = sortRows(filterRows(rows, filters));
  return {
    data: matched.slice(filters.offset, filters.offset + filters.limit),
    totals: totalsOf(matched),
    per_day: perDay(matched),
    limit: filters.limit,
    offset: filters.offset,
  };
}

// ── Excel ──

const EXPORT_COLUMNS = [
  ["Shipment ID", "shipment_id"],
  ["Customer Invoice Number", "billing_invoice_number"],
  ["Carrier Invoice Number", "invoice_number"],
  ["Tracking Number", "tracking_number"],
  ["Customer", "customer_name"],
  ["Carrier", "carrier"],
  ["Shipped Date", "shipped_date"],
  ["Pushed Date", "pushed_date"],
  ["Pushed Date Source", (r) => PUSH_SOURCE_LABELS[r.pushed_date_source] || ""],
  ["Charge", "charge"],
  ["Cost", "cost"],
  ["Gross Profit", "gross_profit"],
  ["Approved Invoice Amount", "approved_invoice_amount"],
  ["Approved Date", "approved_date"],
  ["Approved By", "approved_by"],
  ["Carrier Invoice Exported", (r) => (r.carrier_invoice_exported === null ? "" : r.carrier_invoice_exported ? "Yes" : "No")],
  ["Batch Number", "batch_number"],
  ["GL Code", "gl_code"],
  ["Internal Vendor ID", "internal_vendor_id"],
  ["PO Number", "po_number"],
  ["SO Number", "so_number"],
  ["BOL Number", "bol_number"],
  ["Payee", "payee"],
  ["Other Carrier Invoice Numbers", (r) => (r.invoice_numbers || []).filter((n) => n !== r.invoice_number).join(", ")],
  ["Last Read From FreightPOP", "last_seen_at"],
];

export const PUSH_SOURCE_LABELS = {
  freightpop_export_date: "FreightPOP export date",
  first_seen_exported: "First seen exported",
  unknown: "Not known",
};

export const EXPORT_HEADERS = EXPORT_COLUMNS.map(([title]) => title);

// rows → row objects keyed by EXPORT_HEADERS, for writeXlsx. Ids stay text
// (leading zeros, long numbers); amounts stay numbers.
export function exportRows(rows) {
  return (rows || []).map((r) => {
    const o = {};
    for (const [title, from] of EXPORT_COLUMNS) {
      const v = typeof from === "function" ? from(r) : r[from];
      if (v !== null && v !== undefined && v !== "") o[title] = v;
    }
    return o;
  });
}

// ── Matching a list pasted from NetSuite ──

// The body's `invoices` → { values } (trimmed, blanks and repeats dropped) or { error }.
// An entry may itself hold several, split by new lines, commas, semicolons or tabs.
export function parseInvoices(input) {
  if (!Array.isArray(input)) return { error: "body.invoices must be a list of invoice numbers or shipment ids" };
  const seen = new Set();
  const values = [];
  for (const entry of input) {
    if (entry === null || entry === undefined || typeof entry === "object") continue;
    for (const part of String(entry).split(/[\n\r,;\t]+/)) {
      const v = part.trim().replace(/^["']+|["']+$/g, "").trim();
      const k = v.toUpperCase();
      if (!v || seen.has(k)) continue;
      seen.add(k);
      values.push(v);
      if (values.length > MAX_MATCH) return { error: `At most ${MAX_MATCH} at a time` };
    }
  }
  if (!values.length) return { error: "Nothing to match: paste at least one invoice number or shipment id" };
  return { values };
}

// The forms one pasted value is looked up by: as typed (upper case, no spaces),
// without leading zeros / a trailing ".0", and without a leading "SHP" or "#"
// (FreightPOP's BOL number is "SHP" + the shipment id).
export function matchKeys(value) {
  const base = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!base) return [];
  const keys = [base];
  const add = (k) => { if (k && !keys.includes(k)) keys.push(k); };
  add(trackingKey(base));
  const bare = base.replace(/^(#|SHP[-#]?)/, "");
  add(bare);
  add(trackingKey(bare));
  return keys;
}

const MATCH_FIELDS = [
  ["shipment_id", (r) => [r.shipment_id]],
  ["billing_invoice_number", (r) => [r.billing_invoice_number]],
  ["invoice_number", (r) => r.invoice_numbers?.length ? r.invoice_numbers : [r.invoice_number]],
  ["bol_number", (r) => [r.bol_number]],
  ["tracking_number", (r) => [r.tracking_number]],
];

// rows → Map(field → Map(key → rows[])). A stored value is indexed as typed
// and without leading zeros, so "047976058" finds 47976058 and the reverse.
export function buildMatchIndex(rows) {
  const index = new Map(MATCH_FIELDS.map(([field]) => [field, new Map()]));
  for (const r of rows || []) {
    for (const [field, values] of MATCH_FIELDS) {
      const map = index.get(field);
      for (const v of values(r)) {
        const base = String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
        if (!base) continue;
        for (const k of new Set([base, trackingKey(base)])) {
          if (!k) continue;
          if (!map.has(k)) map.set(k, []);
          if (!map.get(k).includes(r)) map.get(k).push(r);
        }
      }
    }
  }
  return index;
}

// Each pasted value → { input, found, pushed, matched_on, row, others }.
// Fields are tried in order: shipment id, customer invoice number, carrier
// invoice number, BOL number, tracking number. When a value matches several
// shipments a pushed one is shown and `others` counts the rest.
// `rows` must hold every shipment (pushed or not) and approvals with no shipment.
export function matchInvoices(values, rows) {
  const index = buildMatchIndex(rows);
  const results = (values || []).map((input) => {
    const keys = matchKeys(input);
    for (const [field] of MATCH_FIELDS) {
      const map = index.get(field);
      const hits = [];
      for (const k of keys) for (const r of map.get(k) || []) if (!hits.includes(r)) hits.push(r);
      if (!hits.length) continue;
      const row = hits.find((r) => r.pushed) || hits[0];
      return { input, found: true, pushed: !!row.pushed, matched_on: field, row, others: hits.length - 1 };
    }
    return { input, found: false, pushed: false, matched_on: null, row: null, others: 0 };
  });
  const summary = { total: results.length, pushed: 0, not_pushed: 0, not_found: 0 };
  for (const r of results) summary[r.pushed ? "pushed" : r.found ? "not_pushed" : "not_found"]++;
  return { results, summary };
}

// Every row for matching: each shipment (pushed or not) with its approvals,
// then each approved invoice whose tracking number has no shipment row.
export function buildMatchRows(transactions, approvals) {
  const rows = buildRows(transactions, approvals, { pushedOnly: false });
  const withShipment = new Set((transactions || []).map((t) => t.tracking_key || trackingKey(t.tracking_number)).filter(Boolean));
  for (const [key, list] of approvalsByKey(approvals)) {
    if (!withShipment.has(key)) rows.push(shapeRow(null, list));
  }
  return rows;
}

// ── Paging ──

// Reads a whole table through a 1000-row window. fetchPage(from, to) →
// { data, error }; the query must have a stable order. Pages are read
// `concurrency` at a time, in order, and reading stops at the first short
// page. `key(row)` drops a row read twice when the table moved under us.
export async function loadAllPages(fetchPage, { pageSize = PAGE_SIZE, maxPages = 500, concurrency = 1, key } = {}) {
  const out = [];
  const seen = key ? new Set() : null;
  const wave = Math.max(1, concurrency);
  for (let page = 0; page < maxPages; page += wave) {
    const pages = await Promise.all(
      Array.from({ length: Math.min(wave, maxPages - page) }, (_, i) => fetchPage((page + i) * pageSize, (page + i) * pageSize + pageSize - 1)),
    );
    for (const { data, error } of pages) {
      if (error) throw new Error(error.message || String(error));
      for (const row of data || []) {
        if (seen) {
          const k = key(row);
          if (seen.has(k)) continue;
          seen.add(k);
        }
        out.push(row);
      }
      if (!data || data.length < pageSize) return out;
    }
  }
  throw new Error("Too many rows to read");
}
