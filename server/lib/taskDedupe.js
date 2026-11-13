// Newest-task-wins dedupe for auto-created followup tasks.
//
// A shipment can pick up several active tasks for the same audience (a
// re-scrape raises a fresh "Carrier followup: ..." while the old one is
// still open). The newest task reflects the latest carrier data, so it
// takes precedence and the older ones are superseded.
//
// Duplicate key = shipment_id + audience. A carrier task and a customer
// task on the same shipment are NOT duplicates (redelivery deliberately
// creates the pair). Tasks whose title carries neither prefix (manual
// tasks) are never superseded and never supersede anything.
//
// Superseded rows are cancelled, never deleted: the cancelled row is the
// tombstone that stops auto-tasks respawning on the next scrape (same
// pattern as POST /tasks/v2/dismiss).

import { isStorageRiskTitle } from "./storageRisk.js";

export const DEDUPE_ACTIVE = ["open", "in_progress", "blocked"];

const TABLE = "fpx_shipment_tasks";
const CHUNK = 200;
const LOAD_LIMIT = 3000;
const LOAD_COLUMNS =
  "id, shipment_id, tracking_number, title, status, priority, assigned_to, created_at, updated_at, archived_at, email_queued_at, email_queued_by";

// Strict prefix match, unlike the loose includes() helpers in
// taskSegments.js / routes/tasks.js: only titles that START with the
// auto-task prefix count, so a manual "Ask customer about carrier
// followup" task is left alone.
const AUDIENCE_RE = /^\s*(carrier|customer) followup:/i;

export function taskAudience(title) {
  if (typeof title !== "string") return null;
  const m = title.match(AUDIENCE_RE);
  return m ? m[1].toLowerCase() : null;
}

function ms(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Newest first: created_at desc, then updated_at desc, then id desc.
function newestFirst(a, b) {
  return (
    cmp(ms(b.created_at), ms(a.created_at)) ||
    cmp(ms(b.updated_at), ms(a.updated_at)) ||
    cmp(String(b.id), String(a.id))
  );
}

function slim(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority ?? null,
    assigned_to: t.assigned_to ?? null,
    created_at: t.created_at ?? null,
    email_queued_at: t.email_queued_at ?? null,
    email_queued_by: t.email_queued_by ?? null,
  };
}

// Pure. Never mutates `tasks`.
export function planDedupe(tasks) {
  const byKey = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !t.id || !t.shipment_id || t.archived_at) continue;
    if (!DEDUPE_ACTIVE.includes(t.status)) continue;
    const audience = taskAudience(t.title);
    if (!audience) continue;
    // Storage risk is its own lane: a time-boxed warning that must survive a
    // newer ordinary followup (and must not cancel one either).
    const key = `${t.shipment_id}|${audience}|${isStorageRiskTitle(t.title) ? "storage" : "std"}`;
    if (!byKey.has(key)) byKey.set(key, { shipment_id: t.shipment_id, audience, rows: [] });
    byKey.get(key).rows.push(t);
  }

  const groups = [];
  for (const { shipment_id, audience, rows } of byKey.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort(newestFirst);
    const [keep, ...older] = sorted;
    groups.push({
      shipment_id,
      tracking_number: sorted.map((r) => r.tracking_number).find(Boolean) ?? null,
      audience,
      keep: slim(keep),
      supersede: older.map(slim),
      carry_queue: !keep.email_queued_at && older.some((r) => r.email_queued_at),
      working: older.some((r) => r.status === "in_progress" || r.status === "blocked"),
    });
  }

  groups.sort((a, b) => {
    // Missing tracking numbers sort last.
    if (!a.tracking_number !== !b.tracking_number) return a.tracking_number ? -1 : 1;
    return (
      cmp(String(a.tracking_number || ""), String(b.tracking_number || "")) ||
      cmp(a.audience, b.audience) ||
      cmp(String(a.shipment_id), String(b.shipment_id))
    );
  });

  return {
    groups,
    supersede_count: groups.reduce((n, g) => n + g.supersede.length, 0),
    shipments: Array.from(new Set(groups.map((g) => g.shipment_id))),
  };
}

