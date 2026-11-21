import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildInvoiceFlowRouter } from "../routes/invoiceFlow.js";
import { createMemoCache } from "../lib/memoCache.js";
import {
  validatePush, checkPushIds, getInvoiceState, pushSourceOf, groupPushCandidates, pushJobs,
  loadApprovedReady, loadPushJobs, loadGetInvoiceStates, loadPushChecks, nameIds, PUSH_SOURCE,
} from "../lib/invoiceFlow.js";

const A1 = "b1064935-0000-4000-8000-000000000001";
const A2 = "c2222222-0000-4000-8000-000000000002";
const A3 = "d3333333-0000-4000-8000-000000000003";

// Runs newest first, as loadRuns returns them.
const runs = [
  { audit_id: A3, run_number: 3, started_at: "2026-11-20T10:01:00Z", finished_at: "2026-11-20T10:06:00Z" },
  { audit_id: A2, run_number: 2, started_at: "2026-11-10T10:01:00Z", finished_at: "2026-11-10T10:07:00Z" },
  { audit_id: A1, run_number: 1, started_at: "2026-11-01T10:01:00Z", finished_at: null },
];
const view = (id, extra = {}) => ({
  shipment_id: id, bucket: "approved_ready", customer_name: `Cust ${id}`, carrier: "UPS", tracking_number: `T${id}`,
  shipped_date: "2026-11-02", charge: "100.5", cost: "80", approved_invoice_number: `INV${id}`, approved_by: "Isaac",
  last_seen_at: "2026-11-20T10:05:00Z", ...extra,
});

// ---------- a tiny chainable Supabase fake ----------
function fakeSupabase(handler) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, ops: [] };
      calls.push(q);
      const b = { then(res, rej) { return Promise.resolve().then(() => handler(q)).then(res, rej); } };
      for (const op of ["select", "eq", "neq", "in", "not", "or", "order", "range", "limit", "maybeSingle", "single", "insert", "update"]) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b; };
      }
      return b;
    },
  };
}
const arg = (q, op, col) => q.ops.find((o) => o[0] === op && o[1] === col)?.[2];

// ---------- pure helpers ----------

