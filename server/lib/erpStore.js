// Durable copies of what the invoicing scrapes read from FreightPOP:
//   fpx_erp_transactions  one row per shipment of Transactions > History Report
//   fpx_audit_approvals   one row per approved carrier invoice of Audit >
//                         Recently Approved / History
// (see migrations/2026-11-14_erp_transactions_and_audit_approvals.sql).
// The two are matched in the view fpx_erp_invoicing by `tracking_key`, which is
// the same normalisation the approval matcher uses for ids.
//
// Everything down to the "Persistence" heading is pure (no I/O) and unit
// tested. The persistence functions take the supabase client and never throw.

import { num, isExportedToErp, normKey, indexRow, pick, text } from "./historyAudit.js";
import {
  normalizeShipmentId, findApprovalColumns, approvalColumnNames, classifyApprover,
  filterHistoryRows, approvalTime,
} from "./approvalMatch.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");

// The key a tracking number is matched by: trimmed, upper-cased, leading zeros
// and a trailing ".0" ignored ("047976058", 47976058 and " 47976058.0" are one
// key). null when blank.
export function trackingKey(value) {
  return normalizeShipmentId(value) || null;
}

const validDay = (y, m, d) => {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// A day as "YYYY-MM-DD", or null. Accepts "MM/DD/YYYY" (with or without a
// time), ISO text ("2026-03-31", "2026-03-31T00:00:00"), an Excel serial
// number and a Date. The day is taken as written: no time-zone shift.
export function dateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "number" || (typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
    const ms = approvalTime(typeof value === "number" ? value : value.trim());
    return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:$|[T\s,])/);
  if (us) {
    const y = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const [m, d] = [Number(us[1]), Number(us[2])];
    return validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  return null;
}

// ---------- Transactions (History Report) ----------

// Headers historyAudit.js has no field for. Compared after normKey.
const EXTRA_HEADERS = {
  customerId: ["Customer Id", "Customer Number", "Customer #"],
  invoiceApprovedDate: ["Original Invoice Approved Date", "Invoice Approved Date"],
};
function pickExtra(idx, field) {
  for (const name of EXTRA_HEADERS[field]) {
    const k = normKey(name);
    if (idx.has(k)) return idx.get(k);
  }
  return undefined;
}

// One fpx_erp_transactions row from one History Report row (an object keyed by
// FreightPOP's header titles). null when the row has no shipment id.
//   auditId       → last_pull_audit_id   (key left out when not given, so an
//   shipmentType  → shipment_type         upsert leaves the stored value alone)
//   seenAt        → last_seen_at (ISO text; now when not given)
// Never sets first_seen_at or exported_changed_at (see planTransactionUpsert).
// exported_to_erp is null when the report has no "Exported to ERP" column.
export function transactionRow(reportRow, { auditId, shipmentType, seenAt } = {}) {
  if (!reportRow || typeof reportRow !== "object" || Array.isArray(reportRow)) return null;
  const idx = indexRow(reportRow);
  const shipment_id = text(pick(idx, "shipmentId"));
  if (!shipment_id) return null;
  const tracking = text(pick(idx, "tracking"));
  const approved = num(pick(idx, "approved"));
  const additional = num(pick(idx, "additional"));
  const exported = pick(idx, "exported");
  const row = {
    shipment_id,
    tracking_number: tracking,
    tracking_key: trackingKey(tracking),
    customer_id: text(pickExtra(idx, "customerId")),
    customer_name: text(pick(idx, "customerName")),
    account_manager: text(pick(idx, "accountManager")),
    carrier: text(pick(idx, "carrier")),
    service: text(pick(idx, "service")),
    status: text(pick(idx, "shipmentStatus")),
    transaction_type: text(pick(idx, "transactionType")),
    shipped_date: dateOnly(pick(idx, "shippedDate")),
    billing_invoice_number: text(pick(idx, "invoiceNumber")),
    charge: num(pick(idx, "charge")),
    cost: num(pick(idx, "cost")),
    gross_profit: num(pick(idx, "grossProfit")),
    approved_invoice_amount: approved === null && additional === null ? null : round2((approved || 0) + (additional || 0)),
    invoice_approved_date: dateOnly(pickExtra(idx, "invoiceApprovedDate")),
    not_approved_invoice_amount: num(pick(idx, "notApproved")),
    quote_invoice_variance: num(pick(idx, "variance")),
    exported_to_erp: exported === undefined ? null : isExportedToErp(exported),
    customer_invoice_sent: text(pick(idx, "customerInvoiceSent")),
    data: reportRow,
    last_seen_at: seenAt || new Date().toISOString(),
  };
  if (text(auditId)) row.last_pull_audit_id = text(auditId);
  if (text(shipmentType)) row.shipment_type = text(shipmentType);
  return row;
}

