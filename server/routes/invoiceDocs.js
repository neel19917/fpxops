// /api/invoice-docs — what the saved invoice files say (fpx_invoice_documents;
// read by lib/invoiceDocs.js). Mounted behind the API's own auth.
//
// Doc = { id, shipment_id, audit_id, file, doc_type, status, error,
//         invoice_number, invoice_date, due_date, carrier, bill_to, ship_from,
//         ship_to, tracking_number, bol_number, po_number, so_number, terms,
//         currency, subtotal, fuel_surcharge, accessorial_total, total,
//         line_items, fields, summary, confidence, warnings, model, extracted_at }
// GET /:id adds raw_text (and the columns the lists leave out).

import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { isUuid } from "../lib/getInvoice.js";
import { DOC_TYPES } from "../lib/invoiceExtract.js";
import {
  backfillFromRecords, retryFailed, kickInvoiceDocs, queryEmbedding, invoiceDocWorkerEnabled, invoiceDocsState,
} from "../lib/invoiceDocs.js";

export const invoiceDocsRouter = Router();

const TABLE = "fpx_invoice_documents";
export const DOC_COLS = [
  "id", "shipment_id", "audit_id", "file", "doc_type", "status", "error",
  "invoice_number", "invoice_date", "due_date", "carrier", "bill_to", "ship_from", "ship_to",
  "tracking_number", "bol_number", "po_number", "so_number", "terms", "currency",
  "subtotal", "fuel_surcharge", "accessorial_total", "total",
  "line_items", "fields", "summary", "confidence", "warnings", "model", "extracted_at",
];
const DETAIL_COLS = [
  ...DOC_COLS, "raw_text", "carrier_scac", "remit_to", "quote_number", "discount", "tax", "weight", "pieces",
  "freight_class", "attempts", "bytes", "mime", "content_sha256", "input_tokens", "output_tokens", "cost_usd",
  "created_at", "updated_at",
];
const STATUSES = ["pending", "processing", "done", "failed", "skipped"];
// Columns the list's `q` looks in.
const Q_COLS = [
  "shipment_id", "invoice_number", "tracking_number", "bol_number", "po_number", "so_number", "quote_number",
  "carrier", "bill_to", "ship_from", "ship_to", "file", "summary",
];

const pickDoc = (row) => Object.fromEntries(DOC_COLS.map((c) => [c, row?.[c] ?? null]));
const intIn = (v, dflt, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
// A search word as it can sit inside a PostgREST or=(col.ilike."%...%") filter.
export const likeTerm = (q) => String(q || "").replace(/["\\%*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

// GET /?shipment_id=&status=&doc_type=&q=&limit=&offset=
// Newest first. q matches part of a shipment id, a number printed on the
// document, a carrier, a party, the file name or the summary.
// limit default 50, at most 500. Responds { data: Doc[], total }.
invoiceDocsRouter.get("/", async (req, res) => {
  const { shipment_id, status, doc_type } = req.query;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
  if (doc_type && !DOC_TYPES.includes(doc_type)) return res.status(400).json({ error: `doc_type must be one of ${DOC_TYPES.join(", ")}` });
  const limit = intIn(req.query.limit, 50, 1, 500);
  const offset = intIn(req.query.offset, 0, 0, 1_000_000);
  let query = supabase.from(TABLE).select(DOC_COLS.join(", "), { count: "exact" });
  if (shipment_id) query = query.eq("shipment_id", String(shipment_id).trim());
  if (status) query = query.eq("status", status);
  if (doc_type) query = query.eq("doc_type", doc_type);
  const term = likeTerm(req.query.q);
  if (term) query = query.or(Q_COLS.map((c) => `${c}.ilike."%${term}%"`).join(","));
  const { data, error, count } = await query
    .order("created_at", { ascending: false }).order("file", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: (data || []).map(pickDoc), total: count ?? (data || []).length });
});

// GET /search?q=&limit=
// Ranked search over the documents that have been read: exact and partial
// numbers, words anywhere in the text, misspelt carrier names, and — when q
// is a phrase and the embedding function answers — meaning.
// Responds { data: (Doc & { score })[], mode: "semantic" | "text" }.
invoiceDocsRouter.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 500);
  if (!q) return res.status(400).json({ error: "q is required" });
  const limit = intIn(req.query.limit, 20, 1, 100);
  const embedding = await queryEmbedding(supabase, q).catch(() => null);
  const { data, error } = await supabase.rpc("fpx_invoice_documents_search", {
    p_query: q, p_embedding: embedding, p_limit: limit,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    data: (data || []).map((r) => ({ ...pickDoc(r.doc), score: Number(r.score) || 0 })),
    mode: embedding ? "semantic" : "text",
  });
});

