/**
 * Pure-logic GP audit utilities. Usable in both Node.js (tests) and browser (content.js).
 * Browser usage: these functions are inlined into content.js.
 * Node.js usage: import { getLastBusinessDay, computeGpStats, flagOutliers } from "./gp-utils.js";
 */

export function getLastBusinessDay(todayDate) {
  const d = new Date(todayDate);
  const day = d.getDay();
  const offset = day === 0 ? 2 : day === 1 ? 3 : day === 6 ? 1 : 1;
  const biz = new Date(d);
  biz.setDate(biz.getDate() - offset);
  return biz;
}

export function formatDateMmDdYyyy(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export function computeGpPct(grossProfit, markupRate) {
  const gp = parseFloat(grossProfit);
  const mr = parseFloat(markupRate);
  if (!Number.isFinite(gp) || !Number.isFinite(mr) || mr === 0) return null;
  return (gp / mr) * 100;
}

export function computeGpStats(rows) {
  const groups = new Map();

  for (const row of rows) {
    const cid = row["Customer Id"] || row["CustomerId"] || "";
    if (!cid) continue;
    const gpPct = computeGpPct(
      row["Shipment Gross Profit"],
      row["Shipment Marked-Up Rate"]
    );
    if (gpPct === null) continue;

    if (!groups.has(cid)) {
      groups.set(cid, {
        customerId: cid,
        customerName: row["Customer Name"] || "",
        values: [],
      });
    }
    groups.get(cid).values.push(gpPct);
  }

  const stats = new Map();
  for (const [cid, g] of groups) {
    const n = g.values.length;
    const mean = g.values.reduce((a, b) => a + b, 0) / n;
    const variance = g.values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    stats.set(cid, {
      customerId: cid,
      customerName: g.customerName,
      count: n,
      mean,
      stdev,
      outlierCount: 0,
    });
  }

  return stats;
}

export function flagOutliers(rows, stats) {
  for (const row of rows) {
    const cid = row["Customer Id"] || row["CustomerId"] || "";
    const gpPct = computeGpPct(
      row["Shipment Gross Profit"],
      row["Shipment Marked-Up Rate"]
    );

    row._gpPct = gpPct;
    row._isOutlier = false;

    const st = stats.get(cid);
    if (!st || gpPct === null) continue;

    row._customerMean = st.mean;
    row._customerStdev = st.stdev;

    if (st.count < 3) continue;

    const deviation = Math.abs(gpPct - st.mean);
    row._deviation = deviation;

    if (deviation > 2 * st.stdev) {
      row._isOutlier = true;
      st.outlierCount++;
    }
  }
  return rows;
}
