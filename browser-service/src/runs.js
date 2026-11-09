import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// History of every scrape this service ran — manual (dashboard "Refresh all"
// → API queue) and scheduled — with each run's full log.
//
// Source of truth: Supabase table public.fpx_scrape_runs
// (server/migrations/2026-11-09_scrape_runs.sql), written with the service
// role key. A local copy on the data volume is kept as a fallback and as an
// outbox: anything that couldn't be written to Supabase is retried.
//
//   <data>/runs.json            local run summaries, newest first
//   <data>/run-logs/<id>.log    local copy of each run's log

const DATA = path.dirname(config.profileRoot);
const FILE = path.join(DATA, "runs.json");
const LOG_DIR = path.join(DATA, "run-logs");
const MAX_RUNS = 200;

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const supabaseEnabled = !!(SB_URL && SB_KEY);

let runs = [];
try { runs = JSON.parse(fs.readFileSync(FILE, "utf8")) || []; } catch { runs = []; }

function saveLocal() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(runs));
  } catch (e) { console.warn("[runs] local save failed:", e.message); }
}

const logPath = (id) => path.join(LOG_DIR, `${safeId(id)}.log`);
function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }

async function sb(pathAndQuery, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${init.method || "GET"} ${pathAndQuery.split("?")[0]} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const toRow = (r, logText) => ({
  id: r.id, source: r.source, user_email: r.user,
  schedule_id: r.scheduleId || null, schedule_name: r.scheduleName || null,
  started_at: r.startedAt, finished_at: r.finishedAt, duration_ms: Math.round(r.durationMs || 0),
  ok: !!r.ok, note: r.note || null, counts: r.counts || null,
  ...(logText !== undefined ? { log: logText, log_lines: logText ? logText.split("\n").filter(Boolean).length : 0 } : {}),
});

const fromRow = (x) => ({
  id: x.id, source: x.source, user: x.user_email,
  scheduleId: x.schedule_id, scheduleName: x.schedule_name,
  startedAt: x.started_at, finishedAt: x.finished_at, durationMs: x.duration_ms,
  ok: x.ok, note: x.note || "", counts: x.counts || null, synced: true,
});

async function pushToSupabase(r) {
  let text = "";
  try { text = fs.readFileSync(logPath(r.id), "utf8"); } catch {}
  await sb("fpx_scrape_runs?on_conflict=id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(toRow(r, text)),
  });
  r.synced = true;
}

// Retry anything not yet in Supabase (startup + every 5 min).
async function syncPending() {
  if (!supabaseEnabled) return;
  let changed = false;
  for (const r of runs.filter((x) => !x.synced)) {
    try { await pushToSupabase(r); changed = true; }
    catch (e) { console.warn(`[runs] sync ${r.id} failed:`, e.message); break; }
  }
  if (changed) saveLocal();
}

// summary: { id, source: "manual"|"schedule", user, scheduleId?, scheduleName?,
//            startedAt, finishedAt, durationMs, ok, note, counts }
export function recordRun(summary, log) {
  const r = { ...summary, synced: false };
  runs = [r, ...runs.filter((x) => x.id !== r.id)];
  const dropped = runs.splice(MAX_RUNS);
  saveLocal();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const text = (log || []).map((l) => `${l.t}\t${l.level}\t${l.text}`).join("\n");
    fs.writeFileSync(logPath(r.id), text + "\n");
    for (const d of dropped) fs.rmSync(logPath(d.id), { force: true });
  } catch (e) { console.warn("[runs] log write failed:", e.message); }
  if (supabaseEnabled) {
    pushToSupabase(r)
      .then(() => { saveLocal(); console.log(`[runs] saved ${r.id} to Supabase`); })
      .catch((e) => console.warn(`[runs] Supabase save for ${r.id} failed (will retry):`, e.message));
  }
}

const strip = ({ synced, ...r }) => r;

export function listRuns(limit = 20) {
  return runs.slice(0, limit).map(strip);
}

export function lastRunFor(scheduleId) {
  const r = runs.find((x) => x.scheduleId === scheduleId);
  return r ? strip(r) : null;
}

// A run's log: local copy first, else Supabase.
export async function readRunLog(id) {
  let run = runs.find((x) => x.id === id);
  try {
    const text = fs.readFileSync(logPath(id), "utf8");
    if (run) return { run: strip(run), text };
  } catch {}
  if (!supabaseEnabled) return run ? { run: strip(run), text: "" } : null;
  const rows = await sb(`fpx_scrape_runs?id=eq.${encodeURIComponent(id)}&select=*`).catch(() => null);
  const row = rows?.[0];
  if (!row) return run ? { run: strip(run), text: "" } : null;
  return { run: strip(run || fromRow(row)), text: row.log || "" };
}

// On boot: merge the latest history from Supabase (so a fresh volume or a
// second instance still shows every run), then push any unsynced local runs.
export async function initRuns() {
  if (!supabaseEnabled) {
    console.warn("[runs] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — run history is local only");
    return;
  }
  try {
    const rows = await sb(`fpx_scrape_runs?select=id,source,user_email,schedule_id,schedule_name,started_at,finished_at,duration_ms,ok,note,counts&order=started_at.desc&limit=${MAX_RUNS}`);
    const byId = new Map(runs.map((r) => [r.id, r]));
    for (const row of rows || []) if (!byId.has(row.id)) byId.set(row.id, fromRow(row));
    runs = [...byId.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, MAX_RUNS);
    saveLocal();
    console.log(`[runs] loaded ${rows?.length || 0} run(s) from Supabase`);
  } catch (e) {
    console.warn("[runs] Supabase load failed (using local history):", e.message);
  }
  await syncPending();
  setInterval(() => syncPending().catch(() => {}), 5 * 60_000).unref();
}
