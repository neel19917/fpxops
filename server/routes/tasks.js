import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";
import { computeWalkContext } from "../lib/taskWalk.js";
import { generateCarrierGroupEmail, generateCustomerGroupEmail } from "../lib/emailDraft.js";

export const tasksRouter = Router();

// Convention-based detector: a task is a "carrier follow-up" when its
// title contains both "carrier" and "follow" (case-insensitive). No
// schema change needed — operators just type a recognizable title like
// "Carrier followup: missing POD" and the dashboard surfaces it in the
// dedicated panel. Kept in the route file (not a util) because both
// /carrier-followups and /carrier-email-draft need the same definition.
export function isCarrierFollowupTitle(title) {
  if (typeof title !== "string") return false;
  const t = title.toLowerCase();
  return t.includes("carrier") && t.includes("follow");
}

// Customer follow-up uses the same convention with "customer" + "follow".
// Edge case: a title containing BOTH "carrier" and "customer" (e.g.
// "Customer wants carrier followup") is ambiguous — we resolve in
// favor of the carrier panel by excluding such titles from this
// matcher. Without that exclusion the same task would appear in both
// panels and confuse the bulk-email flow (which carrier should we
// write to vs which customer?). Operators who really want a single
// task in both panels can create two tasks.
export function isCustomerFollowupTitle(title) {
  if (typeof title !== "string") return false;
  const t = title.toLowerCase();
  if (!t.includes("customer") || !t.includes("follow")) return false;
  if (t.includes("carrier")) return false;
  return true;
}

// GET /tasks?status=open&assigned_to=...&limit=200
// Cross-shipment task list; defaults to open tasks.
tasksRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  let q = supabase.from("fpx_shipment_tasks").select("*").order("created_at", { ascending: false }).limit(limit);
  if (req.query.status) q = q.eq("status", String(req.query.status));
  if (req.query.assigned_to) q = q.eq("assigned_to", String(req.query.assigned_to));
  if (req.query.priority) q = q.eq("priority", String(req.query.priority));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Attach the FreightPOP-side shipment_id (string) per task so the
  // Tasks page can search/filter by it without an extra round trip. The
  // task row only carries shipment_id (UUID) + tracking_number; the
  // human-facing FreightPOP id lives on the shipment. We do this as a
  // batch lookup against the unique shipment uuids — typically 100s of
  // tasks → 10s of distinct shipments, well under the 1k cap.
  const tasks = data || [];
  const shipmentUuids = Array.from(new Set(tasks.map((t) => t.shipment_id).filter(Boolean)));
  let externalById = new Map();
  if (shipmentUuids.length) {
    const { data: ships, error: shipErr } = await supabase
      .from("fpx_shipments")
      .select("id, shipment_id")
      .in("id", shipmentUuids);
    if (!shipErr && ships) {
      externalById = new Map(ships.map((s) => [s.id, s.shipment_id]));
    }
  }
  const enriched = tasks.map((t) => ({
    ...t,
    shipment_external_id: externalById.get(t.shipment_id) || null,
  }));
  res.json({ data: enriched });
});

// GET /tasks/carrier-followups
// Returns active (open + in_progress) carrier-followup tasks joined to
// their shipments so the dashboard can group by carrier without N round
// trips. The single-query approach also keeps the carrier and customer
// in sync with the latest scrape — important when a carrier is
// reassigned mid-shipment. Output shape:
//   { groups: [{ carrier, items: [{ task, shipment }] }], total }
// Sorted: groups by item count desc, items by oldest task first (FIFO
// follow-up cadence). Sits before /tasks/:id so the static path wins.
tasksRouter.get("/carrier-followups", async (req, res) => {
  const { data: tasks, error } = await supabase
    .from("fpx_shipment_tasks")
    .select("*")
    .in("status", ["open", "in_progress"])
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const followups = (tasks || []).filter((t) => isCarrierFollowupTitle(t.title));
  if (!followups.length) return res.json({ groups: [], total: 0 });

  const shipIds = Array.from(new Set(followups.map((t) => t.shipment_id).filter(Boolean)));
  const { data: ships, error: shipErr } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, shipment_id, customer_name, carrier, carrier_name, mode, shipment_status, pickup_date, updated_eta, estimated_arrival, delivery_date, pickup_response, confirmation_number, pickup_request_number, origin, destination, ship_from, ship_to, ai_issue, ai_recommendation, action_required")
    .in("id", shipIds);
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  const byId = new Map((ships || []).map((s) => [s.id, s]));

  // Group key prefers carrier_name (the human label scraped from the
  // grid) and falls back to carrier (the code/short id). "(unassigned)"
  // bucket catches shipments with neither populated — operators should
  // see them surfaced rather than dropped.
  const groupsMap = new Map();
  for (const t of followups) {
    const ship = byId.get(t.shipment_id);
    if (!ship) continue;
    const carrier = (ship.carrier_name || ship.carrier || "(unassigned)").trim() || "(unassigned)";
    if (!groupsMap.has(carrier)) groupsMap.set(carrier, []);
    groupsMap.get(carrier).push({ task: t, shipment: ship });
  }
  const groups = Array.from(groupsMap.entries())
    .map(([carrier, items]) => ({ carrier, items }))
    .sort((a, b) => b.items.length - a.items.length || a.carrier.localeCompare(b.carrier));
  res.json({ groups, total: followups.length });
});

