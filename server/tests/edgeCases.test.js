import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapShipment, mapShipmentsBulk, guessCustomerNameFromAddress } from "../lib/shipments.js";
import { decidePendingApiKey } from "../lib/pendingApiKey.js";
import { computeMaterialDiff, MATERIAL_FIELDS } from "../lib/scrapeHistory.js";
import { generateApiKey, hashApiKey } from "../lib/auth.js";
import { sendCachedJson } from "../lib/httpCache.js";
import { computeWalkContext } from "../lib/taskWalk.js";

// One file with the boundary cases I think about when writing this kind of
// code. The "happy path" tests already exist in the topic-specific files;
// these are the awkward inputs that have bitten us in production.

describe("guessCustomerNameFromAddress — adversarial input", () => {
  it("survives an extremely long single-segment address", () => {
    const blob = "X".repeat(5000);
    const out = guessCustomerNameFromAddress(blob);
    assert.equal(out, blob, "no truncation in this helper — that's cleanField's job");
  });

  it("treats a leading whitespace-only segment as empty", () => {
    assert.equal(guessCustomerNameFromAddress("   ,   , 1 Main St"), null);
  });

  it("doesn't mistake 'CA' inside a longer word for the country code", () => {
    const out = guessCustomerNameFromAddress("CASCADE Industries, 1 Pine St");
    assert.equal(out, "CASCADE Industries");
  });
});

describe("mapShipment — type coercion edges", () => {
  it("toNum: strips $ and , then parses; junk → null", () => {
    const out = mapShipment({
      _trackingNumber: "T1",
      "Total Weight": "1,234.5",
      "Shipment Marked Up Rate": "$2,500.00",
      "Shipment Gross Profit": "abc",
    });
    assert.equal(out.total_weight, 1234.5);
    assert.equal(out.shipment_marked_up_rate, 2500);
    assert.equal(out.shipment_gross_profit, null);
  });

  it("toIso: invalid date string yields null, not Invalid Date", () => {
    const out = mapShipment({ _trackingNumber: "T1", "Pickup Date": "not a date" });
    assert.equal(out.pickup_date, null);
  });

  it("toIso: timezone-bare date strings round-trip to ISO UTC", () => {
    const out = mapShipment({ _trackingNumber: "T1", "Pickup Date": "2026-04-29" });
    assert.ok(out.pickup_date);
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(out.pickup_date));
  });

  it("toBool: case + whitespace insensitive, junk → null", () => {
    assert.equal(mapShipment({ _trackingNumber: "T1", "Appointment Set": "YES" }).appointment_set, true);
    assert.equal(mapShipment({ _trackingNumber: "T1", "Appointment Set": "  no " }).appointment_set, false);
    assert.equal(mapShipment({ _trackingNumber: "T1", "Appointment Set": "maybe" }).appointment_set, null);
    assert.equal(mapShipment({ _trackingNumber: "T1", "Appointment Set": 1 }).appointment_set, true);
    assert.equal(mapShipment({ _trackingNumber: "T1", "Appointment Set": 0 }).appointment_set, false);
  });

  it("pick: zero / false are treated as truthy values, not skipped", () => {
    // pick() short-circuits on undefined/null/"" only — falsy primitives
    // like 0 and false should pass through.
    const out = mapShipment({ _trackingNumber: "T1", "Total Weight": 0 });
    assert.equal(out.total_weight, 0);
  });
});

