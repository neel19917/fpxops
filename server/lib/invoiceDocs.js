// The queue and worker that read saved invoice files into
// fpx_invoice_documents (see migrations/2026-11-17_invoice_documents.sql).
//
//   queueInvoiceDocuments()  a capture was stored → one row per file
//                            ('pending', or 'skipped' with the reason)
//   processPending()         take waiting rows → download from Storage →
//                            Claude (lib/invoiceExtract.js) → save the columns
//                            → chunks + embeddings → 'done'
//   startInvoiceDocWorker()  kick after every queue + a sweep every 5 minutes
//
// A file is read by Claude once: a row whose bytes have not changed
// (content_sha256) is marked done again without a call, and a file with the
// same bytes as one already read (the same PDF in another pull) copies that
// reading. Nothing here deletes a file or a document row.

import { supabase, isDbReady } from "./supabase.js";
import { isUuid } from "./getInvoice.js";
import {
  planFiles, mimeOf, sha256, normalizeExtraction, chunksForRow, extractDocument, EXTRACTED_COLS,
} from "./invoiceExtract.js";

export const ERP_BUCKET = "erp-pulls";
export const MAX_ATTEMPTS = 3;
const TABLE = "fpx_invoice_documents";
const CHUNKS = "fpx_invoice_document_chunks";

const isTestRun = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.some((a) => a.startsWith("--test"));
// The worker only runs on a real server with a database and a Claude key.
export const invoiceDocWorkerEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY) && isDbReady() && !isTestRun();

// One warning per kind of problem per 10 minutes (a missing table would
// otherwise log on every capture).
const warned = new Map();
function warnOnce(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) || 0) < 10 * 60_000) return;
  warned.set(key, now);
  console.warn(`[FPX] invoice documents: ${message}`);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

// What to write for one capture, given the rows already there. No database.
//   recheck true  (a new capture): a file read before is queued again — the
//                 worker compares its bytes and only calls Claude if they changed
//   recheck false (backfill): rows already there are left as they are
// Returns { inserts: [row], updates: [{ id, patch }] }.
export function queuePlan({ shipment_id, audit_id, files }, existing = [], { recheck = true } = {}) {
  const byFile = new Map((existing || []).map((r) => [r.file, r]));
  const inserts = [];
  const updates = [];
  for (const p of planFiles(files, [...byFile.keys()])) {
    const had = byFile.get(p.file);
    if (!had) {
      inserts.push({
        shipment_id, audit_id, file: p.file, doc_type: p.doc_type, mime: p.mime,
        status: p.action === "process" ? "pending" : "skipped",
        error: p.action === "process" ? null : p.reason,
      });
    } else if (p.action === "process") {
      const again = had.status === "skipped" || (recheck && (had.status === "done" || had.status === "failed"));
      if (again) updates.push({ id: had.id, patch: { status: "pending", attempts: 0, error: null, doc_type: p.doc_type, mime: p.mime } });
    } else if (had.status === "pending" || had.status === "failed") {
      // Not read yet and now there is a better file (the PDF): leave it, with the reason.
      updates.push({ id: had.id, patch: { status: "skipped", error: p.reason } });
    }
  }
  return { inserts, updates };
}

