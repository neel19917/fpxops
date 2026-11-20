import { test } from "node:test";
import assert from "node:assert/strict";
import { ageWords, sourceFreshness, freshness, STALE_HOURS } from "../src/freshness.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

test("ageWords", () => {
  assert.equal(ageWords(0.25), "15 minutes");
  assert.equal(ageWords(1), "1 hour");
  assert.equal(ageWords(30), "30 hours");
  assert.equal(ageWords(72), "3 days");
  assert.equal(ageWords(null), null);
});

test("tracking goes stale after 6 hours", () => {
  assert.equal(sourceFreshness("tracking", hoursAgo(5), NOW).stale, false);
  const s = sourceFreshness("tracking", hoursAgo(7), NOW);
  assert.equal(s.stale, true);
  assert.equal(s.age_hours, 7);
  assert.equal(s.refresh_page, "scraping");
  assert.match(s.note, /may be out of date/);
});

test("ERP 36 h, shipment details 72 h", () => {
  assert.equal(sourceFreshness("erp_transactions", hoursAgo(35), NOW).stale, false);
  assert.equal(sourceFreshness("erp_transactions", hoursAgo(37), NOW).stale, true);
  assert.equal(sourceFreshness("audit_approvals", hoursAgo(40), NOW).stale, true);
  assert.equal(sourceFreshness("shipment_details", hoursAgo(70), NOW).stale, false);
  assert.equal(sourceFreshness("shipment_details", hoursAgo(73), NOW).stale, true);
});

test("documents never go stale but say when they were read", () => {
  const s = sourceFreshness("documents", hoursAgo(500), NOW);
  assert.equal(s.stale, false);
  assert.equal(s.stale_after_hours, STALE_HOURS.documents);
  assert.match(s.note, /21 days ago/);
});

test("missing read time is not stale, says never read", () => {
  const s = sourceFreshness("tracking", null, NOW);
  assert.equal(s.stale, false);
  assert.equal(s.read_at, null);
  assert.equal(s.note, "never read");
});

test("freshness rolls up the stale sources", () => {
  const f = freshness({ tracking: hoursAgo(1), erp_transactions: hoursAgo(72), shipment_details: hoursAgo(100), documents: null }, NOW);
  assert.equal(f.any_stale, true);
  assert.deepEqual(f.stale.sort(), ["erp_transactions", "shipment_details"]);
  assert.equal(f.oldest_stale_hours, 100);
  assert.ok(!("audit_approvals" in f.sources));
  assert.match(f.summary, /ERP data last read 3 days ago/);
  assert.equal(freshness({ tracking: hoursAgo(1) }, NOW).any_stale, false);
});
