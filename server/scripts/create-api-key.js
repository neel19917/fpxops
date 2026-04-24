#!/usr/bin/env node
// Usage: node scripts/create-api-key.js "dashboard" read,write,admin
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
import "dotenv/config";
import { supabase, isDbReady } from "../lib/supabase.js";
import { generateApiKey, hashApiKey } from "../lib/auth.js";

async function main() {
  if (!isDbReady()) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured.");
    process.exit(1);
  }
  const name = process.argv[2] || "unnamed";
  const scopes = (process.argv[3] || "read,write").split(",").map((s) => s.trim()).filter(Boolean);
  const plaintext = generateApiKey();
  const key_hash = hashApiKey(plaintext);
  const key_prefix = plaintext.slice(0, 12);

  const { data, error } = await supabase
    .from("fpx_api_keys")
    .insert({ name, key_hash, key_prefix, scopes, created_by: "cli" })
    .select("id, name, scopes, created_at")
    .single();
  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }
  console.log("\n✓ API key created");
  console.log("  id:     ", data.id);
  console.log("  name:   ", data.name);
  console.log("  scopes: ", data.scopes.join(", "));
  console.log("  key:    ", plaintext);
  console.log("\n⚠️  Save this key NOW — it will not be shown again. Revoke with DELETE /api-keys/:id or admin UI.\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
