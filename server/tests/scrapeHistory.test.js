import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeMaterialDiff, MATERIAL_FIELDS,
  diffRow, historyItems, recordScrapeHistory, readBefore, HISTORY_TEXT_MAX,
} from "../lib/scrapeHistory.js";

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


describe("computeMaterialDiff — timestamp formatting is not a change", () => {
  it("PostgREST '+00:00' vs mapShipment '.000Z' for the same instant → no diff", () => {
    const prev = { pickup_date: "2026-08-21T00:00:00+00:00", updated_eta: "2026-08-25T00:00:00+00:00", appointment_date: "2026-08-25T00:00:00+00:00" };
    const next = { pickup_date: "2026-08-21T00:00:00.000Z", updated_eta: "2026-08-25T00:00:00.000Z", appointment_date: "2026-08-25T00:00:00.000Z" };
    assert.equal(computeMaterialDiff(prev, next), null);
  });
  it("a real ETA move is still a diff, reported with the source strings", () => {
    const prev = { updated_eta: "2026-08-25T00:00:00+00:00" };
    const next = { updated_eta: "2026-08-27T00:00:00.000Z" };
    const d = computeMaterialDiff(prev, next);
    assert.deepEqual(d, { updated_eta: { prev: "2026-08-25T00:00:00+00:00", next: "2026-08-27T00:00:00.000Z" } });
  });
  it("postgres 'YYYY-MM-DD HH:MM:SS+00' form is canonicalized too", () => {
    assert.equal(computeMaterialDiff({ pickup_date: "2026-08-21 00:00:00+00" }, { pickup_date: "2026-08-21T00:00:00.000Z" }), null);
  });
  it("non-date strings are untouched", () => {
    const d = computeMaterialDiff({ tracking_comments: "Out for delivery" }, { tracking_comments: "Attempted Delivery in MIAMI, FL" });
    assert.deepEqual(d, { tracking_comments: { prev: "Out for delivery", next: "Attempted Delivery in MIAMI, FL" } });
  });
});

// ---------- What changed between two reads (fpx_scrape_history) ----------

describe("diffRow", () => {
  it("is null when nothing compared differs", () => {
    assert.equal(diffRow({ a: 1, b: "x" }, { a: 1, b: "x" }), null);
    assert.equal(diffRow({ a: 1 }, null), null);
  });

  it("reports from and to for each changed field", () => {
    assert.deepEqual(diffRow({ status: "In Transit", cost: 10 }, { status: "Delivered", cost: 10 }), {
      status: { from: "In Transit", to: "Delivered" },
    });
  });

  it("is numeric-aware: 155.8 and \"155.80\" are one value, and so is \"$1,234.50\" and 1234.5", () => {
    assert.equal(diffRow({ a: 155.8, b: 1234.5, c: 0 }, { a: "155.80", b: "$1,234.50", c: "0.00" }), null);
    assert.deepEqual(diffRow({ a: 155.8 }, { a: "155.81" }), { a: { from: 155.8, to: "155.81" } });
  });

  it("keeps two texts apart even when both read as the same number (ids)", () => {
    assert.deepEqual(diffRow({ tracking: "047" }, { tracking: "47" }), { tracking: { from: "047", to: "47" } });
  });

  it("treats null, undefined-before and blank text as one value", () => {
    assert.equal(diffRow({ a: null, b: "", c: "  " }, { a: "", b: null, c: null, d: null }), null);
    assert.deepEqual(diffRow({ a: null }, { a: 0 }), { a: { from: null, to: 0 } });
    assert.deepEqual(diffRow({ a: true }, { a: null }), { a: { from: true, to: null } });
  });

  it("ignores bookkeeping columns and anything in `ignore`", () => {
    const before = { status: "A", last_seen_at: "1", captured_at: "1", data: { x: 1 }, note: "p" };
    const after = { status: "A", last_seen_at: "2", captured_at: "2", data: { x: 2 }, note: "q" };
    assert.deepEqual(diffRow(before, after), { note: { from: "p", to: "q" } });
    assert.equal(diffRow(before, after, { ignore: ["note"] }), null);
  });

  it("compares only `fields` when given, and skips a field the new row does not carry", () => {
    assert.deepEqual(diffRow({ a: 1, b: 1, c: 1 }, { a: 2, b: 2 }, { fields: ["a", "c"] }), { a: { from: 1, to: 2 } });
  });

  it("compares lists and objects by content, whatever the key order", () => {
    const before = { acc: [{ name: "Liftgate", amount: 50 }], files: ["a", "b"] };
    assert.equal(diffRow(before, { acc: [{ amount: 50.0, name: "Liftgate" }], files: ["a", "b"] }), null);
    assert.deepEqual(diffRow(before, { acc: [{ name: "Liftgate", amount: 60 }], files: ["a", "b"] }), {
      acc: { from: [{ name: "Liftgate", amount: 50 }], to: [{ name: "Liftgate", amount: 60 }] },
    });
  });

  it("sees one instant written two ways as one value", () => {
    assert.equal(diffRow({ t: "2026-08-25T00:00:00+00:00" }, { t: "2026-08-25T00:00:00.000Z" }), null);
  });

  it("cuts long text short", () => {
    const d = diffRow({ notes: "a" }, { notes: "b".repeat(HISTORY_TEXT_MAX + 100) });
    assert.equal(d.notes.to.length, HISTORY_TEXT_MAX + 1);
    assert.ok(d.notes.to.endsWith("…"));
  });

  it("with no row before, reports every non-blank field from null", () => {
    assert.deepEqual(diffRow(null, { a: 1, b: null, c: "x" }), { a: { from: null, to: 1 }, c: { from: null, to: "x" } });
  });

  it("does not change its input", () => {
    const before = Object.freeze({ a: " x " });
    const after = Object.freeze({ a: "y" });
    assert.deepEqual(diffRow(before, after), { a: { from: "x", to: "y" } });
  });
});

