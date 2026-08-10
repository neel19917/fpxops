import crypto from "node:crypto";
import { supabase } from "./supabase.js";

// ============================================================
// API keys (extension / service-to-service)
// ============================================================
export function hashApiKey(plaintext) {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey() {
  const raw = crypto.randomBytes(32).toString("base64url");
  return `fpx_live_${raw}`;
}

// ============================================================
// Resolved-credential cache
//
// Every authenticated request used to pay two sequential Supabase round
// trips (auth.getUser + profile select for JWTs; key lookup for API keys)
// plus a fire-and-forget last_used/last_login write — ~100ms+ of latency
// tax on EVERY API call and a DB write per request. Cache the resolved
// identity per credential for a short TTL and throttle the "last seen"
// touches to once per TOUCH_INTERVAL_MS.
//
// Tradeoff (deliberate, same shape as the settings cache): a revoked key
// or freshly-disabled user keeps access for up to AUTH_CACHE_TTL_MS after
// the change. Failed resolutions are NOT cached, so a just-enabled user
// gets in immediately. Keys are sha256 of the credential so raw tokens
// never sit in the map.
// ============================================================
const AUTH_CACHE_TTL_MS = 60_000;
// Grace window past the TTL during which an expired entry is still kept
// around. It is NEVER served on the happy path — only as a fallback when
// re-resolution fails because *our* upstream broke (see resolveJwt). Without
// this, every 60s boundary that coincided with a Supabase blip turned into a
// 401, which made the browser force a token refresh for a reason that had
// nothing to do with its token — feeding the rotation race that was logging
// people out. Bounded so a revoked/disabled user still loses access promptly.
const AUTH_CACHE_STALE_MS = 10 * 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const AUTH_CACHE_MAX = 1000;
const authCache = new Map(); // sha256(credential) -> { at, value, touchedAt }

// Returns null, or { entry, stale }. `stale` means past TTL but inside the
// grace window — callers must opt in to using it.
function authCacheGet(credential) {
  const k = hashApiKey(credential);
  const hit = authCache.get(k);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age > AUTH_CACHE_TTL_MS + AUTH_CACHE_STALE_MS) {
    authCache.delete(k);
    return null;
  }
  return { entry: hit, stale: age > AUTH_CACHE_TTL_MS };
}

function authCacheSet(credential, value) {
  // Tokens rotate hourly, so the map self-renews; the cap is just a
  // backstop against pathological churn. Wholesale clear keeps it O(1).
  if (authCache.size >= AUTH_CACHE_MAX) authCache.clear();
  const entry = { at: Date.now(), value, touchedAt: Date.now() };
  authCache.set(hashApiKey(credential), entry);
  return entry;
}

// Called by the admin mutation routes (revoke key, disable user, role
// change) so those take effect immediately instead of after the TTL.
// Wholesale clear: the cache is keyed by credential hash, so we can't
// target one user's entries, and a 1000-entry rebuild is cheap.
export function clearAuthCache() {
  authCache.clear();
}

// True once per TOUCH_INTERVAL_MS per cache entry — gates the last_seen
// writes so they happen on a cadence instead of every request.
function shouldTouch(entry) {
  if (!entry) return true;
  if (Date.now() - entry.touchedAt < TOUCH_INTERVAL_MS) return false;
  entry.touchedAt = Date.now();
  return true;
}

