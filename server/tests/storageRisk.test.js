import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCarrierEvents, detectDestinationArrival, detectStorageRisk, parseCarrierList, isStorageRiskTitle, DESTINATION_PATTERN,
} from "../lib/storageRisk.js";

// Real production Details strings (2026-09-22 scrape), trimmed.
const XPO_HELD = "Carrier Status Code Status Status Comment Status Date City State Longitude Latitude Unloaded from trailerUnloaded from trailer09/21/2026 07:09:00North AugustaSCStaged to dock locationStaged to dock location09/21/2026 07:09:00North AugustaSCHeld for appointment from NAGHeld for appointment from NAG09/21/2026 07:09:00North AugustaSCSchedule arrived from NRO to NAGSchedule arrived from NRO to NAG09/21/2026 05:30:00North AugustaSC";
const XPO_TRAP = "Carrier Status Code Status Status Comment Status Date City State Longitude Latitude Record updatedRecord updated09/22/2026 11:01:00OrlandoFLHeld on trap trailer - Customer Requested Consolidated Delivery - from NOFHeld on trap trailer - Customer Requested Consolidated Delivery - from NOF09/22/2026 10:40:00OrlandoFL";
const SAIA_ARRIVED = "Carrier Status Code Status Status Comment Status Date City State Longitude Latitude Arrived at Destination TerminalInTransitArrived at Destination Terminal09/22/2026 07:04:00OaklandCADeparted from TerminalInTransitDeparted from Terminal09/21/2026 21:31:00FontanaCADelivery Appt 09/23/26 09:00 AM to 11:00 AMInTransitDelivery Appt 09/23/26 09:00 AM to 11:00 AM09/19/2026 12:00:00FontanaCA";
const IN_TRANSIT_ONLY = "Carrier Status Code Status Status Comment Status Date City State Longitude Latitude En route to destinationEn route to destination09/22/2026 03:00:00DallasTXArrived at interimArrived at interim09/21/2026 20:00:00DallasTX";

const T = (iso) => Date.parse(iso);
const ship = (over = {}) => ({
  mode: "LTL", carrier_name: "XPO LTL", delivery_date: null, appointment_date: null, tracking_comments: null,
  last_modified_at: null, raw_data: { Details: XPO_HELD }, ...over,
});

describe("parseCarrierEvents", () => {
  it("splits the flattened Details string on timestamps, oldest first", () => {
    const ev = parseCarrierEvents(XPO_HELD);
    assert.equal(ev.length, 4);
    assert.equal(ev[0].atIso, "2026-09-21T05:30:00.000Z");
    assert.match(ev[0].text, /Schedule arrived from NRO to NAG/);
    assert.equal(ev[3].atIso, "2026-09-21T07:09:00.000Z");
  });
  it("ignores 2-digit-year appointment strings and returns [] on junk", () => {
    const ev = parseCarrierEvents(SAIA_ARRIVED);
    assert.equal(ev.length, 3);
    assert.deepEqual(parseCarrierEvents(null), []);
    assert.deepEqual(parseCarrierEvents("no dates here"), []);
  });
});

describe("DESTINATION_PATTERN", () => {
  it("matches at-destination phrases and not in-transit ones", () => {
    for (const s of ["At destination", "Appointment required at destination", "Held for appointment from XDM", "Arrived at Destination Terminal", "Held on trap trailer - Customer Requested Consolidated Delivery", "Closed for delivery", "Shipment Arrived At Destination Terminal In HOUSTON, TX"]) {
      assert.ok(DESTINATION_PATTERN.test(s), s);
    }
    for (const s of ["En route to destination", "Arrived at interim", "At interim", "Arrived at Origin Terminal", "Out for delivery", "Recorded in system", "Staged to dock location", "Unloaded from trailer", "Unloading at dock"]) {
      assert.ok(!DESTINATION_PATTERN.test(s), s);
    }
  });
});

