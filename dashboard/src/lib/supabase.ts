import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://vvplkjgymahavqrejmgm.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2cGxramd5bWFoYXZxcmVqbWdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMxMzQ0MTUsImV4cCI6MjA2ODcxMDQxNX0.doQ5BUgcJzuCjSOUNeo-as50C41cHC3up-xlRY-dF0M";

// Auth-storage lock. History here matters:
//
// The SDK's default uses navigator.locks with its own acquire logic, which
// orphans under React Strict Mode (effect runs twice; first unmount doesn't
// release; second mount waits 5s before forcefully recovering) — that left
// the dashboard stuck on "Loading…", so it was replaced with a no-op lock.
//
// But the no-op removed ALL serialization of token refresh. Supabase
// rotates refresh tokens on use, so two concurrent refreshes — the SDK's
// auto-refresh timer racing our api.ts gate, or two tabs sharing
// localStorage — make the loser fail with "Invalid Refresh Token: Already
// Used", which can strand the whole session (the "stale tab stuck forever"
// failure mode).
//
// This lock restores serialization without the deadlock: wait up to
// LOCK_DEADLINE_MS for the Web Lock, and if it's still held (orphaned
// holder, dead tab), steal it rather than hang.
const LOCK_DEADLINE_MS = 3_000;

async function deadlineLock<R>(name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
  if (typeof navigator === "undefined" || !navigator.locks) return fn();
  try {
    return await navigator.locks.request(
      name,
      { signal: AbortSignal.timeout(LOCK_DEADLINE_MS) },
      fn,
    ) as R;
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      // Lock looks orphaned — steal it. The evicted holder (if any) gets
      // an AbortError, which the SDK treats as a failed refresh and
      // retries; strictly better than every caller hanging.
      return await navigator.locks.request(name, { steal: true }, fn) as R;
    }
    throw e;
  }
}

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    lock: deadlineLock,
  },
});

export type { Session };
