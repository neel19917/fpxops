import { supabase } from "./supabase.js";
import { getSettings } from "./settings.js";

// USD per 1M tokens. Keep this in sync with anthropic.com/pricing — falling
// off the table downgrades the cost calc to Haiku defaults silently.
const MODEL_PRICING = {
  "claude-haiku-4-5-20251001":  { input: 0.80, output:  4.00 },
  "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00 },
  "claude-sonnet-4-6":          { input: 3.00, output: 15.00 },
  "claude-opus-4-7":            { input: 15.00, output: 75.00 },
};

const LARGE_PROMPT_CHARS = 12000;

// Settings-aware model picker. Reads model.default and model.large from
// fpx_settings (with env-var fallback) so admins can switch models without a
// redeploy.
async function pickModel(systemPrompt, userMessage, override) {
  if (override) return override;
  const len = (systemPrompt || "").length + (userMessage || "").length;
  const { "model.default": defaultModel, "model.large": largeModel } =
    await getSettings("model.default", "model.large");
  return len >= LARGE_PROMPT_CHARS ? largeModel : defaultModel;
}

// Extract structured fields from a Claude JSON response. Supports both the
// legacy `actionRequired: bool` shape and the newer `actionConfidence` +
// `actionTarget` shape. The threshold (default 0.7) is applied here so callers
// always see a YES/NO answer in `action_required`.
export function extractAiJsonFields(text, threshold = 0.7) {
  const out = {
    action_required: null,
    action_confidence: null,
    action_target: null,
    issue: null,
    recommendation: null,
  };
  if (!text) return out;
  const iM = text.match(/"issue"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (iM) out.issue = iM[1];
  const rM = text.match(/"recommendation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (rM) out.recommendation = rM[1];

  const cM = text.match(/"actionConfidence"\s*:\s*([0-9.]+)/);
  if (cM) {
    const n = Number(cM[1]);
    if (Number.isFinite(n)) out.action_confidence = Math.max(0, Math.min(1, n));
  }
  const tM = text.match(/"actionTarget"\s*:\s*"(customer|carrier|none)"/i);
  if (tM) out.action_target = tM[1].toLowerCase();

  // New shape wins: derive YES/NO from confidence.
  if (out.action_confidence !== null) {
    out.action_required = out.action_confidence >= threshold && out.action_target !== "none" ? "YES" : "NO";
  } else if (/"actionRequired"\s*:\s*true\b/.test(text)) {
    out.action_required = "YES";
  } else if (/"actionRequired"\s*:\s*false\b/.test(text)) {
    out.action_required = "NO";
  }
  return out;
}

export async function callClaude({
  systemPrompt,
  userMessage,
  maxTokens = 1024,
  modelOverride,
  metadata = {}, // { kind, tracking_number, shipment_uuid, gp_audit_id, invoice_audit_id, api_key_id }
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ANTHROPIC_API_KEY not configured" };
  const model = await pickModel(systemPrompt, userMessage, modelOverride);
  const startedAt = Date.now();

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (e) {
    await logAnalysis({
      ...metadata,
      model,
      system_prompt: systemPrompt,
      user_message: userMessage,
      duration_ms: Date.now() - startedAt,
      error: e.message,
    });
    return { error: e.message };
  }

  const durationMs = Date.now() - startedAt;
  if (!resp.ok) {
    const body = await resp.text();
    await logAnalysis({
      ...metadata,
      model,
      system_prompt: systemPrompt,
      user_message: userMessage,
      duration_ms: durationMs,
      error: `API ${resp.status}: ${body.slice(0, 500)}`,
    });
    return { error: `API ${resp.status}: ${body.slice(0, 200)}` };
  }

  const json = await resp.json();
  const text = json.content?.[0]?.text || "";
  const inTok = json.usage?.input_tokens || 0;
  const outTok = json.usage?.output_tokens || 0;
  const pricing = MODEL_PRICING[model] || { input: 0.80, output: 4.00 };
  const costUsd = (inTok * pricing.input + outTok * pricing.output) / 1_000_000;

  const analysisId = await logAnalysis({
    ...metadata,
    model,
    system_prompt: systemPrompt,
    user_message: userMessage,
    response_text: text,
    input_tokens: inTok,
    output_tokens: outTok,
    cost_usd: costUsd,
    duration_ms: durationMs,
  });

  // Re-parse so callers can see the structured fields without parsing the
  // response themselves. Threshold comes from settings; missing-on-failure
  // falls back to the default 0.7.
  let parsed = { action_required: null, action_confidence: null, action_target: null, issue: null, recommendation: null };
  try {
    const { "action.threshold": threshold } = await getSettings("action.threshold");
    parsed = extractAiJsonFields(text, Number(threshold) || 0.7);
  } catch {}

  return {
    text, model, input_tokens: inTok, output_tokens: outTok, cost_usd: costUsd, analysis_id: analysisId,
    parsed,
  };
}

async function logAnalysis(entry) {
  const { action_required, issue, recommendation } = extractAiJsonFields(entry.response_text || "");
  const row = {
    kind: entry.kind || "other",
    shipment_uuid: entry.shipment_uuid || null,
    tracking_number: entry.tracking_number || null,
    gp_audit_id: entry.gp_audit_id || null,
    invoice_audit_id: entry.invoice_audit_id || null,
    model: entry.model || null,
    system_prompt: entry.system_prompt || null,
    user_message: entry.user_message || null,
    response_text: entry.response_text || null,
    action_required: entry.action_required || action_required,
    issue: entry.issue || issue,
    recommendation: entry.recommendation || recommendation,
    input_tokens: entry.input_tokens ?? null,
    output_tokens: entry.output_tokens ?? null,
    cost_usd: entry.cost_usd ?? null,
    duration_ms: entry.duration_ms ?? null,
    source: "railway",
    user_email: entry.user_email || null,
    error: entry.error || null,
    metadata: { api_key_id: entry.api_key_id, ...(entry.metadata || {}) },
  };
  const { data, error } = await supabase.from("fpx_ai_analyses").insert(row).select("id").single();
  if (error) {
    console.warn("[FPX-SB] Analysis log failed:", error.message);
    return null;
  }
  return data?.id || null;
}
