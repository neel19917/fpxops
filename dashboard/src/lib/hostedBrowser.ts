import { getAccessTokenOrWait } from "./api";
import { HOSTED_BROWSER_URL } from "../components/HostedFreightPop";

// Client for the hosted browser service's JSON API (browser-service/src/index.js).
// Same Supabase JWT as the Railway API; the service verifies it against the API.

export interface HostedBrowserStatus {
  user: string;
  running: boolean;
  tabs: number;
  busy: boolean;
  startedAt?: string | null;
  lastUsed?: string;
  memoryMb: number | null;
  hasProfile: boolean;
  freightpop: { loggedIn: boolean; url: string; at: string } | null;
}

export interface ScrapeLogLine { t: string; text: string; level: "info" | "warn" | "error" | "done" | "data" }
export interface ScrapeCounts { scraped: number; partial: number; saved: number; changed: number; uploadErrors: number; archived: number; processed?: number; total?: number | null }

export interface HostedWorkerState {
  enabled: boolean;
  reason: string | null;
  pollSeconds: number;
  current: { requestId: string; user: string; scope: string; source?: "manual" | "schedule"; scheduleName?: string | null; startedAt: string; status: string; statusAt: string; log?: ScrapeLogLine[]; logTotal?: number; counts?: ScrapeCounts | null; total?: number | null;
    fpCounts?: Record<string, number> | null; fpCountsAt?: string | null } | null;
  lastResult: { requestId: string; user: string; ok: boolean; note: string; finishedAt: string; durationMs: number; log?: ScrapeLogLine[]; logTotal?: number; counts?: ScrapeCounts | null } | null;
}

export interface HostedUsageUser {
  email: string;
  sessions: number;
  connectedMs: number;
  scrapes: number;
  scrapeMs: number;
  scrapeErrors: number;
  lastActive: string | null;
}

export interface ScrapeRun {
  id: string;
  source: "manual" | "schedule";
  user: string;
  scheduleId: string | null;
  scheduleName: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  note: string;
  counts: ScrapeCounts | null;
}

export interface ScrapeSchedule {
  id: string;
  owner: string;
  name: string;
  enabled: boolean;
  days: number[];      // 0 = Sunday
  times: string[];     // "HH:MM", 24h, in tz
  tz: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRun: { id: string; ok: boolean; finishedAt: string; durationMs: number; note: string; counts: ScrapeCounts | null } | null;
}

export type ScheduleInput = Pick<ScrapeSchedule, "name" | "days" | "times" | "tz"> & { enabled?: boolean };

export interface HostedStats {
  bootedAt: string;
  now: string;
  limits: { maxBrowsers: number; maxSessions: number; idleCloseMin: number };
  live: {
    sessions: number;
    browsers: number;
    memoryMb: number;
    perBrowser: (Omit<HostedBrowserStatus, "running" | "hasProfile" | "freightpop">)[];
  };
  me: HostedBrowserStatus;
  isAdmin?: boolean;
  runs?: ScrapeRun[];
  schedules?: ScrapeSchedule[];
  worker: HostedWorkerState & { queued?: { id: string; user: string; source: string; scheduleId: string; scheduleName: string | null; queuedAt: string }[] };
  usage: {
    days: number;
    users: HostedUsageUser[];
    daily: { date: string; sessions: number; connectedMs: number; scrapes: number; users: number }[];
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!HOSTED_BROWSER_URL) throw new Error("Hosted browser not configured (VITE_FPX_BROWSER_URL)");
  const token = await getAccessTokenOrWait();
  const res = await fetch(`${HOSTED_BROWSER_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(`Hosted browser: ${body.error}`);
    // A bare 404 means the hosted browser is running an older version that
    // doesn't have this endpoint yet (e.g. mid-rollout).
    if (res.status === 404) throw new Error("The hosted browser hasn't been updated with this feature yet — try again after its next deploy.");
    throw new Error(`Hosted browser returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// "Ask FPX" assistant (browser-service/src/assistant.js).
export type AssistantAction =
  | { type: "open_shipment"; id: string; label?: string }
  | { type: "open_task"; task_id: string; label?: string }
  | { type: "filter_shipments"; query?: string; action?: "YES" | "NO" | "ERROR"; customer?: string }
  | { type: "navigate"; page: string };

export interface AssistantReply {
  messages: unknown[];   // conversation, returned verbatim and sent back next turn
  reply: string;
  actions: AssistantAction[];
}

// Admin-adjustable hosted browser settings (browser-service/src/settings.js).
export interface BrowserSetting {
  key: string; label: string; help: string; unit: string;
  min: number; max: number; step: number; default: number; value: number;
  updated_by?: string | null; updated_at?: string | null;
}
export interface BrowserSettingsResponse {
  settings: BrowserSetting[];
  live?: { sessions: number; browsers: number; memoryMb: number; egress: { mbLastHour: number; mbLast5Min: number } };
}

export const hostedBrowser = {
  adminSettings: () => call<BrowserSettingsResponse>("/admin/settings"),
  saveAdminSettings: (settings: Record<string, number>) =>
    call<BrowserSettingsResponse>("/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) }),
  assistantChat: (body: { history: unknown[]; message: string; context?: Record<string, unknown> }) =>
    call<AssistantReply>("/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  enabled: !!HOSTED_BROWSER_URL,
  stats: (days = 30) => call<HostedStats>(`/stats?days=${days}`),
  stopScrape: () => call<{ stopping: boolean }>("/scrape/stop", { method: "POST" }),
  runs: (q: { limit?: number; user?: string; source?: string; ok?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return call<{ isAdmin: boolean; runs: ScrapeRun[] }>(`/runs?${qs}`);
  },
  schedules: () => call<{ schedules: ScrapeSchedule[] }>("/schedules"),
  createSchedule: (input: ScheduleInput) =>
    call<{ schedule: ScrapeSchedule }>("/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
  updateSchedule: (id: string, input: Partial<ScheduleInput>) =>
    call<{ schedule: ScrapeSchedule }>(`/schedules/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
  deleteSchedule: (id: string) => call<{ deleted: boolean }>(`/schedules/${id}`, { method: "DELETE" }),
  runScheduleNow: (id: string) => call<{ queued: boolean; reason?: string }>(`/schedules/${id}/run`, { method: "POST" }),
  // A run's saved log as text (admins: any run; others: their own).
  async runLogText(runId: string): Promise<string> {
    const token = await getAccessTokenOrWait();
    const res = await fetch(`${HOSTED_BROWSER_URL}/scrape/log?run=${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Hosted browser returned ${res.status}`);
    return res.text();
  },
  // Full log as a .log file download — a past run by id, else the running/last one.
  async downloadLog(runId?: string) {
    if (!HOSTED_BROWSER_URL) return;
    const token = await getAccessTokenOrWait();
    const res = await fetch(`${HOSTED_BROWSER_URL}/scrape/log${runId ? `?run=${encodeURIComponent(runId)}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Hosted browser returned ${res.status}`);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "scrape.log";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },
};
