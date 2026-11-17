// Pushed to ERP: the invoices FreightPOP has already exported to the ERP
// (NetSuite), for matching against NetSuite during reconciliation.
// Mounted at /api/audits/erp/pushed (auth is applied where it is mounted).
// Read only: nothing here writes to Supabase or FreightPOP.
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { writeXlsx } from "../lib/xlsxWrite.js";
import {
  TX_SELECT, AP_SELECT, PAGE_SIZE, MAX_MATCH, EXPORT_HEADERS,
  parseFilters, buildRows, buildMatchRows, filterRows, sortRows, listPushed, exportRows,
  parseInvoices, matchInvoices, loadAllPages,
} from "../lib/erpPushed.js";

export const erpPushedRouter = Router();

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CONCURRENCY = 8;
const CACHE_MS = 60_000;

// Every row of a table (or the exported shipments only), 1000 at a time. The
// count is read alongside: fewer rows than the count means a page came back
// short (a lower row cap than expected), which must not pass as the full list.
async function readAll(table, select, keyColumn, filter = (q) => q) {
  const [rows, counted] = await Promise.all([
    loadAllPages(
      (from, to) => filter(supabase.from(table).select(select)).order(keyColumn, { ascending: true }).range(from, to),
      { pageSize: PAGE_SIZE, concurrency: CONCURRENCY, key: (r) => r[keyColumn] },
    ),
    filter(supabase.from(table).select(keyColumn, { count: "exact", head: true })),
  ]);
  if (!counted.error && typeof counted.count === "number" && rows.length < counted.count * 0.995) {
    throw new Error(`Read ${rows.length} of ${counted.count} rows from ${table}`);
  }
  return rows;
}

// The joined rows, kept for a minute so paging, typing in the search box and
// the Excel download don't each re-read ~70 pages. One read at a time per kind.
//   pushed  exported shipments with their approvals (the list and the Excel)
//   all     every shipment, and approvals with no shipment (the match)
const cache = new Map();
function snapshot(kind) {
  const hit = cache.get(kind);
  if (hit && (hit.pending || Date.now() - hit.at < CACHE_MS)) return hit.promise;
  const entry = { at: Date.now(), pending: true, promise: null };
  entry.promise = (async () => {
    try {
      const [transactions, approvals] = await Promise.all([
        readAll("fpx_erp_pushed_transactions", TX_SELECT, "shipment_id", kind === "pushed" ? (q) => q.eq("exported_to_erp", true) : undefined),
        readAll("fpx_erp_pushed_approvals", AP_SELECT, "approval_key"),
      ]);
      entry.at = Date.now();
      return {
        rows: kind === "pushed" ? buildRows(transactions, approvals) : buildMatchRows(transactions, approvals),
        read_at: new Date().toISOString(),
      };
    } catch (e) {
      cache.delete(kind);
      throw e;
    } finally {
      entry.pending = false;
    }
  })();
  cache.set(kind, entry);
  return entry.promise;
}

