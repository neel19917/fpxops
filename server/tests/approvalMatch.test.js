import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_CHECK_SCOPE, findApprovalColumns, approvalColumnNames, normalizeShipmentId,
  classifyApprover, approvalTime, matchApprovals, mergeApproval, summarizeApprovals,
  normalizeApprovalSource, classifyApprovalStatus, filterHistoryRows,
} from "../lib/approvalMatch.js";

// Columns added later, absent from the small exports used below.
const NO_EXTRAS = { status: null, notes: null, uploaded_by: null, variance: null };
const NO_EXTRA_FIELDS = { notes: null, uploaded_by: null, variance: null };

const COLS = ["ShipmentID", "Approved By", "Approved Date", "Approved Amount", "Invoice Number"];
const row = (id, by, at, amount = "100.00", invoice = "INV-1") => ({
  ShipmentID: id, "Approved By": by, "Approved Date": at, "Approved Amount": amount, "Invoice Number": invoice,
});

describe("findApprovalColumns", () => {
  it("names the scope", () => {
    assert.equal(APPROVAL_CHECK_SCOPE, "approval_check");
  });

  it("finds the listed spellings, whatever the case, spacing or punctuation", () => {
    assert.deepEqual(findApprovalColumns(COLS), {
      shipment: "ShipmentID", approved_by: "Approved By", approved_at: "Approved Date",
      amount: "Approved Amount", invoice: "Invoice Number", tracking: null, ...NO_EXTRAS,
    });
    assert.deepEqual(findApprovalColumns(["shipment_id", "APPROVEDBY", "approval  date", "Invoice Amount ($)", "Invoice #"]), {
      shipment: "shipment_id", approved_by: "APPROVEDBY", approved_at: "approval  date",
      amount: "Invoice Amount ($)", invoice: "Invoice #", tracking: null, ...NO_EXTRAS,
    });
    assert.equal(findApprovalColumns(["Shipment #"]).shipment, "Shipment #");
    assert.equal(findApprovalColumns(["Shipment No."]).shipment, "Shipment No.");
  });

  it("prefers candidates in the listed order, not column order", () => {
    const c = findApprovalColumns(["Shipment No", "User", "Modified By", "Approver", "Total", "Amount", "Modified Date", "Date Approved", "Shipment Number"]);
    assert.equal(c.shipment, "Shipment Number");
    assert.equal(c.approved_by, "Approver");
    assert.equal(c.approved_at, "Date Approved");
    assert.equal(c.amount, "Amount");
    assert.equal(findApprovalColumns(["Shipment", "User"]).approved_by, "User");
  });

  it("a listed spelling beats a contains-match", () => {
    const c = findApprovalColumns(["Invoice Approved By User", "Approved By", "ShipmentID"]);
    assert.equal(c.approved_by, "Approved By");
  });

  it("falls back to a contains-match", () => {
    const c = findApprovalColumns(["FP Shipment ID", "Invoice Approved By Name", "Last Approved Date/Time", "Total Approved Amount (USD)", "Carrier Invoice Number"]);
    assert.deepEqual(c, {
      shipment: "FP Shipment ID", approved_by: "Invoice Approved By Name", approved_at: "Last Approved Date/Time",
      amount: "Total Approved Amount (USD)", invoice: "Carrier Invoice Number", tracking: null, ...NO_EXTRAS,
    });
  });

  it("does not mistake other shipment columns for the id", () => {
    assert.equal(findApprovalColumns(["Shipment Status", "Shipment Date", "Shipment Notes", "Carrier"]).shipment, null);
  });

  it("returns null for what is missing, and never throws on odd input", () => {
    assert.deepEqual(findApprovalColumns(["Carrier", "Approved By"]), {
      shipment: null, approved_by: "Approved By", approved_at: null, amount: null, invoice: null, tracking: null, ...NO_EXTRAS,
    });
    for (const bad of [undefined, null, "ShipmentID", {}, [], [null, "", 3]]) {
      assert.equal(findApprovalColumns(bad).shipment, null);
    }
  });

  it("does not change the list it is given", () => {
    const cols = Object.freeze([...COLS]);
    findApprovalColumns(cols);
    assert.deepEqual(cols, COLS);
  });
});

describe("approvalColumnNames", () => {
  it("uses the list sent, or the keys of the rows", () => {
    assert.deepEqual(approvalColumnNames(["A", "B"], [{ C: 1 }]), ["A", "B"]);
    assert.deepEqual(approvalColumnNames(undefined, [{ A: 1 }, { B: 2, A: 3 }, null]), ["A", "B"]);
    assert.deepEqual(approvalColumnNames([], []), []);
  });
});

describe("normalizeShipmentId", () => {
  it("trims, drops leading zeros and a trailing .0", () => {
    const table = [
      [" 13000001 ", "13000001"], [13000001, "13000001"], ["13000001.0", "13000001"], ["13000001.00", "13000001"],
      ["0013000001", "13000001"], ["000", "0"], ["0", "0"], ["ab-12", "AB-12"], ["10.5", "10.5"], ["100", "100"],
      ["", ""], ["   ", ""], [null, ""], [undefined, ""], [{}, ""],
    ];
    for (const [input, want] of table) assert.equal(normalizeShipmentId(input), want, JSON.stringify(input));
  });
});

