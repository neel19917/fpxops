// ERP-pending invoice audit, fed by FreightPOP's Transactions "History Report"
// (not an uploaded carrier bill). Pure: no I/O, so it is fully unit tested.
//
// The hosted browser pulls the report and posts the rows that are NOT exported
// to ERP. We filter again here (defensively), sort by what the customer was
// charged, and map each report row to the fpx_invoice_audit_rows shape.

// Report headers arrive with slightly different spellings ("ShipmentID",
// "Shipment Id", "shipment_id"), so every lookup goes through this: lower-case,
// letters and digits only.
export const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

// Each field lists the header spellings we accept (compared after normKey).
const FIELDS = {
  exported: ["Exported to ERP", "Exported To ERP?", "ERP Exported"],
  shipmentId: ["ShipmentID", "Shipment #", "Shipment Number"],
  carrier: ["Carrier", "Carrier Name"],
  customerName: ["Customer Name", "Customer"],
  charge: ["Shipment Marked-Up Rate", "Marked-Up Rate", "Shipment Markup Rate"],
  cost: ["Shipment Rate without mark up", "Shipment Rate without markup", "Rate without mark up"],
  grossProfit: ["Shipment Gross Profit", "Gross Profit"],
  approved: ["Original Approved Invoice Amount"],
  additional: ["Additional Approved Invoice Amount"],
  notApproved: ["Not Approved Invoice Amount"],
  variance: ["Quote And Invoice Variance", "Quote & Invoice Variance"],
  shippedDate: ["Shipped Date", "Ship Date"],
  invoiceNumber: ["Billing Invoice Number", "Invoice Number"],
  tracking: ["Tracking", "Tracking Number"],
  service: ["Service"],
  accountManager: ["Account Manager"],
  shipmentStatus: ["Status", "Shipment Status"],
  transactionType: ["Transaction Type"],
  customerInvoiceSent: ["Customer Invoice Sent"],
  user: ["User"],
};
const FIELD_KEYS = Object.fromEntries(
  Object.entries(FIELDS).map(([field, names]) => [field, [...new Set(names.map(normKey))]]),
);

// One normalised view of a report row. First spelling wins when two headers
// normalise to the same key.
export function indexRow(row) {
  const idx = new Map();
  if (!row || typeof row !== "object") return idx;
  for (const [k, v] of Object.entries(row)) {
    const nk = normKey(k);
    if (nk && !idx.has(nk)) idx.set(nk, v);
  }
  return idx;
}

export function pick(idx, field) {
  for (const k of FIELD_KEYS[field]) {
    if (idx.has(k)) return idx.get(k);
  }
  return undefined;
}

// Trimmed text, or null when the cell is empty.
export function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Tolerant money parse: "$1,234.50" → 1234.5, "(12.00)" → -12, "" / null /
// anything that is not a number → null.
export function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// "Exported to ERP" arrives as "0"/"1", true/false or "Yes"/"No". Only a clear
// "no" (or a blank cell) counts as not exported; anything else is exported.
export function isExportedToErp(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (s === "" || s === "false" || s === "no" || s === "n") return false;
  if (/^[+-]?0+(\.0+)?$/.test(s)) return false;
  return true;
}

// An invoice amount of 0 means "nothing invoiced" in the report, same as blank.
const amount = (value) => {
  const n = num(value);
  return n === null || n === 0 ? null : n;
};

function auditOne(row) {
  const idx = indexRow(row);
  const charge = num(pick(idx, "charge"));
  const cost = num(pick(idx, "cost"));
  const approved = amount(pick(idx, "approved"));
  const additional = amount(pick(idx, "additional"));
  const notApproved = amount(pick(idx, "notApproved"));
  const grossProfit = num(pick(idx, "grossProfit"));
  const shipmentStatus = text(pick(idx, "shipmentStatus"));

  let bill = null;
  let billIsUnapproved = false;
  if (approved !== null || additional !== null) {
    bill = round2((approved || 0) + (additional || 0));
  } else if (notApproved !== null) {
    bill = round2(notApproved);
    billIsUnapproved = true;
  }

  const difference = bill !== null && cost !== null ? round2(bill - cost) : null;
  let status;
  if (bill === null) status = "no_invoice";
  else if (difference !== null && Math.abs(difference) <= 0.01) status = "match";
  else status = "discrepancy"; // includes "invoice but no cost to compare to"

  const flags = [];
  if (billIsUnapproved || notApproved !== null) flags.push("invoice not approved");
  const hasCost = cost !== null && cost !== 0;
  if (!hasCost) flags.push("no cost on file");
  if (charge === null || charge === 0) flags.push("no charge on file");
  const negativeMargin = hasCost && charge !== null
    ? cost - charge > 0.01
    : grossProfit !== null && grossProfit < -0.01;
  if (negativeMargin) flags.push("cost above charge");
  if (bill !== null && charge !== null && bill - charge > 0.01) flags.push("invoice above charge");
  if (shipmentStatus && /cancel/i.test(shipmentStatus)) flags.push("cancelled shipment");

  return {
    shipment_id: text(pick(idx, "shipmentId")),
    carrier: text(pick(idx, "carrier")),
    customer_name: text(pick(idx, "customerName")),
    bill_amount: bill,
    shipment_cost: cost,
    difference,
    status,
    raw: {
      rank: 0, // filled in after the sort
      charge,
      gross_profit: grossProfit,
      shipped_date: text(pick(idx, "shippedDate")),
      invoice_number: text(pick(idx, "invoiceNumber")),
      tracking: text(pick(idx, "tracking")),
      service: text(pick(idx, "service")),
      account_manager: text(pick(idx, "accountManager")),
      shipment_status: shipmentStatus,
      transaction_type: text(pick(idx, "transactionType")),
      not_approved_amount: num(pick(idx, "notApproved")),
      variance: num(pick(idx, "variance")),
      customer_invoice_sent: text(pick(idx, "customerInvoiceSent")),
      user: text(pick(idx, "user")),
      flags,
    },
  };
}

// rawRows: History Report rows (objects keyed by header).
// rankOffset: rows already stored for the run, so ranks continue across chunks.
// Returns { rows, summary }. Does not mutate the input.
export function auditHistoryRows(rawRows, { rankOffset = 0 } = {}) {
  const input = Array.isArray(rawRows) ? rawRows : [];
  const audited = [];
  for (const row of input) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (isExportedToErp(pick(indexRow(row), "exported"))) continue;
    audited.push(auditOne(row));
  }

  // Biggest charge first, rows without a charge last. Array.prototype.sort is
  // stable, so ties keep the report's own order.
  audited.sort((a, b) => {
    const ca = a.raw.charge;
    const cb = b.raw.charge;
    if (ca === null && cb === null) return 0;
    if (ca === null) return 1;
    if (cb === null) return -1;
    return cb - ca;
  });

  const offset = Number.isFinite(Number(rankOffset)) ? Math.max(0, Math.trunc(Number(rankOffset))) : 0;
  const summary = { total: audited.length, match: 0, discrepancy: 0, no_invoice: 0, total_charges: 0, total_cost: 0, flagged: 0 };
  audited.forEach((r, i) => {
    r.raw.rank = offset + i + 1;
    summary[r.status] += 1;
    summary.total_charges += r.raw.charge || 0;
    summary.total_cost += r.shipment_cost || 0;
    if (r.raw.flags.length) summary.flagged += 1;
  });
  summary.total_charges = round2(summary.total_charges);
  summary.total_cost = round2(summary.total_cost);
  return { rows: audited, summary };
}
