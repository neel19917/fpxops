import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlainFacts, normalizePlainSummary, crossCheck, extractJson } from "../lib/plainSummary.js";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const ship = {
  tracking_number: "200918911", shipment_id: "15124877", customer_name: "The Ryl Company LLC", carrier_name: "XPO LTL", mode: "LTL",
  shipment_status: "In Transit", origin: "Horseheads, NY", destination: "Cvs Corporation, Beech Island, SC",
  pickup_date: "2026-09-16T17:00:00Z", original_eta: "2026-09-23T00:00:00Z", updated_eta: "2026-09-24T00:00:00Z",
  appointment_date: "2026-09-24T05:00:00Z", appointment_set: true, delivery_date: null,
  tracking_comments: "Appointment required at destination", scraped_at: "2026-09-23T14:00:00Z", last_analyzed_at: "2026-09-23T15:39:00Z",
  action_required: "YES", action_target: "customer",
  ai_issue: "Storage risk: held since 09/21/2026 07:09 and will have accumulated 69.9 hold hours by the booked appointment on 09/24/2026 05:00, exceeding XPO's 48-hour storage limit.",
  ai_recommendation: "Contact CVS to confirm or move the appointment.",
};
const triggers = { storage_risk: true, storage_hold_limit_hours: 48, at_destination_since: "2026-09-21T07:09:00Z", hold_hours_so_far: 56.8, hold_hours_at_appointment: 69.9, redelivery_needed: false };
const tasks = [{ title: "Customer followup: Storage risk — confirm appointment", status: "open", assigned_to: "victorz@freightpop.com", created_at: "2026-09-23T15:33:00Z" }, { title: "old", status: "done", created_at: "2026-09-20T00:00:00Z" }];
const notes = [{ body: "Appointment scheduled for delivery on 09/24 confirming storage.", created_by: "victorz@freightpop.com", created_at: "2026-09-21T18:00:00Z" }];

describe("buildPlainFacts", () => {
  const f = buildPlainFacts({ ship, tasks, notes, triggers, now: NOW });
  it("formats dates MM/DD/YYYY and computes hours-ago", () => {
    assert.equal(f.shipment.appointment_date, "09/24/2026");
    assert.equal(f.shipment.pickup_date, "09/16/2026");
    assert.equal(f.shipment.last_scraped_hours_ago, 2);
    assert.equal(f.signals.at_destination_since, "09/21/2026");
    assert.equal(f.signals.hold_hours_at_appointment, 69.9);
    assert.equal(f.today, "09/23/2026");
  });
  it("keeps only active tasks and the latest note", () => {
    assert.equal(f.open_tasks.length, 1);
    assert.equal(f.open_tasks[0].owner, "victorz@freightpop.com");
    assert.equal(f.latest_note.on, "09/21/2026");
  });
  it("renders owner names when a people map is supplied", () => {
    const g = buildPlainFacts({ ship, tasks, notes, triggers, now: NOW, people: { "victorz@freightpop.com": "Victor Zarate" } });
    assert.equal(g.open_tasks[0].owner, "Victor Zarate");
    assert.equal(g.latest_note.by, "Victor Zarate");
  });
});

describe("normalizePlainSummary", () => {
  it("clamps fields, accepts string or object steps, defaults urgency", () => {
    const s = normalizePlainSummary({
      headline: "  XPO will start charging storage  ", what_happened: "x", why_it_matters: "y",
      next_steps: ["Call CVS", { step: "Tell the customer", who: "Victor" }, { step: "" }, 5],
      by_when: "Before 09/24", urgency: "asap",
    });
    assert.equal(s.headline, "XPO will start charging storage");
    assert.deepEqual(s.next_steps, [{ step: "Call CVS", who: null }, { step: "Tell the customer", who: "Victor" }]);
    assert.equal(s.urgency, "monitor");
    assert.equal(normalizePlainSummary(null).headline, "");
  });
});

describe("crossCheck", () => {
  const facts = buildPlainFacts({ ship, tasks, notes, triggers, now: NOW });
  it("passes prose whose dates / hours / numbers all come from the facts", () => {
    const s = normalizePlainSummary({
      headline: "XPO will charge storage on 200918911 if the 09/24 appointment stands",
      what_happened: "The freight reached XPO's terminal on 09/21/2026. By the 9/24 appointment it will have sat 69.9 hours, past the 48-hour free window.",
      why_it_matters: "Storage fees will be billed to The Ryl Company.",
      next_steps: [{ step: "Call CVS to move the appointment earlier", who: "Victor" }],
      by_when: "Before 09/24",
    });
    assert.deepEqual(crossCheck(s, facts), []);
  });
  it("flags dates, hours, dollars and numbers that are not in the facts", () => {
    const s = normalizePlainSummary({
      headline: "Charges of $250 start 09/26",
      what_happened: "It has sat 120 hours. PRO 555123456.",
      why_it_matters: "", next_steps: [], by_when: "",
    });
    assert.deepEqual(crossCheck(s, facts).sort(), ["$250", "09/26", "120 hours", "555123456"].sort());
  });
});

describe("extractJson", () => {
  it("handles fenced and bare JSON", () => {
    assert.deepEqual(extractJson("```json\n{\"a\":1}\n```"), { a: 1 });
    assert.deepEqual(extractJson("ok {\"a\":2}"), { a: 2 });
    assert.equal(extractJson("nope"), null);
  });
});