describe("classifyApprover", () => {
  it("calls automatic approvals EDI", () => {
    const edi = [
      "EDI", "edi", " Edi ", "EDI Import", "EDI-Auto", "System", "SYSTEM USER", "Auto", "Auto Approved", "auto-approve",
      "Automatic", "Automated Approval", "Integration", "API", "api user", "FreightPOP API", "edi@freightpop.com",
      "EDIUser", "ediUser", "edi_user", "system@carrier.com", "noreply@freightpop.com", "no-reply@freightpop.com",
      "svc-audit", "Service Account", "audit-bot",
    ];
    for (const v of edi) {
      const out = classifyApprover(v);
      assert.equal(out.kind, "edi", v);
      assert.equal(out.name, "EDI", v);
      assert.equal(out.raw, v.trim(), v);
    }
  });

  it("does not call a person EDI because the letters appear in the name", () => {
    for (const v of ["Meredith Jones", "Edith", "Eddie", "Paul Autoro", "Megan Rapinoe", "Jobson Lee", "meredith@api.com"]) {
      assert.equal(classifyApprover(v).kind, "person", v);
    }
  });

  it("tidies people's names and keeps the original text", () => {
    const table = [
      ["Shaun", "Shaun"], ["  shaun  ", "Shaun"], ["SHAUN SMITH", "Shaun Smith"], ["shaun   smith", "Shaun Smith"],
      ["Shaun McDonald", "Shaun McDonald"], ["mary-jane o'neil", "Mary-Jane O'neil"],
      ["shaun@freightpop.com", "Shaun"], ["shaun.smith@freightpop.com", "Shaun Smith"],
      ["Shaun_Smith22@Example.com", "Shaun Smith"], ["s.smith+audit@x.io", "S Smith Audit"],
    ];
    for (const [input, want] of table) {
      const out = classifyApprover(input);
      assert.deepEqual(out, { kind: "person", name: want, raw: input.trim() }, input);
    }
  });

  it("is unknown when blank", () => {
    for (const v of ["", "   ", null, undefined]) {
      assert.deepEqual(classifyApprover(v), { kind: "unknown", name: null, raw: null });
    }
  });

  it("shows a known person as listed", () => {
    const people = ["Shaun Smith", "Dana Lee", "Dana Cruz"];
    assert.equal(classifyApprover("shaun", { people }).name, "Shaun Smith");
    assert.equal(classifyApprover("SHAUN SMITH", { people }).name, "Shaun Smith");
    assert.equal(classifyApprover("shaun.smith@x.com", { people }).name, "Shaun Smith");
    assert.equal(classifyApprover("dana", { people }).name, "Dana"); // two Danas: left alone
    assert.equal(classifyApprover("Priya", { people }).name, "Priya");
    assert.equal(classifyApprover("Priya", { people: null }).name, "Priya");
  });
});

describe("approvalTime", () => {
  it("reads ISO text, US text, Excel serials and dates", () => {
    assert.equal(approvalTime("2026-11-03T14:05:00Z"), Date.UTC(2026, 10, 3, 14, 5));
    assert.equal(approvalTime("11/3/2026"), Date.UTC(2026, 10, 3));
    assert.equal(approvalTime("11/03/2026 2:05 PM"), Date.UTC(2026, 10, 3, 14, 5));
    assert.equal(approvalTime("11/03/2026 12:05 AM"), Date.UTC(2026, 10, 3, 0, 5));
    assert.equal(approvalTime("11/03/26 14:05:09"), Date.UTC(2026, 10, 3, 14, 5, 9));
    assert.equal(approvalTime(46329), Date.UTC(2026, 10, 3));
    assert.equal(approvalTime("46329.5"), Date.UTC(2026, 10, 3, 12));
    assert.equal(approvalTime(new Date(Date.UTC(2026, 0, 2))), Date.UTC(2026, 0, 2));
  });

  it("is null for anything that is not a date", () => {
    for (const v of [null, undefined, "", "  ", "soon", 12, NaN, {}, new Date("nope")]) {
      assert.equal(approvalTime(v), null);
    }
  });
});

