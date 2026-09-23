import { supabase } from "./supabase.js";
import * as DEFAULTS from "../prompts.js";

// Hard-coded fallbacks for every key the app reads. If the fpx_settings table
// is missing or unreachable, we still want sensible behavior.
const FALLBACKS = {
  "prompt.system": DEFAULTS.SYSTEM_PROMPT,
  "prompt.per_shipment": DEFAULTS.PER_SHIPMENT_PROMPT,
  "prompt.per_shipment_logic": DEFAULTS.PER_SHIPMENT_LOGIC,
  "prompt.priority": DEFAULTS.PRIORITY_PROMPT,
  "prompt.summary": DEFAULTS.SUMMARY_PROMPT,
  "prompt.gp_system": DEFAULTS.GP_SYSTEM_PROMPT,
  "prompt.gp_exec_summary": DEFAULTS.GP_EXEC_SUMMARY_PROMPT,
  "prompt.gp_row_review": DEFAULTS.GP_ROW_REVIEW_PROMPT,
  "prompt.invoice_system": DEFAULTS.INVOICE_SYSTEM_PROMPT,
  "prompt.invoice_exec_summary": DEFAULTS.INVOICE_EXEC_SUMMARY_PROMPT,
  "prompt.invoice_row_review": DEFAULTS.INVOICE_ROW_REVIEW_PROMPT,
  "prompt.email_draft.system_base":
    'You are a freight brokerage operations assistant at FPX. FPX is the freight broker — not the carrier and not the customer. You always write FROM FPX. Drafting an email now. {{audienceCopy}} Output strict JSON: {"subject": "...", "body": "..."}. Body should be plain text with line breaks (\'\\n\') — no markdown. Sign as "[Your name]\\nFPX Operations" (do not invent a name).',
  "prompt.email_draft.audience_carrier":
    "Write a concise, professional email FROM the FPX brokerage operations team TO the carrier handling this shipment. Ask for the specific information needed to resolve the issue or confirm status. Reference carrier-side identifiers (PRO, pickup number, carrier-issued tracking).",
  "prompt.email_draft.audience_customer":
    "Write a concise, professional email FROM the FPX brokerage account team TO the end customer (the shipper or consignee, not the carrier). Update them on shipment status in plain English; avoid carrier jargon. If action is required from the customer, state it clearly. Otherwise reassure them FPX is monitoring and following up directly with the carrier.",
  // Bulk carrier-followup email: one email per carrier covering every
  // followup-tagged task assigned to that carrier. Routed through the
  // larger model by default so the model can synthesize across many
  // shipments without losing detail.
  "prompt.email_draft.carrier_group.system_base":
    'You are a freight brokerage operations assistant at FPX. FPX is the freight broker — not the carrier and not the customer. You always write FROM FPX. {{audienceCopy}} You will be given a list of multiple shipments handled by ONE carrier that need follow-up. Synthesize them into a single email — one greeting, one closing, and a numbered or bulleted list of every shipment in between. Each shipment line must include the tracking number, FPX shipment id (if present), pickup/delivery cities, current status, and the specific question or action you need from the carrier (e.g. updated ETA, POD, pickup confirmation). Group multiple identical asks together where it improves readability. Output strict JSON: {"subject": "...", "body": "..."}. Body should be plain text with line breaks (\'\\n\') — no markdown. Sign as "[Your name]\\nFPX Operations" (do not invent a name).',
  "prompt.email_draft.carrier_group.audience":
    "Write ONE concise, professional email FROM the FPX brokerage operations team TO the carrier covering ALL of the carrier's open follow-up shipments at once. The goal is to consolidate what would otherwise be multiple per-shipment emails into a single round-up. Be direct about what FPX needs; the carrier should be able to reply once with the full set of answers.",
  // Model used for the carrier-group email synthesis. Defaulting to Opus
  // because this is a multi-shipment, multi-question task where the
  // larger model produces noticeably tighter consolidations. Admins can
  // dial back to Sonnet/Haiku in Settings if they want.
  "prompt.email_draft.carrier_group.model": "claude-opus-4-7",
  // Bulk customer-followup email: one email per customer covering every
  // followup-tagged task assigned to that customer. Same shape as
  // carrier_group, audience flipped — recipient is the shipper /
  // consignee, not the carrier.
  "prompt.email_draft.customer_group.system_base":
    'You are a freight brokerage account team assistant at FPX. FPX is the freight broker — not the carrier and not the customer. You always write FROM FPX. {{audienceCopy}} You will be given a list of multiple shipments belonging to ONE customer that need a status update. Synthesize them into a single email — one greeting, one closing, and a numbered or bulleted list of every shipment in between. Each shipment line must include the FPX shipment id, tracking number (if relevant), origin → destination cities, current status in plain English (avoid carrier jargon), and either the next milestone (ETA, delivery window) or the action FPX is taking on the customer\'s behalf. Group similar updates where it improves readability. Output strict JSON: {"subject": "...", "body": "..."}. Body should be plain text with line breaks (\'\\n\') — no markdown. Sign as "[Your name]\\nFPX Operations" (do not invent a name).',
  "prompt.email_draft.customer_group.audience":
    "Write ONE concise, professional email FROM the FPX brokerage account team TO the end customer (the shipper/consignee, not the carrier) covering ALL of the customer's open shipments at once. Plain English; reassure them FPX is monitoring and following up directly with carriers as needed. State clearly when an action is required from the customer (signature, appointment confirmation, etc).",
  // Same Opus default as carrier_group for the same reason.
  "prompt.email_draft.customer_group.model": "claude-opus-4-7",
  "action.threshold": 0.7,
  "action.auto_draft_enabled": true,
  "model.default": process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  // Large = long prompts (≥ ~12k chars) and any board-level synthesis.
  // Bumped to Opus 5 on 2026-09-22: the tasks page moved to heavier
  // models for cross-task judgement and the Sonnet 4.6 default was
  // noticeably weaker at it. Admins can dial back in Settings.
  "model.large": process.env.ANTHROPIC_MODEL_LARGE || "claude-opus-5",
  // Tasks v2 board-level triage: one heavy-model pass over the active board
  // that ranks work, names what is moot, and batches tasks to work together.
  // Opus 5 by default — this is exactly the kind of many-item, cross-item
  // judgement the smaller models get wrong (they rank by recency and miss
  // that a delivered shipment's task is moot).
  "prompt.task_triage.model": "claude-opus-5",
  "prompt.task_triage.system":
    'You are the operations lead at FPX, a freight broker. You are triaging the open follow-up task board for the tracking team (Allen, Victor). FPX is the broker — not the carrier and not the customer.\n\n' +
    'Each task belongs to one shipment and carries: a segment (redelivery / return_claim / carrier / customer / other), health flags computed from the latest scrape (resolved_upstream = shipment delivered/archived or AI no longer flags it; stale = carrier data not refreshed recently; duplicate = other active tasks on the same shipment; repeat = 2nd+ failed delivery attempt; aging; unassigned; blocked), the shipment\'s current status/ETA/comment, and the AI issue line.\n\n' +
    'Produce a triage the team can act on in the next hour:\n' +
    '1. priority_queue — the tasks to work FIRST, most urgent at the top (at most 15). Urgent means: customer-visible failure right now (failed delivery, refusal, return), money at risk (claims, charges), or a hard deadline (appointment today/tomorrow). For each give a one-sentence reason and the concrete first_action (who to call/email and what to ask).\n' +
    '2. close_candidates — tasks that are probably moot and should be dismissed, with disposition: resolved (shipment delivered / no longer flagged), stale (no fresh data for a long time; likely delivered months ago), duplicate (another active task covers it), superseded (a newer attempt/pair replaces it), not_actionable. Be decisive but do not close a task just because it is old if the shipment still shows a live problem.\n' +
    '3. batches — groups of 2+ tasks that should be worked in ONE call or email (same consignee location, same carrier terminal, same customer). Give a label and reason.\n' +
    '4. risks — up to 5 short observations the lead should know (e.g. "3 Modesto redeliveries for the same consignee — likely a receiving-hours problem").\n' +
    '5. summary — 2-3 plain sentences for the standup.\n\n' +
    'Rules: only reference task_id values that appear in the input. Do not invent shipments. Never put the same task_id in both priority_queue and close_candidates. Be terse: every reason and first_action is ONE sentence under 25 words; at most 15 priority_queue items, 30 close_candidates (the clearest cases first), 8 batches, 5 risks. Output strict JSON only, no prose before or after, with keys: summary, priority_queue [{task_id, reason, first_action}], close_candidates [{task_id, disposition, reason}], batches [{label, reason, task_ids}], risks [string].',
  // Tasks v2 daily executive summary (lib/dailySummary.js): long-form
  // Markdown brief over a numeric digest of the last 24h. Heavy model on
  // purpose — it has to weigh ~10 sections of facts against each other.
  "prompt.daily_summary.model": "claude-opus-5",
  "prompt.daily_summary.system":
    'You are chief of staff to the Director of Operations at FPX, a freight broker. Every day you write the operations brief for the tracking team (Allen, Victor) and their director. You are given a JSON digest covering the last window (default 24h): tasks created / completed / dismissed, the live task board with segments and health flags, shipments scraped and newly flagged, storage and redelivery exposures, per-operator activity, notes, and AI spend.\n\n' +
    'Write a DETAILED brief in Markdown with exactly these sections, in this order, using these headings:\n' +
    '# Daily Operations Brief — <window end date>\n' +
    '## 1. Headline\n3-5 bullets: the things the director must know in 30 seconds. Lead with customer-visible failures and money at risk.\n' +
    '## 2. KPIs\nA Markdown table: metric | value | note. Include active tasks, needs attention, created / completed / dismissed today, likely-resolved backlog, stale-data count, unassigned, shipments scraped, newly flagged, delivered, AI spend (USD).\n' +
    '## 3. What moved today\nWhat was created (by segment), completed and dismissed — with tracking numbers and customers for the notable ones — and who did it.\n' +
    '## 4. Live exposures (work first)\nRanked list of the needs-attention items: redelivery, return/claim, storage risk, repeat failures. For each: tracking number, customer, carrier, what is wrong (hours held / attempt number / status), owner, and the concrete next action. Storage-risk items must state the projected hold hours and the appointment date.\n' +
    '## 5. Carrier hotspots\nCarriers with the most open work and what pattern you see (e.g. one carrier not posting POD scans). Cite counts.\n' +
    '## 6. Customer hotspots\nCustomers with several open items; whether a single call could cover them.\n' +
    '## 7. Team throughput\nPer operator: tasks completed, dismissed, notes written, items still in progress, anything aging on their plate. Neutral tone, numbers first.\n' +
    '## 8. Data & system health\nScrape volume and last scrape time, stale shipments, likely-resolved tasks that should be dismissed, respawn or duplicate risk, anything that looks like a data-quality problem (e.g. carrier history not found), and AI cost by kind.\n' +
    '## 9. Plan for tomorrow\nOrdered checklist (8-12 items) with an owner where obvious.\n' +
    '## 10. Questions for leadership\n2-4 decisions or policy questions surfaced by today\'s data.\n\n' +
    'Rules: use ONLY facts present in the digest; never invent shipments, numbers, or names. Always cite tracking numbers when you mention a shipment. Be dense and specific — no filler, no generic advice. 900-1500 words. Markdown only, no code fences, no preamble.',
  // Storage-charge risk on delivery holds (lib/storageRisk.js). Carriers on
  // this list bill storage once freight sits at the destination terminal
  // longer than hold_hours waiting for an appointment. Comma-separated
  // substrings matched against carrier_name. XPO is the confirmed case
  // (Allen/Victor, 2026-09-23); add others as they're confirmed.
  "storage.carriers": "XPO",
  "storage.hold_hours": 48,
  // Days without a scrape before a task's shipment data counts as stale on
  // the Tasks v2 board. 7 = "not seen this week"; the scraper normally hits
  // every live shipment daily, so anything past that has dropped off the
  // FreightPOP grid.
  "ui.tasks.stale_days": 7,
  // FreightPOP iframe embed in the shipment drawer. On by default; admins
  // can flip off in /admin/settings if iframe embedding is blocked for
  // their tenant. The url_template is normally the base FreightPOP URL —
  // FreightPOP has no deep-link route for an individual shipment, so the
  // drawer surfaces the tracking number next to the iframe for paste-into-
  // search (mirrors how the Chrome extension navigates the live grid).
  // Placeholder substitution still works ({tracking_number}, {shipment_id},
  // {order_number}) for tenants with custom URL routes.
  "embed.freightpop.enabled": true,
  "embed.freightpop.url_template": "https://app.freightpop.com/dashboard",
  // How long the "Changed Xh ago" pill stays on a Tracking row after
  // the most recent material change. Admin-tunable from /admin/settings;
  // 24h is a sensible default ("anything that moved during my shift").
  // Setting to 0 hides the pill entirely without disabling the
  // last_material_change_at column itself.
  "ui.tracking.recent_change_window_hours": 24,
  // Master switch for parcel shipments. OFF by default: parcel-mode rows
  // are hidden from the Tracking page AND no auto-tasks spawn for them
  // (operators don't follow the carrier/customer-followup playbook on
  // parcel exceptions). Flip ON in /admin/settings to surface parcels in
  // the Tracking list again and resume auto-task creation for them. The
  // upsert itself is unaffected either way — parcel rows, counts, and
  // metadata always persist; this only governs visibility + task spawn.
  "ui.tracking.show_parcels": false,
};