// GET /audits/erp/pushed?from=&to=&dated=&q=&carrier=&customer=&limit=&offset=
// The pushed invoices, newest push first.
//   from, to   YYYY-MM-DD on the pushed date. Rows with no known pushed date
//              are included too, unless dated=1.
//   q          part of a shipment id, tracking number, carrier invoice number,
//              customer invoice number, customer or carrier
//   carrier, customer   part of the name
//   limit      default 200, at most 2000;  offset  default 0
// Responds { data, totals: { count, dated, undated, charge, cost, gross_profit,
// approved_invoice_amount }, per_day: [{ date, count, charge }], limit, offset,
// read_at }. totals and per_day cover everything the filter matches, not just
// the page.
erpPushedRouter.get("/", async (req, res) => {
  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  try {
    const snap = await snapshot("pushed");
    const out = listPushed(snap.rows, filters);
    // How many files FPX has saved for each shipment on this page (0 = none yet).
    const saved = await savedFileCounts(out.data.map((r) => r.shipment_id));
    res.json({ ...out, data: out.data.map((r) => ({ ...r, saved_files: saved.get(String(r.shipment_id)) || 0 })), read_at: snap.read_at });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// shipment id → number of files kept in fpx_shipment_records. A failed read
// counts as none: the list still loads.
async function savedFileCounts(ids) {
  const out = new Map();
  const keys = [...new Set(ids.filter(Boolean).map(String))];
  for (let i = 0; i < keys.length; i += 200) {
    try {
      const { data, error } = await supabase.from("fpx_shipment_records").select("shipment_id, files").in("shipment_id", keys.slice(i, i + 200));
      if (error) continue;
      for (const r of data || []) out.set(r.shipment_id, (out.get(r.shipment_id) || 0) + (Array.isArray(r.files) ? r.files.length : 0));
    } catch { /* none */ }
  }
  return out;
}

// GET /audits/erp/pushed/records/:shipmentId — what FPX has saved for one
// shipment: the screenshots and documents of each capture, and the quote id
// FreightPOP's own Shipment Details page opens by.
// Responds { shipment_id, quote_id, records: [{ kind, audit_id, files, captured_at, captured_by }] }.
erpPushedRouter.get("/records/:shipmentId", async (req, res) => {
  const id = String(req.params.shipmentId || "").trim();
  if (!/^[\w-]{1,40}$/.test(id)) return res.status(400).json({ error: "Not a shipment id" });
  try {
    const [recs, tx] = await Promise.all([
      supabase.from("fpx_shipment_records").select("kind, audit_id, files, captured_at, captured_by").eq("shipment_id", id).order("captured_at", { ascending: false }),
      supabase.from("fpx_erp_transactions").select("q:data->>QuoteID").eq("shipment_id", id).limit(1),
    ]);
    if (recs.error) return res.status(500).json({ error: recs.error.message });
    res.json({
      shipment_id: id,
      quote_id: tx.error ? null : String(tx.data?.[0]?.q || "").trim() || null,
      records: (recs.data || []).map((r) => ({ ...r, files: Array.isArray(r.files) ? r.files : [] })),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// GET /audits/erp/pushed/export — the same filters (limit and offset are
// ignored: every matching row), as an .xlsx download.
erpPushedRouter.get("/export", async (req, res) => {
  const filters = parseFilters(req.query);
  if (filters.error) return res.status(400).json({ error: filters.error });
  let buf;
  try {
    const snap = await snapshot("pushed");
    buf = writeXlsx(EXPORT_HEADERS, exportRows(sortRows(filterRows(snap.rows, filters))));
  } catch (e) {
    return res.status(500).json({ error: `Could not build the Excel file: ${e?.message || e}` });
  }
  const range = filters.from || filters.to ? `-${filters.from || "start"}_to_${filters.to || new Date().toISOString().slice(0, 10)}` : `-${new Date().toISOString().slice(0, 10)}`;
  res.set({
    "Content-Type": XLSX_TYPE,
    "Content-Disposition": `attachment; filename="PushedToERP${range}.xlsx"`,
    "Content-Length": String(buf.length),
    "Cache-Control": "private, no-store",
  });
  res.send(buf);
});

// POST /audits/erp/pushed/match  { invoices: string[] }  (at most 5000)
// Invoice numbers and/or shipment ids pasted from NetSuite → for each one
// { input, found, pushed, matched_on, row, others }, and
// summary { total, pushed, not_pushed, not_found }.
//   found       it is in what we keep from FreightPOP
//   pushed      FreightPOP has it as exported to ERP
//   matched_on  shipment_id | billing_invoice_number | invoice_number |
//               bol_number | tracking_number
erpPushedRouter.post("/match", async (req, res) => {
  const parsed = parseInvoices(req.body?.invoices);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const snap = await snapshot("all");
    res.json({ ...matchInvoices(parsed.values, snap.rows), max: MAX_MATCH, read_at: snap.read_at });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});
