import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { enqueueScheduled } from "./worker.js";
import { lastRunFor } from "./runs.js";

// Scheduled Refresh All runs. Each schedule belongs to one person and runs in
// THEIR hosted browser with THEIR FreightPOP login.
//
//   { id, owner, name, enabled, days: [0..6] (0=Sun), times: ["07:00", ...],
//     tz: "America/Los_Angeles", modes: ["LTL","Truckload"] | null (= all), createdAt, updatedAt }
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

function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// Validate + normalise user input. Throws with a readable message.
function clean(input, existing) {
  const out = { ...(existing || {}) };
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
  if (input.modes !== undefined) {
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

function view(s) {
  const last = lastRunFor(s.id);
  return {
    ...s,
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
  const s = clean({ enabled: true, name: "", tz: "America/Los_Angeles", ...input }, null);
  if (!s.days) throw new Error("Pick at least one day");
  if (!s.times) throw new Error("Add at least one time");
  const now = new Date().toISOString();
  const row = { id: crypto.randomUUID(), owner: who.email, ...s, createdAt: now, updatedAt: now };
  schedules.push(row);
  save();
  console.log(`[schedules] ${who.email} created ${row.id}: ${row.days.join(",")} @ ${row.times.join(",")} ${row.tz}`);
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

export function runScheduleNow(who, id) {
  const s = find(id, who);
  return enqueueScheduled(s);
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
    const r = enqueueScheduled(s);
    console.log(`[schedules] ${s.id} (${s.owner}) fired for ${key} ${s.tz}: ${r.queued ? "queued" : r.reason}`);
  }
}

export function startScheduler() {
  console.log(`[schedules] ${schedules.length} schedule(s) loaded`);
  setInterval(tick, 20_000).unref();
  tick();
}
