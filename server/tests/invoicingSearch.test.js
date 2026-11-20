import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_ID_CAP, ERP_BUCKETS, cleanSearchTerm, classifyQuery, searchPlan, ilikeAny, mergeIds, chunk,
  compareRows, pageOfMatches, isTimeoutError, SEARCH_TIMEOUT_MESSAGE,
} from "../lib/invoicingSearch.js";

describe("cleanSearchTerm", () => {
  it("drops quotes, backslashes and wildcards, and squeezes spaces", () => {
    assert.equal(cleanSearchTerm(' "15631966"\\ '), "15631966");
    assert.equal(cleanSearchTerm("50%*off"), "50off");
    assert.equal(cleanSearchTerm("  Acme   Corp "), "Acme Corp");
  });
  it("handles nothing", () => {
    assert.equal(cleanSearchTerm(null), "");
    assert.equal(cleanSearchTerm(undefined), "");
  });
  it("keeps at most 100 characters", () => {
    assert.equal(cleanSearchTerm("x".repeat(300)).length, 100);
  });
});

describe("classifyQuery", () => {
  it("one word with a digit is an id", () => {
    assert.deepEqual(classifyQuery("15631966"), { kind: "id", term: "15631966" });
    assert.equal(classifyQuery("1Z999AA10123456784").kind, "id");
    assert.equal(classifyQuery("INV-2041").kind, "id");
  });
  it("one word without digits could be a name or an id", () => {
    assert.equal(classifyQuery("FedEx").kind, "word");
  });
  it("several words are a name", () => {
    assert.equal(classifyQuery("Acme Corp").kind, "text");
    assert.equal(classifyQuery("FreightPOP FTL 2").kind, "text");
  });
  it("blank or only wildcards is empty", () => {
    assert.equal(classifyQuery("   ").kind, "empty");
    assert.equal(classifyQuery("%%").kind, "empty");
  });
});

describe("searchPlan", () => {
  it("an id looks at the number columns and the approvals' invoice and tracking numbers", () => {
    const p = searchPlan("15631966");
    assert.deepEqual(p.tx, ["shipment_id", "tracking_number", "billing_invoice_number"]);
    assert.deepEqual(p.approvals, ["invoice_number", "tracking_number"]);
    assert.equal(p.cap, SEARCH_ID_CAP);
  });
  it("a single word also looks at names", () => {
    const p = searchPlan("ups");
    assert.ok(p.tx.includes("customer_name") && p.tx.includes("carrier") && p.tx.includes("shipment_id"));
    assert.deepEqual(p.approvals, ["invoice_number"]);
  });
  it("several words look at customer and carrier only", () => {
    const p = searchPlan("Acme Corp");
    assert.deepEqual(p.tx, ["customer_name", "carrier"]);
    assert.deepEqual(p.approvals, []);
  });
  it("nothing to search looks nowhere", () => {
    const p = searchPlan("");
    assert.deepEqual([p.kind, p.tx, p.approvals], ["empty", [], []]);
  });
  it("takes a cap", () => {
    assert.equal(searchPlan("x1", { cap: 5 }).cap, 5);
  });
});

describe("ilikeAny", () => {
  it("builds a quoted PostgREST or-filter", () => {
    assert.equal(ilikeAny(["a", "b"], "12"), 'a.ilike."%12%",b.ilike."%12%"');
  });
  it("cleans the term", () => {
    assert.equal(ilikeAny(["a"], 'x"y'), 'a.ilike."%xy%"');
  });
});

describe("mergeIds", () => {
  it("joins lists in order, each id once", () => {
    assert.deepEqual(mergeIds([["1", "2"], ["2", "3", null, ""]]), { ids: ["1", "2", "3"], truncated: false });
  });
  it("turns numbers into strings", () => {
    assert.deepEqual(mergeIds([[1, "1"]]).ids, ["1"]);
  });
  it("stops at the cap and says so", () => {
    assert.deepEqual(mergeIds([["1", "2", "3"]], 2), { ids: ["1", "2"], truncated: true });
  });
  it("a repeat past the cap is not truncation", () => {
    assert.deepEqual(mergeIds([["1", "2"], ["1"]], 2), { ids: ["1", "2"], truncated: false });
  });
  it("handles missing lists", () => {
    assert.deepEqual(mergeIds([null, undefined]), { ids: [], truncated: false });
  });
});

describe("chunk", () => {
  it("splits into pieces", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 2), []);
  });
});

describe("compareRows", () => {
  it("biggest charge first, no charge last, then shipment id", () => {
    const rows = [
      { shipment_id: "B", charge: 10 },
      { shipment_id: "C", charge: null },
      { shipment_id: "A", charge: 10 },
      { shipment_id: "D", charge: "250.5" },
      { shipment_id: "E", charge: "n/a" },
    ];
    assert.deepEqual(rows.sort(compareRows).map((r) => r.shipment_id), ["D", "A", "B", "C", "E"]);
  });
});

describe("pageOfMatches", () => {
  const rows = [
    { shipment_id: "1", bucket: "exported", approved_by_kind: "edi", charge: 5 },
    { shipment_id: "2", bucket: "approved_ready", approved_by_kind: "person", charge: 50 },
    { shipment_id: "3", bucket: "approved_ready", approved_by_kind: "edi", charge: 20 },
    { shipment_id: "4", bucket: "no_invoice", approved_by_kind: null, charge: 100 },
  ];
  it("counts every step and pages by charge", () => {
    const out = pageOfMatches(rows, { limit: 2, offset: 0 });
    assert.deepEqual(out.counts, { exported: 1, approved_ready: 2, invoice_not_approved: 0, no_invoice: 1 });
    assert.deepEqual(out.pageIds, ["4", "2"]);
    assert.deepEqual(Object.keys(out.counts), ERP_BUCKETS);
  });
  it("a step narrows the page, not the counts", () => {
    const out = pageOfMatches(rows, { bucket: "approved_ready", limit: 10, offset: 1 });
    assert.equal(out.counts.no_invoice, 1);
    assert.deepEqual(out.pageIds, ["3"]);
  });
  it("approved-by narrows both", () => {
    const out = pageOfMatches(rows, { kind: "edi" });
    assert.deepEqual(out.counts, { exported: 1, approved_ready: 1, invoice_not_approved: 0, no_invoice: 0 });
    assert.deepEqual(out.pageIds, ["3", "1"]);
  });
  it("nothing matched", () => {
    assert.deepEqual(pageOfMatches([], {}), { counts: { exported: 0, approved_ready: 0, invoice_not_approved: 0, no_invoice: 0 }, pageIds: [] });
  });
});

describe("isTimeoutError", () => {
  it("knows a statement timeout", () => {
    assert.equal(isTimeoutError({ message: "canceling statement due to statement timeout" }), true);
    assert.equal(isTimeoutError({ code: "57014", message: "x" }), true);
    assert.equal(isTimeoutError(new Error("relation does not exist")), false);
    assert.equal(isTimeoutError(null), false);
  });
  it("has a plain message", () => {
    assert.match(SEARCH_TIMEOUT_MESSAGE, /took too long/);
  });
});
