import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dayOf, parseFilters, pickApproval, pushedDate, shapeRow, buildRows, buildMatchRows, filterRows, sortRows,
  totalsOf, perDay, listPushed, exportRows, EXPORT_HEADERS, parseInvoices, matchKeys, matchInvoices,
  loadAllPages, DEFAULT_LIMIT, MAX_LIMIT, MAX_MATCH,
} from "../lib/erpPushed.js";
import { writeXlsx } from "../lib/xlsxWrite.js";

const tx = (over = {}) => ({
  shipment_id: "15725111",
  tracking_number: "045862331",
  tracking_key: "45862331",
  customer_name: "Acme Co",
  carrier: "XPO Logistics",
  shipped_date: "2026-11-11",
  billing_invoice_number: "15725111",
  charge: 150.1,
  cost: 123.23,
  gross_profit: 26.87,
  approved_invoice_amount: 123.23,
  invoice_approved_date: "2026-11-16",
  exported_to_erp: true,
  exported_changed_at: null,
  first_seen_at: "2026-11-14T06:12:38.322Z",
  last_seen_at: "2026-11-17T12:01:47.566Z",
  batch_number: "",
  ...over,
});

const ap = (over = {}) => ({
  approval_key: "45862331|INV-900",
  tracking_number: "45862331",
  tracking_key: "45862331",
  invoice_number: "INV-900",
  carrier: "XPO",
  approved_date: "2026-11-16",
  approved_by: "EDI",
  invoice_amount: 123.23,
  exported_date: "2026-11-17",
  last_seen_at: "2026-11-17T12:05:00.000Z",
  exported: "Yes",
  gl_code: "5000",
  internal_vendor_id: "V-12",
  po_number: "PO-1",
  so_number: "SO-2",
  bol_number: "SHP15725111",
  payee: "Third Party",
  ...over,
});

describe("dayOf", () => {
  it("takes dates and timestamps, refuses the rest", () => {
    assert.equal(dayOf("2026-11-17"), "2026-11-17");
    assert.equal(dayOf("2026-11-17T12:01:47.589+00:00"), "2026-11-17");
    assert.equal(dayOf("2026-02-30"), null);
    assert.equal(dayOf("11/17/2026"), null);
    assert.equal(dayOf(null), null);
  });
});

describe("parseFilters", () => {
  it("defaults", () => {
    assert.deepEqual(parseFilters({}), { from: null, to: null, dated: false, q: "", carrier: "", customer: "", limit: DEFAULT_LIMIT, offset: 0 });
  });
  it("reads every filter and clamps paging", () => {
    const f = parseFilters({ from: "2026-10-18", to: "2026-11-17", dated: "1", q: "  15725 ", carrier: "xpo", customer: "acme", limit: "99999", offset: "-4" });
    assert.deepEqual(f, { from: "2026-10-18", to: "2026-11-17", dated: true, q: "15725", carrier: "xpo", customer: "acme", limit: MAX_LIMIT, offset: 0 });
    assert.equal(parseFilters({ limit: "0" }).limit, 1);
    assert.equal(parseFilters({ limit: "abc", offset: "40" }).limit, DEFAULT_LIMIT);
    assert.equal(parseFilters({ offset: "40" }).offset, 40);
    assert.equal(parseFilters({ q: ["a", "b"] }).q, "a");
  });
  it("refuses bad dates and a backwards range", () => {
    assert.match(parseFilters({ from: "11/01/2026" }).error, /from must be a date/);
    assert.match(parseFilters({ to: "2026-13-01" }).error, /to must be a date/);
    assert.match(parseFilters({ from: "2026-11-02", to: "2026-11-01" }).error, /not be after/);
  });
});

