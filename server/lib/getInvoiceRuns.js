// Get Invoice runs as files people keep: each run's shipments with its scrape
// number (fpx_scrape_requests.scrape_number), for an Excel sheet someone can
// sort and paste into their own master spreadsheet, and a ZIP of every file
// the run saved, one folder per shipment. Pure functions; the route reads the
// tables and hands them in.
//
// What a run did for a shipment is read from the shipment's ERP-pull row
// (fpx_invoice_audit_rows.raw.get_invoice). That holds the latest run only,
// plus `history` (one entry per run, written since 2026-11-18). A shipment a
// later run clicked again shows status "rerun" in the earlier run, with the
// later scrape number, and the files it has now.


const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const utc = (v) => {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 16).replace("T", " ");
};

// The run's shipment ids in the order they were asked for, repeats dropped.
export function runShipmentIds(run) {
  const out = [];
  for (const v of run?.tracking_numbers || []) {
    const id = String(v ?? "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// What one run did for one shipment, from that shipment's ERP-pull rows.
// rows: [{ audit_id, shipment_id, customer_name, carrier, raw }]; byId: Map<request id, run>.
export function runEntry(run, rows, byId) {
  let latest = null; // the row whose latest run is the newest
  for (const row of rows || []) {
    const gi = asObject(asObject(row.raw).get_invoice);
    const hist = Array.isArray(gi.history) ? gi.history : [];
    const own = hist.find((h) => h?.request_id === run.id) || (gi.request_id === run.id ? gi : null);
    if (own) {
      const isLatest = gi.request_id === run.id;
      const shots = Array.isArray(own.shots) && own.shots.length ? own.shots : isLatest && Array.isArray(gi.shots) ? gi.shots : [];
      const later = isLatest ? null : byId.get(gi.request_id) || null;
      return {
        row, status: own.status || "requested", note: own.note ?? null, at: own.at ?? null,
        files: shots, later_run: later?.scrape_number ?? null,
      };
    }
    const at = Date.parse(gi.requested_at || "") || 0;
    if (!latest || at > latest.at) latest = { row, gi, at };
  }
  if (!latest) return { row: null, status: run.status === "pending" || run.status === "claimed" ? "requested" : "not_reached", note: null, at: null, files: [], later_run: null };
  const later = byId.get(latest.gi.request_id) || null;
  const newer = later && Date.parse(later.requested_at) > Date.parse(run.requested_at);
  return {
    row: latest.row,
    status: newer ? "rerun" : "not_reached",
    note: newer ? `Clicked again in scrape #${later.scrape_number}; this run's result was replaced` : null,
    at: null,
    files: Array.isArray(latest.gi.shots) ? latest.gi.shots : [],
    later_run: newer ? later.scrape_number : null,
  };
}

// One run → its rows (one per shipment asked for).
//   ctx: { byId: Map<request id, run>, rowsByShipment: Map<id, row[]>, tx: Map<id, tx>, docs: Map<id, doc[]> }
export function buildRunRows(run, ctx) {
  return runShipmentIds(run).map((shipment_id) => {
    const e = runEntry(run, ctx.rowsByShipment.get(shipment_id) || [], ctx.byId);
    const t = ctx.tx.get(shipment_id) || {};
    const docs = (ctx.docs.get(shipment_id) || []).filter((d) => !e.row || !d.audit_id || d.audit_id === e.row.audit_id);
    const inv = docs.find((d) => d.doc_type === "invoice" && (d.invoice_number || d.total != null))
      || docs.find((d) => d.invoice_number || d.total != null) || null;
    return {
      scrape_number: run.scrape_number ?? null,
      shipment_id,
      status: e.status,
      note: e.note,
      clicked_at: e.at,
      audit_id: e.row?.audit_id ?? null,
      customer_name: t.customer_name ?? e.row?.customer_name ?? null,
      carrier: t.carrier ?? e.row?.carrier ?? null,
      tracking_number: t.tracking_number ?? null,
      billing_invoice_number: t.billing_invoice_number ?? null,
      charge: num(t.charge),
      cost: num(t.cost),
      approved_invoice_amount: num(t.approved_invoice_amount),
      exported_to_erp: t.exported_to_erp ?? null,
      files: e.files,
      read_invoice_number: inv?.invoice_number ?? null,
      read_total: num(inv?.total),
      read_carrier: inv?.carrier ?? null,
      later_run: e.later_run,
    };
  });
}

// A run as the list shows it, with counts from its rows.
export function summarizeRun(run, rows) {
  const parsed = /buttons=([^;]*)/.exec(run.note || "");
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    id: run.id,
    scrape_number: run.scrape_number ?? null,
    status: run.status,
    requested_at: run.requested_at,
    completed_at: run.completed_at ?? null,
    requested_by: run.requested_by ?? null,
    audit_id: rows.find((r) => r.audit_id)?.audit_id ?? null,
    requested: rows.length,
    clicked: run.result_count ?? null,
    done: count("done"),
    failed: count("failed"),
    waiting: count("requested"),
    files: rows.reduce((n, r) => n + r.files.length, 0),
    note: /^audit=/.test(run.note || "") ? null : run.note ?? null,
    buttons: parsed ? parsed[1] : null,
  };
}

// Every column the Excel export can have: key (used in the URL), label (the
// default header), whether it is in the default sheet, and how it is read.
const fileNames = (r) => r.files.map((f) => String(f).replace(/^invoices\//, "")).join(", ") || null;
const diff = (r) => (r.read_total == null || r.charge == null ? null : Math.round((r.read_total - r.charge) * 100) / 100);
export const EXPORT_COLUMNS = [
  { key: "scrape_number", label: "Scrape #", on: true, get: (r) => r.scrape_number },
  { key: "scrape_date", label: "Scrape date (UTC)", on: true, get: (r, run) => utc(run.requested_at) },
  { key: "shipment_id", label: "Shipment ID", on: true, get: (r) => r.shipment_id },
  { key: "status", label: "Status", on: true, get: (r) => r.status },
  { key: "customer", label: "Customer", on: true, get: (r) => r.customer_name },
  { key: "carrier", label: "Carrier", on: true, get: (r) => r.carrier },
  { key: "tracking", label: "Tracking #", on: true, get: (r) => r.tracking_number },
  { key: "customer_invoice", label: "Customer invoice #", on: true, get: (r) => r.billing_invoice_number },
  { key: "read_invoice", label: "Invoice # (read from document)", on: true, get: (r) => r.read_invoice_number },
  { key: "charge", label: "Charge", on: true, get: (r) => r.charge },
  { key: "cost", label: "Cost", on: true, get: (r) => r.cost },
  { key: "approved", label: "Approved amount", on: true, get: (r) => r.approved_invoice_amount },
  { key: "read_total", label: "Invoice total (read from document)", on: true, get: (r) => r.read_total },
  { key: "total_matches", label: "Total matches charge", on: true, get: (r) => (diff(r) == null ? null : Math.abs(diff(r)) <= 0.01 ? "yes" : "no") },
  { key: "exported", label: "Exported to ERP", on: true, get: (r) => r.exported_to_erp },
  { key: "files", label: "Files", on: true, get: (r) => r.files.length },
  { key: "file_names", label: "File names", on: true, get: fileNames },
  { key: "clicked_at", label: "Clicked at (UTC)", on: true, get: (r) => utc(r.clicked_at) },
  { key: "requested_by", label: "Requested by", on: true, get: (r, run) => run.requested_by ?? null },
  { key: "note", label: "Note", on: true, get: (r) => r.note },
  { key: "gross_profit", label: "Gross profit", on: false, get: (r) => (r.charge == null || r.cost == null ? null : Math.round((r.charge - r.cost) * 100) / 100) },
  { key: "difference", label: "Read total minus charge", on: false, get: diff },
  { key: "read_carrier", label: "Carrier (read from document)", on: false, get: (r) => r.read_carrier },
  { key: "later_run", label: "Clicked again in scrape #", on: false, get: (r) => r.later_run },
  { key: "audit_id", label: "ERP pull id", on: false, get: (r) => r.audit_id },
];
export const EXPORT_HEADERS = EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.label);
const COLUMN = new Map(EXPORT_COLUMNS.map((c) => [c.key, c]));

// The sheet's options from a query string, anything unknown dropped:
//   columns=key,key,...   which columns, in this order (default: the default set)
//   label.<key>=Header    a header of your own for a column
//   sort=<key>&dir=asc|desc
//   status=done,failed    only rows with these statuses
//   latest=1              one row per shipment: its newest run only
export function parseExportOptions(q = {}) {
  const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const columns = [...new Set(list(q.columns).filter((k) => COLUMN.has(k)))];
  const labels = {};
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith("label.")) continue;
    const key = k.slice(6);
    const text = String(v ?? "").trim().slice(0, 80);
    if (COLUMN.has(key) && text) labels[key] = text;
  }
  const sort = COLUMN.has(String(q.sort || "")) ? String(q.sort) : null;
  return {
    columns: columns.length ? columns : EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.key),
    labels,
    sort,
    dir: q.dir === "desc" ? "desc" : "asc",
    statuses: list(q.status),
    latest: q.latest === "1" || q.latest === "true",
  };
}