describe("push helpers", () => {
  it("nameIds names up to 5", () => {
    assert.equal(nameIds(["a", "b"]), "a, b");
    assert.equal(nameIds(["1", "2", "3", "4", "5", "6", "7"]), "1, 2, 3, 4, 5 and 2 more");
  });

  it("checkPushIds refuses shipments already pressed unless repush", () => {
    const checks = { ready: new Set(["1", "2"]), lastPull: new Map([["1", A1], ["2", A1]]), pressed: new Set(["2"]) };
    assert.match(checkPushIds(["1", "2"], A1, checks), /already had Get Invoice pressed.*: 2\./);
    assert.equal(checkPushIds(["1"], A1, checks), null);
    assert.equal(checkPushIds(["1", "2"], A1, checks, { repush: true }), null);
  });
  it("validatePush checks the audit id and 1-200 ids", () => {
    assert.match(validatePush({ audit_id: "nope", shipment_ids: ["1"] }).error, /audit_id/);
    assert.match(validatePush({ shipment_ids: ["1"] }).error, /audit_id/);
    assert.match(validatePush({ audit_id: A1, shipment_ids: [] }).error, /at least one/);
    assert.match(validatePush({ audit_id: A1 }).error, /at least one/);
    const many = Array.from({ length: 201 }, (_, i) => String(i + 1));
    assert.match(validatePush({ audit_id: A1, shipment_ids: many }).error, /up to 200/);
    assert.deepEqual(validatePush({ audit_id: A1, shipment_ids: [" 1 ", 2, "1"] }), { auditId: A1, ids: ["1", "2"], repush: false });
    assert.equal(validatePush({ audit_id: A1, shipment_ids: ["1"], repush: true }).repush, true);
    assert.equal(validatePush({ audit_id: A1, shipment_ids: ["1"], repush: "yes" }).repush, false);
    assert.equal(validatePush({ audit_id: A1, shipment_ids: many.slice(0, 200) }).ids.length, 200);
  });

  it("checkPushIds names ids that are not ready or from another pull", () => {
    const ready = new Set(["1", "2", "3"]);
    const lastPull = new Map([["1", A1], ["2", A2], ["3", A1]]);
    assert.equal(checkPushIds(["1", "3"], A1, { ready, lastPull }), null);
    const msg = checkPushIds(["1", "2", "9"], A1, { ready, lastPull });
    assert.match(msg, /1 shipment is not approved and ready: 9/);
    assert.match(msg, /1 shipment is not from this ERP pull.*: 2/);
    // a ready shipment with no known pull is not from this pull either
    assert.match(checkPushIds(["4"], A1, { ready: new Set(["4"]), lastPull }), /not from this ERP pull.*: 4/);
  });

  it("getInvoiceState reads raw.get_invoice", () => {
    assert.equal(getInvoiceState(null), null);
    assert.equal(getInvoiceState({ other: 1 }), null);
    assert.deepEqual(getInvoiceState({ get_invoice: { status: "requested", requested_at: "t1" } }), { status: "requested", at: "t1", note: null });
    assert.deepEqual(getInvoiceState({ get_invoice: { status: "done", requested_at: "t1", at: "t2", note: "ok" } }), { status: "done", at: "t2", note: "ok" });
  });

  it("pushSourceOf maps audit-log sources", () => {
    assert.equal(pushSourceOf(PUSH_SOURCE), "push_to_erp");
    assert.equal(pushSourceOf("invoice_pipeline"), "pipeline");
    assert.equal(pushSourceOf(undefined), "manual");
  });

  it("groupPushCandidates groups by latest pull, newest run first, and counts unassigned", () => {
    const rows = [view("10"), view("11"), view("12"), view("13"), view("14")];
    const lastPull = new Map([["10", A1], ["11", A3], ["12", A1], ["14", "e0000000-0000-4000-8000-00000000000e"]]);
    const states = new Map([[`${A1}|10`, { status: "failed", at: "t", note: "boom" }]]);
    const { groups, unassigned } = groupPushCandidates({ rows, lastPull, docsSaved: new Set(["11"]), runs, states });
    assert.equal(unassigned, 1);
    assert.deepEqual(groups.map((g) => g.audit_id), [A3, A1, "e0000000-0000-4000-8000-00000000000e"]);
    assert.equal(groups[0].run_number, 3);
    assert.equal(groups[0].pulled_at, "2026-11-20T10:06:00Z");
    assert.equal(groups[1].pulled_at, "2026-11-01T10:01:00Z"); // no finish time: the start
    assert.equal(groups[2].run_number, null);
    assert.deepEqual(groups[1].shipments.map((s) => s.shipment_id), ["10", "12"]);
    assert.deepEqual(groups[0].shipments[0], {
      shipment_id: "11", customer: "Cust 11", carrier: "UPS", tracking: "T11", charge: 100.5,
      invoice_number: "INV11", approved_by: "Isaac", docs_saved: true, get_invoice: null,
    });
    assert.deepEqual(groups[1].shipments[0].get_invoice, { status: "failed", at: "t", note: "boom" });
  });

  it("pushJobs finds the active job and the newest finished one", () => {
    const requests = [
      { id: "r1", status: "done", requested_at: "2026-11-18T10:00:00Z", completed_at: "2026-11-18T11:00:00Z", tracking_numbers: ["1", "2"], note: "done" },
      { id: "r2", status: "error", requested_at: "2026-11-19T10:00:00Z", completed_at: "2026-11-19T10:30:00Z", tracking_numbers: ["3"], note: "x" },
      { id: "r3", status: "claimed", requested_at: "2026-11-20T10:00:00Z", requested_by: "u@freightpop.com", tracking_numbers: ["4", "5", "6"], note: `audit=${A2};from=a;to=b;pause_first=0` },
    ];
    const { active, last } = pushJobs(requests, new Map([["r2", PUSH_SOURCE]]));
    assert.deepEqual(active, { request_id: "r3", status: "claimed", audit_id: A2, count: 3, requested_at: "2026-11-20T10:00:00Z", requested_by: "u@freightpop.com" });
    assert.deepEqual(last, { request_id: "r2", status: "error", completed_at: "2026-11-19T10:30:00Z", count: 1, source: "push_to_erp" });
    assert.deepEqual(pushJobs([]), { active: null, last: null });
    assert.equal(pushJobs([requests[0]], new Map([["r1", "invoice_pipeline"]])).last.source, "pipeline");
  });

  it("loadApprovedReady pages 500 at a time up to 2000", async () => {
    const asked = [];
    const all = Array.from({ length: 2300 }, (_, i) => view(String(i)));
    const out = await loadApprovedReady(async (o) => { asked.push(o); return { rows: all.slice(o.offset, o.offset + o.limit), total: all.length }; });
    assert.equal(out.rows.length, 2000);
    assert.equal(out.total, 2300);
    assert.deepEqual(asked.map((o) => [o.status, o.limit, o.offset]), [["approved_ready", 500, 0], ["approved_ready", 500, 500], ["approved_ready", 500, 1000], ["approved_ready", 500, 1500]]);
    const few = await loadApprovedReady(async (o) => ({ rows: all.slice(0, 3), total: 3, _o: o }));
    assert.equal(few.rows.length, 3);
  });
});

