import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { mapShipment, mapShipmentsBulk } from "../lib/shipments.js";
import { logAudit } from "../lib/audit.js";
import { generateEmailDraft } from "../lib/emailDraft.js";
import { getSettings } from "../lib/settings.js";
import { analyzeExistingShipment } from "./analyze.js";

export const shipmentsRouter = Router();

// Strip null AI fields from the upsert payload so re-scrapes from a
// scrape-only extension don't blow away analysis the server has already
// performed. mapShipment always emits these keys; if the scraper didn't fill
// them in, we want the existing DB values preserved by the upsert.
function preserveExistingAi(rows) {
  const aiFields = ["action_required", "ai_issue", "ai_recommendation", "action_target", "action_confidence"];
  for (const r of rows) {
    for (const f of aiFields) if (r[f] == null) delete r[f];
  }
}

// Per-shipment AI runs in the background after upsert returns, so the
// extension's POST is fast. Concurrency is capped to avoid hammering Claude
// for big bulk uploads. Skips rows already analyzed (action_required set) and
// rows the user manually overrode (action_source === 'manual'). Returns the
// updated rows so autoCreateActionTasks / autoDraftEmails can fan out from
// fresh analyses.
const AUTO_ANALYZE_CONCURRENCY = 4;
async function autoAnalyzeUpserted(req, upsertedIds) {
  if (!upsertedIds.length) return [];
  const { data: rows, error } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, action_required, action_source, action_target, raw_data, ai_issue, ai_recommendation, created_by")
    .in("id", upsertedIds);
  if (error) {
    console.warn("[FPX] auto-analyze fetch failed:", error.message);
    return [];
  }
  const candidates = (rows || []).filter(
    (r) => !r.action_required && r.action_source !== "manual"
  );
  if (!candidates.length) return [];

  const updated = [];
  for (let i = 0; i < candidates.length; i += AUTO_ANALYZE_CONCURRENCY) {
    const batch = candidates.slice(i, i + AUTO_ANALYZE_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((row) => analyzeExistingShipment(row, { reqContext: req }))
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) updated.push(s.value);
    }
  }
  return updated;
}

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

// Fire-and-forget: for each action-required shipment with a known target,
// generate one email draft addressed to that target. Drafts are persisted as
// fpx_ai_analyses rows with metadata.subkind=email_draft_<audience>, which is
// what the dashboard's Drafts sub-tab already reads. Skips shipments that
// already have a recent draft for the same audience.
async function autoDraftEmails(upsertedRows) {
  const { "action.auto_draft_enabled": enabled } = await getSettings("action.auto_draft_enabled");
  if (!enabled) return 0;

  const candidates = (upsertedRows || []).filter((s) => {
    if (String(s.action_required || "").toUpperCase() !== "YES") return false;
    const tgt = String(s.action_target || "").toLowerCase();
    return tgt === "customer" || tgt === "carrier";
  });
  if (!candidates.length) return 0;

  // Skip shipments that already have a draft for this audience in the last 24h
  // — auto-drafts shouldn't pile up on every re-scrape.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ids = candidates.map((s) => s.id);
  const { data: recent } = await supabase
    .from("fpx_ai_analyses")
    .select("shipment_uuid, metadata")
    .in("shipment_uuid", ids)
    .gte("created_at", since);
  const drafted = new Set();
  for (const r of recent || []) {
    const sub = r?.metadata?.subkind;
    if (typeof sub === "string" && sub.startsWith("email_draft_")) {
      drafted.add(`${r.shipment_uuid}::${sub.slice("email_draft_".length)}`);
    }
  }

  let count = 0;
  // Need the full shipment row for context; fetch in one query.
  const todo = candidates.filter((s) => !drafted.has(`${s.id}::${String(s.action_target).toLowerCase()}`));
  if (!todo.length) return 0;
  const { data: ships } = await supabase
    .from("fpx_shipments").select("*").in("id", todo.map((s) => s.id));
  for (const ship of ships || []) {
    const audience = String(ship.action_target || "").toLowerCase();
    if (audience !== "customer" && audience !== "carrier") continue;
    try {
      const draft = await generateEmailDraft({ ship, audience, callMeta: { metadata: { auto: true } } });
      if (!draft.error) count++;
    } catch (e) {
      console.warn("[FPX] auto email draft failed:", ship.tracking_number, e.message);
    }
  }
  return count;
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
    // Scrape-only extension uploads carry no AI fields. Preserve whatever the
    // server has already analyzed instead of overwriting with nulls.
    preserveExistingAi(mapped);
    const { data, error } = await supabase
      .from("fpx_shipments")
      .upsert(mapped, { onConflict: "tracking_number" })
      .select("id,tracking_number,seen_count,created_by,action_required,action_source,action_target,ai_issue,ai_recommendation");
    if (error) return res.status(500).json({ error: error.message });

    // Run analysis + downstream fan-out in the background so the extension's
    // POST returns fast. The audit log records the upsert immediately; task
    // creation + email drafts wait for AI to settle.
    const upsertedIds = data.map((r) => r.id);
    const backgroundWork = (async () => {
      const freshlyAnalyzed = await autoAnalyzeUpserted(req, upsertedIds);
      // For task creation we want the freshest snapshot of every upserted
      // row — newly analyzed rows fold in here, and rows that already had
      // action_required set use whatever the upsert returned.
      const byId = new Map(data.map((r) => [r.id, r]));
      for (const r of freshlyAnalyzed) byId.set(r.id, r);
      const settled = Array.from(byId.values());
      const tasks = await autoCreateActionTasks(req, settled);
      const drafts = await autoDraftEmails(settled);
      if (tasks || drafts) console.log(`[FPX] post-upload: ${tasks} task(s), ${drafts} draft(s)`);
    })().catch((e) => console.warn("[FPX] post-upload background failed:", e.message));

    logAudit(req, {
      action: "bulk_create",
      entity_type: "shipment",
      summary: `Upserted ${data.length} shipments`,
      metadata: { count: data.length, runner: runnerName },
    });
    // Don't await background — let it drain.
    void backgroundWork;
    return res.json({ count: data.length, ids: upsertedIds });
  }
  res.status(400).json({ error: "Provide { shipment } or { shipments: [] }" });
});

// POST /shipments/:id/reanalyze — manual trigger from the dashboard. Runs
// per-shipment AI again (regardless of last_analyzed_at), updates the row,
// and returns the fresh shipment + a one-row analysis result. Manual
// overrides are still preserved by analyzeExistingShipment.
shipmentsRouter.post("/:id/reanalyze", async (req, res) => {
  const { data: row, error } = await supabase
    .from("fpx_shipments").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: "Shipment not found" });
  const updated = await analyzeExistingShipment(row, { reqContext: req });
  logAudit(req, {
    action: "reanalyze",
    entity_type: "shipment",
    entity_id: row.id,
    summary: `Re-analyzed ${row.tracking_number || row.id}`,
    before: { action_required: row.action_required, ai_issue: row.ai_issue },
    after:  { action_required: updated?.action_required, ai_issue: updated?.ai_issue },
  });
  res.json({ shipment: updated || row });
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

  const result = await generateEmailDraft({
    ship,
    audience,
    notes: req.body?.notes,
    callMeta: { api_key_id: req.apiKey?.id, user_email: req.user?.email },
  });
  if (result.error) return res.status(500).json({ error: result.error });
  res.json(result);
});
