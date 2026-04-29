import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";
import { computeWalkContext } from "../lib/taskWalk.js";

export const tasksRouter = Router();

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
  res.json({ data: data || [] });
});

// GET /tasks/:id  — task lookup by id, with optional walk-through context.
// When ?walk=active is set, returns prev_task_id / next_task_id keyed against
// the active (open + in_progress) task set so the drawer can step through.
// `walk` accepts: "active" (default), "open", "in_progress", "all".
// This is the single "database route lookup" the drawer relies on so URL
// state alone (/tasks/:id) is enough to render — no fragile passing of
// in-memory task lists across page transitions.
tasksRouter.get("/:id", async (req, res) => {
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
tasksRouter.patch("/:id", async (req, res) => {
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

// DELETE /tasks/:id
tasksRouter.delete("/:id", async (req, res) => {
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