// Runs → { headers, rows } for writeXlsx, shaped by the options.
export function buildExport(runs, rowsByRun, opts = parseExportOptions()) {
  let items = [];
  for (const run of runs) for (const r of rowsByRun.get(run.id) || []) items.push({ r, run });
  if (opts.statuses?.length) items = items.filter((x) => opts.statuses.includes(x.r.status));
  if (opts.latest) {
    const newest = new Map();
    for (const x of items) {
      const had = newest.get(x.r.shipment_id);
      if (!had || Date.parse(x.run.requested_at) > Date.parse(had.run.requested_at)) newest.set(x.r.shipment_id, x);
    }
    items = items.filter((x) => newest.get(x.r.shipment_id) === x);
  }
  if (opts.sort) {
    const get = COLUMN.get(opts.sort).get;
    const sign = opts.dir === "desc" ? -1 : 1;
    items = items.map((x, i) => ({ ...x, i, v: get(x.r, x.run) })).sort((a, b) => {
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1; // blanks last either way
      if (b.v == null) return -1;
      const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true });
      return c ? c * sign : a.i - b.i;
    });
  }
  const cols = opts.columns.map((k) => COLUMN.get(k));
  // Two columns given the same header would overwrite each other: number the repeats.
  const used = new Map();
  const headers = cols.map((c) => {
    const want = opts.labels?.[c.key] || c.label;
    const n = (used.get(want) || 0) + 1;
    used.set(want, n);
    return n === 1 ? want : `${want} (${n})`;
  });
  const rows = items.map(({ r, run }) => Object.fromEntries(cols.map((c, i) => [headers[i], c.get(r, run) ?? null])));
  return { headers, rows };
}

