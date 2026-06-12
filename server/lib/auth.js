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
const TOUCH_INTERVAL_MS = 5 * 60_000;
const AUTH_CACHE_MAX = 1000;
const authCache = new Map(); // sha256(credential) -> { at, value, touchedAt }

function authCacheGet(credential) {
  const k = hashApiKey(credential);
  const hit = authCache.get(k);
  if (!hit || Date.now() - hit.at > AUTH_CACHE_TTL_MS) {
    authCache.delete(k);
    return null;
  }
  return hit;
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
  // Copies, not the cached object itself — requireAuth hangs these off
  // `req` where a route could mutate them and poison every later request.
  if (cached) return { ...cached.value, scopes: [...cached.value.scopes] };
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
async function resolveJwt(token) {
  const cached = authCacheGet(token);
  if (cached) {
    if (shouldTouch(cached)) {
      supabase.from("fpx_user_profiles").update({ last_login_at: new Date().toISOString() }).eq("id", cached.value.user.id).then(() => {});
    }
    // Copy — requireAuth hangs this off `req`, where a route could
    // mutate it and poison every later request on the same token.
    return { user: { ...cached.value.user } };
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await supabase
    .from("fpx_user_profiles")
    .select("id, email, full_name, role, enabled, avatar_url")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile) return null;
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
  return value;
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
      const v = await resolveJwt(bearer);
      if (!v) return res.status(401).json({ error: "Invalid session" });

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
