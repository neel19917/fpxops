import { supabase } from "./supabase.js";

// Fields that indicate real-world change for the broker. A diff in any of
// these flips material_change=true on the scrape row, which is what gates
// downstream re-analysis. Cosmetic columns like raw_data or last_modified_at
// alone shouldn't trigger work.
export const MATERIAL_FIELDS = [
  "shipment_status",
  "pickup_response",
  "pickup_date",
  "updated_eta",
  "estimated_arrival",
  "estimated_departure",
  "actual_departure",
  "actual_arrival",
  "delivery_date",
  "comments",
  "tracking_comments",
  "appointment_set",
  "appointment_date",
  "signed_by",
  "carrier_name",
  "service",
];

// Timestamps come back from PostgREST as "2026-08-25T00:00:00+00:00" but
// mapShipment emits "2026-08-25T00:00:00.000Z" for the same instant. Compared
// as strings they always differ, which made every scrape of a row with a
// pickup_date / updated_eta / appointment_date a "material change" — a paid
// re-analysis per scrape and a fake "pickup_date: X → X" line in every task
// change log (measured 2026-09-18: 154 of 184 recent auto-task change logs).
// Canonicalize anything that looks like an ISO timestamp to epoch-derived ISO
// so equal instants compare equal regardless of formatting.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}(:?\d{2})?|Z)?$/;
function normalize(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  return v;
}
// Comparison key: like normalize(), but ISO-looking timestamps collapse to a
// canonical instant. Reported prev/next values stay as normalize() returns
// them so change logs show the source strings.
function canon(v) {
  const n = normalize(v);
  if (typeof n === "string" && ISO_TS_RE.test(n)) {
    // Date.parse rejects the bare postgres "+00" offset and the space
    // separator; PostgREST sends "+00:00"/"T" but raw SQL text may not.
    const ms = Date.parse(n.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return n;
}

// Returns null when nothing material changed. Otherwise an object keyed by
// field name: { field: { prev, next } }. Comparing only MATERIAL_FIELDS keeps
// the diff signal-rich and avoids spurious changes from raw_data or
// scraped_at, etc.
export function computeMaterialDiff(prev, next) {
  if (!prev) return null; // first sighting — no diff
  const diff = {};
  for (const f of MATERIAL_FIELDS) {
    const a = normalize(prev[f]);
    const b = normalize(next[f]);
    if (JSON.stringify(canon(a)) !== JSON.stringify(canon(b))) diff[f] = { prev: a, next: b };
  }
  return Object.keys(diff).length ? diff : null;
}

// Insert one row per scrape. shipmentId comes from the upsert that already
// happened, so we can FK back to the canonical shipment. raw_data is the full
// scraped payload — anything the extension grabbed that we didn't promote to
// a typed column still survives in case we need it later.
export async function recordScrape({
  shipmentId,
  trackingNumber,
  scrapedBy,
  raw,
  diff,
  triggeredReanalysis,
}) {
  if (!trackingNumber) return null;
  const row = {
    shipment_id: shipmentId || null,
    tracking_number: trackingNumber,
    scraped_by: scrapedBy || null,
    raw_data: raw ?? {},
    diff: diff || null,
    material_change: !!diff,
    triggered_reanalysis: !!triggeredReanalysis,
  };
  const { data, error } = await supabase
    .from("fpx_shipment_scrapes").insert(row).select("id").single();
  if (error) {
    console.warn("[FPX] recordScrape failed:", error.message);
    return null;
  }
  return data?.id || null;
}

// Convenience for a batch of scrapes — returns array of inserted ids in the
// same order. We use a single .insert(...) with select() so we get the ids
// back in one round-trip.
export async function recordScrapeBatch(rows) {
  const clean = (rows || []).filter((r) => r && r.tracking_number);
  if (!clean.length) return [];
  const payload = clean.map((r) => ({
    shipment_id: r.shipmentId || null,
    tracking_number: r.trackingNumber,
    scraped_by: r.scrapedBy || null,
    raw_data: r.raw ?? {},
    diff: r.diff || null,
    material_change: !!r.diff,
    triggered_reanalysis: !!r.triggeredReanalysis,
  }));
  const { data, error } = await supabase
    .from("fpx_shipment_scrapes").insert(payload).select("id");
  if (error) {
    console.warn("[FPX] recordScrapeBatch failed:", error.message);
    return [];
  }
  return (data || []).map((r) => r.id);
}

// ---------- What changed between two reads (fpx_scrape_history) ----------
// The tracking grid keeps every scrape in fpx_shipment_scrapes (above). The
// other things FPX reads from FreightPOP (ERP transactions, audit approvals,
// shipment details, captured shipment records) keep one row per entity that
// each read overwrites; fpx_scrape_history keeps what was overwritten: a row
// when an entity is first seen and a row each time a read changes a compared
// field. A read that changes nothing writes no row: the entity's own
// last_seen_at / captured_at is the time of its latest read.
// See migrations/2026-11-17_scrape_history.sql.

// Columns that say when or by whom a row was read, never what was read.
export const BOOKKEEPING_FIELDS = [
  "id", "created_at", "updated_at", "first_seen_at", "last_seen_at", "first_captured_at", "captured_at", "captured_by",
  "scraped_at", "scraped_by", "exported_changed_at", "last_pull_audit_id", "last_material_change_at", "audit_id",
  "data", "raw_data", "raw_text",
];

// Longest text kept for one side of a change.
export const HISTORY_TEXT_MAX = 500;

const NUMBER_RE = /^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
// "155.80", "$1,234.50" and 155.8 as numbers; null for anything else.
function asNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^\$/, "").replace(/,/g, "");
  return NUMBER_RE.test(t) ? Number(t) : null;
}