// Records the files of one shipment's capture so they get read. Never
// throws and never rejects: a problem comes back as { error } and is logged.
// Responds { queued, skipped, requeued } (rows added to wait, rows recorded
// as skipped, rows already there put back to wait).
export async function queueInvoiceDocuments(sb, { shipment_id, audit_id, files } = {}, { recheck = true, kick = true } = {}) {
  const out = { queued: 0, skipped: 0, requeued: 0 };
  try {
    const shipment = String(shipment_id ?? "").trim();
    const list = (Array.isArray(files) ? files : []).filter((f) => typeof f === "string" && f.trim());
    if (!shipment || !isUuid(audit_id) || !list.length) return out;

    const { data: existing, error: readErr } = await sb.from(TABLE)
      .select("id, file, status").eq("audit_id", audit_id).eq("shipment_id", shipment).limit(1000);
    if (readErr) throw new Error(readErr.message);

    const { inserts, updates } = queuePlan({ shipment_id: shipment, audit_id, files: list }, existing || [], { recheck });
    if (inserts.length) {
      const { error } = await sb.from(TABLE).upsert(inserts, { onConflict: "audit_id,file", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      out.queued += inserts.filter((r) => r.status === "pending").length;
      out.skipped += inserts.filter((r) => r.status === "skipped").length;
    }
    const now = new Date().toISOString();
    for (const u of updates) {
      const { error } = await sb.from(TABLE).update({ ...u.patch, updated_at: now }).eq("id", u.id);
      if (error) throw new Error(error.message);
      if (u.patch.status === "pending") out.requeued += 1; else out.skipped += 1;
    }
    if (kick && (out.queued || out.requeued)) kickInvoiceDocs();
    return out;
  } catch (e) {
    warnOnce("queue", `files not queued for reading: ${e?.message || e}`);
    return { ...out, error: String(e?.message || e) };
  }
}

// Queues every file in fpx_shipment_records that has no row yet (rows already
// there are left alone). Returns { queued, skipped, shipments } or { error }.
export async function backfillFromRecords(sb, { shipment_id = null, audit_id = null } = {}) {
  const out = { queued: 0, skipped: 0, shipments: 0 };
  try {
    // One shipment has up to two records (invoice, view_shipment): their files together.
    const captures = new Map();
    const PAGE = 500;
    for (let from = 0; from < 200_000; from += PAGE) {
      let q = sb.from("fpx_shipment_records").select("shipment_id, kind, audit_id, files")
        .not("audit_id", "is", null).not("files", "eq", "{}")
        .order("shipment_id").order("kind").range(from, from + PAGE - 1);
      if (shipment_id) q = q.eq("shipment_id", String(shipment_id));
      if (audit_id) q = q.eq("audit_id", audit_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        const key = `${r.audit_id}|${r.shipment_id}`;
        const c = captures.get(key) || { shipment_id: r.shipment_id, audit_id: r.audit_id, files: [] };
        c.files.push(...(r.files || []));
        captures.set(key, c);
      }
      if (!data || data.length < PAGE) break;
    }
    const todo = [...captures.values()];
    out.shipments = todo.length;
    let next = 0;
    let firstError = null;
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        const r = await queueInvoiceDocuments(sb, todo[next++], { recheck: false, kick: false });
        out.queued += (r.queued || 0) + (r.requeued || 0);
        out.skipped += r.skipped || 0;
        if (r.error && !firstError) firstError = r.error;
      }
    }));
    return firstError && !out.queued ? { ...out, error: firstError } : out;
  } catch (e) {
    return { ...out, error: String(e?.message || e) };
  }
}

// Puts files that ran out of tries back to wait. Returns how many.
export async function retryFailed(sb, { shipment_id = null, audit_id = null } = {}) {
  let q = sb.from(TABLE).update({ status: "pending", attempts: 0, error: null, updated_at: new Date().toISOString() }).eq("status", "failed");
  if (shipment_id) q = q.eq("shipment_id", String(shipment_id));
  if (audit_id) q = q.eq("audit_id", audit_id);
  const { data, error } = await q.select("id");
  if (error) return { retried: 0, error: error.message };
  return { retried: (data || []).length };
}

// ---------------------------------------------------------------------------
// Embeddings (the fpx-embed edge function: gte-small, 384 numbers)
// ---------------------------------------------------------------------------

// The embedding of one text as the string pgvector reads ("[0.1,...]"), or
// null when the function could not be reached.
export async function embedText(sb, text) {
  const t = String(text || "").trim();
  if (!t) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await sb.functions.invoke("fpx-embed", { body: { mode: "query", text: t } });
      if (!error && Array.isArray(data?.embedding) && data.embedding.length === 384) return JSON.stringify(data.embedding);
    } catch { /* try once more */ }
  }
  return null;
}

// The embedding of a search phrase (same string form) for the search function, or
// null when the text is an id or a single word (matched exactly instead) —
// same rule as queryEmbedding in browser-service/src/assistant.js.
export async function queryEmbedding(sb, text) {
  const t = String(text || "").trim();
  if (t.length < 6 || /^[\d\s-]+$/.test(t) || t.split(/\s+/).length < 2) return null;
  return embedText(sb, t);
}

