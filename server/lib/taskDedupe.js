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
import { isRedeliveryTitle } from "./redelivery.js";

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

// Confidence (0-100) that `older` really is replaced by `keep`, with the
// reasons in plain words. Deterministic, no model call.
//   high   ≥ 80  safe to replace without a person looking
//   medium 50-79 probably a duplicate
//   low    < 50  someone should look first
export const CONFIDENCE_AUTO = 80;   // on task creation, only these are replaced
export const CONFIDENCE_REVIEW = 50; // the clean-up command's default floor

const STOP = new Set(["fpx", "should", "contact", "the", "to", "and", "a", "of", "for", "today", "immediately", "carrier", "customer", "followup", "redelivery", "attempt"]);
function words(title) {
  return new Set(String(title || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}
const kindOf = (title) => (isRedeliveryTitle(title) ? "redelivery" : "standard");

export function dedupeConfidence(keep, older) {
  let score = 55;
  const reasons = [];
  const sameKind = kindOf(keep.title) === kindOf(older.title);
  if (sameKind) {
    score += 30;
    reasons.push(kindOf(keep.title) === "redelivery" ? "both are redelivery tasks; the newer attempt replaces the older" : "same kind of followup");
  } else {
    score += 10;
    reasons.push("different kind of followup (redelivery vs general)");
  }
  const sim = similarity(keep.title, older.title);
  score += Math.round(sim * 14);
  if (sim >= 0.5) reasons.push("wording is very similar");
  if (older.status === "in_progress" || older.status === "blocked") {
    score -= 40;
    reasons.push(older.status === "blocked" ? "the older task is blocked" : "the older task is in progress");
  }
  if (older.assigned_to && keep.assigned_to && older.assigned_to !== keep.assigned_to) {
    score -= 15;
    reasons.push("different owners");
  }
  return { confidence: Math.max(5, Math.min(99, score)), reasons };
}

// Pure. Never mutates `tasks`. Older tasks scoring below `minConfidence`
// are left alone and listed under `held`.
export function planDedupe(tasks, { minConfidence = 0 } = {}) {
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
    const [keep, ...all] = sorted;
    const scored = all.map((r) => ({ r, ...dedupeConfidence(keep, r) }));
    const withScore = (x) => ({ ...slim(x.r), confidence: x.confidence, reasons: x.reasons });
    const older = scored.filter((x) => x.confidence >= minConfidence).map((x) => x.r);
    groups.push({
      shipment_id,
      tracking_number: sorted.map((r) => r.tracking_number).find(Boolean) ?? null,
      audience,
      keep: slim(keep),
      supersede: scored.filter((x) => x.confidence >= minConfidence).map(withScore),
      held: scored.filter((x) => x.confidence < minConfidence).map(withScore),
      confidence: Math.min(...scored.map((x) => x.confidence)),
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
    min_confidence: minConfidence,
    supersede_count: groups.reduce((n, g) => n + g.supersede.length, 0),
    held_count: groups.reduce((n, g) => n + g.held.length, 0),
    shipments: Array.from(new Set(groups.filter((g) => g.supersede.length).map((g) => g.shipment_id))),
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
      const scored = Number.isFinite(s.confidence) ? note.replace(/\]$/, ` — confidence ${s.confidence}%]`) : note;
      const description = [now.description, scored].filter(Boolean).join("\n\n");
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
export async function supersedeOlderFor(supabase, shipmentIds, { who, dryRun = false, minConfidence = CONFIDENCE_AUTO } = {}) {
  const ids = uniqStrings(shipmentIds);
  const tasks = ids.length ? await loadActiveForDedupe(supabase, { shipmentIds: ids }) : [];
  const plan = planDedupe(tasks, { minConfidence });
  if (dryRun) return { plan, result: null };
  const result = await applyDedupe(supabase, plan, { who });
  return { plan, result };
}
