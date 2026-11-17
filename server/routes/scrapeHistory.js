import { Router } from "express";
import { supabase } from "../lib/supabase.js";

// When FPX read things from FreightPOP, and what each read changed.
//   fpx_scrape_history     first sightings and changed fields of ERP
//                          transactions, audit approvals, shipment details and
//                          captured shipment records (lib/scrapeHistory.js)
//   fpx_shipment_scrapes   every scrape of the tracking grid, with its diff
// Both are shown here in one shape. Read-only.

export const scrapeHistoryRouter = Router();

// source → the table that holds the entity, its key column, and its "last
// read" / "first read" columns.
const SOURCES = {
  erp_transactions: { table: "fpx_erp_transactions", key: "shipment_id", last: "last_seen_at", first: "first_seen_at" },
  audit_approvals: { table: "fpx_audit_approvals", key: "approval_key", last: "last_seen_at", first: "first_seen_at" },
  shipment_details: { table: "fpx_shipment_details", key: "shipment_id", last: "captured_at", first: "first_captured_at" },
  shipment_record: { table: "fpx_shipment_records", key: "shipment_id", last: "captured_at", first: "first_captured_at" },
  tracking: { table: "fpx_shipments", key: "tracking_number", last: "scraped_at", first: null },
};
export const SCRAPE_HISTORY_SOURCES = Object.keys(SOURCES);

const RECORD_KINDS = ["view_shipment", "invoice"];
const COLUMNS = "id, source, entity_key, event, scraped_at, previous_scraped_at, changes, request_id, run_by";

const clampLimit = (v) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100;
};
// An ISO time, null when not given, undefined when given but not a time.
const timeParam = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

// A tracking scrape's diff ({ field: { prev, next } }) in this route's shape.
export function trackingChanges(diff) {
  const out = {};
  if (!diff || typeof diff !== "object") return out;
  for (const [field, c] of Object.entries(diff)) {
    if (c && typeof c === "object") out[field] = { from: c.prev ?? c.from ?? null, to: c.next ?? c.to ?? null };
  }
  return out;
}

// Changes of the tracking grid: the scrapes that found a material change.
async function trackingEvents({ key, since, limit }) {
  let q = supabase
    .from("fpx_shipment_scrapes")
    .select("id, tracking_number, scraped_at, scraped_by, diff")
    .eq("material_change", true);
  if (key) q = q.eq("tracking_number", key);
  if (since) q = q.gte("scraped_at", since);
  const { data, error } = await q.order("scraped_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    id: r.id, source: "tracking", entity_key: r.tracking_number, event: "changed",
    scraped_at: r.scraped_at, previous_scraped_at: null, changes: trackingChanges(r.diff),
    request_id: null, run_by: r.scraped_by || null,
  }));
}

