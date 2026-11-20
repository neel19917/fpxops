// Microsoft Graph access for the support mailbox.
//
// The Entra app has NO Graph application permissions in Entra; its reach is
// granted only by Exchange Online RBAC for Applications, scoped to the one
// mailbox. Every call goes to /users/{mailbox}/... with
// Prefer: IdType="ImmutableId" so message ids survive folder moves.
import crypto from "node:crypto";
import { supabase } from "../supabase.js";
import { decryptSecret } from "./crypto.js";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';
const MAX_TRIES = 6;
const REQUEST_TIMEOUT_MS = 60_000;

// Swappable in tests.
export const _deps = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// App token (client credentials)

const tokenCache = new Map(); // key -> { token, expiresAt }
export const _clearTokenCache = () => tokenCache.clear();

function tokenKey({ tenant_id, client_id, client_secret }) {
  // Per client_id; the tenant and a hash of the secret are folded in so a
  // reconnect with a new secret never reuses a token minted for the old one.
  const h = crypto.createHash("sha256").update(String(client_secret || "")).digest("hex").slice(0, 16);
  return `${client_id}|${tenant_id}|${h}`;
}

export async function getAppToken({ tenant_id, client_id, client_secret }) {
  if (!tenant_id || !client_id || !client_secret) throw new Error("Mailbox app tenant_id, client_id and client_secret are required");
  const key = tokenKey({ tenant_id, client_id, client_secret });
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - 2 * 60_000 > _deps.now()) return hit.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id,
    client_secret,
    scope: "https://graph.microsoft.com/.default",
  });
  let res;
  try {
    res = await _deps.fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant_id)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`Microsoft sign-in did not answer: ${e?.message || e}`);
    err.status = 0;
    err.source = "token";
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const desc = String(json.error_description || json.error || `HTTP ${res.status}`).split(/\r?\n/)[0];
    const err = new Error(`Microsoft sign-in failed: ${desc}`);
    err.status = res.status;
    err.source = "token";
    err.code = json.error;
    throw err;
  }
  tokenCache.set(key, { token: json.access_token, expiresAt: _deps.now() + (Number(json.expires_in) || 3600) * 1000 });
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Graph requests

export function buildGraphUrl(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${GRAPH_BASE}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

// Combines the ImmutableId preference with any the caller asks for
// (e.g. odata.maxpagesize=100) into one Prefer header.
export function mergePrefer(extra) {
  const parts = [IMMUTABLE_ID_PREFER];
  for (const p of String(extra || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!/^IdType=/i.test(p)) parts.push(p);
  }
  return parts.join(", ");
}

// Retry-After is seconds or an HTTP date. Returns ms, or null when absent/unreadable.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export function backoffMs(attempt) {
  return Math.min(60_000, 1000 * 2 ** attempt);
}

const RETRY_STATUSES = new Set([429, 503, 504]);

export async function graphFetch(conn, pathOrUrl, { method = "GET", body, headers = {} } = {}) {
  const url = buildGraphUrl(pathOrUrl);
  let refreshedToken = false;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const token = await getAppToken(conn);
    const extraPrefer = headers.Prefer ?? headers.prefer;
    const h = { ...headers };
    delete h.prefer;
    h.Prefer = mergePrefer(extraPrefer);
    h.Authorization = `Bearer ${token}`;
    if (body !== undefined && h["Content-Type"] == null) h["Content-Type"] = "application/json";

    let res;
    try {
      res = await _deps.fetch(url, {
        method,
        headers: h,
        body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // Network failure / timeout: back off and try again.
      lastErr = Object.assign(new Error(`Microsoft Graph did not answer: ${e?.message || e}`), { status: 0 });
      if (attempt < MAX_TRIES - 1) await _deps.sleep(backoffMs(attempt));
      continue;
    }

    if (res.status === 202 || res.status === 204) return null;
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (res.ok) return json ?? (text || null);

    const gErr = json?.error || {};
    const err = new Error(gErr.message || `Microsoft Graph HTTP ${res.status}`);
    err.status = res.status;
    err.code = gErr.code;
    lastErr = err;

    if (res.status === 401 && !refreshedToken) {
      // Token revoked or rotated under us: mint a fresh one once.
      refreshedToken = true;
      tokenCache.delete(tokenKey(conn));
      continue;
    }
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_TRIES - 1) {
      const wait = parseRetryAfter(res.headers?.get?.("retry-after"), _deps.now()) ?? backoffMs(attempt);
      await _deps.sleep(Math.min(wait, 120_000));
      continue;
    }
    throw err;
  }
  throw lastErr || new Error("Microsoft Graph request failed");
}

export const mailboxPath = (mailbox) => `/users/${encodeURIComponent(mailbox)}`;

// ---------------------------------------------------------------------------
// Connection rows

function withSecret(row) {
  if (!row) return null;
  return { ...row, client_secret: decryptSecret(row.secret_enc) };
}

// Newest connection (by updated_at), decrypted. Disconnected rows are skipped
// unless asked for.
export async function loadConnection({ includeDisconnected = false } = {}) {
  let q = supabase.from("fpx_mailbox_connections").select("*");
  if (!includeDisconnected) q = q.neq("status", "disconnected");
  const { data, error } = await q.order("updated_at", { ascending: false }).limit(1);
  if (error) throw new Error(`Mailbox connection not read: ${error.message}`);
  return withSecret(data?.[0] || null);
}

export async function loadConnectionById(id) {
  const { data, error } = await supabase.from("fpx_mailbox_connections").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Mailbox connection not read: ${error.message}`);
  return withSecret(data || null);
}

export function publicConnection(row) {
  if (!row) return null;
  const { secret_enc, client_secret, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Connection test

export function explainGraphError(err, mailbox) {
  const status = err?.status;
  if (err?.source === "token") {
    return `${err.message}. Check the Directory (tenant) ID, Application (client) ID and client secret (secrets expire; use the secret's Value, not its ID).`;
  }
  if (status === 401 || status === 403) {
    return `Microsoft accepted the app's sign-in but refused access to ${mailbox}. The Exchange Online role assignment ` +
      `(Application Mail.ReadWrite with a management scope for this mailbox) is missing or has not taken effect yet — ` +
      `it can take up to 2 hours after New-ManagementRoleAssignment. Run Test-ServicePrincipalAuthorization in Exchange Online PowerShell to check, then try again.`;
  }
  if (status === 404) {
    return `Mailbox ${mailbox} was not found (or is not an Exchange Online mailbox). Check the address.`;
  }
  return err?.message || String(err);
}

export async function testConnection({ tenant_id, client_id, client_secret, mailbox }) {
  const conn = { tenant_id, client_id, client_secret, mailbox };
  try {
    const base = `${mailboxPath(mailbox)}/mailFolders`;
    const [inbox, sent] = await Promise.all([
      graphFetch(conn, `${base}/inbox?$select=id,totalItemCount`),
      graphFetch(conn, `${base}/sentitems?$select=id,totalItemCount`),
    ]);
    return { ok: true, inbox_total: Number(inbox?.totalItemCount) || 0, sent_total: Number(sent?.totalItemCount) || 0 };
  } catch (e) {
    return { ok: false, error: explainGraphError(e, mailbox) };
  }
}
