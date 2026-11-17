import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  batchConfig, customIdFor, CUSTOM_ID_RE, batchEntry, entrySize, wouldOverflow, planGroups,
  parseResultLine, parseResults, jsonlLines, outcomeOf, batchCostUsd, batchPatchFrom,
  submitBatch, pollBatches, MAX_BATCH_BYTES,
} from "../lib/invoiceBatch.js";
import { buildRequest, costUsd, BATCH_DISCOUNT, EXTRACTION_SCHEMA, ExtractError } from "../lib/invoiceExtract.js";

process.env.INVOICE_OCR_DOC_TYPES = "all";

const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF");
const DOC_ID = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const MODEL_JSON = {
  invoice_number: "4471002938", invoice_date: "2026-11-03", carrier: "XPO", total: "$1,190.50", subtotal: "", line_items: [],
  fields: [], raw_text: "XPO INVOICE 4471002938 TOTAL DUE $1,190.50", summary: "XPO invoice 4471002938.", confidence: 0.9, warnings: [],
};
const message = (over = {}) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(MODEL_JSON) }],
  usage: { input_tokens: 4000, output_tokens: 2500 }, ...over,
});
const line = (custom_id, result) => JSON.stringify({ custom_id, result });

describe("settings", () => {
  it("defaults to batch every 60 minutes, 200 files; checks the numbers", () => {
    assert.deepEqual(batchConfig({}), { mode: "batch", everyMinutes: 60, maxDocs: 200 });
    assert.deepEqual(batchConfig({ "invoice_ocr.mode": "Direct", "invoice_ocr.batch_every_minutes": 1, "invoice_ocr.batch_max_docs": 0 }),
      { mode: "direct", everyMinutes: 5, maxDocs: 200 });
    assert.equal(batchConfig({ "invoice_ocr.mode": "nonsense" }).mode, "batch");
    assert.equal(batchConfig({ "invoice_ocr.batch_every_minutes": "30" }).everyMinutes, 30);
    assert.equal(batchConfig({ "invoice_ocr.batch_max_docs": 999999 }).maxDocs, 2000);
  });
});

describe("the request: one builder for both paths", () => {
  it("a batch request is the direct body without `fallbacks`", () => {
    const args = { model: "claude-opus-5-5", bytes: pdf, mime: "application/pdf", docType: "invoice", shipmentId: "15612931" };
    const direct = buildRequest(args);
    const entry = batchEntry({ docId: DOC_ID, ...args });
    assert.equal(direct.fallbacks, true);
    assert.equal(direct.body.fallbacks, "default");
    const { fallbacks: _f, ...rest } = direct.body;
    assert.deepEqual(entry.params, rest);
    assert.equal("fallbacks" in entry.params, false);
    assert.equal("stream" in entry.params, false);
    assert.deepEqual(entry.params.output_config.format, { type: "json_schema", schema: EXTRACTION_SCHEMA });
    assert.equal(entry.params.max_tokens, 16000);
    assert.equal(buildRequest({ ...args, batch: true }).fallbacks, false);
  });

  it("a file that cannot be sent fails for good before the batch", () => {
    assert.throws(() => batchEntry({ docId: DOC_ID, model: "claude-opus-5-5", bytes: Buffer.alloc(0), mime: "application/pdf" }),
      (e) => e instanceof ExtractError && e.permanent);
  });
});

describe("custom_id", () => {
  it("is the document id, which fits the API's rule (1-64 letters, digits, - and _)", () => {
    assert.equal(customIdFor(DOC_ID), DOC_ID);
    assert.ok(CUSTOM_ID_RE.test(DOC_ID));
    assert.equal(batchEntry({ docId: DOC_ID, model: "claude-haiku-5-5", bytes: pdf, mime: "application/pdf" }).custom_id, DOC_ID);
    for (const bad of ["", "a".repeat(65), "has space", "a/b", "x.y", null]) assert.throws(() => customIdFor(bad));
    assert.equal(customIdFor("a".repeat(64)).length, 64);
  });
});

