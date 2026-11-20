import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createInvoicePipeline, isBackfillNote, auditPrefixFromNote, auditIdFromNote, parsePullNote,
  pickRunAudit, attemptOf, maxBatches, startInvoicePipeline,
} from "../lib/invoicePipeline.js";

// ---- a small in-memory stand-in for the Supabase client ----
function fakeDb(tables = {}) {
  const t = (name) => (tables[name] ||= []);
  let seq = 0;
  const cmp = (a, b) => (a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : 1);
  function builder(name) {
    const filters = [];
    const orders = [];
    let op = "select";
    let payload = null;
    let limitN = null;
    let rangeFrom = 0;
    let rangeTo = null;
    let returning = false;
    const q = {
      select() { if (op !== "select") returning = true; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
      gte(c, v) { filters.push((r) => r[c] != null && r[c] >= v); return q; },
      order(c, { ascending = true } = {}) { orders.push([c, ascending]); return q; },
      limit(n) { limitN = n; return q; },
      range(a, b) { rangeFrom = a; rangeTo = b; return q; },
      insert(v) { op = "insert"; payload = v; return q; },
      update(v) { op = "update"; payload = v; return q; },
      maybeSingle() { return run().then(({ data, error }) => ({ data: data?.[0] ?? null, error })); },
      single() { return run().then(({ data, error }) => (error ? { data: null, error } : data?.length ? { data: data[0], error: null } : { data: null, error: { message: "no rows" } })); },
      then(ok, bad) { return run().then(ok, bad); },
    };
    async function run() {
      const rows = t(name);
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ ...r }));
        for (const r of list) {
          if (name === "fpx_invoice_pipeline") {
            if (rows.some((x) => x.audit_id === r.audit_id)) return { data: null, error: { message: "duplicate key" } };
            r.run_number ??= Math.max(0, ...rows.map((x) => x.run_number || 0)) + 1;
            r.doc_request_ids ??= [];
            for (const k of ["docs_total", "docs_done", "docs_failed"]) r[k] ??= 0;
          }
          if (name === "fpx_scrape_requests") { r.id ??= `req-${++seq}`; r.status ??= "pending"; r.requested_at ??= "2026-11-20T12:00:00.000Z"; }
          rows.push(r);
        }
        return { data: returning ? list : null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      let out = [...hit];
      for (const [c, asc] of [...orders].reverse()) out.sort((a, b) => (asc ? 1 : -1) * cmp(a[c], b[c]));
      out = out.slice(rangeFrom, rangeTo == null ? undefined : rangeTo + 1);
      if (limitN != null) out = out.slice(0, limitN);
      return { data: out.map((r) => ({ ...r })), error: null };
    }
    return q;
  }
  return { from: builder, tables };
}

const AUDIT = "b1064935-1111-4111-8111-111111111111";
const OTHER = "c2222222-2222-4222-8222-222222222222";

function setup({ rows = 150, extraTables = {} } = {}) {
  const tables = {
    fpx_invoice_audits: [
      { id: OTHER, shipment_type: "erp_pending", created_at: "2026-11-20T12:20:00.000Z", run_by: "pat@freightpop.com" },
      { id: AUDIT, shipment_type: "erp_pending", created_at: "2026-11-20T12:10:00.000Z", run_by: "pat@freightpop.com", date_from: "2026-10-20", date_to: "2026-11-20" },
    ],
    fpx_invoice_audit_rows: Array.from({ length: rows }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, audit_id: AUDIT, created_at: "2026-11-20T12:10:00.000Z", shipment_id: String(1000 + i), raw: {} })),
    fpx_scrape_requests: [],
    fpx_invoice_pipeline: [],
    fpx_erp_transactions: [],
    fpx_shipment_records: [],
    fpx_invoice_documents: [],
    ...extraTables,
  };
  const db = fakeDb(tables);
  const calls = { approval: [], getInvoice: [], report: [] };
  let approvalAnswer = null;
  let getInvoiceAnswer = null;
  const deps = {
    db,
    now: () => new Date("2026-11-20T13:00:00.000Z"),
    log: () => {},
    queueApprovalCheck: async (args, opts) => {
      calls.approval.push({ args, opts });
      if (approvalAnswer) return approvalAnswer;
      const request = { id: `ac-${calls.approval.length}`, scope: "approval_check", status: "pending", note: `audit=${args.auditId}`, requested_at: "2026-11-20T12:31:00.000Z" };
      tables.fpx_scrape_requests.push(request);
      return { ok: true, request };
    },
    queueGetInvoice: async (args, opts) => {
      calls.getInvoice.push({ args, opts });
      if (getInvoiceAnswer) return getInvoiceAnswer;
      const request = { id: `gi-${calls.getInvoice.length}`, scope: "get_invoice", status: "pending", tracking_numbers: args.shipmentIds, note: `audit=${args.auditId};from=x;to=y;pause_first=0` };
      tables.fpx_scrape_requests.push(request);
      return { ok: true, request };
    },
    sendReport: async (args) => { calls.report.push(args); return { sent: true, recipients: ["isaacs@freightpop.com"] }; },
  };
  return {
    tables, calls, deps,
    setApprovalAnswer: (v) => { approvalAnswer = v; },
    setGetInvoiceAnswer: (v) => { getInvoiceAnswer = v; },
    pipeline: () => createInvoicePipeline(deps),
  };
}

