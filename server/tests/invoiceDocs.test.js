import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  queuePlan, queueInvoiceDocuments, backfillFromRecords, retryFailed, processOne, processPending,
  kickInvoiceDocs, startInvoiceDocWorker, invoiceDocWorkerEnabled, queryEmbedding, MAX_ATTEMPTS,
} from "../lib/invoiceDocs.js";
import { sha256, ExtractError } from "../lib/invoiceExtract.js";
import { likeTerm, DOC_COLS } from "../routes/invoiceDocs.js";

// These tests cover the reading rules with every kind of document read.
process.env.INVOICE_OCR_DOC_TYPES = "all";

const AUDIT = "3f2b6c1e-8a4d-4e0b-9c57-1d2e3f4a5b6c";
const PDF = "invoices/15612931-invoice.pdf";
const PNG = "invoices/15612931-1.png";
const VIEW = "invoices/15612931-view-1.png";

// A stand-in for the Supabase client: tables in memory, and only the calls
// lib/invoiceDocs.js makes.
function fakeDb({ docs = [], records = [], files = {}, embedOk = true } = {}) {
  const db = {
    fpx_invoice_documents: docs.map((d, i) => ({ id: `doc-${i + 1}`, attempts: 0, status: "pending", ...d })),
    fpx_shipment_records: records,
    fpx_invoice_document_chunks: [],
    fpx_ai_analyses: [],
  };
  const calls = { downloads: [], embeds: 0, claims: 0 };
  let nextId = db.fpx_invoice_documents.length;
  const query = (table) => {
    const q = { filters: [], op: "select", patch: null, max: Infinity, returning: false };
    const rows = () => db[table].filter((r) => q.filters.every((f) => f(r)));
    const api = {
      select() { if (q.op !== "select") q.returning = true; return api; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { q.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { q.filters.push((r) => (r[c] ?? null) === v); return api; },
      not(c, op, v) {
        if (op === "is") q.filters.push((r) => (r[c] ?? null) !== v);
        else if (op === "eq" && v === "{}") q.filters.push((r) => (r[c] || []).length > 0);
        return api;
      },
      order() { return api; },
      limit(n) { q.max = n; return api; },
      range(a, b) { q.from = a; q.max = b - a + 1; return api; },
      update(patch) { q.op = "update"; q.patch = patch; return api; },
      insert(row) { db[table].push(row); return Promise.resolve({ error: null }); },
      upsert(list) {
        for (const r of list) {
          if (db[table].some((x) => x.audit_id === r.audit_id && x.file === r.file)) continue; // ignoreDuplicates
          db[table].push({ id: `doc-${++nextId}`, attempts: 0, ...r });
        }
        return Promise.resolve({ error: null });
      },
      then(resolve, reject) {
        let out;
        if (q.op === "update") {
          const hit = rows();
          for (const r of hit) Object.assign(r, q.patch);
          out = { data: q.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        } else {
          out = { data: rows().slice(q.from || 0, (q.from || 0) + q.max).map((r) => ({ ...r })), error: null };
        }
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return api;
  };
  const sb = {
    from: query,
    storage: { from: () => ({ download: async (path) => {
      calls.downloads.push(path);
      return path in files ? { data: new Blob([files[path]]), error: null } : { data: null, error: { message: "not found" } };
    } }) },
    functions: { invoke: async () => {
      calls.embeds += 1;
      return embedOk ? { data: { embedding: Array(384).fill(0.01) }, error: null } : { data: null, error: { message: "down" } };
    } },
    rpc: async (name, args) => {
      if (name === "fpx_invoice_documents_claim") {
        calls.claims += 1;
        // The real function also takes failed rows again, after a pause; within one run that is never.
        const r = db.fpx_invoice_documents.find((d) => d.status === "pending");
        if (!r) return { data: [], error: null };
        r.status = "processing"; r.attempts += 1;
        return { data: [{ ...r }], error: null };
      }
      if (name === "fpx_invoice_document_set_chunks") {
        db.fpx_invoice_document_chunks = db.fpx_invoice_document_chunks.filter((c) => c.document_id !== args.p_document_id)
          .concat(args.p_chunks.map((c) => ({ document_id: args.p_document_id, ...c })));
        return { data: args.p_chunks.length, error: null };
      }
      return { data: null, error: { message: `no function ${name}` } };
    },
  };
  return { sb, db, calls };
}

const MODEL_JSON = {
  invoice_number: "4471002938", invoice_date: "2026-11-03", carrier: "XPO", total: "$1,190.50", subtotal: "", line_items: [],
  fields: [{ label: "Pickup Date", value: "10/29/2026" }], raw_text: "XPO INVOICE 4471002938 TOTAL DUE $1,190.50",
  summary: "XPO invoice 4471002938, total $1,190.50.", confidence: 0.9, warnings: [],
};
const okExtract = (seen = []) => async (args) => {
  seen.push(args);
  return { extraction: MODEL_JSON, model: "claude-opus-5-5", input_tokens: 4000, output_tokens: 2500, cost_usd: 0.066, stop_reason: "end_turn", duration_ms: 5 };
};

describe("queuePlan", () => {
  const capture = { shipment_id: "15612931", audit_id: AUDIT, files: [PNG, PDF, VIEW] };

  it("a first capture: PDFs and lone pictures wait, the picture of a PDF is recorded as skipped", () => {
    const { inserts, updates } = queuePlan(capture, []);
    assert.deepEqual(updates, []);
    assert.deepEqual(inserts.map((r) => [r.file, r.doc_type, r.status]), [
      [PNG, "invoice", "skipped"], [PDF, "invoice", "pending"], [VIEW, "shipment_details", "pending"],
    ]);
    assert.match(inserts[0].error, /PDF of the same document/);
    assert.equal(inserts[1].error, null);
    assert.equal(inserts[1].mime, "application/pdf");
    assert.equal(inserts[1].shipment_id, "15612931");
    assert.equal(inserts[1].audit_id, AUDIT);
  });

  it("a new capture of files read before: they wait again to be compared, not duplicated", () => {
    const existing = [{ id: "a", file: PDF, status: "done" }, { id: "b", file: PNG, status: "skipped" }, { id: "c", file: VIEW, status: "processing" }];
    const { inserts, updates } = queuePlan(capture, existing);
    assert.deepEqual(inserts, []);
    assert.deepEqual(updates.map((u) => [u.id, u.patch.status, u.patch.attempts]), [["a", "pending", 0]]);
  });

  it("a backfill leaves rows that are there alone", () => {
    const existing = [{ id: "a", file: PDF, status: "done" }, { id: "c", file: VIEW, status: "failed" }];
    const { inserts, updates } = queuePlan(capture, existing, { recheck: false });
    assert.deepEqual(inserts.map((r) => r.file), [PNG]);
    assert.deepEqual(updates, []);
  });

  it("a picture that was waiting is skipped once its PDF arrives, and one already read is kept", () => {
    const waiting = queuePlan({ ...capture, files: [PDF] }, [{ id: "p", file: PNG, status: "pending" }]);
    assert.deepEqual(waiting.inserts.map((r) => r.file), [PDF]);
    const again = queuePlan({ ...capture, files: [PNG, PDF] }, [{ id: "p", file: PNG, status: "pending" }]);
    assert.deepEqual(again.updates.map((u) => [u.id, u.patch.status]), [["p", "skipped"]]);
    const read = queuePlan({ ...capture, files: [PNG, PDF] }, [{ id: "p", file: PNG, status: "done" }]);
    assert.deepEqual(read.updates, []);
  });

  it("a skipped picture whose PDF is not there is read", () => {
    const { updates } = queuePlan({ ...capture, files: [PNG] }, [{ id: "p", file: PNG, status: "skipped" }]);
    assert.deepEqual(updates.map((u) => u.patch.status), ["pending"]);
  });
});

describe("queueInvoiceDocuments", () => {
  it("writes one row per file and is safe to call twice", async () => {
    const { sb, db } = fakeDb();
    const capture = { shipment_id: 15612931, audit_id: AUDIT, files: [PNG, PDF, VIEW, PDF] };
    assert.deepEqual(await queueInvoiceDocuments(sb, capture), { queued: 2, skipped: 1, requeued: 0 });
    assert.deepEqual(await queueInvoiceDocuments(sb, capture), { queued: 0, skipped: 0, requeued: 0 });
    assert.deepEqual(db.fpx_invoice_documents.map((d) => [d.file, d.status, d.shipment_id]), [
      [PNG, "skipped", "15612931"], [PDF, "pending", "15612931"], [VIEW, "pending", "15612931"],
    ]);
  });

  it("does nothing without a shipment, an audit or files", async () => {
    const { sb, db } = fakeDb();
    for (const bad of [undefined, {}, { shipment_id: "1", audit_id: "nope", files: [PDF] }, { shipment_id: "", audit_id: AUDIT, files: [PDF] }, { shipment_id: "1", audit_id: AUDIT, files: [] }]) {
      assert.deepEqual(await queueInvoiceDocuments(sb, bad), { queued: 0, skipped: 0, requeued: 0 });
    }
    assert.equal(db.fpx_invoice_documents.length, 0);
  });

  it("never throws: a database problem comes back as { error }", async () => {
    const quiet = console.warn; console.warn = () => {};
    try {
      const broken = { from: () => { throw new Error("relation \"fpx_invoice_documents\" does not exist"); } };
      const out = await queueInvoiceDocuments(broken, { shipment_id: "1", audit_id: AUDIT, files: [PDF] });
      assert.equal(out.queued, 0);
      assert.match(out.error, /does not exist/);
      const refused = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "permission denied" } }) }) }) }) }) };
      assert.match((await queueInvoiceDocuments(refused, { shipment_id: "1", audit_id: AUDIT, files: [PDF] })).error, /permission denied/);
    } finally { console.warn = quiet; }
  });
});

