import type {
  AiAnalysis, ApiKey, GpAudit, GpAuditRow, InvoiceAudit,
  InvoiceAuditRow, Shipment, ShareLink, ShareLinkView, UserProfileRow,
} from "./types";
import { sb } from "./supabase";

const API_URL = (import.meta.env.VITE_FPX_API_URL || "http://localhost:3210").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit & { params?: Record<string, string | number | undefined> }): Promise<T> {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error("Not signed in.");
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
      Authorization: `Bearer ${session.access_token}`,
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
    list: (params?: { limit?: number; customer?: string; action?: string; status?: string; q?: string }) =>
      request<{ data: Shipment[] }>("/api/shipments", { params }),
    get: (id: string) => request<{ shipment: Shipment; analyses: AiAnalysis[]; history: Shipment[] }>(`/api/shipments/${id}`),
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
};

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