// JSON text with object keys in order, so { a, b } and { b, a } are one value
// (Postgres hands jsonb back with its own key order). Blank text and
// undefined count as null; numbers that are equal print the same.
function stableJson(v) {
  if (v === undefined || v === null) return "null";
  if (typeof v === "string") return v.trim() === "" ? "null" : JSON.stringify(v.trim());
  if (typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}

// The form two values are compared in. A number and text that reads as the
// same number are equal (155.8 and "155.80"); two texts are compared as text,
// so the ids "047" and "47" stay different.
function sameValue(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x === null || y === null) return x === y;
  if (typeof x === "number" || typeof y === "number") {
    const nx = asNumber(x);
    const ny = asNumber(y);
    if (nx !== null && ny !== null) return Math.abs(nx - ny) < 1e-9;
  }
  if (typeof x === "object" || typeof y === "object") return stableJson(x) === stableJson(y);
  return canon(x) === canon(y) || String(canon(x)) === String(canon(y));
}

// A value as it is kept in `changes`: blank → null, long text cut short.
function kept(v) {
  const n = normalize(v);
  if (n === null) return null;
  if (typeof n === "string") return n.length > HISTORY_TEXT_MAX ? `${n.slice(0, HISTORY_TEXT_MAX)}…` : n;
  if (typeof n === "object") {
    const json = stableJson(n);
    return json.length > HISTORY_TEXT_MAX * 4 ? `${json.slice(0, HISTORY_TEXT_MAX * 4)}…` : n;
  }
  return n;
}

// The fields of `after` that differ from `before`: { field: { from, to } },
// or null when none do. Pure.
//   fields  the only fields to compare (the business columns)
//   ignore  fields to leave out, on top of BOOKKEEPING_FIELDS (used when
//           `fields` is not given: then every field of `after` is compared)
// A field `after` does not carry is not compared: an upsert that does not
// send a column leaves the stored value alone. With no `before` (the first
// read) every non-blank compared field is reported with from: null.
export function diffRow(before, after, { fields, ignore } = {}) {
  if (!after || typeof after !== "object") return null;
  const skip = new Set([...BOOKKEEPING_FIELDS, ...(Array.isArray(ignore) ? ignore : [])]);
  const names = Array.isArray(fields) ? fields : Object.keys(after).filter((f) => !skip.has(f));
  const prev = before && typeof before === "object" ? before : null;
  const changes = {};
  for (const f of names) {
    if (!(f in after) || after[f] === undefined) continue;
    const from = prev ? prev[f] : null;
    if (sameValue(from, after[f])) continue;
    changes[f] = { from: kept(from), to: kept(after[f]) };
  }
  return Object.keys(changes).length ? changes : null;
}

const isoOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// The fpx_scrape_history items for rows that were just stored. Pure.
//   rows       the rows as stored (after)
//   beforeBy   Map of entity key → the row stored before this read
//   key        the row's key column, or (row) => entity key
//   fields / ignore   as diffRow
//   seenField  the row's "last read" column (last_seen_at, captured_at)
// A row seen before with nothing changed gives no item.
export function historyItems(rows, beforeBy, { key, fields, ignore, seenField = "last_seen_at" } = {}) {
  const keyOf = typeof key === "function" ? key : (r) => r?.[key];
  const had = beforeBy instanceof Map ? beforeBy : new Map();
  const items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = row ? keyOf(row) : null;
    if (k === null || k === undefined || k === "") continue;
    const before = had.get(String(k)) || null;
    const changes = diffRow(before, row, { fields, ignore });
    if (before && !changes) continue;
    items.push({
      entity_key: String(k),
      event: before ? "changed" : "first_seen",
      scraped_at: isoOrNull(row[seenField]) || new Date().toISOString(),
      previous_scraped_at: before ? isoOrNull(before[seenField]) : null,
      changes: changes || {},
    });
  }
  return items;
}

const HISTORY_CHUNK = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Appends items (from historyItems) to fpx_scrape_history, 500 at a time.
// meta: { request_id?: uuid of the read's job, run_by?: who handed it in }.
// NEVER throws and never rejects: a history failure must not fail the scrape
// that was just stored. Returns { recorded, failed }.
export async function recordScrapeHistory(db, source, items, meta = {}) {
  const out = { recorded: 0, failed: 0 };
  let list = [];
  try {
    list = (Array.isArray(items) ? items : []).filter((i) => i && i.entity_key && (i.event === "first_seen" || i.event === "changed"));
    if (!list.length || !source) return out;
    const request_id = UUID_RE.test(String(meta?.request_id || "")) ? String(meta.request_id) : null;
    const run_by = meta?.run_by ? String(meta.run_by).slice(0, 200) : null;
    const rows = list.map((i) => ({
      source: String(source),
      entity_key: String(i.entity_key).slice(0, 300),
      event: i.event,
      scraped_at: isoOrNull(i.scraped_at) || new Date().toISOString(),
      previous_scraped_at: isoOrNull(i.previous_scraped_at),
      changes: i.changes && typeof i.changes === "object" ? i.changes : {},
      request_id,
      run_by,
    }));
    for (let n = 0; n < rows.length; n += HISTORY_CHUNK) {
      const chunk = rows.slice(n, n + HISTORY_CHUNK);
      try {
        const { error } = await db.from("fpx_scrape_history").insert(chunk);
        if (error) { out.failed += chunk.length; out.error ??= String(error.message || error); } else out.recorded += chunk.length;
      } catch (e) {
        out.failed += chunk.length;
        out.error ??= String(e?.message || e);
      }
    }
  } catch (e) {
    out.failed = list.length - out.recorded;
    out.error ??= String(e?.message || e);
  }
  if (out.failed) console.warn(`[FPX] scrape history (${source}): ${out.failed} change(s) not recorded: ${out.error}`);
  return out;
}

// Rows of `table` whose `column` is one of `keys`, read ~200 keys at a time
// (they travel in the URL). Returns { rows } or { error }; never throws.
export async function readBefore(db, table, column, columns, keys, size = 200) {
  const rows = [];
  try {
    const list = [...new Set((keys || []).map((k) => String(k)))];
    for (let i = 0; i < list.length; i += size) {
      const { data, error } = await db.from(table).select(columns).in(column, list.slice(i, i + size));
      if (error) return { error: String(error.message || error) };
      rows.push(...(data || []));
    }
    return { rows };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
