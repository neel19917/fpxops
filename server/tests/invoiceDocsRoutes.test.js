import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLogQuery, pickLog, lastIdOf, startOfUtcDay, sumCost } from "../routes/invoiceDocs.js";

describe("invoice docs log route helpers", () => {
  it("parseLogQuery: defaults", () => {
    assert.deepEqual(parseLogQuery({}), { since_id: null, document_id: null, shipment_id: null, levels: null, limit: 200 });
  });

  it("parseLogQuery: limit is clamped to 1..1000", () => {
    assert.equal(parseLogQuery({ limit: "5000" }).limit, 1000);
    assert.equal(parseLogQuery({ limit: "0" }).limit, 1);
    assert.equal(parseLogQuery({ limit: "abc" }).limit, 200);
  });

  it("parseLogQuery: since_id must be a whole number", () => {
    assert.equal(parseLogQuery({ since_id: "42" }).since_id, 42);
    assert.equal(parseLogQuery({ since_id: "" }).since_id, null);
    assert.ok(parseLogQuery({ since_id: "x" }).error);
    assert.ok(parseLogQuery({ since_id: "-1" }).error);
    assert.ok(parseLogQuery({ since_id: "1.5" }).error);
  });

  it("parseLogQuery: document_id must be a uuid; shipment_id is trimmed", () => {
    assert.ok(parseLogQuery({ document_id: "nope" }).error);
    const id = "3f2b6c1e-8a4d-4e0b-9c57-1d2e3f4a5b6c";
    assert.equal(parseLogQuery({ document_id: id }).document_id, id);
    assert.equal(parseLogQuery({ shipment_id: " 15612931 " }).shipment_id, "15612931");
  });

  it("parseLogQuery: level takes one level or a comma list", () => {
    assert.deepEqual(parseLogQuery({ level: "error" }).levels, ["error"]);
    assert.deepEqual(parseLogQuery({ level: "warn, error,warn" }).levels, ["warn", "error"]);
    assert.ok(parseLogQuery({ level: "debug" }).error);
  });

  it("pickLog: numbers and unknown levels", () => {
    const l = pickLog({ id: "7", at: "2026-11-17T00:00:00Z", level: "weird", message: "m", ms: "120", cost_usd: "0.0123" });
    assert.equal(l.id, 7);
    assert.equal(l.level, "info");
    assert.equal(l.ms, 120);
    assert.equal(l.cost_usd, 0.0123);
    assert.equal(l.shipment_id, null);
    assert.equal(pickLog({ id: 1, ms: null, cost_usd: null }).cost_usd, null);
  });

  it("lastIdOf: newest id, or the one passed in when there are no lines", () => {
    assert.equal(lastIdOf([{ id: 3 }, { id: 9 }, { id: 5 }]), 9);
    assert.equal(lastIdOf([], 12), 12);
    assert.equal(lastIdOf([]), null);
  });

  it("startOfUtcDay: midnight UTC", () => {
    assert.equal(startOfUtcDay(new Date("2026-11-17T23:59:59.999Z")), "2026-11-17T00:00:00.000Z");
    assert.equal(startOfUtcDay(new Date("2026-11-18T00:00:00.000Z")), "2026-11-18T00:00:00.000Z");
  });

  it("sumCost: ignores blanks and rounds", () => {
    assert.equal(sumCost([{ cost_usd: 0.01 }, { cost_usd: "0.02" }, { cost_usd: null }, {}]), 0.03);
    assert.equal(sumCost(null), 0);
  });
});