describe("matchApprovals", () => {
  const audit = [
    { id: "r1", shipment_id: "13000001", raw: { rank: 1 } },
    { id: "r2", shipment_id: "13000002", raw: { rank: 2 } },
    { id: "r3", shipment_id: "13000003", raw: { rank: 3 } },
    { id: "r4", shipment_id: "13000004", raw: { rank: 4 } },
    { id: "r5", shipment_id: "13000005", raw: { rank: 5 } },
  ];

  it("says who approved each shipment, and which were not found", () => {
    const approved = [
      row("13000001", "EDI", "11/01/2026 9:00 AM", "$1,250.50", "INV-A"),
      row("13000002", "shaun.smith@freightpop.com", "11/02/2026", "88", "INV-B"),
      row("13000003", "", "11/02/2026", "", ""),
      row("99999999", "Shaun", "11/02/2026"),
    ];
    const { columns_used, results, summary } = matchApprovals(audit, approved, COLS);
    assert.equal(columns_used.shipment, "ShipmentID");
    assert.equal(results.length, audit.length);
    assert.deepEqual(results[0], {
      shipment_id: "13000001", status: "approved", approved_by: "EDI", approved_by_kind: "edi", approved_by_raw: "EDI",
      approved_at: "11/01/2026 9:00 AM", amount: 1250.5, invoice: "INV-A", matches: 1,
      source: "recently_approved", ...NO_EXTRA_FIELDS,
    });
    assert.deepEqual(results[1], {
      shipment_id: "13000002", status: "approved", approved_by: "Shaun Smith", approved_by_kind: "person",
      approved_by_raw: "shaun.smith@freightpop.com", approved_at: "11/02/2026", amount: 88, invoice: "INV-B", matches: 1,
      source: "recently_approved", ...NO_EXTRA_FIELDS,
    });
    assert.deepEqual(results[2], {
      shipment_id: "13000003", status: "approved", approved_by: null, approved_by_kind: "unknown",
      approved_by_raw: null, approved_at: "11/02/2026", amount: null, invoice: null, matches: 1,
      source: "recently_approved", ...NO_EXTRA_FIELDS,
    });
    assert.deepEqual(results[3], { shipment_id: "13000004", status: "not_found", matches: 0 });
    assert.deepEqual(summary, {
      approved_rows: 4, matched: 3, not_found: 2, by_edi: 1, by_unknown: 1, by_person: { "Shaun Smith": 1 },
    });
  });

  it("matches ids despite leading zeros, a trailing .0, spaces and numbers", () => {
    const approved = [
      row("0013000001", "Shaun", "11/01/2026"),
      row("13000002.0", "Shaun", "11/01/2026"),
      row(13000003, "Shaun", "11/01/2026"),
      row(" 13000004 ", "Shaun", "11/01/2026"),
      row("130000050", "Shaun", "11/01/2026"), // a different shipment
    ];
    const { results, summary } = matchApprovals(audit, approved, COLS);
    assert.deepEqual(results.map((r) => r.status), ["approved", "approved", "approved", "approved", "not_found"]);
    assert.equal(summary.matched, 4);
    assert.deepEqual(summary.by_person, { Shaun: 4 });
  });

  it("takes the latest approval when a shipment appears several times", () => {
    const approved = [
      row("13000001", "Dana", "11/05/2026 8:00 AM", "10", "INV-2"),
      row("13000001", "EDI", "11/01/2026 8:00 AM", "5", "INV-1"),
      row("13000001", "Priya", "", "7", "INV-0"), // no date: never beats a dated row
    ];
    const { results, summary } = matchApprovals(audit, approved, COLS);
    assert.equal(results[0].approved_by, "Dana");
    assert.equal(results[0].invoice, "INV-2");
    assert.equal(results[0].matches, 3);
    assert.equal(summary.matched, 1);
    assert.deepEqual(summary.by_person, { Dana: 1 });
    assert.equal(summary.by_edi, 0);
  });

  it("falls back to the last row when no date can be read, or on a tie", () => {
    const noDates = [row("13000001", "Dana", "", "1", "A"), row("13000001", "Priya", "n/a", "2", "B")];
    assert.equal(matchApprovals(audit, noDates, COLS).results[0].approved_by, "Priya");
    const tie = [row("13000001", "Dana", "11/05/2026"), row("13000001", "Priya", "11/05/2026")];
    assert.equal(matchApprovals(audit, tie, COLS).results[0].approved_by, "Priya");
    const noDateColumn = [{ ShipmentID: "13000001", User: "Dana" }, { ShipmentID: "13000001", User: "Priya" }];
    const out = matchApprovals(audit, noDateColumn, ["ShipmentID", "User"]);
    assert.equal(out.results[0].approved_by, "Priya");
    assert.equal(out.results[0].approved_at, null);
    assert.equal(out.results[0].matches, 2);
  });

  it("counts people, most approvals first", () => {
    const approved = [
      row("13000001", "dana", "11/01/2026"),
      row("13000002", "Shaun", "11/01/2026"),
      row("13000003", "SHAUN", "11/01/2026"),
      row("13000004", "shaun@freightpop.com", "11/01/2026"),
      row("13000005", "system", "11/01/2026"),
    ];
    const { summary } = matchApprovals(audit, approved, COLS);
    assert.deepEqual(Object.entries(summary.by_person), [["Shaun", 3], ["Dana", 1]]);
    assert.equal(summary.by_edi, 1);
    assert.equal(summary.by_unknown, 0);
    assert.equal(summary.not_found, 0);
  });

  it("writes Excel serial dates as plain dates", () => {
    const { results } = matchApprovals(audit, [row("13000001", "Dana", 46329), row("13000002", "Dana", 46329.5)], COLS);
    assert.equal(results[0].approved_at, "2026-11-03");
    assert.equal(results[1].approved_at, "2026-11-03 12:00");
  });

  it("reads rows sent as lists, and finds the columns from the rows when none are sent", () => {
    const lists = matchApprovals(audit, [["13000001", "Dana", "11/01/2026", "5", "INV-9"]], COLS);
    assert.equal(lists.results[0].approved_by, "Dana");
    assert.equal(lists.results[0].invoice, "INV-9");
    const noColumns = matchApprovals(audit, [row("13000002", "Dana", "11/01/2026")]);
    assert.equal(noColumns.columns_used.shipment, "ShipmentID");
    assert.equal(noColumns.results[1].status, "approved");
  });

  it("matches nothing without a shipment column", () => {
    const out = matchApprovals(audit, [{ Carrier: "X", "Approved By": "Dana" }], ["Carrier", "Approved By"]);
    assert.equal(out.columns_used.shipment, null);
    assert.equal(out.summary.matched, 0);
    assert.equal(out.summary.not_found, 5);
    assert.ok(out.results.every((r) => r.status === "not_found"));
  });

  it("copes with empty and odd input", () => {
    assert.deepEqual(matchApprovals([], [], COLS).summary, {
      approved_rows: 0, matched: 0, not_found: 0, by_edi: 0, by_unknown: 0, by_person: {},
    });
    assert.deepEqual(matchApprovals(null, null, null).results, []);
    const out = matchApprovals([{ shipment_id: null }, { shipment_id: "" }], [row("", "Dana", ""), null, "x"], COLS);
    assert.deepEqual(out.results.map((r) => r.status), ["not_found", "not_found"]);
    assert.equal(out.summary.approved_rows, 3);
  });

  it("does not change its inputs", () => {
    const a = JSON.parse(JSON.stringify(audit));
    const approved = [row("13000001", "Dana", "11/05/2026"), row("13000001", "EDI", "11/01/2026")];
    const b = JSON.parse(JSON.stringify(approved));
    const cols = [...COLS];
    matchApprovals(audit, approved, cols);
    assert.deepEqual(audit, a);
    assert.deepEqual(approved, b);
    assert.deepEqual(cols, COLS);
  });
});

