import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  statusLabel, bucketOf, parseRecipients, sortByChargeDesc, summarizeRows, reportDay, reportFilename,
  reportObjectPath, matchesQuery, reportColumns, sheetRow, summarySheetRows, windowNote, writeWorkbook,
  buildReportEmail, relaySender, emailTransport, FPX_COLUMNS, DEFAULT_RECIPIENTS,
} from "../lib/invoiceReport.js";
import { unzip, readXlsx } from "../lib/xlsxRead.js";

const row = (over = {}) => ({
  shipment_id: "100", status: "no_invoice", customer: "Acme Co", carrier: "XPO", tracking: "TRK1",
  ship_date: "2026-11-01", charge: 100, cost: 80, invoice_number: null, approved_by: null,
  docs_saved: false, last_pulled_at: "2026-11-20T10:00:00Z", run_number: 3, data: {}, ...over,
});

describe("status labels", () => {
  it("names every bucket", () => {
    assert.equal(statusLabel("no_invoice"), "No invoice");
    assert.equal(statusLabel("invoice_not_approved"), "Invoice not approved");
    assert.equal(statusLabel("approved_ready"), "Approved – ready to export");
    assert.equal(statusLabel("exported"), "Exported to ERP");
    assert.equal(statusLabel("weird"), "weird");
  });
  it("bucketOf follows the view's rule", () => {
    assert.equal(bucketOf({ exported_to_erp: true, approved_invoice_amount: 5 }), "exported");
    assert.equal(bucketOf({ approved_invoice_amount: 5 }), "approved_ready");
    assert.equal(bucketOf({}, { approval_key: "x" }), "approved_ready");
    assert.equal(bucketOf({ not_approved_invoice_amount: "12" }), "invoice_not_approved");
    assert.equal(bucketOf({ exported_to_erp: false }), "no_invoice");
  });
});

describe("parseRecipients", () => {
  it("splits, trims, lowercases and dedupes", () => {
    assert.deepEqual(parseRecipients(" A@FreightPOP.com, b@freightpop.com;a@freightpop.com "), ["a@freightpop.com", "b@freightpop.com"]);
  });
  it("accepts arrays and JSON arrays", () => {
    assert.deepEqual(parseRecipients(["x@freightpop.com", "bad"]), ["x@freightpop.com"]);
    assert.deepEqual(parseRecipients('["y@freightpop.com"]'), ["y@freightpop.com"]);
  });
  it("falls back to the default when nothing is valid", () => {
    assert.deepEqual(parseRecipients(""), DEFAULT_RECIPIENTS);
    assert.deepEqual(parseRecipients(null), ["isaacs@freightpop.com"]);
    assert.deepEqual(parseRecipients("not-an-email"), DEFAULT_RECIPIENTS);
  });
});

