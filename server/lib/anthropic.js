import { supabase } from "./supabase.js";

const MODEL_PRICING = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
  "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00 },
};

const LARGE_PROMPT_CHARS = 12000;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const LARGE_MODEL = process.env.ANTHROPIC_MODEL_LARGE || "claude-sonnet-4-5-20250929";

function extractAiJsonFields(text) {
  if (!text) return { action_required: null, issue: null, recommendation: null };
  let issue = null, recommendation = null, action = null;
  const iM = text.match(/"issue"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (iM) issue = iM[1];
  const rM = text.match(/"recommendation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (rM) recommendation = rM[1];
  if (/"actionRequired"\s*:\s*true\b/.test(text)) action = "YES";
  else if (/"actionRequired"\s*:\s*false\b/.test(text)) action = "NO";
  return { action_required: action, issue, recommendation };
}

function pickModel(systemPrompt, userMessage, override) {
  if (override) return override;
  const len = (systemPrompt || "").length + (userMessage || "").length;
  return len >= LARGE_PROMPT_CHARS ? LARGE_MODEL : DEFAULT_MODEL;
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
  const model = pickModel(systemPrompt, userMessage, modelOverride);
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
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_MODEL];
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

  return { text, model, input_tokens: inTok, output_tokens: outTok, cost_usd: costUsd, analysis_id: analysisId };
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