// Rows → Excel rows keyed by EXPORT_HEADERS (the default sheet).
export function exportRows(runs, rowsByRun) {
  return buildExport(runs, rowsByRun).rows;
}

// A name that is safe as one path segment inside a ZIP.
export const zipSafe = (s) => String(s ?? "").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "_").slice(0, 120) || "_";

// The files to put in a ZIP: [{ shipment_id, audit_id, file, name }], each
// stored file once (a shipment in several runs keeps one copy).
export function zipPlan(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r.audit_id) continue;
    for (const f of r.files) {
      const key = `${r.audit_id}/${f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ shipment_id: r.shipment_id, audit_id: r.audit_id, file: f, name: `${zipSafe(r.shipment_id)}/${zipSafe(String(f).replace(/^invoices\//, ""))}` });
    }
  }
  return out;
}

// Adds this run's result to raw.get_invoice.history (newest last, at most 20
// entries), so a later run of the same shipment does not lose it.
export const MAX_HISTORY = 20;
export function withHistory(getInvoice) {
  const gi = asObject(getInvoice);
  if (!gi.request_id) return gi;
  const entry = { request_id: gi.request_id, status: gi.status ?? null, at: gi.at ?? null, note: gi.note ?? null, ...(Array.isArray(gi.shots) && gi.shots.length ? { shots: gi.shots } : {}) };
  const hist = (Array.isArray(gi.history) ? gi.history : []).filter((h) => h?.request_id !== gi.request_id);
  hist.push(entry);
  return { ...gi, history: hist.slice(-MAX_HISTORY) };
}
