import { Router } from "express";
import { supabase } from "../lib/supabase.js";

export const feedbackRouter = Router();

// GET /feedback — admins see all, others see only their own.
feedbackRouter.get("/", async (req, res) => {
  let q = supabase.from("fpx_feedback").select("*").order("created_at", { ascending: false }).limit(500);
  if (req.user && req.user.role !== "admin") q = q.eq("user_id", req.user.id);
  if (!req.user && req.apiKey) {
    // API key callers shouldn't list feedback in bulk.
    return res.status(403).json({ error: "Feedback list requires user JWT auth." });
  }
  if (req.query.status) q = q.eq("status", String(req.query.status));
  if (req.query.category) q = q.eq("category", String(req.query.category));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// POST /feedback  { category, title, body, severity?, source?, context? }
feedbackRouter.post("/", async (req, res) => {
  const category = ["bug","feature","support","other"].includes(req.body?.category) ? req.body.category : "other";
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || "").trim();
  if (!title || !body) return res.status(400).json({ error: "title and body required" });
  const severity = ["low","normal","high","urgent"].includes(req.body?.severity) ? req.body.severity : "normal";
  const source = ["dashboard","extension","other"].includes(req.body?.source) ? req.body.source : "dashboard";
  const row = {
    user_id: req.user?.id || null,
    user_email: req.user?.email || null,
    category, title, body, severity, source,
    context: req.body?.context || null,
  };
  const { data, error } = await supabase.from("fpx_feedback").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ feedback: data });
});

// PATCH /feedback/:id — admin-only triage. Status, admin_notes, resolved_*.
feedbackRouter.patch("/:id", async (req, res) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin role required" });
  }
  const allowed = ["status","admin_notes","severity","category"];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if (patch.status === "resolved") {
    patch.resolved_at = new Date().toISOString();
    patch.resolved_by = req.user.id;
  } else if (patch.status && patch.status !== "resolved") {
    patch.resolved_at = null;
    patch.resolved_by = null;
  }
  const { data, error } = await supabase
    .from("fpx_feedback").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ feedback: data });
});
