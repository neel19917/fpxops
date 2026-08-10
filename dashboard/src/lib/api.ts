import type {
  AiAnalysis, ApiKey, AuditLogEntry, CarrierFollowupShipment, EmailDraft, Feedback, GpAudit, GpAuditRow,
  InvoiceAudit, InvoiceAuditRow, ReanalyzeCurrent, ReanalyzePreview, Shipment, ShareLink, ShareLinkView, ShipmentNote, ShipmentTask, UserProfileRow,
} from "./types";
import { sb } from "./supabase";
import { impersonateHeaders } from "./impersonate";

const API_URL = (import.meta.env.VITE_FPX_API_URL || "http://localhost:3210").replace(/\/$/, "");

// Auth gate.
//
// There is exactly ONE proactive refresh driver in this app now: the SDK's
// own autoRefreshToken ticker (30s tick, refreshes within ~90s of expiry,
// plus a visibilitychange handler that recovers a backgrounded tab). This
// file used to be a second driver and auth.tsx#bootSession a third, each
// with its own 60s expiry skew. Three drivers racing to rotate a
// single-use refresh token is how a session gets stranded with "Invalid
// Refresh Token: Already Used" — a non-retryable error that makes GoTrue
// drop the session and broadcast SIGNED_OUT to every tab.
//
// So: ask getSession() for a token and trust it. The SDK refreshes it when
// it needs refreshing. The only refresh we initiate is the *reactive* one
// below, after the server has actually rejected a token with a 401.
//
// The gate timeout only covers the cold-boot case where Supabase hasn't
// finished hydrating from localStorage / the OAuth hash yet. 2500ms was far
// too tight: it fired on any contended cold boot and rejected a perfectly
// valid session with what read to the user as a logout.
const AUTH_GATE_TIMEOUT_MS = 15_000;
// Hard deadlines on every network round-trip. Without these, a stalled
// connection (laptop slept mid-request, dead proxy, Supabase hiccup in a
// long-lived dev tab) left pages awaiting forever on an infinite
// "Loading…" — the auth gate and the fetch itself had no timeout. A
// stall now surfaces as a retryable error instead of a hang.
const FETCH_TIMEOUT_MS = 20_000;
// Must exceed supabase.ts's `lockAcquireTimeout` (15s): getSession() acquires
// the auth lock, so in the orphaned-holder case it legitimately blocks until
// the SDK's steal-recovery kicks in. At 6s we bailed out mid-recovery and
// treated a recoverable stall as "no session".
const AUTH_CALL_TIMEOUT_MS = 18_000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

// Single-flight guard for sb.auth.refreshSession(), so a page firing six
// parallel requests that all 401 triggers ONE refresh round-trip.
//
// Deliberately NOT wrapped in withDeadline: that helper resolves null on
// timeout without aborting the underlying promise, so a slow refresh went on
// to rotate the token behind a caller that had already given up and fired a
// second refresh — the same "Already Used" strand it was meant to avoid. The
// refresh fetch carries its own generous ceiling in supabase.ts instead.
let _refreshInflight: Promise<string | null> | null = null;
function refreshSessionOnce(): Promise<string | null> {
  if (_refreshInflight) return _refreshInflight;
  _refreshInflight = (async () => {
    try {
      const res = await sb.auth.refreshSession();
      if (res.error || !res.data.session?.access_token) return null;
      return res.data.session.access_token;
    } catch {
      return null;
    } finally {
      // Clear on the next tick so a follow-up burst that's already in flight
      // can still ride along; subsequent requests get a fresh attempt.
      setTimeout(() => { _refreshInflight = null; }, 0);
    }
  })();
  return _refreshInflight;
}

