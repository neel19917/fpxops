import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMaterialDiff, MATERIAL_FIELDS } from "../lib/scrapeHistory.js";

// Pure-logic tests for the diff that drives re-analysis.
// computeMaterialDiff returns null when nothing material has changed and an
// object keyed by field when at least one MATERIAL_FIELDS entry differs.

describe("MATERIAL_FIELDS catalog", () => {
  it("is a non-empty array of strings", () => {
    assert.ok(Array.isArray(MATERIAL_FIELDS));
    assert.ok(MATERIAL_FIELDS.length > 5);
    for (const f of MATERIAL_FIELDS) assert.equal(typeof f, "string");
  });

  it("includes shipment_status — the single most important diff signal", () => {
    assert.ok(MATERIAL_FIELDS.includes("shipment_status"));
  });

  it("does not include cosmetic fields like raw_data or scraped_at", () => {
    assert.ok(!MATERIAL_FIELDS.includes("raw_data"));
    assert.ok(!MATERIAL_FIELDS.includes("scraped_at"));
  });

  it("has no duplicate entries (regression guard for hand-edited list)", () => {
    const set = new Set(MATERIAL_FIELDS);
    assert.equal(set.size, MATERIAL_FIELDS.length);
  });
});

describe("computeMaterialDiff — first-sighting", () => {
  it("returns null when there is no prior row (prev is null/undefined)", () => {
    assert.equal(computeMaterialDiff(null, { shipment_status: "In Transit" }), null);
    assert.equal(computeMaterialDiff(undefined, { shipment_status: "In Transit" }), null);
  });
});

describe("computeMaterialDiff — equality semantics", () => {
  it("returns null when no material field changed", () => {
    const prev = { shipment_status: "In Transit", raw_data: { foo: 1 } };
    const next = { shipment_status: "In Transit", raw_data: { foo: 999 } };
    assert.equal(computeMaterialDiff(prev, next), null,
      "raw_data churn alone must not signal material change");
  });

  it("treats whitespace-only / blank-string changes as equal (normalize trims)", () => {
    const prev = { shipment_status: "In Transit  " };
    const next = { shipment_status: " In Transit" };
    assert.equal(computeMaterialDiff(prev, next), null);
  });

  it("treats empty-string ↔ null as equal (both normalize to null)", () => {
    const prev = { shipment_status: "" };
    const next = { shipment_status: null };
    assert.equal(computeMaterialDiff(prev, next), null);
  });

  it("flags a real status transition", () => {
    const diff = computeMaterialDiff(
      { shipment_status: "In Transit" },
      { shipment_status: "Delivered" },
    );
    assert.deepEqual(diff, { shipment_status: { prev: "In Transit", next: "Delivered" } });
  });

  it("flags a delivery_date appearing for the first time", () => {
    const diff = computeMaterialDiff(
      { delivery_date: null },
      { delivery_date: "2026-04-28T15:30:00Z" },
    );
    assert.ok(diff && diff.delivery_date);
    assert.equal(diff.delivery_date.prev, null);
    assert.equal(diff.delivery_date.next, "2026-04-28T15:30:00Z");
  });

  it("flags multiple simultaneous changes, returning all of them", () => {
    const diff = computeMaterialDiff(
      { shipment_status: "In Transit", carrier_name: "FedEx", comments: "" },
      { shipment_status: "Delivered",  carrier_name: "FedEx", comments: "Left at dock" },
    );
    assert.ok(diff);
    assert.ok(diff.shipment_status);
    assert.ok(diff.comments);
    assert.equal(diff.carrier_name, undefined, "unchanged fields stay out of the diff");
  });

  it("flags appointment_set boolean flip", () => {
    const diff = computeMaterialDiff(
      { appointment_set: false },
      { appointment_set: true },
    );
    assert.ok(diff && diff.appointment_set);
    assert.equal(diff.appointment_set.prev, false);
    assert.equal(diff.appointment_set.next, true);
  });

  it("flags numeric field changes (defensive — currently we have none, but the JSON-stringify path supports it)", () => {
    // Exercise the JSON.stringify-based comparator with non-string values.
    // A future MATERIAL_FIELDS entry could be numeric; the comparator must work.
    const diff = computeMaterialDiff(
      { delivery_date: 0 },
      { delivery_date: 1 },
    );
    assert.ok(diff && diff.delivery_date);
  });

  it("does NOT flag changes to fields outside MATERIAL_FIELDS", () => {
    const diff = computeMaterialDiff(
      { ai_recommendation: "old", shipment_status: "In Transit" },
      { ai_recommendation: "new", shipment_status: "In Transit" },
    );
    assert.equal(diff, null,
      "ai_recommendation drift is not a real-world change — must not trigger re-analysis");
  });
});