// GET /summary
// Responds { total, by_status: { pending, processing, done, failed, skipped },
// by_doc_type: { invoice, bol, ... }, last_extracted_at } (+ cost_usd, the
// Claude spend so far, and worker: whether this server reads files).
invoiceDocsRouter.get("/summary", async (_req, res) => {
  const { data, error } = await supabase.rpc("fpx_invoice_documents_summary");
  if (error) return res.status(500).json({ error: error.message });
  const s = data || {};
  res.json({
    total: Number(s.total) || 0,
    by_status: Object.fromEntries(STATUSES.map((k) => [k, Number(s.by_status?.[k]) || 0])),
    by_doc_type: Object.fromEntries(DOC_TYPES.map((k) => [k, Number(s.by_doc_type?.[k]) || 0])),
    last_extracted_at: s.last_extracted_at || null,
    cost_usd: Number(s.cost_usd) || 0,
    worker: invoiceDocWorkerEnabled(),
  });
});

// POST /process  body { shipment_id?, audit_id?, limit?, retry_failed? }
// Queues every saved file (fpx_shipment_records.files) that has no row yet —
// all of them, or one shipment's / one pull's — and starts reading. With
// retry_failed, files that ran out of tries wait again. limit caps how many
// files this run reads (default 500). Responds { queued, processing: true }
// straight away; reading goes on in the background (watch GET /summary).
// processing is false, with `reason`, when this server has no Claude key.
invoiceDocsRouter.post("/process", async (req, res) => {
  const body = req.body || {};
  const shipment_id = body.shipment_id != null && String(body.shipment_id).trim() ? String(body.shipment_id).trim() : null;
  if (body.audit_id != null && body.audit_id !== "" && !isUuid(body.audit_id)) return res.status(400).json({ error: "audit_id must be an audit's id" });
  const audit_id = body.audit_id || null;

  const filled = await backfillFromRecords(supabase, { shipment_id, audit_id });
  if (filled.error && !filled.queued) return res.status(500).json({ error: filled.error });
  let queued = filled.queued;
  if (body.retry_failed === true) {
    const r = await retryFailed(supabase, { shipment_id, audit_id });
    if (r.error) return res.status(500).json({ error: r.error });
    queued += r.retried;
  }
  const processing = kickInvoiceDocs({ limit: intIn(body.limit, 500, 1, 5000) });
  res.json({
    queued, processing,
    ...(processing ? {} : { reason: "Reading is off on this server (ANTHROPIC_API_KEY is not set)" }),
  });
});

// ---------------------------------------------------------------------------
// The reading log and live state (the dashboard's "Reading invoices" page).
// Read only.
// ---------------------------------------------------------------------------
const LOG_TABLE = "fpx_invoice_doc_log";
export const LOG_COLS = ["id", "at", "document_id", "shipment_id", "file", "doc_type", "step", "level", "message", "ms", "cost_usd"];
export const LOG_LEVELS = ["info", "ok", "warn", "error"];

// The /log query string, checked. Returns { error } or the filters:
// { since_id: number|null, document_id, shipment_id, levels: string[]|null, limit }.
// level may be one level or a comma list ("warn,error").
export function parseLogQuery(q = {}) {
  let since_id = null;
  if (q.since_id != null && String(q.since_id).trim() !== "") {
    const n = Number(q.since_id);
    if (!Number.isSafeInteger(n) || n < 0) return { error: "since_id must be a log line's id" };
    since_id = n;
  }
  let document_id = null;
  if (q.document_id != null && String(q.document_id).trim() !== "") {
    if (!isUuid(String(q.document_id).trim())) return { error: "document_id must be a document's id" };
    document_id = String(q.document_id).trim();
  }
  const shipment_id = q.shipment_id != null && String(q.shipment_id).trim() ? String(q.shipment_id).trim().slice(0, 100) : null;
  let levels = null;
  if (q.level != null && String(q.level).trim() !== "") {
    levels = [...new Set(String(q.level).split(",").map((s) => s.trim()).filter(Boolean))];
    const bad = levels.find((l) => !LOG_LEVELS.includes(l));
    if (bad) return { error: `level must be one of ${LOG_LEVELS.join(", ")}` };
  }
  return { since_id, document_id, shipment_id, levels, limit: intIn(q.limit, 200, 1, 1000) };
}

