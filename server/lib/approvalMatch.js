// "Approval check": the hosted browser takes the Excel export of FreightPOP's
// Audit page → "Recently Approved" and posts its rows. This file matches those
// rows to the shipments of an ERP pull and says, per shipment, whether its
// invoice was approved and by whom: EDI (automatic) or a person.
// Pure: no I/O, so it is fully unit tested. Inputs are never changed.
//
// Row state, in fpx_invoice_audit_rows.raw.approval:
//   { status: "approved", approved_by, approved_by_kind, approved_by_raw,
//     approved_at, amount, invoice, matches, checked_at, checked_by }
//   { status: "not_found", checked_at, checked_by }

import { num } from "./historyAudit.js";

export const APPROVAL_CHECK_SCOPE = "approval_check";

// Headers arrive with different spellings ("ShipmentID", "Shipment Id",
// "Shipment #"), so they are compared lower-cased, letters and digits only.
const normKey = (k) => String(k ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Accepted header spellings, in order of preference.
const CANDIDATES = {
  shipment: ["ShipmentID", "Shipment Id", "Shipment #", "Shipment Number", "Shipment No", "Shipment"],
  approved_by: ["Approved By", "ApprovedBy", "Approver", "Approved User", "Audited By", "Reviewed By", "User", "Modified By", "Updated By"],
  approved_at: ["Approved Date", "Approval Date", "Approved On", "Invoice Approved Date", "Date Approved", "Modified Date"],
  amount: ["Approved Amount", "Approved Invoice Amount", "Invoice Amount", "Amount", "Total"],
  invoice: ["Invoice Number", "Invoice #", "Carrier Invoice", "Invoice No"],
  // FreightPOP's Recently Approved export has no shipment id; it is matched
  // to a shipment by its tracking (PRO) number.
  tracking: ["Tracking Number", "Tracking", "Tracking #", "Tracking No", "PRO Number", "PRO"],
};

// Looser tests, tried in order when no listed spelling is present. Each takes
// a normalised header.
const CONTAINS = {
  shipment: [
    (k) => k.includes("shipmentid") || k.includes("shipmentnumber"),
    (k) => /shipment(num|no)$/.test(k),
  ],
  approved_by: [
    (k) => k.includes("approv") && k.includes("by"),
    (k) => k.includes("approver"),
    (k) => k.includes("approv") && k.includes("user"),
  ],
  approved_at: [
    (k) => k.includes("approv") && (k.includes("date") || k.includes("time")),
    (k) => /approv(ed|al)(on|at)$/.test(k),
  ],
  amount: [
    (k) => k.includes("approv") && k.includes("amount"),
    (k) => k.includes("invoice") && k.includes("amount"),
  ],
  invoice: [
    (k) => k.includes("invoicenumber") || /invoice(num|no)$/.test(k),
  ],
  tracking: [
    (k) => k.includes("trackingnumber") || /tracking(num|no)$/.test(k),
  ],
};

// Which column of the export holds what. Returns the header exactly as it was
// given, or null. A listed spelling wins over a contains-match, and a column
// is never used for two fields. Only `shipment` is needed to run a match.
export function findApprovalColumns(columns) {
  const names = (Array.isArray(columns) ? columns : [])
    .filter((c) => c !== null && c !== undefined && String(c).trim() !== "")
    .map((c) => String(c));
  const keyed = names.map((name) => ({ name, key: normKey(name) }));
  const out = { shipment: null, approved_by: null, approved_at: null, amount: null, invoice: null, tracking: null };
  const used = new Set();
  const take = (field, col) => { out[field] = col.name; used.add(col.name); };
  for (const field of Object.keys(out)) {
    for (const candidate of CANDIDATES[field]) {
      const want = normKey(candidate);
      const hit = keyed.find((c) => c.key === want && !used.has(c.name));
      if (hit) { take(field, hit); break; }
    }
  }
  for (const field of Object.keys(out)) {
    if (out[field]) continue;
    for (const test of CONTAINS[field]) {
      const hit = keyed.find((c) => c.key && !used.has(c.name) && test(c.key));
      if (hit) { take(field, hit); break; }
    }
  }
  return out;
}

// Header names of an export: the list sent with it, or the keys of its rows.
export function approvalColumnNames(columns, rows) {
  if (Array.isArray(columns) && columns.length) return columns.map((c) => String(c ?? ""));
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const k of Object.keys(row)) seen.add(k);
    }
  }
  return [...seen];
}

function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

// Shipment ids are compared as trimmed text, ignoring leading zeros and a
// trailing ".0" (Excel turns 13000001 into 13000001.0). "" when blank.
export function normalizeShipmentId(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  let s = String(value).trim();
  if (!s) return "";
  s = s.replace(/\.0+$/, "");
  s = s.replace(/^0+(?=.)/, "");
  return s.toUpperCase();
}

