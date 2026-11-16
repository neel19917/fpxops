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
// With it go the two figures FreightPOP's own grid hands that page: the sale
// (the grid's RateWithOutMarkedUp, despite its name) and the cost. The page
// shows the cost it is handed; it does not look one up.
// → { quote, sale, cost } (sale / cost null when not known), or null.
async function quoteFor(shipmentId) {
  const tries = [
    () => supabase.from("fpx_shipments").select("q:raw_data->>QuotesId, spot:raw_data->>BrokerSpotQuoteId, sale:raw_data->>RateWithOutMarkedUp, cost:raw_data->>cost").eq("shipment_id", shipmentId).order("updated_at", { ascending: false }).limit(1),
    () => supabase.from("fpx_erp_transactions").select("q:data->>QuoteID, sale:data->>Shipment Marked-Up Rate, cost:data->>Shipment Rate without mark up").eq("shipment_id", shipmentId).limit(1),
    () => supabase.from("fpx_shipment_details").select("q:quote_id, sale, cost").eq("shipment_id", shipmentId).limit(1),
  ];
  const num = (v) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null; };
  for (const run of tries) {
    try {
      const { data } = await run();
      const picked = data?.[0] ? pickQuote(data[0].q, data[0].spot) : null;
      if (picked) return { ...picked, sale: num(data[0].sale), cost: num(data[0].cost) };
    } catch { /* next source */ }
  }
  return null;
}
const quoteIdFor = async (shipmentId) => (await quoteFor(shipmentId))?.quote ?? null;

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

// Every shipment on the tracking dashboard now (not archived), one entry per
// shipment id, with what FreightPOP's grid hands the Shipment Details page.
// "Now" = seen by the latest scrape (or within 6 hours before it): older rows
// that were never archived are no longer in FreightPOP's grid.
async function trackedShipments() {
  const out = new Map();
  const { data: newest, error: e0 } = await supabase
    .from("fpx_shipments").select("scraped_at").is("archived_at", null).not("scraped_at", "is", null)
    .order("scraped_at", { ascending: false }).limit(1);
  if (e0) throw new Error(e0.message);
  if (!newest?.[0]?.scraped_at) return out;
  const since = new Date(new Date(newest[0].scraped_at).getTime() - 6 * 3_600_000).toISOString();
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase
      .from("fpx_shipments")
      .select("shipment_id, customer_name, company_name, q:raw_data->>QuotesId, spot:raw_data->>BrokerSpotQuoteId, sale:raw_data->>RateWithOutMarkedUp, cost:raw_data->>cost")
      .is("archived_at", null).not("shipment_id", "is", null).gte("scraped_at", since)
      .order("scraped_at", { ascending: false }).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      const id = String(r.shipment_id || "").trim();
      if (isShipmentId(id) && !out.has(id)) out.set(id, r);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}
const money = (v) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null; };

// Which quote id opens a shipment's page. A broker spot quote (truckload,
// mostly) is opened by its spot quote id, exactly as FreightPOP's grid does
// (Dashboard.js: "if (BrokerSpotQuoteId > 0) scope = BrokerSpotQuoteId"): that
// page carries the sale to the customer. The shipment's own quote id is kept
// as a second try. → { quote, alt_quote } or null.
function pickQuote(quotesId, spotId) {
  const ok = (v) => { const t = String(v ?? "").trim(); return /^\d+$/.test(t) && t !== "0" ? t : null; };
  const own = ok(quotesId);
  const spot = ok(spotId);
  if (spot) return { quote: spot, alt_quote: own && own !== spot ? own : null };
  return own ? { quote: own, alt_quote: null } : null;
}