async function historyEvents({ source, key, since, limit }) {
  let q = supabase.from("fpx_scrape_history").select(COLUMNS);
  if (source) q = q.eq("source", source);
  if (key) {
    // A captured record is keyed "shipment id|kind"; a bare shipment id asks for every kind.
    if (source === "shipment_record" && !key.includes("|")) q = q.in("entity_key", RECORD_KINDS.map((k) => `${key}|${k}`));
    else q = q.eq("entity_key", key);
  }
  if (since) q = q.gte("scraped_at", since);
  const { data, error } = await q.order("scraped_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

// When one entity was last and first read, from its own table.
// → { last_read_at, first_seen_at } (null when FPX has never stored it).
async function entityTimes(source, key) {
  const s = SOURCES[source];
  if (source === "tracking") {
    const [now, first] = await Promise.all([
      supabase.from("fpx_shipments").select("scraped_at").eq("tracking_number", key).order("scraped_at", { ascending: false }).limit(1),
      supabase.from("fpx_shipment_scrapes").select("scraped_at").eq("tracking_number", key).order("scraped_at", { ascending: true }).limit(1),
    ]);
    if (now.error) throw new Error(now.error.message);
    return { last_read_at: now.data?.[0]?.scraped_at || null, first_seen_at: first.data?.[0]?.scraped_at || null };
  }
  let q = supabase.from(s.table).select(`${s.last}, ${s.first}`);
  if (source === "shipment_record" && key.includes("|")) {
    const cut = key.lastIndexOf("|");
    q = q.eq("shipment_id", key.slice(0, cut)).eq("kind", key.slice(cut + 1));
  } else q = q.eq(s.key, key);
  const { data, error } = await q.limit(10);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) return { last_read_at: null, first_seen_at: null };
  return {
    last_read_at: rows.map((r) => r[s.last]).filter(Boolean).sort().pop() || null,
    first_seen_at: rows.map((r) => r[s.first]).filter(Boolean).sort()[0] || null,
  };
}

// GET /scrape-history?source=&key=&since=&limit=
//   source  erp_transactions | audit_approvals | shipment_details |
//           shipment_record | tracking. Needed with `key`; left out, the recent
//           changes of every source but tracking are listed.
//   key     the entity: a shipment id (erp_transactions, shipment_details,
//           shipment_record, or "shipment id|kind" for one kind), an approval
//           key (audit_approvals), a tracking number (tracking).
//   since   only reads at or after this time (ISO).
//   limit   at most this many, newest first (100; 500 at most).
// Responds { source, key, last_read_at, first_seen_at, events: [{ id, source,
// entity_key, event: "first_seen" | "changed", scraped_at,
// previous_scraped_at, changes: { field: { from, to } }, request_id, run_by }] }.
// last_read_at / first_seen_at come from the entity's own row and are null
// without `key`, or when FPX has not stored that entity.
scrapeHistoryRouter.get("/", async (req, res) => {
  const source = String(req.query.source || "").trim() || null;
  const key = String(req.query.key || "").trim() || null;
  if (source && !SOURCES[source]) return res.status(400).json({ error: `source must be one of: ${SCRAPE_HISTORY_SOURCES.join(", ")}` });
  if (key && !source) return res.status(400).json({ error: "key needs a source" });
  const since = timeParam(req.query.since);
  if (since === undefined) return res.status(400).json({ error: "since must be a time" });
  const limit = clampLimit(req.query.limit);
  try {
    const [events, times] = await Promise.all([
      source === "tracking" ? trackingEvents({ key, since, limit }) : historyEvents({ source, key, since, limit }),
      key ? entityTimes(source, key) : Promise.resolve({ last_read_at: null, first_seen_at: null }),
    ]);
    res.json({ source, key, ...times, events });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

async function count(query) {
  const { count: n, error } = await query;
  if (error) throw new Error(error.message);
  return n ?? 0;
}

// GET /scrape-history/summary — per source: when FPX last read anything of it
// (from the entity tables), and how many reads found a change in the last 24
// hours and 7 days.
// Responds { as_of, sources: [{ source, last_read_at, changes_24h, changes_7d,
// error? }] }. A source whose numbers could not be read carries `error` and
// nulls; the others are still answered.
scrapeHistoryRouter.get("/summary", async (_req, res) => {
  const now = Date.now();
  const day = new Date(now - 24 * 3_600_000).toISOString();
  const week = new Date(now - 7 * 24 * 3_600_000).toISOString();
  const changed = (source, since) => (source === "tracking"
    ? supabase.from("fpx_shipment_scrapes").select("id", { count: "exact", head: true }).eq("material_change", true).gte("scraped_at", since)
    : supabase.from("fpx_scrape_history").select("id", { count: "exact", head: true }).eq("source", source).eq("event", "changed").gte("scraped_at", since));
  const sources = await Promise.all(SCRAPE_HISTORY_SOURCES.map(async (source) => {
    const s = SOURCES[source];
    try {
      const [last, changes_24h, changes_7d] = await Promise.all([
        supabase.from(s.table).select(s.last).not(s.last, "is", null).order(s.last, { ascending: false }).limit(1),
        count(changed(source, day)),
        count(changed(source, week)),
      ]);
      if (last.error) throw new Error(last.error.message);
      return { source, last_read_at: last.data?.[0]?.[s.last] || null, changes_24h, changes_7d };
    } catch (e) {
      return { source, last_read_at: null, changes_24h: null, changes_7d: null, error: String(e?.message || e) };
    }
  }));
  res.json({ as_of: new Date(now).toISOString(), sources });
});