describe("mergeApproval", () => {
  const stamp = { checked_at: "2026-11-13T10:00:00.000Z", checked_by: "fpx-browser" };
  const approvedResult = {
    shipment_id: "13000001", status: "approved", approved_by: "Shaun", approved_by_kind: "person", approved_by_raw: "shaun",
    approved_at: "11/05/2026", amount: 10, invoice: "INV-2", matches: 1,
  };
  const notFound = { shipment_id: "13000001", status: "not_found", matches: 0 };

  it("stores an approval and keeps every other key of raw", () => {
    const raw = { rank: 3, charge: 120, get_invoice: { status: "done" } };
    const before = JSON.parse(JSON.stringify(raw));
    const next = mergeApproval(raw, approvedResult, stamp);
    assert.deepEqual(next, {
      rank: 3, charge: 120, get_invoice: { status: "done" },
      approval: {
        status: "approved", approved_by: "Shaun", approved_by_kind: "person", approved_by_raw: "shaun",
        approved_at: "11/05/2026", amount: 10, invoice: "INV-2", matches: 1, source: "recently_approved",
        checked_at: stamp.checked_at, checked_by: "fpx-browser",
      },
    });
    assert.deepEqual(raw, before);
  });

  it("marks not_found on the last part or a single call", () => {
    assert.deepEqual(mergeApproval({ rank: 1 }, notFound, stamp), {
      rank: 1, approval: { status: "not_found", checked_at: stamp.checked_at, checked_by: "fpx-browser" },
    });
    assert.deepEqual(mergeApproval({ rank: 1 }, notFound, { ...stamp, final: true }).approval.status, "not_found");
    assert.deepEqual(mergeApproval(null, notFound, stamp), {
      approval: { status: "not_found", checked_at: stamp.checked_at, checked_by: "fpx-browser" },
    });
  });

  it("leaves a row alone when a part that is not the last does not have it", () => {
    assert.equal(mergeApproval({ rank: 1 }, notFound, { ...stamp, final: false }), null);
    assert.equal(mergeApproval({ rank: 1, approval: { status: "not_found" } }, notFound, { ...stamp, final: false }), null);
  });

  it("never downgrades an approval from an earlier part", () => {
    const part1 = mergeApproval({ rank: 1 }, approvedResult, { ...stamp, final: false });
    assert.equal(mergeApproval(part1, notFound, { ...stamp, final: false }), null);
    assert.equal(mergeApproval(part1, notFound, { ...stamp, final: true }), null);
  });

  it("accumulates over parts: approved in any part ends approved, the rest not_found", () => {
    const rows = [{ shipment_id: "1", raw: { rank: 1 } }, { shipment_id: "2", raw: { rank: 2 } }, { shipment_id: "3", raw: { rank: 3 } }];
    const parts = [[row("1", "Shaun", "11/01/2026")], [row("2", "EDI", "11/02/2026")]];
    let state = rows;
    parts.forEach((part, p) => {
      const { results } = matchApprovals(state, part, COLS);
      state = state.map((r, i) => {
        const next = mergeApproval(r.raw, results[i], { ...stamp, final: p === parts.length - 1 });
        return next ? { ...r, raw: next } : r;
      });
    });
    assert.deepEqual(state.map((r) => r.raw.approval.status), ["approved", "approved", "not_found"]);
    assert.deepEqual(state.map((r) => r.raw.rank), [1, 2, 3]);
    assert.deepEqual(summarizeApprovals(state), {
      checked_at: stamp.checked_at, matched: 2, not_found: 1, by_edi: 1, by_unknown: 0, by_person: { Shaun: 1 },
      by_source: { recently_approved: 2, history: 0 },
    });
  });

  it("keeps the later of two approvals", () => {
    const had = mergeApproval({}, approvedResult, { checked_at: "2026-11-10T00:00:00.000Z", checked_by: "a" });
    const older = { ...approvedResult, approved_by: "Dana", approved_at: "11/01/2026" };
    const kept = mergeApproval(had, older, stamp);
    assert.equal(kept.approval.approved_by, "Shaun");
    assert.equal(kept.approval.checked_at, stamp.checked_at); // still refreshed
    const newer = { ...approvedResult, approved_by: "Dana", approved_at: "11/09/2026" };
    assert.equal(mergeApproval(had, newer, stamp).approval.approved_by, "Dana");
    const undated = { ...approvedResult, approved_by: "Dana", approved_at: null };
    assert.equal(mergeApproval(had, undated, stamp).approval.approved_by, "Shaun");
  });

  it("replaces a not_found with an approval", () => {
    const next = mergeApproval({ approval: { status: "not_found", checked_at: "x", checked_by: "y" } }, approvedResult, stamp);
    assert.equal(next.approval.status, "approved");
    assert.equal(next.approval.checked_at, stamp.checked_at);
  });
});

describe("summarizeApprovals", () => {
  it("is null when no row was ever checked", () => {
    assert.equal(summarizeApprovals([]), null);
    assert.equal(summarizeApprovals(null), null);
    assert.equal(summarizeApprovals([{ raw: { rank: 1 } }, { raw: null }, {}, { raw: { approval: [] } }]), null);
  });

  it("counts the rows and takes the latest check time", () => {
    const rows = [
      { raw: { approval: { status: "approved", approved_by_kind: "edi", approved_by: "EDI", checked_at: "2026-11-12T00:00:00.000Z" } } },
      { raw: { approval: { status: "approved", approved_by_kind: "person", approved_by: "Dana", checked_at: "2026-11-13T00:00:00.000Z" } } },
      { raw: { approval: { status: "approved", approved_by_kind: "person", approved_by: "Shaun", checked_at: "2026-11-13T00:00:00.000Z" } } },
      { raw: { approval: { status: "approved", approved_by_kind: "person", approved_by: "Shaun" } } },
      { raw: { approval: { status: "approved", approved_by_kind: "unknown", approved_by: null } } },
      { raw: { approval: { status: "not_found", checked_at: "2026-11-11T00:00:00.000Z" } } },
      { raw: { rank: 9 } },
    ];
    const out = summarizeApprovals(rows);
    assert.deepEqual(out, {
      checked_at: "2026-11-13T00:00:00.000Z", matched: 5, not_found: 1, by_edi: 1, by_unknown: 1,
      by_person: { Shaun: 2, Dana: 1 },
      by_source: { recently_approved: 5, history: 0 },
    });
    assert.deepEqual(Object.entries(out.by_person), [["Shaun", 2], ["Dana", 1]]);
  });
});

