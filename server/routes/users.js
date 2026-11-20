import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, generateApiKey, hashApiKey, clearAuthCache } from "../lib/auth.js";
import { sendCachedJson } from "../lib/httpCache.js";
import { logAudit } from "../lib/audit.js";

export const MAILBOX_ACCESS_LEVELS = ["none", "view", "draft"];
const USER_COLS = "id, email, full_name, avatar_url, role, enabled, last_login_at, created_at, auto_open_tracking, mailbox_access";

// Body of PATCH /api/users/:id → { updates } or { error } (400).
// Unknown/invalid role is ignored (historic behavior); an invalid
// mailbox_access is rejected so a typo never silently does nothing.
export function parseUserUpdates(body = {}) {
  const updates = {};
  if (typeof body?.enabled === "boolean") updates.enabled = body.enabled;
  if (typeof body?.role === "string" && ["viewer","member","admin"].includes(body.role)) {
    updates.role = body.role;
  }
  if (typeof body?.full_name === "string") {
    const trimmed = body.full_name.trim();
    updates.full_name = trimmed === "" ? null : trimmed.slice(0, 200);
  }
  if (typeof body?.auto_open_tracking === "boolean") updates.auto_open_tracking = body.auto_open_tracking;
  if (body?.mailbox_access !== undefined) {
    if (!MAILBOX_ACCESS_LEVELS.includes(body.mailbox_access)) {
      return { error: "mailbox_access must be none, view or draft" };
    }
    updates.mailbox_access = body.mailbox_access;
  }
  if (Object.keys(updates).length === 0) return { error: "No valid fields to update" };
  return { updates };
}

