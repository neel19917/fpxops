import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";

export const meRouter = Router();

// GET /api/me — who am I? Lets the dashboard check enabled-status + role.
// Surfaces impersonation state so the dashboard can render the banner.
meRouter.get("/", requireAuth({ requireEnabled: false }), (req, res) => {
  if (req.user) {
    return res.json({
      kind: "user",
      user: req.user,
      realUser: req.realUser || req.user,
      impersonating: req.impersonating
        ? { mode: req.impersonating.mode, target: req.impersonating.target }
        : null,
    });
  }
  if (req.apiKey) {
    return res.json({
      kind: "api_key",
      apiKey: { id: req.apiKey.id, name: req.apiKey.name, scopes: req.apiKey.scopes },
    });
  }
  res.status(401).json({ error: "No identity" });
});

// POST /api/me/impersonate-start  { target_id, writes? }
// Called by the dashboard when an admin starts impersonating. We don't trust
// the client to attribute correctly — the action is logged here against the
// real admin (req.user, since this route doesn't honor the impersonate header).
meRouter.post("/impersonate-start", requireAuth({ acceptApiKey: false, role: "admin" }), async (req, res) => {
  const targetId = String(req.body?.target_id || "").trim();
  const writes = req.body?.writes === true;
  if (!targetId) return res.status(400).json({ error: "target_id required" });
  if (targetId === req.user.id) return res.status(400).json({ error: "Cannot impersonate yourself" });
  const { data: target, error } = await supabase
    .from("fpx_user_profiles").select("id, email, role").eq("id", targetId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!target) return res.status(404).json({ error: "Target user not found" });
  console.log(`[FPX-IMPERSONATE] START — admin=${req.user.email} as=${target.email} writes=${writes}`);
  logAudit(req, {
    action: "impersonate_start",
    entity_type: "user",
    entity_id: target.id,
    summary: `${req.user.email} started impersonating ${target.email} (${writes ? "writes enabled" : "read-only"})`,
    metadata: { target_email: target.email, target_role: target.role, writes_enabled: writes },
  });
  res.json({ ok: true });
});

// POST /api/me/impersonate-stop  { target_id?, writes_were? }
// Logs the end of an impersonation session.
meRouter.post("/impersonate-stop", requireAuth({ acceptApiKey: false, role: "admin" }), async (req, res) => {
  const targetId = req.body?.target_id ? String(req.body.target_id) : null;
  const writes = req.body?.writes_were === true;
  let targetEmail = null;
  if (targetId) {
    const { data } = await supabase.from("fpx_user_profiles").select("email").eq("id", targetId).maybeSingle();
    targetEmail = data?.email || null;
  }
  console.log(`[FPX-IMPERSONATE] STOP — admin=${req.user.email} as=${targetEmail || "unknown"}`);
  logAudit(req, {
    action: "impersonate_stop",
    entity_type: "user",
    entity_id: targetId,
    summary: `${req.user.email} stopped impersonating ${targetEmail || "(target)"}`,
    metadata: { target_email: targetEmail, writes_were_enabled: writes },
  });
  res.json({ ok: true });
});

// POST /api/me/impersonate-toggle-writes  { target_id, writes }
// Logs when an admin enables or disables write-impersonation mid-session.
meRouter.post("/impersonate-toggle-writes", requireAuth({ acceptApiKey: false, role: "admin" }), async (req, res) => {
  const targetId = String(req.body?.target_id || "").trim();
  const writes = req.body?.writes === true;
  if (!targetId) return res.status(400).json({ error: "target_id required" });
  const { data: target } = await supabase.from("fpx_user_profiles").select("id, email").eq("id", targetId).maybeSingle();
  if (!target) return res.status(404).json({ error: "Target user not found" });
  console.log(`[FPX-IMPERSONATE] TOGGLE-WRITES — admin=${req.user.email} as=${target.email} writes=${writes}`);
  logAudit(req, {
    action: writes ? "impersonate_enable_writes" : "impersonate_disable_writes",
    entity_type: "user",
    entity_id: target.id,
    summary: `${req.user.email} ${writes ? "enabled" : "disabled"} write impersonation as ${target.email}`,
    metadata: { target_email: target.email, writes_enabled: writes },
  });
  res.json({ ok: true });
});