// Embeds chunks saved without one (the function was down when the document
// was read). Returns how many it filled.
export async function embedMissingChunks(sb = supabase, { limit = 40 } = {}) {
  const { data, error } = await sb.from(CHUNKS).select("document_id, chunk_no, body").is("embedding", null).limit(limit);
  if (error || !data?.length) return 0;
  let filled = 0;
  for (const c of data) {
    const embedding = await embedText(sb, c.body);
    if (!embedding) break; // still down; the next sweep tries again
    const { error: upErr } = await sb.from(CHUNKS).update({ embedding }).eq("document_id", c.document_id).eq("chunk_no", c.chunk_no);
    if (!upErr) filled += 1;
  }
  return filled;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function logAnalysis(sb, claim, meta, { summary = null, error = null } = {}) {
  try {
    const { error: insErr } = await sb.from("fpx_ai_analyses").insert({
      kind: "invoice_ocr",
      invoice_audit_id: claim.audit_id,
      model: meta?.model || null,
      user_message: `${claim.audit_id}/${claim.file}`,
      response_text: summary,
      input_tokens: meta?.input_tokens ?? null,
      output_tokens: meta?.output_tokens ?? null,
      cost_usd: meta?.cost_usd ?? null,
      duration_ms: meta?.duration_ms ?? null,
      source: "railway",
      error,
      metadata: { document_id: claim.id, shipment_id: claim.shipment_id, file: claim.file, doc_type: claim.doc_type, stop_reason: meta?.stop_reason || null },
    });
    if (insErr) warnOnce("log", `Claude call not logged: ${insErr.message}`);
  } catch (e) {
    warnOnce("log", `Claude call not logged: ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// Log and live state (the "Reading invoices" page)
// ---------------------------------------------------------------------------
const LOG_TABLE = "fpx_invoice_doc_log";
// Writes one line of the reading log. Never throws: the log must not stop a read.
export async function logStep(sb, claim, step, message, { level = "info", ms = null, cost_usd = null } = {}) {
  try {
    const { error } = await sb.from(LOG_TABLE).insert({
      document_id: claim?.id || null, shipment_id: claim?.shipment_id || null, file: claim?.file || null,
      doc_type: claim?.doc_type || null, step, level, message: String(message).slice(0, 1000), ms, cost_usd,
    });
    if (error) warnOnce("doclog", `reading log not written: ${error.message}`);
  } catch (e) {
    warnOnce("doclog", `reading log not written: ${e?.message || e}`);
  }
}
// What this server is doing right now: the run, and each file being read.
const live = { run: null, reading: new Map() };
export function invoiceDocsState() {
  return {
    enabled: invoiceDocWorkerEnabled(),
    running: Boolean(running),
    run: live.run ? { ...live.run } : null,
    reading: [...live.reading.values()].map((r) => ({ ...r })),
  };
}
const fileName = (f) => String(f || "").replace(/^invoices\//, "");

// Reads one claimed row. Returns "done" | "unchanged" | "copied" | "failed".
// Never throws.
export async function processOne(sb, claim, { extract = extractDocument, embed = embedText } = {}) {
  const stamp = () => new Date().toISOString();
  const save = async (patch) => {
    const { error } = await sb.from(TABLE).update({ ...patch, updated_at: stamp() }).eq("id", claim.id);
    if (error) throw new Error(`Could not save: ${error.message}`);
  };
  let meta = null;
  const t0 = Date.now();
  const now = { id: claim.id, shipment_id: claim.shipment_id, file: claim.file, doc_type: claim.doc_type, step: "downloading", since: stamp() };
  live.reading.set(claim.id, now);
  const at = (step) => { now.step = step; now.since = stamp(); };
  await logStep(sb, claim, "started", `Reading ${fileName(claim.file)} (${claim.doc_type}) for shipment ${claim.shipment_id}${claim.attempts > 1 ? `, try ${claim.attempts}` : ""}`);
  try {
    const mime = mimeOf(claim.file);
    let blob = null;
    try {
      const { data, error } = await sb.storage.from(ERP_BUCKET).download(`${claim.audit_id}/${claim.file}`);
      if (!error) blob = data;
    } catch { /* handled below */ }
    if (!blob) throw new Error("Could not download the file from storage");
    const bytes = Buffer.from(await blob.arrayBuffer());
    const hash = sha256(bytes);
    await logStep(sb, claim, "downloaded", `Downloaded ${Math.round(bytes.length / 1024)} KB (${mime})`, { ms: Date.now() - t0 });

    // Same bytes as the last time it was read: nothing to do.
    if (claim.extracted_at && claim.content_sha256 === hash) {
      await save({ status: "done", error: null });
      await logStep(sb, claim, "unchanged", "Same file as last time it was read: kept the earlier reading, no Claude call", { level: "ok", ms: Date.now() - t0 });
      return "unchanged";
    }

    let row = null;
    let result = "done";
    // The same bytes read under another pull: copy that reading.
    const { data: twins } = await sb.from(TABLE)
      .select(`${EXTRACTED_COLS.join(", ")}, model`)
      .eq("content_sha256", hash).eq("status", "done").eq("doc_type", claim.doc_type).neq("id", claim.id)
      .not("extracted_at", "is", null).limit(1);
    if (twins?.length) {
      row = Object.fromEntries(EXTRACTED_COLS.map((c) => [c, twins[0][c] ?? null]));
      row.line_items = row.line_items || [];
      row.fields = row.fields || {};
      row.warnings = row.warnings || [];
      meta = { model: twins[0].model || null, input_tokens: 0, output_tokens: 0, cost_usd: 0, copied: true };
      result = "copied";
      await logStep(sb, claim, "copied", "The same file was already read under another pull: copied that reading, no Claude call", { level: "ok" });
    } else {
      at("reading");
      const tc = Date.now();
      await logStep(sb, claim, "sent", "Sent to Claude to read");
      const got = await extract({ bytes, mime, docType: claim.doc_type, shipmentId: claim.shipment_id });
      const { extraction, ...rest } = got;
      meta = rest;
      row = normalizeExtraction(extraction);
      const named = ["invoice_number", "invoice_date", "carrier", "tracking_number", "bol_number", "po_number", "total"].filter((c) => row[c] != null && row[c] !== "");
      const extra = Object.keys(row.fields || {}).length;
      const lines = (row.line_items || []).length;
      await logStep(sb, claim, "read",
        `Read by ${meta.model || "Claude"}: ${named.length ? named.map((c) => `${c.replace(/_/g, " ")} ${c === "total" ? `$${row[c]}` : row[c]}`).join(", ") : "no main fields found"}`
        + `; ${extra} other field${extra === 1 ? "" : "s"}, ${lines} line item${lines === 1 ? "" : "s"}`
        + `${row.confidence != null ? `; confidence ${Math.round(Number(row.confidence) * 100)}%` : ""}`
        + `${meta.input_tokens ? `; ${meta.input_tokens}+${meta.output_tokens} tokens` : ""}`,
        { level: named.length ? "ok" : "warn", ms: Date.now() - tc, cost_usd: meta.cost_usd ?? null });
      if (Array.isArray(row.warnings) && row.warnings.length) {
        await logStep(sb, claim, "read", `Claude noted: ${row.warnings.slice(0, 3).join(" · ")}`, { level: "warn" });
      }
    }

    await save({
      ...row, content_sha256: hash, bytes: bytes.length, mime,
      model: meta.model, input_tokens: meta.input_tokens, output_tokens: meta.output_tokens, cost_usd: meta.cost_usd,
      extracted_at: stamp(), error: null,
    });
    if (!meta.copied) await logAnalysis(sb, claim, meta, { summary: row.summary });

    // Chunks for search by meaning. A chunk the embed function could not do
    // is saved without one and filled in by the next sweep.
    at("embedding");
    const te = Date.now();
    const bodies = chunksForRow(row, { docType: claim.doc_type });
    const chunks = [];
    let embedDown = false;
    for (let i = 0; i < bodies.length; i++) {
      const embedding = embedDown ? null : await embed(sb, bodies[i]);
      if (!embedding) embedDown = true;
      chunks.push({ chunk_no: i, body: bodies[i], embedding });
    }
    const { error: chunkErr } = await sb.rpc("fpx_invoice_document_set_chunks", { p_document_id: claim.id, p_chunks: chunks });
    if (chunkErr) warnOnce("chunks", `search chunks not saved: ${chunkErr.message}`);
    const embedded = chunks.filter((c) => c.embedding).length;
    await logStep(sb, claim, "embedded",
      chunkErr ? `Search chunks not saved: ${chunkErr.message}` : `Split into ${chunks.length} search chunk${chunks.length === 1 ? "" : "s"}, ${embedded} embedded${embedded < chunks.length ? " (the rest are filled in by the next sweep)" : ""}`,
      { level: chunkErr ? "error" : embedded < chunks.length ? "warn" : "ok", ms: Date.now() - te });

    await save({ status: "done" });
    await logStep(sb, claim, "done", `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, { level: "ok", ms: Date.now() - t0, cost_usd: meta?.cost_usd ?? null });
    return result;
  } catch (e) {
    meta = meta || e?.meta || null;
    const message = String(e?.message || e).slice(0, 500);
    if (e?.meta) await logAnalysis(sb, claim, e.meta, { error: message });
    try {
      await sb.from(TABLE).update({
        status: "failed", error: message, updated_at: stamp(),
        // A file that would fail the same way again is not tried again.
        ...(e?.permanent ? { attempts: Math.max(MAX_ATTEMPTS, claim.attempts || 0) } : {}),
        ...(e?.meta ? { model: e.meta.model, input_tokens: e.meta.input_tokens, output_tokens: e.meta.output_tokens, cost_usd: e.meta.cost_usd } : {}),
      }).eq("id", claim.id);
    } catch { /* the claim times out and is taken again */ }
    await logStep(sb, claim, "failed", `Failed: ${message}${e?.permanent ? " (will not be tried again)" : (claim.attempts || 0) < MAX_ATTEMPTS ? " (will be tried again)" : " (no tries left)"}`,
      { level: "error", ms: Date.now() - t0, cost_usd: e?.meta?.cost_usd ?? null });
    return "failed";
  } finally {
    live.reading.delete(claim.id);
  }
}

// Reads up to `limit` waiting files, `concurrency` at a time. One file
// failing never stops the others. Returns { processed, done, unchanged,
// copied, failed } (and `error` when the queue itself could not be read).
export async function processPending({
  limit = 25, concurrency = 3, shipment_id = null, audit_id = null,
  sb = supabase, extract = extractDocument, embed = embedText,
} = {}) {
  const out = { processed: 0, done: 0, unchanged: 0, copied: 0, failed: 0 };
  const max = Math.max(1, Math.min(Number(limit) || 25, 5000));
  let taken = 0;
  let empty = false;
  const worker = async () => {
    while (!empty && taken < max) {
      taken += 1; // reserved before the await so workers never take more than max between them
      let claim = null;
      try {
        const { data, error } = await sb.rpc("fpx_invoice_documents_claim", {
          p_limit: 1, p_shipment_id: shipment_id, p_audit_id: audit_id, p_max_attempts: MAX_ATTEMPTS,
        });
        if (error) throw new Error(error.message);
        claim = (data || [])[0] || null;
      } catch (e) {
        out.error = String(e?.message || e);
        empty = true;
        return;
      }
      if (!claim) { empty = true; return; }
      const result = await processOne(sb, claim, { extract, embed });
      out.processed += 1;
      out[result] = (out[result] || 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 3, 8)) }, worker));
  if (out.error) warnOnce("claim", `queue not read: ${out.error}`);
  return out;
}