describe("backfillFromRecords / retryFailed", () => {
  it("queues the files of every stored capture that has no row, a shipment's two records together", async () => {
    const { sb, db } = fakeDb({
      docs: [{ shipment_id: "15612931", audit_id: AUDIT, file: PDF, status: "done" }],
      records: [
        { shipment_id: "15612931", kind: "invoice", audit_id: AUDIT, files: [PNG, PDF] },
        { shipment_id: "15612931", kind: "view_shipment", audit_id: AUDIT, files: [VIEW] },
        { shipment_id: "15612940", kind: "invoice", audit_id: AUDIT, files: ["invoices/15612940-1.png"] },
        { shipment_id: "15612950", kind: "invoice", audit_id: null, files: ["invoices/15612950-1.png"] },
        { shipment_id: "15612960", kind: "view_shipment", audit_id: AUDIT, files: [] },
      ],
    });
    const out = await backfillFromRecords(sb);
    assert.deepEqual(out, { queued: 2, skipped: 1, shipments: 2 });
    assert.equal(db.fpx_invoice_documents.find((d) => d.file === PDF).status, "done"); // left alone
    assert.equal(db.fpx_invoice_documents.find((d) => d.file === PNG).status, "skipped");
    assert.deepEqual((await backfillFromRecords(sb)), { queued: 0, skipped: 0, shipments: 2 });
    assert.deepEqual(await backfillFromRecords(sb, { shipment_id: "15612940" }), { queued: 0, skipped: 0, shipments: 1 });
  });

  it("puts failed files back to wait", async () => {
    const { sb, db } = fakeDb({ docs: [
      { shipment_id: "1", audit_id: AUDIT, file: PDF, status: "failed", attempts: 3, error: "x" },
      { shipment_id: "2", audit_id: AUDIT, file: VIEW, status: "done" },
    ] });
    assert.deepEqual(await retryFailed(sb), { retried: 1 });
    assert.deepEqual(db.fpx_invoice_documents.map((d) => [d.status, d.attempts]), [["pending", 0], ["done", 0]]);
  });
});

