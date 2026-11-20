import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildInvoiceFlowRouter } from "../routes/invoiceFlow.js";
import { createMemoCache } from "../lib/memoCache.js";
import {
  parseRequestNote, monthsBetween, validatePull, validateRecipients, pullNote,
  matchRequests, buildRuns, activeFrom, toNotExportedRow, countsFromAggregate, presentRunFiles,
  isMissingTable, queueErpPull, loadRuns, pageLookups, isAdminReq,
} from "../lib/invoiceFlow.js";

const A1 = "b1064935-0000-4000-8000-000000000001";
const A2 = "c2222222-0000-4000-8000-000000000002";
const A3 = "d3333333-0000-4000-8000-000000000003";

// ---------- a tiny chainable Supabase fake ----------
function fakeSupabase(handler, { storage = {} } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, ops: [] };
      calls.push(q);
      const b = { then(res, rej) { return Promise.resolve().then(() => handler(q)).then(res, rej); } };
      for (const op of ["select", "eq", "neq", "in", "not", "or", "order", "range", "limit", "maybeSingle", "single", "insert", "update", "upsert"]) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b; };
      }
      return b;
    },
    storage: {
      from() {
        return {
          list: async (prefix) => ({ data: (storage[prefix] || []).map((name) => ({ name, id: name })), error: null }),
          createSignedUrl: async (path) => ({ data: { signedUrl: `https://signed/${path}` }, error: null }),
          download: async (path) => ({ data: { arrayBuffer: async () => new TextEncoder().encode(`bytes of ${path}`).buffer }, error: null }),
        };
      },
    },
  };
}
const has = (q, op) => q.ops.some((o) => o[0] === op);
const arg = (q, op, col) => q.ops.find((o) => o[0] === op && o[1] === col)?.[2];

const audits = [
  { id: A1, created_at: "2026-11-01T10:05:00Z", date_from: "2026-10-01", date_to: "2026-11-01", run_by: "a@freightpop.com", total_rows: 920 },
  { id: A2, created_at: "2026-11-10T10:05:00Z", date_from: "2026-08-10", date_to: "2026-11-10", run_by: "b@freightpop.com", total_rows: 500 },
  { id: A3, created_at: "2026-11-20T10:05:00Z", date_from: "2026-10-20", date_to: "2026-11-20", run_by: "c@freightpop.com", total_rows: 300 },
];
const requests = [
  { id: "r1", status: "done", requested_at: "2026-11-01T10:00:00Z", claimed_at: "2026-11-01T10:01:00Z", completed_at: "2026-11-01T10:06:00Z", requested_by: "a@freightpop.com", note: "920 of 1,870 report rows not exported to ERP · audit b1064935" },
  { id: "r2", status: "done", requested_at: "2026-11-10T10:00:00Z", claimed_at: "2026-11-10T10:01:00Z", completed_at: "2026-11-10T10:07:00Z", requested_by: "b@freightpop.com", note: "Pulled 500 rows" },
  { id: "r3", status: "done", requested_at: "2026-11-20T10:00:00Z", claimed_at: "2026-11-20T10:01:00Z", completed_at: "2026-11-20T10:06:00Z", requested_by: "c@freightpop.com", note: "300 of 2,000 report rows not exported to ERP · audit d3333333" },
];
const pipelineRow = { audit_id: A3, run_number: 3, erp_request_id: "r3", months: 1, shipment_type: "parcel", stage: "documents", approval_status: "done", docs_total: 765, docs_done: 340, docs_failed: 2, report_emailed_at: "2026-11-20T10:30:00Z", report_email_error: null, error: null };

