import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  trackingKey, dateOnly, transactionRow, transactionRows, dedupeTransactions, planTransactionUpsert,
  approvalRow, approvalRows, dedupeApprovals, planApprovalUpsert, APPROVAL_COLUMNS,
  upsertTransactions, upsertApprovals,
} from "../lib/erpStore.js";
import { normalizeShipmentId, matchApprovals } from "../lib/approvalMatch.js";

const SEEN = "2026-11-14T12:00:00.000Z";
const AUDIT = "11111111-2222-4333-8444-555555555555";

// A History Report row, keyed by FreightPOP's own header titles.
const report = (over = {}) => ({
  ShipmentID: "13000001",
  Tracking: "047976058",
  "Customer Id": "C-77",
  "Customer Name": "Acme Co",
  "Account Manager": "Dana Reyes",
  Carrier: "XPO Logistics",
  Service: "LTL Standard",
  Status: "Delivered",
  "Transaction Type": "Shipment",
  "Shipped Date": "03/31/2026",
  "Billing Invoice Number": "BILL-9",
  "Shipment Marked-Up Rate": "$1,234.50",
  "Shipment Rate without mark up": "1000",
  "Shipment Gross Profit": "234.50",
  "Original Approved Invoice Amount": "900.10",
  "Additional Approved Invoice Amount": "50.05",
  "Original Invoice Approved Date": "2026-04-02T00:00:00",
  "Not Approved Invoice Amount": "0",
  "Quote And Invoice Variance": "(49.85)",
  "Exported to ERP": "0",
  "Customer Invoice Sent": "Yes",
  ...over,
});

const RECENT_COLS = [
  "Carrier", "Carrier SCAC", "Date Uploaded", "Approved Date", "Invoice Date", "Shipment Date", "Invoice Number",
  "Tracking Number", "Invoice Amount", "Quote Amount", "Variance", "BOL Number", "SO Number", "PO Number", "Payee",
  "Ship From Company Name", "Ship To Company Name", "Due Date", "Approved By", "Uploaded By", "Notes", "GL Code",
  "Loc Id", "Number of Invoices for Tracking Number", "Customer Audit", "Shipment Status", "Shipment Processed By",
];
const HISTORY_COLS = [
  "Carrier", "Carrier SCAC", "Internal Vendor ID", "Date Uploaded", "Approved Date", "Invoice Date", "Shipment Date",
  "Invoice Number", "Tracking Number", "Invoice Amount", "Quote Amount", "Variance", "Ship From State", "Due Date",
  "Pickedup Date", "POD Date", "Signed By", "Exported Date", "Approved By", "Uploaded By", "Notes", "GL Code",
  "Number of Invoices for Tracking Number", "Customer Audit", "Shipment Status", "Shipment Processed By",
];
const blankRow = (cols) => Object.fromEntries(cols.map((c) => [c, ""]));
const recent = (over = {}) => ({
  ...blankRow(RECENT_COLS),
  Carrier: "XPO Logistics",
  "Carrier SCAC": "XPOL",
  "Approved Date": "4/2/2026 3:15 PM",
  "Invoice Date": "03/31/2026",
  "Shipment Date": "03/28/2026",
  "Invoice Number": " inv-100a ",
  "Tracking Number": "47976058",
  "Invoice Amount": "$950.15",
  "Quote Amount": "1,000.00",
  Variance: "-49.85",
  "Approved By": "EDI",
  "Uploaded By": "edi@freightpop.com",
  Notes: "auto approved",
  "Shipment Status": "Delivered",
  ...over,
});
const history = (over = {}) => ({
  ...blankRow(HISTORY_COLS),
  Carrier: "XPO Logistics",
  "Carrier SCAC": "XPOL",
  "Approved Date": "04/02/2026",
  "Invoice Number": "INV-100A",
  "Tracking Number": " 47976058.0",
  "Invoice Amount": "950.15",
  "Exported Date": "04/05/2026",
  "Approved By": "shaun.smith@x.com",
  "Shipment Status": "Delivered",
  ...over,
});

const keysOf = (rows) => [...new Set(rows.map((r) => Object.keys(r).sort().join(",")))];

