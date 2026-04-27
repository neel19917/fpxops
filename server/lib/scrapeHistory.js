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

function normalize(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  return v;
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
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[f] = { prev: a, next: b };
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
