import { supabase } from "./supabase.js";
import { getSettings } from "./settings.js";

// AI governance trail (fpx_ai_governance_log): who changed which prompt or
// model (before → after), AI rewrites/previews in Email Studio, and human
// reviews of AI output. The AI calls themselves are logged per call in
// fpx_ai_analyses (prompt, response, model, tokens, cost, user).
//
// Logging is on by default and controlled by the ai.governance.logging
// setting. Turning it off (or on) is itself always recorded.

export async function governanceLoggingEnabled() {
  try {
    const s = await getSettings("ai.governance.logging");
    return s["ai.governance.logging"] !== false;
  } catch { return true; }
}

// Which AI feature a setting key belongs to, e.g.
// prompt.email_draft.carrier_group.audience → email_draft.carrier_group
export function featureForKey(key) {
  const k = String(key || "");
  if (k.startsWith("model.")) return "all (default model)";
  if (!k.startsWith("prompt.")) return null;
  const parts = k.slice(7).split(".");
  if (parts.length > 1) parts.pop();
  return parts.join(".") || k.slice(7);
}

// Setting keys that govern AI behaviour.
export function isAiSettingKey(key) {
  return /^(prompt\.|model\.|ai\.)/.test(String(key || "")) || key === "action.threshold";
}

export function eventTypeForKey(key) {
  if (key === "ai.governance.logging") return "logging_change";
  if (/^model\.|\.model$/.test(key)) return "model_change";
  if (key.startsWith("prompt.")) return "prompt_change";
  return "ai_setting_change";
}

export async function logGovernance(req, entry, { force = false } = {}) {
  try {
    if (!force && !(await governanceLoggingEnabled())) return;
    const realUser = req?.realUser || req?.user;
    const row = {
      event_type: entry.event_type,
      feature: entry.feature || null,
      setting_key: entry.setting_key || null,
      actor_email: realUser?.email || req?.apiKey?.name || null,
      actor_source: realUser ? "jwt" : req?.apiKey ? "api_key" : "system",
      summary: entry.summary || null,
      before: entry.before === undefined ? null : entry.before,
      after: entry.after === undefined ? null : entry.after,
      analysis_id: entry.analysis_id || null,
      metadata: {
        ...(entry.metadata || {}),
        ...(req?.impersonating ? { impersonated_as: req.impersonating.target?.email || null } : {}),
      },
    };
    const { error } = await supabase.from("fpx_ai_governance_log").insert(row);
    if (error) console.warn("[FPX-GOV] insert failed:", error.message);
  } catch (e) {
    console.warn("[FPX-GOV] log failed:", e.message);
  }
}