describe("trackingKey", () => {
  it("is the matcher's own normalisation", () => {
    for (const v of ["047976058", 47976058, " 47976058.0", "abc-1 ", "000"]) {
      assert.equal(trackingKey(v), normalizeShipmentId(v));
    }
    assert.equal(trackingKey("047976058"), "47976058");
    assert.equal(trackingKey(47976058), "47976058");
    assert.equal(trackingKey(" 47976058.0"), "47976058");
    assert.equal(trackingKey("pro-12a"), "PRO-12A");
  });

  it("is null for blank", () => {
    for (const v of [null, undefined, "", "   ", {}]) assert.equal(trackingKey(v), null);
  });
});

describe("dateOnly", () => {
  it("reads US, ISO and Excel dates as a day", () => {
    assert.equal(dateOnly("03/31/2026"), "2026-03-31");
    assert.equal(dateOnly("3/1/2026"), "2026-03-01");
    assert.equal(dateOnly("4/2/2026 3:15 PM"), "2026-04-02");
    assert.equal(dateOnly("12/31/26"), "2026-12-31");
    assert.equal(dateOnly("2026-03-31"), "2026-03-31");
    assert.equal(dateOnly("2026-03-31T00:00:00"), "2026-03-31");
    assert.equal(dateOnly("2026-03-31T23:30:00Z"), "2026-03-31");
    assert.equal(dateOnly("2026-03-31 08:00"), "2026-03-31");
    assert.equal(dateOnly(46112), "2026-03-31");
    assert.equal(dateOnly("46112"), "2026-03-31");
    assert.equal(dateOnly(new Date("2026-03-31T10:00:00Z")), "2026-03-31");
  });

  it("is null for anything that is not a real day", () => {
    for (const v of [null, undefined, "", "n/a", "13/45/2026", "02/30/2026", "2026-13-01", 5, {}, "Delivered"]) {
      assert.equal(dateOnly(v), null);
    }
  });
});

describe("transactionRow", () => {
  it("maps FreightPOP's header titles to the table's columns", () => {
    const src = report();
    const row = transactionRow(src, { auditId: AUDIT, shipmentType: "non-parcel", seenAt: SEEN });
    assert.deepEqual(row, {
      shipment_id: "13000001",
      tracking_number: "047976058",
      tracking_key: "47976058",
      customer_id: "C-77",
      customer_name: "Acme Co",
      account_manager: "Dana Reyes",
      carrier: "XPO Logistics",
      service: "LTL Standard",
      status: "Delivered",
      transaction_type: "Shipment",
      shipped_date: "2026-03-31",
      billing_invoice_number: "BILL-9",
      charge: 1234.5,
      cost: 1000,
      gross_profit: 234.5,
      approved_invoice_amount: 950.15,
      invoice_approved_date: "2026-04-02",
      not_approved_invoice_amount: 0,
      quote_invoice_variance: -49.85,
      exported_to_erp: false,
      customer_invoice_sent: "Yes",
      data: src,
      last_seen_at: SEEN,
      last_pull_audit_id: AUDIT,
      shipment_type: "non-parcel",
    });
    assert.equal(row.data, src);
  });

  it("never sets first_seen_at or exported_changed_at", () => {
    const row = transactionRow(report(), { seenAt: SEEN });
    assert.equal("first_seen_at" in row, false);
    assert.equal("exported_changed_at" in row, false);
  });

  it("leaves out the audit id and shipment type when they are not given", () => {
    const row = transactionRow(report(), { seenAt: SEEN });
    assert.equal("last_pull_audit_id" in row, false);
    assert.equal("shipment_type" in row, false);
  });

  it("reads the exported flag, and null when the report has no such column", () => {
    for (const v of ["1", "Yes", true, 1, "True"]) {
      assert.equal(transactionRow(report({ "Exported to ERP": v })).exported_to_erp, true);
    }
    for (const v of ["0", "No", false, 0, "", null]) {
      assert.equal(transactionRow(report({ "Exported to ERP": v })).exported_to_erp, false);
    }
    const { "Exported to ERP": _drop, ...without } = report();
    assert.equal(transactionRow(without).exported_to_erp, null);
  });

  it("parses money, and adds the two approved amounts", () => {
    const blank = transactionRow(report({ "Original Approved Invoice Amount": "", "Additional Approved Invoice Amount": null }));
    assert.equal(blank.approved_invoice_amount, null);
    const one = transactionRow(report({ "Original Approved Invoice Amount": "", "Additional Approved Invoice Amount": "12.5" }));
    assert.equal(one.approved_invoice_amount, 12.5);
    const odd = transactionRow(report({ "Shipment Marked-Up Rate": "n/a", "Shipment Rate without mark up": "", "Shipment Gross Profit": "(5.00)" }));
    assert.equal(odd.charge, null);
    assert.equal(odd.cost, null);
    assert.equal(odd.gross_profit, -5);
  });

  it("is tolerant of header spelling", () => {
    const row = transactionRow({ "Shipment Id": 13000002, "tracking number": " 1Z99 ", "CUSTOMER ID": 5, "Ship Date": "2026-01-02" });
    assert.equal(row.shipment_id, "13000002");
    assert.equal(row.tracking_key, "1Z99");
    assert.equal(row.customer_id, "5");
    assert.equal(row.shipped_date, "2026-01-02");
  });

  it("is null without a shipment id", () => {
    assert.equal(transactionRow(report({ ShipmentID: "  " })), null);
    assert.equal(transactionRow({ Tracking: "1" }), null);
    for (const v of [null, undefined, "x", 3, []]) assert.equal(transactionRow(v), null);
  });
});