describe("pushedDate", () => {
  it("prefers FreightPOP's export date", () => {
    assert.deepEqual(pushedDate(tx({ exported_changed_at: "2026-11-18T01:00:00Z" }), ap()), { pushed_date: "2026-11-17", pushed_date_source: "freightpop_export_date" });
  });
  it("falls back to the day we saw it turn exported", () => {
    assert.deepEqual(pushedDate(tx({ exported_changed_at: "2026-11-17T12:01:47.589+00:00" }), ap({ exported_date: null })), { pushed_date: "2026-11-17", pushed_date_source: "first_seen_exported" });
    assert.deepEqual(pushedDate(tx({ exported_changed_at: "2026-11-17T12:01:47Z" }), null), { pushed_date: "2026-11-17", pushed_date_source: "first_seen_exported" });
  });
  it("is unknown when neither is there, or the flip was to not exported", () => {
    assert.deepEqual(pushedDate(tx(), null), { pushed_date: null, pushed_date_source: "unknown" });
    assert.deepEqual(pushedDate(tx({ exported_to_erp: false, exported_changed_at: "2026-11-17T12:00:00Z" }), null), { pushed_date: null, pushed_date_source: "unknown" });
  });
});

describe("pickApproval", () => {
  it("takes the exported one over a newer approval, then the latest", () => {
    const old = ap({ approval_key: "a", invoice_number: "A", approved_date: "2026-10-01", exported_date: "2026-10-05" });
    const newer = ap({ approval_key: "b", invoice_number: "B", approved_date: "2026-11-10", exported_date: null });
    assert.equal(pickApproval([newer, old]).invoice_number, "A");
    const later = ap({ approval_key: "c", invoice_number: "C", approved_date: "2026-11-01", exported_date: "2026-11-12" });
    assert.equal(pickApproval([old, later, newer]).invoice_number, "C");
    assert.equal(pickApproval([newer, ap({ approval_key: "d", invoice_number: "D", approved_date: "2026-11-11", exported_date: null })]).invoice_number, "D");
    assert.equal(pickApproval([]), null);
  });
});

describe("shapeRow / buildRows", () => {
  it("joins a shipment to its approval", () => {
    const [row, ...rest] = buildRows([tx(), tx({ shipment_id: "2", tracking_key: "X2", exported_to_erp: false })], [ap()]);
    assert.equal(rest.length, 0, "not-exported shipments are left out");
    assert.deepEqual(row, {
      shipment_id: "15725111", tracking_number: "045862331", customer_name: "Acme Co", carrier: "XPO Logistics",
      shipped_date: "2026-11-11", billing_invoice_number: "15725111", invoice_number: "INV-900", invoice_numbers: ["INV-900"],
      approved_invoice_amount: 123.23, charge: 150.1, cost: 123.23, gross_profit: 26.87, pushed: true,
      pushed_date: "2026-11-17", pushed_date_source: "freightpop_export_date", carrier_invoice_exported: true,
      approved_date: "2026-11-16", approved_by: "EDI", batch_number: null, gl_code: "5000", internal_vendor_id: "V-12",
      po_number: "PO-1", so_number: "SO-2", bol_number: "SHP15725111", payee: "Third Party",
      last_seen_at: "2026-11-17T12:01:47.566Z",
    });
  });
  it("works with no approval, and keeps every carrier invoice number", () => {
    const bare = shapeRow(tx({ approved_invoice_amount: null }), []);
    assert.equal(bare.invoice_number, null);
    assert.equal(bare.approved_invoice_amount, null);
    assert.equal(bare.approved_date, "2026-11-16");
    assert.equal(bare.carrier_invoice_exported, null);
    assert.equal(bare.pushed_date_source, "unknown");
    const two = shapeRow(tx(), [ap(), ap({ approval_key: "k2", invoice_number: "INV-901", exported_date: null, exported: "No" })]);
    assert.deepEqual(two.invoice_numbers, ["INV-900", "INV-901"]);
    assert.equal(two.invoice_number, "INV-900");
  });
  it("falls back to the approval's amount, and matches approvals by tracking number when the key is missing", () => {
    const [row] = buildRows([tx({ approved_invoice_amount: null, tracking_key: null })], [ap({ tracking_key: null, tracking_number: "0045862331", invoice_amount: "99.5" })]);
    assert.equal(row.approved_invoice_amount, 99.5);
    assert.equal(row.invoice_number, "INV-900");
  });
  it("an approved invoice with no shipment is a row for matching, pushed when FreightPOP dated its export", () => {
    const rows = buildMatchRows([tx({ exported_to_erp: false })], [ap(), ap({ approval_key: "z|Z-1", tracking_key: "Z", tracking_number: "Z", invoice_number: "Z-1" })]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].pushed, false);
    assert.equal(rows[1].shipment_id, null);
    assert.equal(rows[1].invoice_number, "Z-1");
    assert.equal(rows[1].pushed, true);
    assert.equal(rows[1].carrier_invoice_exported, true);
    assert.equal(rows[1].last_seen_at, "2026-11-17T12:05:00.000Z");
  });
});

