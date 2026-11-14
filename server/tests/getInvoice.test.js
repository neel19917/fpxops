import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_GET_INVOICE_IDS, isUuid, normalizeShipmentIds, missingShipmentIds,
  buildGetInvoiceNote, parseGetInvoiceNote, markRequested, mergeResult,
  resetRequested, normalizeResult, updateRowsRaw,
} from "../lib/getInvoice.js";

const AUDIT = "3f2b6c1e-8a4d-4e0b-9c57-1d2e3f4a5b6c";
const REQ = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

describe("normalizeShipmentIds", () => {
  it("trims, stringifies numbers and drops repeats", () => {
    assert.deepEqual(normalizeShipmentIds([" 13000001 ", 13000002, "13000001"]), { ids: ["13000001", "13000002"] });
  });

  it("refuses a missing or empty list", () => {
    for (const bad of [undefined, null, "13000001", {}, []]) {
      assert.equal(normalizeShipmentIds(bad).error, "Pick at least one shipment");
    }
  });

  it("refuses blank ids and ids that are not text", () => {
    assert.ok(normalizeShipmentIds(["1", "  "]).error);
    assert.ok(normalizeShipmentIds(["1", null]).error);
    assert.ok(normalizeShipmentIds([{ id: 1 }]).error);
    assert.ok(normalizeShipmentIds([NaN]).error);
  });

  it("allows 200 and refuses 201 with a plain message", () => {
    const many = Array.from({ length: MAX_GET_INVOICE_IDS + 1 }, (_, i) => String(i + 1));
    assert.equal(normalizeShipmentIds(many.slice(0, 200)).ids.length, 200);
    assert.equal(normalizeShipmentIds(many).error, "Pick up to 200 shipments at a time");
  });

  it("counts after dropping repeats", () => {
    const ids = Array.from({ length: 200 }, (_, i) => String(i + 1));
    assert.equal(normalizeShipmentIds([...ids, "1", "2"]).ids.length, 200);
  });
});

describe("missingShipmentIds", () => {
  it("lists ids with no row, in the order asked", () => {
    const rows = [{ shipment_id: "2" }, { shipment_id: " 4 " }, { shipment_id: null }];
    assert.deepEqual(missingShipmentIds(["5", "2", "1", "4"], rows), ["5", "1"]);
    assert.deepEqual(missingShipmentIds(["2"], rows), []);
    assert.deepEqual(missingShipmentIds(["2"], null), ["2"]);
  });
});

describe("get-invoice note", () => {
  it("builds the agreed format, pause on by default", () => {
    assert.equal(
      buildGetInvoiceNote({ auditId: AUDIT, from: "2026-08-01", to: "2026-10-31" }),
      `audit=${AUDIT};from=2026-08-01;to=2026-10-31;pause_first=1`,
    );
    assert.ok(buildGetInvoiceNote({ auditId: AUDIT, from: "a", to: "b", pauseFirst: false }).endsWith(";pause_first=0"));
  });

  it("round-trips", () => {
    for (const pauseFirst of [true, false]) {
      const note = buildGetInvoiceNote({ auditId: AUDIT, from: "2026-08-01", to: "2026-10-31", pauseFirst });
      assert.deepEqual(parseGetInvoiceNote(note), { audit_id: AUDIT, from: "2026-08-01", to: "2026-10-31", pause_first: pauseFirst });
    }
  });

  it("keeps a timestamp date whole", () => {
    const note = buildGetInvoiceNote({ auditId: AUDIT, from: "2026-08-01T00:00:00+00:00", to: "2026-10-31T23:59:59+00:00" });
    assert.equal(parseGetInvoiceNote(note).from, "2026-08-01T00:00:00+00:00");
  });

  it("returns null for notes that are not get-invoice notes", () => {
    for (const bad of [null, undefined, 5, "", "months=3;type=parcel", "audit=nope;from=a;to=b", "Interrupted — the hosted browser restarted mid-run."]) {
      assert.equal(parseGetInvoiceNote(bad), null);
    }
  });

  it("treats a missing pause_first as on", () => {
    assert.equal(parseGetInvoiceNote(`audit=${AUDIT};from=a;to=b`).pause_first, true);
  });
});