describe("transactionRows / dedupeTransactions", () => {
  it("collapses rows for one shipment: the last one wins", () => {
    const out = transactionRows([
      report({ Carrier: "First" }),
      report({ ShipmentID: "2" }),
      report({ ShipmentID: "" }),
      report({ Carrier: "Last" }),
    ], { seenAt: SEEN });
    assert.equal(out.received, 4);
    assert.equal(out.skipped_no_id, 1);
    assert.deepEqual(out.rows.map((r) => [r.shipment_id, r.carrier]), [["13000001", "Last"], ["2", "XPO Logistics"]]);
    assert.ok(out.rows.every((r) => r.last_seen_at === SEEN));
  });

  it("copes with no rows", () => {
    assert.deepEqual(transactionRows(null), { rows: [], received: 0, skipped_no_id: 0 });
    assert.deepEqual(dedupeTransactions([null, {}, { shipment_id: "" }]), []);
  });
});

describe("planTransactionUpsert", () => {
  const NOW = "2026-11-15T00:00:00.000Z";
  const t = (id, exported) => transactionRow(report({ ShipmentID: id, "Exported to ERP": exported }), { auditId: AUDIT, seenAt: SEEN });

  it("stamps exported_changed_at only where the flag flipped", () => {
    const rows = [t("new", "1"), t("same-no", "0"), t("same-yes", "1"), t("now-yes", "1"), t("now-no", "0"), t("was-null", "0"), t("null-yes", "1")];
    const existing = [
      { shipment_id: "same-no", exported_to_erp: false },
      { shipment_id: "same-yes", exported_to_erp: true },
      { shipment_id: "now-yes", exported_to_erp: false },
      { shipment_id: "now-no", exported_to_erp: true },
      { shipment_id: "was-null", exported_to_erp: null },
      { shipment_id: "null-yes", exported_to_erp: null },
    ];
    const { plain, flipped } = planTransactionUpsert(rows, existing, NOW);
    assert.deepEqual(plain.map((r) => r.shipment_id), ["new", "same-no", "same-yes", "was-null"]);
    assert.deepEqual(flipped.map((r) => r.shipment_id), ["now-yes", "now-no", "null-yes"]);
    assert.ok(flipped.every((r) => r.exported_changed_at === NOW));
  });

  it("gives each group one column set, without first_seen_at", () => {
    const rows = [t("a", "1"), t("b", "0"), t("c", "1"), { ...t("d", "0"), first_seen_at: "x", exported_changed_at: "y" }];
    const { plain, flipped } = planTransactionUpsert(rows, [{ shipment_id: "c", exported_to_erp: false }], NOW);
    assert.equal(keysOf(plain).length, 1);
    assert.equal(keysOf(flipped).length, 1);
    assert.ok(plain.every((r) => !("first_seen_at" in r) && !("exported_changed_at" in r)));
    assert.ok(flipped.every((r) => !("first_seen_at" in r) && "exported_changed_at" in r));
    assert.deepEqual(
      Object.keys(flipped[0]).filter((k) => !(k in plain[0])),
      ["exported_changed_at"],
    );
  });

  it("does not call it a flip when the report had no exported column", () => {
    const { "Exported to ERP": _drop, ...without } = report({ ShipmentID: "x" });
    const { plain, flipped } = planTransactionUpsert([transactionRow(without)], [{ shipment_id: "x", exported_to_erp: true }], NOW);
    assert.equal(plain.length, 1);
    assert.equal(flipped.length, 0);
  });

  it("does not change its input", () => {
    const rows = [t("a", "1")];
    const copy = structuredClone(rows);
    planTransactionUpsert(rows, [{ shipment_id: "a", exported_to_erp: false }], NOW);
    assert.deepEqual(rows, copy);
  });
});

