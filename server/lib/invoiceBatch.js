// Reading saved invoice files through Anthropic's Message Batches API
// (invoice_ocr.mode = "batch", the default): half the price of the direct
// call, results within 24 hours (most within the hour).
//
//   submitBatch()  claim what is waiting (fpx_invoice_documents_claim), download
//                  each file, settle the ones that need no Claude call (same
//                  bytes as before / a twin already read), and send the rest
//                  as one batch — several when the request would be too big.
//                  Each batch is a row of fpx_invoice_ocr_batches; each file
//                  sent carries its id in fpx_invoice_documents.ocr_batch_id
//                  and stays 'processing' until its result is saved.
//   pollBatches()  ask Claude about every batch not yet saved; when one has
//                  ended, read its results (one JSON line per file) and save
//                  each through the same steps as the direct read
//                  (normalise → save → chunks + embeddings → log).
//   batchTick()    the timer: a batch every invoice_ocr.batch_every_minutes,
//                  a check of open batches every 5 minutes.
//
// The request for a file is built by buildRequest() in lib/invoiceExtract.js,
// the same function the direct call uses (with batch: true, which only leaves
// out `fallbacks`; the Batches API refuses it).
//
// Batches API facts relied on (platform.claude.com/docs/en/build-with-claude/batch-processing):
//   * POST /v1/messages/batches { requests: [{ custom_id, params }] }; at most
//     100,000 requests or 256 MB per batch
//   * custom_id: 1-64 characters, letters, digits, "-" and "_"
//   * GET /v1/messages/batches/{id}: processing_status in_progress | canceling
//     | ended, request_counts, ended_at, expires_at, results_url
//   * results: JSON lines { custom_id, result: { type: succeeded | errored |
//     canceled | expired, message | error } }, in any order
//   * a batch not finished within 24 hours expires; results are kept 29 days
//   * every token costs 50% of the standard price
// Nothing here deletes a batch, a file or a document row.

import { supabase } from "./supabase.js";
import { getSettings } from "./settings.js";
import {
  buildRequest, readMessage, ExtractError, INVOICE_OCR_MODEL_KEY, ANTHROPIC_VERSION, BATCH_DISCOUNT,
} from "./invoiceExtract.js";
import {
  prepareDoc, rowFromExtraction, finishReading, failDoc, logStep, embedText, embedMissingChunks,
  invoiceDocWorkerEnabled, MAX_ATTEMPTS,
} from "./invoiceDocs.js";

const DOCS = "fpx_invoice_documents";
const BATCHES = "fpx_invoice_ocr_batches";
const API = "https://api.anthropic.com/v1/messages/batches";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const MODE_KEY = "invoice_ocr.mode";
export const EVERY_KEY = "invoice_ocr.batch_every_minutes";
export const MAX_DOCS_KEY = "invoice_ocr.batch_max_docs";
export const MODES = ["batch", "direct"];

// The settings, checked: mode "batch" unless it says "direct"; at least 5
// minutes between batches (at most a day); 1 to 2,000 files per run.
export function batchConfig(raw = {}) {
  const mode = String(raw[MODE_KEY] ?? "").trim().toLowerCase() === "direct" ? "direct" : "batch";
  const every = Number(raw[EVERY_KEY]);
  const max = Number(raw[MAX_DOCS_KEY]);
  return {
    mode,
    everyMinutes: Number.isFinite(every) ? Math.max(5, Math.min(1440, Math.round(every))) : 60,
    maxDocs: Number.isFinite(max) && max >= 1 ? Math.min(2000, Math.round(max)) : 200,
  };
}
export async function getBatchConfig() {
  try {
    return batchConfig(await getSettings(MODE_KEY, EVERY_KEY, MAX_DOCS_KEY));
  } catch {
    return batchConfig({});
  }
}

// ---------------------------------------------------------------------------
// Pure parts (tested in tests/invoiceBatch.test.js)
// ---------------------------------------------------------------------------

// The API's rule for custom_id. A document id (a uuid, 36 characters) is used as is.
export const CUSTOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function customIdFor(docId) {
  const id = String(docId ?? "");
  if (!CUSTOM_ID_RE.test(id)) throw new Error(`Document id "${id}" cannot be a batch custom_id`);
  return id;
}

// One request of a batch: the same body as the direct call, minus `fallbacks`.
// Throws ExtractError (permanent) when the file cannot be sent (too big, empty, ...).
export function batchEntry({ docId, model, bytes, mime, docType = "other", shipmentId = null }) {
  const { body } = buildRequest({ model, bytes, mime, docType, shipmentId, batch: true });
  return { custom_id: customIdFor(docId), params: body };
}