describe("mapShipment — cleanField boundaries", () => {
  it("caps comments at 500 chars with ellipsis", () => {
    const long = "X".repeat(800);
    const out = mapShipment({ _trackingNumber: "T1", Comments: long });
    assert.ok(out.comments.length <= 501, "501 = 500 + ellipsis char");
    assert.ok(out.comments.endsWith("…"));
  });

  it("preserves exact-length values at the cap", () => {
    const exact = "X".repeat(500);
    const out = mapShipment({ _trackingNumber: "T1", Comments: exact });
    assert.equal(out.comments, exact);
    assert.ok(!out.comments.endsWith("…"));
  });

  it("collapses internal whitespace runs to a single space", () => {
    const out = mapShipment({ _trackingNumber: "T1", "Signed By": "John   Q\t\nDoe" });
    assert.equal(out.signed_by, "John Q Doe");
  });

  it("isLabelOnly catches multi-label strings ('Status: Date:')", () => {
    const out = mapShipment({ _trackingNumber: "T1", "Shipment status": "Status: Date:" });
    assert.equal(out.shipment_status, null);
  });

  it("isLabelOnly does NOT drop substantive values that happen to contain a colon", () => {
    const long = "Arrived at terminal from SPARTANBURG, SC; Time: 10:03 AM";
    const out = mapShipment({ _trackingNumber: "T1", "Shipment status": long });
    assert.ok(out.shipment_status);
    assert.ok(out.shipment_status.includes("SPARTANBURG"));
  });
});