describe("approvalRow", () => {
  it("maps a Recently Approved row", () => {
    const src = recent();
    const row = approvalRow(src, RECENT_COLS, { source: "recently_approved", seenAt: SEEN });
    assert.deepEqual(row, {
      approval_key: "47976058|INV-100A",
      tracking_number: "47976058",
      tracking_key: "47976058",
      invoice_number: "inv-100a",
      carrier: "XPO Logistics",
      carrier_scac: "XPOL",
      approved_date: "2026-04-02",
      approved_at_text: "4/2/2026 3:15 PM",
      approved_by: "EDI",
      approved_by_kind: "edi",
      approved_by_raw: "EDI",
      uploaded_by: "edi@freightpop.com",
      invoice_amount: 950.15,
      quote_amount: 1000,
      variance: -49.85,
      invoice_date: "2026-03-31",
      shipment_date: "2026-03-28",
      exported_date: null,
      notes: "auto approved",
      source: "recently_approved",
      data: src,
      last_seen_at: SEEN,
    });
    assert.equal("first_seen_at" in row, false);
    assert.deepEqual(Object.keys(row).filter((k) => !APPROVAL_COLUMNS.includes(k)), ["data", "last_seen_at"]);
  });

  it("maps a History row: a person, and the exported date", () => {
    const row = approvalRow(history(), HISTORY_COLS, { source: "history", seenAt: SEEN });
    assert.equal(row.approval_key, "47976058|INV-100A");
    assert.equal(row.tracking_number, "47976058.0");
    assert.equal(row.approved_by, "Shaun Smith");
    assert.equal(row.approved_by_kind, "person");
    assert.equal(row.approved_by_raw, "shaun.smith@x.com");
    assert.equal(row.exported_date, "2026-04-05");
    assert.equal(row.source, "history");
  });

  it("has the same key as the shipment it belongs to, and as the matcher", () => {
    const shipment = transactionRow(report({ Tracking: "047976058" }));
    for (const tracking of ["047976058", 47976058, " 47976058.0"]) {
      const row = approvalRow(recent({ "Tracking Number": tracking }), RECENT_COLS);
      assert.equal(row.tracking_key, shipment.tracking_key);
      const matched = matchApprovals([{ shipment_id: "1", raw: { tracking: "047976058" } }], [recent({ "Tracking Number": tracking })], RECENT_COLS);
      assert.equal(matched.results[0].status, "approved");
    }
  });

  it("keys an approval with no invoice number by its tracking number alone", () => {
    assert.equal(approvalRow(recent({ "Invoice Number": "" }), RECENT_COLS).approval_key, "47976058|");
  });

  it("is unknown when nobody is named", () => {
    const row = approvalRow(recent({ "Approved By": "" }), RECENT_COLS);
    assert.deepEqual([row.approved_by, row.approved_by_kind, row.approved_by_raw], [null, "unknown", null]);
  });

  it("is null without a tracking number", () => {
    assert.equal(approvalRow(recent({ "Tracking Number": " " }), RECENT_COLS), null);
    assert.equal(approvalRow(null, RECENT_COLS), null);
  });

  it("reads a row sent as a plain list by position", () => {
    const src = recent();
    const row = approvalRow(RECENT_COLS.map((c) => src[c]), RECENT_COLS, { seenAt: SEEN });
    assert.equal(row.approval_key, "47976058|INV-100A");
    assert.equal(row.data["Carrier SCAC"], "XPOL");
  });
});

