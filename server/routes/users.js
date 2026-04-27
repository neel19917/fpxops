import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";
import { sendCachedJson } from "../lib/httpCache.js";

export const usersRouter = Router();

// All routes here require an admin (JWT or admin-scoped API key).
usersRouter.use(requireAuth({ role: "admin", scope: "admin" }));

// GET /api/users — list all profiles.
usersRouter.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("fpx_user_profiles")
    .select("id, email, full_name, avatar_url, role, enabled, last_login_at, created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  sendCachedJson(req, res, { data: data || [] });
});

// PATCH /api/users/:id  { enabled?, role? }
usersRouter.patch("/:id", async (req, res) => {
  const updates = {};
  if (typeof req.body?.enabled === "boolean") updates.enabled = req.body.enabled;
  if (typeof req.body?.role === "string" && ["viewer","member","admin"].includes(req.body.role)) {
    updates.role = req.body.role;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });
  const { data, error } = await supabase
    .from("fpx_user_profiles")
    .update(updates)
    .eq("id", req.params.id)
    .select("id, email, full_name, avatar_url, role, enabled, last_login_at, created_at")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "User not found" });
  res.json({ user: data });
});

// Manually seed a user row (e.g. pre-enable someone before they've logged in).
// Body: { email, role?, enabled? }
usersRouter.post("/", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });
  const role = ["viewer","member","admin"].includes(req.body?.role) ? req.body.role : "viewer";
  const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : true;
  // We can't create an auth.users row from the API without admin SDK; instead we
  // surface an "invite" instruction. For now, update existing profile by email.
  const { data: existing } = await supabase
    .from("fpx_user_profiles").select("id").ilike("email", email).maybeSingle();
  if (existing) {
    const { data, error } = await supabase
      .from("fpx_user_profiles").update({ role, enabled }).eq("id", existing.id)
      .select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ user: data, created: false });
  }
  res.status(404).json({
    error: `No profile for ${email} yet. Ask them to sign in once with Microsoft, then enable them here.`,
  });
});