describe("isUuid", () => {
  it("accepts uuids only", () => {
    assert.equal(isUuid(AUDIT), true);
    assert.equal(isUuid("123"), false);
    assert.equal(isUuid(undefined), false);
  });
});

describe("raw.get_invoice state", () => {
  const raw = { rank: 3, charge: 512.5, customer: "Acme" };
  const stamp = { requested_at: "2026-11-13T10:00:00.000Z", requested_by: "pat@example.com", request_id: REQ };

  it("markRequested keeps the rest of raw and does not change its input", () => {
    const next = markRequested(raw, stamp);
    assert.deepEqual(next, { ...raw, get_invoice: { status: "requested", ...stamp } });
    assert.equal(raw.get_invoice, undefined);
  });

  it("markRequested starts over, dropping an older result", () => {
    const old = mergeResult(markRequested(raw, { ...stamp, request_id: "old" }), { ok: false, note: "No button", at: "2026-11-01T00:00:00.000Z", by: "fpx-browser" });
    assert.deepEqual(markRequested(old, stamp).get_invoice, { status: "requested", ...stamp });
  });

  it("mergeResult records done and keeps the requested fields and other keys", () => {
    const next = mergeResult(markRequested(raw, stamp), { ok: true, note: "Invoice requested", at: "2026-11-13T10:05:00.000Z", by: "fpx-browser" });
    assert.deepEqual(next, {
      ...raw,
      get_invoice: { ...stamp, status: "done", note: "Invoice requested", at: "2026-11-13T10:05:00.000Z", by: "fpx-browser" },
    });
  });

  it("mergeResult records failed", () => {
    const next = mergeResult(markRequested(raw, stamp), { ok: false, note: "Button missing", at: "2026-11-13T10:05:00.000Z", by: "fpx-browser" });
    assert.equal(next.get_invoice.status, "failed");
    assert.equal(next.get_invoice.request_id, REQ);
  });

  it("mergeResult copes with a row that was never requested or has no raw", () => {
    assert.deepEqual(mergeResult(null, { ok: true, at: "t" }), { get_invoice: { status: "done", note: null, at: "t", by: null } });
    assert.deepEqual(mergeResult({ rank: 1, get_invoice: "junk" }, { ok: true, at: "t" }).get_invoice.status, "done");
    assert.equal(mergeResult(["x"], { ok: true, at: "t" }).get_invoice.status, "done");
  });

  it("resetRequested puts a waiting row back, keeping the requested fields", () => {
    const next = resetRequested(markRequested(raw, stamp), { request_id: REQ, note: "Not picked up" });
    assert.deepEqual(next, { ...raw, get_invoice: { ...stamp, status: "not_started", note: "Not picked up" } });
  });

  it("resetRequested leaves rows with a result, other requests' rows and untouched rows alone", () => {
    const done = mergeResult(markRequested(raw, stamp), { ok: true, at: "t" });
    assert.equal(resetRequested(done, { request_id: REQ, note: "x" }), null);
    assert.equal(resetRequested(markRequested(raw, stamp), { request_id: "another", note: "x" }), null);
    assert.equal(resetRequested(raw, { request_id: REQ, note: "x" }), null);
    assert.equal(resetRequested(null, { request_id: REQ, note: "x" }), null);
  });
});

describe("normalizeResult", () => {
  const now = "2026-11-13T12:00:00.000Z";

  it("cleans a result", () => {
    assert.deepEqual(
      normalizeResult({ shipment_id: " 13000001 ", ok: true, note: "Clicked", at: "2026-11-13T10:05:00Z" }, { by: "fpx-browser", now }),
      { shipment_id: "13000001", ok: true, note: "Clicked", at: "2026-11-13T10:05:00.000Z", by: "fpx-browser" },
    );
  });

  it("only ok === true is a success; a bad or missing time becomes now", () => {
    const r = normalizeResult({ shipment_id: 13000002, ok: "yes", at: "not a date" }, { now });
    assert.deepEqual(r, { shipment_id: "13000002", ok: false, note: null, at: now, by: null });
  });

  it("caps the note at 500 characters", () => {
    assert.equal(normalizeResult({ shipment_id: "1", ok: false, note: "x".repeat(900) }, { now }).note.length, 500);
  });

  it("returns null without a shipment id", () => {
    for (const bad of [null, "1", {}, { shipment_id: "  " }, { shipment_id: null, ok: true }]) {
      assert.equal(normalizeResult(bad, { now }), null);
    }
  });
});

