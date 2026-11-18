import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunRows, exportRows, giPushed, scrapeStatusLabel, summarizeRun, zipPlan, runShipmentIds, withHistory, EXPORT_HEADERS, buildExport, parseExportOptions } from "../lib/getInvoiceRuns.js";

const A = "11111111-1111-4111-8111-111111111111";
const r1 = { id: "run-1", scrape_number: 40, status: "done", requested_at: "2026-11-17T19:13:00Z", requested_by: "pat", tracking_numbers: ["100", "200", "100"], result_count: 1, note: "Stopped by user. 1 of 2 clicked" };
const r2 = { id: "run-2", scrape_number: 41, status: "done", requested_at: "2026-11-17T19:32:00Z", requested_by: "pat", tracking_numbers: ["200"], result_count: 1, note: "1 of 1 clicked" };
const byId = new Map([[r1.id, r1], [r2.id, r2]]);
const rowsByShipment = new Map([
  ["100", [{ audit_id: A, shipment_id: "100", customer_name: "Acme", carrier: "UPS", raw: { get_invoice: { status: "done", request_id: "run-1", requested_at: r1.requested_at, at: "2026-11-17T19:20:00Z", shots: ["invoices/100-1.png"] } } }]],
  ["200", [{ audit_id: A, shipment_id: "200", customer_name: "Beta", carrier: "FedEx", raw: { get_invoice: { status: "done", request_id: "run-2", requested_at: r2.requested_at, at: "2026-11-17T19:40:00Z", shots: ["invoices/200-1.png", "invoices/200-2.pdf"] } } }]],
]);
const tx = new Map([["100", { shipment_id: "100", billing_invoice_number: "INV-100", charge: 250, cost: 200, tracking_number: "PRO1" }]]);
const docs = new Map([["100", [{ shipment_id: "100", audit_id: A, doc_type: "invoice", invoice_number: "INV-100", total: 250 }]]]);
const ctx = { byId, rowsByShipment, tx, docs };

describe("Get Invoice runs", () => {
  it("lists a run's shipments once, in order", () => {
    assert.deepEqual(runShipmentIds(r1), ["100", "200"]);
  });

  it("reads each shipment's result for the run, and marks one a later run clicked again", () => {
    const rows = buildRunRows(r1, ctx);
    assert.deepEqual(rows.map((r) => [r.shipment_id, r.status, r.later_run, r.files.length]), [["100", "done", null, 1], ["200", "rerun", 41, 2]]);
    assert.equal(rows[0].scrape_number, 40);
    assert.deepEqual([rows[0].billing_invoice_number, rows[0].read_invoice_number, rows[0].read_total, rows[0].charge], ["INV-100", "INV-100", 250, 250]);
    assert.equal(buildRunRows(r2, ctx)[0].status, "done");
  });

  it("uses the history entry of an earlier run when there is one", () => {
    const hist = new Map(rowsByShipment);
    hist.set("200", [{ ...rowsByShipment.get("200")[0], raw: { get_invoice: { ...rowsByShipment.get("200")[0].raw.get_invoice, history: [{ request_id: "run-1", status: "failed", note: "No button", at: "t" }] } } }]);
    const row = buildRunRows(r1, { ...ctx, rowsByShipment: hist })[1];
    assert.deepEqual([row.status, row.note, row.later_run], ["failed", "No button", 41]);
  });

  it("a shipment with no row yet is not reached, or requested while the run is going", () => {
    const run = { ...r2, id: "run-3", tracking_numbers: ["999"] };
    assert.equal(buildRunRows(run, ctx)[0].status, "not_reached");
    assert.equal(buildRunRows({ ...run, status: "claimed" }, ctx)[0].status, "requested");
  });

  it("summarizes a run and exports rows with the scrape number first", () => {
    const rows = buildRunRows(r1, ctx);
    const s = summarizeRun(r1, rows);
    assert.deepEqual([s.scrape_number, s.requested, s.done, s.files, s.audit_id], [40, 2, 1, 3, A]);
    const out = exportRows([r1], new Map([[r1.id, rows]]));
    assert.equal(EXPORT_HEADERS[0], "Scrape #");
    assert.deepEqual([out[0]["Scrape #"], out[0]["Shipment ID"], out[0]["Total matches charge"], out[0]["File names"]], [40, "100", "yes", "100-1.png"]);
  });

  it("plans each stored file once, in a folder per shipment", () => {
    const rows = [...buildRunRows(r1, ctx), ...buildRunRows(r2, ctx)];
    assert.deepEqual(zipPlan(rows).map((p) => p.name), ["100/100-1.png", "200/200-1.png", "200/200-2.pdf"]);
  });

  it("says whether GET INVOICE was pushed", () => {
    assert.equal(giPushed({ status: "done" }), true);
    assert.equal(giPushed({ status: "failed", note: "Stopped before the result could be checked · A new window opened · the button was clicked" }), true);
    assert.equal(giPushed({ status: "failed", note: "No GET INVOICE button" }), false);
    for (const s of ["not_reached", "not_started", "requested", "rerun"]) assert.equal(giPushed({ status: s }), false);
    assert.deepEqual(["done", "not_reached", "x", null].map(scrapeStatusLabel), ["Done", "Not reached", "x", null]);
    const out = exportRows([r1], new Map([[r1.id, buildRunRows(r1, ctx)]]));
    assert.deepEqual(out.map((r) => r["Get Invoice pushed"]), ["Yes", "No"]);
  });

  it("withHistory keeps one entry per run, newest last", () => {
    const g = withHistory({ request_id: "b", status: "done", history: [{ request_id: "a", status: "failed" }, { request_id: "b", status: "failed" }] });
    assert.deepEqual(g.history.map((h) => [h.request_id, h.status]), [["a", "failed"], ["b", "done"]]);
    assert.equal(withHistory({ status: "done" }).history, undefined);
  });
});