describe("historyItems", () => {
  const before = new Map([
    ["1", { id: "1", cost: 10, last_seen_at: "2026-11-01T00:00:00+00:00" }],
    ["2", { id: "2", cost: 10, last_seen_at: "2026-11-01T00:00:00+00:00" }],
  ]);
  const rows = [
    { id: "1", cost: "10.00", last_seen_at: "2026-11-02T00:00:00.000Z" },
    { id: "2", cost: 12, last_seen_at: "2026-11-02T00:00:00.000Z" },
    { id: "3", cost: 5, last_seen_at: "2026-11-02T00:00:00.000Z" },
    { cost: 1 },
  ];

  it("gives first_seen for a new entity, changed for a changed one, nothing for an unchanged one", () => {
    assert.deepEqual(historyItems(rows, before, { key: "id", fields: ["cost"] }), [
      { entity_key: "2", event: "changed", scraped_at: "2026-11-02T00:00:00.000Z", previous_scraped_at: "2026-11-01T00:00:00.000Z", changes: { cost: { from: 10, to: 12 } } },
      { entity_key: "3", event: "first_seen", scraped_at: "2026-11-02T00:00:00.000Z", previous_scraped_at: null, changes: { cost: { from: null, to: 5 } } },
    ]);
  });

  it("takes a key function and another last-read column", () => {
    const items = historyItems(
      [{ s: "9", kind: "invoice", files: ["a"], captured_at: "2026-11-02T00:00:00Z" }],
      new Map([["9|invoice", { files: [], captured_at: "2026-11-01T00:00:00Z" }]]),
      { key: (r) => `${r.s}|${r.kind}`, fields: ["files"], seenField: "captured_at" },
    );
    assert.deepEqual(items.map((i) => [i.entity_key, i.event, i.previous_scraped_at]), [["9|invoice", "changed", "2026-11-01T00:00:00.000Z"]]);
  });

  it("copes with nothing", () => {
    assert.deepEqual(historyItems(null, null, {}), []);
    assert.deepEqual(historyItems([], new Map()), []);
  });
});