const pull = (over = {}) => ({
  before: { id: "pull-1", scope: "erp_audit", status: "claimed", note: "months=1;type=non-parcel", requested_by: "pat@freightpop.com", requested_at: "2026-11-20T12:00:00.000Z", claimed_at: "2026-11-20T12:05:00.000Z", ...over.before },
  after: { id: "pull-1", scope: "erp_audit", status: "done", note: "150 of 400 report rows not exported to ERP · audit b1064935", requested_by: "pat@freightpop.com", requested_at: "2026-11-20T12:00:00.000Z", claimed_at: "2026-11-20T12:05:00.000Z", ...over.after },
});

// The worker finishes a request: the row is updated, then the complete route
// calls onRequestComplete with the request before and after.
async function complete(env, p, id, status = "done", note = "finished") {
  const req = env.tables.fpx_scrape_requests.find((r) => r.id === id);
  const before = { ...req };
  Object.assign(req, { status, note, completed_at: "2026-11-20T12:59:00.000Z" });
  await p.onRequestComplete(before, { ...req });
}

// The worker's results on the audit rows for a Get Invoice request.
function reportResults(env, requestId, ids, ok = true) {
  for (const r of env.tables.fpx_invoice_audit_rows) {
    if (ids.includes(r.shipment_id)) r.raw = { get_invoice: { status: ok ? "done" : "failed", request_id: requestId } };
  }
}

describe("invoice pipeline helpers", () => {
  it("reads backfill, audit prefix, audit id and pull settings from notes", () => {
    assert.equal(isBackfillNote("from=2026-08-01;to=2026-11-01;backfill=1"), true);
    assert.equal(isBackfillNote("months=3;type=parcel"), false);
    assert.equal(auditPrefixFromNote("920 of 1,870 report rows not exported to ERP · audit B1064935"), "b1064935");
    assert.equal(auditPrefixFromNote("Stopped by user"), null);
    assert.equal(auditIdFromNote(`audit=${AUDIT}`), AUDIT);
    assert.deepEqual(parsePullNote("months=6;type=both"), { months: 6, shipment_type: "both" });
    assert.deepEqual(parsePullNote("from=2026-01-01;to=2026-02-01"), { months: null, shipment_type: "non-parcel" });
  });

  it("picks the audit named in the note, else the newest one not taken", () => {
    const audits = [{ id: OTHER }, { id: AUDIT }];
    assert.equal(pickRunAudit(audits, "x · audit b1064935").id, AUDIT);
    assert.equal(pickRunAudit(audits, "no id here").id, OTHER);
    assert.equal(pickRunAudit(audits, "no id here", { taken: new Set([OTHER]) }).id, AUDIT);
    assert.equal(pickRunAudit(audits, "no id here", { prefixOnly: true }), null);
  });

  it("finds this pipeline's Get Invoice result on a row, in history too", () => {
    assert.equal(attemptOf({ get_invoice: { status: "done", request_id: "a" } }, ["a"]), "done");
    assert.equal(attemptOf({ get_invoice: { status: "done", request_id: "manual" } }, ["a"]), null);
    assert.equal(attemptOf({ get_invoice: { status: "requested", request_id: "b", history: [{ request_id: "a", status: "failed" }] } }, ["a", "b"]), "failed");
    assert.equal(attemptOf({ get_invoice: { status: "not_started", request_id: "a" } }, ["a"]), null);
    assert.equal(maxBatches(765), 7);
    assert.equal(maxBatches(0), 3);
  });

  it("does not start the tick under node --test", () => {
    assert.equal(startInvoicePipeline(), false);
  });
});