describe("processOne", () => {
  const bytes = Buffer.from("%PDF-1.7 the invoice");
  const claimOf = (db) => ({ ...db.fpx_invoice_documents[0] });

  it("downloads, reads, saves the columns, the chunks and the cost", async () => {
    const { sb, db, calls } = fakeDb({ docs: [{ shipment_id: "15612931", audit_id: AUDIT, file: PDF, doc_type: "invoice" }], files: { [`${AUDIT}/${PDF}`]: bytes } });
    const seen = [];
    assert.equal(await processOne(sb, claimOf(db), { extract: okExtract(seen) }), "done");
    assert.deepEqual(calls.downloads, [`${AUDIT}/${PDF}`]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mime, "application/pdf");
    assert.equal(seen[0].docType, "invoice");
    assert.equal(seen[0].shipmentId, "15612931");
    assert.ok(Buffer.isBuffer(seen[0].bytes) && seen[0].bytes.equals(bytes));
    const d = db.fpx_invoice_documents[0];
    assert.equal(d.status, "done");
    assert.equal(d.error, null);
    assert.equal(d.invoice_number, "4471002938");
    assert.equal(d.invoice_date, "2026-11-03");
    assert.equal(d.total, 1190.5);
    assert.deepEqual(d.fields, { "Pickup Date": "10/29/2026" });
    assert.equal(d.content_sha256, sha256(bytes));
    assert.equal(d.bytes, bytes.length);
    assert.equal(d.model, "claude-opus-5-5");
    assert.equal(d.cost_usd, 0.066);
    assert.ok(d.extracted_at);
    assert.equal(db.fpx_invoice_document_chunks.length, 1);
    assert.equal(db.fpx_invoice_document_chunks[0].document_id, d.id);
    assert.equal(JSON.parse(db.fpx_invoice_document_chunks[0].embedding).length, 384);
    assert.equal(db.fpx_ai_analyses.length, 1);
    assert.equal(db.fpx_ai_analyses[0].kind, "invoice_ocr");
    assert.equal(db.fpx_ai_analyses[0].cost_usd, 0.066);
  });

  it("does not read again a file whose bytes have not changed", async () => {
    const { sb, db } = fakeDb({
      docs: [{ shipment_id: "1", audit_id: AUDIT, file: PDF, doc_type: "invoice", content_sha256: sha256(bytes), extracted_at: "2026-11-16T00:00:00Z", total: 5 }],
      files: { [`${AUDIT}/${PDF}`]: bytes },
    });
    const seen = [];
    assert.equal(await processOne(sb, claimOf(db), { extract: okExtract(seen) }), "unchanged");
    assert.equal(seen.length, 0);
    assert.equal(db.fpx_invoice_documents[0].status, "done");
    assert.equal(db.fpx_invoice_documents[0].total, 5);
  });

  it("reads again when the bytes changed", async () => {
    const { sb, db } = fakeDb({
      docs: [{ shipment_id: "1", audit_id: AUDIT, file: PDF, doc_type: "invoice", content_sha256: "old", extracted_at: "2026-11-16T00:00:00Z", total: 5, po_number: "GONE" }],
      files: { [`${AUDIT}/${PDF}`]: bytes },
    });
    const seen = [];
    assert.equal(await processOne(sb, claimOf(db), { extract: okExtract(seen) }), "done");
    assert.equal(seen.length, 1);
    assert.equal(db.fpx_invoice_documents[0].total, 1190.5);
    assert.equal(db.fpx_invoice_documents[0].po_number, null); // not on the new reading
  });

  it("copies the reading of the same bytes saved under another pull, without a call", async () => {
    const other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const { sb, db } = fakeDb({
      docs: [
        { shipment_id: "1", audit_id: other, file: PDF, doc_type: "invoice" },
        { shipment_id: "1", audit_id: AUDIT, file: PDF, doc_type: "invoice", status: "done", content_sha256: sha256(bytes), extracted_at: "2026-11-16T00:00:00Z",
          invoice_number: "INV-9", total: 42, raw_text: "copied text", summary: "A copied invoice.", line_items: [], fields: { A: "b" }, warnings: [], model: "claude-opus-5-5" },
      ],
      files: { [`${other}/${PDF}`]: bytes },
    });
    const seen = [];
    assert.equal(await processOne(sb, claimOf(db), { extract: okExtract(seen) }), "copied");
    assert.equal(seen.length, 0);
    const d = db.fpx_invoice_documents[0];
    assert.deepEqual([d.status, d.invoice_number, d.total, d.cost_usd, d.audit_id], ["done", "INV-9", 42, 0, other]);
    assert.deepEqual(d.fields, { A: "b" });
    assert.equal(db.fpx_ai_analyses.length, 0);
    assert.ok(db.fpx_invoice_document_chunks.some((c) => c.document_id === d.id));
  });

  it("a file that is not in storage fails and can be tried again", async () => {
    const { sb, db } = fakeDb({ docs: [{ shipment_id: "1", audit_id: AUDIT, file: PDF, doc_type: "invoice", attempts: 1 }] });
    assert.equal(await processOne(sb, claimOf(db), { extract: okExtract() }), "failed");
    assert.deepEqual([db.fpx_invoice_documents[0].status, db.fpx_invoice_documents[0].attempts], ["failed", 1]);
    assert.match(db.fpx_invoice_documents[0].error, /Could not download/);
  });

  it("a failure that would repeat is not tried again, and its cost is kept", async () => {
    const { sb, db } = fakeDb({ docs: [{ shipment_id: "1", audit_id: AUDIT, file: PDF, doc_type: "invoice", attempts: 1 }], files: { [`${AUDIT}/${PDF}`]: bytes } });
    const extract = async () => {
      throw Object.assign(new ExtractError("The document is too long to read in one go", { permanent: true }),
        { meta: { model: "claude-opus-5-5", input_tokens: 9000, output_tokens: 16000, cost_usd: 0.356, stop_reason: "max_tokens" } });
    };
    assert.equal(await processOne(sb, claimOf(db), { extract }), "failed");
    const d = db.fpx_invoice_documents[0];
    assert.deepEqual([d.status, d.attempts, d.cost_usd], ["failed", MAX_ATTEMPTS, 0.356]);
    assert.match(d.error, /too long/);
    assert.equal(db.fpx_ai_analyses[0].error, d.error);
  });

  it("is still done when the embedding function is down: chunks wait without one", async () => {
    const { sb, db, calls } = fakeDb({ docs: [{ shipment_id: "1", audit_id: AUDIT, file: PDF, doc_type: "invoice" }], files: { [`${AUDIT}/${PDF}`]: bytes }, embedOk: false });
    assert.equal(await processOne(sb, claimOf(db), { extract: okExtract() }), "done");
    assert.equal(db.fpx_invoice_documents[0].status, "done");
    assert.deepEqual(db.fpx_invoice_document_chunks.map((c) => c.embedding), [null]);
    assert.equal(calls.embeds, 2); // one chunk, tried twice
  });
});

