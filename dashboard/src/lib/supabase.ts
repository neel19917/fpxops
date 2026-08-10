import { createClient, type Session } from "@supabase/supabase-js";

// Env is the only source of truth for these. There used to be hardcoded
// fallbacks here, which meant a missing or misspelled Netlify env var built
// green and silently targeted the baked-in project with no failure signal.
// Dev fails loudly; prod only warns, because a throw here white-screens the
// whole app and the browser console is where an operator would look anyway.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  const missing = [
    !SUPABASE_URL ? "VITE_SUPABASE_URL" : null,
    !SUPABASE_ANON_KEY ? "VITE_SUPABASE_ANON_KEY" : null,
  ].filter(Boolean).join(", ");
  const msg = `Supabase config missing at build time: ${missing}. Set it in Netlify → Site configuration → Environment variables (and in dashboard/.env locally).`;
  if (import.meta.env.DEV) throw new Error(msg);
  console.error(msg);
}

// Token-refresh serialization. History here matters, because this file has now
// been wrong in two opposite directions:
//
// 1. The SDK's default navigator.locks-based lock was replaced with a no-op,
//    to fix the dashboard hanging on "Loading…". That removed ALL
//    serialization of token refresh.
// 2. The no-op was replaced with a lock that waited 3s and then took the lock
//    with `{ steal: true }`. That was worse. Supabase rotates refresh tokens
//    on use, so stealing the lock from a holder that had already POSTed to
//    /auth/v1/token aborted it *after* the server rotated — the new token was
//    never persisted, and the stored one became "Invalid Refresh Token:
//    Already Used". That is a non-retryable AuthApiError, so GoTrue calls
//    _removeSession() and broadcasts SIGNED_OUT to every tab. It was the
//    direct cause of users being bounced to the sign-in screen mid-session.
//
// The custom lock also discarded the SDK's `acquireTimeout` argument. That
// argument is a contract (see @supabase/auth-js/lib/locks.js): negative means
// wait forever, positive means wait that long, and **0 means fail immediately
// if the lock is held**. The auto-refresh ticker passes 0 precisely so it can
// skip a tick when a refresh is already running — GoTrueClient catches the
// resulting error via `e.isAcquireTimeout` and logs "auto refresh token tick
// lock not available". Turning that "skip" into "wait 3s then evict" is what
// manufactured the concurrent refresh in the first place.
//
// The fix is a lock that honours the contract and NEVER steals.
//
// Why not just drop the override and use the SDK's default? Because the SDK's
// own navigatorLock also steals once its acquire timeout fires — its option
// docs literally read "5 seconds, then steal orphaned lock" — and that timeout
// is only configurable via the `lockAcquireTimeout` client option, which
// supabase-js does not forward. Its `_initSupabaseAuthClient` destructures a
// fixed key list ({ autoRefreshToken, persistSession, detectSessionInUrl,
// storage, userStorage, storageKey, flowType, lock, debug, throwOnError }) and
// silently drops everything else. `lock` is the only knob that gets through,
// so overriding it is the only way to control this.
//
// Not stealing is safe: the browser releases a Web Lock automatically when the
// holding page goes away, so a lock can only be "orphaned" by a live tab whose
// promise never settles — and the two things that used to cause that (an
// aborted refresh fetch, and awaiting a PostgREST query inside
// onAuthStateChange) are both fixed, here and in auth.tsx. A failed acquire is
// retryable and keeps the session; a steal destroys it.
const LOCK_WAIT_MS = 15_000;

// GoTrueClient decides whether a failed acquire is benign by checking
// `e.isAcquireTimeout` (it also accepts its own LockAcquireTimeoutError, but
// that class lives in @supabase/auth-js, a transitive dep we shouldn't import
// from). With this flag set, the auto-refresh ticker logs "lock not available"
// and simply waits for the next tick.
function lockUnavailable(message: string): Error {
  const e = new Error(message) as Error & { isAcquireTimeout: true };
  e.isAcquireTimeout = true;
  return e;
}

async function serialLock<R>(name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
  if (typeof navigator === "undefined" || !navigator.locks) return fn();

  // 0 = the auto-refresh ticker's non-blocking probe: "run only if nobody else
  // is refreshing." Ignoring this argument is what turned a harmless skipped
  // tick into a mid-refresh eviction every 30 seconds.
  if (acquireTimeout === 0) {
    return await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) throw lockUnavailable(`auth lock '${name}' is held; skipping`);
      return await fn();
    }) as R;
  }

  // Negative = wait indefinitely.
  if (acquireTimeout < 0) {
    return await navigator.locks.request(name, fn) as R;
  }

  // Positive: wait up to our own ceiling, then fail. The SDK passes 5000 here;
  // we deliberately wait longer, because the ceiling needs to exceed the
  // worst-case hold (one refresh round-trip plus subscriber callbacks) or
  // contention becomes routine.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LOCK_WAIT_MS);
  try {
    return await navigator.locks.request(name, { signal: ctl.signal }, async () => {
      // Granted — stop the acquire timer immediately. Leaving it armed would
      // abort a signal we already hold the lock under.
      clearTimeout(timer);
      return await fn();
    }) as R;
  } catch (e) {
    if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw lockUnavailable(`timed out after ${LOCK_WAIT_MS}ms acquiring auth lock '${name}'`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// supabase-js calls fetch with no deadline by default. The boot path and every
// page query need one, or a single stalled request (a dead socket, a service
// worker or extension intercepting the call) pins the UI forever.
const FETCH_DEADLINE_MS = 12_000;

// ...with one exception, and it is not negotiable: the token endpoint gets NO
// deadline at all. `_refreshAccessToken` wraps the POST in the SDK's
// `retryable()` helper, and an AbortSignal abort is classified as an
// AuthRetryableFetchError — so aborting the POST makes the SDK re-send the
// SAME refresh token ~200 ms later. If the server had already rotated before
// our abort landed, that retry gets a 400 "Already Used", which IS
// non-retryable, and the session is destroyed. An abort here doesn't just
// strand the refresh, it actively converts a slow success into a hard logout.
// Upstream puts no timeout on this call either. Observed /token latency on this
// project is 48–440 ms, so a hang here is a network fault rather than slowness;
// the browser releases the auth lock when the tab goes away, and other callers
// fail their acquire (retryably) rather than blocking forever.
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetchWithDeadline(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (requestUrl(input).includes("/auth/v1/token")) {
    return fetch(input, init);
  }
  const deadline = AbortSignal.timeout(FETCH_DEADLINE_MS);
  const signal = init.signal
    ? ("any" in AbortSignal ? AbortSignal.any([init.signal, deadline]) : init.signal)
    : deadline;
  return fetch(input, { ...init, signal });
}

export const sb = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    lock: serialLock,
  },
  global: { fetch: fetchWithDeadline },
});

export type { Session };