export const pickLog = (row) => ({
  id: Number(row?.id) || 0,
  at: row?.at ?? null,
  document_id: row?.document_id ?? null,
  shipment_id: row?.shipment_id ?? null,
  file: row?.file ?? null,
  doc_type: row?.doc_type ?? null,
  step: row?.step ?? null,
  level: LOG_LEVELS.includes(row?.level) ? row.level : "info",
  message: row?.message ?? "",
  ms: row?.ms == null ? null : Number(row.ms),
  cost_usd: row?.cost_usd == null ? null : Number(row.cost_usd),
});

// The newest id among the lines, or the one the caller already had.
export const lastIdOf = (lines, since_id = null) =>
  lines.reduce((m, l) => (l.id > m ? l.id : m), since_id ?? 0) || null;

// Midnight UTC of the day `now` falls in, as an ISO string.
export const startOfUtcDay = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

// Sum of cost_usd, ignoring blanks; rounded to 1/10000 of a dollar.
export const sumCost = (rows) =>
  Math.round((rows || []).reduce((s, r) => s + (Number(r?.cost_usd) || 0), 0) * 10_000) / 10_000;

// GET /log?since_id=&document_id=&shipment_id=&level=&limit=
// Lines of the reading log. Without since_id: the newest `limit` lines,
// newest first. With since_id: only lines after it, oldest first (for live
// tailing). limit default 200, at most 1000. Responds { data: LogLine[],
// last_id } — last_id is the newest id seen (pass it back as since_id).
invoiceDocsRouter.get("/log", async (req, res) => {
  const f = parseLogQuery(req.query);
  if (f.error) return res.status(400).json({ error: f.error });
  let query = supabase.from(LOG_TABLE).select(LOG_COLS.join(", "));
  if (f.since_id != null) query = query.gt("id", f.since_id);
  if (f.document_id) query = query.eq("document_id", f.document_id);
  if (f.shipment_id) query = query.eq("shipment_id", f.shipment_id);
  if (f.levels) query = query.in("level", f.levels);
  const { data, error } = await query.order("id", { ascending: f.since_id != null }).limit(f.limit);
  if (error) return res.status(500).json({ error: error.message });
  const lines = (data || []).map(pickLog);
  res.json({ data: lines, last_id: lastIdOf(lines, f.since_id) });
});

// GET /state
// What the reader is doing now on this API server, with the counts:
// { enabled, running, run, reading: [...],            (lib/invoiceDocs.js)
//   total, by_status, by_doc_type, last_extracted_at, cost_usd,
//   queue: { pending, processing, failed }, cost_today_usd }
// cost_today_usd sums the log's cost_usd since midnight UTC.
invoiceDocsRouter.get("/state", async (_req, res) => {
  const since = startOfUtcDay();
  const [summary, today] = await Promise.all([
    supabase.rpc("fpx_invoice_documents_summary"),
    supabase.from(LOG_TABLE).select("cost_usd").gte("at", since).not("cost_usd", "is", null).limit(20_000),
  ]);
  if (summary.error) return res.status(500).json({ error: summary.error.message });
  const s = summary.data || {};
  const by_status = Object.fromEntries(STATUSES.map((k) => [k, Number(s.by_status?.[k]) || 0]));
  res.json({
    ...invoiceDocsState(),
    total: Number(s.total) || 0,
    by_status,
    by_doc_type: Object.fromEntries(DOC_TYPES.map((k) => [k, Number(s.by_doc_type?.[k]) || 0])),
    last_extracted_at: s.last_extracted_at || null,
    cost_usd: Number(s.cost_usd) || 0,
    queue: { pending: by_status.pending, processing: by_status.processing, failed: by_status.failed },
    // null when the log could not be read (e.g. the table is not there yet).
    cost_today_usd: today.error ? null : sumCost(today.data),
  });
});

// GET /:id — one document, with raw_text.
invoiceDocsRouter.get("/:id", async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Document not found" });
  const { data, error } = await supabase.from(TABLE).select(DETAIL_COLS.join(", ")).eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Document not found" });
  res.json(data);
});
