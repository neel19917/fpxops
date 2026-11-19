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

// ---------------------------------------------------------------------------
// Flags: what a person should look at for one shipment of a run.
// ---------------------------------------------------------------------------
//
// The file GET INVOICE saves ("<id>-invoice.pdf", doc_type "invoice") is the
// invoice FreightPOP/FPXpress sends the *customer*, so its total is compared
// with the charge (what the customer pays), and its number with FreightPOP's
// billing invoice number. The cost and the approved amount are the carrier's
// side: they are compared with the charge, never with the document's total.
// The other files (BOL, rate confirmation, quote screenshot) are not invoices,
// and a "-1.png" screenshot of an invoice row is typed "invoice" but holds
// no number or total, so it does not count as the invoice read.

const MONEY_TOLERANCE = 0.01;
export const LOW_CONFIDENCE = 0.75;
const money = (n) => `$${Math.abs(n).toFixed(2)}`;
const cents = (n) => Math.round(n * 100) / 100;
const short = (s, max = 90) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const normInvoiceNo = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=.)/, "");
const DOC_WORDS = { invoice: "invoice screenshot", bol: "BOL/labels", rate_confirmation: "rate confirmation", quote: "quote", shipment_details: "shipment page", accessorials: "accessorials", documents: "documents page", other: "other file" };

