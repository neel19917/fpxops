import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { mapShipment, mapShipmentsBulk } from "../lib/shipments.js";
import { callClaude } from "../lib/anthropic.js";

export const shipmentsRouter = Router();

// GET /shipments?limit=500&customer=Acme&action=YES&status=Issue&q=track123
// Reads from fpx_shipments_latest (view) — one row per tracking_number, most recent
// scrape. Base table fpx_shipments keeps the full history; hit /shipments/:id to see it.
shipmentsRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  let q = supabase.from("fpx_shipments_latest").select("*").order("scraped_at", { ascending: false }).limit(limit);
  if (req.query.customer) q = q.eq("customer_name", String(req.query.customer));
  if (req.query.action) q = q.eq("action_required", String(req.query.action));
  if (req.query.status) q = q.eq("shipment_status", String(req.query.status));
  if (req.query.q) {
    const s = String(req.query.q);
    q = q.or(`tracking_number.ilike.%${s}%,customer_name.ilike.%${s}%,carrier_name.ilike.%${s}%,ai_issue.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

shipmentsRouter.get("/:id", async (req, res) => {
  const { data: ship, error } = await supabase.from("fpx_shipments").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ship) return res.status(404).json({ error: "Shipment not found" });
  const [analysesRes, historyRes] = await Promise.all([
    supabase
      .from("fpx_ai_analyses").select("*")
      .or(`shipment_uuid.eq.${ship.id},tracking_number.eq.${ship.tracking_number || "__none__"}`)
      .order("created_at", { ascending: false }).limit(50),
    ship.tracking_number
      ? supabase.from("fpx_shipments").select("id, scraped_at, shipment_status, action_required, ai_issue")
          .eq("tracking_number", ship.tracking_number).neq("id", ship.id)
          .order("scraped_at", { ascending: false }).limit(20)
      : Promise.resolve({ data: [] }),
  ]);
  res.json({ shipment: ship, analyses: analysesRes.data || [], history: historyRes.data || [] });
});

// POST /shipments — single or bulk upsert keyed on tracking_number. Repeat
// scrapes update the existing row (seen_count auto-bumps via trigger) instead
// of growing the table. The x-fpx-user-name header (set by the extension popup)
// gets stamped as created_by on first insert; the trigger preserves it on
// subsequent upserts so task auto-assignment is stable.
// Body: { shipment: {...} } or { shipments: [...] }
shipmentsRouter.post("/", async (req, res) => {
  const runnerName = (req.header("x-fpx-user-name") || req.user?.email || req.apiKey?.name || "").trim() || null;
  const single = req.body.shipment;
  const bulk = req.body.shipments;
  if (single) {
    const mapped = mapShipment(single, runnerName);
    if (!mapped || !mapped.tracking_number) return res.status(400).json({ error: "tracking_number required" });
    const { data, error } = await supabase
      .from("fpx_shipments")
      .upsert(mapped, { onConflict: "tracking_number" })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ shipment: data });
  }
  if (Array.isArray(bulk)) {
    const mapped = mapShipmentsBulk(bulk, runnerName);
    if (!mapped.length) return res.json({ count: 0, ids: [] });
    const { data, error } = await supabase
      .from("fpx_shipments")
      .upsert(mapped, { onConflict: "tracking_number" })
      .select("id,tracking_number,seen_count,created_by");
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ count: data.length, ids: data.map((r) => r.id) });
  }
  res.status(400).json({ error: "Provide { shipment } or { shipments: [] }" });
});

// ----- Tasks scoped to a shipment -----

// GET /shipments/:id/tasks — list tasks for a shipment (newest first).
shipmentsRouter.get("/:id/tasks", async (req, res) => {
  const { data, error } = await supabase
    .from("fpx_shipment_tasks")
    .select("*")
    .eq("shipment_id", req.params.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// POST /shipments/:id/tasks — create a task. assigned_to defaults to the
// shipment's created_by (the runner who scraped it).
shipmentsRouter.post("/:id/tasks", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "title required" });
  const { data: ship, error: shipErr } = await supabase
    .from("fpx_shipments").select("id, tracking_number, created_by").eq("id", req.params.id).maybeSingle();
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  if (!ship) return res.status(404).json({ error: "Shipment not found" });
  const creatorName = req.user?.email || req.apiKey?.name || req.header("x-fpx-user-name") || null;
  const row = {
    shipment_id: ship.id,
    tracking_number: ship.tracking_number,
    title,
    description: req.body?.description ? String(req.body.description) : null,
    priority: ["low","normal","high","urgent"].includes(req.body?.priority) ? req.body.priority : "normal",
    status: "open",
    assigned_to: req.body?.assigned_to || ship.created_by || null,
    created_by: creatorName,
    due_at: req.body?.due_at || null,
  };
  const { data, error } = await supabase.from("fpx_shipment_tasks").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ task: data });
});

// POST /shipments/:id/email-draft  { audience: "carrier" | "customer", notes? }
// Returns { subject, body } generated by Claude using the shipment context.
shipmentsRouter.post("/:id/email-draft", async (req, res) => {
  const audience = req.body?.audience === "customer" ? "customer" : "carrier";
  const { data: ship, error } = await supabase
    .from("fpx_shipments").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ship) return res.status(404).json({ error: "Shipment not found" });

  const slim = {
    tracking_number: ship.tracking_number,
    carrier: ship.carrier_name || ship.carrier,
    customer: ship.customer_name,
    mode: ship.mode,
    status: ship.shipment_status,
    pickup_date: ship.pickup_date,
    eta: ship.updated_eta || ship.estimated_arrival,
    delivered: ship.delivery_date,
    pickup_response: ship.pickup_response,
    confirmation_number: ship.confirmation_number,
    pickup_request_number: ship.pickup_request_number,
    origin: ship.origin || ship.ship_from,
    destination: ship.destination || ship.ship_to,
    issue: ship.ai_issue,
    recommendation: ship.ai_recommendation,
    action_required: ship.action_required,
    notes: req.body?.notes || null,
  };

  const audienceCopy = audience === "carrier"
    ? "Write a concise, professional email FROM a freight broker TO the carrier. Ask for the specific information needed to resolve the issue or confirm status. Reference the carrier-side identifiers (PRO, pickup number)."
    : "Write a concise, professional email FROM a freight broker TO the end customer. Update them on shipment status in plain English; avoid carrier jargon. If action is required, state it clearly and reassure them you're on it.";

  const systemPrompt = `You are a freight brokerage operations assistant drafting emails. ${audienceCopy} Output strict JSON: {"subject": "...", "body": "..."}. Body should be plain text with line breaks ('\\n') — no markdown, no signature placeholder beyond "[Your name]".`;
  const userMessage = `Shipment context:\n${JSON.stringify(slim, null, 2)}\n\nWrite the email now. JSON only.`;

  const result = await callClaude({
    systemPrompt, userMessage, maxTokens: 700,
    metadata: { kind: "other", tracking_number: ship.tracking_number, shipment_uuid: ship.id, api_key_id: req.apiKey?.id, user_email: req.user?.email, metadata: { subkind: `email_draft_${audience}` } },
  });
  if (result.error) return res.status(500).json({ error: result.error });

  let parsed = null;
  try {
    const m = result.text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {}
  if (!parsed?.subject || !parsed?.body) {
    return res.json({ subject: "(draft)", body: result.text, raw: result.text });
  }
  res.json({ subject: parsed.subject, body: parsed.body });
});