// ---------- loaders ----------

describe("push loaders", () => {
  it("loadPushJobs reads get_invoice requests and their audit-log sources", async () => {
    const sb = fakeSupabase((q) => {
      if (q.table === "fpx_scrape_requests") return { data: [{ id: "r1", status: "done" }, { id: "r2", status: "done" }], error: null };
      if (q.table === "fpx_audit_log") return { data: [{ entity_id: "r1", metadata: { source: PUSH_SOURCE } }, { entity_id: "r2", metadata: {} }], error: null };
      return { data: [], error: null };
    });
    const { requests, sources } = await loadPushJobs(sb);
    assert.equal(requests.length, 2);
    assert.equal(sources.get("r1"), PUSH_SOURCE);
    assert.equal(sources.has("r2"), false);
    assert.equal(arg(sb.calls[0], "eq", "scope"), "get_invoice");
    assert.deepEqual(arg(sb.calls[1], "in", "entity_id"), ["r1", "r2"]);
  });

  it("loadGetInvoiceStates reads raw.get_invoice per audit", async () => {
    const sb = fakeSupabase((q) => {
      const audit = arg(q, "eq", "audit_id");
      if (audit === A1) return { data: [{ id: 1, shipment_id: "10", raw: { get_invoice: { status: "requested", requested_at: "t" } } }, { id: 2, shipment_id: "12", raw: {} }], error: null };
      return { data: [], error: null };
    });
    const states = await loadGetInvoiceStates(sb, new Map([[A1, ["10", "12"]], [A3, ["11"]]]));
    assert.deepEqual([...states.keys()], [`${A1}|10`]);
    assert.equal(sb.calls.length, 2);
    assert.equal(sb.calls.some((q) => q.ops.some((o) => o[0] === "update")), false); // read only
  });

  it("loadPushChecks reads buckets and latest pulls", async () => {
    const sb = fakeSupabase((q) => {
      if (q.table === "fpx_erp_invoicing") return { data: [{ shipment_id: "1", bucket: "approved_ready" }, { shipment_id: "2", bucket: "no_invoice" }], error: null };
      if (q.table === "fpx_erp_transactions") return { data: [{ shipment_id: "1", last_pull_audit_id: A1 }, { shipment_id: "2", last_pull_audit_id: null }], error: null };
      return { data: [], error: null };
    });
    const { ready, lastPull } = await loadPushChecks(sb, ["1", "2"]);
    assert.deepEqual([...ready], ["1"]);
    assert.deepEqual([...lastPull], [["1", A1]]);
  });
});

// ---------- routes ----------

