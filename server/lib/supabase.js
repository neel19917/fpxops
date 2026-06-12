import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn("[FPX] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — DB writes will fail");
}

// Supabase calls go out through fetch with no deadline by default — a
// stalled connection (Supabase incident, network partition, dead socket)
// would pin the route handler forever; the client gives up after its own
// 20s timeout but the server-side work never unwinds. 15s is generous
// for PostgREST queries that normally answer in well under 100ms, while
// still beating the dashboard's timeout so the user sees a real error
// message from us instead of a generic network failure.
const DB_TIMEOUT_MS = 15_000;
function fetchWithDeadline(input, init = {}) {
  const deadline = AbortSignal.timeout(DB_TIMEOUT_MS);
  const signal = init.signal
    ? (AbortSignal.any ? AbortSignal.any([init.signal, deadline]) : init.signal)
    : deadline;
  return fetch(input, { ...init, signal });
}

export const supabase = createClient(url || "http://localhost:0", key || "no-key", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchWithDeadline },
});

export function isDbReady() {
  return Boolean(url && key);
}