describe("approvalRows", () => {
  it("drops History rows that are not approvals before mapping", () => {
    const out = approvalRows([
      history(),
      history({ "Tracking Number": "222", "Approved Date": "", "Approved By": "" }),
      history({ "Tracking Number": "333", "Approved Date": "", "Approved By": "Pat Lee" }),
    ], HISTORY_COLS, { source: "history", seenAt: SEEN });
    assert.equal(out.received, 3);
    assert.equal(out.dropped, 1);
    assert.deepEqual(out.rows.map((r) => r.tracking_key), ["47976058", "333"]);
    assert.ok(out.rows.every((r) => r.source === "history"));
  });

  it("uses a status column when the export has one", () => {
    const cols = [...HISTORY_COLS, "Status"];
    const out = approvalRows([
      { ...history(), Status: "Approved" },
      { ...history({ "Tracking Number": "222" }), Status: "Not Approved" },
    ], cols, { source: "history" });
    assert.equal(out.dropped, 1);
    assert.deepEqual(out.rows.map((r) => r.tracking_key), ["47976058"]);
  });

  it("keeps every Recently Approved row that has a tracking number", () => {
    const out = approvalRows([
      recent(),
      recent({ "Tracking Number": "" }),
      recent({ "Tracking Number": "222", "Approved Date": "", "Approved By": "" }),
    ], RECENT_COLS, { seenAt: SEEN });
    assert.equal(out.dropped, 0);
    assert.equal(out.skipped_no_tracking, 1);
    assert.deepEqual(out.rows.map((r) => r.approval_key), ["47976058|INV-100A", "222|INV-100A"]);
  });

  it("takes the headers from the rows when none are sent", () => {
    const out = approvalRows([recent()], undefined, {});
    assert.equal(out.rows[0].approval_key, "47976058|INV-100A");
    assert.equal(out.rows[0].source, "recently_approved");
  });
});

describe("dedupeApprovals", () => {
  const a = (over) => ({ approval_key: "K|1", approved_at_text: null, approved_date: null, source: "recently_approved", ...over });

  it("keeps the latest approved date", () => {
    const out = dedupeApprovals([
      a({ approved_at_text: "4/2/2026 3:15 PM", notes: "late" }),
      a({ approved_at_text: "4/2/2026 9:00 AM", notes: "early" }),
      a({ approved_at_text: null, notes: "no date" }),
      a({ approval_key: "K|2", notes: "other" }),
    ]);
    assert.deepEqual(out.map((r) => r.notes), ["late", "other"]);
  });

  it("falls back to approved_date when there is no printed text", () => {
    const out = dedupeApprovals([a({ approved_date: "2026-04-01", notes: "old" }), a({ approved_date: "2026-04-03", notes: "new" })]);
    assert.equal(out[0].notes, "new");
  });

  it("on a tie Recently Approved beats History, whichever comes first", () => {
    const ra = a({ approved_date: "2026-04-02", notes: "ra" });
    const hi = a({ approved_date: "2026-04-02", source: "history", notes: "hi" });
    assert.equal(dedupeApprovals([ra, hi])[0].notes, "ra");
    assert.equal(dedupeApprovals([hi, ra])[0].notes, "ra");
    assert.equal(dedupeApprovals([a({ source: "history", notes: "h" }), a({ notes: "r" })])[0].notes, "r");
  });

  it("within one source the later row wins a tie", () => {
    assert.equal(dedupeApprovals([a({ notes: "1" }), a({ notes: "2" })])[0].notes, "2");
  });

  it("leaves out rows without a key", () => {
    assert.deepEqual(dedupeApprovals([null, {}, { approval_key: "" }]), []);
    assert.deepEqual(dedupeApprovals(undefined), []);
  });
});