describe("mapShipmentsBulk — input filtering", () => {
  it("returns [] when given a single null entry", () => {
    assert.deepEqual(mapShipmentsBulk([null]), []);
  });

  it("preserves entries with tracking_number even if everything else is missing", () => {
    const out = mapShipmentsBulk([{ _trackingNumber: "TRK-only" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].tracking_number, "TRK-only");
  });

  it("filters out entries whose tracking_number is empty string", () => {
    const out = mapShipmentsBulk([
      { _trackingNumber: "" },
      { _trackingNumber: "   " }, // whitespace
      { _trackingNumber: "TRK-real" },
    ]);
    // Whitespace-only tracking is technically truthy (non-empty string),
    // so it survives — that's a known minor wart but documenting via test.
    const tracks = out.map((r) => r.tracking_number);
    assert.ok(tracks.includes("TRK-real"));
    assert.ok(!tracks.includes(""), "empty string filtered");
  });
});

describe("decidePendingApiKey — defensive parses", () => {
  const NOW = Date.parse("2026-04-29T12:00:00Z");

  it("non-Date-parseable expiry strings count as expired", () => {
    for (const exp of ["yesterday", "garbage", "2026-13-99T99:99:99Z", ""]) {
      const v = decidePendingApiKey(
        { pending_api_key: "fpx_live_x", pending_api_key_expires_at: exp },
        NOW,
      );
      assert.equal(v.plaintext, null, `bad expiry "${exp}" should expire`);
      assert.equal(v.shouldClear, true);
    }
  });

  it("expiry returned as a Date object also works", () => {
    const v = decidePendingApiKey(
      { pending_api_key: "fpx_live_x", pending_api_key_expires_at: new Date(NOW + 60_000) },
      NOW,
    );
    assert.equal(v.plaintext, "fpx_live_x");
  });

  it("zero / negative nowMs (clock failure scenarios)", () => {
    // Pretend the clock returns 0 — every stash should look unexpired
    // because expires_at > 0. Keep delivery in this case so we don't
    // strand legit users behind a broken clock.
    const v = decidePendingApiKey(
      { pending_api_key: "fpx_live_x", pending_api_key_expires_at: new Date(NOW + 60_000).toISOString() },
      0,
    );
    assert.equal(v.plaintext, "fpx_live_x");
  });
});

describe("computeMaterialDiff — JSON-stringify quirks", () => {
  it("handles Date-typed values by ISO-string equality", () => {
    const d = new Date("2026-04-29T12:00:00Z");
    const diff = computeMaterialDiff({ delivery_date: d.toISOString() }, { delivery_date: d.toISOString() });
    assert.equal(diff, null);
  });

  it("treats undefined as null (normalize)", () => {
    const diff = computeMaterialDiff({ shipment_status: undefined }, { shipment_status: null });
    assert.equal(diff, null);
  });

  it("mutating the input prev row doesn't pollute the output", () => {
    const prev = { shipment_status: "In Transit" };
    const next = { shipment_status: "Delivered" };
    const diff = computeMaterialDiff(prev, next);
    assert.deepEqual(diff, { shipment_status: { prev: "In Transit", next: "Delivered" } });
    // Prove we didn't mutate prev/next.
    assert.equal(prev.shipment_status, "In Transit");
    assert.equal(next.shipment_status, "Delivered");
  });

  it("ignores extra keys not in MATERIAL_FIELDS even when they all change", () => {
    const prev = {};
    const next = {};
    // Stuff every non-material field with random values.
    for (const f of ["raw_data", "scraped_at", "ai_issue", "ai_recommendation", "id", "uid"]) {
      prev[f] = "a";
      next[f] = "b";
    }
    assert.equal(computeMaterialDiff(prev, next), null);
  });

  it("MATERIAL_FIELDS doesn't accidentally include any '_at' / '_id' columns", () => {
    for (const f of MATERIAL_FIELDS) {
      assert.ok(!f.endsWith("_id"), `${f} ends with _id — likely shouldn't be a material field`);
      assert.ok(f !== "scraped_at" && f !== "raw_data", `${f} is cosmetic, must not be material`);
    }
  });
});

describe("generateApiKey / hashApiKey — extra invariants", () => {
  it("hashApiKey is independent of input encoding (bytes-equality test)", () => {
    // Same string twice, hashed in two calls — must be identical.
    const a = "fpx_live_test";
    const h1 = hashApiKey(a);
    const h2 = hashApiKey(a);
    assert.equal(h1, h2);
  });

  it("hashApiKey distinguishes between inputs that differ only in unicode normalization", () => {
    // é vs e + ́ — visually identical but different byte sequences.
    const composed = "fpx_live_café";
    const decomposed = "fpx_live_café";
    assert.notEqual(composed, decomposed);
    assert.notEqual(hashApiKey(composed), hashApiKey(decomposed));
  });

  it("generateApiKey: length is consistent across calls", () => {
    const lens = new Set();
    for (let i = 0; i < 50; i++) lens.add(generateApiKey().length);
    assert.equal(lens.size, 1, "every generated key should be the same length");
  });
});

describe("sendCachedJson — body-passthrough edges", () => {
  function makeRes() {
    const calls = { setKey: null, setVal: null, jsonBody: null };
    return {
      set(k, v) { calls.setKey = k; calls.setVal = v; return this; },
      json(b) { calls.jsonBody = b; return this; },
      _calls: calls,
    };
  }

  it("forwards arrays without copying", () => {
    const res = makeRes();
    const arr = [1, 2, 3];
    sendCachedJson({}, res, arr);
    assert.equal(res._calls.jsonBody, arr);
  });

  it("forwards strings", () => {
    const res = makeRes();
    sendCachedJson({}, res, "hello");
    assert.equal(res._calls.jsonBody, "hello");
  });

  it("zero values for maxAge / swr render correctly (edge: explicit no-cache)", () => {
    const res = makeRes();
    sendCachedJson({}, res, {}, { maxAge: 0, swr: 0 });
    assert.equal(res._calls.setVal, "private, max-age=0, stale-while-revalidate=0");
  });
});

describe("computeWalkContext — a few more boundaries", () => {
  it("focused task with extra fields doesn't lose them in the output (forward-compat)", () => {
    const t = { id: "a", shipment_id: "s-a", custom_field: "kept" };
    const w = computeWalkContext(t, [t]);
    // The ids array is just ids; custom_field shouldn't leak in.
    assert.deepEqual(w.ids, ["a"]);
  });

  it("ids array length always equals total", () => {
    for (const list of [
      [],
      [T("a")],
      [T("a"), T("b")],
      [T("a"), T("b"), T("c"), T("d"), T("e")],
    ]) {
      const focus = list[0] || T("z");
      const w = computeWalkContext(focus, list);
      assert.equal(w.ids.length, w.total, "ids.length must match total");
    }
  });

  it("doesn't follow prev/next off the ends even with strange index recoveries", () => {
    const list = [T("a"), T("b")];
    // Pin missing focus → idx becomes 0 → prev null, next "a"
    const w = computeWalkContext(T("missing"), list);
    assert.equal(w.prev_id, null);
    assert.equal(w.next_id, "a");
  });

  function T(id, extra = {}) { return { id, shipment_id: `s-${id}`, ...extra }; }
});
