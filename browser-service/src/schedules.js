import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { enqueueScheduled } from "./worker.js";
import { lastRunFor, listRuns } from "./runs.js";

// Scheduled runs. Each schedule belongs to one person and runs in THEIR
// hosted browser with THEIR FreightPOP login.
//
//   { id, owner, name, enabled, days: [0..6] (0=Sun), times: ["07:00", ...],
//     tz: "America/Los_Angeles", modes: ["LTL","Truckload"] | null (= all), createdAt, updatedAt,
//     job: "tracking" | "erp_lookback" | "shipment_details" (missing = "tracking"),
//     months: 1..12 | null, shipmentType: "non-parcel" | "parcel" | "both" | null (erp_lookback only),
//     lastFired: { at, requestId, queued, coalesced, reason } | null (non-tracking jobs only) }
//
// job "tracking" is Refresh All, queued straight into this service's scrape
// lane. The other jobs are queued through the API (POST /api/ops/lookback,
// run_as the owner); the hosted browser claims that row later and records the
// run under the API's request id, which lastFired remembers. For them modes is
// null; months/shipmentType are null unless the job is erp_lookback.
//
// A 20s tick compares each schedule's local wall-clock time (in its own time
// zone) to its times; a firing is remembered per date+time so it runs once.
// Runs missed while the service was down are skipped, not replayed.

const FILE = path.join(path.dirname(config.profileRoot), "schedules.json");
let schedules = [];
try { schedules = JSON.parse(fs.readFileSync(FILE, "utf8")) || []; } catch { schedules = []; }
const fired = new Map(); // scheduleId -> "YYYY-MM-DD HH:MM" last fired

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(schedules, null, 2));
  } catch (e) { console.warn("[schedules] save failed:", e.message); }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const JOBS = ["tracking", "erp_lookback", "shipment_details"];
const SHIPMENT_TYPES = ["non-parcel", "parcel", "both"];
const jobOf = (s) => s?.job || "tracking";

function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// Validate + normalise user input. Throws with a readable message.
function clean(input, existing) {
  const out = { ...(existing || {}) };
  const job = input.job !== undefined ? String(input.job ?? "") : jobOf(existing);
  if (!JOBS.includes(job)) throw new Error(`Unknown job "${job}" (use ${JOBS.join(", ")})`);
  // Only written when asked for: a saved schedule with no job stays as it is.
  if (input.job !== undefined) out.job = job;
  if (input.name !== undefined) out.name = String(input.name || "").trim().slice(0, 80);
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  if (input.days !== undefined) {
    const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if (!days.length) throw new Error("Pick at least one day");
    out.days = days;
  }
  if (input.times !== undefined) {
    const times = [...new Set((Array.isArray(input.times) ? input.times : []).map((t) => String(t).trim()))];
    if (!times.length) throw new Error("Add at least one time");
    const bad = times.find((t) => !TIME_RE.test(t));
    if (bad) throw new Error(`"${bad}" isn't a time (use HH:MM, 24-hour)`);
    if (times.length > 12) throw new Error("At most 12 times per schedule");
    out.times = times.sort();
  }
  if (job !== "tracking") out.modes = null;
  else if (input.modes !== undefined) {
    // null / all three = every mode.
    const KNOWN = ["LTL", "Truckload", "Parcel"];
    const modes = input.modes == null ? [] : [...new Set((Array.isArray(input.modes) ? input.modes : []).map(String).filter((m) => KNOWN.includes(m)))];
    if (Array.isArray(input.modes) && !modes.length) throw new Error("Pick at least one mode");
    out.modes = modes.length && modes.length < KNOWN.length ? modes : null;
  }
  if (input.tz !== undefined) {
    if (!validTz(input.tz)) throw new Error(`Unknown time zone "${input.tz}"`);
    out.tz = input.tz;
  }
  if (job === "erp_lookback") {
    const raw = input.months ?? out.months ?? 1;
    const months = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
    if (!Number.isInteger(months) || months < 1 || months > 12) throw new Error("Months must be a whole number from 1 to 12");
    const shipmentType = String(input.shipmentType ?? out.shipmentType ?? "non-parcel");
    if (!SHIPMENT_TYPES.includes(shipmentType)) throw new Error(`Unknown shipment type "${shipmentType}" (use ${SHIPMENT_TYPES.join(", ")})`);
    out.months = months;
    out.shipmentType = shipmentType;
  } else if (out.job) {
    out.months = null;
    out.shipmentType = null;
  }
  // lastFired belongs to the job that fired it.
  if (existing && job !== jobOf(existing)) out.lastFired = null;
  return out;
}

// Wall-clock parts of `date` in `tz`.
function wallClock(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, dow };
}

// Next firing time, scanning minute by minute (cheap: only checks minutes
// whose wall-clock HH:MM is one of the schedule's times).
export function nextRunAt(s, from = new Date()) {
  if (!s.enabled || !s.days?.length || !s.times?.length) return null;
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const d = new Date(start.getTime() + i * 60_000);
    const w = wallClock(d, s.tz);
    if (s.times.includes(w.time) && s.days.includes(w.dow)) return d.toISOString();
  }
  return null;
}

// nextRunAt scans up to 8 days of minutes; cache per schedule per minute.
const nextCache = new Map(); // id -> { key, value }
function cachedNext(s) {
  const key = `${s.updatedAt}|${Math.floor(Date.now() / 60_000)}`;
  const hit = nextCache.get(s.id);
  if (hit?.key === key) return hit.value;
  const value = nextRunAt(s);
  nextCache.set(s.id, { key, value });
  return value;
}

