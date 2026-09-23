import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapShipment, mapShipmentsBulk, guessCustomerNameFromAddress,
  normalizeTrackingNumber, pairRawByTracking, isPartialScrape, stripNullFields, groupByKeySignature,
} from "../lib/shipments.js";

describe("guessCustomerNameFromAddress", () => {
  it("takes leading non-numeric segments before street number", () => {
    const got = guessCustomerNameFromAddress("ASSOCIATED PACKAGING, INC., 435 Calvert Dr, Gallatin, TN, 37066, US");
    assert.equal(got, "ASSOCIATED PACKAGING, INC.");
  });
  it("returns null on empty / non-string input", () => {
    assert.equal(guessCustomerNameFromAddress(null), null);
    assert.equal(guessCustomerNameFromAddress(""), null);
    assert.equal(guessCustomerNameFromAddress(123), null);
  });
  it("stops on country code segment", () => {
    const got = guessCustomerNameFromAddress("ACME, US");
    assert.equal(got, "ACME");
  });
  it("returns null when first segment is a street number", () => {
    assert.equal(guessCustomerNameFromAddress("435 Calvert Dr, Gallatin"), null);
  });
});

describe("mapShipment — basic mapping", () => {
  it("returns null for null/non-object input", () => {
    assert.equal(mapShipment(null), null);
    assert.equal(mapShipment("hello"), null);
  });

  it("maps the canonical scraped keys into typed columns", () => {
    const raw = {
      _trackingNumber: "TRK-001",
      "Shipment ID": "S-42",
      "Customer Name": "Acme Co",
      CARRIER: "FEDEX",
      "CARRIER NAME": "FedEx Freight",
      MODE: "LTL",
      "SHIPMENT STATUS": "In Transit",
      "PICKUP DATE": "2026-04-20",
      "Total Weight": "1,234.5",
      "Total Packages": "3",
      _actionRequired: "YES",
      _aiIssue: "Pickup missed",
      _aiRecommendation: "Reschedule pickup",
    };
    const out = mapShipment(raw, "neel@freightpop.com");
    assert.equal(out.tracking_number, "TRK-001");
    assert.equal(out.shipment_id, "S-42");
    assert.equal(out.customer_name, "Acme Co");
    assert.equal(out.carrier, "FEDEX");
    assert.equal(out.carrier_name, "FedEx Freight");
    assert.equal(out.mode, "LTL");
    assert.equal(out.shipment_status, "In Transit");
    assert.equal(out.total_weight, 1234.5);
    assert.equal(out.total_packages, 3);
    assert.equal(out.action_required, "YES");
    assert.equal(out.ai_issue, "Pickup missed");
    assert.equal(out.ai_recommendation, "Reschedule pickup");
    assert.equal(out.created_by, "neel@freightpop.com");
    assert.match(out.pickup_date, /^2026-04-20T/);
    assert.match(out.scraped_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(out.raw_data, raw);
  });

  it("guesses customer_name from origin when not explicitly provided", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-2",
      "Ship From": "ASSOCIATED PACKAGING, INC., 435 Calvert Dr, Gallatin, TN, 37066, US",
    });
    assert.equal(out.customer_name, "ASSOCIATED PACKAGING, INC.");
  });

  it("explicit customer_name beats the address guess", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-3",
      "Customer Name": "Real Customer",
      "Ship From": "Bogus Inc, 1 Bogus Way, Nowhere",
    });
    assert.equal(out.customer_name, "Real Customer");
  });

  it("Company Name beats the address guess when Customer Name is missing", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-4",
      "Company Name": "Proline Range Hoods",
      // FreightPOP origin blob would otherwise produce "SPARTANBURGSC29301".
      "Ship From": "SPARTANBURGSC29301",
    });
    assert.equal(out.customer_name, "Proline Range Hoods");
    assert.equal(out.company_name, "Proline Range Hoods");
  });
});