describe("invoice pipeline flow", () => {
  it("runs pull → approval check → report → Get Invoice batches → done", async () => {
    const env = setup({ rows: 450 });
    // Two shipments already have documents and one is now exported: skipped.
    env.tables.fpx_shipment_records.push({ shipment_id: "1000", kind: "invoice", files: ["invoices/1000-1.pdf"] });
    env.tables.fpx_shipment_records.push({ shipment_id: "1001", kind: "invoice", files: [] });
    env.tables.fpx_invoice_documents.push({ shipment_id: "1002" });
    env.tables.fpx_erp_transactions.push({ shipment_id: "1003", exported_to_erp: true });
    const p = env.pipeline();
    const { before, after } = pull();
    await p.onRequestComplete(before, after);

    let run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.audit_id, AUDIT);
    assert.equal(run.run_number, 1);
    assert.equal(run.erp_request_id, "pull-1");
    assert.equal(run.months, 1);
    assert.equal(run.shipment_type, "non-parcel");
    assert.equal(run.stage, "approvals");
    assert.equal(run.approval_status, "queued");
    assert.equal(env.calls.approval.length, 1);
    assert.equal(env.calls.approval[0].args.auditId, AUDIT);
    assert.equal(env.calls.approval[0].opts.requestedBy, "pat@freightpop.com");

    await complete(env, p, "ac-1", "done", "120 of 450 shipments of audit b1064935 are in Recently Approved");
    run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.approval_status, "done");
    assert.deepEqual(env.calls.report, [{ auditId: AUDIT, reason: "after_pull" }]);
    assert.ok(run.report_emailed_at);
    assert.equal(run.stage, "documents");
    assert.equal(run.docs_total, 447);
    assert.equal(env.calls.getInvoice.length, 1);
    const first = env.calls.getInvoice[0].args;
    assert.equal(first.shipmentIds.length, 200);
    assert.equal(first.shipmentIds[0], "1001");
    assert.ok(!first.shipmentIds.includes("1000") && !first.shipmentIds.includes("1002") && !first.shipmentIds.includes("1003"));
    assert.equal(first.pauseAfterFirst, false);
    assert.equal(first.buttons, null);
    assert.deepEqual(run.doc_request_ids, ["gi-1"]);

    // A tick while the batch runs changes nothing.
    await p.advancePipelines();
    assert.equal(env.calls.getInvoice.length, 1);

    reportResults(env, "gi-1", first.shipmentIds.slice(0, 190), true);
    reportResults(env, "gi-1", first.shipmentIds.slice(190), false);
    await complete(env, p, "gi-1");
    run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.docs_done, 190);
    assert.equal(run.docs_failed, 10);
    assert.equal(env.calls.getInvoice.length, 2);
    const second = env.calls.getInvoice[1].args.shipmentIds;
    assert.equal(second.length, 200);
    assert.ok(!second.some((id) => first.shipmentIds.includes(id)), "failed shipments are not retried");

    reportResults(env, "gi-2", second, true);
    await complete(env, p, "gi-2");
    const third = env.calls.getInvoice[2].args.shipmentIds;
    assert.equal(third.length, 47);
    reportResults(env, "gi-3", third, true);
    await complete(env, p, "gi-3");
    run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.stage, "done");
    assert.equal(run.docs_done, 437);
    assert.equal(run.docs_failed, 10);
    assert.equal(env.calls.getInvoice.length, 3);
    assert.equal(env.calls.report.length, 1, "the report is emailed once");
  });

  it("skips backfill pulls", async () => {
    const env = setup();
    const p = env.pipeline();
    const { before, after } = pull({ before: { note: "from=2026-08-01;to=2026-11-01;backfill=1" }, after: { note: "Backfill copied 1,000 rows" } });
    await p.onRequestComplete(before, after);
    assert.equal(env.tables.fpx_invoice_pipeline.length, 0);
    assert.equal(env.calls.approval.length, 0);
  });

  it("falls back to the newest audit made after the claim when the note has no id", async () => {
    const env = setup();
    const p = env.pipeline();
    const { before, after } = pull({ after: { note: "done" } });
    await p.onRequestComplete(before, after);
    assert.equal(env.tables.fpx_invoice_pipeline[0].audit_id, OTHER);
  });

  it("marks the run failed when the pull errors", async () => {
    const env = setup();
    const p = env.pipeline();
    const { before, after } = pull({ after: { status: "error", note: "12 of 150 rows uploaded before the stop · audit b1064935" } });
    await p.onRequestComplete(before, after);
    const run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.stage, "failed");
    assert.match(run.error, /before the stop/);
    assert.equal(env.calls.approval.length, 0);
  });

  it("adopts an approval check already queued for the audit", async () => {
    const env = setup();
    env.tables.fpx_scrape_requests.push({ id: "mine", scope: "approval_check", status: "claimed", note: `audit=${AUDIT}`, requested_at: "2026-11-20T12:30:00.000Z" });
    const p = env.pipeline();
    const { before, after } = pull();
    await p.onRequestComplete(before, after);
    const run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(env.calls.approval.length, 0);
    assert.equal(run.approval_request_id, "mine");
    assert.equal(run.approval_status, "running");
  });

  it("waits on 409 and the tick queues the approval check later", async () => {
    const env = setup();
    env.setApprovalAnswer({ ok: false, status: 409, error: "An approval check is already queued or running" });
    const p = env.pipeline();
    const { before, after } = pull();
    await p.onRequestComplete(before, after);
    let run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.stage, "approvals");
    assert.equal(run.approval_request_id, undefined);
    env.setApprovalAnswer(null);
    await p.advancePipelines();
    run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.approval_request_id, "ac-2");
  });

  it("goes on to documents when the approval check errors, and records a report failure", async () => {
    const env = setup({ rows: 3 });
    env.deps.sendReport = async () => { throw new Error("email not configured"); };
    const p = env.pipeline();
    const { before, after } = pull();
    await p.onRequestComplete(before, after);
    await complete(env, p, "ac-1", "error", "Interrupted");
    const run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.approval_status, "error");
    assert.match(run.report_email_error, /email not configured/);
    assert.equal(run.stage, "documents");
    assert.equal(env.calls.getInvoice.length, 1);
    assert.equal(env.calls.getInvoice[0].args.shipmentIds.length, 3);
  });

  it("re-queues shipments a batch never reached, and the tick recovers an expired batch", async () => {
    const env = setup({ rows: 5 });
    const p = env.pipeline();
    const { before, after } = pull();
    await p.onRequestComplete(before, after);
    await complete(env, p, "ac-1");
    reportResults(env, "gi-1", ["1000", "1001"], true);
    // Expired without the complete route (stale request close-out).
    env.tables.fpx_scrape_requests.find((r) => r.id === "gi-1").status = "error";
    await p.advancePipelines();
    assert.deepEqual(env.calls.getInvoice[1].args.shipmentIds, ["1002", "1003", "1004"]);
  });

  it("finishes at once when every shipment already has documents", async () => {
    const env = setup({ rows: 2 });
    env.tables.fpx_invoice_documents.push({ shipment_id: "1000" }, { shipment_id: "1001" });
    const p = env.pipeline();
    const { before, after } = pull();
    await p.onRequestComplete(before, after);
    await complete(env, p, "ac-1");
    const run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.stage, "done");
    assert.equal(run.docs_total, 0);
    assert.equal(env.calls.getInvoice.length, 0);
  });

  it("the tick picks up a pull the complete route missed", async () => {
    const env = setup({ rows: 2 });
    env.tables.fpx_scrape_requests.push({ id: "pull-9", scope: "erp_audit", status: "done", note: "2 of 9 report rows not exported to ERP · audit b1064935", requested_by: "pat@freightpop.com", requested_at: "2026-11-20T12:00:00.000Z", claimed_at: "2026-11-20T12:05:00.000Z", completed_at: "2026-11-20T12:15:00.000Z" });
    const p = env.pipeline();
    await p.advancePipelines();
    const run = env.tables.fpx_invoice_pipeline[0];
    assert.equal(run.audit_id, AUDIT);
    assert.equal(run.erp_request_id, "pull-9");
    assert.equal(env.calls.approval.length, 1);
  });

  it("lists the shipments needing documents", async () => {
    const env = setup({ rows: 4 });
    env.tables.fpx_invoice_documents.push({ shipment_id: "1001" });
    assert.deepEqual(await env.pipeline().shipmentsNeedingDocs(AUDIT), ["1000", "1002", "1003"]);
  });

  it("never throws", async () => {
    const p = createInvoicePipeline({ db: { from() { throw new Error("db down"); } }, log: () => {} });
    await p.onRequestComplete({ id: "x", scope: "erp_audit", note: "months=1" }, { id: "x", status: "done", note: "audit b1064935" });
    await p.onRequestComplete({ id: "y", scope: "get_invoice", note: `audit=${AUDIT};from=a;to=b;pause_first=0` }, { id: "y" });
    await p.advancePipelines();
  });
});