// Several rows for one shipment collapse to one: the last one wins. Rows
// without a shipment_id are left out.
export function dedupeTransactions(rows) {
  const byId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.shipment_id) byId.set(r.shipment_id, r);
  }
  return [...byId.values()];
}

// Maps and dedupes a whole report. Returns { rows, received, skipped_no_id }.
export function transactionRows(reportRows, opts = {}) {
  const input = Array.isArray(reportRows) ? reportRows : [];
  const seenAt = opts.seenAt || new Date().toISOString();
  const mapped = [];
  let skipped_no_id = 0;
  for (const r of input) {
    const row = transactionRow(r, { ...opts, seenAt });
    if (row) mapped.push(row); else skipped_no_id += 1;
  }
  return { rows: dedupeTransactions(mapped), received: input.length, skipped_no_id };
}

// Splits mapped rows into the two upsert groups, given what is stored now
// (`existing`: [{ shipment_id, exported_to_erp }]):
//   plain    rows as mapped (no exported_changed_at key: new shipments and
//            shipments whose exported flag did not change)
//   flipped  rows + exported_changed_at: `now`, for stored shipments whose
//            flag changed (true ↔ not true). A row whose flag is null (the
//            report had no such column) never counts as changed.
// Neither group carries first_seen_at, and each group has one column set.
export function planTransactionUpsert(rows, existing, now = new Date().toISOString()) {
  const had = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && e.shipment_id !== null && e.shipment_id !== undefined) had.set(String(e.shipment_id), e);
  }
  const plain = [];
  const flipped = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const { first_seen_at: _f, exported_changed_at: _c, ...row } = r;
    const before = had.get(String(row.shipment_id));
    const changed = !!before && typeof row.exported_to_erp === "boolean"
      && (before.exported_to_erp === true) !== row.exported_to_erp;
    if (changed) flipped.push({ ...row, exported_changed_at: now });
    else plain.push(row);
  }
  return { plain, flipped };
}

// ---------- Approvals (Audit > Recently Approved / History) ----------

// Typed columns of fpx_audit_approvals that a row from an export fills.
export const APPROVAL_COLUMNS = [
  "approval_key", "tracking_number", "tracking_key", "invoice_number", "carrier", "carrier_scac",
  "approved_date", "approved_at_text", "approved_by", "approved_by_kind", "approved_by_raw", "uploaded_by",
  "invoice_amount", "quote_amount", "variance", "invoice_date", "shipment_date", "exported_date", "notes", "source",
];
// The ones a History row may fill in on a row that came from Recently Approved.
const FILLABLE = APPROVAL_COLUMNS.filter((c) => !["approval_key", "tracking_key", "source"].includes(c));

const isBlank = (v) => v === null || v === undefined || v === "";
const sourceOf = (v) => (v === "history" ? "history" : "recently_approved");

// The export row as an object keyed by header (a row sent as a plain list is
// read by position).
function asRecord(row, headers) {
  if (Array.isArray(row)) return Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null]).filter(([h]) => h !== ""));
  return row && typeof row === "object" ? row : null;
}

// When FreightPOP printed the approval: its own text, or a day for an Excel
// serial number.
function printed(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") return dateOnly(value);
  return text(value);
}

