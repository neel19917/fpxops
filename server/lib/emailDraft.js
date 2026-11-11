import { callClaude } from "./anthropic.js";
import { getSettings } from "./settings.js";

// Request extras for the current Claude 5 models. They always think before
// answering and the thinking counts against max_tokens, so emails run at low
// effort (short, direct drafts) with room to spare; a safety decline falls
// back server-side instead of failing the draft. Older models get nothing
// extra (they'd reject these fields).
export function emailModelExtras(model) {
  if (!/^claude-(opus-5|sonnet-5-5|fable-5-1)/.test(String(model || ""))) return null;
  return { output_config: { effort: "low" }, fallbacks: "default" };
}

// Email Studio previews: swap in unsaved prompt text / model for the keys
// this generator reads. Copies — never mutates the shared settings cache.
function withOverrides(settings, overrides) {
  const out = { ...settings };
  if (overrides && typeof overrides === "object") {
    for (const k of Object.keys(out)) if (typeof overrides[k] === "string") out[k] = overrides[k];
  }
  return out;
}

// Build the slim shipment context the email prompt sees. Centralized so the
// manual draft route and the auto-drafter agree on what's available.
export function slimShipmentForEmail(ship, notes) {
  return {
    tracking_number: ship.tracking_number,
    carrier: ship.carrier_name || ship.carrier,
    customer: ship.customer_name,
    mode: ship.mode,
    status: ship.shipment_status,
    pickup_date: ship.pickup_date,
    eta: ship.updated_eta || ship.estimated_arrival,
    delivered: ship.delivery_date,
    pickup_response: ship.pickup_response,
    confirmation_number: ship.confirmation_number,
    pickup_request_number: ship.pickup_request_number,
    origin: ship.origin || ship.ship_from,
    destination: ship.destination || ship.ship_to,
    issue: ship.ai_issue,
    recommendation: ship.ai_recommendation,
    action_required: ship.action_required,
    notes: notes || null,
  };
}