// A stand-in for the Supabase client: just the calls updateRowsRaw makes.
function fakeDb(rows, { failIds = [], readError = null } = {}) {
  const writes = [];
  const reads = [];
  return {
    writes,
    reads,
    from(table) {
      assert.equal(table, "fpx_invoice_audit_rows");
      return {
        select(cols) {
          const f = {};
          const q = {
            eq(col, v) { f[col] = v; return q; },
            in(col, list) {
              reads.push({ cols, audit_id: f.audit_id, ids: list });
              if (readError) return Promise.resolve({ data: null, error: { message: readError } });
              return Promise.resolve({
                data: rows.filter((r) => r.audit_id === f.audit_id && list.includes(r.shipment_id)).map((r) => ({ id: r.id, shipment_id: r.shipment_id, raw: r.raw })),
                error: null,
              });
            },
          };
          return q;
        },
        update(patch) {
          return {
            eq(col, id) {
              assert.equal(col, "id");
              if (failIds.includes(id)) return Promise.resolve({ error: { message: "boom" } });
              writes.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

describe("updateRowsRaw", () => {
  const rows = [
    { id: "r1", audit_id: AUDIT, shipment_id: "1", raw: { rank: 1 } },
    { id: "r2", audit_id: AUDIT, shipment_id: "2", raw: { rank: 2 } },
    { id: "r2b", audit_id: AUDIT, shipment_id: "2", raw: { rank: 5 } },
    { id: "x1", audit_id: "other", shipment_id: "1", raw: { rank: 9 } },
  ];

  it("writes only raw, only for this audit's rows, and reports what matched", async () => {
    const db = fakeDb(rows);
    const out = await updateRowsRaw(db, AUDIT, ["1", "2", "404"], (raw) => mergeResult(raw, { ok: true, at: "t" }));
    assert.deepEqual([...out.matched].sort(), ["1", "2"]);
    assert.equal(out.updated, 3);
    assert.equal(out.failed, 0);
    assert.deepEqual(db.writes.map((w) => w.id).sort(), ["r1", "r2", "r2b"]);
    for (const w of db.writes) assert.deepEqual(Object.keys(w.patch), ["raw"]);
    assert.equal(db.writes.find((w) => w.id === "r2b").patch.raw.rank, 5);
  });

  it("with no change function it only reads", async () => {
    const db = fakeDb(rows);
    const out = await updateRowsRaw(db, AUDIT, ["1"], null);
    assert.equal(out.rows.length, 1);
    assert.equal(db.writes.length, 0);
  });

  it("skips rows the change function returns null for", async () => {
    const db = fakeDb(rows);
    const out = await updateRowsRaw(db, AUDIT, ["1", "2"], (raw, row) => (row.id === "r1" ? { ...raw, touched: true } : null));
    assert.equal(out.updated, 1);
    assert.deepEqual(db.writes, [{ id: "r1", patch: { raw: { rank: 1, touched: true } } }]);
  });

  it("counts failed writes and names them", async () => {
    const db = fakeDb(rows, { failIds: ["r2"] });
    const failed = [];
    const out = await updateRowsRaw(db, AUDIT, ["1", "2"], (raw) => ({ ...raw }), (row) => failed.push(row.id));
    assert.equal(out.updated, 2);
    assert.equal(out.failed, 1);
    assert.deepEqual(failed, ["r2"]);
  });

  it("reports a failed read and writes nothing", async () => {
    const db = fakeDb(rows, { readError: "down" });
    const out = await updateRowsRaw(db, AUDIT, ["1"], (raw) => raw);
    assert.equal(out.error, "down");
    assert.equal(db.writes.length, 0);
  });

  it("reads ids in chunks of 100", async () => {
    const db = fakeDb(rows);
    await updateRowsRaw(db, AUDIT, Array.from({ length: 200 }, (_, i) => String(i + 1)), null);
    assert.deepEqual(db.reads.map((r) => r.ids.length), [100, 100]);
  });
});
