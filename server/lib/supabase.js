import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn("[FPX] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — DB writes will fail");
}

export const supabase = createClient(url || "http://localhost:0", key || "no-key", {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function isDbReady() {
  return Boolean(url && key);
}
