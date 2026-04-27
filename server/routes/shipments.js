import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { mapShipment, mapShipmentsBulk } from "../lib/shipments.js";
import { callClaude } from "../lib/anthropic.js";
import { logAudit } from "../lib/audit.js";

export const shipmentsRouter = Router();

// After an upsert batch, look at the newly-flagged action-needed shipments and
// create one open task per shipment that doesn't already have one. The task
// title comes from the AI recommendation (or issue) so the broker sees what
// to do without clicking in. Returns the count created.
async function autoCreateActionTasks(req, upsertedRows) {
  const candidates = (upsertedRows || []).filter(
    (s) => String(s.action_required || "").toUpperCase() === "YES"
  );
  if (!candidates.length) return 0;
  const ids = candidates.map((s) => s.id);
  // Find which of these already have an open task; skip those.
  const { data: existing } = await supabase
    .from("fpx_shipment_tasks")
    .select("shipment_id")
    .in("shipment_id", ids)
    .in("status", ["open", "in_progress"]);
  const taken = new Set((existing || []).map((r) => r.shipment_id));
  const toCreate = candidates.filter((s) => !taken.has(s.id));
  if (!toCreate.length) return 0;

  const rows = toCreate.map((s) => {
    const reasonLine = s.ai_recommendation
      ? String(s.ai_recommendation).split(/[.!?]\s/)[0].slice(0, 140)
      : (s.ai_issue ? String(s.ai_issue).slice(0, 140) : "Action needed on this shipment");
    return {
      shipment_id: s.id,
      tracking_number: s.tracking_number,
      title: reasonLine,
      description: [s.ai_issue, s.ai_recommendation].filter(Boolean).join("\n\n"),
      status: "open",
      priority: "high",
      assigned_to: s.created_by || null,
      created_by: "system (auto-flag)",
    };
  });
  const { data, error } = await supabase
    .from("fpx_shipment_tasks").insert(rows).select("id, shipment_id, tracking_number, title");
  if (error) {
    console.warn("[FPX] auto-task insert failed:", error.message);
    return 0;
  }
  // Audit each auto-created task.
  for (const t of data || []) {
    logAudit(req, {
      action: "auto_task",
      entity_type: "task",
      entity_id: t.id,
      summary: `Auto-created task for action-needed shipment ${t.tracking_number}: ${t.title}`,
      after: t,
      metadata: { reason: "action_required=YES" },
    });
  }
  return (data || []).length;
}

// GET /shipments?limit=500&customer=Acme&action=YES&status=Issue&q=track123&source=ai|manual
// Reads from fpx_shipments_latest (view) — one row per tracking_number, most recent
// scrape. Base table fpx_shipments keeps the full history; hit /shipments/:id to see it.
shipmentsRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  let q = supabase.from("fpx_shipments_latest").select("*").order("scraped_at", { ascending: false }).limit(limit);
  if (req.query.customer) q = q.eq("customer_name", String(req.query.customer));
  if (req.query.action) q = q.eq("action_required", String(req.query.action));
  if (req.query.source && ["ai", "manual", "none"].includes(String(req.query.source))) {
    q = q.eq("action_source", String(req.query.source));
  }
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
      .select("id,tracking_number,seen_count,created_by,action_required,ai_issue,ai_recommendation");
    if (error) return res.status(500).json({ error: error.message });
    const autoTaskCount = await autoCreateActionTasks(req, data || []);
    logAudit(req, {
      action: "bulk_create",
      entity_type: "shipment",
      summary: `Upserted ${data.length} shipments` + (autoTaskCount ? ` (${autoTaskCount} auto-tasks)` : ""),
      metadata: { count: data.length, runner: runnerName, auto_tasks: autoTaskCount },
    });
    return res.json({ count: data.length, ids: data.map((r) => r.id), auto_tasks: autoTaskCount });
  }
  res.status(400).json({ error: "Provide { shipment } or { shipments: [] }" });
});

// PATCH /shipments/:id/action  { action_required, reason? }
// Manually override the AI's action_required value. Pins action_source='manual'
// so subsequent scrapes don't reset it (enforced by the bump-seen trigger).
// Pass null/empty to clear the override.
shipmentsRouter.patch("/:id/action", async (req, res) => {
  const value = req.body?.action_required;
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
  const overrideName = req.user?.email || req.apiKey?.name || req.header("x-fpx-user-name") || "unknown";

  // Pre-fetch for audit `before` snapshot.
  const { data: before } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, action_required, action_source, action_overridden_by")
    .eq("id", req.params.id).maybeSingle();
  if (!before) return res.status(404).json({ error: "Shipment not found" });

  const patch = value == null
    ? {
        action_source: "ai",
        action_overridden_by: null,
        action_overridden_at: null,
        action_override_reason: null,
      }
    : {
        action_required: String(value),
        action_source: "manual",
        action_overridden_by: overrideName,
        action_overridden_at: new Date().toISOString(),
        action_override_reason: reason,
      };

  const { data, error } = await supabase
    .from("fpx_shipments")
    .update(patch)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  logAudit(req, {
    action: "override",
    entity_type: "shipment",
    entity_id: data.id,
    summary: value == null
      ? `Cleared manual override on ${data.tracking_number}`
      : `Set ${data.tracking_number} action to ${String(value).toUpperCase()} (manual)` + (reason ? ` — ${reason}` : ""),
    before: { action_required: before.action_required, action_source: before.action_source },
    after:  { action_required: data.action_required,   action_source: data.action_source },
    metadata: { reason },
  });

  res.json({ shipment: data });
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
    ? "Write a concise, professional email FROM the FPX brokerage operations team TO the carrier handling this shipment. Ask for the specific information needed to resolve the issue or confirm status. Reference carrier-side identifiers (PRO, pickup number, carrier-issued tracking)."
    : "Write a concise, professional email FROM the FPX brokerage account team TO the end customer (the shipper or consignee, not the carrier). Update them on shipment status in plain English; avoid carrier jargon. If action is required from the customer, state it clearly. Otherwise reassure them FPX is monitoring and following up directly with the carrier.";

  const systemPrompt = `You are a freight brokerage operations assistant at FPX. FPX is the freight broker — not the carrier and not the customer. You always write FROM FPX. Drafting an email now. ${audienceCopy} Output strict JSON: {"subject": "...", "body": "..."}. Body should be plain text with line breaks ('\\n') — no markdown. Sign as "[Your name]\\nFPX Operations" (do not invent a name).`;
  const userMessage = `Shipment context (you, FPX, are the broker for this shipment):\n${JSON.stringify(slim, null, 2)}\n\nWrite the email now. JSON only, no preamble.`;

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