// Injectable for tests; production uses the real Supabase / audit / auth.
export function buildUsersRouter(deps = {}) {
  const d = {
    supabase, logAudit, clearAuthCache,
    auth: requireAuth({ role: "admin", scope: "admin" }),
    ...deps,
  };
  const router = Router();

  // All routes here require an admin (JWT or admin-scoped API key).
  router.use(d.auth);

  // GET /api/users — list all profiles.
  router.get("/", async (req, res) => {
    const { data, error } = await d.supabase
      .from("fpx_user_profiles")
      .select(USER_COLS)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    sendCachedJson(req, res, { data: data || [] });
  });

  // PATCH /api/users/:id  { enabled?, role?, full_name?, auto_open_tracking?, mailbox_access? }
  router.patch("/:id", async (req, res) => {
    const parsed = parseUserUpdates(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { updates } = parsed;
    let before = null;
    if (updates.mailbox_access !== undefined) {
      const { data: prev, error: pErr } = await d.supabase
        .from("fpx_user_profiles").select("id, email, mailbox_access").eq("id", req.params.id).maybeSingle();
      if (pErr) return res.status(500).json({ error: pErr.message });
      if (!prev) return res.status(404).json({ error: "User not found" });
      before = prev;
    }
    const { data, error } = await d.supabase
      .from("fpx_user_profiles")
      .update(updates)
      .eq("id", req.params.id)
      .select(USER_COLS)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "User not found" });
    // Role / enabled / mailbox access changes must bite immediately, not
    // after the resolved-credential cache TTL.
    d.clearAuthCache();
    if (before && before.mailbox_access !== data.mailbox_access) {
      d.logAudit(req, {
        action: "update",
        entity_type: "user",
        entity_id: data.id,
        summary: `Changed Support Mailbox access for ${data.email} from ${before.mailbox_access || "draft"} to ${data.mailbox_access}`,
        before: { mailbox_access: before.mailbox_access ?? null },
        after: { mailbox_access: data.mailbox_access },
        metadata: { target_email: data.email, field: "mailbox_access" },
      });
    }
    res.json({ user: data });
  });

  // POST /api/users/:id/issue-key
  // Admin-only. Generates a fresh API key for the user, revokes any existing
  // active keys belonging to them so we don't pile up forgotten secrets, stashes
  // the plaintext on the user's profile so their extension can pick it up on
  // the next /api/me call. Also flips enabled=true so this single action
  // represents "approve API access for this user end-to-end".
  router.post("/:id/issue-key", async (req, res) => {
    const { id } = req.params;
    const { data: target, error: tErr } = await d.supabase
      .from("fpx_user_profiles")
      .select("id, email, full_name, enabled")
      .eq("id", id)
      .maybeSingle();
    if (tErr) return res.status(500).json({ error: tErr.message });
    if (!target) return res.status(404).json({ error: "User not found" });

    // Revoke any active keys still pointing at this user so a re-issue doesn't
    // leave the previous key live in some forgotten install.
    const { data: priors } = await d.supabase
      .from("fpx_api_keys")
      .select("id, name, key_prefix")
      .eq("user_id", id)
      .is("revoked_at", null)
      .not("scopes", "cs", "{mcp}"); // their Claude connector key is separate — keep it
    if (priors && priors.length) {
      await d.supabase
        .from("fpx_api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .in("id", priors.map((p) => p.id));
      for (const p of priors) {
        d.logAudit(req, {
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
    const { data: created, error: cErr } = await d.supabase
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
    const { error: pErr } = await d.supabase
      .from("fpx_user_profiles")
      .update({
        pending_api_key: plaintext,
        pending_api_key_expires_at: expiresAt,
        enabled: true,
      })
      .eq("id", id);
    if (pErr) return res.status(500).json({ error: pErr.message });

    d.logAudit(req, {
      action: "issue_api_key",
      entity_type: "user",
      entity_id: target.id,
      summary: `Issued API key for ${target.email} (${key_prefix}…); stashed for extension auto-pull`,
      after: { user_email: target.email, key_id: created.id, key_prefix },
      metadata: { key_id: created.id, key_prefix, scopes: created.scopes, expires_at: expiresAt },
    });

    // Old keys were just revoked and the user's enabled flag changed —
    // drop cached resolutions so both take effect immediately.
    d.clearAuthCache();

    res.json({
      key: created,
      plaintext, // returned once to the admin too, for manual fallback
      user_id: target.id,
      expires_at: expiresAt,
      revoked_count: priors?.length || 0,
    });
  });

  // Manually seed a user row (e.g. pre-enable someone before they've logged in).
  // Body: { email, role?, enabled?, mailbox_access? }
  router.post("/", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email is required" });
    const role = ["viewer","member","admin"].includes(req.body?.role) ? req.body.role : "viewer";
    const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : true;
    const seed = { role, enabled };
    if (req.body?.mailbox_access !== undefined) {
      if (!MAILBOX_ACCESS_LEVELS.includes(req.body.mailbox_access)) {
        return res.status(400).json({ error: "mailbox_access must be none, view or draft" });
      }
      seed.mailbox_access = req.body.mailbox_access;
    }
    // We can't create an auth.users row from the API without admin SDK; instead we
    // surface an "invite" instruction. For now, update existing profile by email.
    const { data: existing } = await d.supabase
      .from("fpx_user_profiles").select("id").ilike("email", email).maybeSingle();
    if (existing) {
      const { data, error } = await d.supabase
        .from("fpx_user_profiles").update(seed).eq("id", existing.id)
        .select().maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      d.clearAuthCache();
      if (seed.mailbox_access !== undefined) {
        d.logAudit(req, {
          action: "update", entity_type: "user", entity_id: existing.id,
          summary: `Set Support Mailbox access for ${email} to ${seed.mailbox_access}`,
          after: { mailbox_access: seed.mailbox_access },
          metadata: { target_email: email, field: "mailbox_access" },
        });
      }
      return res.json({ user: data, created: false });
    }
    res.status(404).json({
      error: `No profile for ${email} yet. Ask them to sign in once with Microsoft, then enable them here.`,
    });
  });

  return router;
}

export const usersRouter = buildUsersRouter();