const sample = () => buildRows(
  [
    tx(),
    tx({ shipment_id: "200", tracking_number: "T200", tracking_key: "T200", billing_invoice_number: "B-200", customer_name: "Beta LLC", carrier: "Estes", charge: 10, cost: 4, gross_profit: 6, approved_invoice_amount: 4, shipped_date: "2026-10-01", exported_changed_at: "2026-11-15T10:00:00Z" }),
    tx({ shipment_id: "300", tracking_number: "T300", tracking_key: "T300", billing_invoice_number: "B-300", customer_name: "Beta LLC", carrier: "XPO Logistics", charge: 0.1, cost: 0.2, gross_profit: -0.1, approved_invoice_amount: null, shipped_date: "2026-09-01" }),
    tx({ shipment_id: "400", tracking_number: "T400", tracking_key: "T400", exported_to_erp: false }),
  ],
  [ap()],
);

describe("filterRows", () => {
  it("applies the range to the pushed date and keeps undated rows unless dated", () => {
    const rows = sample();
    const f = (q) => filterRows(rows, parseFilters(q)).map((r) => r.shipment_id);
    assert.deepEqual(f({}), ["15725111", "200", "300"]);
    assert.deepEqual(f({ from: "2026-11-16", to: "2026-11-17" }), ["15725111", "300"]);
    assert.deepEqual(f({ from: "2026-11-16", to: "2026-11-17", dated: "1" }), ["15725111"]);
    assert.deepEqual(f({ to: "2026-11-15", dated: "1" }), ["200"]);
    assert.deepEqual(f({ dated: "1" }), ["15725111", "200"]);
  });
  it("searches ids, tracking, both invoice numbers, customer and carrier", () => {
    const rows = sample();
    const f = (q) => filterRows(rows, parseFilters(q)).map((r) => r.shipment_id);
    assert.deepEqual(f({ q: "inv-900" }), ["15725111"]);
    assert.deepEqual(f({ q: "b-2" }), ["200"]);
    assert.deepEqual(f({ q: "T300" }), ["300"]);
    assert.deepEqual(f({ q: "beta" }), ["200", "300"]);
    assert.deepEqual(f({ q: "estes" }), ["200"]);
    assert.deepEqual(f({ carrier: "xpo" }), ["15725111", "300"]);
    assert.deepEqual(f({ customer: "beta", carrier: "xpo" }), ["300"]);
    assert.deepEqual(f({ q: "nothing-like-this" }), []);
  });
});