function chunks(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function uniqStrings(arr) {
  return Array.from(new Set((Array.isArray(arr) ? arr : []).filter((x) => typeof x === "string" && x)));
}

// The superseded task that was queued most recently — its queue stamp is
// what moves to the keeper.
function latestQueued(supersede) {
  let best = null;
  for (const s of supersede) {
    if (!s.email_queued_at) continue;
    if (!best || ms(s.email_queued_at) > ms(best.email_queued_at)) best = s;
  }
  return best;
}

// Applies a plan from planDedupe. Per-row updates (each description gets
// its own note); a single-row failure is counted, not thrown.
//
// Returns { superseded, carried_queue, failed, skipped, ids }.
//   skipped = groups left alone because the keeper was closed/archived
//             since the plan was made (superseding its older siblings
//             would leave the shipment with no active task).
export async function applyDedupe(supabase, plan, { who } = {}) {
  const out = { superseded: 0, carried_queue: 0, failed: 0, skipped: 0, ids: [] };
  const groups = Array.isArray(plan?.groups) ? plan.groups.filter((g) => g?.keep?.id && g.supersede?.length) : [];
  if (!groups.length) return out;

  const by = String(who || "").trim() || "system";
  const stamp = new Date().toISOString().slice(0, 10);

  // Fresh read: current status (the plan may be stale) and the description
  // we append to (the plan's slim rows don't carry it).
  const allIds = uniqStrings(groups.flatMap((g) => [g.keep.id, ...g.supersede.map((s) => s.id)]));
  const fresh = new Map();
  let readFailed = false;
  for (const part of chunks(allIds)) {
    const { data, error } = await supabase
      .from(TABLE).select("id, status, description, archived_at").in("id", part);
    if (error) { readFailed = true; continue; }
    for (const r of data || []) fresh.set(r.id, r);
  }

  for (const g of groups) {
    const keepNow = fresh.get(g.keep.id);
    if (!keepNow) {
      // Couldn't confirm the keeper is still active — don't cancel its siblings.
      if (readFailed) out.failed += g.supersede.length; else out.skipped++;
      continue;
    }
    if (!DEDUPE_ACTIVE.includes(keepNow.status) || keepNow.archived_at) { out.skipped++; continue; }

    // Carry the queue stamp first, so a failure can't leave the shipment
    // with the stamp cleared on the old task and never set on the new one.
    let carryOk = true;
    if (g.carry_queue) {
      const src = latestQueued(g.supersede);
      if (src) {
        const { data, error } = await supabase.from(TABLE)
          .update({ email_queued_at: src.email_queued_at, email_queued_by: src.email_queued_by ?? null })
          .eq("id", g.keep.id)
          .in("status", DEDUPE_ACTIVE)
          .is("email_queued_at", null)
          .select("id");
        if (error) { carryOk = false; }
        else if ((data || []).length) out.carried_queue++;
      }
    }
    if (!carryOk) { out.failed += g.supersede.length; continue; }

    const note = `[${stamp} superseded by newer task ${String(g.keep.id).slice(0, 8)} — ${by}]`;
    for (const s of g.supersede) {
      const now = fresh.get(s.id);
      if (!now) { if (readFailed) out.failed++; continue; }
      if (!DEDUPE_ACTIVE.includes(now.status)) continue; // closed in the meantime
      const description = [now.description, note].filter(Boolean).join("\n\n");
      const { data, error } = await supabase.from(TABLE)
        .update({ status: "cancelled", description, completed_at: null, email_queued_at: null, email_queued_by: null })
        .eq("id", s.id)
        .in("status", DEDUPE_ACTIVE)
        .select("id");
      if (error) { out.failed++; continue; }
      if ((data || []).length) { out.superseded++; out.ids.push(s.id); }
    }
  }
  return out;
}

// All active, non-archived tasks (cap 3000), optionally narrowed.
//   shipmentIds — only tasks on those shipments.
//   taskIds     — only tasks on the SHIPMENTS of those tasks, so the newer
//                 sibling is found even when it wasn't selected.
// Both given → union of the two shipment sets. Throws on a query error.
export async function loadActiveForDedupe(supabase, { shipmentIds, taskIds } = {}) {
  const narrowed = shipmentIds !== undefined && shipmentIds !== null || taskIds !== undefined && taskIds !== null;
  const ships = new Set(uniqStrings(shipmentIds));

  for (const part of chunks(uniqStrings(taskIds))) {
    const { data, error } = await supabase.from(TABLE).select("id, shipment_id").in("id", part);
    if (error) throw new Error(error.message || "Failed to load tasks");
    for (const r of data || []) if (r.shipment_id) ships.add(r.shipment_id);
  }

  const base = () => supabase.from(TABLE).select(LOAD_COLUMNS)
    .in("status", DEDUPE_ACTIVE).is("archived_at", null);

  if (!narrowed) {
    const { data, error } = await base().order("created_at", { ascending: false }).limit(LOAD_LIMIT);
    if (error) throw new Error(error.message || "Failed to load tasks");
    return data || [];
  }

  const rows = [];
  for (const part of chunks(Array.from(ships))) {
    if (rows.length >= LOAD_LIMIT) break;
    const { data, error } = await base().in("shipment_id", part).limit(LOAD_LIMIT);
    if (error) throw new Error(error.message || "Failed to load tasks");
    rows.push(...(data || []));
  }
  return rows.slice(0, LOAD_LIMIT);
}

// Load → plan → apply for a set of shipments. For callers that just
// created a task and want its older siblings out of the way.
export async function supersedeOlderFor(supabase, shipmentIds, { who, dryRun = false } = {}) {
  const ids = uniqStrings(shipmentIds);
  const tasks = ids.length ? await loadActiveForDedupe(supabase, { shipmentIds: ids }) : [];
  const plan = planDedupe(tasks);
  if (dryRun) return { plan, result: null };
  const result = await applyDedupe(supabase, plan, { who });
  return { plan, result };
}
