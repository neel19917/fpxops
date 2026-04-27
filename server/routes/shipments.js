import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { mapShipment, mapShipmentsBulk } from "../lib/shipments.js";
import { logAudit } from "../lib/audit.js";
import { generateEmailDraft } from "../lib/emailDraft.js";
import { getSettings } from "../lib/settings.js";
import { analyzeExistingShipment } from "./analyze.js";
import { MATERIAL_FIELDS, computeMaterialDiff, recordScrapeBatch } from "../lib/scrapeHistory.js";

export const shipmentsRouter = Router();

// Columns selected by the list endpoint. Excludes raw_data (multi-KB JSON blob
// per row, never rendered on the list) and other drawer-only fields. Cuts the
// list-view payload roughly 10-50x at scale; the drawer (`/shipments/:id`)
// still returns full rows.
const LIST_COLUMNS = [
  "id", "scraped_at",
  "tracking_number", "shipment_id", "order_number",
  "customer_name", "customer_id", "company_name",
  "account_manager", "created_by", "seen_count",
  "carrier", "carrier_name", "mode", "service",
  "shipment_status", "action_required", "action_source",
  "ai_issue", "ai_recommendation",
  "ship_from", "ship_to",
  "shipment_date", "pickup_date", "updated_eta", "original_eta", "delivery_date",
  "appointment_set", "appointment_date", "required_arrival_date",
  "ready_time", "cut_off_time",
  "shipper_spot_quote", "spot_quote_fulfilled_by", "pickup_tendered",
  "tracking_comments", "updated_via", "last_modified_at",
  "signed_by",
  "shipment_marked_up_rate", "shipment_rate_without_markup", "shipment_gross_profit",
  "reference_one", "reference_two", "reference_three",
  "reference_four", "reference_five", "reference_six",
].join(", ");

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

