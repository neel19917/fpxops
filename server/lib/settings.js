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
  "action.threshold": 0.7,
  "action.auto_draft_enabled": true,
  "model.default": process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  "model.large": process.env.ANTHROPIC_MODEL_LARGE || "claude-sonnet-4-6",
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