describe("mapShipment — cleanField / blob detection", () => {
  it("drops a full-modal blob in signed_by", () => {
    const blob = "Tracking Number: 123 Ship From: A Ship To: B Carrier: X Service: Y Number of Pieces: 1 Total Weight: 100";
    const out = mapShipment({ _trackingNumber: "T", "SIGNED BY": blob });
    assert.equal(out.signed_by, null);
  });
  it("drops pure label residue", () => {
    const out = mapShipment({ _trackingNumber: "T", "SHIPMENT STATUS": "Event History:" });
    assert.equal(out.shipment_status, null);
  });
  it("caps oversized comments", () => {
    const long = "x ".repeat(400);
    const out = mapShipment({ _trackingNumber: "T", COMMENTS: long });
    assert.ok(out.comments.length <= 501); // 500 + ellipsis allowance
    assert.match(out.comments, /…$/);
  });
});

describe("mapShipment — new FreightPOP grid columns", () => {
  it("maps the new grid fields under their canonical kendo titles", () => {
    const raw = {
      _trackingNumber: "TRK-NEW",
      "Company Name": "Acme Corp",
      "Shipment Date": "2026-04-15",
      "Tracking Comments": "Driver running late",
      "Shipper Spot Quote": "$1,234.00",
      "Pickup Tendered": "2026-04-14 09:00",
      "Last Modified": "2026-04-20T15:30:00Z",
      "Updated Via": "API",
      "Original ETA": "2026-04-22",
      "Order Number": "PO-9001",
      "Reference 1": "REF-A",
      "Reference 2": "REF-B",
      "Reference 3": "REF-C",
      "Reference 4": "REF-D",
      "Reference 5": "REF-E",
      "Reference 6": "REF-F",
      "Ready Time": "08:00",
      "Cut Off Time": "17:00",
      "Appointment Set": "Yes",
      "Appointment Date": "2026-04-21",
      "Required Arrival Date": "2026-04-23",
      "Spot Quote Fulfilled By": "Carrier X",
    };
    const out = mapShipment(raw);
    assert.equal(out.company_name, "Acme Corp");
    assert.match(out.shipment_date, /^2026-04-15T/);
    assert.equal(out.tracking_comments, "Driver running late");
    assert.equal(out.shipper_spot_quote, "$1,234.00");
    assert.equal(out.pickup_tendered, "2026-04-14 09:00");
    assert.match(out.last_modified_at, /^2026-04-20T15:30:00/);
    assert.equal(out.updated_via, "API");
    assert.match(out.original_eta, /^2026-04-22T/);
    assert.equal(out.order_number, "PO-9001");
    assert.equal(out.reference_one, "REF-A");
    assert.equal(out.reference_two, "REF-B");
    assert.equal(out.reference_three, "REF-C");
    assert.equal(out.reference_four, "REF-D");
    assert.equal(out.reference_five, "REF-E");
    assert.equal(out.reference_six, "REF-F");
    assert.equal(out.ready_time, "08:00");
    assert.equal(out.cut_off_time, "17:00");
    assert.equal(out.appointment_set, true);
    assert.match(out.appointment_date, /^2026-04-21T/);
    assert.match(out.required_arrival_date, /^2026-04-23T/);
    assert.equal(out.spot_quote_fulfilled_by, "Carrier X");
  });

  it("accepts uppercase / abbreviated reference variants (Ref1, REFERENCE 1)", () => {
    const out = mapShipment({
      _trackingNumber: "T",
      Ref1: "abbrev-1",
      "REFERENCE 2": "upper-2",
    });
    assert.equal(out.reference_one, "abbrev-1");
    assert.equal(out.reference_two, "upper-2");
  });

  it("appointment_set: parses No → false, junk → null", () => {
    assert.equal(mapShipment({ _trackingNumber: "T", "Appointment Set": "No" }).appointment_set, false);
    assert.equal(mapShipment({ _trackingNumber: "T", "Appointment Set": "maybe" }).appointment_set, null);
    assert.equal(mapShipment({ _trackingNumber: "T" }).appointment_set, null);
  });

  it("leaves new columns null when raw lacks them (no false positives)", () => {
    const out = mapShipment({ _trackingNumber: "T" });
    assert.equal(out.company_name, null);
    assert.equal(out.order_number, null);
    assert.equal(out.reference_one, null);
    assert.equal(out.appointment_date, null);
    assert.equal(out.shipper_spot_quote, null);
  });
});

