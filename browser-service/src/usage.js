import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Per-user usage counters for the hosted browser, persisted to the data
// volume so they survive restarts. Small and append-only-ish: one record per
// user per UTC day, pruned to the last 30 days.
//
// { "<email>": { "<YYYY-MM-DD>": { sessions, connectedMs, scrapes, scrapeMs, scrapeErrors } } }

const FILE = path.join(path.dirname(config.profileRoot), "usage.json");
const KEEP_DAYS = 30;
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch { data = {}; }

let dirty = false;
setInterval(flush, 30_000).unref();

export function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data));
    dirty = false;
  } catch (e) { console.warn("[usage] save failed:", e.message); }
}

const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

function bucket(email) {
  const u = (data[email] ||= {});
  const d = (u[day()] ||= { sessions: 0, connectedMs: 0, scrapes: 0, scrapeMs: 0, scrapeErrors: 0 });
  dirty = true;
  return d;
}

export function recordSession(email, connectedMs) {
  const b = bucket(email);
  b.sessions += 1;
  b.connectedMs += Math.max(0, connectedMs);
}

export function recordScrape(email, ms, ok) {
  const b = bucket(email);
  b.scrapes += 1;
  b.scrapeMs += Math.max(0, ms);
  if (!ok) b.scrapeErrors += 1;
}

// Totals per user + per day over the last `days` days (prunes old days).
export function summary(days = 30) {
  const cutoff = day(Date.now() - (KEEP_DAYS - 1) * 86_400_000);
  const since = day(Date.now() - (days - 1) * 86_400_000);
  const users = [];
  const daily = {};
  for (const [email, byDay] of Object.entries(data)) {
    const tot = { email, sessions: 0, connectedMs: 0, scrapes: 0, scrapeMs: 0, scrapeErrors: 0, lastActive: null };
    for (const [d, v] of Object.entries(byDay)) {
      if (d < cutoff) { delete byDay[d]; dirty = true; continue; }
      if (d < since) continue;
      for (const k of ["sessions", "connectedMs", "scrapes", "scrapeMs", "scrapeErrors"]) tot[k] += v[k] || 0;
      if (!tot.lastActive || d > tot.lastActive) tot.lastActive = d;
      const dd = (daily[d] ||= { date: d, sessions: 0, connectedMs: 0, scrapes: 0, users: 0 });
      dd.sessions += v.sessions || 0;
      dd.connectedMs += v.connectedMs || 0;
      dd.scrapes += v.scrapes || 0;
      dd.users += 1;
    }
    if (tot.lastActive) users.push(tot);
  }
  users.sort((a, b) => b.connectedMs - a.connectedMs);
  return { days, users, daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)) };
}