async function resolveApiKey(key) {
  const cached = authCacheGet(key);
  // Fresh entries only — the stale grace window is a JWT-path affordance.
  // Serving a stale API key would extend the life of a revoked one.
  // Copies, not the cached object itself — requireAuth hangs these off
  // `req` where a route could mutate them and poison every later request.
  if (cached && !cached.stale) {
    return { ...cached.entry.value, scopes: [...cached.entry.value.scopes] };
  }
  const { data } = await supabase
    .from("fpx_api_keys")
    .select("id, name, scopes, revoked_at")
    .eq("key_hash", hashApiKey(key))
    .maybeSingle();
  if (!data || data.revoked_at) return null;
  const value = { id: data.id, name: data.name, scopes: data.scopes || [] };
  authCacheSet(key, value);
  supabase.from("fpx_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return value;
}

// ============================================================
// Supabase JWT (dashboard users)
// ============================================================
// Decode a JWT payload without verifying it — logging only, so we can say
// *which* token failed instead of printing an anonymous "Invalid session".
export function peekJwtClaims(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) || {};
  } catch {
    return {};
  }
}

// Was the token itself rejected, or did our call to Supabase fail?
//
// Only an explicit 401/403 from GoTrue means the credential is bad. A 0 or
// undefined status is a transport failure (DNS, TLS, connection reset, an
// aborted fetch); a 5xx is Supabase having a bad day. Both used to be reported
// to the browser as 401 "Invalid session", which reads as "refresh your token"
// — and a refresh provoked for no reason is what races the SDK's own rotation.
//
// Exported for testing: this one branch decides whether a blip logs a user out.
export function classifyGetUserError(error) {
  const status = error?.status;
  if (status === 401 || status === 403) return "invalid_token";
  return "upstream";
}

// resolveJwt returns a discriminated result rather than null-for-everything.
//
// It used to collapse four very different situations — an expired token, a
// network failure talking to GoTrue, a timed-out profile select, and a
// genuinely absent profile row — into `null`, which requireAuth turned into a
// blanket 401 "Invalid session". The browser treats 401 as "your token is
// stale, refresh it", so our own transient failures were provoking client
// token refreshes, and concurrent refreshes are what strand a session with
// "Invalid Refresh Token: Already Used".
//
//   { ok: true,  user }                 → authenticated
//   { ok: false, reason: "invalid_token" }   → 401, refreshing might help
//   { ok: false, reason: "profile_missing" } → 403, refreshing cannot help
//   { ok: false, reason: "upstream" }        → 503, retry, do NOT refresh
async function resolveJwt(token) {
  const cached = authCacheGet(token);
  if (cached && !cached.stale) {
    if (shouldTouch(cached.entry)) {
      supabase.from("fpx_user_profiles").update({ last_login_at: new Date().toISOString() }).eq("id", cached.entry.value.user.id).then(() => {});
    }
    // Copy — requireAuth hangs this off `req`, where a route could
    // mutate it and poison every later request on the same token.
    return { ok: true, user: { ...cached.entry.value.user } };
  }

  // When our own upstream fails, prefer a stale-but-known identity over
  // bouncing a user who did nothing wrong.
  const upstream = (detail) => {
    if (cached) {
      const ageS = Math.round((Date.now() - cached.entry.at) / 1000);
      console.warn(`[FPX-AUTH] upstream failed, serving identity ${ageS}s stale — ${detail}`);
      return { ok: true, user: { ...cached.entry.value.user }, stale: true };
    }
    return { ok: false, reason: "upstream", detail };
  };

  let res;
  try {
    res = await supabase.auth.getUser(token);
  } catch (e) {
    // A thrown fetch error or a DB_TIMEOUT_MS abort. Previously this escaped
    // requireAuth entirely and Express returned an unshaped 500.
    return upstream(`getUser threw: ${e?.message || e}`);
  }
  const { data, error } = res;
  if (error) {
    if (classifyGetUserError(error) === "invalid_token") {
      return { ok: false, reason: "invalid_token", detail: error.message };
    }
    return upstream(`getUser status=${error.status} ${error.message}`);
  }
  if (!data?.user) return { ok: false, reason: "invalid_token", detail: "no user on token" };

  // The profile error was previously discarded, which made an RLS hiccup or a
  // dropped connection indistinguishable from "this user has no profile row".
  const { data: profile, error: profileError } = await supabase
    .from("fpx_user_profiles")
    .select("id, email, full_name, role, enabled, avatar_url")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) return upstream(`profile select: ${profileError.message}`);
  if (!profile) return { ok: false, reason: "profile_missing", detail: data.user.email || data.user.id };

  const value = {
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      avatarUrl: profile.avatar_url,
      role: profile.role,
      enabled: profile.enabled,
    },
  };
  authCacheSet(token, value);
  // Fire-and-forget last_login_at touch (throttled by the cache above —
  // a fresh resolve only happens at most once per TTL per token).
  supabase.from("fpx_user_profiles").update({ last_login_at: new Date().toISOString() }).eq("id", profile.id).then(() => {});
  return { ok: true, user: { ...value.user } };
}