it("matches by tracking number when the export has no shipment column", async () => {
  const { matchApprovals } = await import("../lib/approvalMatch.js");
  const columns = ["Carrier", "Approved Date", "Invoice Number", "Tracking Number", "Invoice Amount", "Approved By"];
  const audit = [
    { shipment_id: "13413021", raw: { tracking: "047976058" } },
    { shipment_id: "13413022", raw: { tracking: "PRO-9" } },
    { shipment_id: "13413023", raw: {} },
  ];
  const approved = [
    { Carrier: "ABF", "Approved Date": "11/12/2026", "Invoice Number": "INV1", "Tracking Number": "47976058", "Invoice Amount": "449.39", "Approved By": "EDI" },
    { Carrier: "XPO", "Approved Date": "11/13/2026", "Invoice Number": "INV2", "Tracking Number": "pro-9", "Invoice Amount": "100", "Approved By": "shaun.smith@x.com" },
  ];
  const { results, summary, columns_used } = matchApprovals(audit, approved, columns);
  assert.equal(columns_used.shipment, null);
  assert.equal(columns_used.tracking, "Tracking Number");
  assert.deepEqual(results.map((r) => r.status), ["approved", "approved", "not_found"]);
  assert.equal(results[0].approved_by_kind, "edi");
  assert.equal(results[1].approved_by, "Shaun Smith");
  assert.equal(summary.matched, 2);
});

// The real "Recently Approved" export.
const REAL_COLS = [
  "Carrier", "Carrier SCAC", "Date Uploaded", "Approved Date", "Invoice Date", "Shipment Date", "Invoice Number",
  "Tracking Number", "Invoice Amount", "Quote Amount", "Variance", "BOL Number", "SO Number", "PO Number", "Payee",
  "Ship From Company Name", "Ship To Company Name", "Due Date", "Approved By", "Uploaded By", "Notes", "GL Code",
  "Loc Id", "Number of Invoices for Tracking Number", "Customer Audit", "Shipment Status", "Shipment Processed By",
];

describe("status, notes and the other added columns", () => {
  it("reads the real Recently Approved export", () => {
    for (const source of [undefined, "recently_approved", "history"]) {
      assert.deepEqual(findApprovalColumns(REAL_COLS, { source }), {
        shipment: null, approved_by: "Approved By", approved_at: "Approved Date", amount: "Invoice Amount",
        invoice: "Invoice Number", tracking: "Tracking Number", status: null,
        notes: "Notes", uploaded_by: "Uploaded By", variance: "Variance",
      });
    }
  });

  it("finds a status column, and never takes Shipment Status for one", () => {
    for (const name of ["Status", "Invoice Status", "Audit Status", "Approval Status", "Action", "Decision", "invoice_status"]) {
      assert.equal(findApprovalColumns(["Tracking Number", "Shipment Status", name]).status, name);
    }
    assert.equal(findApprovalColumns(["Shipment Status", "Audit Status", "Status"]).status, "Status");
    assert.equal(findApprovalColumns(["Tracking Number", "Shipment Status"]).status, null);
    assert.equal(findApprovalColumns(["Shipment Status", "Delivery Status", "Tracking Status", "Payment Status"]).status, null);
    // contains-match
    assert.equal(findApprovalColumns(["Shipment Status", "Current Invoice Status Name"]).status, "Current Invoice Status Name");
    assert.equal(findApprovalColumns(["Shipment Status", "Record Status"]).status, "Record Status");
    assert.equal(findApprovalColumns(["Record Status", "FP Audit Status Text"]).status, "FP Audit Status Text");
  });

  it("finds notes, uploaded by and variance", () => {
    for (const name of ["Notes", "Note", "Comments", "Comment", "Audit Notes", "Approval Notes", "Remarks", "Invoice Notes", "Reviewer Comment Text"]) {
      assert.equal(findApprovalColumns(["Tracking Number", name]).notes, name);
    }
    assert.equal(findApprovalColumns(["Internal Notes", "Notes"]).notes, "Notes");
    const c = findApprovalColumns(["Uploaded By", "Variance", "Approved By"]);
    assert.equal(c.uploaded_by, "Uploaded By");
    assert.equal(c.variance, "Variance");
    assert.equal(c.approved_by, "Approved By");
  });

  it("accepts more approver names for History only, after the usual ones", () => {
    for (const name of ["Action By", "Processed By", "Shipment Processed By"]) {
      assert.equal(findApprovalColumns(["Tracking Number", name]).approved_by, null);
      assert.equal(findApprovalColumns(["Tracking Number", name], { source: "history" }).approved_by, name);
    }
    const h = (cols) => findApprovalColumns(cols, { source: "history" }).approved_by;
    assert.equal(h(["Shipment Processed By", "Processed By", "Action By"]), "Action By");
    assert.equal(h(["Action By", "Approved By"]), "Approved By");
    assert.equal(h(["Action By", "Modified By"]), "Modified By");
    assert.equal(h(["Action By", "Invoice Approved By Name"]), "Invoice Approved By Name");
    assert.equal(h(["Uploaded By"]), null);
  });

  it("carries notes, uploaded by and variance on an approved result", () => {
    const audit = [{ shipment_id: "1", raw: { tracking: "PRO1" } }, { shipment_id: "2", raw: { tracking: "PRO2" } }];
    const long = "n".repeat(1500);
    const rows = [
      { "Tracking Number": "PRO1", "Approved By": "EDI", Notes: "  short paid, see email  ", "Uploaded By": " dana ", Variance: "(12.50)" },
      { "Tracking Number": "PRO2", "Approved By": "EDI", Notes: long, "Uploaded By": "", Variance: "n/a" },
    ];
    const out = matchApprovals(audit, rows, REAL_COLS);
    assert.equal(out.results[0].notes, "short paid, see email");
    assert.equal(out.results[0].uploaded_by, "dana");
    assert.equal(out.results[0].variance, -12.5);
    assert.equal(out.results[1].notes.length, 1000);
    assert.equal(out.results[1].uploaded_by, null);
    assert.equal(out.results[1].variance, null);
    const blank = matchApprovals(audit, [{ "Tracking Number": "PRO1", Notes: "   " }], REAL_COLS).results[0];
    assert.equal(blank.notes, null);
    const stored = mergeApproval({}, out.results[0], { checked_at: "t", checked_by: "b" }).approval;
    assert.equal(stored.notes, "short paid, see email");
    assert.equal(stored.uploaded_by, "dana");
    assert.equal(stored.variance, -12.5);
  });
});