// POST /tasks/carrier-email-draft  { carrier, task_ids: string[], notes? }
// Generates ONE consolidated email covering every supplied task's
// shipment, addressed to the named carrier. Routed through the larger
// model (configurable via prompt.email_draft.carrier_group.model in
// Settings; defaults to Opus for the multi-shipment synthesis).
tasksRouter.post("/carrier-email-draft", async (req, res) => {
  const carrier = typeof req.body?.carrier === "string" ? req.body.carrier.trim() : "";
  const taskIds = Array.isArray(req.body?.task_ids)
    ? req.body.task_ids.filter((x) => typeof x === "string" && x)
    : [];
  if (!carrier) return res.status(400).json({ error: "carrier required" });
  if (!taskIds.length) return res.status(400).json({ error: "task_ids required" });

  const { data: tasks, error: taskErr } = await supabase
    .from("fpx_shipment_tasks").select("*").in("id", taskIds);
  if (taskErr) return res.status(500).json({ error: taskErr.message });
  const followupTasks = (tasks || []).filter((t) => isCarrierFollowupTitle(t.title));
  if (!followupTasks.length) {
    return res.status(400).json({ error: "No carrier-followup tasks in supplied ids" });
  }
  const shipIds = Array.from(new Set(followupTasks.map((t) => t.shipment_id).filter(Boolean)));
  if (!shipIds.length) return res.status(400).json({ error: "No shipments linked to supplied tasks" });

  const { data: ships, error: shipErr } = await supabase
    .from("fpx_shipments").select("*").in("id", shipIds);
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  const shipById = new Map((ships || []).map((s) => [s.id, s]));

  const items = followupTasks
    .map((t) => ({ task: t, shipment: shipById.get(t.shipment_id) }))
    .filter((it) => it.shipment);
  if (!items.length) return res.status(404).json({ error: "Shipments not found" });

  const result = await generateCarrierGroupEmail({
    carrier,
    items,
    notes: req.body?.notes,
    callMeta: { api_key_id: req.apiKey?.id, user_email: req.user?.email },
  });
  if (result.error) return res.status(500).json({ error: result.error });
  logAudit(req, {
    action: "create", entity_type: "email_draft",
    summary: `Drafted carrier follow-up email to "${carrier}" covering ${items.length} shipment(s)`,
    metadata: { carrier, task_ids: taskIds, count: items.length, model: result.model || null },
  });
  res.json({ subject: result.subject, body: result.body, count: items.length, model: result.model || null });
});

// Pulls prior bulk-email drafts for a single group (carrier or customer)
// from fpx_ai_analyses, parses out subject/body, and returns newest-first.
// Both /carrier-email-drafts and /customer-email-drafts go through this
// helper so the two endpoints stay in lockstep.
async function listGroupDrafts({ subkind, groupKey, groupValue, limit }) {
  if (!groupValue) return [];
  // Use jsonb containment (@>) so Postgres can hit the
  // fpx_ai_analyses_metadata_gin_idx GIN index. The .eq("metadata->>...")
  // form translates to text equality which doesn't use the GIN index
  // and would seq-scan the table once we cross ~10k analyses rows.
  // .contains() in supabase-js compiles to `metadata @> '...'::jsonb`
  // which the planner turns into a Bitmap Index Scan.
  const matcher = { subkind, [groupKey]: groupValue };
  const { data, error } = await supabase
    .from("fpx_ai_analyses")
    .select("id, created_at, model, response_text, input_tokens, output_tokens, cost_usd, metadata, rating, rating_reason, rated_by, rated_at")
    .contains("metadata", matcher)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { error };
  // Parse subject + body out of the JSON the model emitted. Same logic
  // as generateCarrierGroupEmail / generateCustomerGroupEmail — kept
  // here in the route layer so historical drafts render even if the
  // generator's parser changes.
  const drafts = (data || []).map((a) => {
    let subject = null, body = null;
    try {
      const m = (a.response_text || "").match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed?.subject) subject = String(parsed.subject);
        if (parsed?.body) body = String(parsed.body);
      }
    } catch { /* fall through with nulls */ }
    return {
      id: a.id,
      created_at: a.created_at,
      model: a.model,
      subject,
      body,
      raw: a.response_text,
      count: (a.metadata && typeof a.metadata === "object" && Number(a.metadata.count)) || null,
      cost_usd: a.cost_usd,
      input_tokens: a.input_tokens,
      output_tokens: a.output_tokens,
      rating: a.rating || null,
      rating_reason: a.rating_reason || null,
      rated_by: a.rated_by || null,
      rated_at: a.rated_at || null,
    };
  });
  return drafts;
}