describe("processPending", () => {
  it("reads everything waiting; one bad file does not stop the rest", async () => {
    const files = {};
    const docs = [];
    for (let i = 1; i <= 6; i++) {
      docs.push({ shipment_id: String(i), audit_id: AUDIT, file: `invoices/${i}-invoice.pdf`, doc_type: "invoice" });
      if (i !== 3) files[`${AUDIT}/invoices/${i}-invoice.pdf`] = Buffer.from(`%PDF-1.7 invoice ${i}`);
    }
    const { sb, db } = fakeDb({ docs, files });
    const out = await processPending({ sb, limit: 5, concurrency: 3, extract: okExtract() });
    assert.equal(out.processed, 5);
    assert.equal(out.failed, 1);
    assert.equal(out.done, 4);
    assert.equal(db.fpx_invoice_documents.filter((d) => d.status === "done").length, 4);
    assert.equal(db.fpx_invoice_documents.filter((d) => d.status === "pending").length, 1); // limit 5 of 6
    assert.equal(db.fpx_invoice_documents[2].status, "failed");
  });

  it("stops quietly when nothing is waiting, and reports a queue it cannot read", async () => {
    const { sb, calls } = fakeDb();
    assert.deepEqual(await processPending({ sb, extract: okExtract() }), { processed: 0, done: 0, unchanged: 0, copied: 0, failed: 0 });
    assert.ok(calls.claims >= 1 && calls.claims <= 3);
    const quiet = console.warn; console.warn = () => {};
    try {
      const out = await processPending({ sb: { rpc: async () => ({ data: null, error: { message: "function does not exist" } }) }, extract: okExtract() });
      assert.equal(out.processed, 0);
      assert.match(out.error, /does not exist/);
    } finally { console.warn = quiet; }
  });
});