describe("Get Invoice export options", () => {
  const rowsByRun = new Map([[r1.id, buildRunRows(r1, ctx)], [r2.id, buildRunRows(r2, ctx)]]);
  it("picks, orders and renames columns", () => {
    const opts = parseExportOptions({ columns: "shipment_id,scrape_number,nope,shipment_id", "label.shipment_id": "Shipment", "label.bad": "x" });
    assert.deepEqual(opts.columns, ["shipment_id", "scrape_number"]);
    const { headers, rows } = buildExport([r1, r2], rowsByRun, opts);
    assert.deepEqual(headers, ["Shipment", "Scrape #"]);
    assert.deepEqual(rows[0], { Shipment: "100", "Scrape #": 40 });
  });
  it("defaults to the default columns", () => {
    assert.deepEqual(buildExport([r1], rowsByRun).headers, EXPORT_HEADERS);
  });
  it("filters by status, keeps the newest run per shipment, and sorts with blanks last", () => {
    const only = buildExport([r1, r2], rowsByRun, parseExportOptions({ columns: "shipment_id,scrape_number", status: "done" }));
    assert.deepEqual(only.rows.map((r) => [r["Shipment ID"], r["Scrape #"]]), [["100", 40], ["200", 41]]);
    const latest = buildExport([r1, r2], rowsByRun, parseExportOptions({ columns: "shipment_id,scrape_number", latest: "1", sort: "scrape_number", dir: "desc" }));
    assert.deepEqual(latest.rows.map((r) => [r["Shipment ID"], r["Scrape #"]]), [["200", 41], ["100", 40]]);
    const byCharge = buildExport([r1, r2], rowsByRun, parseExportOptions({ columns: "shipment_id,charge", sort: "charge", dir: "desc" }));
    assert.equal(byCharge.rows.at(-1).Charge, null);
  });
  it("numbers repeated headers", () => {
    const { headers } = buildExport([r1], rowsByRun, parseExportOptions({ columns: "charge,cost", "label.cost": "Charge" }));
    assert.deepEqual(headers, ["Charge", "Charge (2)"]);
  });
});

describe("master-file Excel", async () => {
  const { writeXlsx, filterSortXlsx, reshapeXlsx } = await import("../lib/xlsxWrite.js");
  const { readXlsx } = await import("../lib/xlsxRead.js");
  const { masterFileDrop } = await import("../lib/getInvoiceRuns.js");
  const headers = ["Customer Id", "Customer Name", "ShipmentID", "Charge", "Appointment Set", "Appointment Date", "Pickup Response", "Spot Quote", "Customer Audit", "Billing Invoice Number"];
  const row = (id, n) => Object.fromEntries(headers.map((h) => [h, h === "ShipmentID" ? id : h === "Charge" ? n : `${h} ${id}`]));
  const book = writeXlsx(headers, [row("100", 10), row("200", 20), row("300", 30)]);

  it("finds Customer Id and Appointment Set through Customer Audit by title", () => {
    assert.deepEqual([...masterFileDrop(headers)].sort((a, b) => a - b), [0, 4, 5, 6, 7, 8]);
    assert.equal(masterFileDrop(["A", "B", "C"]).size, 0);
  });

  it("drops those columns, keeps the rest in place and adds Scrape # last", () => {
    const cut = filterSortXlsx(book, { keep: (o) => o.ShipmentID !== "200", compare: (a, b) => Number(b.ShipmentID) - Number(a.ShipmentID) });
    const out = readXlsx(reshapeXlsx(cut, { drop: masterFileDrop, add: [
      { title: "Scrape #", value: (o) => (o.ShipmentID === "300" ? 130 : null) },
      { title: "Scrape Status", value: (o) => (o.ShipmentID === "300" ? "Done" : "Not reached") },
      { title: "Get Invoice Pushed", value: (o) => (o.ShipmentID === "300" ? "Yes" : "No") },
    ] }));
    assert.deepEqual(out.headers, ["Customer Name", "ShipmentID", "Charge", "Billing Invoice Number", "Scrape #", "Scrape Status", "Get Invoice Pushed"]);
    assert.deepEqual(out.rows.map((r) => [r.ShipmentID, r.Charge, r["Billing Invoice Number"], r["Scrape #"], r["Scrape Status"], r["Get Invoice Pushed"]]),
      [["300", "30", "Billing Invoice Number 300", "130", "Done", "Yes"], ["100", "10", "Billing Invoice Number 100", "", "Not reached", "No"]]);
  });

  it("still takes a single added column", () => {
    const out = readXlsx(reshapeXlsx(book, { drop: masterFileDrop, add: { title: "Scrape #", value: () => 7 } }));
    assert.equal(out.headers.at(-1), "Scrape #");
    assert.deepEqual(out.rows.map((r) => r["Scrape #"]), ["7", "7", "7"]);
  });
});
