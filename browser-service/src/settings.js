import { config } from "./config.js";

// Admin-adjustable settings for the hosted browser, stored in Supabase
// fpx_settings under "browser.*" keys (same table the API's Settings page
// uses). Re-read every 30s and applied live — no redeploy. Env vars give the
// starting defaults; a saved setting overrides them.

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const enabled = !!(SB_URL && SB_KEY);

// key → { label, help, min, max, default, apply(value) }
export const SETTINGS = {
  "browser.stream_quality": {
    label: "Live view picture quality", unit: "%", min: 30, max: 90, step: 5,
    default: 60,
    help: "JPEG quality of the live FreightPOP views. Lower = less data (cheaper), blurrier text.",
  },
  "browser.stream_every_nth_frame": {
    label: "Live view frame skipping", unit: "", min: 1, max: 4, step: 1,
    default: 1,
    help: "1 = every frame (smoothest). 2 sends every other frame — roughly half the data.",
  },
  "browser.view_idle_min": {
    label: "Close a view after inactivity", unit: "min", min: 0, max: 240, step: 5,
    default: 0,
    help: "Disconnect a FreightPOP view nobody has clicked or typed in for this long (0 = never). Its window is kept 10 min, so coming back resumes it.",
  },
  "browser.max_browsers": {
    label: "People at once", unit: "browsers", min: 1, max: 20, step: 1,
    default: config.maxBrowsers,
    help: "Max per-person Chromium browsers running together (~340 MB each). Raise Railway memory to match.",
  },
  "browser.max_tabs_per_user": {
    label: "Views per person", unit: "", min: 1, max: 10, step: 1,
    default: config.maxTabsPerUser,
    help: "Open FreightPOP views per person; the oldest closes when exceeded.",
  },
  "browser.max_sessions": {
    label: "Views across the team", unit: "", min: 1, max: 100, step: 1,
    default: config.maxSessions,
    help: "Total live FreightPOP views across everyone.",
  },
  "browser.idle_close_min": {
    label: "Close an unused browser after", unit: "min", min: 5, max: 480, step: 5,
    default: Math.round(config.idleCloseMs / 60_000),
    help: "A person's browser shuts down after this long with no views open. Their login is kept.",
  },
  "browser.scrape_poll_seconds": {
    label: "Check for queued scrapes every", unit: "s", min: 10, max: 300, step: 5,
    default: Math.round(config.scrapePollMs / 1000),
    help: "How quickly a 'Refresh all shipments' click starts.",
  },
};

const values = Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, s.default]));
const meta = {}; // key → { updated_by, updated_at }
const listeners = new Set();

export function get(key) { return values[key]; }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Push the values into the live config objects the rest of the service reads.
function apply() {
  config.maxBrowsers = values["browser.max_browsers"];
  config.maxTabsPerUser = values["browser.max_tabs_per_user"];
  config.maxSessions = values["browser.max_sessions"];
  config.idleCloseMs = values["browser.idle_close_min"] * 60_000;
  config.scrapePollMs = values["browser.scrape_poll_seconds"] * 1000;
}

function clean(key, raw) {
  const s = SETTINGS[key];
  if (!s) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
  const n = Number(raw);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`${s.label}: must be a number`), { status: 400 });
  if (n < s.min || n > s.max) throw Object.assign(new Error(`${s.label}: must be between ${s.min} and ${s.max}`), { status: 400 });
  return Math.round(n / (s.step || 1)) * (s.step || 1);
}

async function sb(pathAndQuery, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function refresh() {
  if (!enabled) { apply(); return; }
  try {
    const rows = await sb("fpx_settings?select=key,value,updated_by,updated_at&key=like.browser.*");
    let changed = false;
    for (const r of rows || []) {
      if (!SETTINGS[r.key]) continue;
      let v;
      try { v = clean(r.key, r.value); } catch { continue; }
      if (values[r.key] !== v) { values[r.key] = v; changed = true; }
      meta[r.key] = { updated_by: r.updated_by, updated_at: r.updated_at };
    }
    apply();
    if (changed) for (const fn of listeners) { try { fn(values); } catch {} }
  } catch (e) {
    console.warn("[settings] load failed (keeping current):", e.message);
  }
}

export function list() {
  return Object.entries(SETTINGS).map(([key, s]) => ({
    key, ...s, value: values[key], ...(meta[key] || {}),
  }));
}

// patch: { key: value } — admin only (checked by the caller).
export async function update(patch, byEmail) {
  if (!enabled) throw Object.assign(new Error("Settings need Supabase configured"), { status: 503 });
  const rows = Object.entries(patch || {}).map(([key, v]) => ({
    key, value: clean(key, v), description: SETTINGS[key].label, updated_by: byEmail, updated_at: new Date().toISOString(),
  }));
  if (!rows.length) return list();
  await sb("fpx_settings?on_conflict=key", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  console.log(`[settings] ${byEmail} set ${rows.map((r) => `${r.key}=${r.value}`).join(", ")}`);
  await refresh();
  return list();
}

export function startSettings() {
  apply();
  refresh();
  setInterval(refresh, 30_000).unref();
}