// GET /shipment-details/sweep-list — for the hosted browser: every tracked
// shipment that has a FreightPOP quote id, with the sale and cost to open its
// page with. Responds { shipments: [{ shipment_id, quote, sale, cost }], skipped }.
shipmentDetailsRouter.get("/sweep-list", async (_req, res) => {
  try {
    const tracked = await trackedShipments();
    const shipments = [];
    let skipped = 0;
    for (const [id, r] of tracked) {
      const picked = pickQuote(r.q, r.spot);
      if (!picked) { skipped++; continue; }
      shipments.push({ shipment_id: id, ...picked, sale: money(r.sale), cost: money(r.cost) });
    }
    res.json({ shipments, skipped });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// POST /shipment-details/sweep — ask the hosted browser to read the details
// of every tracked shipment. Runs as the person asking. A sweep already
// waiting or running is returned as is. Responds { request: { id, status } }.
shipmentDetailsRouter.post("/sweep", async (req, res) => {
  const who = req.user?.email || null;
  if (!who) return res.status(403).json({ error: "Sign in to the dashboard to read from FreightPOP: the read uses your FreightPOP login" });
  const { data: open } = await supabase
    .from("fpx_scrape_requests").select("id, status, note")
    .eq("scope", SHIPMENT_DETAILS_SCOPE).in("status", ["pending", "claimed"])
    .order("requested_at", { ascending: false }).limit(20);
  const running = (open || []).find((r) => /(?:^|;)\s*all=1\b/.test(String(r.note || "")));
  if (running) return res.json({ request: { id: running.id, status: running.status }, coalesced: true });
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .insert({ scope: SHIPMENT_DETAILS_SCOPE, note: "all=1", requested_by: who })
    .select("id, status").single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "rescrape_request", entity_type: "scrape_request", entity_id: data.id,
    summary: "Asked for every tracked shipment's details to be read from FreightPOP",
    metadata: { scope: SHIPMENT_DETAILS_SCOPE, sweep: true },
  });
  res.json({ request: data });
});

// GET /shipment-details — what is stored for the shipments on the tracking
// dashboard now. Responds { tracked, read, totals: { sale, cost, gross_profit },
// rows: [{ shipment_id, customer, carrier, tracking_number, sale, cost,
// gross_profit, quote_freight, quote_fuel, quote_accessorial_total,
// quote_total, captured_at }] }, newest read first.
shipmentDetailsRouter.get("/", async (_req, res) => {
  try {
    const tracked = await trackedShipments();
    const ids = [...tracked.keys()];
    const rows = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase
        .from("fpx_shipment_details")
        .select("shipment_id, carrier, tracking_number, sale, cost, gross_profit, quote_freight, quote_fuel, quote_accessorial_total, quote_total, captured_at")
        .in("shipment_id", ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const d of data || []) rows.push({ ...d, customer: tracked.get(d.shipment_id)?.customer_name || tracked.get(d.shipment_id)?.company_name || null });
    }
    rows.sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
    const sum = (k) => Math.round(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0) * 100) / 100;
    res.json({ tracked: ids.length, read: rows.length, totals: { sale: sum("sale"), cost: sum("cost"), gross_profit: sum("gross_profit") }, rows });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
  const found = await quoteFor(id);
  if (!found) return res.status(409).json({ error: "FPX does not know this shipment's FreightPOP quote id yet" });
  const quoteId = found.quote;
  const { data: open } = await supabase
    .from("fpx_scrape_requests").select("id, status")
    .eq("scope", SHIPMENT_DETAILS_SCOPE).in("status", ["pending", "claimed"]).contains("tracking_numbers", [id])
    .order("requested_at", { ascending: false }).limit(1);
  if (open?.[0]) return res.json({ request: open[0], coalesced: true });
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .insert({ scope: SHIPMENT_DETAILS_SCOPE, tracking_numbers: [id], note: `q=${id}:${quoteId}:${found.cost != null ? `${found.sale ?? ""}:${found.cost}` : ":"}${found.alt_quote ? `:${found.alt_quote}` : ""}`, requested_by: who })
    .select("id, status").single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "rescrape_request", entity_type: "scrape_request", entity_id: data.id,
    summary: `Asked for shipment ${id}'s details to be read from FreightPOP`,
    metadata: { scope: SHIPMENT_DETAILS_SCOPE, shipment_id: id, quote_id: quoteId },
  });
  res.json({ request: data });
});