// Words that mark an automatic approval. Compared against whole words, so
// "Meredith" (contains "edi") and "Paula" are still people.
const EDI_WORDS = new Set([
  "edi", "system", "auto", "automatic", "automated", "automation", "autoapprove", "autoapproved",
  "integration", "integrations", "api",
  // obvious service accounts
  "service", "svc", "bot", "robot", "noreply", "donotreply", "scheduler", "daemon", "batch", "job", "import", "importer",
]);

function words(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // ediUser → edi User
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // EDIUser → EDI User
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const titleWord = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);

// "shaun.smith@x.com" → "Shaun Smith"; "SHAUN" / "shaun" → "Shaun"; a name
// that already has mixed case ("Shaun McDonald") is only trimmed.
function tidyName(s) {
  const at = s.indexOf("@");
  if (at > 0 && !/\s/.test(s)) {
    const parts = s.slice(0, at).split(/[._\-+]+/).map((p) => p.replace(/\d+$/, "")).filter(Boolean);
    if (parts.length) return parts.map(titleWord).join(" ");
  }
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean === clean.toLowerCase() || clean === clean.toUpperCase()) {
    return clean.split(" ").map((w) => w.split("-").map(titleWord).join("-")).join(" ");
  }
  return clean;
}

// Who approved: { kind: "edi" | "person" | "unknown", name, raw }.
// `people` is an optional list of known names; a value that is one of them
// (full name, or a first name only one of them has) is shown as listed.
export function classifyApprover(value, { people = [] } = {}) {
  const raw = text(value);
  if (!raw) return { kind: "unknown", name: null, raw: null };
  // For an email only the part before @ says who it is (not the domain).
  const isEmail = raw.includes("@") && !/\s/.test(raw);
  const subject = isEmail ? raw.slice(0, raw.indexOf("@")) : raw;
  const ws = words(subject);
  if (ws.some((w) => EDI_WORDS.has(w)) || ws.join("") === "noreply" || ws.join("") === "donotreply") {
    return { kind: "edi", name: "EDI", raw };
  }
  let name = tidyName(raw);
  const known = (Array.isArray(people) ? people : []).map((p) => text(p)).filter(Boolean);
  const lower = name.toLowerCase();
  const full = known.find((p) => p.toLowerCase() === lower);
  if (full) name = full;
  else {
    const first = known.filter((p) => p.toLowerCase().split(/\s+/)[0] === lower);
    if (first.length === 1) name = first[0];
  }
  return { kind: "person", name, raw };
}

const pad = (n) => String(n).padStart(2, "0");

