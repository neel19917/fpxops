import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_CHECK_SCOPE, findApprovalColumns, approvalColumnNames, normalizeShipmentId,
  classifyApprover, approvalTime, matchApprovals, mergeApproval, summarizeApprovals,
} from "../lib/approvalMatch.js";

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
      amount: "Approved Amount", invoice: "Invoice Number", tracking: null,
    });
    assert.deepEqual(findApprovalColumns(["shipment_id", "APPROVEDBY", "approval  date", "Invoice Amount ($)", "Invoice #"]), {
      shipment: "shipment_id", approved_by: "APPROVEDBY", approved_at: "approval  date",
      amount: "Invoice Amount ($)", invoice: "Invoice #", tracking: null,
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
      amount: "Total Approved Amount (USD)", invoice: "Carrier Invoice Number", tracking: null,
    });
  });

  it("does not mistake other shipment columns for the id", () => {
    assert.equal(findApprovalColumns(["Shipment Status", "Shipment Date", "Shipment Notes", "Carrier"]).shipment, null);
  });

  it("returns null for what is missing, and never throws on odd input", () => {
    assert.deepEqual(findApprovalColumns(["Carrier", "Approved By"]), {
      shipment: null, approved_by: "Approved By", approved_at: null, amount: null, invoice: null, tracking: null,
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
    });
    assert.deepEqual(results[1], {
      shipment_id: "13000002", status: "approved", approved_by: "Shaun Smith", approved_by_kind: "person",
      approved_by_raw: "shaun.smith@freightpop.com", approved_at: "11/02/2026", amount: 88, invoice: "INV-B", matches: 1,
    });
    assert.deepEqual(results[2], {
      shipment_id: "13000003", status: "approved", approved_by: null, approved_by_kind: "unknown",
      approved_by_raw: null, approved_at: "11/02/2026", amount: null, invoice: null, matches: 1,
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
        approved_at: "11/05/2026", amount: 10, invoice: "INV-2", matches: 1,
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
