import type { AiAnalysis, ApiKey, GpAudit, GpAuditRow, InvoiceAudit, InvoiceAuditRow, Shipment } from "./types";

const STORAGE_KEY = "fpx:auth";

export interface AuthConfig {
  url: string;
  key: string;
}

export function loadAuth(): AuthConfig {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) return JSON.parse(s);
  } catch {}
  const envUrl = import.meta.env.VITE_FPX_API_URL || "";
  return { url: envUrl, key: "" };
}

export function saveAuth(cfg: AuthConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

async function request<T>(path: string, init?: RequestInit & { params?: Record<string, string | number | undefined> }): Promise<T> {
  const { url, key } = loadAuth();
  if (!url) throw new Error("API URL not configured.");
  if (!key) throw new Error("API key not configured.");

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.params || {})) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const q = search.toString();
  const full = `${url.replace(/\/$/, "")}${path}${q ? `?${q}` : ""}`;

  const resp = await fetch(full, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      ...(init?.headers || {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

export const api = {
  health: () => request<{ ok: boolean; version: string; uptime: number; db: boolean }>("/health"),

  shipments: {
    list: (params?: { limit?: number; customer?: string; action?: string; status?: string; q?: string }) =>
      request<{ data: Shipment[] }>("/api/shipments", { params }),
    get: (id: string) => request<{ shipment: Shipment; analyses: AiAnalysis[] }>(`/api/shipments/${id}`),
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
};
