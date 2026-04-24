import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  makeErrorResult,
  computeInvoiceComparison,
  classifyInvoiceResults,
  extractShipmentIdFromMemo,
} from "../inv-utils.js";

function makeShip(overrides = {}) {
  return {
    shipmentId: overrides.shipmentId || "13069382",
    billAmount: overrides.billAmount ?? 250.0,
    vendor: overrides.vendor || "UPS Freight",
    invoiceNumber: overrides.invoiceNumber || "INV-001",
    memo: overrides.memo || "13069382 some memo text",
  };
}

function makeBaseResult(ship, costAmount, saleAmount, gpAmount) {
  return {
    shipmentId: ship.shipmentId,
    billAmount: ship.billAmount,
    vendor: ship.vendor,
    invoiceNumber: ship.invoiceNumber,
    memo: ship.memo,
    shipmentSale: saleAmount,
    shipmentCost: costAmount,
    grossProfit: gpAmount,
    difference: null, pctDifference: null, direction: "N/A",
    matched: false, marginDollars: null, marginPct: null,
    error: null, scrapedFields: {},
  };
}

// ========= Test 1: Bill == Cost → MATCH, zero difference =========
describe("computeInvoiceComparison", () => {
  it("marks MATCH when bill amount equals cost amount", () => {
    const ship = makeShip({ billAmount: 150.00 });
    const result = makeBaseResult(ship, 150.00, 200.00, 50.00);

    computeInvoiceComparison(result, ship.billAmount, 150.00, 200.00);

    assert.equal(result.matched, true);
    assert.equal(result.direction, "MATCH");
    assert.equal(result.difference, 0);
    assert.equal(result.pctDifference, 0);
    assert.equal(result.marginDollars, 50.00, "Margin = Sale 200 - Cost 150");
    assert.equal(result.marginPct, 25.00, "Margin% = 50/200 * 100");
  });

  // ========= Test 2: Bill > Cost → OVER with correct variance =========
  it("flags OVER when bill exceeds cost and computes correct variance", () => {
    const ship = makeShip({ billAmount: 300.00 });
    const result = makeBaseResult(ship, 250.00, 400.00, 150.00);

    computeInvoiceComparison(result, ship.billAmount, 250.00, 400.00);

    assert.equal(result.matched, false);
    assert.equal(result.direction, "OVER");
    assert.equal(result.difference, 50.00);
    assert.equal(result.pctDifference, 20.00, "50/250 * 100 = 20%");
    assert.equal(result.marginDollars, 150.00);
    assert.equal(result.marginPct, 37.50);
  });

  // ========= Test 3: Bill < Cost → UNDER, negative difference =========
  it("flags UNDER when bill is less than cost", () => {
    const ship = makeShip({ billAmount: 100.00 });
    const result = makeBaseResult(ship, 120.00, 180.00, 60.00);

    computeInvoiceComparison(result, ship.billAmount, 120.00, 180.00);

    assert.equal(result.matched, false);
    assert.equal(result.direction, "UNDER");
    assert.equal(result.difference, -20.00);
    assert.equal(result.pctDifference, -16.67, "-20/120 * 100 ≈ -16.67");
    assert.equal(result.marginDollars, 60.00);
  });
});

// ========= Test 4: makeErrorResult + classifyInvoiceResults — errors, matches, discrepancies =========
describe("classifyInvoiceResults", () => {
  it("correctly partitions results into discrepancies, matches, and errors", () => {
    const ship1 = makeShip({ shipmentId: "S1", billAmount: 100 });
    const ship2 = makeShip({ shipmentId: "S2", billAmount: 200 });
    const ship3 = makeShip({ shipmentId: "S3", billAmount: 300 });

    const matchResult = makeBaseResult(ship1, 100, 150, 50);
    computeInvoiceComparison(matchResult, 100, 100, 150);

    const overResult = makeBaseResult(ship2, 180, 250, 70);
    computeInvoiceComparison(overResult, 200, 180, 250);

    const errResult = makeErrorResult(ship3, "Shipment not found in grid");

    const { discrepancies, matches, errors, totalVariance } =
      classifyInvoiceResults([matchResult, overResult, errResult]);

    assert.equal(matches.length, 1, "One exact match");
    assert.equal(matches[0].shipmentId, "S1");

    assert.equal(discrepancies.length, 1, "One discrepancy (OVER)");
    assert.equal(discrepancies[0].shipmentId, "S2");
    assert.equal(discrepancies[0].direction, "OVER");

    assert.equal(errors.length, 1, "One error");
    assert.equal(errors[0].shipmentId, "S3");

    assert.equal(totalVariance, 20.00, "Total variance = $20 over");
  });
});

// ========= Test 5: extractShipmentIdFromMemo — parses IDs from messy memo strings =========
describe("extractShipmentIdFromMemo", () => {
  it("extracts numeric ID from start of memo", () => {
    assert.equal(extractShipmentIdFromMemo("13069382 UPS invoice"), "13069382");
    assert.equal(extractShipmentIdFromMemo("13069382"), "13069382");
  });

  it("returns null for non-numeric or short memos", () => {
    assert.equal(extractShipmentIdFromMemo("ABC-123"), null);
    assert.equal(extractShipmentIdFromMemo("1234"), null, "Fewer than 5 digits");
    assert.equal(extractShipmentIdFromMemo(""), null);
    assert.equal(extractShipmentIdFromMemo(null), null);
  });

  it("handles memo with text before number", () => {
    assert.equal(extractShipmentIdFromMemo("INV 13069382"), null, "Number must be at start");
  });
});
