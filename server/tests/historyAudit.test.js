import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isExportedToErp, num, auditHistoryRows } from "../lib/historyAudit.js";

let seq = 0;
function row(over = {}) {
  seq++;
  return {
    "Customer Id": "C-1",
    "Customer Name": "Acme Corp",
    "Account Manager": "Dana Reyes",
    "Shipped Date": "10/02/2026",
    "Billing Invoice Number": `INV-${seq}`,
    "Transaction Type": "Shipment",
    "ShipmentID": String(13000000 + seq),
    "Status": "Shipped",
    "Carrier": "UPS Freight",
    "Service": "LTL Standard",
    "Tracking": `PRO${seq}`,
    "Shipment Marked-Up Rate": "500.00",
    "Shipment Rate without mark up": "400.00",
    "Shipment Gross Profit": "100.00",
    "Original Approved Invoice Amount": "400.00",
    "Original Invoice Approved Date": "10/05/2026",
    "Not Approved Invoice Amount": "",
    "Additional Approved Invoice Amount": "",
    "Quote And Invoice Variance": "0",
    "Exported to ERP": "0",
    "User": "jsmith",
    "Customer Invoice Sent": "Yes",
    "Some Other Column": "ignored",
    ...over,
  };
}

describe("isExportedToErp", () => {
  it("treats clear 'no' values and blanks as not exported", () => {
    for (const v of [0, "0", false, "false", "False", "FALSE", "No", "no", " no ", "", "   ", null, undefined, "0.0", " 0 "]) {
      assert.equal(isExportedToErp(v), false, `expected not exported for ${JSON.stringify(v)}`);
    }
  });

  it("treats everything else as exported", () => {
    for (const v of [1, "1", true, "true", "True", "Yes", "yes", "Y", "Exported", "2", 5, "10/01/2026"]) {
      assert.equal(isExportedToErp(v), true, `expected exported for ${JSON.stringify(v)}`);
    }
  });
});

describe("num", () => {
  it("parses money strings and numbers", () => {
    assert.equal(num("$1,234.50"), 1234.5);
    assert.equal(num("1234"), 1234);
    assert.equal(num(" 12.5 "), 12.5);
    assert.equal(num("-45.10"), -45.1);
    assert.equal(num("($45.10)"), -45.1);
    assert.equal(num("-$45.10"), -45.1);
    assert.equal(num(".5"), 0.5);
    assert.equal(num(0), 0);
    assert.equal(num("0"), 0);
    assert.equal(num(99.99), 99.99);
  });

  it("returns null for blanks and non-numbers", () => {
    for (const v of ["", "   ", null, undefined, "N/A", "abc", "12abc", "1.2.3", NaN, Infinity, {}, [], true]) {
      assert.equal(num(v), null, `expected null for ${String(v)}`);
    }
  });
});

describe("auditHistoryRows — filter", () => {
  it("drops rows already exported to ERP", () => {
    const { rows, summary } = auditHistoryRows([
      row({ ShipmentID: "A", "Exported to ERP": "1" }),
      row({ ShipmentID: "B", "Exported to ERP": "0" }),
      row({ ShipmentID: "C", "Exported to ERP": true }),
      row({ ShipmentID: "D", "Exported to ERP": "No" }),
      row({ ShipmentID: "E", "Exported to ERP": "Yes" }),
      row({ ShipmentID: "F", "Exported to ERP": false }),
    ]);
    assert.deepEqual(rows.map((r) => r.shipment_id).sort(), ["B", "D", "F"]);
    assert.equal(summary.total, 3);
  });

  it("keeps a row that has no Exported column at all", () => {
    const r = row();
    delete r["Exported to ERP"];
    assert.equal(auditHistoryRows([r]).rows.length, 1);
  });

  it("copes with empty and junk input", () => {
    const empty = { total: 0, match: 0, discrepancy: 0, no_invoice: 0, total_charges: 0, total_cost: 0, flagged: 0 };
    assert.deepEqual(auditHistoryRows([]), { rows: [], summary: empty });
    assert.deepEqual(auditHistoryRows(null), { rows: [], summary: empty });
    assert.deepEqual(auditHistoryRows(undefined), { rows: [], summary: empty });
    assert.equal(auditHistoryRows([null, "x", 3, [], row()]).rows.length, 1);
  });
});

