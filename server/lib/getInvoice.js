// "Get invoices" job: after a person reviews an ERP pull and ticks shipments,
// the hosted browser clicks FreightPOP's GET INVOICE button for each one.
// This file holds the parts that don't need a request: checking the ids,
// the note that carries the job's settings, and the per-row state kept in
// raw.get_invoice. The one database helper takes the client as an argument,
// so nothing here needs credentials to load.
//
// Row state, in fpx_invoice_audit_rows.raw.get_invoice:
//   { status: "requested" | "done" | "failed" | "not_started",
//     requested_at, requested_by, request_id,   // set when the job is queued
//     note, at, by }                            // set when a result comes back

export const GET_INVOICE_SCOPE = "get_invoice";
export const MAX_GET_INVOICE_IDS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

// Trim, turn numbers into strings and drop repeats. Returns { ids } or
// { error } with a message a person can read.
export function normalizeShipmentIds(input, max = MAX_GET_INVOICE_IDS) {
  if (!Array.isArray(input) || !input.length) return { error: "Pick at least one shipment" };
  const ids = [];
  const seen = new Set();
  for (const v of input) {
    if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) {
      return { error: "Each shipment id must be text" };
    }
    const id = String(v).trim();
    if (!id) return { error: "A shipment id is blank" };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > max) return { error: `Pick up to ${max} shipments at a time` };
  return { ids };
}

// Ids asked for that are not among the audit's rows, in the order asked.
export function missingShipmentIds(ids, rows) {
  const have = new Set((rows || []).map((r) => String(r.shipment_id ?? "").trim()));
  return ids.filter((id) => !have.has(id));
}

// "audit=<uuid>;from=<date_from>;to=<date_to>;pause_first=<1|0>"
export function buildGetInvoiceNote({ auditId, from, to, pauseFirst = true }) {
  return `audit=${auditId};from=${from};to=${to};pause_first=${pauseFirst ? 1 : 0}`;
}

// Reads the note back. Returns null when it isn't a get-invoice note (the
// complete route replaces note with the result text, so that is expected).
export function parseGetInvoiceNote(note) {
  if (typeof note !== "string") return null;
  const parts = {};
  for (const piece of note.split(";")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    parts[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  if (!isUuid(parts.audit)) return null;
  return {
    audit_id: parts.audit,
    from: parts.from || null,
    to: parts.to || null,
    pause_first: parts.pause_first !== "0", // on unless switched off
  };
}

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// A new request starts the row's state over: an older result's note/at/by
// would otherwise sit next to "requested".
export function markRequested(raw, { requested_at, requested_by = null, request_id }) {
  return {
    ...asObject(raw),
    get_invoice: { status: "requested", requested_at, requested_by, request_id },
  };
}

// Folds one result into raw. Every other key of raw is kept, and so are the
// requested_at / requested_by / request_id written when the job was queued.
export function mergeResult(raw, { ok, note = null, at, by = null }) {
  const base = asObject(raw);
  return {
    ...base,
    get_invoice: { ...asObject(base.get_invoice), status: ok ? "done" : "failed", note, at, by },
  };
}

// Puts a row that was waiting on a request back to "not_started". Returns null
// (leave the row alone) when it isn't waiting on that request, so a result
// that already arrived is never overwritten.
export function resetRequested(raw, { request_id, note }) {
  const base = asObject(raw);
  const gi = asObject(base.get_invoice);
  if (gi.status !== "requested") return null;
  if (request_id && gi.request_id && gi.request_id !== request_id) return null;
  return { ...base, get_invoice: { ...gi, status: "not_started", note } };
}

// Cleans one entry of the worker's results. Returns null when it has no
// shipment id.
export function normalizeResult(entry, { by = null, now = new Date().toISOString() } = {}) {
  const e = asObject(entry);
  const shipment_id = typeof e.shipment_id === "string" || typeof e.shipment_id === "number"
    ? String(e.shipment_id).trim() : "";
  if (!shipment_id) return null;
  const t = e.at ? new Date(e.at) : null;
  return {
    shipment_id,
    ok: e.ok === true,
    note: e.note === undefined || e.note === null || e.note === "" ? null : String(e.note).slice(0, 500),
    at: t && !Number.isNaN(t.getTime()) ? t.toISOString() : now,
    by,
  };
}

// Reads the audit's rows for these shipment ids and writes back a new raw for
// each. change(raw, row) returns the new raw, or null to leave the row as is.
// Only the raw column is written. Returns
//   { rows, matched: Set<shipment_id>, updated, failed, error }
// where updated/failed count rows, and error is set when the read failed.
// onFail(row) is called for each row whose write failed.
export async function updateRowsRaw(db, auditId, shipmentIds, change, onFail) {
  const out = { rows: [], matched: new Set(), updated: 0, failed: 0, error: null };
  const ID_CHUNK = 100;
  for (let i = 0; i < shipmentIds.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from("fpx_invoice_audit_rows").select("id, shipment_id, raw")
      .eq("audit_id", auditId).in("shipment_id", shipmentIds.slice(i, i + ID_CHUNK));
    if (error) { out.error = error.message; return out; }
    out.rows.push(...(data || []));
  }
  for (const r of out.rows) out.matched.add(String(r.shipment_id ?? "").trim());
  if (!change) return out;
  const WRITE_CHUNK = 10;
  for (let i = 0; i < out.rows.length; i += WRITE_CHUNK) {
    await Promise.all(out.rows.slice(i, i + WRITE_CHUNK).map(async (row) => {
      const next = change(row.raw, row);
      if (!next) return;
      const { error } = await db.from("fpx_invoice_audit_rows").update({ raw: next }).eq("id", row.id);
      if (error) { out.failed += 1; if (onFail) onFail(row); }
      else out.updated += 1;
    }));
  }
  return out;
}
