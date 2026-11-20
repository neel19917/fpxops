// Get Invoice runs, each with its scrape number, as a list, as Excel and as a
// ZIP of the files saved for each shipment. Mounted at /api/get-invoice-runs
// (auth is applied where it is mounted). Read only.
//   GET /columns               the Excel columns there are (for the column picker)
//   GET /                      runs, newest first, with counts
// Every Excel (and the one inside a ZIP) takes the sheet options of
// parseExportOptions: ?columns=&label.<key>=&sort=&dir=&status=&latest=
//   GET /export.xlsx           every run's shipments in one sheet
//   GET /files.zip             every run's files, one folder per shipment, + the sheet
//   GET /:n                    one run (by scrape number) and its shipments
//   GET /:n/export.xlsx        one run as Excel
//   GET /:n/files.zip          one run's files + its sheet
//   GET /:n/master.xlsx, /master.xlsx   FreightPOP's own export in master-file layout
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { filterSortXlsx, reshapeXlsx, writeXlsx, zip } from "../lib/xlsxWrite.js";
import { ERP_BUCKET } from "../lib/invoiceDocs.js";
import {
  EXPORT_COLUMNS, buildExport, buildRunRows, giPushed, masterFileDrop, scrapeStatusLabel, parseExportOptions, runShipmentIds, summarizeRun, zipPlan,
} from "../lib/getInvoiceRuns.js";

export const getInvoiceRunsRouter = Router();

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ID_CHUNK = 100;
const MAX_ZIP_FILES = 3000;
const DOWNLOAD_CONCURRENCY = 6;

async function inChunks(ids, read) {
  const out = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await read(ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(error.message);
    out.push(...(data || []));
  }
  return out;
}

