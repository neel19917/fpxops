import { Router } from "express";
import { supabase } from "../lib/supabase.js";

export const auditLogRouter = Router();

// GET /audit-log?entity_type=&entity_id=&action=&actor_email=&limit=200
// Admin-only — RLS already restricts SELECT but we double-check at the route
// boundary so non-admins get a clear 403 instead of an empty array.
auditLogRouter.get("/", async (req, res) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin role required" });
  }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  let q = supabase.from("fpx_audit_log").select("*").order("created_at", { ascending: false }).limit(limit);
  if (req.query.entity_type) q = q.eq("entity_type", String(req.query.entity_type));
  if (req.query.entity_id)   q = q.eq("entity_id",   String(req.query.entity_id));
  if (req.query.action)      q = q.eq("action",      String(req.query.action));
  if (req.query.actor_email) q = q.eq("actor_email", String(req.query.actor_email));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});