// One fpx_audit_approvals row from one export row. `columns` is the export's
// header list (taken from the row's keys when left out). null when the row has
// no tracking number. Options: source ("recently_approved" default, or
// "history"), seenAt (ISO text; now when not given), cols (the result of
// findApprovalColumns, to save working it out per row).
// A History row must already have passed filterHistoryRows: use approvalRows.
export function approvalRow(exportRow, columns, { source: sourceIn, seenAt, cols: colsIn } = {}) {
  const source = sourceOf(sourceIn);
  const headers = approvalColumnNames(columns, [exportRow]);
  const record = asRecord(exportRow, headers);
  if (!record) return null;
  const cols = colsIn || findApprovalColumns(headers, { source });
  const idx = indexRow(record);
  const get = (name) => (name ? record[name] : undefined);
  const byTitle = (title) => idx.get(normKey(title));

  const tracking = text(get(cols.tracking));
  const tracking_key = trackingKey(tracking);
  if (!tracking_key) return null;
  const invoice = text(get(cols.invoice));
  const who = classifyApprover(get(cols.approved_by));
  const approvedAt = get(cols.approved_at);
  return {
    approval_key: `${tracking_key}|${(invoice || "").toUpperCase()}`,
    tracking_number: tracking,
    tracking_key,
    invoice_number: invoice,
    carrier: text(byTitle("Carrier")),
    carrier_scac: text(byTitle("Carrier SCAC")),
    approved_date: dateOnly(approvedAt),
    approved_at_text: printed(approvedAt),
    approved_by: who.name,
    approved_by_kind: who.kind,
    approved_by_raw: who.raw,
    uploaded_by: text(get(cols.uploaded_by)),
    invoice_amount: num(get(cols.amount)),
    quote_amount: num(byTitle("Quote Amount")),
    variance: num(get(cols.variance)),
    invoice_date: dateOnly(byTitle("Invoice Date")),
    shipment_date: dateOnly(byTitle("Shipment Date")),
    exported_date: dateOnly(byTitle("Exported Date")),
    notes: text(get(cols.notes)),
    source,
    data: record,
    last_seen_at: seenAt || new Date().toISOString(),
  };
}

const approvedMs = (r) => approvalTime(r.approved_at_text) ?? approvalTime(r.approved_date);

// Several rows with one approval_key collapse to one: the latest approved date
// wins (a row with a date beats one without). On a tie Recently Approved beats
// History, and within one source the later row wins.
export function dedupeApprovals(rows) {
  const byKey = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.approval_key) continue;
    const had = byKey.get(r.approval_key);
    if (!had) { byKey.set(r.approval_key, r); continue; }
    const a = approvedMs(had);
    const b = approvedMs(r);
    let wins;
    if (a !== b) wins = b !== null && (a === null || b > a);
    else wins = !(sourceOf(had.source) === "recently_approved" && sourceOf(r.source) === "history");
    if (wins) byKey.set(r.approval_key, r);
  }
  return [...byKey.values()];
}

// Maps and dedupes the rows of one export. For source "history" the rows go
// through filterHistoryRows first, so invoices that were not approved are
// never stored. Returns { rows, received, dropped, skipped_no_tracking }.
export function approvalRows(exportRows, columns, { source: sourceIn, seenAt: seenIn } = {}) {
  const source = sourceOf(sourceIn);
  const given = Array.isArray(exportRows) ? exportRows : [];
  const headers = approvalColumnNames(columns, given);
  const cols = findApprovalColumns(headers, { source });
  const seenAt = seenIn || new Date().toISOString();
  let kept = given;
  let dropped = 0;
  if (source === "history") {
    const filtered = filterHistoryRows(given, headers, cols);
    kept = filtered.rows;
    dropped = filtered.dropped.not_approved + filtered.dropped.no_approval_info;
  }
  const mapped = [];
  let skipped_no_tracking = 0;
  for (const r of kept) {
    const row = approvalRow(r, headers, { source, seenAt, cols });
    if (row) mapped.push(row); else skipped_no_tracking += 1;
  }
  return { rows: dedupeApprovals(mapped), received: given.length, dropped, skipped_no_tracking };
}

