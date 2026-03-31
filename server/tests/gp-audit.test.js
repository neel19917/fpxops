import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getLastBusinessDay,
  formatDateMmDdYyyy,
  computeGpStats,
  flagOutliers,
  computeGpPct,
} from "../gp-utils.js";

function makeRow(customerId, customerName, markupRate, grossProfit, extras = {}) {
  return {
    "Customer Id": customerId,
    "Customer Name": customerName,
    "Shipment Marked-Up Rate": String(markupRate),
    "Shipment Gross Profit": String(grossProfit),
    "ShipmentID": extras.shipmentId || "SHP" + Math.floor(Math.random() * 99999),
    ...extras,
  };
}

// ========= Test 1: getLastBusinessDay -- weekday (Wed -> Tue) =========
describe("getLastBusinessDay", () => {
  it("returns yesterday for a Wednesday", () => {
    const wed = new Date("2026-03-25T12:00:00");
    const result = getLastBusinessDay(wed);
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 2);
    assert.equal(result.getDate(), 24);
    assert.equal(result.getDay(), 2);
  });

  // ========= Test 2: getLastBusinessDay -- Mon/Sun/Sat all return Friday =========
  it("returns previous Friday for Monday, Sunday, and Saturday", () => {
    const mon = getLastBusinessDay(new Date("2026-03-23T12:00:00"));
    assert.equal(mon.getDate(), 20, "Monday -> Friday 20th");
    assert.equal(mon.getDay(), 5);

    const sun = getLastBusinessDay(new Date("2026-03-22T12:00:00"));
    assert.equal(sun.getDate(), 20, "Sunday -> Friday 20th");
    assert.equal(sun.getDay(), 5);

    const sat = getLastBusinessDay(new Date("2026-03-21T12:00:00"));
    assert.equal(sat.getDate(), 20, "Saturday -> Friday 20th");
    assert.equal(sat.getDay(), 5);
  });
});

// ========= Test 3: computeGpStats -- correct mean and stdev =========
describe("computeGpStats", () => {
  it("computes correct mean and stdev for a customer group", () => {
    const rows = [
      makeRow("C100", "Acme Corp", 76.13, 12.69),
      makeRow("C100", "Acme Corp", 46.9, 7.82),
      makeRow("C100", "Acme Corp", 46.9, 7.82),
      makeRow("C100", "Acme Corp", 16.63, 2.77),
      makeRow("C100", "Acme Corp", 13.27, 2.21),
    ];

    const stats = computeGpStats(rows);
    assert.ok(stats.has("C100"), "Has customer C100");

    const st = stats.get("C100");
    assert.equal(st.count, 5);
    assert.equal(st.customerName, "Acme Corp");

    const expectedPcts = rows.map((r) =>
      computeGpPct(r["Shipment Gross Profit"], r["Shipment Marked-Up Rate"])
    );
    const expectedMean = expectedPcts.reduce((a, b) => a + b, 0) / expectedPcts.length;
    assert.ok(Math.abs(st.mean - expectedMean) < 0.01, `Mean ~${expectedMean.toFixed(2)}, got ${st.mean.toFixed(2)}`);
    assert.ok(st.stdev < 0.5, `Stdev should be near 0 for nearly uniform GP%, got ${st.stdev.toFixed(4)}`);
  });
});

// ========= Test 4: flagOutliers -- detects outlier beyond 2 STDEV =========
describe("flagOutliers", () => {
  it("flags the outlier row that is beyond 2 STDEV", () => {
    const rows = [];
    for (let i = 0; i < 9; i++) {
      rows.push(makeRow("C200", "BigCo", 100, 20, { shipmentId: `NORM${i}` }));
    }
    rows.push(makeRow("C200", "BigCo", 100, 5, { shipmentId: "OUTLIER" }));

    const stats = computeGpStats(rows);
    flagOutliers(rows, stats);

    const outlierRow = rows.find((r) => r.ShipmentID === "OUTLIER");
    assert.ok(outlierRow._isOutlier, "The 5% GP row should be flagged as outlier");

    const normalRows = rows.filter((r) => r.ShipmentID !== "OUTLIER");
    for (const r of normalRows) {
      assert.equal(r._isOutlier, false, `Normal row ${r.ShipmentID} should NOT be flagged`);
    }

    assert.equal(stats.get("C200").outlierCount, 1);
  });

  // ========= Test 5: flagOutliers -- skips customers with < 3 shipments =========
  it("does not flag outliers for customers with fewer than 3 shipments", () => {
    const rows = [
      makeRow("C300", "SmallCo", 100, 20, { shipmentId: "S1" }),
      makeRow("C300", "SmallCo", 100, 5, { shipmentId: "S2" }),
    ];

    const stats = computeGpStats(rows);
    flagOutliers(rows, stats);

    for (const r of rows) {
      assert.equal(r._isOutlier, false, `Row ${r.ShipmentID} should NOT be flagged (insufficient data)`);
    }
    assert.equal(stats.get("C300").outlierCount, 0);
  });
});