// GET /tasks/carrier-email-drafts?carrier=Pilot[&limit=20]
// List of prior bulk drafts for a carrier, newest-first. Used by the
// Group Email modal to show the operator the history of drafts for
// that carrier, so they can compare or reuse one without burning a
// fresh Opus call.
tasksRouter.get("/carrier-email-drafts", async (req, res) => {
  const carrier = typeof req.query.carrier === "string" ? req.query.carrier.trim() : "";
  if (!carrier) return res.status(400).json({ error: "carrier required" });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const drafts = await listGroupDrafts({
    subkind: "email_draft_carrier_group",
    groupKey: "carrier",
    groupValue: carrier,
    limit,
  });
  if (drafts && drafts.error) return res.status(500).json({ error: drafts.error.message });
  res.json({ drafts });
});

// GET /tasks/customer-email-drafts?customer=X[&limit=20]
tasksRouter.get("/customer-email-drafts", async (req, res) => {
  const customer = typeof req.query.customer === "string" ? req.query.customer.trim() : "";
  if (!customer) return res.status(400).json({ error: "customer required" });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const drafts = await listGroupDrafts({
    subkind: "email_draft_customer_group",
    groupKey: "customer",
    groupValue: customer,
    limit,
  });
  if (drafts && drafts.error) return res.status(500).json({ error: drafts.error.message });
  res.json({ drafts });
});

// GET /tasks/customer-followups  — mirror of /carrier-followups grouped
// by customer_name. Detection uses isCustomerFollowupTitle, which
// excludes carrier-titled tasks (so the same task never shows up in
// both panels). Empty / "(unassigned)" customer rows are bucketed
// under a placeholder rather than dropped — operators should see a
// gap they can clean up rather than have it disappear silently.
tasksRouter.get("/customer-followups", async (req, res) => {
  const { data: tasks, error } = await supabase
    .from("fpx_shipment_tasks")
    .select("*")
    .in("status", ["open", "in_progress"])
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const followups = (tasks || []).filter((t) => isCustomerFollowupTitle(t.title));
  if (!followups.length) return res.json({ groups: [], total: 0 });

  const shipIds = Array.from(new Set(followups.map((t) => t.shipment_id).filter(Boolean)));
  const { data: ships, error: shipErr } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, shipment_id, customer_name, carrier, carrier_name, mode, shipment_status, pickup_date, updated_eta, estimated_arrival, delivery_date, pickup_response, confirmation_number, pickup_request_number, origin, destination, ship_from, ship_to, ai_issue, ai_recommendation, action_required")
    .in("id", shipIds);
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  const byId = new Map((ships || []).map((s) => [s.id, s]));

  const groupsMap = new Map();
  for (const t of followups) {
    const ship = byId.get(t.shipment_id);
    if (!ship) continue;
    const customer = (ship.customer_name || "(unassigned)").trim() || "(unassigned)";
    if (!groupsMap.has(customer)) groupsMap.set(customer, []);
    groupsMap.get(customer).push({ task: t, shipment: ship });
  }
  const groups = Array.from(groupsMap.entries())
    .map(([customer, items]) => ({ customer, items }))
    .sort((a, b) => b.items.length - a.items.length || a.customer.localeCompare(b.customer));
  res.json({ groups, total: followups.length });
});

