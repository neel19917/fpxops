import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRedelivery, isLtlMode, REDELIVERY_PATTERN } from "../lib/redelivery.js";

// Real tracking_comments strings observed in fpx_shipments_latest (2026-09).
const POSITIVE = [
  "Attempted Delivery in HOUSTON, TX",
  "Attempted Delivery in MARKHAM, IL",
  "Your delivery will be rescheduled.",
  "Delivery has been rescheduled to the next business day due to holiday closures.",
  "We tried to deliver to the business, but it was closed. A second attempt will be made the next business day.",
  "The receiving business was closed and delivery has been rescheduled for the next business day.",
  "Delivery attempt failed - consignee not available",
  "Redelivery scheduled for 09/20",
];

const NEGATIVE = [
  "Attempting to schedule a delivery appointment.",   // scheduling, not a failed attempt
  "Refused for damage",                                // disposition problem, not a redelivery
  "Shipment delivered refused",
  "Departed from origin terminal",
  "Out for delivery",
  "Arrived at destination terminal",
];

test("pattern matches the observed redelivery phrasings", () => {
  for (const s of POSITIVE) assert.equal(REDELIVERY_PATTERN.test(s), true, s);
});

test("pattern does not match ordinary milestones, appointment scheduling, or refusals", () => {
  for (const s of NEGATIVE) assert.equal(REDELIVERY_PATTERN.test(s), false, s);
});

test("isLtlMode is case/whitespace tolerant and false for other modes", () => {
  assert.equal(isLtlMode("LTL"), true);
  assert.equal(isLtlMode(" ltl "), true);
  assert.equal(isLtlMode("Parcel"), false);
  assert.equal(isLtlMode("Truckload"), false);
  assert.equal(isLtlMode(null), false);
});

test("detectRedelivery: true for LTL failed attempt with no delivery_date", () => {
  assert.equal(detectRedelivery({ mode: "LTL", tracking_comments: "Attempted Delivery in MODESTO, CA" }), true);
});

test("detectRedelivery: reads the comments column too", () => {
  assert.equal(detectRedelivery({ mode: "LTL", comments: "consignee closed, will reattempt tomorrow" }), true);
});

test("detectRedelivery: false once delivery_date is set (redelivery completed)", () => {
  assert.equal(
    detectRedelivery({ mode: "LTL", tracking_comments: "Attempted Delivery in MODESTO, CA", delivery_date: "2026-09-12T00:00:00Z" }),
    false,
  );
});

test("detectRedelivery: false for LTL with comments that are not a redelivery", () => {
  assert.equal(detectRedelivery({ mode: "LTL", tracking_comments: "Departed from origin terminal" }), false);
  assert.equal(detectRedelivery({ mode: "LTL", tracking_comments: "Refused for damage" }), false);
});

test("detectRedelivery: null for non-LTL (scope) and null with no comment text (unknown)", () => {
  assert.equal(detectRedelivery({ mode: "Parcel", tracking_comments: "Your delivery will be rescheduled." }), null);
  assert.equal(detectRedelivery({ mode: "LTL" }), null);
  assert.equal(detectRedelivery({ mode: "LTL", tracking_comments: "   " }), null);
  assert.equal(detectRedelivery(null), null);
});

// ---- repeat-failure detection + title convention -------------------------
import { isNewFailureEvent, isRedeliveryTitle, REDELIVERY_TAG } from "../lib/redelivery.js";

const ATTEMPTED = { mode: "LTL", tracking_comments: "Attempted Delivery in MODESTO, CA", last_modified_at: "2026-09-10T00:00:00Z", updated_eta: "2026-09-10T00:00:00Z" };

test("isRedeliveryTitle matches both halves of the pair and nothing else", () => {
  assert.equal(isRedeliveryTitle(`Carrier followup: ${REDELIVERY_TAG}call carrier for re-attempt`), true);
  assert.equal(isRedeliveryTitle(`Customer followup: ${REDELIVERY_TAG}notify customer of failed delivery attempt`), true);
  assert.equal(isRedeliveryTitle("Carrier followup: missing POD"), false);
  assert.equal(isRedeliveryTitle(null), false);
});

test("isNewFailureEvent: false when nothing moved (same comment, same stamps)", () => {
  assert.equal(isNewFailureEvent(ATTEMPTED, { ...ATTEMPTED }), false);
});

test("isNewFailureEvent: true when the carrier's last-modified stamp advances with the comment still 'attempted' (identical text on 2nd attempt)", () => {
  assert.equal(isNewFailureEvent(ATTEMPTED, { ...ATTEMPTED, last_modified_at: "2026-09-12T00:00:00Z" }), true);
});

test("isNewFailureEvent: true when updated ETA moves while still in redelivery state", () => {
  assert.equal(isNewFailureEvent(ATTEMPTED, { ...ATTEMPTED, updated_eta: "2026-09-13T00:00:00Z" }), true);
});

test("isNewFailureEvent: true when comment text changes to a different failure phrasing", () => {
  assert.equal(isNewFailureEvent(ATTEMPTED, { ...ATTEMPTED, tracking_comments: "Attempted Delivery in TURLOCK, CA" }), true);
});

test("isNewFailureEvent: true when re-entering redelivery state after an 'out for delivery' scrape", () => {
  const outForDelivery = { ...ATTEMPTED, tracking_comments: "Out for delivery" };
  assert.equal(isNewFailureEvent(outForDelivery, ATTEMPTED), true);
});

test("isNewFailureEvent: false when current scrape is no longer a redelivery, or when prev/next missing", () => {
  assert.equal(isNewFailureEvent(ATTEMPTED, { ...ATTEMPTED, tracking_comments: "Delivered", last_modified_at: "2026-09-13T00:00:00Z" }), false);
  assert.equal(isNewFailureEvent(null, ATTEMPTED), false);
  assert.equal(isNewFailureEvent(ATTEMPTED, undefined), false);
});

test("isNewFailureEvent: stamps missing on the prior row (pre-fix data) do not count as movement", () => {
  const prevNoStamp = { ...ATTEMPTED, last_modified_at: null };
  assert.equal(isNewFailureEvent(prevNoStamp, ATTEMPTED), false);
});