function makeApp({ deps = {}, user = { role: "user", email: "u@freightpop.com" } } = {}) {
  const queued = [];
  const pageCalls = [];
  const sb = fakeSupabase(() => ({ data: [], error: null }));
  const rows = [view("10"), view("11"), view("12"), view("13")];
  const router = buildInvoiceFlowRouter({
    supabase: sb,
    runsCache: createMemoCache(),
    countsCache: createMemoCache(),
    logAudit: async () => {},
    loadRuns: async () => ({ runs, requests: [] }),
    loadNotExportedPage: async (o) => { pageCalls.push(o); return { rows: rows.slice(o.offset, o.offset + o.limit), total: rows.length }; },
    pageLookups: async () => ({ docsSaved: new Set(["10"]), lastPull: new Map([["10", A1], ["11", A3], ["12", A1]]) }),
    loadGetInvoiceStates: async (idsByAudit) => {
      assert.deepEqual([...idsByAudit.entries()], [[A1, ["10", "12"]], [A3, ["11"]]]);
      return new Map([[`${A1}|12`, { status: "done", at: "2026-11-19T00:00:00Z", note: null }]]);
    },
    loadPushJobs: async () => ({
      requests: [
        { id: "r9", status: "pending", requested_at: "2026-11-20T12:00:00Z", requested_by: "x@freightpop.com", tracking_numbers: ["99"], note: `audit=${A2};from=a;to=b;pause_first=1` },
        { id: "r8", status: "done", requested_at: "2026-11-19T12:00:00Z", completed_at: "2026-11-19T13:00:00Z", tracking_numbers: ["1", "2"], note: "2 done" },
      ],
      sources: new Map([["r8", "invoice_pipeline"]]),
    }),
    loadPushChecks: async () => ({ ready: new Set(["10", "11", "12"]), lastPull: new Map([["10", A1], ["11", A3], ["12", A1]]) }),
    queueGetInvoice: async (args, opts) => { queued.push({ args, opts }); return { ok: true, request: { id: "req-1", status: "pending", scope: "get_invoice" } }; },
    ...deps,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use("/api/invoice-flow", router);
  return { app, queued, pageCalls };
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
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe("GET /api/invoice-flow/push", () => {
  it("groups approved_ready shipments by latest pull, newest run first", async () => {
    const { app, pageCalls } = makeApp();
    const r = await call(app, "GET", "/api/invoice-flow/push");
    assert.equal(r.status, 200);
    assert.equal(pageCalls[0].status, "approved_ready");
    assert.equal(pageCalls[0].limit, 500);
    assert.equal(r.body.total, 4);
    assert.equal(r.body.unassigned, 1);
    assert.deepEqual(r.body.groups.map((g) => [g.audit_id, g.run_number]), [[A3, 3], [A1, 1]]);
    const a1 = r.body.groups[1];
    assert.deepEqual(a1.shipments.map((s) => s.shipment_id), ["10", "12"]);
    assert.equal(a1.shipments[0].docs_saved, true);
    assert.equal(a1.shipments[0].get_invoice, null);
    assert.deepEqual(a1.shipments[1].get_invoice, { status: "done", at: "2026-11-19T00:00:00Z", note: null });
    assert.deepEqual(r.body.active, { request_id: "r9", status: "pending", audit_id: A2, count: 1, requested_at: "2026-11-20T12:00:00Z", requested_by: "x@freightpop.com" });
    assert.deepEqual(r.body.last, { request_id: "r8", status: "done", completed_at: "2026-11-19T13:00:00Z", count: 2, source: "pipeline" });
  });

  it("answers 500 when a loader fails", async () => {
    const { app } = makeApp({ deps: { loadPushJobs: async () => { throw new Error("db down"); } } });
    const r = await call(app, "GET", "/api/invoice-flow/push");
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db down");
  });
});

describe("POST /api/invoice-flow/push", () => {
  it("rejects a bad audit id, no ids and more than 200", async () => {
    const { app, queued } = makeApp();
    let r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: "x", shipment_ids: ["10"] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /audit_id/);
    r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: A1, shipment_ids: [] });
    assert.equal(r.status, 400);
    r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: A1, shipment_ids: Array.from({ length: 201 }, (_, i) => `S${i}`) });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /200/);
    assert.equal(queued.length, 0);
  });

  it("rejects ids that are not approved_ready, naming them", async () => {
    const { app, queued } = makeApp();
    const r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: A1, shipment_ids: ["10", "77"] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not approved and ready: 77/);
    assert.equal(queued.length, 0);
  });

  it("rejects ids whose latest pull is another audit, naming them", async () => {
    const { app, queued } = makeApp();
    const r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: A1, shipment_ids: ["10", "11"] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not from this ERP pull.*: 11/);
    assert.equal(queued.length, 0);
  });

  it("queues one Get Invoice job: no pause, every button, marked push_to_erp", async () => {
    const { app, queued } = makeApp();
    const r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: A1, shipment_ids: ["10", "12", "10"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { request: { id: "req-1", status: "pending" }, count: 2 });
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].args, { auditId: A1, shipmentIds: ["10", "12"], pauseAfterFirst: false, buttons: null, source: "push_to_erp" });
    assert.equal(queued[0].opts.req.user.email, "u@freightpop.com"); // the request is passed for the audit log
  });

  it("passes a 409 through with a readable message", async () => {
    const { app } = makeApp({ deps: { queueGetInvoice: async () => ({ ok: false, status: 409, error: "An invoice run is already queued or running" }) } });
    const r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: A1, shipment_ids: ["10"] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "A Get Invoice run is already queued or running. Try again when it finishes.");
  });

  it("passes other queue errors through", async () => {
    const { app } = makeApp({ deps: { queueGetInvoice: async () => ({ ok: false, status: 400, error: "1 shipment is not in this ERP pull: 10" }) } });
    const r = await call(app, "POST", "/api/invoice-flow/push", { audit_id: A1, shipment_ids: ["10"] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not in this ERP pull/);
  });
});