describe("listPushed", () => {
  it("sorts newest push first with undated last, pages, and totals the whole match", () => {
    const out = listPushed(sample(), parseFilters({ limit: "2" }));
    assert.deepEqual(out.data.map((r) => r.shipment_id), ["15725111", "200"]);
    assert.deepEqual(out.totals, { count: 3, dated: 2, undated: 1, charge: 160.2, cost: 127.43, gross_profit: 32.77, approved_invoice_amount: 127.23 });
    assert.deepEqual(out.per_day, [{ date: "2026-11-15", count: 1, charge: 10 }, { date: "2026-11-17", count: 1, charge: 150.1 }]);
    assert.equal(out.limit, 2);
    const next = listPushed(sample(), parseFilters({ limit: "2", offset: "2" }));
    assert.deepEqual(next.data.map((r) => r.shipment_id), ["300"]);
    assert.equal(next.totals.count, 3);
  });
  it("sortRows orders undated rows by shipped date", () => {
    const rows = sortRows([
      { shipment_id: "1", pushed_date: null, shipped_date: "2026-01-01" },
      { shipment_id: "2", pushed_date: null, shipped_date: "2026-03-01" },
      { shipment_id: "3", pushed_date: "2026-02-01", shipped_date: null },
    ]);
    assert.deepEqual(rows.map((r) => r.shipment_id), ["3", "2", "1"]);
  });
  it("totals and per-day of nothing", () => {
    assert.deepEqual(totalsOf([]), { count: 0, dated: 0, undated: 0, charge: 0, cost: 0, gross_profit: 0, approved_invoice_amount: 0 });
    assert.deepEqual(perDay([]), []);
  });
});

describe("exportRows", () => {
  it("gives writeXlsx plain titled rows, blanks left out", () => {
    const [first, , third] = exportRows(sortRows(sample()));
    assert.equal(first["Shipment ID"], "15725111");
    assert.equal(first["Carrier Invoice Number"], "INV-900");
    assert.equal(first["Pushed Date"], "2026-11-17");
    assert.equal(first["Pushed Date Source"], "FreightPOP export date");
    assert.equal(first["Charge"], 150.1);
    assert.equal(first["Carrier Invoice Exported"], "Yes");
    assert.equal(first["GL Code"], "5000");
    assert.ok(!("Batch Number" in first));
    assert.ok(!("Other Carrier Invoice Numbers" in first));
    assert.equal(third["Pushed Date Source"], "Not known");
    assert.ok(!("Pushed Date" in third));
    for (const k of Object.keys(first)) assert.ok(EXPORT_HEADERS.includes(k), k);
    const buf = writeXlsx(EXPORT_HEADERS, exportRows(sample()));
    assert.equal(buf.subarray(0, 2).toString(), "PK");
  });
});

describe("parseInvoices", () => {
  it("splits, trims, drops blanks and repeats", () => {
    assert.deepEqual(parseInvoices(["INV-1, inv-1\n 15725111 ;\t\"B-200\"", "", null, 42, { a: 1 }]).values, ["INV-1", "15725111", "B-200", "42"]);
  });
  it("refuses a non-list, an empty list and too many", () => {
    assert.match(parseInvoices("INV-1").error, /must be a list/);
    assert.match(parseInvoices([" ", ","]).error, /Nothing to match/);
    assert.match(parseInvoices(Array.from({ length: MAX_MATCH + 1 }, (_, i) => `X${i}`)).error, /At most 5000/);
    assert.equal(parseInvoices(Array.from({ length: MAX_MATCH }, (_, i) => `X${i}`)).values.length, MAX_MATCH);
  });
});