// Every Get Invoice run with its shipments' rows. `only` limits it to one run.
// Documents of every status but skipped are read, so the flags can tell "not
// read yet" and "could not be read" from "no invoice" (see flagsFor).
export async function load(only = null) {
  const { data: all, error } = await supabase
    .from("fpx_scrape_requests")
    .select("id, scrape_number, status, requested_at, completed_at, requested_by, tracking_numbers, result_count, note")
    .eq("scope", "get_invoice").order("requested_at", { ascending: false }).limit(2000);
  if (error) throw new Error(error.message);
  const runs = only == null ? all || [] : (all || []).filter((r) => String(r.scrape_number) === String(only));
  const byId = new Map((all || []).map((r) => [r.id, r]));
  const ids = [...new Set(runs.flatMap(runShipmentIds))];
  const [auditRows, tx, docs] = await Promise.all([
    inChunks(ids, (c) => supabase.from("fpx_invoice_audit_rows")
      .select("audit_id, shipment_id, customer_name, carrier, raw").in("shipment_id", c).not("raw->get_invoice", "is", null)),
    inChunks(ids, (c) => supabase.from("fpx_erp_transactions")
      .select("shipment_id, customer_name, carrier, tracking_number, billing_invoice_number, charge, cost, approved_invoice_amount, exported_to_erp").in("shipment_id", c)),
    inChunks(ids, (c) => supabase.from("fpx_invoice_documents")
      .select("shipment_id, audit_id, file, doc_type, status, invoice_number, total, carrier, confidence, warnings").in("shipment_id", c).neq("status", "skipped")),
  ]);
  const group = (list) => {
    const m = new Map();
    for (const r of list) {
      const k = String(r.shipment_id ?? "").trim();
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const ctx = { byId, rowsByShipment: group(auditRows), tx: new Map(tx.map((t) => [String(t.shipment_id), t])), docs: group(docs) };
  const rowsByRun = new Map(runs.map((run) => [run.id, buildRunRows(run, ctx)]));
  return { runs, rowsByRun };
}

const fail = (res, e) => res.status(500).json({ error: e?.message || String(e) });
const day = () => new Date().toISOString().slice(0, 10);

const sheet = (runs, rowsByRun, query) => {
  const { headers, rows } = buildExport(runs, rowsByRun, parseExportOptions(query));
  return writeXlsx(headers, rows);
};

function sendXlsx(res, runs, rowsByRun, name, query) {
  const buf = sheet(runs, rowsByRun, query);
  res.set({ "Content-Type": XLSX_TYPE, "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": String(buf.length), "Cache-Control": "private, no-store" });
  res.send(buf);
}

// FreightPOP's own Transactions export (kept with each ERP pull), cut to the
// runs' shipments in master-file layout: see masterFileDrop. Each shipment
// carries the scrape number and status of its newest run, and whether GET
// INVOICE was pushed for it in any run. Null when no pull kept a file.
async function masterSheet(runs, rowsByRun) {
  const scrape = new Map(); // shipment → its newest run's row (runs come newest first)
  const pushed = new Set(); // shipments GET INVOICE was pushed for, in any run
  const order = [];
  const audits = [];
  for (const run of runs) {
    for (const r of rowsByRun.get(run.id) || []) {
      if (giPushed(r)) pushed.add(r.shipment_id);
      if (!scrape.has(r.shipment_id)) { scrape.set(r.shipment_id, r); order.push(r.shipment_id); }
      if (r.audit_id && !audits.includes(r.audit_id)) audits.push(r.audit_id);
    }
  }
  const files = [];
  for (const a of audits) {
    for (const name of ["full.xlsx", "not-exported.xlsx"]) {
      const { data, error } = await supabase.storage.from(ERP_BUCKET).download(`${a}/${name}`);
      if (!error && data) { files.push(Buffer.from(await data.arrayBuffer())); break; }
    }
  }
  if (!files.length) return null;
  const idOf = (o) => String(o?.ShipmentID ?? o?.["Shipment ID"] ?? "").trim();
  const rank = new Map(order.map((id, i) => [id, i]));
  const seen = new Set();
  const cut = filterSortXlsx(files[0], {
    more: files.slice(1),
    keep: (o) => { const id = idOf(o); if (!scrape.has(id) || seen.has(id)) return false; seen.add(id); return true; },
    compare: (a, b) => rank.get(idOf(a)) - rank.get(idOf(b)),
  });
  return reshapeXlsx(cut, {
    drop: masterFileDrop,
    add: [
      { title: "Scrape #", value: (o) => scrape.get(idOf(o))?.scrape_number ?? null },
      { title: "Scrape Status", value: (o) => scrapeStatusLabel(scrape.get(idOf(o))?.status) },
      { title: "Get Invoice Pushed", value: (o) => (scrape.has(idOf(o)) ? (pushed.has(idOf(o)) ? "Yes" : "No") : null) },
    ],
  });
}

async function sendMaster(res, runs, rowsByRun, name) {
  const buf = await masterSheet(runs, rowsByRun);
  if (!buf) return res.status(404).json({ error: "FreightPOP's Transactions export was not kept for these shipments' ERP pull, so this file can't be made. Use the standard Excel instead." });
  res.set({ "Content-Type": XLSX_TYPE, "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": String(buf.length), "Cache-Control": "private, no-store" });
  res.send(buf);
}

// The ZIP: one folder per shipment with its files and data.json (what FPX
// holds for it in Supabase), and the Excel sheet at the root.
async function sendZip(res, runs, rowsByRun, base, query) {
  const rows = runs.flatMap((r) => rowsByRun.get(r.id) || []);
  const plan = zipPlan(rows);
  if (plan.length > MAX_ZIP_FILES) {
    return res.status(413).json({ error: `That is ${plan.length} files; download one run at a time (up to ${MAX_ZIP_FILES} files).` });
  }
  const shipments = [...new Set(rows.map((r) => r.shipment_id))];
  const [tx, docs] = await Promise.all([
    inChunks(shipments, (c) => supabase.from("fpx_erp_transactions").select("*").in("shipment_id", c)),
    inChunks(shipments, (c) => supabase.from("fpx_invoice_documents")
      .select("shipment_id, audit_id, file, doc_type, status, extracted_at, model, confidence, invoice_number, invoice_date, due_date, carrier, carrier_scac, bill_to, remit_to, ship_from, ship_to, tracking_number, bol_number, po_number, so_number, quote_number, currency, subtotal, fuel_surcharge, accessorial_total, discount, tax, total, weight, pieces, freight_class, terms, line_items, fields, warnings, summary, raw_text")
      .in("shipment_id", c)),
  ]);

  const entries = [];
  const missing = [];
  for (let i = 0; i < plan.length; i += DOWNLOAD_CONCURRENCY) {
    await Promise.all(plan.slice(i, i + DOWNLOAD_CONCURRENCY).map(async (p) => {
      try {
        const { data, error } = await supabase.storage.from(ERP_BUCKET).download(`${p.audit_id}/${p.file}`);
        if (error || !data) throw new Error(error?.message || "not found");
        entries.push({ name: `${base}/${p.name}`, data: Buffer.from(await data.arrayBuffer()) });
      } catch (e) {
        missing.push(`${p.shipment_id}: ${p.file} (${e?.message || e})`);
      }
    }));
  }
  for (const id of shipments) {
    const json = {
      shipment_id: id,
      get_invoice_runs: rows.filter((r) => r.shipment_id === id),
      freightpop_transaction: tx.find((t) => String(t.shipment_id) === id) || null,
      documents_read: docs.filter((d) => String(d.shipment_id) === id),
    };
    entries.push({ name: `${base}/${id.replace(/[^A-Za-z0-9_.-]+/g, "_")}/data.json`, data: Buffer.from(JSON.stringify(json, null, 2)) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  entries.unshift({ name: `${base}/${base}.xlsx`, data: sheet(runs, rowsByRun, query) });
  try {
    const master = await masterSheet(runs, rowsByRun);
    if (master) entries.splice(1, 0, { name: `${base}/${base}-master-file.xlsx`, data: master });
  } catch (e) {
    missing.push(`master-file Excel: ${e?.message || e}`);
  }
  if (missing.length) entries.push({ name: `${base}/MISSING-FILES.txt`, data: Buffer.from(`These files could not be read from storage:\n${missing.join("\n")}\n`) });
  const buf = zip(entries);
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${base}.zip"`, "Content-Length": String(buf.length), "Cache-Control": "private, no-store" });
  res.send(buf);
}

// The columns the export can have, for the dashboard's column picker.
getInvoiceRunsRouter.get("/columns", (_req, res) => {
  res.json({ columns: EXPORT_COLUMNS.map(({ key, label, on }) => ({ key, label, default: on })) });
});

getInvoiceRunsRouter.get("/", async (_req, res) => {
  try {
    const { runs, rowsByRun } = await load();
    res.json({ runs: runs.map((r) => summarizeRun(r, rowsByRun.get(r.id) || [])) });
  } catch (e) { fail(res, e); }
});

getInvoiceRunsRouter.get("/export.xlsx", async (req, res) => {
  try {
    const { runs, rowsByRun } = await load();
    sendXlsx(res, runs, rowsByRun, `GetInvoice-AllScrapes-${day()}.xlsx`, req.query);
  } catch (e) { fail(res, e); }
});

getInvoiceRunsRouter.get("/master.xlsx", async (_req, res) => {
  try {
    const { runs, rowsByRun } = await load();
    await sendMaster(res, runs, rowsByRun, `GetInvoice-AllScrapes-MasterFile-${day()}.xlsx`);
  } catch (e) { fail(res, e); }
});

getInvoiceRunsRouter.get("/files.zip", async (req, res) => {
  try {
    const { runs, rowsByRun } = await load();
    await sendZip(res, runs, rowsByRun, `GetInvoice-AllScrapes-${day()}`, req.query);
  } catch (e) { fail(res, e); }
});

async function oneRun(req, res) {
  const n = String(req.params.n || "").replace(/^#/, "");
  if (!/^\d{1,12}$/.test(n)) { res.status(400).json({ error: "Use the scrape number, e.g. /57" }); return null; }
  const got = await load(n);
  if (!got.runs.length) { res.status(404).json({ error: `No Get Invoice run has scrape number ${n}` }); return null; }
  return { ...got, n };
}

getInvoiceRunsRouter.get("/:n", async (req, res) => {
  try {
    const got = await oneRun(req, res);
    if (!got) return;
    const run = got.runs[0];
    const rows = got.rowsByRun.get(run.id) || [];
    res.json({ run: summarizeRun(run, rows), rows });
  } catch (e) { fail(res, e); }
});

getInvoiceRunsRouter.get("/:n/export.xlsx", async (req, res) => {
  try {
    const got = await oneRun(req, res);
    if (got) sendXlsx(res, got.runs, got.rowsByRun, `GetInvoice-Scrape-${got.n}.xlsx`, req.query);
  } catch (e) { fail(res, e); }
});

getInvoiceRunsRouter.get("/:n/master.xlsx", async (req, res) => {
  try {
    const got = await oneRun(req, res);
    if (got) await sendMaster(res, got.runs, got.rowsByRun, `GetInvoice-Scrape-${got.n}-MasterFile.xlsx`);
  } catch (e) { fail(res, e); }
});

getInvoiceRunsRouter.get("/:n/files.zip", async (req, res) => {
  try {
    const got = await oneRun(req, res);
    if (got) await sendZip(res, got.runs, got.rowsByRun, `GetInvoice-Scrape-${got.n}`, req.query);
  } catch (e) { fail(res, e); }
});
