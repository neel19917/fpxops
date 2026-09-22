import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, buildBoard, segmentForTitle, attemptFor, isReturnClaimTitle } from "../lib/taskSegments.js";

// Fixed clock so age / staleness assertions are deterministic.
const NOW = Date.parse("2026-09-22T20:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const task = (over = {}) => ({
  id: "t1", shipment_id: "s1", status: "open", assigned_to: "Allen",
  title: "Carrier followup: FPX should contact ABF for an ETA",
  created_at: daysAgo(1), ...over,
});
const ship = (over = {}) => ({
  id: "s1", tracking_number: "123", customer_name: "Acme", carrier_name: "ABF", mode: "LTL",
  shipment_status: "In Transit", scraped_at: daysAgo(0), delivery_date: null, archived_at: null,
  action_required: "YES", ...over,
});

describe("segmentForTitle", () => {
  it("routes the structured tags before the generic prefixes", () => {
    assert.equal(segmentForTitle("Carrier followup: Redelivery — call AAA Cooper"), "redelivery");
    assert.equal(segmentForTitle("Customer followup: Redelivery — notify customer of failed delivery attempt (attempt 2)"), "redelivery");
    assert.equal(segmentForTitle("Carrier followup: Return/claim — confirm return charges"), "return_claim");
    assert.equal(segmentForTitle("Customer followup: Return/claim — get disposition"), "return_claim");
    assert.equal(segmentForTitle("Carrier followup: FPX should contact Pilot"), "carrier");
    assert.equal(segmentForTitle("Customer followup: confirm receiving hours"), "customer");
    assert.equal(segmentForTitle("Customer wants carrier followup"), "carrier");
    assert.equal(segmentForTitle("Check with Victor"), "other");
    assert.equal(segmentForTitle(null), "other");
  });
  it("isReturnClaimTitle matches the structured tag only", () => {
    assert.equal(isReturnClaimTitle("Carrier followup: Return/claim — x"), true);
    assert.equal(isReturnClaimTitle("Possible claim on return"), false);
  });
});

describe("attemptFor", () => {
  it("reads the (attempt N) suffix and defaults redelivery to 1", () => {
    assert.equal(attemptFor("Carrier followup: Redelivery — x (attempt 3)", "redelivery"), 3);
    assert.equal(attemptFor("Carrier followup: Redelivery — x", "redelivery"), 1);
    assert.equal(attemptFor("Carrier followup: FPX should call", "carrier"), null);
  });
});

