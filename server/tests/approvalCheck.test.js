import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkApproval } from "../lib/approvalCheck.js";

const row = (over = {}) => ({
  shipment_id: "1", bill_amount: 155.8, shipment_cost: 155.8,
  raw: {
    charge: "168.26", gross_profit: "12.46",
    approval: { status: "approved", approved_by: "Shaun Zimmerman", amount: 155.8, invoice: "100" },
    get_invoice: { status: "done", shots: ["invoices/1-1.png", "invoices/1-invoice.pdf"] },
    ...over.raw,
  },
  ...over.row,
});
const view = (over = {}) => ({
  text: "Shipment Sale:\n$ 168.26\nShipment Cost:\n$ 155.8\nGross Profit:\n$ 12.46",
  files: ["invoices/1-view-1.png", "invoices/1-view-print-shipping-labels-bol-file.pdf", "invoices/1-view-print-rate-confirmation-file.pdf"],
  data: { buttons: [{ label: "DETAILS", did: "opened" }] },
  ...over,
});
const approval = (data = {}) => ({ approved_by: "Shaun Zimmerman", invoice_amount: 155.8, quote_amount: 155.8, invoice_number: "100", data: { "POD Date": "10/13/2026", ...data } });

describe("checkApproval", () => {
  test("everything held and matching is 100", () => {
    const r = checkApproval(row(), view(), approval());
    assert.deepEqual(r, { confidence: 100, pass: true, missing: [], issues: [], cautions: [] });
  });

  test("a forced approval of a duplicate invoice still passes at exactly 90", () => {
    const r = checkApproval(row(), view(), { ...approval({ "Is Forced Approved": "true" }), invoice_number: "37341095-DUP1" });
    assert.equal(r.confidence, 90);
    assert.equal(r.pass, true);
    assert.equal(r.cautions.length, 2);
  });

  test("no saved record: the shipment details and the invoice PDF are missing", () => {
    const r = checkApproval(row({ raw: { get_invoice: null } }), null, approval());
    assert.equal(r.confidence, 75);
    assert.equal(r.pass, false);
    assert.deepEqual(r.missing, ["Customer invoice PDF (Get Invoice)", "Shipment details (View Shipment)"]);
  });

  test("an invoice over the quoted cost is an issue and fails", () => {
    const r = checkApproval(row({ row: { bill_amount: 200 } }), view(), { ...approval(), invoice_amount: 200 });
    assert.equal(r.pass, false);
    assert.match(r.issues[0], /\$44\.20 over the quoted cost/);
  });

  test("a View Shipment record without its documents names each one", () => {
    const r = checkApproval(row(), view({ files: ["invoices/1-view-1.png"], data: {} }), approval());
    assert.deepEqual(r.missing, ["Quote breakdown (freight, fuel, accessorials)", "Bill of lading", "Rate confirmation"]);
    assert.equal(r.confidence, 85);
  });

  test("the threshold can be set", () => {
    assert.equal(checkApproval(row({ raw: { get_invoice: null } }), null, approval(), 70).pass, true);
  });

  test("nothing known about the shipment never goes below 0", () => {
    const r = checkApproval({ raw: {} }, null, null);
    assert.equal(r.confidence, 0);
    assert.equal(r.pass, false);
  });
});
