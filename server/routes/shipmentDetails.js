import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";
import { parseShipmentDetail, describeDetail } from "../lib/shipmentDetail.js";
import { SHIPMENT_DETAILS_SCOPE } from "./ops.js";

// Shipment details read from FreightPOP's own Shipment Details page by the
// hosted browser's read-only details job (browser-service/src/details.js),
// kept in fpx_shipment_details, one row per shipment. The tracking dashboard
// shows them and can ask for a fresh read.

export const shipmentDetailsRouter = Router();

// Everything the dashboard shows. raw_text and data stay in the table.
const COLUMNS = [
  "shipment_id", "quote_id", "carrier", "account_nickname", "tracking_number", "vendor_name", "service", "payer", "confirmation",
  "ship_from", "ship_to", "pickup_date", "delivery_date", "ready_time", "cutoff_time",
  "quantity", "package_type", "dimension", "weight_per_piece", "freight_class", "nmfc", "description", "so_number", "po_number",
  "total_units", "total_weight", "linear_feet", "shipment_quote", "quote_number", "sale", "cost", "gross_profit",
  "quote_freight", "quote_fuel", "quote_accessorial_total", "quote_total", "quote_accessorials", "captured_at", "captured_by",
].join(", ");

const isShipmentId = (v) => /^\d{1,15}$/.test(String(v ?? ""));

// FreightPOP's quote id for a shipment: its Shipment Details page opens by it.
// The tracking scrape keeps it (raw_data.QuotesId); so do the History Report
// rows and any earlier read.
async function quoteIdFor(shipmentId) {
  const tries = [
    () => supabase.from("fpx_shipments").select("q:raw_data->>QuotesId").eq("shipment_id", shipmentId).order("updated_at", { ascending: false }).limit(1),
    () => supabase.from("fpx_shipment_details").select("q:quote_id").eq("shipment_id", shipmentId).limit(1),
    () => supabase.from("fpx_erp_transactions").select("q:data->>QuoteID").eq("shipment_id", shipmentId).limit(1),
  ];
  for (const run of tries) {
    try {
      const { data } = await run();
      const q = String(data?.[0]?.q ?? "").trim();
      if (/^\d+$/.test(q) && q !== "0") return q;
    } catch { /* next source */ }
  }
  return null;
}

async function latestJob(shipmentId) {
  const { data } = await supabase
    .from("fpx_scrape_requests").select("id, status, requested_at, completed_at, note")
    .eq("scope", SHIPMENT_DETAILS_SCOPE).contains("tracking_numbers", [shipmentId])
    .order("requested_at", { ascending: false }).limit(1);
  const job = data?.[0] || null;
  // While it waits, the note holds the job's own instructions, not a message.
  return job ? { ...job, note: job.status === "done" || job.status === "error" ? job.note : null } : null;
}

// POST /shipment-details — the hosted browser hands in what it read.
// Body: { by?, records: [{ shipment_id, quote_id?, text, inputs?, quote_text?, url? }] } (at most 25).
// Text that is not that shipment's Shipment Details page is refused, not stored.
// Responds { stored, failed, summary: [one line per stored shipment], error? }.
shipmentDetailsRouter.post("/", async (req, res) => {
  const list = Array.isArray(req.body?.records) ? req.body.records.slice(0, 25) : null;
  if (!list) return res.status(400).json({ error: "body.records must be a list" });
  const by = String(req.body?.by || req.user?.email || req.apiKey?.name || "").trim() || null;
  const now = new Date().toISOString();
  const rows = [];
  let refused = 0;
  for (const r of list) {
    const row = parseShipmentDetail(r);
    if (row) rows.push({ ...row, captured_at: now, captured_by: by });
    else refused++;
  }
  if (!rows.length) return res.json({ stored: 0, failed: refused, summary: [], error: refused ? "The text was not that shipment's Shipment Details page" : undefined });
  const { error } = await supabase.from("fpx_shipment_details").upsert(rows, { onConflict: "shipment_id" });
  if (error) {
    console.warn(`[FPX] shipment details not stored: ${error.message}`);
    return res.json({ stored: 0, failed: list.length, summary: [], error: error.message });
  }
  res.json({ stored: rows.length, failed: refused, summary: rows.map(describeDetail) });
});

// GET /shipment-details/:shipmentId — the stored details of one shipment, the
// latest read request for it, and whether a read can be asked for.
// Responds { details | null, job | null, can_refresh, reason? }.
shipmentDetailsRouter.get("/:shipmentId", async (req, res) => {
  const id = String(req.params.shipmentId);
  if (!isShipmentId(id)) return res.status(400).json({ error: "shipment id must be a number" });
  const [{ data, error }, job, quoteId] = await Promise.all([
    supabase.from("fpx_shipment_details").select(COLUMNS).eq("shipment_id", id).maybeSingle(),
    latestJob(id).catch(() => null),
    quoteIdFor(id),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    details: data || null,
    job,
    can_refresh: !!quoteId,
    reason: quoteId ? null : "FPX does not know this shipment's FreightPOP quote id yet. It is picked up the next time the shipment is scraped.",
  });
});

// POST /shipment-details/:shipmentId/refresh — ask the hosted browser to read
// this shipment's details again. It runs as the person asking, with their
// FreightPOP login. A request already waiting or running is returned as is.
// Responds { request: { id, status } }.
shipmentDetailsRouter.post("/:shipmentId/refresh", async (req, res) => {
  const id = String(req.params.shipmentId);
  if (!isShipmentId(id)) return res.status(400).json({ error: "shipment id must be a number" });
  const who = req.user?.email || null;
  if (!who) return res.status(403).json({ error: "Sign in to the dashboard to read from FreightPOP: the read uses your FreightPOP login" });
  const quoteId = await quoteIdFor(id);
  if (!quoteId) return res.status(409).json({ error: "FPX does not know this shipment's FreightPOP quote id yet" });
  const { data: open } = await supabase
    .from("fpx_scrape_requests").select("id, status")
    .eq("scope", SHIPMENT_DETAILS_SCOPE).in("status", ["pending", "claimed"]).contains("tracking_numbers", [id])
    .order("requested_at", { ascending: false }).limit(1);
  if (open?.[0]) return res.json({ request: open[0], coalesced: true });
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .insert({ scope: SHIPMENT_DETAILS_SCOPE, tracking_numbers: [id], note: `q=${id}:${quoteId}`, requested_by: who })
    .select("id, status").single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "rescrape_request", entity_type: "scrape_request", entity_id: data.id,
    summary: `Asked for shipment ${id}'s details to be read from FreightPOP`,
    metadata: { scope: SHIPMENT_DETAILS_SCOPE, shipment_id: id, quote_id: quoteId },
  });
  res.json({ request: data });
});