const TTL_MS = 30_000;
let cache = null;
let cacheLoadedAt = 0;
let inflight = null;

async function loadFromDb() {
  const { data, error } = await supabase.from("fpx_settings").select("key, value, description, updated_by, updated_at");
  if (error) {
    console.warn("[FPX] settings load failed:", error.message);
    return null;
  }
  const next = {};
  for (const row of data || []) next[row.key] = row;
  return next;
}

async function ensureCache() {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const fresh = await loadFromDb();
    if (fresh) {
      cache = fresh;
      cacheLoadedAt = now;
    } else if (!cache) {
      // First load failed — empty cache so we serve fallbacks until next attempt.
      cache = {};
      cacheLoadedAt = now;
    }
    inflight = null;
    return cache;
  })();
  return inflight;
}

export async function getSetting(key) {
  const c = await ensureCache();
  const row = c[key];
  if (row && row.value !== undefined && row.value !== null) return row.value;
  return FALLBACKS[key];
}

// Synchronous read for hot paths that can't await (computeTemporalTriggers
// runs inside a sync JSON build). Serves the in-process cache when it has
// been loaded by any earlier async call — which is always the case on the
// analysis path, since the threshold is read first — and the hard-coded
// fallback otherwise. Never blocks, never throws.
export function getSettingsSync(...keys) {
  const c = cache || {};
  const out = {};
  for (const k of keys) {
    const row = c[k];
    out[k] = row && row.value !== undefined && row.value !== null ? row.value : FALLBACKS[k];
  }
  return out;
}

