import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOOKBACK_JOBS,
  JOB_SCOPE,
  DEFAULT_THRESHOLD_HOURS,
  normalizeLookbackBody,
  resolveRunAs,
  planRequest,
  findOpenDuplicate,
  parseThresholds,
  datasetForScope,
  datasetForRun,
  buildHealth,
} from "../lib/lookback.js";

// Pure-logic tests for the lookback route: what gets queued, who it runs as,
// and the data-freshness report.

const NOW = new Date("2026-11-17T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const FRESH = {
  tracking: hoursAgo(1),
  erp_transactions: hoursAgo(2),
  audit_approvals: hoursAgo(3),
  shipment_details: hoursAgo(4),
};
const dataset = (health, key) => health.datasets.find((d) => d.key === key);

describe("constants", () => {
  it("match the contract", () => {
    assert.deepEqual(LOOKBACK_JOBS, ["erp", "shipment_details", "tracking"]);
    assert.deepEqual(JOB_SCOPE, { erp: "erp_audit", shipment_details: "shipment_details", tracking: "all" });
    assert.deepEqual(DEFAULT_THRESHOLD_HOURS, { tracking: 6, erp: 36, approvals: 36, details: 36 });
  });
});

describe("normalizeLookbackBody", () => {
  it("applies the defaults to an empty or missing body", () => {
    const want = { ok: true, jobs: ["erp"], months: 1, shipment_type: "non-parcel", modes: null, run_as: null };
    assert.deepEqual(normalizeLookbackBody({}), want);
    assert.deepEqual(normalizeLookbackBody(undefined), want);
    assert.deepEqual(normalizeLookbackBody(null), want);
  });

  it("accepts a single job string and dedupes a list", () => {
    assert.deepEqual(normalizeLookbackBody({ jobs: "tracking" }).jobs, ["tracking"]);
    assert.deepEqual(normalizeLookbackBody({ jobs: ["erp", "tracking", "erp"] }).jobs, ["erp", "tracking"]);
  });

  it("rejects an unknown job and names the allowed values", () => {
    const r = normalizeLookbackBody({ jobs: ["erp", "invoices"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /invoices/);
    for (const job of LOOKBACK_JOBS) assert.ok(r.error.includes(job));
  });

  it("rejects an empty jobs array and names the allowed values", () => {
    const r = normalizeLookbackBody({ jobs: [] });
    assert.equal(r.ok, false);
    for (const job of LOOKBACK_JOBS) assert.ok(r.error.includes(job));
  });

  it("accepts whole months 1-12, including numeric strings", () => {
    assert.equal(normalizeLookbackBody({ months: 12 }).months, 12);
    assert.equal(normalizeLookbackBody({ months: "6" }).months, 6);
  });

  it("rejects months that are out of range, fractional or not numbers", () => {
    for (const months of [0, 13, 1.5, "abc", "", -1, true]) {
      assert.deepEqual(normalizeLookbackBody({ months }), {
        ok: false,
        error: "months must be a whole number from 1 to 12",
      });
    }
  });

  it("accepts the three shipment types and rejects anything else", () => {
    for (const t of ["non-parcel", "parcel", "both"]) {
      assert.equal(normalizeLookbackBody({ shipment_type: t }).shipment_type, t);
    }
    const r = normalizeLookbackBody({ shipment_type: "ltl" });
    assert.equal(r.ok, false);
    assert.match(r.error, /shipment_type/);
  });

  it("filters and dedupes modes", () => {
    assert.deepEqual(normalizeLookbackBody({ modes: ["Parcel", "Air", "LTL", "Parcel"] }).modes, ["LTL", "Parcel"]);
  });

  it("turns all three modes into null", () => {
    assert.equal(normalizeLookbackBody({ modes: ["Parcel", "Truckload", "LTL"] }).modes, null);
  });

  it("rejects a modes array with nothing valid in it", () => {
    assert.deepEqual(normalizeLookbackBody({ modes: ["Air"] }), { ok: false, error: "Pick at least one mode" });
    assert.deepEqual(normalizeLookbackBody({ modes: [] }), { ok: false, error: "Pick at least one mode" });
  });

  it("trims run_as and treats blank as null", () => {
    assert.equal(normalizeLookbackBody({ run_as: "  Pat@x.com " }).run_as, "Pat@x.com");
    assert.equal(normalizeLookbackBody({ run_as: "   " }).run_as, null);
    assert.equal(normalizeLookbackBody({ run_as: 42 }).run_as, null);
  });
});

describe("resolveRunAs", () => {
  const user = { email: "Pat@x.com", role: "user" };
  const admin = { email: "boss@x.com", role: "admin" };
  const key = { name: "cron", scopes: ["write"] };

  it("runs as the signed-in user when no run_as is given", () => {
    assert.deepEqual(resolveRunAs({ user }), { ok: true, email: "Pat@x.com", source: "self" });
  });

  it("treats a run_as equal to the user's own email (any case) as self", () => {
    assert.deepEqual(resolveRunAs({ user, runAs: " pat@X.com " }), { ok: true, email: "Pat@x.com", source: "self" });
  });

  it("stops a non-admin running as someone else", () => {
    assert.deepEqual(resolveRunAs({ user, runAs: "other@x.com" }), {
      ok: false,
      status: 403,
      error: "Only admins can run a lookback as someone else",
    });
  });

  it("lets an admin run as someone else, trimmed with case untouched", () => {
    assert.deepEqual(resolveRunAs({ user: admin, runAs: " Other@X.com " }), {
      ok: true,
      email: "Other@X.com",
      source: "run_as",
    });
  });

  it("rejects an admin's run_as that is not an email", () => {
    const r = resolveRunAs({ user: admin, runAs: "other" });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it("ignores env and last runner for a signed-in user", () => {
    const r = resolveRunAs({ user, envRunAs: "env@x.com", lastRunner: "last@x.com" });
    assert.deepEqual(r, { ok: true, email: "Pat@x.com", source: "self" });
  });

  it("needs the write or admin scope on an API key", () => {
    assert.deepEqual(resolveRunAs({ apiKey: { name: "ro", scopes: ["read"] }, runAs: "pat@x.com" }), {
      ok: false,
      status: 403,
      error: "API key needs the 'write' scope to queue lookbacks",
    });
    assert.equal(resolveRunAs({ apiKey: { name: "ro" }, runAs: "pat@x.com" }).status, 403);
    assert.equal(resolveRunAs({ apiKey: { name: "adm", scopes: ["admin"] }, runAs: "pat@x.com" }).ok, true);
  });

  it("picks run_as, then env, then the last runner for an API key", () => {
    const all = { apiKey: key, runAs: " a@x.com ", envRunAs: "b@x.com", lastRunner: "c@x.com" };
    assert.deepEqual(resolveRunAs(all), { ok: true, email: "a@x.com", source: "run_as" });
    assert.deepEqual(resolveRunAs({ ...all, runAs: "  " }), { ok: true, email: "b@x.com", source: "env" });
    assert.deepEqual(resolveRunAs({ ...all, runAs: null, envRunAs: "" }), {
      ok: true,
      email: "c@x.com",
      source: "last_runner",
    });
  });

  it("explains what to pass when an API key has nobody to run as", () => {
    const r = resolveRunAs({ apiKey: key });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /FreightPOP login/);
    assert.match(r.error, /run_as/);
    assert.match(r.error, /FPX_LOOKBACK_RUN_AS/);
  });

  it("rejects a chosen value without an @", () => {
    assert.equal(resolveRunAs({ apiKey: key, runAs: "schedule" }).status, 400);
    assert.equal(resolveRunAs({ apiKey: key, envRunAs: "service" }).status, 400);
    assert.equal(resolveRunAs({ apiKey: key, lastRunner: "schedule" }).status, 400);
  });

  it("returns 401 with neither a user nor an API key", () => {
    assert.equal(resolveRunAs({ runAs: "pat@x.com" }).status, 401);
    assert.equal(resolveRunAs({}).ok, false);
    assert.equal(resolveRunAs().status, 401);
  });
});

describe("planRequest", () => {
  const opts = { months: 3, shipment_type: "both", modes: ["LTL"] };

  it("plans an ERP pull", () => {
    assert.deepEqual(planRequest("erp", opts), { scope: "erp_audit", note: "months=3;type=both", modes: null });
  });

  it("plans a shipment details sweep", () => {
    assert.deepEqual(planRequest("shipment_details", opts), { scope: "shipment_details", note: "all=1", modes: null });
  });

  it("plans a tracking scrape with its modes", () => {
    assert.deepEqual(planRequest("tracking", opts), { scope: "all", note: null, modes: ["LTL"] });
    assert.deepEqual(planRequest("tracking", { ...opts, modes: null }), { scope: "all", note: null, modes: null });
  });
});

describe("findOpenDuplicate", () => {
  const erpPlan = planRequest("erp", { months: 2, shipment_type: "parcel" });
  const row = (over) => ({
    id: "r1",
    status: "pending",
    scope: "erp_audit",
    note: "months=2;type=parcel",
    modes: null,
    requested_by: "someone@x.com",
    requested_at: hoursAgo(1),
    ...over,
  });

  it("matches an ERP pull with the same months and type, whoever asked", () => {
    const open = [row({ note: "Months = 2; Type = PARCEL" })];
    assert.equal(findOpenDuplicate("erp", erpPlan, open), open[0]);
  });

  it("does not match different months or a different type", () => {
    assert.equal(findOpenDuplicate("erp", erpPlan, [row({ note: "months=3;type=parcel" })]), null);
    assert.equal(findOpenDuplicate("erp", erpPlan, [row({ note: "months=2;type=both" })]), null);
  });

  it("reads a missing note with the worker's defaults (3 months, non-parcel)", () => {
    const plan = planRequest("erp", { months: 3, shipment_type: "non-parcel" });
    const open = [row({ note: null })];
    assert.equal(findOpenDuplicate("erp", plan, open), open[0]);
    assert.equal(findOpenDuplicate("erp", erpPlan, open), null);
  });

  it("does not match a fixed-range or backfill pull", () => {
    assert.equal(findOpenDuplicate("erp", erpPlan, [row({ note: "months=2;type=parcel;from=2026-01-01" })]), null);
    assert.equal(findOpenDuplicate("erp", erpPlan, [row({ note: "months=2;type=parcel;backfill=1" })]), null);
  });

  it("ignores rows of another scope", () => {
    assert.equal(findOpenDuplicate("erp", erpPlan, [row({ scope: "approval_check" })]), null);
    assert.equal(findOpenDuplicate("erp", erpPlan, [row({ scope: "all" })]), null);
  });

  it("ignores rows that are not pending or claimed", () => {
    assert.equal(findOpenDuplicate("erp", erpPlan, [row({ status: "done" })]), null);
  });

  it("matches a details sweep but not a single-shipment request", () => {
    const plan = planRequest("shipment_details", {});
    const sweep = row({ scope: "shipment_details", note: "x=1; all=1" });
    assert.equal(findOpenDuplicate("shipment_details", plan, [sweep]), sweep);
    assert.equal(findOpenDuplicate("shipment_details", plan, [row({ scope: "shipment_details", note: "q=12345" })]), null);
    assert.equal(findOpenDuplicate("shipment_details", plan, [row({ scope: "shipment_details", note: "all=10" })]), null);
    assert.equal(findOpenDuplicate("shipment_details", plan, [row({ scope: "shipment_details", note: null })]), null);
  });

  it("matches tracking on the same modes in any order", () => {
    const plan = planRequest("tracking", { modes: ["LTL", "Parcel"] });
    const same = row({ scope: "all", note: null, modes: ["Parcel", "LTL"] });
    assert.equal(findOpenDuplicate("tracking", plan, [same]), same);
    assert.equal(findOpenDuplicate("tracking", plan, [row({ scope: "all", modes: ["LTL"] })]), null);
    assert.equal(findOpenDuplicate("tracking", plan, [row({ scope: "all", modes: null })]), null);
    assert.equal(findOpenDuplicate("tracking", plan, [row({ scope: "selected", modes: ["LTL", "Parcel"] })]), null);
  });

  it("treats null and empty modes as the same thing", () => {
    const plan = planRequest("tracking", { modes: null });
    const empty = row({ scope: "all", note: null, modes: [] });
    assert.equal(findOpenDuplicate("tracking", plan, [empty]), empty);
  });

  it("prefers a pending row over a claimed one, then the newest", () => {
    const claimed = row({ id: "c", status: "claimed", requested_at: hoursAgo(0.5) });
    const oldPending = row({ id: "p1", requested_at: hoursAgo(5) });
    const newPending = row({ id: "p2", requested_at: hoursAgo(2) });
    assert.equal(findOpenDuplicate("erp", erpPlan, [claimed, oldPending, newPending]).id, "p2");
    assert.equal(findOpenDuplicate("erp", erpPlan, [claimed]).id, "c");
  });

  it("returns null for no rows", () => {
    assert.equal(findOpenDuplicate("erp", erpPlan, []), null);
    assert.equal(findOpenDuplicate("erp", erpPlan, null), null);
  });
});

describe("parseThresholds", () => {
  it("returns the defaults for an empty or missing query", () => {
    assert.deepEqual(parseThresholds({}), DEFAULT_THRESHOLD_HOURS);
    assert.deepEqual(parseThresholds(undefined), DEFAULT_THRESHOLD_HOURS);
  });

  it("reads each query parameter", () => {
    assert.deepEqual(
      parseThresholds({ tracking_hours: "2", erp_hours: "48", approvals_hours: 12.5, details_hours: "8760" }),
      { tracking: 2, erp: 48, approvals: 12.5, details: 8760 }
    );
  });

  it("falls back to the default for anything out of range or not a number", () => {
    assert.deepEqual(
      parseThresholds({ tracking_hours: "0", erp_hours: "-5", approvals_hours: "soon", details_hours: "8761" }),
      DEFAULT_THRESHOLD_HOURS
    );
    assert.deepEqual(parseThresholds({ tracking_hours: "", erp_hours: "Infinity" }), DEFAULT_THRESHOLD_HOURS);
  });
});

describe("datasetForScope", () => {
  it("maps each scope to its dataset", () => {
    assert.equal(datasetForScope("all"), "tracking");
    assert.equal(datasetForScope("selected"), "tracking");
    assert.equal(datasetForScope(null), "tracking");
    assert.equal(datasetForScope(undefined), "tracking");
    assert.equal(datasetForScope("erp_audit"), "erp_transactions");
    assert.equal(datasetForScope("approval_check"), "audit_approvals");
    assert.equal(datasetForScope("shipment_details"), "shipment_details");
    assert.equal(datasetForScope("get_invoice"), null);
  });
});

describe("datasetForRun", () => {
  const scopes = new Map([
    ["req-erp", "erp_audit"],
    ["req-inv", "get_invoice"],
    ["req-old", null],
  ]);

  it("uses the scope of the request with the same id", () => {
    assert.equal(datasetForRun({ id: "req-erp", counts: { saved: 3 } }, scopes), "erp_transactions");
    assert.equal(datasetForRun({ id: "req-inv" }, scopes), null);
    assert.equal(datasetForRun({ id: "req-old" }, scopes), "tracking");
  });

  it("treats sch_ runs as tracking scrapes", () => {
    assert.equal(datasetForRun({ id: "sch_123" }, scopes), "tracking");
  });

  it("splits mir_ runs by their counts", () => {
    assert.equal(datasetForRun({ id: "mir_1", counts: { approvedRows: 4 } }, scopes), "audit_approvals");
    assert.equal(datasetForRun({ id: "mir_2", counts: { uploaded: 9 } }, scopes), "erp_transactions");
    assert.equal(datasetForRun({ id: "mir_3", counts: { reportRows: 0 } }, scopes), "erp_transactions");
    assert.equal(datasetForRun({ id: "mir_4", counts: {} }, scopes), null);
    assert.equal(datasetForRun({ id: "mir_5", counts: null }, scopes), null);
  });

  it("returns null for anything it cannot place", () => {
    assert.equal(datasetForRun({ id: "something-else", counts: { saved: 1 } }, scopes), null);
    assert.equal(datasetForRun({ id: "sch_1" }, undefined), "tracking");
    assert.equal(datasetForRun({}, scopes), null);
    assert.equal(datasetForRun(null, scopes), null);
  });
});

describe("buildHealth", () => {
  it("always returns the four datasets in order with their labels and thresholds", () => {
    const h = buildHealth({ now: NOW, thresholds: { tracking: 1, erp: 2, approvals: 3, details: 4 }, newest: FRESH });
    assert.equal(h.generated_at, NOW.toISOString());
    assert.deepEqual(h.thresholds_hours, { tracking: 1, erp: 2, approvals: 3, details: 4 });
    assert.deepEqual(
      h.datasets.map((d) => [d.key, d.label, d.threshold_hours]),
      [
        ["tracking", "Tracking scrape", 1],
        ["erp_transactions", "ERP transactions", 2],
        ["audit_approvals", "Audit approvals", 3],
        ["shipment_details", "Shipment details", 4],
      ]
    );
  });

  it("is ok when every dataset is fresh and nothing failed", () => {
    const h = buildHealth({ now: NOW, requests: [], runs: [], newest: FRESH });
    assert.equal(h.ok, true);
    const t = dataset(h, "tracking");
    assert.equal(t.newest_data_at, FRESH.tracking);
    assert.equal(t.age_hours, 1);
    assert.equal(t.stale, false);
    assert.equal(t.stale_reason, null);
    assert.equal(t.failing, false);
    assert.equal(t.last_success, null);
    assert.equal(t.last_failure, null);
    assert.deepEqual(t.active, []);
  });

  it("marks a dataset stale when its newest data is older than the threshold", () => {
    const h = buildHealth({ now: NOW, newest: { ...FRESH, erp_transactions: hoursAgo(41.2) } });
    const erp = dataset(h, "erp_transactions");
    assert.equal(erp.age_hours, 41.2);
    assert.equal(erp.stale, true);
    assert.equal(erp.stale_reason, "Newest data is 41.2 hours old (limit 36)");
    assert.equal(h.ok, false);
    assert.equal(dataset(h, "tracking").stale, false);
  });

  it("marks a dataset stale when there is no data", () => {
    const h = buildHealth({ now: NOW, newest: { ...FRESH, shipment_details: null } });
    const d = dataset(h, "shipment_details");
    assert.equal(d.newest_data_at, null);
    assert.equal(d.age_hours, null);
    assert.equal(d.stale, true);
    assert.equal(d.stale_reason, "No data yet");
    assert.equal(h.ok, false);
  });

  it("is not stale inside the threshold, and honours a custom threshold", () => {
    const newest = { ...FRESH, tracking: hoursAgo(5.9) };
    assert.equal(dataset(buildHealth({ now: NOW, newest }), "tracking").stale, false);
    const tight = buildHealth({ now: NOW, newest, thresholds: { ...DEFAULT_THRESHOLD_HOURS, tracking: 2 } });
    assert.equal(dataset(tight, "tracking").stale, true);
    assert.equal(dataset(tight, "tracking").stale_reason, "Newest data is 5.9 hours old (limit 2)");
  });

  it("flags failing when the last failure is newer than the last success", () => {
    const requests = [
      { id: "a", scope: "erp_audit", status: "done", requested_by: "pat@x.com", completed_at: hoursAgo(10), result_count: 120, note: "Uploaded 120" },
      { id: "b", scope: "erp_audit", status: "error", requested_by: "sam@x.com", completed_at: hoursAgo(2), result_count: null, note: "Login failed" },
    ];
    const h = buildHealth({ now: NOW, requests, newest: FRESH });
    const erp = dataset(h, "erp_transactions");
    assert.equal(erp.failing, true);
    assert.deepEqual(erp.last_success, { at: hoursAgo(10), by: "pat@x.com", rows: 120, note: "Uploaded 120", id: "a", via: "request" });
    assert.deepEqual(erp.last_failure, { at: hoursAgo(2), by: "sam@x.com", note: "Login failed", id: "b", via: "request" });
    assert.equal(h.ok, false);
    assert.equal(dataset(h, "tracking").failing, false);
  });

  it("is not failing once a newer success follows the failure, and is failing with no success at all", () => {
    const failure = { id: "b", scope: "erp_audit", status: "error", requested_by: "sam@x.com", completed_at: hoursAgo(5), note: "boom" };
    const success = { id: "c", scope: "erp_audit", status: "done", requested_by: "sam@x.com", completed_at: hoursAgo(1), result_count: 4 };
    const recovered = buildHealth({ now: NOW, requests: [failure, success], newest: FRESH });
    assert.equal(dataset(recovered, "erp_transactions").failing, false);
    assert.equal(dataset(recovered, "erp_transactions").last_failure.id, "b");
    assert.equal(recovered.ok, true);
    const never = buildHealth({ now: NOW, requests: [failure], newest: FRESH });
    assert.equal(dataset(never, "erp_transactions").failing, true);
    assert.equal(dataset(never, "erp_transactions").last_success, null);
  });

  it("counts a request and its run once, filling rows from the run", () => {
    const requests = [
      { id: "same", scope: "all", status: "done", requested_by: "pat@x.com", completed_at: hoursAgo(3), result_count: null, note: "Saved 55" },
    ];
    const runs = [
      // The run finished later and failed on paper; the request's fields win.
      { id: "same", source: "manual", user_email: "other@x.com", finished_at: hoursAgo(2), ok: false, note: "run note", counts: { saved: 55 } },
    ];
    const t = dataset(buildHealth({ now: NOW, requests, runs, newest: FRESH }), "tracking");
    assert.deepEqual(t.last_success, { at: hoursAgo(3), by: "pat@x.com", rows: 55, note: "Saved 55", id: "same", via: "request" });
    assert.equal(t.last_failure, null);
    assert.equal(t.failing, false);
  });

  it("keeps the request's own row count when it has one", () => {
    const requests = [{ id: "same", scope: "all", status: "done", requested_by: "pat@x.com", completed_at: hoursAgo(3), result_count: 7 }];
    const runs = [{ id: "same", source: "manual", finished_at: hoursAgo(3), ok: true, counts: { saved: 55 } }];
    assert.equal(dataset(buildHealth({ now: NOW, requests, runs, newest: FRESH }), "tracking").last_success.rows, 7);
  });

  it("takes the newest of the two sources", () => {
    const requests = [
      { id: "req", scope: "selected", status: "done", requested_by: "pat@x.com", completed_at: hoursAgo(8), result_count: 3 },
    ];
    const runs = [
      { id: "sch_9", source: "schedule", user_email: "sam@x.com", finished_at: hoursAgo(1), ok: true, note: "Morning", counts: { saved: 40 } },
      { id: "sch_8", source: "schedule", user_email: "sam@x.com", finished_at: hoursAgo(20), ok: false, note: "Timed out", counts: null },
    ];
    const t = dataset(buildHealth({ now: NOW, requests, runs, newest: FRESH }), "tracking");
    assert.deepEqual(t.last_success, { at: hoursAgo(1), by: "sam@x.com", rows: 40, note: "Morning", id: "sch_9", via: "schedule" });
    assert.deepEqual(t.last_failure, { at: hoursAgo(20), by: "sam@x.com", note: "Timed out", id: "sch_8", via: "schedule" });
    assert.equal(t.failing, false);

    const older = dataset(
      buildHealth({ now: NOW, requests, runs: [{ ...runs[0], finished_at: hoursAgo(30) }], newest: FRESH }),
      "tracking"
    );
    assert.equal(older.last_success.id, "req");
    assert.equal(older.last_success.via, "request");
  });

  it("files the daily mirror runs under their datasets with the right row counts", () => {
    const runs = [
      { id: "mir_a", source: "manual", user_email: "svc@x.com", finished_at: hoursAgo(4), ok: true, counts: { approvedRows: 30, matched: 12 } },
      { id: "mir_e", source: "manual", user_email: "svc@x.com", finished_at: hoursAgo(5), ok: true, counts: { reportRows: 90, uploaded: 88 } },
      { id: "mir_x", source: "manual", finished_at: hoursAgo(1), ok: false, counts: {} },
      { id: "unknown", source: "manual", finished_at: hoursAgo(1), ok: false, counts: { saved: 1 } },
    ];
    const h = buildHealth({ now: NOW, runs, newest: FRESH });
    assert.deepEqual(dataset(h, "audit_approvals").last_success, { at: hoursAgo(4), by: "svc@x.com", rows: 12, note: null, id: "mir_a", via: "run" });
    assert.equal(dataset(h, "erp_transactions").last_success.rows, 88);
    assert.equal(h.ok, true);
  });

  it("lists pending and claimed requests per dataset, oldest first, with their notes", () => {
    const requests = [
      { id: "n", scope: "erp_audit", status: "pending", requested_by: "pat@x.com", requested_at: hoursAgo(1), claimed_at: null, note: "months=1;type=both" },
      { id: "o", scope: "erp_audit", status: "claimed", requested_by: "sam@x.com", requested_at: hoursAgo(3), claimed_at: hoursAgo(2), note: "months=6;type=parcel" },
      { id: "d", scope: "shipment_details", status: "pending", requested_by: "pat@x.com", requested_at: hoursAgo(1), note: "all=1" },
      { id: "t", scope: "all", status: "pending", requested_by: "pat@x.com", requested_at: hoursAgo(1), note: 5 },
      { id: "i", scope: "get_invoice", status: "pending", requested_by: "pat@x.com", requested_at: hoursAgo(1) },
      { id: "z", scope: "erp_audit", status: "done", requested_by: "pat@x.com", requested_at: hoursAgo(9), completed_at: hoursAgo(8) },
    ];
    const h = buildHealth({ now: NOW, requests, newest: FRESH });
    assert.deepEqual(dataset(h, "erp_transactions").active, [
      { request_id: "o", status: "claimed", requested_by: "sam@x.com", requested_at: hoursAgo(3), claimed_at: hoursAgo(2), note: "months=6;type=parcel" },
      { request_id: "n", status: "pending", requested_by: "pat@x.com", requested_at: hoursAgo(1), claimed_at: null, note: "months=1;type=both" },
    ]);
    assert.deepEqual(dataset(h, "shipment_details").active.map((a) => [a.request_id, a.note]), [["d", "all=1"]]);
    assert.deepEqual(dataset(h, "tracking").active.map((a) => [a.request_id, a.note]), [["t", null]]);
    assert.deepEqual(dataset(h, "audit_approvals").active, []);
    assert.equal(h.ok, true);
  });

  it("ignores finished rows with no usable time", () => {
    const requests = [{ id: "a", scope: "all", status: "error", completed_at: null, note: "x" }];
    const runs = [
      { id: "sch_1", source: "schedule", finished_at: "not a date", ok: false },
      { id: "sch_2", source: "schedule", finished_at: hoursAgo(1) }, // ok missing
    ];
    const t = dataset(buildHealth({ now: NOW, requests, runs, newest: FRESH }), "tracking");
    assert.equal(t.last_failure, null);
    assert.equal(t.last_success, null);
    assert.equal(t.failing, false);
  });

  it("does not throw on empty or odd input", () => {
    const empty = buildHealth({ now: NOW });
    assert.equal(empty.ok, false);
    assert.equal(empty.datasets.length, 4);
    assert.deepEqual(empty.thresholds_hours, DEFAULT_THRESHOLD_HOURS);
    for (const d of empty.datasets) {
      assert.equal(d.stale, true);
      assert.equal(d.stale_reason, "No data yet");
      assert.deepEqual(d.active, []);
    }

    assert.doesNotThrow(() => buildHealth());
    assert.equal(typeof buildHealth().generated_at, "string");
    const odd = buildHealth({
      now: NOW,
      thresholds: null,
      requests: [null, 7, {}, { id: null, status: "done" }, { scope: "erp_audit", status: "pending", requested_at: "nope" }],
      runs: [null, "x", {}, { id: 12, ok: true, finished_at: hoursAgo(1) }, { id: "mir_1", ok: true, finished_at: hoursAgo(1), counts: "bad" }],
      newest: { tracking: "garbage", erp_transactions: 12345, audit_approvals: undefined },
    });
    assert.equal(odd.datasets.length, 4);
    assert.equal(dataset(odd, "tracking").stale, true);
    assert.equal(dataset(odd, "erp_transactions").active.length, 1);
  });
});
