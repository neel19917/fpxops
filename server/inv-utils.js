/**
 * Pure-logic Invoice Audit utilities.
 * Browser usage: these functions are inlined into content.js.
 * Node.js usage: import from "./inv-utils.js";
 */

export function makeErrorResult(ship, errorMsg) {
  return {
    shipmentId: ship.shipmentId,
    billAmount: ship.billAmount,
    vendor: ship.vendor,
    invoiceNumber: ship.invoiceNumber,
    memo: ship.memo,
    shipmentSale: null, shipmentCost: null, grossProfit: null,
    difference: null, pctDifference: null, direction: "N/A",
    matched: false, marginDollars: null, marginPct: null,
    error: errorMsg, scrapedFields: {},
  };
}

/**
 * Compare Bill Amount [CI] vs Shipment Cost [FPX] and compute direction/match.
 * Mutates `result` in place and returns it.
 */
export function computeInvoiceComparison(result, billAmount, costAmount, saleAmount) {
  if (costAmount !== null && costAmount !== undefined && Number.isFinite(costAmount)) {
    result.difference = +(billAmount - costAmount).toFixed(2);
    result.pctDifference = costAmount !== 0 ? +((result.difference / costAmount) * 100).toFixed(2) : 0;
    result.direction = result.difference > 0.01 ? "OVER" : result.difference < -0.01 ? "UNDER" : "MATCH";
    result.matched = Math.abs(result.difference) <= 0.01;
  } else {
    result.error = "Shipment Cost not found on detail page";
  }

  if (saleAmount !== null && saleAmount !== undefined && Number.isFinite(saleAmount) &&
      costAmount !== null && costAmount !== undefined && Number.isFinite(costAmount)) {
    result.marginDollars = +(saleAmount - costAmount).toFixed(2);
    result.marginPct = saleAmount !== 0 ? +((result.marginDollars / saleAmount) * 100).toFixed(2) : 0;
  }

  return result;
}

/**
 * Classify invoice audit results into discrepancies, matches, and errors.
 */
export function classifyInvoiceResults(results) {
  const discrepancies = results.filter((r) => !r.matched && r.shipmentCost !== null && !r.error);
  const matches = results.filter((r) => r.matched);
  const errors = results.filter((r) => r.error);
  const totalVariance = discrepancies.reduce((sum, r) => sum + (r.difference || 0), 0);
  return { discrepancies, matches, errors, totalVariance };
}

/**
 * Extract a numeric Shipment ID from the beginning of a memo string.
 */
export function extractShipmentIdFromMemo(memo) {
  if (!memo) return null;
  const m = String(memo).match(/^(\d{5,})/);
  return m ? m[1] : null;
}
