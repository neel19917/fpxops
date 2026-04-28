import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, generateApiKey, hashApiKey } from "../lib/auth.js";
import { sendCachedJson } from "../lib/httpCache.js";
import { logAudit } from "../lib/audit.js";

export const usersRouter = Router();

// Issued plaintexts hang around on the profile for at most 24h. If the rep
// never picks them up, they expire so we don't leave a forever-secret in the
// row. The hashed key in fpx_api_keys keeps working — the admin can re-issue.
const PENDING_KEY_TTL_MS = 24 * 60 * 60 * 1000;

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

// PATCH /api/users/:id  { enabled?, role?, full_name? }
usersRouter.patch("/:id", async (req, res) => {
  const updates = {};
  if (typeof req.body?.enabled === "boolean") updates.enabled = req.body.enabled;
  if (typeof req.body?.role === "string" && ["viewer","member","admin"].includes(req.body.role)) {
    updates.role = req.body.role;
  }
  if (typeof req.body?.full_name === "string") {
    const trimmed = req.body.full_name.trim();
    updates.full_name = trimmed === "" ? null : trimmed.slice(0, 200);
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

// POST /api/users/:id/issue-key
// Admin-only. Generates a fresh API key for the user, revokes any existing
// active keys belonging to them so we don't pile up forgotten secrets, stashes
// the plaintext on the user's profile so their extension can pick it up on
// the next /api/me call. Also flips enabled=true so this single action
// represents "approve API access for this user end-to-end".
usersRouter.post("/:id/issue-key", async (req, res) => {
  const { id } = req.params;
  const { data: target, error: tErr } = await supabase
    .from("fpx_user_profiles")
    .select("id, email, full_name, enabled")
    .eq("id", id)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!target) return res.status(404).json({ error: "User not found" });

  // Revoke any active keys still pointing at this user so a re-issue doesn't
  // leave the previous key live in some forgotten install.
  const { data: priors } = await supabase
    .from("fpx_api_keys")
    .select("id, name, key_prefix")
    .eq("user_id", id)
    .is("revoked_at", null);
  if (priors && priors.length) {
    await supabase
      .from("fpx_api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", id)
      .is("revoked_at", null);
    for (const p of priors) {
      logAudit(req, {
        action: "revoke",
        entity_type: "api_key",
        entity_id: p.id,
        summary: `Auto-revoked old API key "${p.name}" (${p.key_prefix}…) for ${target.email} during re-issue`,
        metadata: { reason: "re-issue", target_email: target.email },
      });
    }
  }

  const plaintext = generateApiKey();
  const key_hash = hashApiKey(plaintext);
  const key_prefix = plaintext.slice(0, 12);
  const keyName = `Auto-issued · ${target.full_name || target.email}`;
  const { data: created, error: cErr } = await supabase
    .from("fpx_api_keys")
    .insert({
      name: keyName,
      key_hash,
      key_prefix,
      scopes: ["read", "write"],
      created_by: req.user?.email || req.apiKey?.name || "admin",
      user_id: target.id,
    })
    .select("id, name, key_prefix, scopes, created_at")
    .single();
  if (cErr) return res.status(500).json({ error: cErr.message });

  // Stash plaintext + expiry on the user's profile so their extension can
  // pull it on the next /api/me call. Also flip enabled=true so the gate
  // they hit on /api/me responses also clears.
  const expiresAt = new Date(Date.now() + PENDING_KEY_TTL_MS).toISOString();
  const { error: pErr } = await supabase
    .from("fpx_user_profiles")
    .update({
      pending_api_key: plaintext,
      pending_api_key_expires_at: expiresAt,
      enabled: true,
    })
    .eq("id", id);
  if (pErr) return res.status(500).json({ error: pErr.message });

  logAudit(req, {
    action: "issue_api_key",
    entity_type: "user",
    entity_id: target.id,
    summary: `Issued API key for ${target.email} (${key_prefix}…); stashed for extension auto-pull`,
    after: { user_email: target.email, key_id: created.id, key_prefix },
    metadata: { key_id: created.id, key_prefix, scopes: created.scopes, expires_at: expiresAt },
  });

  res.json({
    key: created,
    plaintext, // returned once to the admin too, for manual fallback
    user_id: target.id,
    expires_at: expiresAt,
    revoked_count: priors?.length || 0,
  });
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