describe("auditHistoryRows — sort", () => {
  it("sorts by charge descending, nulls last, ties in report order", () => {
    const { rows } = auditHistoryRows([
      row({ ShipmentID: "low", "Shipment Marked-Up Rate": "100" }),
      row({ ShipmentID: "none-1", "Shipment Marked-Up Rate": "" }),
      row({ ShipmentID: "tie-1", "Shipment Marked-Up Rate": "$1,000.00" }),
      row({ ShipmentID: "top", "Shipment Marked-Up Rate": 2500 }),
      row({ ShipmentID: "tie-2", "Shipment Marked-Up Rate": "1000" }),
      row({ ShipmentID: "none-2", "Shipment Marked-Up Rate": null }),
      row({ ShipmentID: "zero", "Shipment Marked-Up Rate": "0" }),
      row({ ShipmentID: "tie-3", "Shipment Marked-Up Rate": 1000 }),
    ]);
    assert.deepEqual(rows.map((r) => r.shipment_id), ["top", "tie-1", "tie-2", "tie-3", "low", "zero", "none-1", "none-2"]);
    assert.deepEqual(rows.map((r) => r.raw.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("continues ranks from rankOffset", () => {
    const { rows } = auditHistoryRows([
      row({ "Shipment Marked-Up Rate": "10" }),
      row({ "Shipment Marked-Up Rate": "20" }),
    ], { rankOffset: 500 });
    assert.deepEqual(rows.map((r) => r.raw.rank), [501, 502]);
    assert.equal(rows[0].raw.charge, 20);
  });
});

describe("auditHistoryRows — bill, cost, difference, status", () => {
  const one = (over) => auditHistoryRows([row(over)]).rows[0];

  it("match when the approved invoice equals the cost", () => {
    const r = one({});
    assert.equal(r.bill_amount, 400);
    assert.equal(r.shipment_cost, 400);
    assert.equal(r.difference, 0);
    assert.equal(r.status, "match");
    assert.deepEqual(r.raw.flags, []);
  });

  it("match within one cent", () => {
    const r = one({ "Original Approved Invoice Amount": "400.01" });
    assert.equal(r.difference, 0.01);
    assert.equal(r.status, "match");
  });

  it("discrepancy beyond one cent, difference is bill minus cost at 2 dp", () => {
    const over = one({ "Original Approved Invoice Amount": "$455.555" });
    assert.equal(over.bill_amount, 455.56);
    assert.equal(over.difference, 55.56);
    assert.equal(over.status, "discrepancy");
    const under = one({ "Original Approved Invoice Amount": "350.10" });
    assert.equal(under.difference, -49.9);
    assert.equal(under.status, "discrepancy");
  });

  it("adds original and additional approved amounts", () => {
    const r = one({ "Original Approved Invoice Amount": "400.00", "Additional Approved Invoice Amount": "25.50" });
    assert.equal(r.bill_amount, 425.5);
    assert.equal(r.difference, 25.5);
    assert.equal(r.status, "discrepancy");
  });

  it("uses the additional amount on its own", () => {
    const r = one({ "Original Approved Invoice Amount": "", "Additional Approved Invoice Amount": "400" });
    assert.equal(r.bill_amount, 400);
    assert.equal(r.status, "match");
  });

  it("prefers approved amounts over the not-approved amount", () => {
    const r = one({ "Original Approved Invoice Amount": "400", "Not Approved Invoice Amount": "999" });
    assert.equal(r.bill_amount, 400);
    assert.equal(r.raw.not_approved_amount, 999);
    assert.ok(r.raw.flags.includes("invoice not approved"));
  });

  it("falls back to the not-approved amount", () => {
    const r = one({ "Original Approved Invoice Amount": "", "Not Approved Invoice Amount": "410.00" });
    assert.equal(r.bill_amount, 410);
    assert.equal(r.difference, 10);
    assert.equal(r.status, "discrepancy");
    assert.ok(r.raw.flags.includes("invoice not approved"));
  });

  it("no_invoice when the row has no invoice amount", () => {
    const blank = one({ "Original Approved Invoice Amount": "", "Additional Approved Invoice Amount": null });
    assert.equal(blank.bill_amount, null);
    assert.equal(blank.difference, null);
    assert.equal(blank.status, "no_invoice");
    assert.equal(blank.shipment_cost, 400);
  });

  it("treats zero invoice amounts as no invoice", () => {
    const r = one({ "Original Approved Invoice Amount": "0.00", "Additional Approved Invoice Amount": "0", "Not Approved Invoice Amount": 0 });
    assert.equal(r.bill_amount, null);
    assert.equal(r.status, "no_invoice");
    assert.ok(!r.raw.flags.includes("invoice not approved"));
  });

  it("discrepancy with no difference when there is an invoice but no cost", () => {
    const r = one({ "Shipment Rate without mark up": "" });
    assert.equal(r.shipment_cost, null);
    assert.equal(r.difference, null);
    assert.equal(r.status, "discrepancy");
    assert.ok(r.raw.flags.includes("no cost on file"));
  });
});

describe("auditHistoryRows — flags", () => {
  const flags = (over) => auditHistoryRows([row(over)]).rows[0].raw.flags;

  it("cost above charge", () => {
    assert.ok(flags({ "Shipment Marked-Up Rate": "300", "Shipment Rate without mark up": "400" }).includes("cost above charge"));
    assert.ok(!flags({ "Shipment Marked-Up Rate": "400", "Shipment Rate without mark up": "400" }).includes("cost above charge"));
  });

  it("cost above charge from a negative gross profit when the charge is missing", () => {
    const f = flags({ "Shipment Marked-Up Rate": "", "Shipment Rate without mark up": "", "Shipment Gross Profit": "-20" });
    assert.ok(f.includes("cost above charge"));
    assert.ok(f.includes("no charge on file"));
    assert.ok(f.includes("no cost on file"));
  });

  it("invoice above charge", () => {
    assert.ok(flags({ "Original Approved Invoice Amount": "600" }).includes("invoice above charge"));
    assert.ok(!flags({ "Original Approved Invoice Amount": "500" }).includes("invoice above charge"));
  });

  it("cancelled shipment, either spelling", () => {
    assert.ok(flags({ Status: "Cancelled" }).includes("cancelled shipment"));
    assert.ok(flags({ Status: "canceled" }).includes("cancelled shipment"));
    assert.ok(!flags({ Status: "Shipped" }).includes("cancelled shipment"));
  });

  it("no cost on file for blank and zero cost", () => {
    assert.ok(flags({ "Shipment Rate without mark up": "" }).includes("no cost on file"));
    assert.ok(flags({ "Shipment Rate without mark up": "0.00" }).includes("no cost on file"));
  });

  it("a row can carry several flags", () => {
    const f = flags({
      Status: "Cancelled",
      "Shipment Marked-Up Rate": "100",
      "Shipment Rate without mark up": "150",
      "Original Approved Invoice Amount": "",
      "Not Approved Invoice Amount": "175",
    });
    assert.deepEqual([...f].sort(), ["cancelled shipment", "cost above charge", "invoice above charge", "invoice not approved"]);
  });
});

describe("auditHistoryRows — row shape", () => {
  it("maps to the fpx_invoice_audit_rows shape with a compact raw", () => {
    const r = auditHistoryRows([row({
      ShipmentID: 13069382,
      Tracking: 401821050,
      "Billing Invoice Number": "INV-9",
      "Quote And Invoice Variance": "-12.50",
    })]).rows[0];
    assert.deepEqual(Object.keys(r).sort(), ["bill_amount", "carrier", "customer_name", "difference", "raw", "shipment_cost", "shipment_id", "status"]);
    assert.equal(r.shipment_id, "13069382");
    assert.equal(r.carrier, "UPS Freight");
    assert.equal(r.customer_name, "Acme Corp");
    assert.deepEqual(r.raw, {
      rank: 1,
      charge: 500,
      gross_profit: 100,
      shipped_date: "10/02/2026",
      invoice_number: "INV-9",
      tracking: "401821050",
      service: "LTL Standard",
      account_manager: "Dana Reyes",
      shipment_status: "Shipped",
      transaction_type: "Shipment",
      not_approved_amount: null,
      variance: -12.5,
      customer_invoice_sent: "Yes",
      user: "jsmith",
      flags: [],
    });
  });

  it("matches headers regardless of case, spacing and punctuation", () => {
    const { rows } = auditHistoryRows([{
      "customer name": "Globex",
      "SHIPMENT ID": "777",
      " carrier ": "XPO",
      "Shipment Marked Up Rate": "900",
      "shipment_rate_without_markup": "700",
      "original approved invoice amount": "700",
      "ExportedToERP": "No",
      "Shipped  Date": "09/15/2026",
      "billing-invoice-number": "B-1",
      "status": "Shipped",
    }]);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.shipment_id, "777");
    assert.equal(r.carrier, "XPO");
    assert.equal(r.customer_name, "Globex");
    assert.equal(r.raw.charge, 900);
    assert.equal(r.shipment_cost, 700);
    assert.equal(r.status, "match");
    assert.equal(r.raw.shipped_date, "09/15/2026");
    assert.equal(r.raw.invoice_number, "B-1");
  });

  it("still filters when the exported header is spelled differently", () => {
    assert.equal(auditHistoryRows([{ "exported_to_erp": "1", ShipmentID: "1" }]).rows.length, 0);
  });
});

describe("auditHistoryRows — summary", () => {
  it("counts statuses, totals and flagged rows over not-exported rows only", () => {
    const { summary } = auditHistoryRows([
      row({ "Shipment Marked-Up Rate": "500.10", "Shipment Rate without mark up": "400.20" }),                // discrepancy (bill 400 vs 400.20)
      row({ "Shipment Marked-Up Rate": "250.25", "Shipment Rate without mark up": "200.05", "Original Approved Invoice Amount": "200.05" }), // match
      row({ "Shipment Marked-Up Rate": "100", "Shipment Rate without mark up": "80", "Original Approved Invoice Amount": "" }),               // no_invoice
      row({ "Shipment Marked-Up Rate": "", "Shipment Rate without mark up": "", "Original Approved Invoice Amount": "", Status: "Cancelled" }), // no_invoice, flagged
      row({ "Shipment Marked-Up Rate": "9999", "Exported to ERP": "1" }),                                    // dropped
    ]);
    assert.deepEqual(summary, {
      total: 4,
      match: 1,
      discrepancy: 1,
      no_invoice: 2,
      total_charges: 850.35,
      total_cost: 680.25,
      flagged: 1,
    });
  });
});

describe("auditHistoryRows — purity", () => {
  it("does not mutate or reorder the input", () => {
    const input = [
      row({ "Shipment Marked-Up Rate": "1" }),
      row({ "Shipment Marked-Up Rate": "3", "Exported to ERP": "1" }),
      row({ "Shipment Marked-Up Rate": "2" }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    Object.freeze(input);
    input.forEach(Object.freeze);
    const first = auditHistoryRows(input);
    const second = auditHistoryRows(input);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(first, second);
    assert.notEqual(first.rows[0].raw.flags, second.rows[0].raw.flags);
  });
});
