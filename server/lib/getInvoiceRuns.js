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

export const EXPORT_HEADERS = [
  "Scrape #", "Scrape date (UTC)", "Shipment ID", "Status", "Customer", "Carrier", "Tracking #",
  "Customer invoice #", "Invoice # (read from document)", "Charge", "Cost", "Approved amount",
  "Invoice total (read from document)", "Total matches charge", "Exported to ERP", "Files", "File names",
  "Clicked at (UTC)", "Requested by", "Note",
];

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

// Rows → Excel rows keyed by EXPORT_HEADERS.
export function exportRows(runs, rowsByRun) {
  const out = [];
  for (const run of runs) {
    for (const r of rowsByRun.get(run.id) || []) {
      out.push({
        "Scrape #": r.scrape_number,
        "Scrape date (UTC)": utc(run.requested_at),
        "Shipment ID": r.shipment_id,
        "Status": r.status,
        "Customer": r.customer_name,
        "Carrier": r.carrier,
        "Tracking #": r.tracking_number,
        "Customer invoice #": r.billing_invoice_number,
        "Invoice # (read from document)": r.read_invoice_number,
        "Charge": r.charge,
        "Cost": r.cost,
        "Approved amount": r.approved_invoice_amount,
        "Invoice total (read from document)": r.read_total,
        "Total matches charge": r.read_total == null || r.charge == null ? null : Math.abs(r.read_total - r.charge) <= 0.01 ? "yes" : "no",
        "Exported to ERP": r.exported_to_erp,
        "Files": r.files.length,
        "File names": r.files.map((f) => String(f).replace(/^invoices\//, "")).join(", ") || null,
        "Clicked at (UTC)": utc(r.clicked_at),
        "Requested by": run.requested_by ?? null,
        "Note": r.note,
      });
    }
  }
  return out;
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
