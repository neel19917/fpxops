import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, hashApiKey, generateApiKey } from "../lib/auth.js";

export const apiKeysRouter = Router();

// Admin scope (API key) OR admin role (Microsoft sign-in JWT). The latter
// is required so the first key can be minted from the dashboard.
apiKeysRouter.use(requireAuth({ scope: "admin", role: "admin" }));

// GET /api-keys — list non-revoked + revoked, sorted newest first. Plaintext NEVER returned.
apiKeysRouter.get("/", async (_req, res) => {
  const { data, error } = await supabase
    .from("fpx_api_keys")
    .select("id, name, key_prefix, scopes, created_by, last_used_at, revoked_at, created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
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
  res.json({ key: data, plaintext, warning: "Save this key now — it will not be shown again." });
});

// DELETE /api-keys/:id — soft-revoke (sets revoked_at).
apiKeysRouter.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("fpx_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("revoked_at", null);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
