import { Router } from "express";
import express from "express";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { logGovernance } from "../lib/governance.js";

// OAuth 2.1 for the FPX Claude connector — "sign in with your FPX account".
// Everything is served under the dashboard's domain (Netlify proxies /mcp,
// /oauth/register, /oauth/token and the /.well-known documents here); the
// sign-in + "Allow Claude?" screen is the dashboard page /oauth/authorize.
//
//  1. Claude calls /mcp without a token → 401 + WWW-Authenticate pointing at
//     /.well-known/oauth-protected-resource → /.well-known/oauth-authorization-server
//  2. Claude registers itself (POST /oauth/register, RFC 7591)
//  3. The rep signs in on /oauth/authorize and clicks Allow → the dashboard
//     calls POST /api/oauth/approve → one-time code back to Claude
//  4. Claude swaps it (PKCE S256) at POST /oauth/token → access (1h) +
//     refresh (30d, rotating; reuse of an old one revokes the whole sign-in)
//
// Read-only scope only. Tokens and codes are stored hashed.

export const PUBLIC_BASE = (process.env.FPX_PUBLIC_URL || "https://fpxpress.netlify.app").replace(/\/$/, "");
export const MCP_RESOURCE = `${PUBLIC_BASE}/mcp`;
const SCOPE = "fpx.read";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_MS = 10 * 60_000;

// Where Claude may send people back to after Allow.
const REDIRECT_OK = [
  /^https:\/\/([a-z0-9-]+\.)*claude\.ai\//i,
  /^https:\/\/([a-z0-9-]+\.)*claude\.com\//i,
  /^https:\/\/([a-z0-9-]+\.)*anthropic\.com\//i,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i, // Claude Code / desktop local callbacks
];
const redirectAllowed = (u) => typeof u === "string" && u.length < 2000 && REDIRECT_OK.some((re) => re.test(u));

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (prefix) => `${prefix}${b64url(crypto.randomBytes(32))}`;

export const oauthRouter = Router();

// ---------- discovery ----------
const protectedResource = (_req, res) => res.json({
  resource: MCP_RESOURCE,
  authorization_servers: [PUBLIC_BASE],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "FPX (read-only)",
});
oauthRouter.get("/.well-known/oauth-protected-resource", protectedResource);
oauthRouter.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