describe("the worker under node --test", () => {
  it("is off: nothing is started and nothing is kicked", () => {
    const had = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      assert.equal(invoiceDocWorkerEnabled(), false);
      assert.equal(startInvoiceDocWorker(), false);
      assert.equal(kickInvoiceDocs(), false);
    } finally { if (had === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = had; }
  });
});

describe("search helpers", () => {
  it("embeds a phrase but not an id or a single word", async () => {
    const { sb, calls } = fakeDb();
    assert.equal(await queryEmbedding(sb, "15612931"), null);
    assert.equal(await queryEmbedding(sb, "537-123456"), null);
    assert.equal(await queryEmbedding(sb, "liftgate"), null);
    assert.equal(calls.embeds, 0);
    assert.equal(JSON.parse(await queryEmbedding(sb, "liftgate fee disputed")).length, 384);
    assert.equal(calls.embeds, 1);
  });

  it("makes a search word safe to put in a filter", () => {
    assert.equal(likeTerm('  XPO "Logistics"  '), "XPO Logistics");
    assert.equal(likeTerm("50%*off\\"), "50 off");
    assert.equal(likeTerm("Acme, Inc (West)"), "Acme, Inc (West)");
    assert.equal(likeTerm(null), "");
  });

  it("lists exactly the columns the dashboard's Doc has", () => {
    assert.deepEqual(DOC_COLS, [
      "id", "shipment_id", "audit_id", "file", "doc_type", "status", "error", "invoice_number", "invoice_date", "due_date",
      "carrier", "bill_to", "ship_from", "ship_to", "tracking_number", "bol_number", "po_number", "so_number", "terms", "currency",
      "subtotal", "fuel_surcharge", "accessorial_total", "total", "line_items", "fields", "summary", "confidence", "warnings",
      "model", "extracted_at",
    ]);
  });
});