describe("splitting by size", () => {
  it("groups in order and never passes the byte or count cap", () => {
    assert.deepEqual(planGroups([40, 40, 40, 10], { maxBytes: 100, maxCount: 10 }), [[0, 1], [2, 3]]);
    assert.deepEqual(planGroups([1, 1, 1, 1, 1], { maxBytes: 100, maxCount: 2 }), [[0, 1], [2, 3], [4]]);
    // One request bigger than the cap still goes, alone.
    assert.deepEqual(planGroups([150, 10], { maxBytes: 100 }), [[0], [1]]);
    assert.deepEqual(planGroups([]), []);
    assert.equal(wouldOverflow({ bytes: 0, count: 0 }, 10 ** 12), false);
  });

  it("the default cap stays well under the API's 256 MB, and a request's size is its JSON", () => {
    assert.ok(MAX_BATCH_BYTES <= 128 * 1024 * 1024);
    const entry = batchEntry({ docId: DOC_ID, model: "claude-opus-5-5", bytes: pdf, mime: "application/pdf" });
    assert.equal(entrySize(entry), Buffer.byteLength(JSON.stringify(entry)) + 1);
    // Base64 of the file is inside.
    assert.ok(entrySize(entry) > pdf.toString("base64").length);
  });
});

describe("results", () => {
  it("reads JSONL lines, skipping blanks and junk", () => {
    const text = [line(DOC_ID, { type: "succeeded", message: message() }), "", "not json", JSON.stringify({ nope: 1 }),
      line("b", { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad" } } })].join("\n");
    const got = parseResults(text);
    assert.deepEqual(got.map((r) => [r.docId, r.type]), [[DOC_ID, "succeeded"], ["b", "errored"]]);
    assert.equal(parseResultLine("   "), null);
  });

  it("streams lines split across chunks", async () => {
    const enc = new TextEncoder();
    const body = [enc.encode('{"custom_id":"a","res'), enc.encode('ult":{"type":"expired"}}\n{"custom_id":"b",'), enc.encode('"result":{"type":"canceled"}}')];
    const lines = [];
    for await (const l of jsonlLines(body)) lines.push(parseResultLine(l));
    assert.deepEqual(lines.map((r) => [r.docId, r.type]), [["a", "expired"], ["b", "canceled"]]);
  });

  it("a success is read like a direct answer, at half the cost", () => {
    const o = outcomeOf({ type: "succeeded", message: message() }, { model: "claude-opus-5-5" });
    assert.equal(o.ok, true);
    assert.equal(o.extraction.invoice_number, "4471002938");
    assert.equal(BATCH_DISCOUNT, 0.5);
    const full = costUsd("claude-opus-5-5", 4000, 2500); // $0.066
    assert.ok(Math.abs(o.meta.cost_usd - full / 2) < 1e-9);
    assert.ok(Math.abs(o.meta.cost_usd - 0.033) < 1e-9);
    assert.equal(o.meta.input_tokens, 4000);
  });

  it("failures: refusal and a refused request are for good; errors, expiry and cancel are retried", () => {
    const refusal = outcomeOf({ type: "succeeded", message: message({ stop_reason: "refusal", content: [] }) });
    assert.equal(refusal.ok, false);
    assert.equal(refusal.error.permanent, true);
    assert.ok(refusal.error.meta.cost_usd > 0);
    const invalid = outcomeOf({ type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad schema" } } });
    assert.equal(invalid.error.permanent, true);
    assert.match(invalid.error.message, /bad schema/);
    const sdkShape = outcomeOf({ type: "errored", error: { type: "invalid_request", message: "x" } });
    assert.equal(sdkShape.error.permanent, true);
    const server = outcomeOf({ type: "errored", error: { type: "error", error: { type: "api_error", message: "overloaded" } } });
    assert.equal(server.error.permanent, false);
    for (const type of ["expired", "canceled"]) {
      const o = outcomeOf({ type });
      assert.equal(o.ok, false);
      assert.equal(o.error.permanent, false);
    }
    assert.equal(outcomeOf(null).ok, false);
  });

  it("the batch's cost sums what was billed, once per result", () => {
    const outs = [
      outcomeOf({ type: "succeeded", message: message() }),
      outcomeOf({ type: "succeeded", message: message({ usage: { input_tokens: 1000, output_tokens: 0 } }) }),
      outcomeOf({ type: "expired" }),
    ];
    assert.equal(batchCostUsd(outs), Math.round((0.033 + 0.002) * 1e6) / 1e6);
    assert.equal(batchCostUsd([]), 0);
  });

  it("the batch's row from Claude's batch object", () => {
    const p = batchPatchFrom({ processing_status: "ended", request_counts: { processing: 0, succeeded: 3, errored: 1, expired: 0, canceled: 0 }, ended_at: "2026-11-17T10:00:00Z", expires_at: "x" });
    assert.deepEqual(p, { status: "ended", succeeded: 3, errored: 1, expired: 0, canceled: 0, ended_at: "2026-11-17T10:00:00Z", expires_at: "x" });
    assert.equal(batchPatchFrom({ processing_status: "in_progress" }).status, "in_progress");
  });
});

// ---------------------------------------------------------------------------
// The whole round trip with a stand-in database and a stand-in Claude.
// ---------------------------------------------------------------------------
function fakeWorld({ docs = [], files = {} } = {}) {
  const db = {
    fpx_invoice_documents: docs.map((d) => ({ attempts: 0, status: "pending", ocr_batch_id: null, ...d })),
    fpx_invoice_ocr_batches: [],
    fpx_invoice_doc_log: [],
    fpx_ai_analyses: [],
    chunks: [],
  };
  let n = 0;
  const query = (table) => {
    const q = { filters: [], op: "select", patch: null, max: Infinity, row: null, single: false, head: false };
    const rows = () => db[table].filter((r) => q.filters.every((f) => f(r)));
    const api = {
      select(_c, opts) { if (opts?.head) q.head = true; return api; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { q.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { q.filters.push((r) => (r[c] ?? null) === v); return api; },
      not(c, op, v) { if (op === "is") q.filters.push((r) => (r[c] ?? null) !== v); return api; },
      order() { return api; },
      limit(m) { q.max = m; return api; },
      single() { q.single = true; return api; },
      update(patch) { q.op = "update"; q.patch = patch; return api; },
      insert(row) {
        q.op = "insert";
        q.row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, created_at: new Date().toISOString(), succeeded: 0, errored: 0, expired: 0, canceled: 0, results_applied_at: null, ...row };
        db[table].push(q.row);
        return api;
      },
      then(resolve, reject) {
        let out;
        if (q.op === "insert") out = { data: q.single ? { ...q.row } : null, error: null };
        else if (q.op === "update") { for (const r of rows()) Object.assign(r, q.patch); out = { data: null, error: null }; }
        else if (q.head) out = { count: rows().length, error: null };
        else out = { data: rows().slice(0, q.max).map((r) => ({ ...r })), error: null };
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return api;
  };
  const sb = {
    from: query,
    storage: { from: () => ({ download: async (p) => (p in files ? { data: new Blob([files[p]]), error: null } : { data: null, error: { message: "nf" } }) }) },
    functions: { invoke: async () => ({ data: { embedding: Array(384).fill(0.01) }, error: null }) },
    rpc: async (name, args) => {
      if (name === "fpx_invoice_documents_claim") {
        const got = db.fpx_invoice_documents.filter((d) => d.status === "pending").slice(0, args.p_limit);
        for (const d of got) { d.status = "processing"; d.attempts += 1; d.ocr_batch_id = null; }
        return { data: got.map((d) => ({ ...d })), error: null };
      }
      if (name === "fpx_invoice_document_set_chunks") {
        db.chunks = db.chunks.filter((c) => c.document_id !== args.p_document_id).concat(args.p_chunks.map((c) => ({ document_id: args.p_document_id, ...c })));
        return { data: args.p_chunks.length, error: null };
      }
      return { data: null, error: { message: `no function ${name}` } };
    },
  };
  // Claude's batch endpoints.
  const claude = { created: [], status: "in_progress", results: null, gets: 0 };
  const fetchImpl = async (url, init = {}) => {
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      claude.created.push(body);
      return json({ id: `msgbatch_${claude.created.length}`, processing_status: "in_progress", request_counts: { processing: body.requests.length } });
    }
    if (/\/results$/.test(url)) {
      const enc = new TextEncoder();
      return { ok: true, status: 200, body: [enc.encode(claude.results)] };
    }
    claude.gets += 1;
    const id = url.split("/").pop();
    return json({ id, processing_status: claude.status, request_counts: { succeeded: 1, errored: 1 }, ended_at: claude.status === "ended" ? new Date().toISOString() : null, results_url: `https://api.anthropic.com/v1/messages/batches/${id}/results` });
  };
  return { sb, db, claude, fetchImpl };
}

describe("submit, then poll (stand-ins, no network)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const AUDIT = "3f2b6c1e-8a4d-4e0b-9c57-1d2e3f4a5b6c";
  const withKey = async (fn) => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try { return await fn(); } finally { if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before; }
  };

  it("sends what needs Claude, applies results once, and fails the errored file for a retry", async () => {
    const pdfB = Buffer.concat([pdf, Buffer.from("b")]);
    const w = fakeWorld({
      docs: [
        { id: A, shipment_id: "1", audit_id: AUDIT, file: "invoices/1-invoice.pdf", doc_type: "invoice" },
        { id: B, shipment_id: "2", audit_id: AUDIT, file: "invoices/2-invoice.pdf", doc_type: "invoice" },
        { id: C, shipment_id: "3", audit_id: AUDIT, file: "invoices/3-invoice.pdf", doc_type: "invoice" }, // missing file
      ],
      files: { [`${AUDIT}/invoices/1-invoice.pdf`]: pdf, [`${AUDIT}/invoices/2-invoice.pdf`]: pdfB },
    });
    const sent = await withKey(() => submitBatch({ sb: w.sb, fetchImpl: w.fetchImpl, modelOverride: "claude-opus-5-5", maxDocs: 10 }));
    assert.equal(sent.claimed, 3);
    assert.equal(sent.sent_docs, 2);
    assert.equal(sent.failed, 1);
    assert.equal(w.claude.created.length, 1);
    assert.deepEqual(w.claude.created[0].requests.map((r) => r.custom_id).sort(), [A, B]);
    assert.equal("fallbacks" in w.claude.created[0].requests[0].params, false);
    const batch = w.db.fpx_invoice_ocr_batches[0];
    assert.equal(batch.anthropic_batch_id, "msgbatch_1");
    assert.equal(batch.request_count, 2);
    const doc = (id) => w.db.fpx_invoice_documents.find((d) => d.id === id);
    assert.equal(doc(A).ocr_batch_id, batch.id);
    assert.equal(doc(A).status, "processing");
    assert.equal(doc(C).status, "failed");
    assert.ok(w.db.fpx_invoice_doc_log.some((l) => l.step === "submitted" && /batch of 2/.test(l.message)));
    assert.ok(w.db.fpx_invoice_doc_log.some((l) => l.step === "batched" && l.document_id === A));

    // Nothing more is waiting: a second send claims nothing and sends nothing.
    const again = await withKey(() => submitBatch({ sb: w.sb, fetchImpl: w.fetchImpl, modelOverride: "claude-opus-5-5", maxDocs: 10 }));
    assert.equal(again.claimed, 0);
    assert.equal(w.claude.created.length, 1);

    // Still with Claude: a waiting line, nothing saved.
    const p1 = await withKey(() => pollBatches({ sb: w.sb, fetchImpl: w.fetchImpl }));
    assert.equal(p1.still_open, 1);
    assert.ok(w.db.fpx_invoice_doc_log.some((l) => l.step === "waiting"));

    // Ended: A read, B errored.
    w.claude.status = "ended";
    w.claude.results = [
      line(B, { type: "errored", error: { type: "error", error: { type: "api_error", message: "overloaded" } } }),
      line(A, { type: "succeeded", message: message() }),
    ].join("\n");
    const p2 = await withKey(() => pollBatches({ sb: w.sb, fetchImpl: w.fetchImpl }));
    assert.deepEqual([p2.ended, p2.applied_docs, p2.failed_docs], [1, 1, 1]);
    assert.equal(doc(A).status, "done");
    assert.equal(doc(A).ocr_batch_id, null);
    assert.equal(doc(A).invoice_number, "4471002938");
    assert.ok(Math.abs(doc(A).cost_usd - 0.033) < 1e-9);
    assert.equal(doc(A).content_sha256.length, 64);
    assert.equal(doc(B).status, "failed");
    assert.equal(doc(B).ocr_batch_id, null);
    assert.ok(doc(B).attempts < 3);
    assert.ok(w.db.chunks.some((c) => c.document_id === A));
    assert.ok(batch.results_applied_at);
    assert.ok(Math.abs(Number(batch.cost_usd) - 0.033) < 1e-9);
    assert.equal(w.db.fpx_ai_analyses.length, 1);

    // A second check finds nothing open; saving again would change nothing.
    const p3 = await withKey(() => pollBatches({ sb: w.sb, fetchImpl: w.fetchImpl }));
    assert.equal(p3.checked, 0);
    batch.results_applied_at = null; // as if the server stopped before marking it
    await withKey(() => pollBatches({ sb: w.sb, fetchImpl: w.fetchImpl }));
    assert.equal(w.db.fpx_ai_analyses.length, 1);
    assert.ok(Math.abs(Number(batch.cost_usd) - 0.033) < 1e-9);
  });

  it("a batch Claude refuses gives the files back without using a try", async () => {
    const w = fakeWorld({
      docs: [{ id: A, shipment_id: "1", audit_id: AUDIT, file: "invoices/1-invoice.pdf", doc_type: "invoice" }],
      files: { [`${AUDIT}/invoices/1-invoice.pdf`]: pdf },
    });
    const refuse = async () => ({ ok: false, status: 429, text: async () => "rate limited", json: async () => ({}) });
    const r = await withKey(() => submitBatch({ sb: w.sb, fetchImpl: refuse, modelOverride: "claude-opus-5-5", maxDocs: 10 }));
    assert.equal(r.sent_docs, 0);
    assert.match(r.error, /429/);
    const d = w.db.fpx_invoice_documents[0];
    assert.deepEqual([d.status, d.attempts, d.ocr_batch_id], ["pending", 0, null]);
    assert.equal(w.db.fpx_invoice_ocr_batches[0].status, "failed");
  });

  it("a batch that never ends is given up after 25 hours and its files wait again", async () => {
    const w = fakeWorld({ docs: [{ id: A, shipment_id: "1", audit_id: AUDIT, file: "invoices/1-invoice.pdf", doc_type: "invoice", status: "processing", attempts: 1 }] });
    const old = new Date(Date.now() - 26 * 3600_000).toISOString();
    w.db.fpx_invoice_ocr_batches.push({ id: "b1", anthropic_batch_id: "msgbatch_x", status: "in_progress", request_count: 1, created_at: old, submitted_at: old, results_applied_at: null });
    w.db.fpx_invoice_documents[0].ocr_batch_id = "b1";
    const r = await withKey(() => pollBatches({ sb: w.sb, fetchImpl: w.fetchImpl }));
    assert.equal(r.checked, 1);
    assert.equal(w.db.fpx_invoice_ocr_batches[0].status, "failed");
    const d = w.db.fpx_invoice_documents[0];
    assert.deepEqual([d.status, d.ocr_batch_id], ["pending", null]);
  });

  it("splits into several batches when the requests would be too big together", async () => {
    const w = fakeWorld({
      docs: [A, B].map((id, i) => ({ id, shipment_id: String(i), audit_id: AUDIT, file: `invoices/${i}-invoice.pdf`, doc_type: "invoice" })),
      files: { [`${AUDIT}/invoices/0-invoice.pdf`]: pdf, [`${AUDIT}/invoices/1-invoice.pdf`]: Buffer.concat([pdf, Buffer.from("x")]) },
    });
    const r = await withKey(() => submitBatch({ sb: w.sb, fetchImpl: w.fetchImpl, modelOverride: "claude-opus-5-5", maxDocs: 10, limits: { maxBytes: 1000 } }));
    assert.equal(r.batches.length, 2);
    assert.equal(w.claude.created.length, 2);
    assert.equal(r.sent_docs, 2);
  });
});