// Bytes one request adds to the batch's JSON body.
export const entrySize = (entry) => Buffer.byteLength(JSON.stringify(entry)) + 1;

// The API takes up to 256 MB or 100,000 requests; stay well under both (the
// whole body is also held in memory while it is sent).
export const MAX_BATCH_BYTES = 100 * 1024 * 1024;
export const MAX_BATCH_REQUESTS = 10_000;

// Whether one more request of `size` bytes would make the group too big. An
// empty group always takes it.
export function wouldOverflow({ bytes = 0, count = 0 }, size, { maxBytes = MAX_BATCH_BYTES, maxCount = MAX_BATCH_REQUESTS } = {}) {
  if (!count) return false;
  return count + 1 > maxCount || bytes + size > maxBytes;
}

// Splits requests (by their sizes) into batches, in order. Returns arrays of indexes.
export function planGroups(sizes, limits = {}) {
  const groups = [];
  let cur = { idx: [], bytes: 0, count: 0 };
  sizes.forEach((size, i) => {
    if (wouldOverflow(cur, size, limits)) {
      groups.push(cur.idx);
      cur = { idx: [], bytes: 0, count: 0 };
    }
    cur.idx.push(i);
    cur.bytes += size;
    cur.count += 1;
  });
  if (cur.count) groups.push(cur.idx);
  return groups;
}

// One line of the results file → { docId, type, message, error } or null
// when the line is blank or not a result.
export function parseResultLine(line) {
  const t = String(line || "").trim();
  if (!t) return null;
  let j;
  try { j = JSON.parse(t); } catch { return null; }
  if (!j || typeof j.custom_id !== "string" || !j.result || typeof j.result.type !== "string") return null;
  return { docId: j.custom_id, type: j.result.type, message: j.result.message || null, error: j.result.error || null };
}

// Every result in a JSONL text (for tests and small files).
export const parseResults = (text) => String(text || "").split("\n").map(parseResultLine).filter(Boolean);

// The lines of a streamed body (a web ReadableStream or a Node stream), one at a time.
export async function* jsonlLines(body) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of body) {
    rest += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  rest += decoder.decode();
  if (rest.trim()) yield rest;
}

// What one result means for its document:
//   { ok: true, extraction, meta }   save it (meta.cost_usd at the batch price)
//   { ok: false, error }             an ExtractError (permanent: do not retry)
export function outcomeOf(result, { model = null, durationMs = null } = {}) {
  if (!result) return { ok: false, error: new ExtractError("No result came back for this file") };
  if (result.type === "succeeded") {
    try {
      const { extraction, ...meta } = readMessage(result.message, { model, durationMs, discount: BATCH_DISCOUNT });
      return { ok: true, extraction, meta };
    } catch (e) {
      return { ok: false, error: e instanceof ExtractError ? e : new ExtractError(String(e?.message || e)) };
    }
  }
  if (result.type === "errored") {
    const err = result.error || {};
    const kind = String(err.error?.type || err.type || "");
    const msg = String(err.error?.message || err.message || kind || "error");
    // A request the API refused would be refused again; anything else may pass next time.
    return { ok: false, error: new ExtractError(`Claude could not read it in the batch: ${msg}`.slice(0, 400), { permanent: /invalid_request/.test(kind) }) };
  }
  if (result.type === "expired") return { ok: false, error: new ExtractError("Claude did not get to it within 24 hours (the batch expired); it goes in the next batch") };
  if (result.type === "canceled") return { ok: false, error: new ExtractError("The batch was canceled before this file was read; it goes in the next batch") };
  return { ok: false, error: new ExtractError(`Unknown batch result "${result.type}"`) };
}

// What a batch's succeeded results cost, at the batch price.
export function batchCostUsd(outcomes) {
  const sum = (outcomes || []).reduce((s, o) => s + (Number(o?.meta?.cost_usd ?? o?.error?.meta?.cost_usd) || 0), 0);
  return Math.round(sum * 1e6) / 1e6;
}

// The batch row's fields from the API's batch object.
export function batchPatchFrom(api) {
  const c = api?.request_counts || {};
  return {
    status: api?.processing_status === "ended" ? "ended" : api?.processing_status === "canceling" ? "canceling" : "in_progress",
    succeeded: c.succeeded || 0, errored: c.errored || 0, expired: c.expired || 0, canceled: c.canceled || 0,
    ended_at: api?.ended_at || null,
    expires_at: api?.expires_at || null,
  };
}