describe("normalizeApprovalSource", () => {
  it("reads the source of a post", () => {
    for (const v of [undefined, null, "", "recently_approved", "recently-approved", "Recently Approved"]) {
      assert.equal(normalizeApprovalSource(v), "recently_approved");
    }
    for (const v of ["history", "History", "audit-history"]) assert.equal(normalizeApprovalSource(v), "history");
    for (const v of ["other", 3, {}, []]) assert.equal(normalizeApprovalSource(v), null);
  });
});

describe("History export: which rows are approvals", () => {
  const STATUS_TABLE = [
    ["Approved", true], ["approved", true], [" APPROVED ", true], ["Approve", true], ["Auto Approved", true],
    ["Auto-Approved", true], ["AutoApproved", true], ["Paid", true], ["Accepted", true], ["Approved - EDI", true],
    ["Not Approved", false], ["Not-Approved", false], ["Unapproved", false], ["Rejected", false], ["Pending", false],
    ["Pending Approval", false], ["Disputed", false], ["Void", false], ["Voided", false], ["Deleted", false],
    ["Unpaid", false], ["", false], [null, false], [undefined, false], ["   ", false],
  ];

  it("classifies a status cell", () => {
    for (const [value, yes] of STATUS_TABLE) {
      assert.equal(classifyApprovalStatus(value), yes ? "approved" : "not_approved", JSON.stringify(value));
    }
    assert.equal(classifyApprovalStatus("Delivered"), "other");
    assert.equal(classifyApprovalStatus("In Transit"), "other");
  });

  it("keeps only approved rows when there is a status column", () => {
    const cols = ["Tracking Number", "Status", "Approved Date", "Approved By"];
    const rows = STATUS_TABLE.map(([value], i) => ({ "Tracking Number": `P${i}`, Status: value, "Approved Date": "11/01/2026", "Approved By": "Dana" }));
    const before = JSON.parse(JSON.stringify(rows));
    const out = filterHistoryRows(rows, cols);
    const want = STATUS_TABLE.filter(([, yes]) => yes).length;
    assert.equal(out.status_used, true);
    assert.equal(out.rows.length, want);
    assert.deepEqual(out.dropped, { not_approved: STATUS_TABLE.length - want, no_approval_info: 0 });
    assert.ok(out.rows.every((r) => classifyApprovalStatus(r.Status) === "approved"));
    assert.ok(out.rows.every((r) => rows.includes(r)));
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), before);
  });

  it("without a status column keeps rows with an approved date or an approver", () => {
    const cols = ["Tracking Number", "Approved Date", "Approved By"];
    const rows = [
      { "Tracking Number": "A", "Approved Date": "11/01/2026", "Approved By": "" },
      { "Tracking Number": "B", "Approved Date": "", "Approved By": "EDI" },
      { "Tracking Number": "C", "Approved Date": "", "Approved By": "  " },
      { "Tracking Number": "D" },
    ];
    const out = filterHistoryRows(rows, cols);
    assert.equal(out.status_used, false);
    assert.deepEqual(out.rows.map((r) => r["Tracking Number"]), ["A", "B"]);
    assert.deepEqual(out.dropped, { not_approved: 0, no_approval_info: 2 });
  });

  it("does not take a column every invoice has (Action By, Modified Date) as proof of approval", () => {
    const cols = ["Tracking Number", "Action By", "Modified Date"];
    const rows = [{ "Tracking Number": "A", "Action By": "Dana", "Modified Date": "11/01/2026" }];
    const out = filterHistoryRows(rows, cols);
    assert.deepEqual(out.rows, []);
    assert.deepEqual(out.dropped, { not_approved: 0, no_approval_info: 1 });
    // …but with a status column that says Approved, Action By is the approver.
    const audit = [{ shipment_id: "1", raw: { tracking: "A" } }];
    const m = matchApprovals(audit, [{ ...rows[0], Status: "Approved" }], [...cols, "Status"], { source: "history" });
    assert.equal(m.results[0].status, "approved");
    assert.equal(m.results[0].approved_by, "Dana");
  });

  it("does not use a status column that is not about approval", () => {
    const cols = ["Tracking Number", "Status", "Approved Date"];
    const rows = [
      { "Tracking Number": "A", Status: "Delivered", "Approved Date": "11/01/2026" },
      { "Tracking Number": "B", Status: "In Transit", "Approved Date": "" },
    ];
    const out = filterHistoryRows(rows, cols);
    assert.equal(out.status_used, false);
    assert.deepEqual(out.rows.map((r) => r["Tracking Number"]), ["A"]);
    assert.deepEqual(out.dropped, { not_approved: 0, no_approval_info: 1 });
    const m = matchApprovals([{ shipment_id: "1", raw: { tracking: "A" } }], rows, cols, { source: "history" });
    assert.equal(m.columns_used.status, null);
    assert.equal(m.results[0].status, "approved");
  });

  it("reads rows sent as lists and copes with odd input", () => {
    const cols = ["Tracking Number", "Status"];
    const out = filterHistoryRows([["A", "Approved"], ["B", "Rejected"], null, "x"], cols);
    assert.deepEqual(out.rows, [["A", "Approved"]]);
    assert.deepEqual(out.dropped, { not_approved: 3, no_approval_info: 0 });
    assert.deepEqual(filterHistoryRows(null, null), { rows: [], dropped: { not_approved: 0, no_approval_info: 0 }, status_used: false });
  });
});