describe("mapShipmentsBulk", () => {
  it("filters out rows without tracking_number", () => {
    const out = mapShipmentsBulk([
      { _trackingNumber: "A" },
      { "Customer Name": "no-tracking" },
      { _trackingNumber: "B" },
      null,
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((r) => r.tracking_number), ["A", "B"]);
  });
  it("returns [] for null/undefined input", () => {
    assert.deepEqual(mapShipmentsBulk(null), []);
    assert.deepEqual(mapShipmentsBulk(undefined), []);
  });
});

describe("mapShipmentsBulk — bad-row hardening", () => {
  it("collapses duplicate tracking numbers to the last occurrence", () => {
    const out = mapShipmentsBulk([
      { _trackingNumber: "DUP", CARRIER: "first" },
      { _trackingNumber: "OTHER" },
      { _trackingNumber: "DUP", CARRIER: "second" },
    ]);
    assert.deepEqual(out.map((r) => r.tracking_number), ["OTHER", "DUP"]);
    assert.equal(out.find((r) => r.tracking_number === "DUP").carrier, "second");
  });
  it("treats whitespace variants of a tracking number as the same shipment", () => {
    const out = mapShipmentsBulk([
      { _trackingNumber: " 4017 70491\u00a0" },
      { _trackingNumber: "4017 70491" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].tracking_number, "4017 70491");
  });
  it("survives rows that are not objects or have hostile shapes", () => {
    const out = mapShipmentsBulk([
      42, "str", [], null, undefined,
      { _trackingNumber: "OK", "Shipment Date": { nested: true }, "Total Weight": ["x"] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].tracking_number, "OK");
    assert.equal(out[0].shipment_date, null);
    assert.equal(out[0].total_weight, null);
  });
});

describe("normalizeTrackingNumber", () => {
  it("trims, collapses whitespace, and nulls empties", () => {
    assert.equal(normalizeTrackingNumber("  A  B \n"), "A B");
    assert.equal(normalizeTrackingNumber("   "), null);
    assert.equal(normalizeTrackingNumber(null), null);
    assert.equal(normalizeTrackingNumber(12345), "12345");
  });
});

describe("pairRawByTracking", () => {
  it("keys raw payloads by tracking number regardless of skipped rows", () => {
    const bulk = [
      { "Customer Name": "no tracking" },
      { _trackingNumber: "A", Details: "a-details" },
      null,
      { _trackingNumber: "B", Details: "b-details" },
    ];
    const mapped = mapShipmentsBulk(bulk);
    const raw = pairRawByTracking(bulk);
    for (const m of mapped) {
      assert.equal(raw.get(m.tracking_number).Details, `${m.tracking_number.toLowerCase()}-details`);
    }
    assert.equal(raw.size, 2);
  });
  it("last duplicate wins, matching mapShipmentsBulk", () => {
    const raw = pairRawByTracking([
      { _trackingNumber: "D", Details: "old" },
      { _trackingNumber: "D", Details: "new" },
    ]);
    assert.equal(raw.get("D").Details, "new");
  });
});

describe("partial scrape rows", () => {
  it("isPartialScrape flags _error / _partial rows only", () => {
    assert.equal(isPartialScrape({ _error: "Modal did not appear (timeout)" }), true);
    assert.equal(isPartialScrape({ _partial: true }), true);
    assert.equal(isPartialScrape({ _trackingNumber: "X" }), false);
    assert.equal(isPartialScrape(null), false);
  });
  it("stripNullFields drops null columns but keeps the conflict key and un-archive signal", () => {
    const mapped = mapShipment({ _trackingNumber: "P1", _error: "timeout", "Shipment status": "In Transit" });
    const stripped = stripNullFields(mapped);
    assert.equal(stripped.tracking_number, "P1");
    assert.equal(stripped.shipment_status, "In Transit");
    assert.equal("archived_at" in stripped, true);
    assert.equal(stripped.archived_at, null);
    assert.equal("carrier" in stripped, false);
    assert.equal("updated_eta" in stripped, false);
    assert.equal(typeof stripped.scraped_at, "string");
  });
});

describe("groupByKeySignature", () => {
  it("groups rows with identical key sets and separates differently shaped rows", () => {
    const groups = groupByKeySignature([
      { a: 1, b: 2 },
      { b: 3, a: 4 },
      { a: 5 },
      null,
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length, 2);
    assert.equal(groups[1].length, 1);
  });
  it("returns [] for empty input", () => {
    assert.deepEqual(groupByKeySignature([]), []);
    assert.deepEqual(groupByKeySignature(null), []);
  });
});