function handler({ pipeline = [pipelineRow], pipelineError = null, reqs = requests, busy = [] } = {}) {
  return (q) => {
    if (q.table === "fpx_invoice_audits") return { data: audits, error: null };
    if (q.table === "fpx_invoice_pipeline") return pipelineError ? { data: null, error: pipelineError } : { data: pipeline, error: null };
    if (q.table === "fpx_scrape_requests") {
      if (has(q, "insert")) return { data: { id: "new-req", ...q.ops.find((o) => o[0] === "insert")[1], status: "pending" }, error: null };
      if (arg(q, "in", "status")) return { data: busy, error: null };
      return { data: reqs, error: null };
    }
    if (q.table === "fpx_audit_log") return { data: [{ created_at: "2026-11-20T11:00:00Z", metadata: { sent: true } }], error: null };
    if (q.table === "fpx_erp_invoicing") {
      if (q.ops.find((o) => o[0] === "select")?.[1]?.includes("sum")) {
        return { data: [
          { bucket: "no_invoice", count: 10, sum: 1000.5 },
          { bucket: "invoice_not_approved", count: 5, sum: 500 },
          { bucket: "approved_ready", count: 2, sum: 200 },
          { bucket: "exported", count: 40, sum: 99999 },
        ], error: null };
      }
      return { data: [
        { shipment_id: "S1", bucket: "no_invoice", customer_name: "Acme", carrier: "UPS", tracking_number: "1Z", shipped_date: "2026-11-02", charge: "300.5", cost: "200", approved_invoice_number: null, approved_by: null, last_seen_at: "2026-11-20T10:05:00Z" },
        { shipment_id: "S2", bucket: "approved_ready", customer_name: "Beta", carrier: "FedEx", tracking_number: "77", shipped_date: "2026-11-03", charge: 100, cost: 80, approved_invoice_number: "INV9", approved_by: "Isaac", last_seen_at: "2026-11-20T10:05:00Z" },
      ], count: 2, error: null };
    }
    if (q.table === "fpx_shipment_records") return { data: [{ shipment_id: "S1", files: ["invoices/S1-1.pdf"] }, { shipment_id: "S2", files: [] }], error: null };
    if (q.table === "fpx_invoice_documents") return { data: [], error: null };
    if (q.table === "fpx_erp_transactions") return { data: [{ shipment_id: "S1", last_pull_audit_id: A3 }, { shipment_id: "S2", last_pull_audit_id: A1 }], error: null };
    return { data: [], error: null };
  };
}

function makeApp({ user = { role: "user", email: "u@freightpop.com" }, apiKey = null, h = handler(), deps = {}, storage = {} } = {}) {
  const sb = fakeSupabase(h, { storage });
  const audit = [];
  const sent = [];
  const saved = [];
  const router = buildInvoiceFlowRouter({
    supabase: sb,
    runsCache: createMemoCache(),
    countsCache: createMemoCache(),
    logAudit: async (_req, e) => { audit.push(e); },
    getReportRecipients: async () => ["isaacs@freightpop.com"],
    buildNotExportedWorkbook: async () => ({ buffer: Buffer.from("xlsx"), filename: "FPX-not-exported-to-ERP-2026-11-20.xlsx", count: 17 }),
    sendNotExportedReport: async (o) => { sent.push(o); return { sent: true, recipients: ["isaacs@freightpop.com"] }; },
    setRecipients: async (list, by) => { saved.push({ list, by }); },
    ...deps,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; req.apiKey = apiKey; next(); });
  app.use("/api/invoice-flow", router);
  return { app, sb, audit, sent, saved };
}

async function call(app, method, path, body) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get("content-type") || "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  } finally {
    server.close();
  }
}

// ---------- pure helpers ----------

describe("parseRequestNote", () => {
  it("reads the finished note", () => {
    const p = parseRequestNote("920 of 1,870 report rows not exported to ERP · audit b1064935");
    assert.equal(p.not_exported, 920);
    assert.equal(p.report_rows, 1870);
    assert.equal(p.audit_prefix, "b1064935");
  });
  it("reads the queued note", () => {
    const p = parseRequestNote("months=6;type=both");
    assert.equal(p.months, 6);
    assert.equal(p.shipment_type, "both");
    assert.equal(p.report_rows, null);
  });
  it("is all null for anything else", () => {
    assert.deepEqual(parseRequestNote(null), { months: null, shipment_type: null, not_exported: null, report_rows: null, audit_prefix: null });
    assert.equal(parseRequestNote("1 of 1 report row").report_rows, 1);
  });
});