describe("matchApprovals with a History export", () => {
  const H_COLS = ["Carrier", "Invoice Number", "Tracking Number", "Invoice Amount", "Status", "Approved Date", "Action By", "Notes"];
  const h = (tracking, status, by, at, extra = {}) => ({
    Carrier: "ABF", "Invoice Number": `INV-${tracking}`, "Tracking Number": tracking, "Invoice Amount": "50.00",
    Status: status, "Approved Date": at, "Action By": by, Notes: "", ...extra,
  });
  const audit = [
    { id: "r1", shipment_id: "1", raw: { tracking: "PRO1" } },
    { id: "r2", shipment_id: "2", raw: { tracking: "PRO2" } },
    { id: "r3", shipment_id: "3", raw: { tracking: "PRO3" } },
    { id: "r4", shipment_id: "4", raw: { tracking: "PRO4" } },
  ];

  it("matches only approved rows, stamps the source and says what was dropped", () => {
    const rows = [
      h("PRO1", "Approved", "dana", "10/01/2026", { Notes: "ok per Sam" }),
      h("PRO2", "Rejected", "dana", "10/02/2026"),
      h("PRO3", "Pending", "", ""),
      h("PRO4", "Approved", "EDI", "10/03/2026"),
      h("PRO4", "Not Approved", "dana", "10/09/2026"), // later, but not an approval
      h("PRO9", "Approved", "dana", "10/03/2026"),
    ];
    const before = JSON.parse(JSON.stringify(rows));
    const out = matchApprovals(audit, rows, H_COLS, { source: "history" });
    assert.equal(out.columns_used.status, "Status");
    assert.equal(out.columns_used.approved_by, "Action By");
    assert.equal(out.columns_used.notes, "Notes");
    assert.deepEqual(out.dropped, { not_approved: 3, no_approval_info: 0 });
    assert.deepEqual(out.results.map((r) => r.status), ["approved", "not_found", "not_found", "approved"]);
    assert.equal(out.results[0].source, "history");
    assert.equal(out.results[0].approved_by, "Dana");
    assert.equal(out.results[0].notes, "ok per Sam");
    assert.equal(out.results[3].approved_by_kind, "edi");
    assert.equal(out.results[3].matches, 1);
    assert.equal(out.results[1].source, undefined);
    assert.equal(out.summary.approved_rows, 6);
    assert.equal(out.summary.matched, 2);
    assert.deepEqual(rows, before);
  });

  it("stamps recently_approved by default, and filters nothing for that source", () => {
    const rows = [h("PRO1", "Rejected", "dana", "10/01/2026")];
    const out = matchApprovals(audit, rows, H_COLS);
    assert.equal(out.results[0].status, "approved");
    assert.equal(out.results[0].source, "recently_approved");
    assert.deepEqual(out.dropped, { not_approved: 0, no_approval_info: 0 });
    assert.equal(matchApprovals(audit, rows, H_COLS, { source: "recently_approved" }).results[0].source, "recently_approved");
  });

  it("takes the latest of two approved History rows for one shipment", () => {
    const rows = [h("PRO1", "Approved", "dana", "10/05/2026"), h("PRO1", "Approved", "priya", "10/01/2026")];
    const out = matchApprovals(audit, rows, H_COLS, { source: "history" });
    assert.equal(out.results[0].approved_by, "Dana");
    assert.equal(out.results[0].matches, 2);
  });
});

