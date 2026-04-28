import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapShipment, mapShipmentsBulk, guessCustomerNameFromAddress } from "../lib/shipments.js";

// Additional edge-case coverage for the scrape→row mapper. The base
// shipments.test.js covers the happy path; these probe the boundaries.

describe("guessCustomerNameFromAddress — edges", () => {
  it("handles a single-segment address with no comma", () => {
    assert.equal(guessCustomerNameFromAddress("Acme Inc"), "Acme Inc");
  });

  it("returns null on whitespace-only input (empty after split/filter)", () => {
    assert.equal(guessCustomerNameFromAddress("   "), null);
    assert.equal(guessCustomerNameFromAddress(",,,"), null);
  });

  it("preserves case (does not upper/lower the company name)", () => {
    assert.equal(guessCustomerNameFromAddress("Acme Co, 1 Main St"), "Acme Co");
  });

  it("doesn't treat 'CA' as country when it's part of a longer segment", () => {
    // Country-code stop only triggers when the segment is <=3 chars and matches
    // the country-code regex. "California" should not stop iteration.
    const got = guessCustomerNameFromAddress("Acme, California Branch, 1 Main St");
    assert.equal(got, "Acme, California Branch");
  });

  it("stops at numeric-prefix street segment", () => {
    const got = guessCustomerNameFromAddress("Foo Co, Bar Division, 100 Main St, City");
    assert.equal(got, "Foo Co, Bar Division");
  });
});

describe("mapShipment — runner attribution", () => {
  it("attaches runnerName as created_by", () => {
    const out = mapShipment({ _trackingNumber: "TRK-1" }, "shaun@freightpop.com");
    assert.equal(out.created_by, "shaun@freightpop.com");
  });

  it("created_by is null when runnerName is omitted", () => {
    const out = mapShipment({ _trackingNumber: "TRK-1" });
    assert.equal(out.created_by, null);
  });

  it("preserves the raw scrape under raw_data so we don't lose unmapped columns", () => {
    const raw = { _trackingNumber: "TRK-1", "Some Future Column": "value" };
    const out = mapShipment(raw);
    assert.equal(out.raw_data, raw);
  });

  it("stamps scraped_at as an ISO-8601 string at mapping time", () => {
    const out = mapShipment({ _trackingNumber: "TRK-1" });
    assert.ok(out.scraped_at);
    // ISO-8601 of the form 2026-04-28T...Z
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(out.scraped_at));
    // Sanity: parses back to a Date within 5s of now
    const drift = Math.abs(Date.now() - Date.parse(out.scraped_at));
    assert.ok(drift < 5000, `scraped_at drifted ${drift}ms from now`);
  });
});

describe("mapShipment — name fallback ladder", () => {
  it("Customer Name > Company Name > address-guess (priority order)", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Customer Name": "Customer Co",
      "Company Name": "Company Co",
      "Ship From": "Address Co, 1 Main St",
    });
    assert.equal(out.customer_name, "Customer Co");
  });

  it("falls through to Company Name when Customer Name is blank string", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Customer Name": "",
      "Company Name": "Company Co",
      "Ship From": "Address Co, 1 Main St",
    });
    // pick() returns the first truthy match — empty string is falsy.
    assert.equal(out.customer_name, "Company Co");
  });

  it("falls through to address-guess when neither Customer Name nor Company Name present", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Ship From": "Address Co, 1 Main St",
    });
    assert.equal(out.customer_name, "Address Co");
  });

  it("customer_name is null when nothing is available", () => {
    const out = mapShipment({ _trackingNumber: "TRK-1" });
    assert.equal(out.customer_name, null);
  });

  it("preserves Company Name as the dedicated company_name column too", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Company Name": "Co",
    });
    assert.equal(out.company_name, "Co");
  });
});

describe("mapShipment — Shipment status sourcing", () => {
  it("prefers the Kendo 'Shipment status' (lowercase 's') over modal-scraped 'Status'", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Shipment status": "In Transit",   // Kendo grid column
      "Status": "Ship Date:",            // modal label residue
    });
    assert.equal(out.shipment_status, "In Transit");
  });

  it("falls through to 'Status' when the Kendo column is missing", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Status": "Delivered",
    });
    assert.equal(out.shipment_status, "Delivered");
  });

  it("drops label-only Status residue ('Ship Date:') and yields null", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Status": "Ship Date:",
    });
    assert.equal(out.shipment_status, null);
  });

  it("drops 'Origin Terminal:' label residue (seen on Ship Date in prod)", () => {
    // cleanField runs on every text field; verify via the comments path.
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Comments": "Origin Terminal:",
    });
    assert.equal(out.comments, null);
  });

  it("drops compound label residue 'Delivered Date: Event History:'", () => {
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Status": "Delivered Date: Event History:",
    });
    assert.equal(out.shipment_status, null);
  });

  it("keeps clean status tokens unchanged ('Booked' / 'Out For Delivery')", () => {
    const a = mapShipment({ _trackingNumber: "TRK-1", "Shipment status": "Booked" });
    assert.equal(a.shipment_status, "Booked");
    const b = mapShipment({ _trackingNumber: "TRK-2", "Shipment status": "Out For Delivery" });
    assert.equal(b.shipment_status, "Out For Delivery");
  });

  it("does NOT drop a real status that happens to contain a colon (e.g. 'Arrived: terminal scan')", () => {
    // Real values longer than 30 chars after the colon won't match the
    // label-only regex, so they survive.
    const out = mapShipment({
      _trackingNumber: "TRK-1",
      "Shipment status": "Arrived at terminal from SPARTANBURG, SC; Time: 10:03 AM",
    });
    assert.ok(out.shipment_status, "real status with a colon must survive");
    assert.ok(out.shipment_status.includes("SPARTANBURG"));
  });
});

describe("mapShipmentsBulk — additional cases", () => {
  it("forwards runnerName to every row", () => {
    const out = mapShipmentsBulk([
      { _trackingNumber: "TRK-1" },
      { _trackingNumber: "TRK-2" },
    ], "neel@freightpop.com");
    assert.equal(out.length, 2);
    assert.ok(out.every((r) => r.created_by === "neel@freightpop.com"));
  });

  it("preserves input order on output (no sorting)", () => {
    const out = mapShipmentsBulk([
      { _trackingNumber: "TRK-Z" },
      { _trackingNumber: "TRK-A" },
      { _trackingNumber: "TRK-M" },
    ]);
    assert.deepEqual(out.map((r) => r.tracking_number), ["TRK-Z", "TRK-A", "TRK-M"]);
  });
});