// POST /tasks/customer-email-draft  { customer, task_ids: string[], notes? }
// Mirror of carrier-email-draft. Validates titles via
// isCustomerFollowupTitle so a stray carrier-tagged id can't slip
// through into the customer flow.
tasksRouter.post("/customer-email-draft", async (req, res) => {
  const customer = typeof req.body?.customer === "string" ? req.body.customer.trim() : "";
  const taskIds = Array.isArray(req.body?.task_ids)
    ? req.body.task_ids.filter((x) => typeof x === "string" && x)
    : [];
  if (!customer) return res.status(400).json({ error: "customer required" });
  if (!taskIds.length) return res.status(400).json({ error: "task_ids required" });

  const { data: tasks, error: taskErr } = await supabase
    .from("fpx_shipment_tasks").select("*").in("id", taskIds);
  if (taskErr) return res.status(500).json({ error: taskErr.message });
  const followupTasks = (tasks || []).filter((t) => isCustomerFollowupTitle(t.title));
  if (!followupTasks.length) {
    return res.status(400).json({ error: "No customer-followup tasks in supplied ids" });
  }
  const shipIds = Array.from(new Set(followupTasks.map((t) => t.shipment_id).filter(Boolean)));
  if (!shipIds.length) return res.status(400).json({ error: "No shipments linked to supplied tasks" });

  const { data: ships, error: shipErr } = await supabase
    .from("fpx_shipments").select("*").in("id", shipIds);
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  const shipById = new Map((ships || []).map((s) => [s.id, s]));

  const items = followupTasks
    .map((t) => ({ task: t, shipment: shipById.get(t.shipment_id) }))
    .filter((it) => it.shipment);
  if (!items.length) return res.status(404).json({ error: "Shipments not found" });

  const result = await generateCustomerGroupEmail({
    customer,
    items,
    notes: req.body?.notes,
    callMeta: { api_key_id: req.apiKey?.id, user_email: req.user?.email },
  });
  if (result.error) return res.status(500).json({ error: result.error });
  logAudit(req, {
    action: "create", entity_type: "email_draft",
    summary: `Drafted customer follow-up email to "${customer}" covering ${items.length} shipment(s)`,
    metadata: { customer, task_ids: taskIds, count: items.length, model: result.model || null },
  });
  res.json({ subject: result.subject, body: result.body, count: items.length, model: result.model || null });
});

// GET /tasks/:id  — task lookup by id, with optional walk-through context.
// When ?walk=active is set, returns prev_task_id / next_task_id keyed against
// the active (open + in_progress) task set so the drawer can step through.
// `walk` accepts: "active" (default), "open", "in_progress", "all".
// This is the single "database route lookup" the drawer relies on so URL
// state alone (/tasks/:id) is enough to render — no fragile passing of
// in-memory task lists across page transitions.
//
// The :id pattern is constrained to a UUID-shaped regex so this route
// can never accidentally swallow a sibling like /customer-followups or
// /carrier-followups in the future. Without the regex, registration
// order is the only thing keeping those routes safe — easy to break
// during a refactor. (Express 4 supports inline regex via `:param(re)`.)
tasksRouter.get("/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", async (req, res) => {
  const { data: task, error } = await supabase
    .from("fpx_shipment_tasks").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!task) return res.status(404).json({ error: "Task not found" });

  const walkParam = String(req.query.walk || "active").toLowerCase();
  let walk = null;
  if (walkParam !== "off") {
    let q = supabase.from("fpx_shipment_tasks")
      .select("id, shipment_id, tracking_number, title, status")
      .order("created_at", { ascending: false });
    if (walkParam === "active") q = q.in("status", ["open", "in_progress"]);
    else if (walkParam === "open" || walkParam === "in_progress" || walkParam === "blocked" || walkParam === "done")
      q = q.eq("status", walkParam);
    // "all" → no status filter.
    const { data: list, error: listErr } = await q;
    if (!listErr && list) {
      // Pure resolver lives in lib/taskWalk.js so it's testable without
      // mocking supabase.
      walk = computeWalkContext(task, list, walkParam);
    }
  }
  res.json({ task, walk });
});