// A non-tracking job's run is recorded under the API's request id (no
// scheduleId), so it is found by the id remembered at firing. runs.js keeps
// the newest 200; an older run is no longer shown.
function lastRunOf(s) {
  if (jobOf(s) === "tracking") return lastRunFor(s.id);
  const f = s.lastFired;
  if (!f) return null;
  const run = f.requestId != null ? listRuns(200).find((r) => String(r.id) === String(f.requestId)) : null;
  if (run) return run;
  // Never reached the queue: show why.
  if (!f.queued) return { id: null, ok: false, finishedAt: f.at, durationMs: 0, note: f.reason || "not queued", counts: null };
  return null;
}

function view(s) {
  const last = lastRunOf(s);
  return {
    ...s,
    job: jobOf(s),
    lastFired: s.lastFired || null,
    nextRunAt: cachedNext(s),
    lastRun: last && { id: last.id, ok: last.ok, finishedAt: last.finishedAt, durationMs: last.durationMs, note: last.note, counts: last.counts },
  };
}

// Owners see their own; admins see everyone's.
export function listSchedules(who) {
  return schedules.filter((s) => who.isAdmin || s.owner === who.email).map(view);
}

function find(id, who) {
  const s = schedules.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error("Schedule not found"), { status: 404 });
  if (s.owner !== who.email && !who.isAdmin) throw Object.assign(new Error("Not your schedule"), { status: 403 });
  return s;
}

export function createSchedule(who, input) {
  if (schedules.filter((s) => s.owner === who.email).length >= 10) throw new Error("At most 10 schedules per person");
  const s = clean({ enabled: true, name: "", tz: "America/Los_Angeles", job: "tracking", ...input }, null);
  if (!s.days) throw new Error("Pick at least one day");
  if (!s.times) throw new Error("Add at least one time");
  const now = new Date().toISOString();
  const row = { id: crypto.randomUUID(), owner: who.email, ...s, createdAt: now, updatedAt: now };
  schedules.push(row);
  save();
  console.log(`[schedules] ${who.email} created ${row.id} (${row.job}): ${row.days.join(",")} @ ${row.times.join(",")} ${row.tz}`);
  return view(row);
}

export function updateSchedule(who, id, input) {
  const s = find(id, who);
  Object.assign(s, clean(input, s), { updatedAt: new Date().toISOString() });
  save();
  return view(s);
}

export function deleteSchedule(who, id) {
  const s = find(id, who);
  schedules = schedules.filter((x) => x !== s);
  save();
  console.log(`[schedules] ${who.email} deleted ${id}`);
}

// Queue a non-tracking job through the API, as the schedule's owner. Never
// throws. → { queued, reason?, coalesced?, requestId? } (coalesced = the same
// job was already waiting or running, which counts as queued).
async function fireLookback(s) {
  let out;
  try {
    if (!config.apiKey) out = { queued: false, reason: "FPX_API_KEY is not set on the hosted browser, so it cannot queue this job" };
    else {
      const body = jobOf(s) === "erp_lookback"
        ? { jobs: ["erp"], months: s.months ?? 1, shipment_type: s.shipmentType || "non-parcel", run_as: s.owner }
        : { jobs: ["shipment_details"], run_as: s.owner };
      const res = await fetch(`${config.apiUrl}/api/ops/lookback`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": config.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text().catch(() => "");
      let data = null;
      try { data = JSON.parse(text); } catch {}
      const q = Array.isArray(data?.queued) ? data.queued[0] : null;
      if (!res.ok) out = { queued: false, reason: String(data?.error || `API answered ${res.status} ${text}`).trim().slice(0, 200) };
      else if (q) out = { queued: true, requestId: q.request_id ?? null, ...(q.coalesced ? { coalesced: true } : {}) };
      else out = { queued: false, reason: String((Array.isArray(data?.skipped) && data.skipped[0]?.reason) || "the API queued nothing").slice(0, 200) };
    }
  } catch (e) {
    out = { queued: false, reason: String(e?.name === "TimeoutError" ? "the API did not answer in 30s" : e?.message || e).slice(0, 200) };
  }
  // Not a user edit: updatedAt stays (the nextRunAt cache keys on it).
  if (schedules.includes(s)) {
    s.lastFired = { at: new Date().toISOString(), requestId: out.requestId ?? null, queued: out.queued, coalesced: !!out.coalesced, reason: out.reason || null };
    save();
  }
  return out;
}

// Tracking answers at once; the other jobs answer with a promise.
export function runScheduleNow(who, id) {
  const s = find(id, who);
  return jobOf(s) === "tracking" ? enqueueScheduled(s) : fireLookback(s);
}

function tick() {
  const now = new Date();
  for (const s of schedules) {
    if (!s.enabled) continue;
    let w;
    try { w = wallClock(now, s.tz); } catch { continue; }
    if (!s.days.includes(w.dow) || !s.times.includes(w.time)) continue;
    const key = `${w.date} ${w.time}`;
    if (fired.get(s.id) === key) continue;
    fired.set(s.id, key);
    if (jobOf(s) !== "tracking") {
      fireLookback(s)
        .then((r) => console.log(`[schedules] ${s.id} (${s.owner}) ${jobOf(s)} fired for ${key} ${s.tz}: ${r.queued ? (r.coalesced ? "already queued or running" : "queued") : r.reason}`))
        .catch((e) => console.warn(`[schedules] ${s.id} (${s.owner}) fired for ${key} ${s.tz}: ${e.message}`));
      continue;
    }
    const r = enqueueScheduled(s);
    console.log(`[schedules] ${s.id} (${s.owner}) fired for ${key} ${s.tz}: ${r.queued ? "queued" : r.reason}`);
  }
}

export function startScheduler() {
  console.log(`[schedules] ${schedules.length} schedule(s) loaded`);
  setInterval(tick, 20_000).unref();
  tick();
}