// When an approval happened, as milliseconds for comparing. Accepts a Date, an
// Excel serial number, ISO text or US "m/d/yyyy h:mm AM" text. null otherwise.
export function approvalTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Excel serial day (1970-01-01 is 25569). Anything else is not a date.
    return value > 20000 && value < 80000 ? Math.round((value - 25569) * 86400000) : null;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return approvalTime(Number(s));
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    let hour = us[4] ? Number(us[4]) : 0;
    if (us[7]) {
      const pm = us[7].toLowerCase() === "pm";
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    return Date.UTC(year, Number(us[1]) - 1, Number(us[2]), hour, us[5] ? Number(us[5]) : 0, us[6] ? Number(us[6]) : 0);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// The date as it is stored and shown. Text is kept as FreightPOP wrote it (its
// time zone is not known); an Excel serial becomes "YYYY-MM-DD" or
// "YYYY-MM-DD HH:mm".
function approvalDateText(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    const ms = approvalTime(value);
    if (ms === null) return null;
    const d = new Date(ms);
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return Number.isInteger(value) ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return text(value);
}

// One cell of an export row. Rows are normally objects keyed by header; a row
// sent as a plain list is read by the header's position.
function cell(row, name, headers) {
  if (!name || row === null || row === undefined) return undefined;
  if (Array.isArray(row)) {
    const i = headers.indexOf(name);
    return i >= 0 ? row[i] : undefined;
  }
  if (typeof row !== "object") return undefined;
  return row[name];
}

const emptySummary = (approvedRows) => ({
  approved_rows: approvedRows, matched: 0, not_found: 0, by_edi: 0, by_unknown: 0, by_person: {},
});

// { name: count } with the biggest count first (then by name), so it reads in
// that order when serialised.
function sortPeople(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

// Matches the "Recently Approved" rows to an audit's rows.
//   auditRows:    [{ shipment_id, ... }]  (fpx_invoice_audit_rows)
//   approvedRows: the export's rows, objects keyed by header
//   columns:      the export's headers (taken from the rows when left out)
// Returns {
//   columns_used,            // findApprovalColumns(columns)
//   results,                 // one per audit row, same order:
//                            //   { shipment_id, status: "approved", approved_by, approved_by_kind,
//                            //     approved_by_raw, approved_at, amount, invoice, matches }
//                            //   { shipment_id, status: "not_found", matches: 0 }
//   summary }                // { approved_rows, matched, not_found, by_edi, by_unknown, by_person }
// When several export rows are for one shipment, the one approved last wins
// (the last row when no date can be read) and `matches` says how many there were.
// With no shipment column nothing can match: every result is not_found and
// columns_used.shipment is null.
export function matchApprovals(auditRows, approvedRows, columns, { people = [] } = {}) {
  const audit = Array.isArray(auditRows) ? auditRows : [];
  const approved = Array.isArray(approvedRows) ? approvedRows : [];
  const headers = approvalColumnNames(columns, approved);
  const cols = findApprovalColumns(headers);

  // shipment id (or "t:" + tracking number) → { row, time, count }
  const best = new Map();
  const keyCol = cols.shipment || cols.tracking;
  const prefix = cols.shipment ? "" : "t:";
  if (keyCol) {
    for (const row of approved) {
      const raw = normalizeShipmentId(cell(row, keyCol, headers));
      const id = raw ? prefix + raw : "";
      if (!id) continue;
      const time = approvalTime(cell(row, cols.approved_at, headers));
      const had = best.get(id);
      if (!had) { best.set(id, { row, time, count: 1 }); continue; }
      had.count += 1;
      // Later date wins; on a tie, or when neither has a date, the later row.
      // A row with a date is never replaced by one without.
      const newer = time !== null ? (had.time === null || time >= had.time) : had.time === null;
      if (newer) { had.row = row; had.time = time; }
    }
  }

  const summary = emptySummary(approved.length);
  const people_counts = {};
  const results = audit.map((a) => {
    const shipment_id = a?.shipment_id ?? null;
    // By shipment id when the export has one, else by tracking number.
    const trackingKey = normalizeShipmentId(a?.raw?.tracking ?? a?.tracking_number ?? null);
    const hit = cols.shipment
      ? best.get(normalizeShipmentId(shipment_id))
      : (trackingKey ? best.get("t:" + trackingKey) : undefined);
    if (!hit) {
      summary.not_found += 1;
      return { shipment_id, status: "not_found", matches: 0 };
    }
    const who = classifyApprover(cell(hit.row, cols.approved_by, headers), { people });
    summary.matched += 1;
    if (who.kind === "edi") summary.by_edi += 1;
    else if (who.kind === "person") people_counts[who.name] = (people_counts[who.name] || 0) + 1;
    else summary.by_unknown += 1;
    return {
      shipment_id,
      status: "approved",
      approved_by: who.name,
      approved_by_kind: who.kind,
      approved_by_raw: who.raw,
      approved_at: approvalDateText(cell(hit.row, cols.approved_at, headers)),
      amount: num(cell(hit.row, cols.amount, headers)),
      invoice: text(cell(hit.row, cols.invoice, headers)),
      matches: hit.count,
    };
  });
  summary.by_person = sortPeople(people_counts);
  return { columns_used: cols, results, summary };
}

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// Folds one match result into a row's raw, touching only raw.approval. Returns
// the new raw, or null to leave the row as it is.
// An export can arrive in several parts, and "Recently Approved" only reaches
// back so far, so an approval once seen is never taken away:
//   - approved now: stored, unless the row already holds an approval with a
//     later date (then only checked_at / checked_by are refreshed);
//   - not found now: stored as not_found only on the last part (`final`), and
//     only when the row holds no approval.
export function mergeApproval(raw, result, { checked_at, checked_by = null, final = true } = {}) {
  const base = asObject(raw);
  const had = asObject(base.approval);
  if (result?.status === "approved") {
    const { shipment_id: _drop, ...fields } = result;
    if (had.status === "approved") {
      const before = approvalTime(had.approved_at);
      const now = approvalTime(fields.approved_at);
      if (before !== null && (now === null || now < before)) {
        return { ...base, approval: { ...had, checked_at, checked_by } };
      }
    }
    return { ...base, approval: { ...fields, checked_at, checked_by } };
  }
  if (!final || had.status === "approved") return null;
  return { ...base, approval: { status: "not_found", checked_at, checked_by } };
}

// Run-level numbers read back from the rows' raw.approval:
//   { checked_at, matched, not_found, by_edi, by_unknown, by_person }
// checked_at is the latest check of any row. null when no row was ever checked.
export function summarizeApprovals(rows) {
  let checked_at = null;
  let seen = false;
  const out = { matched: 0, not_found: 0, by_edi: 0, by_unknown: 0 };
  const people_counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const a = row?.raw?.approval;
    if (!a || typeof a !== "object" || Array.isArray(a) || !a.status) continue;
    seen = true;
    if (typeof a.checked_at === "string" && (checked_at === null || a.checked_at > checked_at)) checked_at = a.checked_at;
    if (a.status !== "approved") { out.not_found += 1; continue; }
    out.matched += 1;
    if (a.approved_by_kind === "edi") out.by_edi += 1;
    else if (a.approved_by_kind === "person" && a.approved_by) {
      people_counts[a.approved_by] = (people_counts[a.approved_by] || 0) + 1;
    } else out.by_unknown += 1;
  }
  if (!seen) return null;
  return { checked_at, ...out, by_person: sortPeople(people_counts) };
}