async function getAccessTokenOrWait(): Promise<string> {
  // getSession() is usually a local read, but it can block on the SDK's
  // internal initialize (and on the auth lock while a refresh is in flight) —
  // same deadline treatment as the boot path in auth.tsx.
  const got = await withDeadline(sb.auth.getSession(), AUTH_CALL_TIMEOUT_MS);
  const token = got?.data.session?.access_token;
  if (token) return token;

  // Nothing yet — we're mid-hydration. Wait for onAuthStateChange to deliver
  // a session rather than trying to force one into existence ourselves.
  return new Promise<string>((resolve, reject) => {
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => {
      if (s?.access_token) {
        sub.subscription.unsubscribe();
        clearTimeout(timer);
        resolve(s.access_token);
      }
    });
    const timer = setTimeout(() => {
      sub.subscription.unsubscribe();
      // Deliberately not "Not signed in." — reaching this timer means the SDK
      // never produced a session, which is far more often a stalled boot than
      // an actually signed-out user, and the old wording sent people off to
      // re-authenticate for no reason.
      reject(new Error("Session is still initializing — retry in a moment."));
    }, AUTH_GATE_TIMEOUT_MS);
  });
}

async function request<T>(path: string, init?: RequestInit & { params?: Record<string, string | number | undefined>; noImpersonate?: boolean }): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.params || {})) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const q = search.toString();
  const full = `${API_URL}${path}${q ? `?${q}` : ""}`;

  async function fire(token: string) {
    try {
      return await fetch(full, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          // Impersonation headers are skipped on meta-operations (start/stop/toggle)
          // so the request is attributed to the real admin server-side.
          ...(init?.noImpersonate ? {} : impersonateHeaders()),
          ...(init?.headers || {}),
        },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${path}`);
      }
      throw e;
    }
  }

  let accessToken = await getAccessTokenOrWait();
  let resp = await fire(accessToken);
  // The one place we initiate a refresh: a 401 means the access token really
  // was rejected server-side. Force a refresh and retry exactly once before
  // propagating the failure. Routes through the single-flight guard so a page
  // firing 6 parallel requests on mount only triggers ONE refresh round-trip.
  if (resp.status === 401) {
    const refreshed = await refreshSessionOnce();
    if (refreshed) {
      accessToken = refreshed;
      resp = await fire(accessToken);
    }
  } else if (resp.status === 503) {
    // The server couldn't verify our token because ITS upstream call failed
    // (Supabase hiccup, profile query timeout) — our token is fine. Retry
    // once WITHOUT refreshing. Refreshing here is what used to feed the
    // rotation race: a transient server-side blip on the 60s auth-cache
    // boundary would force a client refresh for reasons unrelated to the
    // token's validity.
    await new Promise((r) => setTimeout(r, 400));
    resp = await fire(accessToken);
  }
  if (!resp.ok) {
    const text = await resp.text();
    try {
      const body = JSON.parse(text);
      throw new Error(body.error || text.slice(0, 200));
    } catch {
      throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
    }
  }
  return resp.json();
}

// Public fetch (no auth, used by share viewer).
async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!resp.ok) {
    const text = await resp.text();
    try {
      const body = JSON.parse(text);
      throw new Error(body.error || text.slice(0, 200));
    } catch { throw new Error(`${resp.status}: ${text.slice(0, 200)}`); }
  }
  return resp.json();
}

export const apiUrl = API_URL;

// Client-visible configuration bundled into /api/me. Add new flags here in
// lockstep with server/routes/me.js#loadClientConfig.
export interface ClientConfig {
  embed_freightpop: {
    enabled: boolean;
    url_template: string;
  };
  // How long the "Changed Xh ago" pill stays on Tracking rows after
  // the most recent material change. Admin-tunable from Settings;
  // 0 hides the pill entirely (the column itself is unaffected).
  tracking_ui: {
    recent_change_window_hours: number;
    // Master parcel switch. When false (default), the Tracking page hides
    // parcel-mode rows and the server skips auto-tasks for parcels. Admin-
    // tunable from Settings (key: ui.tracking.show_parcels).
    show_parcels: boolean;
  };
}

export const api = {
  health: () => fetch(`${API_URL}/health`).then((r) => r.json()),

  me: {
    get: () => request<{
      kind: string;
      user?: { id: string; email: string; role: string; enabled: boolean };
      pending_api_key?: string | null;
      client_config?: ClientConfig;
    }>("/api/me"),
  },

  impersonate: {
    start: (target_id: string, writes: boolean) =>
      request<{ ok: boolean }>("/api/me/impersonate-start", {
        method: "POST",
        body: JSON.stringify({ target_id, writes }),
        noImpersonate: true,
      }),
    stop: (target_id: string | null, writes_were: boolean) =>
      request<{ ok: boolean }>("/api/me/impersonate-stop", {
        method: "POST",
        body: JSON.stringify({ target_id, writes_were }),
        noImpersonate: true,
      }),
    toggleWrites: (target_id: string, writes: boolean) =>
      request<{ ok: boolean }>("/api/me/impersonate-toggle-writes", {
        method: "POST",
        body: JSON.stringify({ target_id, writes }),
        noImpersonate: true,
      }),
  },

  shipments: {
    list: (params?: { limit?: number; customer?: string; action?: string; status?: string; q?: string; source?: string; before?: string }) =>
      request<{ data: Shipment[]; next_cursor: string | null }>("/api/shipments", { params }),
    get: (id: string) => request<{ shipment: Shipment; analyses: AiAnalysis[]; history: Shipment[]; tasks: ShipmentTask[]; notes_log: ShipmentNote[]; recent_diff: ShipmentRecentDiff | null }>(`/api/shipments/${id}`),
    overrideAction: (id: string, body: { action_required: string | null; reason?: string }) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/action`, { method: "PATCH", body: JSON.stringify(body) }),
    reanalyze: (id: string) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/reanalyze`, { method: "POST" }),
    // Run a fresh analysis on the chosen model and return the proposed
    // verdict WITHOUT persisting it (powers the Re-analyze modal). The run is
    // logged to fpx_ai_analyses; the shipment only changes on applyReanalysis.
    reanalyzePreview: (id: string, model?: string) =>
      request<{ preview: ReanalyzePreview; current: ReanalyzeCurrent }>(
        `/api/shipments/${id}/reanalyze/preview`,
        { method: "POST", body: JSON.stringify({ model }) },
      ),
    // Commit a previewed analysis onto the shipment (writes an audit entry).
    applyReanalysis: (id: string, analysisId: string) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/reanalyze/apply`, {
        method: "POST",
        body: JSON.stringify({ analysis_id: analysisId }),
      }),
    updateNotes: (id: string, notes: string | null) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/notes`, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      }),
    // Append one entry to the shipment's notes log (the editable single
    // field has been replaced by this running log). Returns the new entry
    // plus the shipment with its denormalized latest-note column updated.
    addNote: (id: string, body: string) =>
      request<{ note: ShipmentNote; shipment: Shipment | null }>(`/api/shipments/${id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    bulkDelete: (ids: string[]) =>
      request<{ deleted: number }>(`/api/shipments/bulk-delete`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    // True counts over the whole dataset (not just the loaded page). The
    // status pills fold `statuses` through the client's STATUS_MATCHERS.
    stats: (parcels?: boolean) =>
      request<{ total: number; issues: number; statuses: Record<string, number> }>(
        "/api/shipments/stats",
        { params: { parcels: parcels ? "1" : "0" } },
      ),
    // Background batch re-analysis — replaces stored verdicts for the selection.
    bulkReanalyze: (ids: string[]) =>
      request<{ queued: number; capped: boolean; scope?: string }>(`/api/shipments/bulk-reanalyze`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    // Re-analyze every shipment (latest row per tracking). Server enumerates the
    // ids; background-processed like bulkReanalyze.
    reanalyzeAll: () =>
      request<{ queued: number; capped: boolean; scope?: string }>(`/api/shipments/bulk-reanalyze`, {
        method: "POST",
        body: JSON.stringify({ scope: "all" }),
      }),
  },
  analyses: {
    list: (params?: {
      limit?: number;
      kind?: string;
      tracking_number?: string;
      model?: string;
      user_email?: string;
      source?: string;
      from?: string;
      to?: string;
      rating?: "up" | "down" | "unrated";
    }) => request<{ data: AiAnalysis[] }>("/api/analyses", { params }),
    // Reps rate AI generations 👍 / 👎 so the team can iterate on
    // prompts. Passing rating=null clears a prior rating (mistaken
    // click). Reason is optional but encouraged on 👎.
    rate: (id: string, body: { rating: "up" | "down" | null; reason?: string }) =>
      request<{ analysis: { id: string; rating: "up" | "down" | null; rating_reason: string | null; rated_by: string | null; rated_at: string | null } }>(
        `/api/analyses/${id}/rating`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  },
  audits: {
    gp: {
      list: () => request<{ data: GpAudit[] }>("/api/audits/gp"),
      get: (id: string) => request<{ run: GpAudit; rows: GpAuditRow[] }>(`/api/audits/gp/${id}`),
      reanalyze: (id: string, level: "summary" | "full" = "summary") =>
        request<{ run: GpAudit }>(`/api/audits/gp/${id}/reanalyze`, {
          method: "POST",
          body: JSON.stringify({ level }),
        }),
    },
    invoice: {
      list: () => request<{ data: InvoiceAudit[] }>("/api/audits/invoice"),
      get: (id: string) => request<{ run: InvoiceAudit; rows: InvoiceAuditRow[] }>(`/api/audits/invoice/${id}`),
      reanalyze: (id: string, level: "summary" | "full" = "summary") =>
        request<{ run: InvoiceAudit }>(`/api/audits/invoice/${id}/reanalyze`, {
          method: "POST",
          body: JSON.stringify({ level }),
        }),
    },
  },
  apiKeys: {
    list: () => request<{ data: ApiKey[] }>("/api-keys"),
    create: (name: string, scopes: string[]) =>
      request<{ key: ApiKey; plaintext: string; warning: string }>("/api-keys", {
        method: "POST",
        body: JSON.stringify({ name, scopes }),
      }),
    revoke: (id: string) => request<{ ok: boolean }>(`/api-keys/${id}`, { method: "DELETE" }),
  },
  users: {
    list: () => request<{ data: UserProfileRow[] }>("/api/users"),
    update: (id: string, body: { enabled?: boolean; role?: string; full_name?: string | null }) =>
      request<{ user: UserProfileRow }>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    issueKey: (id: string) =>
      request<{
        key: { id: string; name: string; key_prefix: string; scopes: string[]; created_at: string };
        plaintext: string;
        user_id: string;
        expires_at: string;
        revoked_count: number;
      }>(`/api/users/${id}/issue-key`, { method: "POST" }),
  },
  shareLinks: {
    list: () => request<{ data: ShareLink[] }>("/api/share-links"),
    get: (id: string) => request<{ link: ShareLink; views: ShareLinkView[] }>(`/api/share-links/${id}`),
    create: (body: {
      resource_type: ShareLink["resource_type"];
      resource_id: string;
      label?: string;
      expires_in_days?: number;
      password?: string;
    }) => request<{ link: ShareLink }>("/api/share-links", { method: "POST", body: JSON.stringify(body) }),
    revoke: (id: string) => request<{ ok: boolean }>(`/api/share-links/${id}`, { method: "DELETE" }),
  },
  tasks: {
    list: (params?: { status?: string; assigned_to?: string; priority?: string; limit?: number; include_archived?: 0 | 1 }) =>
      request<{ data: ShipmentTask[] }>("/api/tasks", { params }),
    // Single-task lookup with optional walk-through siblings. The server
    // resolves the prev / next task ids (and their shipment ids) within the
    // selected scope, so a /tasks/:id URL is self-contained.
    get: (id: string, params?: { walk?: "active" | "open" | "in_progress" | "blocked" | "done" | "all" | "off" }) =>
      request<{
        task: ShipmentTask;
        walk: null | {
          mode: string;
          index: number;
          total: number;
          prev_id: string | null;
          next_id: string | null;
          prev_shipment_id: string | null;
          next_shipment_id: string | null;
          ids: string[];
        };
      }>(`/api/tasks/${id}`, { params }),
    listForShipment: (shipmentId: string) =>
      request<{ data: ShipmentTask[] }>(`/api/shipments/${shipmentId}/tasks`),
    create: (shipmentId: string, body: { title: string; description?: string; priority?: string; assigned_to?: string; due_at?: string; status?: "open" | "in_progress" | "blocked" }) =>
      request<{ task: ShipmentTask }>(`/api/shipments/${shipmentId}/tasks`, { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, patch: Partial<Pick<ShipmentTask, "status" | "priority" | "assigned_to" | "title" | "description" | "due_at">>) =>
      request<{ task: ShipmentTask }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
    bulkCreate: (body: { shipment_ids: string[]; title: string; description?: string; priority?: string; assigned_to?: string; due_at?: string }) =>
      request<{ created: number; missing: string[] }>("/api/tasks/bulk", { method: "POST", body: JSON.stringify(body) }),
    bulkUpdate: (body: { ids: string[]; status?: string; priority?: string; assigned_to?: string }) =>
      request<{ updated: number }>("/api/tasks/bulk-update", { method: "POST", body: JSON.stringify(body) }),
    bulkDelete: (body: { ids: string[] }) =>
      request<{ deleted: number }>("/api/tasks/bulk-delete", { method: "POST", body: JSON.stringify(body) }),
    // Active "Carrier Followup"-titled tasks grouped by carrier. Returns
    // each task joined to its shipment so the Kanban panel can render
    // carrier/customer/ETA without further round trips.
    carrierFollowups: () =>
      request<{
        groups: { carrier: string; items: { task: ShipmentTask; shipment: CarrierFollowupShipment }[] }[];
        total: number;
      }>("/api/tasks/carrier-followups"),
    // Generates ONE consolidated email covering every supplied task's
    // shipment for a single carrier. The server pulls the larger model
    // (Opus by default, configurable in Settings).
    carrierEmailDraft: (body: { carrier: string; task_ids: string[]; notes?: string }) =>
      request<{ subject: string; body: string; count: number; model: string | null }>(
        "/api/tasks/carrier-email-draft",
        { method: "POST", body: JSON.stringify(body) },
      ),
    // Customer-side mirror of carrierFollowups: groups active customer-
    // followup-titled tasks by customer name, joined to shipment data.
    customerFollowups: () =>
      request<{
        groups: { customer: string; items: { task: ShipmentTask; shipment: CarrierFollowupShipment }[] }[];
        total: number;
      }>("/api/tasks/customer-followups"),
    customerEmailDraft: (body: { customer: string; task_ids: string[]; notes?: string }) =>
      request<{ subject: string; body: string; count: number; model: string | null }>(
        "/api/tasks/customer-email-draft",
        { method: "POST", body: JSON.stringify(body) },
      ),
    // Lists prior bulk drafts for a single group, newest-first. The
    // Group Email modal calls this on open so the operator can see
    // every draft we've ever written for that carrier / customer.
    carrierEmailDrafts: (carrier: string, limit = 20) =>
      request<{ drafts: GroupEmailDraft[] }>("/api/tasks/carrier-email-drafts", {
        params: { carrier, limit },
      }),
    customerEmailDrafts: (customer: string, limit = 20) =>
      request<{ drafts: GroupEmailDraft[] }>("/api/tasks/customer-email-drafts", {
        params: { customer, limit },
      }),
  },
  feedback: {
    list: (params?: { status?: string; category?: string }) =>
      request<{ data: Feedback[] }>("/api/feedback", { params }),
    create: (body: { category: Feedback["category"]; title: string; body: string; severity?: Feedback["severity"]; source?: string; context?: Record<string, unknown> }) =>
      request<{ feedback: Feedback }>("/api/feedback", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, patch: Partial<Pick<Feedback, "status" | "admin_notes" | "severity" | "category">>) =>
      request<{ feedback: Feedback }>(`/api/feedback/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  },
  emailDraft: {
    generate: (shipmentId: string, audience: "carrier" | "customer", notes?: string) =>
      request<EmailDraft>(`/api/shipments/${shipmentId}/email-draft`, {
        method: "POST",
        body: JSON.stringify({ audience, notes }),
      }),
  },
  auditLog: {
    list: (params?: { entity_type?: string; entity_id?: string; action?: string; actor_email?: string; limit?: number }) =>
      request<{ data: AuditLogEntry[] }>("/api/audit-log", { params }),
  },
  settings: {
    list: () => request<{ data: SettingRow[] }>("/api/settings"),
    update: (key: string, value: unknown) =>
      request<{ setting: SettingRow }>(`/api/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
    refresh: () => request<{ ok: boolean }>("/api/settings/refresh", { method: "POST" }),
  },
  ops: {
    metrics: (days = 30) =>
      request<OpsMetrics>("/api/ops/metrics", { params: { days } }),
    // Enqueue a rescrape for the Chrome extension to fulfill on its next cycle.
    requestRescrape: (body?: { scope?: "all" | "selected"; tracking_numbers?: string[] }) =>
      request<{ request: ScrapeRequest; coalesced?: boolean }>("/api/ops/rescrape", {
        method: "POST",
        body: JSON.stringify(body || { scope: "all" }),
      }),
    rescrapeRecent: () =>
      request<{ requests: ScrapeRequest[] }>("/api/ops/rescrape"),
  },
};

export interface ScrapeRequest {
  id: string;
  status: "pending" | "claimed" | "done" | "error";
  scope: "all" | "selected";
  tracking_numbers: string[] | null;
  requested_by: string | null;
  requested_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  result_count: number | null;
  note: string | null;
}

// Recent material-diff for a shipment, returned by GET /api/shipments/:id.
// Mirrors fpx_shipment_scrapes.diff which the AI prompt also sees as
// recent_changes. Each key in `diff` is a column name; the value is
// { prev, next } showing what moved between the prior scrape and the
// most recent one.
export interface ShipmentRecentDiff {
  scraped_at: string;
  scraped_by: string | null;
  diff: Record<string, { prev: unknown; next: unknown }> | null;
}

// Stored bulk-email draft as returned by the carrier-email-drafts /
// customer-email-drafts list endpoints. Pulled from fpx_ai_analyses
// rows tagged with metadata.subkind=email_draft_*_group.
export interface GroupEmailDraft {
  id: string;
  created_at: string;
  model: string | null;
  subject: string | null;
  body: string | null;
  raw: string | null;
  count: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  rating?: "up" | "down" | null;
  rating_reason?: string | null;
  rated_by?: string | null;
  rated_at?: string | null;
}

export interface OpsDailyRow {
  date: string;
  shipments_analyzed: number;
  tasks_completed: number;
  emails_generated: number;
  cost_usd: number;
}
export interface OpsMetrics {
  range: { from: string; to: string; days: number };
  totals: {
    shipments_analyzed: number;
    tasks_completed: number;
    emails_generated: number;
    cost_usd: number;
    // Per-category cost split: per-shipment AI analyses, single-
    // shipment emails (carrier/customer drafts in the drawer), bulk
    // group emails, and anything else (gp/invoice audits, ad-hoc).
    cost_breakdown: {
      per_shipment_analysis: number;
      email_single: number;
      email_group: number;
      other: number;
    };
  };
  today: { date: string; shipments_analyzed: number; tasks_completed: number; emails_generated: number; cost_usd: number };
  last7: { shipments_analyzed: number; tasks_completed: number; emails_generated: number; cost_usd: number };
  daily: OpsDailyRow[];
  byOperator: { operator: string; tasks_completed: number; emails_generated: number }[];
}

export interface SettingRow {
  key: string;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  description: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export const publicShare = {
  // Returns metadata and, if no password, the resource itself.
  peek: (token: string) =>
    publicRequest<{ meta: { label?: string; resource_type: string; created_at: string; expires_at?: string; requires_password?: boolean }; data?: unknown }>(`/share/${token}`),
  view: (token: string, password?: string) =>
    publicRequest<{ meta: { label?: string; resource_type: string; created_at: string }; data: unknown }>(
      `/share/${token}/view`,
      { method: "POST", body: JSON.stringify({ password }) }
    ),
};
