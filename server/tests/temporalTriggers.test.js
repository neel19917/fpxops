import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTemporalTriggers } from "../routes/analyze.js";

// as_of = 2026-06-17T00:00:00Z for all cases below.
const AS_OF = Date.parse("2026-06-17T00:00:00Z");
const past = "2026-06-10T00:00:00Z";
const future = "2026-06-25T00:00:00Z";

test("eta_passed_no_arrival: true when operative ETA is past and nothing arrived", () => {
  const t = computeTemporalTriggers({ updated_eta: past }, AS_OF);
  assert.equal(t.eta_passed_no_arrival, true);
});

test("eta_passed_no_arrival: false when ETA is in the future", () => {
  const t = computeTemporalTriggers({ updated_eta: future }, AS_OF);
  assert.equal(t.eta_passed_no_arrival, false);
});

test("eta_passed_no_arrival: false once delivered, even if ETA passed", () => {
  const t = computeTemporalTriggers({ updated_eta: past, delivery_date: past }, AS_OF);
  assert.equal(t.eta_passed_no_arrival, false);
});

test("eta_passed_no_arrival: NULL (not false) when no ETA field at all — unknown, not fine", () => {
  const t = computeTemporalTriggers({}, AS_OF);
  assert.equal(t.eta_passed_no_arrival, null);
});

test("operative ETA falls back updated_eta -> estimated_arrival -> original_eta", () => {
  assert.equal(computeTemporalTriggers({ estimated_arrival: past }, AS_OF).eta_passed_no_arrival, true);
  assert.equal(computeTemporalTriggers({ original_eta: future }, AS_OF).eta_passed_no_arrival, false);
});

test("pickup_date_passed_no_departure: true when pickup past and no departure; null when no pickup", () => {
  assert.equal(computeTemporalTriggers({ pickup_date: past }, AS_OF).pickup_date_passed_no_departure, true);
  assert.equal(computeTemporalTriggers({}, AS_OF).pickup_date_passed_no_departure, null);
});

test("appointment_passed_no_delivery: null unless appointment_set is an explicit boolean", () => {
  // date present but appointment_set unknown -> null
  assert.equal(computeTemporalTriggers({ appointment_date: past }, AS_OF).appointment_passed_no_delivery, null);
  // explicitly set + past -> true
  assert.equal(
    computeTemporalTriggers({ appointment_date: past, appointment_set: true }, AS_OF).appointment_passed_no_delivery,
    true,
  );
  // explicitly not set -> false (no appointment to miss)
  assert.equal(
    computeTemporalTriggers({ appointment_date: past, appointment_set: false }, AS_OF).appointment_passed_no_delivery,
    false,
  );
});

test("required_arrival_at_risk: true when operative ETA is later than RAD; null without RAD", () => {
  assert.equal(
    computeTemporalTriggers({ required_arrival_date: past, updated_eta: future }, AS_OF).required_arrival_at_risk,
    true,
  );
  assert.equal(computeTemporalTriggers({ updated_eta: future }, AS_OF).required_arrival_at_risk, null);
});

test("days_since_last_status: null when last_modified_at missing (current scrape never sends it)", () => {
  assert.equal(computeTemporalTriggers({}, AS_OF).days_since_last_status, null);
  assert.equal(computeTemporalTriggers({ last_modified_at: past }, AS_OF).days_since_last_status, 7);
});

test("eta_slip_days: only computed when BOTH etas present", () => {
  assert.equal(computeTemporalTriggers({ updated_eta: future, original_eta: past }, AS_OF).eta_slip_days, 15);
  assert.equal(computeTemporalTriggers({ updated_eta: future }, AS_OF).eta_slip_days, null);
});

test("unparseable date reads as unknown (null), not as a wrong boolean", () => {
  assert.equal(computeTemporalTriggers({ updated_eta: "not-a-date" }, AS_OF).eta_passed_no_arrival, null);
});