// POST /tasks/bulk  { shipment_ids: string[], title, description?, priority?, assigned_to? }
// Creates one task per shipment. assigned_to defaults to that shipment's
// created_by (the runner who scraped it). Skips already-completed shipments? No —
// we let the user fan out tasks to any selection. Returns { created, errors }.
tasksRouter.post("/bulk", async (req, res) => {
  const ids = Array.isArray(req.body?.shipment_ids) ? req.body.shipment_ids.filter((x) => typeof x === "string") : [];
  const title = String(req.body?.title || "").trim();
  if (!ids.length) return res.status(400).json({ error: "shipment_ids required" });
  if (!title) return res.status(400).json({ error: "title required" });
  const description = req.body?.description ? String(req.body.description) : null;
  const priority = ["low","normal","high","urgent"].includes(req.body?.priority) ? req.body.priority : "normal";
  const overrideAssignee = req.body?.assigned_to ? String(req.body.assigned_to) : null;
  const creatorName = req.user?.email || req.apiKey?.name || req.header("x-fpx-user-name") || null;
  const due_at = req.body?.due_at || null;

  // Fetch the target shipments so we can pull tracking_number + created_by per row.
  const { data: ships, error: shipErr } = await supabase
    .from("fpx_shipments").select("id, tracking_number, created_by").in("id", ids);
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  const found = new Map(ships.map((s) => [s.id, s]));

  const rows = [];
  const missing = [];
  for (const id of ids) {
    const s = found.get(id);
    if (!s) { missing.push(id); continue; }
    rows.push({
      shipment_id: s.id,
      tracking_number: s.tracking_number,
      title,
      description,
      priority,
      status: "open",
      assigned_to: overrideAssignee || s.created_by || null,
      created_by: creatorName,
      due_at,
    });
  }
  if (!rows.length) return res.status(404).json({ error: "No matching shipments found", missing });

  const { data, error } = await supabase.from("fpx_shipment_tasks").insert(rows).select("id, shipment_id, assigned_to, title");
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "bulk_create", entity_type: "task",
    summary: `Bulk-created ${data.length} task(s): "${title}"`,
    metadata: { count: data.length, missing, title, priority, assignee_override: overrideAssignee },
  });
  res.json({ created: data.length, missing, tasks: data });
});

// POST /tasks/bulk-update  { ids: string[], status?, priority?, assigned_to? }
// Apply the same patch to many tasks at once.
tasksRouter.post("/bulk-update", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string") : [];
  if (!ids.length) return res.status(400).json({ error: "ids required" });
  const allowed = ["status","priority","assigned_to"];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if (!Object.keys(patch).length) return res.status(400).json({ error: "no fields to update" });
  if (patch.status === "done") patch.completed_at = new Date().toISOString();
  if (patch.status && patch.status !== "done") patch.completed_at = null;
  const { data, error } = await supabase
    .from("fpx_shipment_tasks").update(patch).in("id", ids).select("id");
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "bulk_update", entity_type: "task",
    summary: `Bulk-updated ${data.length} task(s)`,
    metadata: { count: data.length, patch },
  });
  res.json({ updated: data.length });
});

// POST /tasks/bulk-delete  { ids: string[] }
// Delete many tasks at once. Used by the Tasks page "clear out" toolbar.
tasksRouter.post("/bulk-delete", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string") : [];
  if (!ids.length) return res.status(400).json({ error: "ids required" });
  const { data: before } = await supabase
    .from("fpx_shipment_tasks").select("id, title").in("id", ids);
  const { error } = await supabase.from("fpx_shipment_tasks").delete().in("id", ids);
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "bulk_delete", entity_type: "task",
    summary: `Bulk-deleted ${ids.length} task(s)`,
    metadata: { count: ids.length, ids, titles: (before || []).map((b) => b.title) },
  });
  res.json({ deleted: ids.length });
});

// PATCH /tasks/:id  { status?, priority?, assigned_to?, title?, description?, due_at? }
// Same UUID constraint as GET /:id — see the rationale above.
tasksRouter.patch("/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", async (req, res) => {
  const allowed = ["status", "priority", "assigned_to", "title", "description", "due_at"];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if (patch.status === "done" && !patch.completed_at) patch.completed_at = new Date().toISOString();
  if (patch.status && patch.status !== "done") patch.completed_at = null;
  const { data: before } = await supabase
    .from("fpx_shipment_tasks").select("id, title, status, priority, assigned_to").eq("id", req.params.id).maybeSingle();
  const { data, error } = await supabase
    .from("fpx_shipment_tasks").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "update", entity_type: "task", entity_id: data.id,
    summary: `Updated task "${data.title}"`,
    before, after: data,
  });
  res.json({ task: data });
});

// DELETE /tasks/:id  — UUID-constrained for the same reason as GET /:id.
tasksRouter.delete("/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", async (req, res) => {
  const { data: before } = await supabase
    .from("fpx_shipment_tasks").select("id, title, shipment_id").eq("id", req.params.id).maybeSingle();
  const { error } = await supabase.from("fpx_shipment_tasks").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "delete", entity_type: "task", entity_id: req.params.id,
    summary: before ? `Deleted task "${before.title}"` : "Deleted task",
    before,
  });
  res.json({ ok: true });
});