describe("planApprovalUpsert", () => {
  const ra = (over = {}) => approvalRow(recent(over), RECENT_COLS, { source: "recently_approved", seenAt: SEEN });
  const hi = (over = {}) => approvalRow(history(over), HISTORY_COLS, { source: "history", seenAt: "2026-11-14T13:00:00.000Z" });
  const stored = (row) => Object.fromEntries(APPROVAL_COLUMNS.map((c) => [c, row[c]]));

  it("writes new approvals whole", () => {
    const { write, fill } = planApprovalUpsert([ra(), hi({ "Tracking Number": "9" })], []);
    assert.equal(write.length, 2);
    assert.equal(fill.length, 0);
    assert.equal(keysOf(write).length, 1);
    assert.deepEqual(Object.keys(write[0]).sort(), [...APPROVAL_COLUMNS, "data", "last_seen_at"].sort());
  });

  it("a History row only fills the blanks of a stored Recently Approved row", () => {
    const before = stored(ra({ "Approved By": "", "Carrier SCAC": "", Notes: "kept" }));
    const { write, fill } = planApprovalUpsert([hi({ Notes: "from history", "Invoice Amount": "1.00" })], [before]);
    assert.equal(write.length, 0);
    assert.equal(fill.length, 1);
    const f = fill[0];
    assert.equal(f.source, "recently_approved");
    assert.equal(f.notes, "kept");
    assert.equal(f.invoice_amount, 950.15);
    assert.equal(f.approved_at_text, "4/2/2026 3:15 PM");
    assert.equal(f.carrier_scac, "XPOL");
    assert.equal(f.exported_date, "2026-04-05");
    assert.deepEqual([f.approved_by, f.approved_by_kind, f.approved_by_raw], ["Shaun Smith", "person", "shaun.smith@x.com"]);
    assert.equal(f.last_seen_at, "2026-11-14T13:00:00.000Z");
    assert.deepEqual(Object.keys(f).sort(), [...APPROVAL_COLUMNS, "last_seen_at"].sort());
    assert.equal("data" in f, false);
    assert.equal("first_seen_at" in f, false);
  });

  it("a History row never changes the approver Recently Approved gave", () => {
    const { fill } = planApprovalUpsert([hi()], [stored(ra())]);
    assert.deepEqual([fill[0].approved_by, fill[0].approved_by_kind, fill[0].approved_by_raw], ["EDI", "edi", "EDI"]);
  });

  it("a row stored before `source` existed counts as Recently Approved", () => {
    const { write, fill } = planApprovalUpsert([hi()], [{ ...stored(ra()), source: null }]);
    assert.equal(write.length, 0);
    assert.equal(fill.length, 1);
  });

  it("a History row replaces a stored History row", () => {
    const { write, fill } = planApprovalUpsert([hi({ Notes: "newer" })], [stored(hi({ Notes: "older" }))]);
    assert.equal(fill.length, 0);
    assert.equal(write[0].notes, "newer");
    assert.equal(write[0].source, "history");
  });

  it("a Recently Approved row replaces a stored History row, keeping History's value where its own is blank", () => {
    const { write, fill } = planApprovalUpsert([ra({ "Approved By": "", Notes: "" })], [stored(hi({ Notes: "history note" }))]);
    assert.equal(fill.length, 0);
    const w = write[0];
    assert.equal(w.source, "recently_approved");
    assert.equal(w.notes, "history note");
    assert.equal(w.exported_date, "2026-04-05");
    assert.equal(w.approved_at_text, "4/2/2026 3:15 PM");
    assert.deepEqual([w.approved_by, w.approved_by_kind, w.approved_by_raw], ["Shaun Smith", "person", "shaun.smith@x.com"]);
    assert.ok("data" in w);
  });

  it("gives each group one column set", () => {
    const rows = [ra(), ra({ "Tracking Number": "2" }), hi({ "Tracking Number": "3" }), hi({ "Tracking Number": "4" }), hi({ "Tracking Number": "5" })];
    const existing = [stored(hi({ "Tracking Number": "2" })), stored(ra({ "Tracking Number": "4" })), stored(ra({ "Tracking Number": "5" }))];
    const { write, fill } = planApprovalUpsert(rows, existing);
    assert.deepEqual(write.map((r) => r.tracking_key), ["47976058", "2", "3"]);
    assert.deepEqual(fill.map((r) => r.tracking_key), ["4", "5"]);
    assert.equal(keysOf(write).length, 1);
    assert.equal(keysOf(fill).length, 1);
  });
});

// A stand-in for the supabase client that records what it is asked.
function fakeDb({ existing = [], failRead = false, failUpsert = () => false, throwOn = null } = {}) {
  const calls = { reads: [], upserts: [] };
  return {
    calls,
    from(table) {
      return {
        select(columns) {
          return {
            async in(key, keys) {
              calls.reads.push({ table, columns, key, keys });
              if (throwOn === "read") throw new Error("network down");
              if (failRead) return { data: null, error: { message: "read failed" } };
              return { data: existing.filter((e) => keys.includes(e[key])), error: null };
            },
          };
        },
        async upsert(rows, opts) {
          calls.upserts.push({ table, rows, opts });
          return failUpsert(rows) ? { error: { message: "upsert failed" } } : { error: null };
        },
      };
    },
  };
}