// ============================================================
// Impersonation ("view as another user")
//   x-fpx-impersonate:        target user id  → swap req.user to target
//   x-fpx-impersonate-write:  '1'             → also allow mutations
//
// Only honored when the real caller is an admin via JWT. API-key auth ignores
// these headers (impersonation is a UI debug aid, not a service-to-service tool).
// `req.realUser` always carries the actual admin so audit logs stay accurate
// even when `req.user` reflects the impersonated target.
// ============================================================
async function resolveImpersonationTarget(targetId) {
  if (!targetId || typeof targetId !== "string") return null;
  const { data, error } = await supabase
    .from("fpx_user_profiles")
    .select("id, email, full_name, role, enabled, avatar_url")
    .eq("id", targetId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    email: data.email,
    fullName: data.full_name,
    avatarUrl: data.avatar_url,
    role: data.role,
    enabled: data.enabled,
  };
}

// ============================================================
// Unified middleware
//   options.scope   -> required API-key scope (e.g. 'admin')
//   options.role    -> required JWT role (e.g. 'admin')
//   options.acceptApiKey  -> (default true) allow x-api-key auth
//   options.acceptJwt     -> (default true) allow Bearer JWT auth
//   options.requireEnabled -> (default true) when JWT, require enabled=true
// ============================================================
export function requireAuth(options = {}) {
  const acceptApiKey = options.acceptApiKey !== false;
  const acceptJwt = options.acceptJwt !== false;
  const requireEnabled = options.requireEnabled !== false;

  return async (req, res, next) => {
    const apiKey = acceptApiKey ? req.header("x-api-key") : null;
    const authHeader = acceptJwt ? req.header("authorization") || req.header("Authorization") || "" : "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1];

    if (apiKey) {
      const k = await resolveApiKey(apiKey);
      if (!k) return res.status(401).json({ error: "Invalid or revoked API key" });
      if (options.scope && !k.scopes.includes(options.scope)) {
        return res.status(403).json({ error: `API key lacks '${options.scope}' scope` });
      }
      req.apiKey = k;
      return next();
    }

    if (bearer) {
      const r = await resolveJwt(bearer);
      if (!r.ok) {
        const claims = peekJwtClaims(bearer);
        const who = claims.sub || "unknown";
        if (r.reason === "upstream") {
          // 503, not 401. A 401 tells the client its token is stale and makes
          // it refresh; this failure is ours, and refreshing here is what
          // used to trigger the concurrent-refresh logout.
          console.error(`[FPX-AUTH] 503 upstream sub=${who} — ${r.detail}`);
          res.set("Retry-After", "2");
          return res.status(503).json({ error: "Auth backend unavailable — retry.", code: "auth_upstream" });
        }
        if (r.reason === "profile_missing") {
          console.warn(`[FPX-AUTH] 403 profile_missing sub=${who} (${r.detail})`);
          return res.status(403).json({
            error: "No profile exists for this account. An admin needs to add you.",
            code: "profile_missing",
          });
        }
        console.warn(`[FPX-AUTH] 401 invalid_token sub=${who} exp=${claims.exp} — ${r.detail}`);
        return res.status(401).json({ error: "Invalid session", code: "invalid_token" });
      }
      const v = { user: r.user };

      // Impersonation handshake (admin-only, JWT-only). The real admin must
      // be enabled + admin-role to impersonate; the target's enabled flag is
      // checked afterward via the route's requireEnabled.
      const impersonateId = req.header("x-fpx-impersonate");
      const writeOptIn = req.header("x-fpx-impersonate-write") === "1";
      if (impersonateId && impersonateId !== v.user.id) {
        if (!v.user.enabled) {
          return res.status(403).json({ error: "Your account is not yet enabled. An admin needs to activate it." });
        }
        if (v.user.role !== "admin") {
          return res.status(403).json({ error: "Impersonation requires admin role." });
        }
        const target = await resolveImpersonationTarget(impersonateId);
        if (!target) return res.status(404).json({ error: "Impersonation target not found" });
        const isMutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
        if (isMutation && !writeOptIn) {
          console.warn(`[FPX-IMPERSONATE] BLOCKED ${req.method} ${req.path} — admin=${v.user.email} target=${target.email} reason=read_only`);
          return res.status(403).json({
            error: "Impersonation is read-only. Enable write impersonation to perform this action.",
          });
        }
        req.realUser = v.user;
        req.user = target;
        req.impersonating = { mode: writeOptIn ? "write" : "read", target };
        console.log(`[FPX-IMPERSONATE] ${req.impersonating.mode.toUpperCase()} ${req.method} ${req.path} — admin=${v.user.email} as=${target.email}`);
      } else {
        req.user = v.user;
        req.realUser = v.user;
      }

      // Now enforce the route's enabled requirement. /api/me deliberately
      // passes requireEnabled:false so a pending-approval user can still
      // read their own profile to find out *why* they're locked out.
      if (requireEnabled && !req.user.enabled) {
        return res.status(403).json({ error: "Your account is not yet enabled. An admin needs to activate it." });
      }
      if (options.role && req.user.role !== options.role && req.user.role !== "admin") {
        // 'admin' is a superset — always allowed.
        return res.status(403).json({ error: `Requires '${options.role}' role` });
      }
      return next();
    }

    return res.status(401).json({ error: "Missing credentials (x-api-key or Bearer token)" });
  };
}

