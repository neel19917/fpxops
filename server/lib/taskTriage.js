// AI triage for the Tasks v2 board.
//
// One call over the whole active board (or a segment of it) with the heavy
// model: rank what to work first, name what is probably moot, and batch
// tasks that should be worked in one call (same consignee, same carrier
// terminal). This is deliberately a board-level pass, not per-task — the
// per-shipment analysis already runs on Haiku for every scrape; the value
// here is cross-task judgement, which needs the larger model and the whole
// picture at once.
//
// Output is strict JSON validated against the input id set, so a
// hallucinated task id can never reach the UI.

import { callClaude } from "./anthropic.js";
import { getSettings } from "./settings.js";

// Hard cap on rows per triage call. Keeps the prompt inside a sane size and
// the cost predictable (~150 rows ≈ 40k input tokens on the slim shape).
export const TRIAGE_MAX_ROWS = 150;

// Slim row the model sees. Mirrors what an operator reads on the board;
// nothing the model doesn't need (raw_data, prompts, uuids other than the
// task id it must echo back).
export function slimRowForTriage(row) {
  const t = row.task || {};
  const s = row.shipment || {};
  const seg = row.seg || {};
  return {
    task_id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assigned_to: t.assigned_to || null,
    age_days: seg.age_days ?? null,
    segment: seg.segment,
    attempt: seg.attempt ?? null,
    flags: seg.flags || [],
    health: seg.health || null,
    shipment: s.id ? {
      tracking_number: s.tracking_number,
      customer: s.customer_name,
      carrier: s.carrier_name || s.carrier,
      mode: s.mode,
      status: s.shipment_status,
      eta: s.updated_eta,
      delivered: s.delivery_date,
      days_since_scrape: seg.days_since_scrape ?? null,
      action_required: s.action_required,
      ai_issue: s.ai_issue ? String(s.ai_issue).slice(0, 240) : null,
      carrier_comment: s.tracking_comments ? String(s.tracking_comments).slice(0, 160) : null,
      destination: s.destination,
    } : null,
  };
}

const ALLOWED_DISPOSITIONS = new Set(["resolved", "stale", "duplicate", "superseded", "not_actionable"]);

// Validate + normalize the model's JSON against the ids we sent. Unknown
// ids are dropped, not errored — one bad id shouldn't sink the whole triage.
export function normalizeTriage(parsed, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const out = { summary: "", priority_queue: [], close_candidates: [], batches: [], risks: [], dropped_ids: 0 };
  if (!parsed || typeof parsed !== "object") return out;
  out.summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";

  const seen = new Set();
  for (const item of Array.isArray(parsed.priority_queue) ? parsed.priority_queue : []) {
    const id = String(item?.task_id || "");
    if (!known.has(id) || seen.has(id)) { if (id) out.dropped_ids++; continue; }
    seen.add(id);
    out.priority_queue.push({
      task_id: id,
      rank: out.priority_queue.length + 1,
      reason: String(item?.reason || "").trim(),
      first_action: String(item?.first_action || "").trim(),
    });
  }
  const closeSeen = new Set();
  for (const item of Array.isArray(parsed.close_candidates) ? parsed.close_candidates : []) {
    const id = String(item?.task_id || "");
    if (!known.has(id) || closeSeen.has(id)) { if (id) out.dropped_ids++; continue; }
    closeSeen.add(id);
    const disp = String(item?.disposition || "").toLowerCase();
    out.close_candidates.push({
      task_id: id,
      disposition: ALLOWED_DISPOSITIONS.has(disp) ? disp : "not_actionable",
      reason: String(item?.reason || "").trim(),
    });
  }
  for (const b of Array.isArray(parsed.batches) ? parsed.batches : []) {
    const ids = Array.from(new Set((Array.isArray(b?.task_ids) ? b.task_ids : []).map(String).filter((id) => known.has(id))));
    if (ids.length < 2) continue;
    out.batches.push({ label: String(b?.label || "Batch").trim(), reason: String(b?.reason || "").trim(), task_ids: ids });
  }
  out.risks = (Array.isArray(parsed.risks) ? parsed.risks : []).map((r) => String(r || "").trim()).filter(Boolean).slice(0, 10);
  return out;
}

export function extractJson(text) {
  if (!text) return null;
  // Prefer a fenced block if the model wrapped it; else first {...} span.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

export async function runTaskTriage({ rows, notes, scopeLabel, callMeta }) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, TRIAGE_MAX_ROWS);
  if (!list.length) return { error: "No tasks to triage" };

  const { "prompt.task_triage.system": systemPrompt, "prompt.task_triage.model": model } =
    await getSettings("prompt.task_triage.system", "prompt.task_triage.model");

  const slim = list.map(slimRowForTriage);
  const knownIds = new Set(slim.map((r) => r.task_id));
  const userMessage = [
    `Scope: ${scopeLabel || "all active tasks"} (${slim.length} tasks). Today is ${new Date().toISOString().slice(0, 10)}.`,
    notes ? `Operator notes: ${String(notes).slice(0, 1000)}` : null,
    "Tasks (JSON):",
    JSON.stringify(slim),
    "Return the triage JSON now.",
  ].filter(Boolean).join("\n\n");

  const result = await callClaude({
    systemPrompt,
    userMessage,
    maxTokens: 8000,
    modelOverride: model,
    metadata: {
      kind: "other",
      ...(callMeta || {}),
      metadata: { subkind: "task_triage", count: slim.length, scope: scopeLabel || "all", ...((callMeta?.metadata) || {}) },
    },
  });
  if (result.error) return { error: result.error };

  const parsed = extractJson(result.text);
  const triage = normalizeTriage(parsed, knownIds);
  if (!parsed) triage.summary = triage.summary || "Model response was not valid JSON; raw text kept on the analysis row.";
  return {
    triage,
    model: result.model,
    cost_usd: result.cost_usd,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    analysis_id: result.analysis_id,
    count: slim.length,
    truncated: (Array.isArray(rows) ? rows.length : 0) > TRIAGE_MAX_ROWS,
  };
}