// Decide which upserted shipments deserve a (re)analysis pass:
//   - never analyzed yet (no action_required)               → analyze
//   - manually overridden                                   → skip (always)
//   - material data changed since last scrape               → re-analyze
//   - already analyzed and no new info                      → skip
// `materialChangedIds` is a Set of fpx_shipments.id that had a non-null diff
// from the prior scrape. The bulk POST flow builds it before calling this.
async function autoAnalyzeUpserted(req, upsertedIds, { materialChangedIds = new Set() } = {}) {
  if (!upsertedIds.length) return [];
  const { data: rows, error } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, action_required, action_source, action_target, raw_data, ai_issue, ai_recommendation, created_by")
    .in("id", upsertedIds);
  if (error) {
    console.warn("[FPX] auto-analyze fetch failed:", error.message);
    return [];
  }
  const candidates = (rows || []).filter((r) => {
    if (r.action_source === "manual") return false;
    if (!r.action_required) return true;
    if (materialChangedIds.has(r.id)) return true;
    return false;
  });
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
  let q = supabase.from("fpx_shipments_latest").select(LIST_COLUMNS).order("scraped_at", { ascending: false }).limit(limit);
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
  const [analysesRes, historyRes, tasksRes] = await Promise.all([
    supabase
      .from("fpx_ai_analyses").select("*")
      .or(`shipment_uuid.eq.${ship.id},tracking_number.eq.${ship.tracking_number || "__none__"}`)
      .order("created_at", { ascending: false }).limit(50),
    ship.tracking_number
      ? supabase.from("fpx_shipments").select("id, scraped_at, shipment_status, action_required, ai_issue")
          .eq("tracking_number", ship.tracking_number).neq("id", ship.id)
          .order("scraped_at", { ascending: false }).limit(20)
      : Promise.resolve({ data: [] }),
    supabase.from("fpx_shipment_tasks").select("*").eq("shipment_id", ship.id).order("created_at", { ascending: false }),
  ]);
  res.json({
    shipment: ship,
    analyses: analysesRes.data || [],
    history: historyRes.data || [],
    tasks: tasksRes.data || [],
  });
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

    // ---- Scrape history ------------------------------------------------
    // Pull the prior snapshot for every tracking_number so we can compute a
    // material-field diff before the upsert clobbers the row. Only the
    // fields we compare on are pulled — keeps the query small.
    const trackingNumbers = mapped.map((m) => m.tracking_number).filter(Boolean);
    const priorByTracking = new Map();
    if (trackingNumbers.length) {
      const cols = ["id", "tracking_number", "action_source", ...MATERIAL_FIELDS].join(", ");
      const { data: priors } = await supabase
        .from("fpx_shipments").select(cols).in("tracking_number", trackingNumbers);
      for (const p of priors || []) priorByTracking.set(p.tracking_number, p);
    }
    // Compute the diff per scraped row (null if first sighting / no change).
    const diffByTracking = new Map();
    for (const m of mapped) {
      const prev = priorByTracking.get(m.tracking_number);
      const diff = computeMaterialDiff(prev, m);
      if (diff) diffByTracking.set(m.tracking_number, diff);
    }
    // ---- Upsert (latest-snapshot table) --------------------------------
    const { data, error } = await supabase
      .from("fpx_shipments")
      .upsert(mapped, { onConflict: "tracking_number" })
      .select("id,tracking_number,seen_count,created_by,action_required,action_source,action_target,ai_issue,ai_recommendation");
    if (error) return res.status(500).json({ error: error.message });

    const upsertedIds = data.map((r) => r.id);
    const idByTracking = new Map(data.map((r) => [r.tracking_number, r.id]));
    // Set of fpx_shipments.id whose latest scrape had material changes.
    const materialChangedIds = new Set(
      Array.from(diffByTracking.keys())
        .map((t) => idByTracking.get(t))
        .filter(Boolean),
    );

    // ---- Persist one fpx_shipment_scrapes row per scraped item ----------
    const scrapePayloads = mapped.map((m, i) => ({
      shipmentId: idByTracking.get(m.tracking_number),
      trackingNumber: m.tracking_number,
      scrapedBy: runnerName,
      raw: bulk[i],                       // full raw extension payload, not the mapped row
      diff: diffByTracking.get(m.tracking_number) || null,
      triggeredReanalysis: false,         // flipped after we know which got re-analyzed
    }));
    // Fire off scrape recording in parallel with the rest of background work.
    const scrapeRecordPromise = recordScrapeBatch(scrapePayloads);

    // ---- Mark manual overrides as stale when new material data arrives -
    // We don't change action_required (operator's choice still wins), but we
    // raise a flag so the dashboard can prompt "this override may be out of
    // date." Cleared back to false on next clean scrape (handled below).
    const staleTargets = mapped
      .filter((m) => diffByTracking.has(m.tracking_number) && priorByTracking.get(m.tracking_number)?.action_source === "manual")
      .map((m) => idByTracking.get(m.tracking_number))
      .filter(Boolean);
    if (staleTargets.length) {
      await supabase.from("fpx_shipments")
        .update({ action_override_stale: true })
        .in("id", staleTargets);
    }
    // Conversely, if a manual override row scraped with no material change,
    // and was previously marked stale, leave it as-is — only operator action
    // clears stale once it's set. (Avoids flapping if the carrier flips a
    // status field then flips it back.)

    // ---- Background: re-analyze + tasks + drafts -----------------------
    const backgroundWork = (async () => {
      const freshlyAnalyzed = await autoAnalyzeUpserted(req, upsertedIds, { materialChangedIds });
      const byId = new Map(data.map((r) => [r.id, r]));
      for (const r of freshlyAnalyzed) byId.set(r.id, r);
      const settled = Array.from(byId.values());
      const tasks = await autoCreateActionTasks(req, settled);
      const drafts = await autoDraftEmails(settled);
      if (tasks || drafts || freshlyAnalyzed.length) {
        console.log(`[FPX] post-upload: ${freshlyAnalyzed.length} (re)analyzed, ${tasks} task(s), ${drafts} draft(s)`);
      }
    })().catch((e) => console.warn("[FPX] post-upload background failed:", e.message));

    logAudit(req, {
      action: "bulk_create",
      entity_type: "shipment",
      summary: `Upserted ${data.length} shipments` + (materialChangedIds.size ? ` (${materialChangedIds.size} with material changes)` : ""),
      metadata: {
        count: data.length,
        runner: runnerName,
        material_changes: materialChangedIds.size,
        stale_overrides_flagged: staleTargets.length,
      },
    });
    // Don't await background — let it drain. scrapeRecordPromise is logged-only.
    void backgroundWork;
    void scrapeRecordPromise;
    return res.json({
      count: data.length,
      ids: upsertedIds,
      material_changes: materialChangedIds.size,
      stale_overrides: staleTargets.length,
    });
  }
  res.status(400).json({ error: "Provide { shipment } or { shipments: [] }" });
});

// POST /shipments/bulk-delete  { ids: [uuid, ...] }
// Hard-deletes shipments. fpx_shipment_tasks rows cascade automatically;
// fpx_ai_analyses rows have their shipment_uuid set to NULL so the analysis
// history survives. Returns the count actually removed (after RLS / missing IDs
// are filtered out).
shipmentsRouter.post("/bulk-delete", async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(String).filter(Boolean)
    : [];
  if (!ids.length) return res.status(400).json({ error: "body.ids array required" });

  // Snapshot for audit before the delete fires.
  const { data: before } = await supabase
    .from("fpx_shipments").select("id, tracking_number, customer_name").in("id", ids);
  const { error, data } = await supabase
    .from("fpx_shipments").delete().in("id", ids).select("id");
  if (error) return res.status(500).json({ error: error.message });
  const deleted = (data || []).length;

  logAudit(req, {
    action: "bulk_delete",
    entity_type: "shipment",
    summary: `Deleted ${deleted} shipment${deleted === 1 ? "" : "s"}`,
    before: { rows: before || [] },
    metadata: { count: deleted, requested: ids.length },
  });

  res.json({ deleted });
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