// Back-compat alias — older routes imported `requireApiKey`.
export function requireApiKey(options = {}) {
  return requireAuth({ ...options, acceptJwt: false });
}

// ============================================================
// Bootstrap
// ============================================================
export async function bootstrapAdminKey() {
  const plaintext = process.env.FPX_BOOTSTRAP_ADMIN_KEY;
  if (!plaintext) return;
  const key_hash = hashApiKey(plaintext);
  const { data: existing } = await supabase
    .from("fpx_api_keys").select("id").eq("key_hash", key_hash).maybeSingle();
  if (existing) { console.log("[FPX] Bootstrap admin key already present."); return; }
  const { error } = await supabase.from("fpx_api_keys").insert({
    name: "bootstrap-admin",
    key_hash,
    key_prefix: plaintext.slice(0, 12),
    scopes: ["read", "write", "admin"],
    created_by: "bootstrap",
  });
  if (error) console.warn("[FPX] Bootstrap admin insert failed:", error.message);
  else console.log("[FPX] Bootstrap admin key registered.");
}

// Promote a specific email to admin on startup, once. Idempotent.
export async function bootstrapAdminEmail() {
  const email = process.env.FPX_BOOTSTRAP_ADMIN_EMAIL;
  if (!email) return;
  const { data, error } = await supabase
    .from("fpx_user_profiles")
    .update({ role: "admin", enabled: true })
    .ilike("email", email)
    .select("id, email");
  if (error) console.warn("[FPX] Bootstrap admin email failed:", error.message);
  else if (data && data.length) console.log(`[FPX] Bootstrap admin: ${email} set to enabled admin.`);
  else console.log(`[FPX] Bootstrap admin email ${email} not found yet — will take effect after first login.`);
}