describe("mergeApproval with a History result", () => {
  const stamp = { checked_at: "2026-11-13T12:00:00.000Z", checked_by: "fpx-browser" };
  const earlier = { checked_at: "2026-11-13T10:00:00.000Z", checked_by: "fpx-browser" };
  const recent = {
    shipment_id: "1", status: "approved", source: "recently_approved", approved_by: "Shaun", approved_by_kind: "person",
    approved_by_raw: "shaun", approved_at: "11/05/2026", amount: 10, invoice: "INV-2", notes: "from RA", uploaded_by: "edi",
    variance: 0, matches: 1,
  };
  const history = {
    shipment_id: "1", status: "approved", source: "history", approved_by: "Dana", approved_by_kind: "person",
    approved_by_raw: "dana", approved_at: "11/09/2026", amount: 55, invoice: "INV-H", notes: "from history",
    uploaded_by: "dana", variance: 4.5, matches: 2,
  };
  const notFound = { shipment_id: "1", status: "not_found", matches: 0 };

  it("upgrades a row with no approval, or not_found, to approved", () => {
    const raw = { rank: 2, approval: { status: "not_found", checked_at: "x", checked_by: "y" } };
    const before = JSON.parse(JSON.stringify(raw));
    const next = mergeApproval(raw, history, stamp);
    const { shipment_id: _id, ...fields } = history;
    assert.deepEqual(next, { rank: 2, approval: { ...fields, ...stamp } });
    assert.deepEqual(raw, before);
    assert.equal(mergeApproval({ rank: 2 }, history, stamp).approval.source, "history");
    assert.equal(mergeApproval(null, history, stamp).approval.status, "approved");
    // the source can also come from the options
    const { source: _s, ...unstamped } = history;
    assert.equal(mergeApproval({}, unstamped, { ...stamp, source: "history" }).approval.source, "history");
  });

  it("never writes not_found and never downgrades", () => {
    for (const final of [true, false]) {
      assert.equal(mergeApproval({ rank: 1 }, notFound, { ...stamp, final, source: "history" }), null);
      assert.equal(mergeApproval({ approval: { status: "not_found" } }, notFound, { ...stamp, final, source: "history" }), null);
      assert.equal(mergeApproval(mergeApproval({}, recent, earlier), notFound, { ...stamp, final, source: "history" }), null);
      assert.equal(mergeApproval(mergeApproval({}, history, earlier), notFound, { ...stamp, final, source: "history" }), null);
    }
  });

  it("does not overwrite what Recently Approved gave", () => {
    const had = mergeApproval({ rank: 1 }, recent, earlier);
    const before = JSON.parse(JSON.stringify(had));
    assert.equal(mergeApproval(had, history, stamp), null); // nothing blank: row left as it is
    assert.deepEqual(had, before);
    // an approval stored before `source` existed counts as Recently Approved
    const { source: _s, ...legacy } = had.approval;
    assert.equal(mergeApproval({ approval: legacy }, history, stamp), null);
  });

  it("fills only the blank fields of a Recently Approved approval", () => {
    const thin = { ...recent, approved_by: null, approved_by_kind: "unknown", approved_by_raw: null, amount: null, notes: null, variance: null };
    const had = mergeApproval({ rank: 1 }, thin, earlier);
    const next = mergeApproval(had, history, stamp);
    assert.deepEqual(next.approval, {
      status: "approved", source: "recently_approved",
      approved_by: "Dana", approved_by_kind: "person", approved_by_raw: "dana", // was blank
      approved_at: "11/05/2026", invoice: "INV-2", uploaded_by: "edi", matches: 1, // kept
      amount: 55, notes: "from history", variance: 4.5, // were blank
      ...stamp,
    });
    assert.equal(next.rank, 1);
    // an approver is kept whole: a name is not paired with History's kind
    const noDate = mergeApproval({}, { ...recent, approved_at: null }, earlier);
    const filled = mergeApproval(noDate, history, stamp).approval;
    assert.equal(filled.approved_at, "11/09/2026");
    assert.equal(filled.approved_by, "Shaun");
    assert.equal(filled.notes, "from RA");
    assert.equal(filled.variance, 0); // 0 is a value, not a blank
    // an EDI approval is an approver too
    const edi = mergeApproval({}, { ...recent, approved_by: "EDI", approved_by_kind: "edi", approved_by_raw: null }, earlier);
    assert.equal(mergeApproval(edi, history, stamp), null);
  });

  it("keeps the later of two History approvals", () => {
    const had = mergeApproval({}, history, earlier);
    const older = { ...history, approved_by: "Priya", approved_at: "11/01/2026" };
    assert.equal(mergeApproval(had, older, stamp).approval.approved_by, "Dana");
    const newer = { ...history, approved_by: "Priya", approved_at: "11/12/2026" };
    const next = mergeApproval(had, newer, stamp).approval;
    assert.equal(next.approved_by, "Priya");
    assert.equal(next.source, "history");
  });

  it("lets a later Recently Approved result replace a History approval, keeping what it lacks", () => {
    const had = mergeApproval({}, history, earlier);
    const next = mergeApproval(had, { ...recent, notes: null }, stamp).approval;
    assert.equal(next.source, "recently_approved");
    assert.equal(next.approved_by, "Shaun");
    assert.equal(next.approved_at, "11/05/2026");
    assert.equal(next.notes, "from history");
    // and a Recently Approved run that no longer lists it leaves it approved
    assert.equal(mergeApproval(had, notFound, { ...stamp, final: true }), null);
  });

  it("runs end to end: Recently Approved, then History", () => {
    const RA = ["Tracking Number", "Approved By", "Approved Date", "Invoice Amount", "Notes"];
    const H = ["Tracking Number", "Status", "Approved By", "Approved Date", "Invoice Amount", "Notes"];
    let state = ["P1", "P2", "P3", "P4"].map((t, i) => ({ id: `r${i}`, shipment_id: String(i), raw: { tracking: t } }));
    const apply = (rows, cols, source, at) => {
      const { results } = matchApprovals(state, rows, cols, { source });
      let newly = 0;
      state = state.map((r, i) => {
        const next = mergeApproval(r.raw, results[i], { checked_at: at, checked_by: "b", source });
        if (!next) return r;
        if (r.raw.approval?.status !== "approved" && next.approval.status === "approved") newly += 1;
        return { ...r, raw: next };
      });
      return newly;
    };
    assert.equal(apply([{ "Tracking Number": "P1", "Approved By": "Shaun", "Approved Date": "11/10/2026", "Invoice Amount": "10", Notes: "" }], RA, "recently_approved", "t1"), 1);
    assert.deepEqual(state.map((r) => r.raw.approval.status), ["approved", "not_found", "not_found", "not_found"]);
    const newly = apply([
      { "Tracking Number": "P1", Status: "Approved", "Approved By": "Dana", "Approved Date": "11/11/2026", "Invoice Amount": "99", Notes: "older note" },
      { "Tracking Number": "P2", Status: "Approved", "Approved By": "EDI", "Approved Date": "10/01/2026", "Invoice Amount": "20", Notes: "" },
      { "Tracking Number": "P3", Status: "Rejected", "Approved By": "", "Approved Date": "", "Invoice Amount": "30", Notes: "" },
    ], H, "history", "t2");
    assert.equal(newly, 1);
    assert.deepEqual(state.map((r) => r.raw.approval.status), ["approved", "approved", "not_found", "not_found"]);
    assert.deepEqual(state.map((r) => r.raw.approval.source), ["recently_approved", "history", undefined, undefined]);
    assert.equal(state[0].raw.approval.approved_by, "Shaun");
    assert.equal(state[0].raw.approval.amount, 10);
    assert.equal(state[0].raw.approval.notes, "older note"); // was blank
    assert.deepEqual(summarizeApprovals(state), {
      checked_at: "t2", matched: 2, not_found: 2, by_edi: 1, by_unknown: 0, by_person: { Shaun: 1 },
      by_source: { recently_approved: 1, history: 1 },
    });
  });
});

describe("summarizeApprovals by source", () => {
  it("splits matched by where the approval came from", () => {
    const a = (extra) => ({ raw: { approval: { status: "approved", approved_by_kind: "edi", ...extra } } });
    const out = summarizeApprovals([
      a({ source: "history" }), a({ source: "history" }), a({ source: "recently_approved" }), a({}), a({ source: "odd" }),
      { raw: { approval: { status: "not_found", source: "history" } } },
    ]);
    assert.deepEqual(out.by_source, { recently_approved: 3, history: 2 });
    assert.equal(out.matched, 5);
    assert.equal(out.not_found, 1);
  });
});