describe("upsertTransactions", () => {
  const t = (id, exported = "0") => transactionRow(report({ ShipmentID: id, "Exported to ERP": exported }), { seenAt: SEEN });

  it("reads what is stored, then upserts the two groups", async () => {
    const db = fakeDb({ existing: [{ shipment_id: "b", exported_to_erp: false }] });
    const out = await upsertTransactions(db, [t("a"), t("b", "1"), t("c")]);
    assert.deepEqual(out, { upserted: 3, failed: 0 });
    assert.deepEqual(db.calls.reads.map((r) => [r.table, r.columns, r.key, r.keys]), [
      ["fpx_erp_transactions", "shipment_id, exported_to_erp", "shipment_id", ["a", "b", "c"]],
    ]);
    assert.equal(db.calls.upserts.length, 2);
    assert.deepEqual(db.calls.upserts.map((u) => u.rows.map((r) => r.shipment_id)), [["a", "c"], ["b"]]);
    assert.ok(db.calls.upserts.every((u) => u.opts.onConflict === "shipment_id"));
    assert.ok(db.calls.upserts.every((u) => u.rows.every((r) => !("first_seen_at" in r))));
    assert.equal("exported_changed_at" in db.calls.upserts[0].rows[0], false);
    assert.equal(typeof db.calls.upserts[1].rows[0].exported_changed_at, "string");
  });

  it("works in chunks of 500", async () => {
    const db = fakeDb();
    const rows = Array.from({ length: 1201 }, (_, i) => t(`s${i}`));
    const out = await upsertTransactions(db, rows);
    assert.deepEqual(out, { upserted: 1201, failed: 0 });
    assert.deepEqual(db.calls.upserts.map((u) => u.rows.length), [500, 500, 201]);
    assert.ok(db.calls.reads.every((r) => r.keys.length <= 100));
  });

  it("never throws: failures are counted", async () => {
    assert.deepEqual(await upsertTransactions(fakeDb({ failRead: true }), [t("a"), t("b")]), { upserted: 0, failed: 2, error: "read failed" });
    assert.deepEqual(await upsertTransactions(fakeDb({ throwOn: "read" }), [t("a")]), { upserted: 0, failed: 1, error: "network down" });
    assert.deepEqual(await upsertTransactions(fakeDb({ failUpsert: () => true }), [t("a")]), { upserted: 0, failed: 1, error: "upsert failed" });
    assert.deepEqual(await upsertTransactions(null, [t("a")]), { upserted: 0, failed: 1, error: "Cannot read properties of null (reading 'from')" });
    assert.deepEqual(await upsertTransactions(fakeDb(), []), { upserted: 0, failed: 0 });
    assert.deepEqual(await upsertTransactions(fakeDb(), null), { upserted: 0, failed: 0 });
  });
});

describe("upsertApprovals", () => {
  it("splits History rows that meet a stored Recently Approved row", async () => {
    const ra = approvalRow(recent(), RECENT_COLS, { seenAt: SEEN });
    const db = fakeDb({ existing: [Object.fromEntries(APPROVAL_COLUMNS.map((c) => [c, ra[c]]))] });
    const rows = approvalRows([history(), history({ "Tracking Number": "9" })], HISTORY_COLS, { source: "history", seenAt: SEEN }).rows;
    const out = await upsertApprovals(db, rows);
    assert.deepEqual(out, { upserted: 2, failed: 0 });
    assert.equal(db.calls.reads[0].columns, APPROVAL_COLUMNS.join(", "));
    assert.deepEqual(db.calls.upserts.map((u) => u.rows.map((r) => [r.approval_key, r.source, "data" in r])), [
      [["9|INV-100A", "history", true]],
      [["47976058|INV-100A", "recently_approved", false]],
    ]);
    assert.ok(db.calls.upserts.every((u) => u.opts.onConflict === "approval_key"));
  });

  it("counts a failed group and keeps going", async () => {
    const ra = approvalRow(recent(), RECENT_COLS, { seenAt: SEEN });
    const db = fakeDb({
      existing: [Object.fromEntries(APPROVAL_COLUMNS.map((c) => [c, ra[c]]))],
      failUpsert: (rows) => !("data" in rows[0]),
    });
    const rows = approvalRows([history(), history({ "Tracking Number": "9" })], HISTORY_COLS, { source: "history" }).rows;
    assert.deepEqual(await upsertApprovals(db, rows), { upserted: 1, failed: 1, error: "upsert failed" });
  });
});