export async function getSettings(...keys) {
  const c = await ensureCache();
  const out = {};
  for (const k of keys) {
    const row = c[k];
    out[k] = row && row.value !== undefined && row.value !== null ? row.value : FALLBACKS[k];
  }
  return out;
}

// Returns the full set, including defaults for keys not yet in the DB. Used by
// the admin settings page so editors see every editable knob.
export async function getAllSettingsForAdmin() {
  const c = await ensureCache();
  const merged = {};
  for (const key of Object.keys(FALLBACKS)) {
    const row = c[key];
    merged[key] = {
      key,
      value: row?.value ?? FALLBACKS[key],
      default: FALLBACKS[key],
      isDefault: !row,
      description: row?.description || null,
      updated_by: row?.updated_by || null,
      updated_at: row?.updated_at || null,
    };
  }
  // Surface any unknown keys present in the DB too, so admins can see them.
  for (const [key, row] of Object.entries(c)) {
    if (merged[key]) continue;
    merged[key] = {
      key,
      value: row.value,
      default: null,
      isDefault: false,
      description: row.description || null,
      updated_by: row.updated_by || null,
      updated_at: row.updated_at || null,
    };
  }
  return Object.values(merged);
}

export async function setSetting(key, value, updatedBy) {
  if (typeof key !== "string" || !key) throw new Error("key required");
  const row = {
    key,
    value,
    updated_by: updatedBy || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("fpx_settings")
    .upsert(row, { onConflict: "key" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  // Invalidate cache; next read repopulates.
  cache = null;
  cacheLoadedAt = 0;
  return data;
}

export function invalidateSettingsCache() {
  cache = null;
  cacheLoadedAt = 0;
}

// Sync default for synchronous callers that need a string immediately. Only
// safe for prompts since their fallbacks are static strings.
export function getFallback(key) {
  return FALLBACKS[key];
}