describe("validation", () => {
  it("pull: months 1|3|6|12 and a known shipment type", () => {
    assert.deepEqual(validatePull({}), { months: 1, shipmentType: "non-parcel" });
    assert.deepEqual(validatePull({ months: "3", shipment_type: "parcel" }), { months: 3, shipmentType: "parcel" });
    assert.ok(validatePull({ months: 2 }).error);
    assert.ok(validatePull({ months: 13 }).error);
    assert.ok(validatePull({ months: 1, shipment_type: "ltl" }).error);
    assert.equal(pullNote(12, "both"), "months=12;type=both");
  });
  it("recipients: @freightpop.com only, cleaned and each once", () => {
    assert.deepEqual(validateRecipients([" Isaacs@FreightPOP.com ", "isaacs@freightpop.com", "x@freightpop.com"]).recipients, ["isaacs@freightpop.com", "x@freightpop.com"]);
    assert.ok(validateRecipients(["a@gmail.com"]).error);
    assert.ok(validateRecipients(["a@freightpop.com.evil.com"]).error);
    assert.ok(validateRecipients([]).error);
    assert.ok(validateRecipients("a@freightpop.com").error);
    assert.ok(validateRecipients([42]).error);
  });
  it("admins are role admin or an admin-scoped key", () => {
    assert.equal(isAdminReq({ user: { role: "admin" } }), true);
    assert.equal(isAdminReq({ apiKey: { scopes: ["admin"] } }), true);
    assert.equal(isAdminReq({ user: { role: "user" } }), false);
  });
  it("monthsBetween rounds to whole months", () => {
    assert.equal(monthsBetween("2026-08-10", "2026-11-10"), 3);
    assert.equal(monthsBetween("2026-11-01", "2026-11-02"), 1);
    assert.equal(monthsBetween(null, "2026-11-02"), null);
  });
  it("isMissingTable", () => {
    assert.equal(isMissingTable({ code: "42P01", message: "x" }), true);
    assert.equal(isMissingTable({ code: "PGRST205", message: "Could not find the table 'public.fpx_invoice_pipeline'" }), true);
    assert.equal(isMissingTable({ code: "500", message: "boom" }), false);
  });
});

describe("runs", () => {
  it("matches requests by pipeline row, note prefix, then time", () => {
    const m = matchRequests(audits, requests, new Map([[A3, pipelineRow]]));
    assert.equal(m.get(A1).id, "r1");
    assert.equal(m.get(A2).id, "r2");
    assert.equal(m.get(A3).id, "r3");
  });
  it("builds runs newest first with numbers, report rows and pipeline progress", () => {
    const runs = buildRuns({ audits, pipelines: [pipelineRow], requests });
    assert.deepEqual(runs.map((r) => r.run_number), [3, 2, 1]);
    const [r3, r2, r1] = runs;
    assert.equal(r3.stage, "documents");
    assert.equal(r3.docs_done, 340);
    assert.equal(r3.shipment_type, "parcel");
    assert.equal(r3.report_rows, 2000);
    assert.equal(r3.started_at, "2026-11-20T10:01:00Z");
    assert.equal(r3.finished_at, "2026-11-20T10:06:00Z");
    assert.equal(r1.report_rows, 1870);
    assert.equal(r1.not_exported, 920);
    assert.equal(r1.stage, "done");
    assert.equal(r1.months, 1);
    assert.equal(r2.months, 3);
    assert.equal(r2.report_rows, null);
    assert.equal(r2.requested_by, "b@freightpop.com");
    for (const k of ["audit_id", "run_number", "started_at", "finished_at", "months", "shipment_type", "date_from", "date_to", "report_rows", "not_exported", "stage", "approval_status", "docs_total", "docs_done", "docs_failed", "report_emailed_at", "report_email_error", "error", "requested_by"]) {
      assert.ok(Object.hasOwn(r1, k), k);
    }
  });
  it("an older run with no request takes its audit's time", () => {
    const [run] = buildRuns({ audits: [audits[0]], pipelines: [], requests: [] });
    assert.equal(run.started_at, audits[0].created_at);
    assert.equal(run.run_number, 1);
  });
  it("active: a queued pull, else an unfinished pipeline", () => {
    const runs = buildRuns({ audits, pipelines: [pipelineRow], requests });
    assert.deepEqual(activeFrom(runs, [{ id: "x", status: "pending", requested_at: "2026-11-21" }]),
      { stage: "pulled", run_number: 4, message: "Pull queued: waiting for the hosted browser" });
    const a = activeFrom(runs, requests);
    assert.equal(a.stage, "documents");
    assert.equal(a.run_number, 3);
    assert.match(a.message, /340 of 765/);
    assert.equal(activeFrom(buildRuns({ audits, pipelines: [], requests }), requests), null);
  });
  it("tolerates fpx_invoice_pipeline not existing", async () => {
    const sb = fakeSupabase(handler({ pipelineError: { code: "42P01", message: "relation does not exist" } }));
    const { runs } = await loadRuns(sb);
    assert.equal(runs.length, 3);
    assert.equal(runs[0].stage, "done");
  });
});