const asMetadata = (_req, res) => res.json({
  issuer: PUBLIC_BASE,
  authorization_endpoint: `${PUBLIC_BASE}/oauth/authorize`,
  token_endpoint: `${PUBLIC_BASE}/oauth/token`,
  registration_endpoint: `${PUBLIC_BASE}/oauth/register`,
  revocation_endpoint: `${PUBLIC_BASE}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [SCOPE],
});
oauthRouter.get("/.well-known/oauth-authorization-server", asMetadata);
oauthRouter.get("/.well-known/oauth-authorization-server/mcp", asMetadata);
oauthRouter.get("/.well-known/openid-configuration", asMetadata);

// ---------- dynamic client registration (RFC 7591) ----------
oauthRouter.post("/oauth/register", express.json({ limit: "32kb" }), async (req, res) => {
  const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
  if (!uris.length || !uris.every(redirectAllowed)) {
    return res.status(400).json({ error: "invalid_redirect_uri", error_description: "Only Claude's callback addresses are accepted." });
  }
  const client_id = `fpxc_${b64url(crypto.randomBytes(18))}`;
  const client_name = String(req.body?.client_name || "Claude").slice(0, 100);
  const { error } = await supabase.from("fpx_oauth_clients").insert({ client_id, client_name, redirect_uris: uris.slice(0, 10) });
  if (error) return res.status(500).json({ error: "server_error", error_description: error.message });
  res.status(201).json({
    client_id, client_name, redirect_uris: uris.slice(0, 10), client_id_issued_at: Math.floor(Date.now() / 1000),
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE,
  });
});

async function getClient(client_id) {
  if (!client_id || typeof client_id !== "string") return null;
  const { data } = await supabase.from("fpx_oauth_clients").select("client_id, client_name, redirect_uris").eq("client_id", client_id).maybeSingle();
  return data || null;
}

// ---------- the dashboard's "Allow Claude?" screen ----------
// GET: who's asking (and is the request valid) — shown on the screen.
oauthRouter.get("/api/oauth/client", requireAuth({ acceptApiKey: false }), async (req, res) => {
  const c = await getClient(String(req.query.client_id || ""));
  if (!c) return res.status(400).json({ error: "Unknown app — start the connection again from Claude." });
  const redirect_uri = String(req.query.redirect_uri || "");
  if (!c.redirect_uris.includes(redirect_uri)) return res.status(400).json({ error: "This sign-in link doesn't match the app that registered. Start again from Claude." });
  res.json({ client_name: c.client_name, redirect_host: new URL(redirect_uri).host, scope: SCOPE });
});

// POST: the rep clicked Allow (or Deny) → where to send the browser next.
oauthRouter.post("/api/oauth/approve", requireAuth({ acceptApiKey: false }), express.json(), async (req, res) => {
  if (!req.user || req.impersonating) return res.status(403).json({ error: "Sign in as yourself to connect Claude" });
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, resource, decision } = req.body || {};
  const c = await getClient(client_id);
  if (!c || !c.redirect_uris.includes(redirect_uri)) return res.status(400).json({ error: "Invalid sign-in request — start again from Claude." });
  const back = new URL(redirect_uri);
  if (state) back.searchParams.set("state", String(state));
  if (decision !== "allow") {
    back.searchParams.set("error", "access_denied");
    return res.json({ redirect: back.toString() });
  }
  if (code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(String(code_challenge || ""))) {
    return res.status(400).json({ error: "Claude didn't send a valid PKCE challenge." });
  }
  const code = random("fpx_code_");
  const { error } = await supabase.from("fpx_oauth_codes").insert({
    code_hash: sha256(code), client_id, user_id: req.user.id, redirect_uri, code_challenge,
    scope: SCOPE, resource: resource ? String(resource).slice(0, 300) : null,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "create", entity_type: "oauth_grant",
    summary: `Connected Claude (${c.client_name}) to FPX — read-only`, metadata: { client_id, redirect_host: back.host },
  });
  logGovernance(req, { event_type: "mcp_connect", feature: "mcp", summary: `Connected Claude (${c.client_name}) — read-only`, metadata: { client_id } });
  back.searchParams.set("code", code);
  res.json({ redirect: back.toString() });
});

// ---------- token endpoint ----------
async function issueTokens({ client_id, user_id, family }) {
  const access = random("fpx_oat_");
  const refresh = random("fpx_ort_");
  const now = Date.now();
  const rows = [
    { token_hash: sha256(access), kind: "access", client_id, user_id, scope: SCOPE, family, expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString() },
    { token_hash: sha256(refresh), kind: "refresh", client_id, user_id, scope: SCOPE, family, expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString() },
  ];
  const { error } = await supabase.from("fpx_oauth_tokens").insert(rows);
  if (error) throw new Error(error.message);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

const tokenError = (res, status, error, description) => res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });

async function userEnabled(user_id) {
  const { data } = await supabase.from("fpx_user_profiles").select("enabled").eq("id", user_id).maybeSingle();
  return !!data?.enabled;
}

oauthRouter.post("/oauth/token", express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }), async (req, res) => {
  const b = req.body || {};
  try {
    if (b.grant_type === "authorization_code") {
      const code = String(b.code || "");
      const { data: row } = await supabase.from("fpx_oauth_codes").select("*").eq("code_hash", sha256(code)).maybeSingle();
      if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return tokenError(res, 400, "invalid_grant", "Code is invalid or expired");
      // One use only — mark it before anything else.
      const { data: claimed } = await supabase.from("fpx_oauth_codes").update({ used_at: new Date().toISOString() })
        .eq("code_hash", row.code_hash).is("used_at", null).select("code_hash");
      if (!claimed?.length) return tokenError(res, 400, "invalid_grant", "Code already used");
      if (b.client_id && b.client_id !== row.client_id) return tokenError(res, 400, "invalid_grant", "Code was issued to another app");
      if (b.redirect_uri && b.redirect_uri !== row.redirect_uri) return tokenError(res, 400, "invalid_grant", "redirect_uri mismatch");
      const verifier = String(b.code_verifier || "");
      if (!verifier || b64url(crypto.createHash("sha256").update(verifier).digest()) !== row.code_challenge) {
        return tokenError(res, 400, "invalid_grant", "PKCE verification failed");
      }
      if (!(await userEnabled(row.user_id))) return tokenError(res, 400, "invalid_grant", "FPX account disabled");
      const out = await issueTokens({ client_id: row.client_id, user_id: row.user_id, family: crypto.randomUUID() });
      return res.set("Cache-Control", "no-store").json(out);
    }
    if (b.grant_type === "refresh_token") {
      const hash = sha256(String(b.refresh_token || ""));
      const { data: row } = await supabase.from("fpx_oauth_tokens").select("*").eq("token_hash", hash).eq("kind", "refresh").maybeSingle();
      if (!row) return tokenError(res, 400, "invalid_grant", "Unknown refresh token");
      if (row.revoked_at) {
        // A refresh token used twice: treat the whole sign-in as compromised.
        await supabase.from("fpx_oauth_tokens").update({ revoked_at: new Date().toISOString() }).eq("family", row.family).is("revoked_at", null);
        return tokenError(res, 400, "invalid_grant", "Refresh token already used — sign in again");
      }
      if (Date.parse(row.expires_at) < Date.now()) return tokenError(res, 400, "invalid_grant", "Refresh token expired — sign in again");
      if (b.client_id && b.client_id !== row.client_id) return tokenError(res, 400, "invalid_grant", "Token was issued to another app");
      if (!(await userEnabled(row.user_id))) return tokenError(res, 400, "invalid_grant", "FPX account disabled");
      const { data: rotated } = await supabase.from("fpx_oauth_tokens").update({ revoked_at: new Date().toISOString() })
        .eq("token_hash", hash).is("revoked_at", null).select("token_hash");
      if (!rotated?.length) return tokenError(res, 400, "invalid_grant", "Refresh token already used");
      const out = await issueTokens({ client_id: row.client_id, user_id: row.user_id, family: row.family });
      return res.set("Cache-Control", "no-store").json(out);
    }
    return tokenError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  } catch (e) {
    return tokenError(res, 500, "server_error", e.message);
  }
});

// ---------- revocation (RFC 7009) — always 200 ----------
oauthRouter.post("/oauth/revoke", express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }), async (req, res) => {
  const token = String(req.body?.token || "");
  if (token) {
    const { data: row } = await supabase.from("fpx_oauth_tokens").select("family").eq("token_hash", sha256(token)).maybeSingle();
    if (row) await supabase.from("fpx_oauth_tokens").update({ revoked_at: new Date().toISOString() }).eq("family", row.family).is("revoked_at", null);
  }
  res.status(200).end();
});

// ---------- used by /mcp ----------
export async function resolveOAuthAccess(token) {
  if (!token || !token.startsWith("fpx_oat_")) return null;
  const { data: t } = await supabase.from("fpx_oauth_tokens").select("token_hash, user_id, client_id, expires_at, revoked_at, family")
    .eq("token_hash", sha256(token)).eq("kind", "access").maybeSingle();
  if (!t || t.revoked_at || Date.parse(t.expires_at) < Date.now()) return null;
  const { data: u } = await supabase.from("fpx_user_profiles").select("id, email, role, enabled").eq("id", t.user_id).maybeSingle();
  if (!u?.enabled) return null;
  supabase.from("fpx_oauth_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", t.token_hash).then(() => {});
  return { keyId: `oauth:${t.family}`, user: { id: u.id, email: u.email, role: u.role } };
}

// Revoke every Claude sign-in for a person (Connect Claude → Disconnect).
export async function revokeOAuthForUser(user_id) {
  const { data } = await supabase.from("fpx_oauth_tokens").update({ revoked_at: new Date().toISOString() })
    .eq("user_id", user_id).is("revoked_at", null).select("family");
  return new Set((data || []).map((r) => r.family)).size;
}

export async function oauthStatusForUser(user_id) {
  const { data } = await supabase.from("fpx_oauth_tokens").select("family, client_id, created_at, last_used_at, expires_at")
    .eq("user_id", user_id).eq("kind", "refresh").is("revoked_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  return (data || []).length;
}