describe("matchInvoices", () => {
  const rows = () => buildMatchRows(
    [
      tx(),
      tx({ shipment_id: "400", tracking_number: "T400", tracking_key: "T400", billing_invoice_number: "B-400", exported_to_erp: false }),
      tx({ shipment_id: "500", tracking_number: "0077", tracking_key: "77", billing_invoice_number: "500", exported_to_erp: null }),
    ],
    [ap(), ap({ approval_key: "T400|INV-400", tracking_key: "T400", tracking_number: "T400", invoice_number: "INV-400", exported_date: null, exported: "No", bol_number: "SHP400" }),
      ap({ approval_key: "Z|Z-1", tracking_key: "Z", tracking_number: "Z", invoice_number: "Z-1" })],
  );
  it("sorts each pasted value into pushed, not pushed or not found", () => {
    const { results, summary } = matchInvoices(["15725111", "inv-900", "SHP15725111", "B-400", "INV-400", "500", "77", "Z-1", "NOPE-1"], rows());
    assert.deepEqual(summary, { total: 9, pushed: 4, not_pushed: 4, not_found: 1 });
    const by = Object.fromEntries(results.map((r) => [r.input, r]));
    assert.deepEqual([by["15725111"].found, by["15725111"].pushed, by["15725111"].matched_on], [true, true, "shipment_id"]);
    assert.deepEqual([by["inv-900"].pushed, by["inv-900"].matched_on, by["inv-900"].row.shipment_id], [true, "invoice_number", "15725111"]);
    assert.deepEqual([by["SHP15725111"].pushed, by["SHP15725111"].matched_on], [true, "shipment_id"]);
    assert.deepEqual([by["B-400"].found, by["B-400"].pushed, by["B-400"].matched_on], [true, false, "billing_invoice_number"]);
    assert.deepEqual([by["INV-400"].pushed, by["INV-400"].row.shipment_id], [false, "400"]);
    assert.deepEqual([by["500"].found, by["500"].pushed], [true, false]);
    assert.deepEqual([by["77"].matched_on, by["77"].row.shipment_id], ["tracking_number", "500"]);
    assert.deepEqual([by["Z-1"].found, by["Z-1"].pushed, by["Z-1"].row.shipment_id], [true, true, null]);
    assert.deepEqual(by["NOPE-1"], { input: "NOPE-1", found: false, pushed: false, matched_on: null, row: null, others: 0 });
  });
  it("ignores leading zeros both ways and prefers a pushed shipment when several match", () => {
    const list = buildMatchRows(
      [
        tx({ shipment_id: "1", tracking_number: "PRO9", tracking_key: "PRO9", billing_invoice_number: "0009001", exported_to_erp: false }),
        tx({ shipment_id: "2", tracking_number: "PRO9", tracking_key: "PRO9", billing_invoice_number: "X2", exported_to_erp: true }),
      ],
      [],
    );
    const { results } = matchInvoices(["9001", "pro9", "00002"], list);
    assert.deepEqual([results[0].found, results[0].row.shipment_id], [true, "1"]);
    assert.deepEqual([results[1].pushed, results[1].row.shipment_id, results[1].others], [true, "2", 1]);
    assert.deepEqual([results[2].matched_on, results[2].row.shipment_id], ["shipment_id", "2"]);
  });
  it("matchKeys", () => {
    assert.deepEqual(matchKeys(" shp-0015725111 "), ["SHP-0015725111", "0015725111", "15725111"]);
    assert.deepEqual(matchKeys("#42"), ["#42", "42"]);
    assert.deepEqual(matchKeys(""), []);
  });
});

describe("loadAllPages", () => {
  const table = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
  const pager = (rows, calls) => async (from, to) => { calls.push([from, to]); return { data: rows.slice(from, to + 1), error: null }; };
  it("reads past the 1000-row cap until a short page", async () => {
    const calls = [];
    const out = await loadAllPages(pager(table(2500), calls), { pageSize: 1000 });
    assert.equal(out.length, 2500);
    assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it("reads one more page when the last is exactly full", async () => {
    const calls = [];
    const out = await loadAllPages(pager(table(2000), calls), { pageSize: 1000 });
    assert.equal(out.length, 2000);
    assert.equal(calls.length, 3);
  });
  it("reads several pages at a time, in order", async () => {
    const calls = [];
    const out = await loadAllPages(pager(table(4321), calls), { pageSize: 1000, concurrency: 3 });
    assert.deepEqual(out.map((r) => r.id), table(4321).map((r) => r.id));
    assert.equal(calls.length, 6);
  });
  it("drops a row read twice and passes an error on", async () => {
    const rows = [...table(3), { id: 2 }, { id: 3 }];
    const out = await loadAllPages(async (from, to) => ({ data: rows.slice(from, to + 1), error: null }), { pageSize: 2, key: (r) => r.id });
    assert.deepEqual(out.map((r) => r.id), [0, 1, 2, 3]);
    await assert.rejects(loadAllPages(async () => ({ data: null, error: { message: "boom" } })), /boom/);
    await assert.rejects(loadAllPages(async () => ({ data: [{}, {}], error: null }), { pageSize: 2, maxPages: 3 }), /Too many rows/);
  });
});