describe("recordScrapeHistory", () => {
  const db = ({ fail = null } = {}) => {
    const inserts = [];
    return {
      inserts,
      from(table) {
        return {
          async insert(rows) {
            inserts.push({ table, rows });
            if (fail === "throw") throw new Error("network down");
            if (fail === "error") return { error: { message: "no such table" } };
            return { error: null };
          },
        };
      },
    };
  };
  const item = (k, event = "changed") => ({ entity_key: k, event, scraped_at: "2026-11-02T00:00:00Z", previous_scraped_at: null, changes: { a: { from: 1, to: 2 } } });
  const quiet = async (fn) => {
    const warn = console.warn;
    console.warn = () => {};
    try { return await fn(); } finally { console.warn = warn; }
  };

  it("inserts in chunks of 500, with the source and who ran the read", async () => {
    const d = db();
    const out = await recordScrapeHistory(d, "erp_transactions", Array.from({ length: 1201 }, (_, i) => item(`k${i}`)), {
      request_id: "11111111-2222-4333-8444-555555555555", run_by: "hosted browser",
    });
    assert.deepEqual(out, { recorded: 1201, failed: 0 });
    assert.deepEqual(d.inserts.map((i) => [i.table, i.rows.length]), [["fpx_scrape_history", 500], ["fpx_scrape_history", 500], ["fpx_scrape_history", 201]]);
    assert.deepEqual(d.inserts[0].rows[0], {
      source: "erp_transactions", entity_key: "k0", event: "changed", scraped_at: "2026-11-02T00:00:00.000Z", previous_scraped_at: null,
      changes: { a: { from: 1, to: 2 } }, request_id: "11111111-2222-4333-8444-555555555555", run_by: "hosted browser",
    });
  });

  it("writes nothing when there is nothing to record", async () => {
    const d = db();
    assert.deepEqual(await recordScrapeHistory(d, "x", []), { recorded: 0, failed: 0 });
    assert.deepEqual(await recordScrapeHistory(d, "x", null), { recorded: 0, failed: 0 });
    assert.deepEqual(await recordScrapeHistory(d, "x", [{ entity_key: "a", event: "seen_again" }, { event: "changed" }]), { recorded: 0, failed: 0 });
    assert.equal(d.inserts.length, 0);
  });

  it("leaves out a request id that is not a uuid", async () => {
    const d = db();
    await recordScrapeHistory(d, "x", [item("a")], { request_id: "not-a-uuid" });
    assert.equal(d.inserts[0].rows[0].request_id, null);
    assert.equal(d.inserts[0].rows[0].run_by, null);
  });

  it("never throws: a failed insert, a thrown error and no client are all counted", async () => {
    await quiet(async () => {
      assert.deepEqual(await recordScrapeHistory(db({ fail: "error" }), "x", [item("a"), item("b")]), { recorded: 0, failed: 2, error: "no such table" });
      assert.deepEqual(await recordScrapeHistory(db({ fail: "throw" }), "x", [item("a")]), { recorded: 0, failed: 1, error: "network down" });
      const out = await recordScrapeHistory(null, "x", [item("a")]);
      assert.equal(out.recorded, 0);
      assert.equal(out.failed, 1);
    });
  });
});

describe("readBefore", () => {
  it("reads the keys 200 at a time, each key once", async () => {
    const reads = [];
    const d = { from: (table) => ({ select: (columns) => ({ in: async (column, keys) => { reads.push({ table, columns, column, n: keys.length }); return { data: keys.slice(0, 1).map((k) => ({ k })), error: null }; } }) }) };
    const out = await readBefore(d, "t", "k", "k, a", [...Array.from({ length: 450 }, (_, i) => i), 0, 1]);
    assert.deepEqual(reads.map((r) => r.n), [200, 200, 50]);
    assert.equal(out.rows.length, 3);
  });

  it("never throws", async () => {
    assert.ok((await readBefore(null, "t", "k", "k", ["a"])).error);
    const d = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "nope" } }) }) }) };
    assert.deepEqual(await readBefore(d, "t", "k", "k", ["a"]), { error: "nope" });
    assert.deepEqual(await readBefore(d, "t", "k", "k", []), { rows: [] });
  });
});
