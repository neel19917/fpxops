import type {
  AiAnalysis, ApiKey, AuditLogEntry, CarrierFollowupShipment, EmailDraft, Feedback, GpAudit, GpAuditRow,
  InvoiceAudit, InvoiceAuditRow, Shipment, ShareLink, ShareLinkView, ShipmentTask, UserProfileRow,
} from "./types";
import { sb } from "./supabase";
import { impersonateHeaders } from "./impersonate";

const API_URL = (import.meta.env.VITE_FPX_API_URL || "http://localhost:3210").replace(/\/$/, "");

// Auth gate. Three failure modes were causing a "load → blank → refresh fixes
// it" loop on every page load:
//   1. Page mounts before Supabase hydrates from localStorage / OAuth hash —
//      first call to getSession() returns null until onAuthStateChange fires.
//   2. Cached session in storage is *stale* (access token expired). getSession
//      returns it anyway; the API server 401s; user refreshes; by then
//      autoRefreshToken has rotated and the second load succeeds.
//   3. (after #2) the same stale token gets sent on every subsequent request
//      until something prompts a refresh.
//
// Fix: when getSession returns nothing or returns a token within 60s of
// expiry, call refreshSession() before resolving. If neither yields a
// usable token, wait briefly on onAuthStateChange. The 60s skew is generous
// for clock drift between client + Supabase + Railway.
const AUTH_GATE_TIMEOUT_MS = 2500;
const REFRESH_SKEW_S = 60;

function tokenStillFresh(s: { access_token?: string; expires_at?: number | null } | null): string | null {
  if (!s?.access_token) return null;
  const exp = s.expires_at;
  if (exp && Date.now() / 1000 > exp - REFRESH_SKEW_S) return null; // expiring soon
  return s.access_token;
}

// Single-flight guard for sb.auth.refreshSession(). With the no-op lock in
// supabase.ts (deliberate: navigator.locks orphans under React Strict Mode),
// the SDK no longer serializes refresh internally — so N parallel requests
// hitting a 401 would each call the refresh endpoint. Coalesce them here:
// the first call wins and every concurrent caller awaits the same promise.
let _refreshInflight: Promise<string | null> | null = null;
function refreshSessionOnce(): Promise<string | null> {
  if (_refreshInflight) return _refreshInflight;
  _refreshInflight = (async () => {
    try {
      const { data, error } = await sb.auth.refreshSession();
      if (error || !data.session?.access_token) return null;
      return data.session.access_token;
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
  // 1. Cached session, if still fresh.
  const cached = (await sb.auth.getSession()).data.session;
  const fresh = tokenStillFresh(cached);
  if (fresh) return fresh;

  // 2. Cached but stale → ask the SDK to refresh. If we have a refresh
  // token, this returns a brand-new access token without forcing a full
  // sign-in round-trip.
  if (cached?.refresh_token) {
    const tok = await refreshSessionOnce();
    if (tok) return tok;
  }

  // 3. Nothing usable yet — wait for onAuthStateChange to deliver one.
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
      reject(new Error("Not signed in."));
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
    return fetch(full, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // Impersonation headers are skipped on meta-operations (start/stop/toggle)
        // so the request is attributed to the real admin server-side.
        ...(init?.noImpersonate ? {} : impersonateHeaders()),
        ...(init?.headers || {}),
      },
    });
  }

  let accessToken = await getAccessTokenOrWait();
  let resp = await fire(accessToken);
  // Belt + suspenders for the stale-token race: a 401 means the access token
  // the SDK handed us was no longer valid server-side. Force a refresh and
  // retry exactly once before propagating the failure to the caller. Routes
  // through the single-flight guard so a page firing 6 parallel requests on
  // mount only triggers ONE refresh round-trip.
  if (resp.status === 401) {
    const refreshed = await refreshSessionOnce();
    if (refreshed) {
      accessToken = refreshed;
      resp = await fire(accessToken);
    }
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
    get: (id: string) => request<{ shipment: Shipment; analyses: AiAnalysis[]; history: Shipment[]; tasks: ShipmentTask[]; recent_diff: ShipmentRecentDiff | null }>(`/api/shipments/${id}`),
    overrideAction: (id: string, body: { action_required: string | null; reason?: string }) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/action`, { method: "PATCH", body: JSON.stringify(body) }),
    reanalyze: (id: string) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/reanalyze`, { method: "POST" }),
    updateNotes: (id: string, notes: string | null) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/notes`, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      }),
    bulkDelete: (ids: string[]) =>
      request<{ deleted: number }>(`/api/shipments/bulk-delete`, {
        method: "POST",
        body: JSON.stringify({ ids }),
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
    list: (params?: { status?: string; assigned_to?: string; priority?: string; limit?: number }) =>
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
  },
};

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