describe("rows and counts", () => {
  it("toNotExportedRow maps the view", () => {
    const row = toNotExportedRow(
      { shipment_id: 7, bucket: "approved_ready", customer_name: "C", carrier: "K", tracking_number: "T", shipped_date: "2026-11-01", charge: "10.5", cost: null, approved_invoice_number: "I", approved_by: "P", last_seen_at: "z" },
      { docsSaved: new Set(["7"]), lastPull: new Map([["7", A1]]), runNumberByAudit: new Map([[A1, 1]]) },
    );
    assert.deepEqual(row, { shipment_id: "7", status: "approved_ready", customer: "C", carrier: "K", tracking: "T", ship_date: "2026-11-01", charge: 10.5, cost: null, invoice_number: "I", approved_by: "P", docs_saved: true, last_pulled_at: "z", run_number: 1 });
  });
  it("countsFromAggregate leaves exported out of the charge", () => {
    assert.deepEqual(countsFromAggregate([{ bucket: "no_invoice", count: 2, sum: 1.254 }, { bucket: "exported", count: 9, sum: 50 }]),
      { no_invoice: 2, invoice_not_approved: 0, approved_ready: 0, exported: 9, charge_total: 1.25 });
  });
  it("presentRunFiles finds the four files", () => {
    assert.deepEqual(presentRunFiles(["full.xlsx", "audit-history-2026-10-01_2026-11-01.xlsx", "invoices"]).map((f) => f.name), ["full.xlsx", "audit-history.xlsx"]);
  });
  it("pageLookups: docs saved from records with files or any document, in batch", async () => {
    const sb = fakeSupabase((q) => {
      if (q.table === "fpx_shipment_records") return { data: [{ shipment_id: "S1", files: ["a.pdf"] }, { shipment_id: "S2", files: [] }], error: null };
      if (q.table === "fpx_invoice_documents") return { data: [{ shipment_id: "S3" }], error: null };
      return { data: [{ shipment_id: "S1", last_pull_audit_id: A1 }], error: null };
    });
    const { docsSaved, lastPull } = await pageLookups(sb, ["S1", "S2", "S3"]);
    assert.deepEqual([...docsSaved].sort(), ["S1", "S3"]);
    assert.equal(lastPull.get("S1"), A1);
    assert.equal(sb.calls.length, 3);
  });
  it("queueErpPull: 409-style conflict when one is pending, else the ops.js row", async () => {
    const busy = fakeSupabase(handler({ busy: [{ id: "x", status: "claimed" }] }));
    assert.deepEqual(await queueErpPull(busy, { months: 1, shipmentType: "non-parcel" }), { conflict: "A pull is already running" });
    const free = fakeSupabase(handler());
    const out = await queueErpPull(free, { months: 6, shipmentType: "both", requestedBy: "u@freightpop.com" });
    assert.equal(out.request.scope, "erp_audit");
    assert.equal(out.request.note, "months=6;type=both");
    assert.equal(out.request.requested_by, "u@freightpop.com");
  });
});

// ---------- routes ----------