// The reader adds a note to nearly every document (weight printed per piece,
// dates printed with apostrophes, "issued by FreightPOP, not the carrier").
// Only notes about money, a cut-off or unreadable page, or a page that is not
// an invoice are worth a flag.
const WARNING_MATTERS = /(total|amount|add(s)? up|cut off|cut-off|unreadable|illegible|blank|truncat|does not match|doesn't match|disagree|not an invoice)/i;
const WARNING_NOISE = /(weight|breakdown|per piece|per-piece)/i;
export const meaningfulWarnings = (warnings) => (Array.isArray(warnings) ? warnings : [])
  .map((w) => String(w ?? "").trim()).filter((w) => w && WARNING_MATTERS.test(w) && !WARNING_NOISE.test(w));

// The invoice document read for a shipment: a read invoice with a total or a
// number, the one with both (and the PDF, and the surest) first.
export function invoiceDocOf(docs) {
  const score = (d) => (d.total != null ? 2 : 0) + (d.invoice_number ? 2 : 0) + (/\.pdf$/i.test(d.file || "") ? 1 : 0) + (num(d.confidence) ?? 0);
  return (docs || [])
    .filter((d) => (d.status ?? "done") === "done" && d.doc_type === "invoice" && (d.invoice_number || d.total != null))
    .sort((a, b) => score(b) - score(a))[0] || null;
}

// [{ code, level: "error" | "warn" | "info", text }] for one row of a run.
//   row:  the row buildRunRows makes (status, note, files, charge, cost, approved_invoice_amount, later_run)
//   docs: the shipment's fpx_invoice_documents rows (any status)
//   tx:   its fpx_erp_transactions row, or null
export function flagsFor(row, docs = [], tx = null) {
  const out = [];
  const add = (code, level, text) => out.push({ code, level, text });
  const st = row?.status;
  if (st === "rerun") {
    add("rerun", "info", row.later_run != null ? `Clicked again in scrape #${row.later_run}` : "Clicked again in a later run");
    return out;
  }
  if (st === "requested") return out;
  if (st === "not_reached") { add("not_reached", "warn", "Not reached: the run stopped first"); return out; }
  if (st === "not_started") { add("not_started", "warn", row.note ? `Not started: ${short(row.note)}` : "Not started"); return out; }
  const pushed = giPushed(row);
  if (st === "failed" && !pushed) { add("failed", "error", row.note ? `Get Invoice failed: ${short(row.note)}` : "Get Invoice failed"); return out; }
  if (st === "failed") add("unchecked", "warn", "Clicked, but the result was not checked");

  // Documents.
  const files = Array.isArray(row.files) ? row.files : [];
  const all = Array.isArray(docs) ? docs : [];
  const inv = invoiceDocOf(all);
  if (!files.length) {
    if (st === "done") add("no_files", "error", "Done, but no file was saved");
  } else if (!inv) {
    const read = all.filter((d) => (d.status ?? "done") === "done");
    const waiting = all.filter((d) => d.status === "pending" || d.status === "processing");
    if (waiting.length) add("not_read", "info", "Invoice not read yet");
    else if (all.some((d) => d.status === "failed")) add("read_failed", "warn", "The invoice file could not be read");
    else if (read.length) {
      const kinds = [...new Set(read.map((d) => DOC_WORDS[d.doc_type] || d.doc_type))];
      add("no_invoice", "warn", `No invoice in the files (only ${kinds.join(", ")})`);
    } else add("not_read", "warn", "No file has been read");
  }
  const charge = num(tx?.charge ?? row.charge);
  const cost = num(tx?.cost ?? row.cost);
  const approved = num(tx?.approved_invoice_amount ?? row.approved_invoice_amount);
  const billing = tx?.billing_invoice_number ?? row.billing_invoice_number ?? null;
  if (inv) {
    const total = num(inv.total);
    if (total == null) add("no_total", "warn", "Invoice total not read");
    else if (charge != null && Math.abs(total - charge) > MONEY_TOLERANCE) {
      const d = cents(total - charge);
      add("total_mismatch", "error", `Invoice total ${money(total)} is ${money(d)} ${d > 0 ? "above" : "below"} the charge ${money(charge)}`);
    }
    if (!inv.invoice_number) add("no_invoice_number", "info", "Invoice # not read");
    else if (billing && normInvoiceNo(inv.invoice_number) !== normInvoiceNo(billing)) {
      add("invoice_number_mismatch", "warn", `Invoice # read ${short(inv.invoice_number, 30)}, FreightPOP has ${short(billing, 30)}`);
    } else if (!billing && tx) add("no_billing_number", "info", "FreightPOP has no customer invoice #");
    const conf = num(inv.confidence);
    if (conf != null && conf < LOW_CONFIDENCE) add("low_confidence", "warn", `Low read confidence (${Math.round(conf * 100)}%)`);
    const ws = meaningfulWarnings(inv.warnings);
    if (ws.length) add("reader_warning", "warn", `Reader: ${short(ws[0])}${ws.length > 1 ? ` (+${ws.length - 1} more)` : ""}`);
  }

  // Money from FreightPOP.
  if (!tx && row.charge == null && row.cost == null) add("no_transaction", "warn", "Not in FreightPOP's transactions pull");
  else if (charge == null) add("no_charge", "warn", "No charge in FreightPOP");
  if (charge != null && cost != null && charge < cost - MONEY_TOLERANCE) {
    add("loss", "error", `Loss: charge ${money(charge)} is ${money(cents(cost - charge))} below cost ${money(cost)}`);
  }
  if (charge != null && approved != null && approved > charge + MONEY_TOLERANCE) {
    add("approved_over_charge", "error", `Carrier approved ${money(approved)}, above the charge ${money(charge)}`);
  } else if (cost != null && approved != null && approved > cost + MONEY_TOLERANCE) {
    add("approved_over_cost", "info", `Carrier approved ${money(cents(approved - cost))} over cost`);
  }
  return out;
}

const LEVEL_RANK = { error: 3, warn: 2, info: 1 };
// The worst level among the flags, or null when there are none.
export const flagLevel = (flags) => (flags || []).reduce((top, f) => ((LEVEL_RANK[f.level] || 0) > (LEVEL_RANK[top] || 0) ? f.level : top), null);
// A row needs a look: it has an error or a warning (info alone does not count).
export const isFlagged = (r) => (r?.flags || []).some((f) => f.level === "error" || f.level === "warn");

// One run → its rows (one per shipment asked for).
//   ctx: { byId: Map<request id, run>, rowsByShipment: Map<id, row[]>, tx: Map<id, tx>, docs: Map<id, doc[]> }
// docs may hold rows of any status (a row without one counts as read).
export function buildRunRows(run, ctx) {
  return runShipmentIds(run).map((shipment_id) => {
    const e = runEntry(run, ctx.rowsByShipment.get(shipment_id) || [], ctx.byId);
    const tRow = ctx.tx.get(shipment_id) || null;
    const t = tRow || {};
    const docs = (ctx.docs.get(shipment_id) || []).filter((d) => !e.row || !d.audit_id || d.audit_id === e.row.audit_id);
    const inv = invoiceDocOf(docs);
    const row = {
      scrape_number: run.scrape_number ?? null,
      shipment_id,
      status: e.status,
      note: e.note,
      pushed: giPushed(e),
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
      read_confidence: num(inv?.confidence),
      later_run: e.later_run,
    };
    const flags = flagsFor(row, docs, tRow);
    return { ...row, flags, flag_level: flagLevel(flags) };
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
    // Shipments with an error or a warning flag, and those with an error.
    flagged: rows.filter(isFlagged).length,
    flag_errors: rows.filter((r) => (r.flags || []).some((f) => f.level === "error")).length,
    note: /^audit=/.test(run.note || "") ? null : run.note ?? null,
    buttons: parsed ? parsed[1] : null,
  };
}

// Whether GET INVOICE was pushed for the shipment in this run: a finished
// click, or a click the run stopped before it could check ("the button was
// clicked"). Not reached, not started and waiting rows were never pushed.
export function giPushed(r) {
  if (!r) return false;
  if (r.status === "done") return true;
  return r.status === "failed" && /\bbutton was clicked\b/i.test(r.note || "");
}
const STATUS_LABEL = {
  done: "Done", failed: "Failed", requested: "Waiting", not_started: "Not started",
  not_reached: "Not reached", rerun: "Re-run later",
};
export const scrapeStatusLabel = (s) => STATUS_LABEL[s] || (s ? String(s) : null);

// Every column the Excel export can have: key (used in the URL), label (the
// default header), whether it is in the default sheet, and how it is read.
const fileNames = (r) => r.files.map((f) => String(f).replace(/^invoices\//, "")).join(", ") || null;
// "Flags": the errors and warnings, worst first; "All flags": every flag with its level.
const byLevel = (flags) => [...(flags || [])].sort((a, b) => (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0));
const flagSummary = (r) => byLevel(r.flags).filter((f) => f.level !== "info").map((f) => f.text).join("; ") || null;
const LEVEL_WORD = { error: "Error", warn: "Check", info: "Note" };
const flagText = (r) => byLevel(r.flags).map((f) => `${LEVEL_WORD[f.level] || f.level}: ${f.text}`).join("; ") || null;
const diff = (r) => (r.read_total == null || r.charge == null ? null : Math.round((r.read_total - r.charge) * 100) / 100);
export const EXPORT_COLUMNS = [
  { key: "scrape_number", label: "Scrape #", on: true, get: (r) => r.scrape_number },
  { key: "scrape_date", label: "Scrape date (UTC)", on: true, get: (r, run) => utc(run.requested_at) },
  { key: "shipment_id", label: "Shipment ID", on: true, get: (r) => r.shipment_id },
  { key: "status", label: "Status", on: true, get: (r) => r.status },
  { key: "pushed", label: "Get Invoice pushed", on: true, get: (r) => (giPushed(r) ? "Yes" : "No") },
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
  { key: "flags", label: "Flags", on: true, get: flagSummary },
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
  { key: "flag_text", label: "All flags (with level)", on: false, get: flagText },
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

// The master-file layout the AP team pastes into their own spreadsheet:
// FreightPOP's Transactions export without "Customer Id" (column A) and
// without "Appointment Set" through "Customer Audit" (columns BA to BE), with
// the scrape number added as the last column so the rest still line up.
// Found by header title, so a column FreightPOP moves is still the right one.
export const MASTER_DROP_SINGLE = ["Customer Id"];
export const MASTER_DROP_RANGE = ["Appointment Set", "Customer Audit"];
export function masterFileDrop(headers) {
  const norm = (h) => String(h ?? "").trim().toLowerCase();
  const at = (t) => headers.findIndex((h) => norm(h) === norm(t));
  const out = new Set();
  for (const t of MASTER_DROP_SINGLE) { const i = at(t); if (i >= 0) out.add(i); }
  const [from, to] = MASTER_DROP_RANGE.map(at);
  if (from >= 0 && to >= from) for (let i = from; i <= to; i++) out.add(i);
  return out;
}