// Splits mapped rows into the two upsert groups, given what is stored now
// (`existing`: rows with approval_key + the APPROVAL_COLUMNS):
//   write  the whole row (typed columns, data, last_seen_at): new approvals,
//          and any row replacing a stored one. A Recently Approved row that
//          replaces a History row keeps History's value where its own is blank.
//   fill   a History row for an approval stored from Recently Approved: the
//          stored typed values, with only the blank ones taken from the new
//          row; source stays recently_approved, `data` is not sent (so it is
//          not changed), last_seen_at is the new row's.
// Neither group carries first_seen_at, and each group has one column set.
export function planApprovalUpsert(rows, existing) {
  const had = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && e.approval_key) had.set(e.approval_key, e);
  }
  const write = [];
  const fill = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const { first_seen_at: _f, ...row } = r;
    const before = had.get(row.approval_key);
    const isHistory = sourceOf(row.source) === "history";
    if (before && isHistory && sourceOf(before.source) === "recently_approved") {
      const merged = {};
      for (const c of APPROVAL_COLUMNS) merged[c] = before[c] ?? null;
      for (const c of FILLABLE) if (isBlank(merged[c]) && !isBlank(row[c])) merged[c] = row[c];
      // The approver is one thing: name, kind and raw text go together.
      if (isBlank(before.approved_by) && isBlank(before.approved_by_raw) && before.approved_by_kind !== "edi") {
        merged.approved_by = row.approved_by ?? null;
        merged.approved_by_kind = row.approved_by_kind ?? "unknown";
        merged.approved_by_raw = row.approved_by_raw ?? null;
      } else {
        merged.approved_by = before.approved_by ?? null;
        merged.approved_by_kind = before.approved_by_kind ?? "unknown";
        merged.approved_by_raw = before.approved_by_raw ?? null;
      }
      merged.approval_key = row.approval_key;
      merged.source = "recently_approved";
      merged.last_seen_at = row.last_seen_at;
      fill.push(merged);
      continue;
    }
    if (before && !isHistory && sourceOf(before.source) === "history") {
      const merged = { ...row };
      for (const c of FILLABLE) if (isBlank(merged[c]) && !isBlank(before[c])) merged[c] = before[c];
      if (isBlank(row.approved_by) && isBlank(row.approved_by_raw) && row.approved_by_kind !== "edi") {
        merged.approved_by = before.approved_by ?? null;
        merged.approved_by_kind = before.approved_by_kind ?? "unknown";
        merged.approved_by_raw = before.approved_by_raw ?? null;
      } else {
        merged.approved_by = row.approved_by ?? null;
        merged.approved_by_kind = row.approved_by_kind ?? "unknown";
        merged.approved_by_raw = row.approved_by_raw ?? null;
      }
      write.push(merged);
      continue;
    }
    write.push(row);
  }
  return { write, fill };
}

// ---------- Persistence ----------

const CHUNK = 500;
// Keys per read of what is stored (they travel in the URL).
const READ_KEYS = 100;

const message = (e) => String(e?.message || e || "unknown error");

// Rows of `table` whose `key` is one of `keys`. Returns { rows } or { error }.
async function readExisting(supabase, table, key, columns, keys) {
  const rows = [];
  for (let i = 0; i < keys.length; i += READ_KEYS) {
    const { data, error } = await supabase.from(table).select(columns).in(key, keys.slice(i, i + READ_KEYS));
    if (error) return { error: message(error) };
    rows.push(...(data || []));
  }
  return { rows };
}

// Reads what is stored for each chunk, plans its groups and upserts them.
// Returns { upserted, failed, error? } (error: the first failure's message).
async function upsertPlanned(supabase, { table, key, readColumns, rows, plan }) {
  const out = { upserted: 0, failed: 0 };
  const list = Array.isArray(rows) ? rows.filter((r) => r && r[key]) : [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    let settled = 0; // rows of this chunk already counted
    try {
      const existing = await readExisting(supabase, table, key, readColumns, chunk.map((r) => r[key]));
      if (existing.error) throw new Error(existing.error);
      for (const group of plan(chunk, existing.rows)) {
        if (!group.length) continue;
        const { error } = await supabase.from(table).upsert(group, { onConflict: key });
        if (error) { out.failed += group.length; out.error ??= message(error); } else out.upserted += group.length;
        settled += group.length;
      }
    } catch (e) {
      out.failed += chunk.length - settled;
      out.error ??= message(e);
    }
  }
  if (out.failed) console.warn(`[FPX] ${table}: ${out.failed} row(s) not stored: ${out.error}`);
  return out;
}

// Upserts fpx_erp_transactions rows (from transactionRows). first_seen_at is
// never sent, so the database sets it on insert and an update leaves it;
// exported_changed_at is sent only for shipments whose flag changed.
export function upsertTransactions(supabase, rows) {
  const now = new Date().toISOString();
  return upsertPlanned(supabase, {
    table: "fpx_erp_transactions",
    key: "shipment_id",
    readColumns: "shipment_id, exported_to_erp",
    rows: dedupeTransactions(rows),
    plan: (chunk, existing) => {
      const { plain, flipped } = planTransactionUpsert(chunk, existing, now);
      return [plain, flipped];
    },
  });
}

// Upserts fpx_audit_approvals rows (from approvalRows). first_seen_at is never
// sent. A stored Recently Approved row is not replaced by a History row; only
// its blank columns are filled in.
export function upsertApprovals(supabase, rows) {
  return upsertPlanned(supabase, {
    table: "fpx_audit_approvals",
    key: "approval_key",
    readColumns: APPROVAL_COLUMNS.join(", "),
    rows: dedupeApprovals(rows),
    plan: (chunk, existing) => {
      const { write, fill } = planApprovalUpsert(chunk, existing);
      return [write, fill];
    },
  });
}
