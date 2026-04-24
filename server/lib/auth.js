import crypto from "node:crypto";
import { supabase } from "./supabase.js";

export function hashApiKey(plaintext) {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey() {
  // 32 random bytes → base64url, prefixed for easy identification.
  const raw = crypto.randomBytes(32).toString("base64url");
  return `fpx_live_${raw}`;
}

// Express middleware. Reads x-api-key, verifies against fpx_api_keys.
// Attaches req.apiKey = { id, name, scopes } on success. 401 otherwise.
export function requireApiKey(options = {}) {
  const requiredScope = options.scope; // e.g. 'admin'
  return async (req, res, next) => {
    const key = req.header("x-api-key");
    if (!key) return res.status(401).json({ error: "Missing x-api-key header" });
    const keyHash = hashApiKey(key);
    const { data, error } = await supabase
      .from("fpx_api_keys")
      .select("id, name, scopes, revoked_at")
      .eq("key_hash", keyHash)
      .maybeSingle();
    if (error) return res.status(500).json({ error: `Auth DB error: ${error.message}` });
    if (!data || data.revoked_at) return res.status(401).json({ error: "Invalid or revoked API key" });
    if (requiredScope && !(data.scopes || []).includes(requiredScope)) {
      return res.status(403).json({ error: `Requires '${requiredScope}' scope` });
    }
    req.apiKey = { id: data.id, name: data.name, scopes: data.scopes || [] };
    // Fire-and-forget last_used_at update.
    supabase.from("fpx_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
    next();
  };
}

// Bootstrap: if FPX_BOOTSTRAP_ADMIN_KEY is set, ensure that plaintext key exists as an admin key.
export async function bootstrapAdminKey() {
  const plaintext = process.env.FPX_BOOTSTRAP_ADMIN_KEY;
  if (!plaintext) return;
  const keyHash = hashApiKey(plaintext);
  const { data: existing } = await supabase
    .from("fpx_api_keys")
    .select("id")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (existing) {
    console.log("[FPX] Bootstrap admin key already present.");
    return;
  }
  const { error } = await supabase.from("fpx_api_keys").insert({
    name: "bootstrap-admin",
    key_hash: keyHash,
    key_prefix: plaintext.slice(0, 12),
    scopes: ["read", "write", "admin"],
    created_by: "bootstrap",
  });
  if (error) console.warn("[FPX] Bootstrap admin insert failed:", error.message);
  else console.log("[FPX] Bootstrap admin key registered.");
}