describe("sort and summary", () => {
  it("sorts biggest charge first, nulls last, ties by id", () => {
    const out = sortByChargeDesc([row({ shipment_id: "2", charge: 5 }), row({ shipment_id: "9", charge: null }),
      row({ shipment_id: "10", charge: 50 }), row({ shipment_id: "1", charge: 50 })]);
    assert.deepEqual(out.map((r) => r.shipment_id), ["1", "10", "2", "9"]);
  });
  it("adds up counts and money by status", () => {
    const s = summarizeRows([
      row({ status: "no_invoice", charge: 100.1, cost: 80 }),
      row({ status: "approved_ready", charge: "1,000.20", cost: 900 }),
      row({ status: "approved_ready", charge: null, cost: null }),
      row({ status: "invoice_not_approved", charge: 0.1, cost: 0.2 }),
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.no_invoice, 1);
    assert.equal(s.approved_ready, 2);
    assert.equal(s.invoice_not_approved, 1);
    assert.equal(s.charge_total, 1100.4);
    assert.equal(s.cost_total, 980.2);
    assert.equal(s.by_status.approved_ready.charge, 1000.2);
  });
  it("summary sheet rows end with the totals and notes", () => {
    const s = summarizeRows([row()]);
    const r = summarySheetRows(s, { generatedAt: new Date("2026-11-20T00:00:00Z"), windowNote: "All time." });
    assert.equal(r[3].Status, "Total not exported");
    assert.equal(r[3].Shipments, 1);
    assert.equal(r[5].Shipments, "2026-11-20T00:00:00.000Z");
    assert.equal(r[6].Shipments, "All time.");
  });
  it("window note gives the ship date range", () => {
    assert.match(windowNote([row({ ship_date: "2026-10-02" }), row({ ship_date: "2026-11-05" }), row({ ship_date: null })]), /2026-10-02 to 2026-11-05/);
  });
});

describe("names and paths", () => {
  it("uses the Pacific calendar day", () => {
    const late = new Date("2026-11-21T05:00:00Z"); // 9pm on the 20th in California
    assert.equal(reportDay(late), "2026-11-20");
    assert.equal(reportFilename(late), "FPX-not-exported-to-ERP-2026-11-20.xlsx");
    assert.equal(reportObjectPath(late), "reports/2026-11-20/FPX-not-exported-to-ERP-2026-11-20.xlsx");
  });
});

describe("search", () => {
  it("matches every word against ids and names", () => {
    assert.ok(matchesQuery(row(), "acme xpo"));
    assert.ok(matchesQuery(row(), "trk"));
    assert.ok(!matchesQuery(row(), "acme fedex"));
    assert.ok(matchesQuery(row(), ""));
  });
});

describe("columns and rows", () => {
  it("keeps FreightPOP's order, then extras, then FPX columns", () => {
    const cols = reportColumns(["ShipmentID", "Carrier", "Customer Name"], [row({ data: { Zeta: "1", Carrier: "X", Alpha: "2" } })]);
    assert.deepEqual(cols, ["ShipmentID", "Carrier", "Customer Name", "Alpha", "Zeta", ...FPX_COLUMNS]);
  });
  it("writes FPX values and leaves blanks out", () => {
    const cols = reportColumns(["ShipmentID", "Notes"], []);
    const o = sheetRow(row({ data: { ShipmentID: "100", Notes: "" }, status: "approved_ready", approved_by: "EDI", docs_saved: true }), cols);
    assert.deepEqual(o, { ShipmentID: "100", "FPX Status": "Approved – ready to export", "Approved by": "EDI", "Documents saved": "Yes", "Last pulled": "2026-11-20", "Run #": 3 });
  });
});

describe("writeWorkbook", () => {
  it("writes two named sheets", () => {
    const buf = writeWorkbook([
      { name: "Not exported", headers: ["A", "B", "C"], rows: [{ A: "1", B: 2, C: "x" }] },
      { name: "Summary", headers: ["Status", "Shipments"], rows: [{ Status: "Total", Shipments: 1 }] },
    ]);
    const files = unzip(buf);
    const wb = files.get("xl/workbook.xml").toString("utf8");
    assert.match(wb, /name="Not exported" sheetId="1"/);
    assert.match(wb, /name="Summary" sheetId="2"/);
    assert.ok(files.get("xl/worksheets/sheet2.xml").toString("utf8").includes("Total"));
    const { headers, rows } = readXlsx(buf);
    assert.deepEqual(headers, ["A", "B", "C"]);
    assert.equal(rows.length, 1);
  });
});

describe("email", () => {
  const summary = summarizeRows([row({ charge: 123000 }), row({ status: "approved_ready", charge: 456 })]);
  it("subject has count, charge and run", () => {
    const m = buildReportEmail({ summary, runNumber: 12, downloadUrl: "https://x/y?a=1&b=2" });
    assert.equal(m.subject, "Not exported to ERP — 2 shipments ($123,456) · Run #12");
    assert.ok(m.html.includes("https://fpxpress.netlify.app/invoices"));
    assert.ok(m.html.includes("https://x/y?a=1&amp;b=2"));
    assert.ok(m.text.includes("Approved – ready to export: 1 ($456)"));
  });
  it("no run number → no run in the subject", () => {
    assert.equal(buildReportEmail({ summary }).subject, "Not exported to ERP — 2 shipments ($123,456)");
  });
  it("picks the transport like notify.js", () => {
    assert.equal(emailTransport({ SALESOS_EMAIL_KEY: "k", RESEND_API_KEY: "r" }), "relay");
    assert.equal(emailTransport({ RESEND_API_KEY: "r" }), "resend");
    assert.equal(emailTransport({}), null);
    assert.deepEqual(relaySender("FPX <fpx@updates.freightpopsales.com>"), { fromName: "FPX", fromLocal: "fpx" });
  });
});
