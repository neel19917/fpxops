// One identity per operator.
//
// Task owners arrive as three different strings for the same person: the
// extension sends the runner's display name ("Victor Zarate", "Allen") in
// x-fpx-user-name, which becomes fpx_shipments.created_by and then the
// auto-task's assigned_to; the dashboard's UserPicker emits the email
// ("victorz@freightpop.com"). On 2026-09-23 the Tasks v2 owner rail showed
// "victorz@freightpop.com 27 / Victor Zarate 1" — the same person twice.
//
// Canonical form = the fpx_user_profiles email. resolveAssignee() maps any
// of email / full name / unique first name onto it; displayName() goes the
// other way for the UI. Unknown strings pass through unchanged so a
// free-text assignee is never silently dropped.

import { supabase } from "./supabase.js";

const TTL_MS = 60_000;
let cache = null;       // { byKey: Map<lowercased key, email>, names: Map<email, full_name> }
let loadedAt = 0;
let inflight = null;

async function load() {
  const { data, error } = await supabase
    .from("fpx_user_profiles").select("email, full_name, enabled");
  if (error) throw new Error(error.message);
  return buildIndex(data || []);
}

// Pure: profiles → lookup index. Exported for tests.
export function buildIndex(profiles) {
  const byKey = new Map();
  const names = new Map();
  const firstNames = new Map(); // first name → Set<email>, to detect ambiguity
  for (const p of profiles) {
    const email = String(p.email || "").trim().toLowerCase();
    if (!email) continue;
    const full = String(p.full_name || "").trim();
    names.set(email, full || email);
    byKey.set(email, email);
    if (full) {
      byKey.set(full.toLowerCase(), email);
      const first = full.split(/\s+/)[0].toLowerCase();
      if (!firstNames.has(first)) firstNames.set(first, new Set());
      firstNames.get(first).add(email);
    }
  }
  // A bare first name resolves only when exactly one profile has it.
  for (const [first, emails] of firstNames) {
    if (emails.size === 1 && !byKey.has(first)) byKey.set(first, Array.from(emails)[0]);
  }
  return { byKey, names };
}

export async function peopleIndex() {
  const now = Date.now();
  if (cache && now - loadedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = load()
    .then((idx) => { cache = idx; loadedAt = Date.now(); return idx; })
    .catch((e) => { console.warn("[FPX] people index load failed:", e.message); return cache || buildIndex([]); })
    .finally(() => { inflight = null; });
  return inflight;
}

// Pure variant used by the async wrapper and by tests.
export function resolveWithIndex(idx, raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  return idx.byKey.get(s.toLowerCase()) || s;
}

export async function resolveAssignee(raw) {
  const idx = await peopleIndex();
  return resolveWithIndex(idx, raw);
}

// email → { email: full_name } for everyone we know, so the UI can show
// names while grouping/filtering on the stable email.
export async function peopleMap() {
  const idx = await peopleIndex();
  return Object.fromEntries(idx.names);
}