// Single flight: one run at a time in this process; a kick during a run
// makes it go round once more when it finishes.
let running = null;
let again = false;
export const invoiceDocsRunning = () => Boolean(running);

// Starts reading what is waiting, without waiting for it. Returns false when
// the worker is off (no Claude key, no database, or under `node --test`).
export function kickInvoiceDocs({ limit = 500, concurrency = 3 } = {}) {
  if (!invoiceDocWorkerEnabled()) return false;
  if (running) { again = true; return true; }
  running = (async () => {
    live.run = { started_at: new Date().toISOString(), processed: 0, done: 0, copied: 0, unchanged: 0, failed: 0 };
    try {
      do {
        again = false;
        const r = await processPending({ limit, concurrency });
        for (const k of ["processed", "done", "copied", "unchanged", "failed"]) live.run[k] += r[k] || 0;
        if (r.processed) console.log(`[FPX] invoice documents: read ${r.done}, copied ${r.copied}, unchanged ${r.unchanged}, failed ${r.failed}`);
      } while (again);
      if (live.run.processed) {
        const r = live.run;
        await logStep(supabase, null, "run",
          `Run finished: ${r.processed} file${r.processed === 1 ? "" : "s"} (${r.done} read, ${r.copied} copied, ${r.unchanged} unchanged, ${r.failed} failed) in ${Math.round((Date.now() - Date.parse(r.started_at)) / 1000)}s`,
          { level: r.failed ? "warn" : "ok", ms: Date.now() - Date.parse(r.started_at) });
      }
      await embedMissingChunks();
    } catch (e) {
      warnOnce("run", `worker stopped: ${e?.message || e}`);
    } finally {
      running = null;
      if (live.run) live.run = { ...live.run, finished_at: new Date().toISOString() };
    }
  })();
  return true;
}

// Call once from server/index.js. Reads anything left waiting shortly after
// start, then looks again every 5 minutes (retries, files queued while the
// server was down). Does nothing — and returns false — without
// ANTHROPIC_API_KEY, without a database, or under `node --test`.
let sweep = null;
export function startInvoiceDocWorker({ intervalMs = 5 * 60_000, firstRunMs = 20_000 } = {}) {
  if (!invoiceDocWorkerEnabled()) return false;
  if (sweep) return true;
  setTimeout(() => kickInvoiceDocs(), firstRunMs).unref();
  sweep = setInterval(() => kickInvoiceDocs(), intervalMs);
  sweep.unref();
  return true;
}
