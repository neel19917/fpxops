import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, hashApiKey, generateApiKey, clearAuthCache } from "../lib/auth.js";
import { sendCachedJson } from "../lib/httpCache.js";
import { logAudit } from "../lib/audit.js";

export const apiKeysRouter = Router();

// Admin scope (API key) OR admin role (Microsoft sign-in JWT). The latter
// is required so the first key can be minted from the dashboard.
apiKeysRouter.use(requireAuth({ scope: "admin", role: "admin" }));

// GET /api-keys — list non-revoked + revoked, sorted newest first. Plaintext NEVER returned.
apiKeysRouter.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("fpx_api_keys")
    .select("id, name, key_prefix, scopes, created_by, last_used_at, revoked_at, created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  sendCachedJson(req, res, { data: data || [] });
});

// POST /api-keys  { name, scopes?: ['read','write','admin'] } → returns PLAINTEXT once.
apiKeysRouter.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const scopes = Array.isArray(req.body?.scopes) && req.body.scopes.length
    ? req.body.scopes
    : ["read", "write"];
  const plaintext = generateApiKey();
  const key_hash = hashApiKey(plaintext);
  const key_prefix = plaintext.slice(0, 12);
  const { data, error } = await supabase
    .from("fpx_api_keys")
    .insert({ name, key_hash, key_prefix, scopes, created_by: req.apiKey?.name || req.user?.email || "admin" })
    .select("id, name, key_prefix, scopes, created_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "create",
    entity_type: "api_key",
    entity_id: data.id,
    summary: `Created API key "${data.name}" (${key_prefix}…) with scopes: ${scopes.join(", ")}`,
    after: { name: data.name, key_prefix, scopes },
    metadata: { name: data.name, key_prefix, scopes },
  });
  res.json({ key: data, plaintext, warning: "Save this key now — it will not be shown again." });
});

// DELETE /api-keys/:id — soft-revoke (sets revoked_at).
apiKeysRouter.delete("/:id", async (req, res) => {
  // Snapshot for the audit `before` so the log shows what got revoked even
  // after the row's revoked_at timestamp moves.
  const { data: before } = await supabase
    .from("fpx_api_keys")
    .select("id, name, key_prefix, scopes, revoked_at")
    .eq("id", req.params.id).maybeSingle();
  if (!before) return res.status(404).json({ error: "API key not found" });
  if (before.revoked_at) return res.status(409).json({ error: "API key already revoked" });

  const { error, data } = await supabase
    .from("fpx_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("revoked_at", null)
    .select("id, name, key_prefix, scopes, revoked_at")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(409).json({ error: "API key already revoked" });

  logAudit(req, {
    action: "revoke",
    entity_type: "api_key",
    entity_id: data.id,
    summary: `Revoked API key "${data.name}" (${data.key_prefix}…)`,
    before: { name: before.name, key_prefix: before.key_prefix, scopes: before.scopes, revoked_at: before.revoked_at },
    after:  { name: data.name,   key_prefix: data.key_prefix,   scopes: data.scopes,   revoked_at: data.revoked_at },
    metadata: { name: data.name, key_prefix: data.key_prefix, scopes: data.scopes },
  });
  // Revocation must bite immediately, not after the resolved-credential
  // cache TTL.
  clearAuthCache();
  res.json({ ok: true });
});