// Generate a single email draft. Returns { subject, body, raw } on success,
// or { error } on failure. The system prompt and audience copy are pulled
// from fpx_settings so admins can edit them.
export async function generateEmailDraft({ ship, audience, notes, callMeta, overrides }) {
  const aud = audience === "customer" ? "customer" : "carrier";
  const settings = withOverrides(await getSettings(
    "prompt.email_draft.system_base",
    "prompt.email_draft.audience_carrier",
    "prompt.email_draft.audience_customer",
    "prompt.email_draft.model",
  ), overrides);
  const model = settings["prompt.email_draft.model"] || undefined;
  const audienceCopy = aud === "carrier"
    ? settings["prompt.email_draft.audience_carrier"]
    : settings["prompt.email_draft.audience_customer"];
  const systemPrompt = String(settings["prompt.email_draft.system_base"] || "")
    .replace("{{audienceCopy}}", audienceCopy);
  const slim = slimShipmentForEmail(ship, notes);
  const userMessage = `Shipment context (you, FPX, are the broker for this shipment):\n${JSON.stringify(slim, null, 2)}\n\nWrite the email now. JSON only, no preamble.`;

  const result = await callClaude({
    systemPrompt,
    userMessage,
    // Room for the model's thinking + a full email (thinking counts here).
    maxTokens: emailModelExtras(model) ? 4000 : 700,
    modelOverride: model,
    extraBody: emailModelExtras(model),
    metadata: {
      kind: "other",
      tracking_number: ship.tracking_number,
      shipment_uuid: ship.id,
      ...(callMeta || {}),
      metadata: { subkind: `email_draft_${aud}`, ...((callMeta?.metadata) || {}) },
    },
  });
  if (result.error) return { error: result.error };

  let parsed = null;
  try {
    const m = result.text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {}
  if (!parsed?.subject || !parsed?.body) {
    return { subject: "(draft)", body: result.text, raw: result.text };
  }
  return { subject: parsed.subject, body: parsed.body, model: result.model };
}

// Slim per-shipment context for the carrier-group email. Mirrors
// slimShipmentForEmail but keyed by tracking + shipment id since the
// recipient is one carrier handling N shipments — those are the
// reference points the reply will use.
function slimShipmentForGroup(ship, taskTitle, taskDescription) {
  return {
    tracking_number: ship.tracking_number,
    shipment_id: ship.shipment_id,
    customer: ship.customer_name,
    mode: ship.mode,
    status: ship.shipment_status,
    pickup_date: ship.pickup_date,
    eta: ship.updated_eta || ship.estimated_arrival,
    delivered: ship.delivery_date,
    pickup_response: ship.pickup_response,
    confirmation_number: ship.confirmation_number,
    pickup_request_number: ship.pickup_request_number,
    origin: ship.origin || ship.ship_from,
    destination: ship.destination || ship.ship_to,
    issue: ship.ai_issue,
    recommendation: ship.ai_recommendation,
    action_required: ship.action_required,
    // Carry the operator's task notes through so the model knows what
    // FPX is actually asking the carrier per shipment.
    task_title: taskTitle || null,
    task_description: taskDescription || null,
  };
}

// Generate one consolidated carrier email covering N shipments at once.
// Pulls the carrier_group prompt + model from settings so admins can
// tune the wording and the model tier. Returns { subject, body } on
// success, { error } on failure (matches generateEmailDraft contract).
export async function generateCarrierGroupEmail({ carrier, items, notes, callMeta, overrides }) {
  if (!Array.isArray(items) || items.length === 0) return { error: "No shipments supplied" };
  const settings = withOverrides(await getSettings(
    "prompt.email_draft.carrier_group.system_base",
    "prompt.email_draft.carrier_group.audience",
    "prompt.email_draft.carrier_group.model",
  ), overrides);
  const audienceCopy = settings["prompt.email_draft.carrier_group.audience"];
  const systemPrompt = String(settings["prompt.email_draft.carrier_group.system_base"] || "")
    .replace("{{audienceCopy}}", audienceCopy);
  const modelOverride = settings["prompt.email_draft.carrier_group.model"] || undefined;

  const slim = items.map((it) => slimShipmentForGroup(it.shipment, it.task?.title, it.task?.description));
  const userMessage = `Carrier: ${carrier || "(unknown)"}\n` +
    `Shipments needing follow-up (count=${slim.length}):\n${JSON.stringify(slim, null, 2)}\n\n` +
    (notes ? `Operator notes for this batch: ${notes}\n\n` : "") +
    "Write the consolidated email now. JSON only, no preamble.";

  // Generous token budget — multi-shipment bodies routinely run several
  // hundred tokens; clipping mid-list would force the operator to ask
  // for a regenerate. Fine to lean high on a one-off, on-demand call.
  const result = await callClaude({
    systemPrompt,
    userMessage,
    maxTokens: emailModelExtras(modelOverride) ? 8000 : 2000,
    modelOverride,
    extraBody: emailModelExtras(modelOverride),
    metadata: {
      kind: "other",
      ...(callMeta || {}),
      metadata: { subkind: "email_draft_carrier_group", carrier, count: slim.length, ...((callMeta?.metadata) || {}) },
    },
  });
  if (result.error) return { error: result.error };

  let parsed = null;
  try {
    const m = result.text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {}
  if (!parsed?.subject || !parsed?.body) {
    return { subject: "(draft)", body: result.text, raw: result.text };
  }
  return { subject: parsed.subject, body: parsed.body, model: result.model };
}

// Bulk customer-followup email — same shape as the carrier-group flow
// but swaps the audience to the end customer (shipper / consignee) and
// reads its prompts from the customer_group settings keys. The slim
// shape is identical because the model still benefits from the same
// per-shipment context regardless of who's reading.
export async function generateCustomerGroupEmail({ customer, items, notes, callMeta, overrides }) {
  if (!Array.isArray(items) || items.length === 0) return { error: "No shipments supplied" };
  const settings = withOverrides(await getSettings(
    "prompt.email_draft.customer_group.system_base",
    "prompt.email_draft.customer_group.audience",
    "prompt.email_draft.customer_group.model",
  ), overrides);
  const audienceCopy = settings["prompt.email_draft.customer_group.audience"];
  const systemPrompt = String(settings["prompt.email_draft.customer_group.system_base"] || "")
    .replace("{{audienceCopy}}", audienceCopy);
  const modelOverride = settings["prompt.email_draft.customer_group.model"] || undefined;

  const slim = items.map((it) => slimShipmentForGroup(it.shipment, it.task?.title, it.task?.description));
  const userMessage = `Customer: ${customer || "(unknown)"}\n` +
    `Shipments needing follow-up (count=${slim.length}):\n${JSON.stringify(slim, null, 2)}\n\n` +
    (notes ? `Operator notes for this batch: ${notes}\n\n` : "") +
    "Write the consolidated customer-facing email now. JSON only, no preamble.";

  const result = await callClaude({
    systemPrompt,
    userMessage,
    maxTokens: emailModelExtras(modelOverride) ? 8000 : 2000,
    modelOverride,
    extraBody: emailModelExtras(modelOverride),
    metadata: {
      kind: "other",
      ...(callMeta || {}),
      metadata: { subkind: "email_draft_customer_group", customer, count: slim.length, ...((callMeta?.metadata) || {}) },
    },
  });
  if (result.error) return { error: result.error };

  let parsed = null;
  try {
    const m = result.text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {}
  if (!parsed?.subject || !parsed?.body) {
    return { subject: "(draft)", body: result.text, raw: result.text };
  }
  return { subject: parsed.subject, body: parsed.body, model: result.model };
}