describe("routes", () => {
  it("GET /summary", async () => {
    const { app } = makeApp();
    const r = await call(app, "GET", "/api/invoice-flow/summary");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.not_exported, { total: 17, no_invoice: 10, invoice_not_approved: 5, approved_ready: 2, charge_total: 1700.5 });
    assert.equal(r.body.exported_total, 40);
    assert.equal(r.body.latest_run.run_number, 3);
    assert.equal(r.body.active.stage, "documents");
    assert.equal(r.body.last_pull_at, "2026-11-20T10:06:00Z");
    assert.deepEqual(r.body.report, { recipients: ["isaacs@freightpop.com"], last_emailed_at: "2026-11-20T11:00:00Z" });
  });

  it("GET /runs pages", async () => {
    const { app } = makeApp();
    const r = await call(app, "GET", "/api/invoice-flow/runs?limit=2&offset=1");
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 3);
    assert.deepEqual(r.body.runs.map((x) => x.run_number), [2, 1]);
  });

  it("GET /runs/:auditId with signed files and docs count; 404 otherwise", async () => {
    const { app } = makeApp({ storage: { [A1]: ["not-exported.xlsx", "full.xlsx", "invoices"], [`${A1}/invoices`]: ["S1-1.pdf", "S1-2.png"] } });
    const r = await call(app, "GET", `/api/invoice-flow/runs/${A1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.run.audit_id, A1);
    assert.deepEqual(r.body.files.map((f) => f.name), ["not-exported.xlsx", "full.xlsx"]);
    assert.match(r.body.files[0].url, /^https:\/\/signed\//);
    assert.ok(r.body.files[0].label);
    assert.equal(r.body.docs_count, 2);
    assert.equal((await call(app, "GET", "/api/invoice-flow/runs/nope")).status, 404);
    assert.equal((await call(app, "GET", "/api/invoice-flow/runs/eeeeeeee-0000-4000-8000-000000000000")).status, 404);
  });

  it("GET /runs/:auditId/documents.zip", async () => {
    const { app } = makeApp({ storage: { [`${A1}/invoices`]: ["S1-1.pdf"] } });
    const r = await call(app, "GET", `/api/invoice-flow/runs/${A1}/documents.zip`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/zip");
    assert.match(r.headers.get("content-disposition"), /FPX-run-1-documents\.zip/);
    assert.equal(r.body.subarray(0, 2).toString(), "PK");
    const empty = makeApp();
    assert.equal((await call(empty.app, "GET", `/api/invoice-flow/runs/${A2}/documents.zip`)).status, 404);
  });

  it("GET /not-exported: rows, total, validation", async () => {
    const { app } = makeApp();
    const r = await call(app, "GET", "/api/invoice-flow/not-exported?status=all&limit=50");
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 17);
    assert.equal(r.body.rows.length, 2);
    assert.deepEqual(r.body.rows[0], { shipment_id: "S1", status: "no_invoice", customer: "Acme", carrier: "UPS", tracking: "1Z", ship_date: "2026-11-02", charge: 300.5, cost: 200, invoice_number: null, approved_by: null, docs_saved: true, last_pulled_at: "2026-11-20T10:05:00Z", run_number: 3 });
    assert.equal(r.body.rows[1].docs_saved, false);
    assert.equal(r.body.rows[1].run_number, 1);
    const one = await call(app, "GET", "/api/invoice-flow/not-exported?status=approved_ready");
    assert.equal(one.body.total, 2);
    assert.equal((await call(app, "GET", "/api/invoice-flow/not-exported?status=exported")).status, 400);
  });

  it("GET /not-exported.xlsx", async () => {
    const { app } = makeApp();
    const r = await call(app, "GET", "/api/invoice-flow/not-exported.xlsx");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /FPX-not-exported-to-ERP-2026-11-20\.xlsx/);
    assert.equal(r.body.toString(), "xlsx");
  });

  it("POST /pull queues an erp_audit request; 400 bad input; 409 when one is pending", async () => {
    const ok = makeApp();
    const r = await call(ok.app, "POST", "/api/invoice-flow/pull", { months: 3, shipment_type: "non-parcel" });
    assert.equal(r.status, 200);
    assert.equal(r.body.request.scope, "erp_audit");
    assert.equal(r.body.request.note, "months=3;type=non-parcel");
    assert.equal(r.body.request.requested_by, "u@freightpop.com");
    assert.equal(ok.audit[0].metadata.months, 3);
    assert.equal((await call(ok.app, "POST", "/api/invoice-flow/pull", { months: 2 })).status, 400);
    assert.equal((await call(ok.app, "POST", "/api/invoice-flow/pull", { months: 1, shipment_type: "ltl" })).status, 400);
    const busy = makeApp({ h: handler({ busy: [{ id: "x", status: "pending" }] }) });
    const c = await call(busy.app, "POST", "/api/invoice-flow/pull", { months: 1, shipment_type: "both" });
    assert.equal(c.status, 409);
    assert.match(c.body.error, /already queued/);
    assert.equal(busy.sb.calls.filter((q) => has(q, "insert")).length, 0);
  });

  it("POST /report/email sends a manual report and logs it", async () => {
    const { app, sent, audit } = makeApp();
    const r = await call(app, "POST", "/api/invoice-flow/report/email", {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sent: true, recipients: ["isaacs@freightpop.com"] });
    assert.deepEqual(sent, [{ reason: "manual" }]);
    assert.equal(audit[0].action, "invoice_report_email");
    assert.equal(audit[0].metadata.sent, true);
  });

  it("PUT /report/recipients: admins only, @freightpop.com only", async () => {
    const user = makeApp();
    assert.equal((await call(user.app, "PUT", "/api/invoice-flow/report/recipients", { recipients: ["a@freightpop.com"] })).status, 403);
    const admin = makeApp({ user: { role: "admin", email: "boss@freightpop.com" } });
    assert.equal((await call(admin.app, "PUT", "/api/invoice-flow/report/recipients", { recipients: ["a@gmail.com"] })).status, 400);
    const r = await call(admin.app, "PUT", "/api/invoice-flow/report/recipients", { recipients: ["A@freightpop.com", "isaacs@freightpop.com"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { recipients: ["a@freightpop.com", "isaacs@freightpop.com"] });
    assert.deepEqual(admin.saved, [{ list: ["a@freightpop.com", "isaacs@freightpop.com"], by: "boss@freightpop.com" }]);
    assert.equal(admin.audit[0].entity_id, "invoices.report_recipients");
  });
});
