import type {
  AiAnalysis, ApiKey, AuditLogEntry, EmailDraft, Feedback, GpAudit, GpAuditRow,
  InvoiceAudit, InvoiceAuditRow, Shipment, ShareLink, ShareLinkView, ShipmentTask, UserProfileRow,
} from "./types";
import { sb } from "./supabase";

const API_URL = (import.meta.env.VITE_FPX_API_URL || "http://localhost:3210").replace(/\/$/, "");

// Auth gate. Pages can mount before Supabase finishes hydrating the session
// from localStorage / processing the OAuth hash, so the first request after a
// hard refresh sometimes fires before `access_token` is available — that 401
// surfaces as "loaded the page, no data, refresh fixes it." Wait briefly for
// the session to appear via onAuthStateChange before giving up.
const AUTH_GATE_TIMEOUT_MS = 2500;
async function getAccessTokenOrWait(): Promise<string> {
  const { data } = await sb.auth.getSession();
  if (data.session?.access_token) return data.session.access_token;
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

async function request<T>(path: string, init?: RequestInit & { params?: Record<string, string | number | undefined> }): Promise<T> {
  const accessToken = await getAccessTokenOrWait();
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.params || {})) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const q = search.toString();
  const full = `${API_URL}${path}${q ? `?${q}` : ""}`;
  const resp = await fetch(full, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });
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

export const api = {
  health: () => fetch(`${API_URL}/health`).then((r) => r.json()),

  shipments: {
    list: (params?: { limit?: number; customer?: string; action?: string; status?: string; q?: string; source?: string }) =>
      request<{ data: Shipment[] }>("/api/shipments", { params }),
    get: (id: string) => request<{ shipment: Shipment; analyses: AiAnalysis[]; history: Shipment[] }>(`/api/shipments/${id}`),
    overrideAction: (id: string, body: { action_required: string | null; reason?: string }) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/action`, { method: "PATCH", body: JSON.stringify(body) }),
    reanalyze: (id: string) =>
      request<{ shipment: Shipment }>(`/api/shipments/${id}/reanalyze`, { method: "POST" }),
  },
  analyses: {
    list: (params?: { limit?: number; kind?: string; tracking_number?: string }) =>
      request<{ data: AiAnalysis[] }>("/api/analyses", { params }),
  },
  audits: {
    gp: {
      list: () => request<{ data: GpAudit[] }>("/api/audits/gp"),
      get: (id: string) => request<{ run: GpAudit; rows: GpAuditRow[] }>(`/api/audits/gp/${id}`),
    },
    invoice: {
      list: () => request<{ data: InvoiceAudit[] }>("/api/audits/invoice"),
      get: (id: string) => request<{ run: InvoiceAudit; rows: InvoiceAuditRow[] }>(`/api/audits/invoice/${id}`),
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
    update: (id: string, body: { enabled?: boolean; role?: string }) =>
      request<{ user: UserProfileRow }>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
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
    listForShipment: (shipmentId: string) =>
      request<{ data: ShipmentTask[] }>(`/api/shipments/${shipmentId}/tasks`),
    create: (shipmentId: string, body: { title: string; description?: string; priority?: string; assigned_to?: string; due_at?: string }) =>
      request<{ task: ShipmentTask }>(`/api/shipments/${shipmentId}/tasks`, { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, patch: Partial<Pick<ShipmentTask, "status" | "priority" | "assigned_to" | "title" | "description" | "due_at">>) =>
      request<{ task: ShipmentTask }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
    bulkCreate: (body: { shipment_ids: string[]; title: string; description?: string; priority?: string; assigned_to?: string; due_at?: string }) =>
      request<{ created: number; missing: string[] }>("/api/tasks/bulk", { method: "POST", body: JSON.stringify(body) }),
    bulkUpdate: (body: { ids: string[]; status?: string; priority?: string; assigned_to?: string }) =>
      request<{ updated: number }>("/api/tasks/bulk-update", { method: "POST", body: JSON.stringify(body) }),
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
};

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