describe("detectDestinationArrival", () => {
  it("takes the earliest matching event from Details", () => {
    assert.deepEqual(detectDestinationArrival(ship()), { at: "2026-09-21T07:09:00.000Z", source: "events" });
    assert.deepEqual(detectDestinationArrival(ship({ raw_data: { Details: SAIA_ARRIVED } })), { at: "2026-09-22T07:04:00.000Z", source: "events" });
    assert.deepEqual(detectDestinationArrival(ship({ raw_data: { Details: XPO_TRAP } })), { at: "2026-09-22T10:40:00.000Z", source: "events" });
  });
  it("falls back to tracking_comments + last_modified_at when Details has no arrival", () => {
    const s = ship({ raw_data: { Details: IN_TRANSIT_ONLY }, tracking_comments: "At destination", last_modified_at: "2026-09-22T00:00:00Z" });
    assert.deepEqual(detectDestinationArrival(s), { at: "2026-09-22T00:00:00.000Z", source: "comment" });
  });
  it("returns null with no evidence", () => {
    assert.equal(detectDestinationArrival(ship({ raw_data: { Details: IN_TRANSIT_ONLY }, tracking_comments: "En route to destination" })), null);
    assert.equal(detectDestinationArrival(ship({ raw_data: null, tracking_comments: "At destination", last_modified_at: null })), null);
  });
});

describe("detectStorageRisk", () => {
  const asOf = T("2026-09-22T18:00:00Z");
  it("XPO held Mon 07:09, appointment Wed 05:00 → 70h > 48h → risk", () => {
    const r = detectStorageRisk(ship({ appointment_date: "2026-09-24T05:00:00Z" }), { asOfMs: asOf });
    assert.equal(r.storage_risk, true);
    assert.equal(r.storage_carrier_policy, true);
    assert.equal(r.at_destination_since, "2026-09-21T07:09:00.000Z");
    assert.equal(r.hold_hours_at_appointment, 69.9);
    assert.equal(r.hold_hours_so_far, 34.9);
    assert.equal(r.storage_hold_limit_hours, 48);
  });
  it("appointment inside the window → no risk", () => {
    const r = detectStorageRisk(ship({ appointment_date: "2026-09-22T12:00:00Z" }), { asOfMs: asOf });
    assert.equal(r.storage_risk, false);
    assert.equal(r.hold_hours_at_appointment, 28.9);
  });
  it("no appointment yet: risk once the hold passes half the limit", () => {
    assert.equal(detectStorageRisk(ship(), { asOfMs: asOf }).storage_risk, true);            // 34.9h ≥ 24h
    assert.equal(detectStorageRisk(ship(), { asOfMs: T("2026-09-21T20:00:00Z") }).storage_risk, false); // 12.9h
  });
  it("non-policy carrier: facts still computed, risk false", () => {
    const r = detectStorageRisk(ship({ carrier_name: "SAIA", raw_data: { Details: SAIA_ARRIVED }, appointment_date: "2026-09-26T09:00:00Z" }), { asOfMs: asOf });
    assert.equal(r.storage_risk, false);
    assert.equal(r.storage_carrier_policy, false);
    assert.equal(r.hold_hours_at_appointment, 97.9);
  });
  it("carrier list + threshold are configurable", () => {
    const r = detectStorageRisk(ship({ carrier_name: "SAIA", raw_data: { Details: SAIA_ARRIVED }, appointment_date: "2026-09-26T09:00:00Z" }), { asOfMs: asOf, holdHours: 72, carriers: "XPO, saia" });
    assert.equal(r.storage_carrier_policy, true);
    assert.equal(r.storage_risk, true);
    assert.equal(r.storage_hold_limit_hours, 72);
    assert.equal(detectStorageRisk(ship({ appointment_date: "2026-09-24T05:00:00Z" }), { asOfMs: asOf, holdHours: 96 }).storage_risk, false);
  });
  it("null for parcel / not at destination; false once delivered", () => {
    assert.equal(detectStorageRisk(ship({ mode: "Parcel" }), { asOfMs: asOf }).storage_risk, null);
    assert.equal(detectStorageRisk(ship({ raw_data: { Details: IN_TRANSIT_ONLY } }), { asOfMs: asOf }).storage_risk, null);
    assert.equal(detectStorageRisk(ship({ delivery_date: "2026-09-22T10:00:00Z" }), { asOfMs: asOf }).storage_risk, false);
    assert.equal(detectStorageRisk(null).storage_risk, null);
  });
});

describe("helpers", () => {
  it("parseCarrierList / isStorageRiskTitle", () => {
    assert.deepEqual(parseCarrierList("XPO, Saia;\nabf"), ["xpo", "saia", "abf"]);
    assert.deepEqual(parseCarrierList(["XPO LTL"]), ["xpo ltl"]);
    assert.deepEqual(parseCarrierList(""), []);
    assert.equal(isStorageRiskTitle("Customer followup: Storage risk — get an earlier appointment"), true);
    assert.equal(isStorageRiskTitle("Customer followup: storage charges likely"), false);
  });
});