// A batch sent more than this long ago that has not ended is given up on.
export const STUCK_AFTER_MS = 25 * 60 * 60_000;
// A batch row that never got a Claude batch id this long after it was made.
export const SENDING_STUCK_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function headers(json = true) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ExtractError("ANTHROPIC_API_KEY not configured");
  return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, ...(json ? { "Content-Type": "application/json" } : {}) };
}
async function apiError(resp, what) {
  const text = await resp.text().catch(() => "");
  return Object.assign(new Error(`${what}: Claude API ${resp.status} ${text.slice(0, 300)}`), { status: resp.status });
}
export async function createBatch(requests, { fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(API, {
    method: "POST", headers: headers(), body: JSON.stringify({ requests }), signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!resp.ok) throw await apiError(resp, "Batch not accepted");
  return resp.json();
}
export async function getBatch(id, { fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(`${API}/${encodeURIComponent(id)}`, { headers: headers(false), signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw await apiError(resp, "Batch not found");
  return resp.json();
}
export async function openResults(api, { fetchImpl = fetch } = {}) {
  const url = api?.results_url || `${API}/${encodeURIComponent(api.id)}/results`;
  const resp = await fetchImpl(url, { headers: headers(false), signal: AbortSignal.timeout(15 * 60_000) });
  if (!resp.ok) throw await apiError(resp, "Results not available");
  return resp.body;
}

// ---------------------------------------------------------------------------
// Database steps
// ---------------------------------------------------------------------------

const stamp = () => new Date().toISOString();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortId = (id) => (id ? String(id) : "?");

// Gives claimed documents back to the queue (they were never read).
// undoAttempt: the try is not counted (the batch never reached Claude).
async function releaseDocs(sb, docs, reason, { undoAttempt = false } = {}) {
  for (const d of docs) {
    const patch = {
      status: "pending", error: reason, updated_at: stamp(),
      ...(undoAttempt ? { attempts: Math.max(0, (d.attempts || 1) - 1) } : {}),
    };
    try {
      const { error } = await sb.from(DOCS).update({ ...patch, ocr_batch_id: null }).eq("id", d.id);
      // Before the migration there is no ocr_batch_id column: give it back all the same.
      if (error && /ocr_batch_id/.test(error.message || "")) await sb.from(DOCS).update(patch).eq("id", d.id);
    } catch { /* the next poll finds it again */ }
  }
}

async function markBatchFailed(sb, row, reason) {
  await sb.from(BATCHES).update({ status: "failed", error: String(reason).slice(0, 1000), ended_at: row.ended_at || stamp() }).eq("id", row.id);
}

// Single flight: one submit or poll at a time in this process.
let busy = null;
export const batchBusy = () => Boolean(busy);
async function single(fn) {
  if (busy) return { busy: true };
  busy = fn();
  try { return await busy; } finally { busy = null; }
}

// Sends what is waiting. Returns { claimed, unchanged, copied, failed,
// sent_docs, batches: [{ id, anthropic_batch_id, request_count }] } plus
// `error` when the queue or Claude could not be reached, or { busy: true }.
export function submitBatch(opts = {}) {
  return single(() => submitBatchNow(opts));
}
async function submitBatchNow({ sb = supabase, fetchImpl = fetch, embed = embedText, maxDocs = null, modelOverride = null, limits = {} } = {}) {
  const cfg = await getBatchConfig();
  const max = Math.max(1, Number(maxDocs) || cfg.maxDocs);
  const model = modelOverride || (await getSettings(INVOICE_OCR_MODEL_KEY))[INVOICE_OCR_MODEL_KEY];
  const out = { claimed: 0, unchanged: 0, copied: 0, failed: 0, sent_docs: 0, batches: [] };
  let group = { items: [], bytes: 0, count: 0 };
  let stop = false; // a batch could not be stored or sent: give the rest back

  const send = async () => {
    const items = group.items;
    group = { items: [], bytes: 0, count: 0 };
    if (!items.length) return;
    const docs = items.map((i) => i.claim);
    if (stop) return releaseDocs(sb, docs, null, { undoAttempt: true });

    const { data: row, error: insErr } = await sb.from(BATCHES).insert({
      status: "sending", model, request_count: items.length,
      bytes_sent: items.reduce((s, i) => s + i.size, 0),
      requests: items.map((i) => ({ document_id: i.claim.id, sha256: i.hash, bytes: i.bytes, mime: i.mime })),
    }).select("id, created_at").single();
    if (insErr || !row) {
      stop = true;
      out.error = `Batch not stored: ${insErr?.message || "no row"}`;
      await releaseDocs(sb, docs, null, { undoAttempt: true });
      await logStep(sb, null, "failed", `Could not record a batch (${insErr?.message || "no row"}); ${plural(docs.length, "file")} went back to wait`, { level: "error" });
      return;
    }
    // The files now belong to this batch: the claim function will not hand them out again.
    for (const d of docs) {
      const { error } = await sb.from(DOCS).update({ ocr_batch_id: row.id, updated_at: stamp() }).eq("id", d.id);
      if (error) warn(`ocr_batch_id not set: ${error.message}`);
    }
    for (const i of items) {
      await logStep(sb, i.claim, "batched", `Added to a batch of ${items.length} (${Math.round(i.bytes / 1024)} KB), read at half price; results within 24 hours`);
    }
    let api;
    try {
      api = await createBatch(items.map((i) => i.entry), { fetchImpl });
    } catch (e) {
      stop = true;
      const reason = String(e?.message || e).slice(0, 500);
      out.error = reason;
      await markBatchFailed(sb, row, reason);
      await releaseDocs(sb, docs, null, { undoAttempt: true });
      await logStep(sb, null, "failed", `Batch of ${items.length} not sent: ${reason}. The files went back to wait.`, { level: "error" });
      return;
    }
    await sb.from(BATCHES).update({
      anthropic_batch_id: api.id, submitted_at: stamp(), ...batchPatchFrom(api),
    }).eq("id", row.id);
    out.sent_docs += items.length;
    out.batches.push({ id: row.id, anthropic_batch_id: api.id, request_count: items.length });
    await logStep(sb, null, "submitted", `Sent batch of ${items.length} to Claude (batch id ${api.id}); results within 24 hours, most within the hour`, { level: "ok" });
  };

  while (out.claimed < max && !stop) {
    let claims;
    try {
      const { data, error } = await sb.rpc("fpx_invoice_documents_claim", {
        p_limit: Math.min(50, max - out.claimed), p_shipment_id: null, p_audit_id: null, p_max_attempts: MAX_ATTEMPTS,
      });
      if (error) throw new Error(error.message);
      claims = data || [];
    } catch (e) {
      out.error = `Queue not read: ${e?.message || e}`;
      break;
    }
    if (!claims.length) break;
    out.claimed += claims.length;
    for (const claim of claims) {
      if (stop) { await releaseDocs(sb, [claim], null, { undoAttempt: true }); continue; }
      const t0 = Date.now();
      try {
        const prep = await prepareDoc(sb, claim, { t0 });
        if (prep.result === "unchanged") { out.unchanged += 1; continue; }
        if (prep.result === "copied") {
          await finishReading(sb, claim, { row: prep.row, meta: prep.meta, hash: prep.hash, size: prep.bytes.length, mime: prep.mime, t0, embed });
          out.copied += 1;
          continue;
        }
        const entry = batchEntry({ docId: claim.id, model, bytes: prep.bytes, mime: prep.mime, docType: claim.doc_type, shipmentId: claim.shipment_id });
        const size = entrySize(entry);
        if (wouldOverflow(group, size, limits)) await send();
        group.items.push({ claim, entry, size, hash: prep.hash, bytes: prep.bytes.length, mime: prep.mime });
        group.bytes += size;
        group.count += 1;
      } catch (e) {
        await failDoc(sb, claim, e, { t0 });
        out.failed += 1;
      }
    }
  }
  await send();
  return out;
}

let warnedAt = 0;
function warn(message) {
  if (Date.now() - warnedAt < 10 * 60_000) return;
  warnedAt = Date.now();
  console.warn(`[FPX] invoice batches: ${message}`);
}

const DOC_FIELDS = "id, shipment_id, audit_id, file, doc_type, attempts, status, ocr_batch_id, content_sha256, extracted_at";

// Saves the results of one ended batch. Only documents still marked with this
// batch are touched, and each is unmarked as it is saved, so running this
// twice saves nothing twice. Returns { applied, failed }.
async function applyResults(sb, row, api, { fetchImpl, embed }) {
  const { data: docs, error } = await sb.from(DOCS).select(DOC_FIELDS).eq("ocr_batch_id", row.id).limit(20_000);
  if (error) throw new Error(`Documents of the batch not read: ${error.message}`);
  const open = new Map((docs || []).map((d) => [d.id, d]));
  const sent = new Map((Array.isArray(row.requests) ? row.requests : []).map((r) => [r.document_id, r]));
  const durationMs = row.submitted_at && api.ended_at ? Date.parse(api.ended_at) - Date.parse(row.submitted_at) : null;
  const outcomes = [];
  let applied = 0;
  let failed = 0;
  const unmark = { ocr_batch_id: null };

  const body = await openResults(api, { fetchImpl });
  for await (const line of jsonlLines(body)) {
    const result = parseResultLine(line);
    if (!result) continue;
    const outcome = outcomeOf(result, { model: row.model, durationMs });
    outcomes.push(outcome);
    const doc = open.get(result.docId);
    if (!doc) continue; // saved by an earlier check, or not ours
    open.delete(result.docId);
    const t0 = Date.now();
    const req = sent.get(doc.id) || {};
    if (!outcome.ok) {
      await failDoc(sb, doc, outcome.error, { t0, patch: unmark });
      failed += 1;
      continue;
    }
    try {
      const rowData = await rowFromExtraction(sb, doc, outcome.extraction, outcome.meta, { ms: durationMs, via: ` (batch ${shortId(row.anthropic_batch_id)})` });
      await finishReading(sb, doc, {
        row: rowData, meta: outcome.meta, hash: req.sha256 || null, size: req.bytes ?? null, mime: req.mime || null, t0, embed, patch: unmark,
      });
      applied += 1;
    } catch (e) {
      await failDoc(sb, doc, e, { t0, patch: unmark });
      failed += 1;
    }
  }
  // Sent but no line came back (should not happen): wait again via the retry rules.
  for (const doc of open.values()) {
    await failDoc(sb, doc, new ExtractError("No result came back for this file in the batch"), { patch: unmark });
    failed += 1;
  }
  const cost = batchCostUsd(outcomes);
  await sb.from(BATCHES).update({ ...batchPatchFrom(api), status: "ended", results_applied_at: stamp(), cost_usd: cost }).eq("id", row.id);
  await logStep(sb, null, "done",
    `Batch ${shortId(row.anthropic_batch_id)} finished: ${applied} read and saved, ${failed} failed; cost $${cost.toFixed(4)} (half price)`,
    { level: failed ? "warn" : "ok", ms: durationMs, cost_usd: cost });
  return { applied, failed };
}

// Checks every batch not yet saved. Returns { checked, ended, applied_docs,
// failed_docs, still_open } (+ error), or { busy: true }.
export function pollBatches(opts = {}) {
  return single(() => pollBatchesNow(opts));
}
async function pollBatchesNow({ sb = supabase, fetchImpl = fetch, embed = embedText, now = Date.now() } = {}) {
  const out = { checked: 0, ended: 0, applied_docs: 0, failed_docs: 0, still_open: 0 };
  const { data: rows, error } = await sb.from(BATCHES).select("*")
    .is("results_applied_at", null).neq("status", "failed").order("created_at", { ascending: true }).limit(50);
  if (error) return { ...out, error: error.message };
  for (const row of rows || []) {
    out.checked += 1;
    const docsOf = async () => (await sb.from(DOCS).select(DOC_FIELDS).eq("ocr_batch_id", row.id).limit(20_000)).data || [];
    try {
      if (!row.anthropic_batch_id) {
        // Still being sent by this server, or the server stopped while sending.
        if (now - Date.parse(row.created_at) > SENDING_STUCK_MS) {
          await markBatchFailed(sb, row, "Never reached Claude (the server stopped while sending)");
          const docs = await docsOf();
          await releaseDocs(sb, docs, null, { undoAttempt: true });
          await logStep(sb, null, "failed", `A batch that never reached Claude was given up; ${plural(docs.length, "file")} went back to wait`, { level: "warn" });
        } else out.still_open += 1;
        continue;
      }
      let api;
      try {
        api = await getBatch(row.anthropic_batch_id, { fetchImpl });
      } catch (e) {
        if (e?.status === 404) {
          await markBatchFailed(sb, row, "Claude no longer knows this batch");
          const docs = await docsOf();
          await releaseDocs(sb, docs, "The batch was lost; read again in the next batch");
          await logStep(sb, null, "failed", `Batch ${row.anthropic_batch_id} is gone at Claude; ${plural(docs.length, "file")} went back to wait`, { level: "error" });
          continue;
        }
        throw e;
      }
      const patch = batchPatchFrom(api);
      if (api.processing_status !== "ended") {
        const sentAt = Date.parse(row.submitted_at || row.created_at);
        if (now - sentAt > STUCK_AFTER_MS) {
          await markBatchFailed(sb, row, "Not finished after 25 hours");
          const docs = await docsOf();
          await releaseDocs(sb, docs, "The batch did not finish within 25 hours; read again in the next batch");
          await logStep(sb, null, "failed", `Batch ${row.anthropic_batch_id} did not finish after 25 hours; ${plural(docs.length, "file")} went back to wait`, { level: "error" });
          continue;
        }
        const doneNow = patch.succeeded + patch.errored + patch.expired + patch.canceled;
        const doneBefore = (row.succeeded || 0) + (row.errored || 0) + (row.expired || 0) + (row.canceled || 0);
        await sb.from(BATCHES).update({ ...patch, checked_at: new Date(now).toISOString() }).eq("id", row.id);
        // One line the first time and whenever more files are done (not every 5 minutes).
        if (doneNow !== doneBefore || !row.checked_at) {
          await logStep(sb, null, "waiting",
            `Batch ${row.anthropic_batch_id} is with Claude: ${doneNow} of ${row.request_count} done, sent ${Math.round((now - sentAt) / 60_000)} min ago`);
        }
        out.still_open += 1;
        continue;
      }
      await sb.from(BATCHES).update({ ...patch, status: "ended" }).eq("id", row.id);
      const r = await applyResults(sb, { ...row, ...patch }, api, { fetchImpl, embed });
      out.ended += 1;
      out.applied_docs += r.applied;
      out.failed_docs += r.failed;
    } catch (e) {
      // Left as it is: the next check tries again.
      out.error = String(e?.message || e).slice(0, 500);
      out.still_open += 1;
      warn(`batch ${row.anthropic_batch_id || row.id} not checked: ${out.error}`);
    }
  }
  // Chunks saved while the embed function was down (the direct sweep does this in direct mode).
  await embedMissingChunks(sb).catch(() => 0);
  return out;
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

const schedule = { nextSubmitAt: null, lastPollAt: 0 };
export const POLL_EVERY_MS = 5 * 60_000;

// When the next batch goes, for the dashboard (null in direct mode).
export function batchState() {
  return { busy: batchBusy(), next_submit_at: schedule.nextSubmitAt ? new Date(schedule.nextSubmitAt).toISOString() : null };
}
// After "Send batch now": the timer starts again from now.
export function resetBatchTimer(everyMinutes, now = Date.now()) {
  schedule.nextSubmitAt = now + everyMinutes * 60_000;
}

// Batches that are open (sent, results not saved yet), or null when unknown.
export async function countOpenBatches(sb = supabase) {
  const { count, error } = await sb.from(BATCHES).select("id", { count: "exact", head: true })
    .is("results_applied_at", null).neq("status", "failed");
  return error ? null : count || 0;
}

// Called every minute by startInvoiceDocWorker (lib/invoiceDocs.js). Open
// batches are checked every 5 minutes in either mode (switching to direct
// must not strand a batch); in batch mode what is waiting is sent every
// invoice_ocr.batch_every_minutes. The first time, the next batch is due
// `every` minutes after the last one recorded, so a restart does not reset
// the clock.
export async function batchTick({ now = Date.now(), sb = supabase } = {}) {
  if (!invoiceDocWorkerEnabled()) return;
  const cfg = await getBatchConfig();
  if (now - schedule.lastPollAt >= POLL_EVERY_MS - 1000) {
    schedule.lastPollAt = now;
    const r = await pollBatches();
    if (r.error) warn(`check: ${r.error}`);
  }
  if (cfg.mode !== "batch") { schedule.nextSubmitAt = null; return; }
  if (schedule.nextSubmitAt == null) {
    const { data } = await sb.from(BATCHES).select("created_at").order("created_at", { ascending: false }).limit(1);
    const last = data?.[0]?.created_at ? Date.parse(data[0].created_at) : 0;
    schedule.nextSubmitAt = last ? last + cfg.everyMinutes * 60_000 : now;
  }
  if (now < schedule.nextSubmitAt) return;
  const r = await submitBatch();
  if (r.busy) return; // a check is running; try on the next tick
  schedule.nextSubmitAt = now + cfg.everyMinutes * 60_000;
  if (r.error) warn(`send: ${r.error}`);
  if (r.claimed) console.log(`[FPX] invoice batches: sent ${r.sent_docs} in ${r.batches.length} batch(es); ${r.unchanged} unchanged, ${r.copied} copied, ${r.failed} failed`);
}