describe("classifyTask — health flags", () => {
  it("clean fresh assigned task has no flags", () => {
    const c = classifyTask(task(), ship(), { now: NOW });
    assert.deepEqual(c.flags, []);
    assert.equal(c.segment, "carrier");
    assert.equal(c.age_days, 1);
    assert.equal(c.days_since_scrape, 0);
    assert.equal(c.health, null);
  });
  it("delivered shipment → resolved_upstream, health names the delivery date", () => {
    const c = classifyTask(task(), ship({ delivery_date: daysAgo(2) }), { now: NOW });
    assert.ok(c.flags.includes("resolved_upstream"));
    assert.match(c.health, /delivery date/);
  });
  it("AI flipped to NO → resolved_upstream", () => {
    const c = classifyTask(task(), ship({ action_required: "NO" }), { now: NOW });
    assert.ok(c.flags.includes("resolved_upstream"));
  });
  it("archived shipment → resolved_upstream", () => {
    assert.ok(classifyTask(task(), ship({ archived_at: daysAgo(1) }), { now: NOW }).flags.includes("resolved_upstream"));
  });
  it("stale: no scrape for staleDays, or never scraped", () => {
    assert.ok(classifyTask(task(), ship({ scraped_at: daysAgo(9) }), { now: NOW, staleDays: 7 }).flags.includes("stale"));
    assert.ok(!classifyTask(task(), ship({ scraped_at: daysAgo(6) }), { now: NOW, staleDays: 7 }).flags.includes("stale"));
    assert.ok(classifyTask(task(), ship({ scraped_at: null }), { now: NOW }).flags.includes("stale"));
  });
  it("repeat: attempt > 1 on a redelivery task", () => {
    const c = classifyTask(task({ title: "Carrier followup: Redelivery — x (attempt 2)" }), ship(), { now: NOW });
    assert.equal(c.segment, "redelivery");
    assert.equal(c.attempt, 2);
    assert.ok(c.flags.includes("repeat"));
    assert.equal(c.health, "Failed attempt #2");
  });
  it("aging only counts active tasks; unassigned + blocked are literal", () => {
    assert.ok(classifyTask(task({ created_at: daysAgo(6) }), ship(), { now: NOW }).flags.includes("aging"));
    assert.ok(!classifyTask(task({ created_at: daysAgo(6), status: "done" }), ship(), { now: NOW }).flags.includes("aging"));
    assert.ok(classifyTask(task({ assigned_to: "  " }), ship(), { now: NOW }).flags.includes("unassigned"));
    assert.ok(classifyTask(task({ status: "blocked" }), ship(), { now: NOW }).flags.includes("blocked"));
  });
  it("orphan task (no shipment) never gets shipment-derived flags", () => {
    const c = classifyTask(task(), null, { now: NOW });
    assert.ok(!c.flags.includes("stale"));
    assert.ok(!c.flags.includes("resolved_upstream"));
    assert.equal(c.days_since_scrape, null);
  });
  it("duplicate comes from the caller's active count and only on active tasks", () => {
    assert.ok(classifyTask(task(), ship(), { now: NOW, activeOnShipment: 2 }).flags.includes("duplicate"));
    assert.ok(!classifyTask(task({ status: "done" }), ship(), { now: NOW, activeOnShipment: 2 }).flags.includes("duplicate"));
  });
});

describe("buildBoard", () => {
  it("computes duplicates per shipment and the summary counts", () => {
    const tasks = [
      task({ id: "a", shipment_id: "s1" }),
      task({ id: "b", shipment_id: "s1", title: "Customer followup: Redelivery — notify customer of failed delivery attempt" }),
      task({ id: "c", shipment_id: "s2", assigned_to: null, title: "Carrier followup: Redelivery — x (attempt 2)" }),
      task({ id: "d", shipment_id: "s3", status: "done", title: "Carrier followup: old" }),
    ];
    const ships = new Map([
      ["s1", ship({ id: "s1" })],
      ["s2", ship({ id: "s2", carrier_name: "AAA Cooper", customer_name: "MKS", scraped_at: daysAgo(10), delivery_date: daysAgo(1) })],
      ["s3", ship({ id: "s3" })],
    ]);
    const { rows, summary } = buildBoard(tasks, ships, { now: NOW, staleDays: 7 });
    assert.equal(rows.length, 4);
    const byId = Object.fromEntries(rows.map((r) => [r.task.id, r]));
    assert.ok(byId.a.seg.flags.includes("duplicate"));
    assert.ok(byId.b.seg.flags.includes("duplicate"));
    assert.ok(!byId.c.seg.flags.includes("duplicate"));
    assert.deepEqual(byId.c.seg.flags.sort(), ["repeat", "resolved_upstream", "stale", "unassigned"]);
    assert.equal(summary.total, 4);
    assert.equal(summary.active, 3);
    assert.equal(summary.by_segment.redelivery, 2);
    assert.equal(summary.by_segment.carrier, 2);
    assert.equal(summary.by_flag.duplicate, 2);
    assert.equal(summary.by_assignee["(unassigned)"], 1);
    assert.equal(summary.by_carrier["AAA Cooper"], 1);
    // c is redelivery+repeat but resolved upstream → excluded; b counts.
    assert.equal(summary.needs_attention, 1);
    // slim shipment keeps only the board columns
    assert.equal(byId.a.shipment.tracking_number, "123");
    assert.equal("raw_data" in byId.a.shipment, false);
  });
  it("tolerates a plain-object shipment map and an empty task list", () => {
    const { rows, summary } = buildBoard([], {}, { now: NOW });
    assert.equal(rows.length, 0);
    assert.equal(summary.total, 0);
    assert.equal(summary.needs_attention, 0);
  });
});
