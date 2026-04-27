import { callClaude } from "./anthropic.js";
import { getSettings } from "./settings.js";

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
export async function generateEmailDraft({ ship, audience, notes, callMeta }) {
  const aud = audience === "customer" ? "customer" : "carrier";
  const settings = await getSettings(
    "prompt.email_draft.system_base",
    "prompt.email_draft.audience_carrier",
    "prompt.email_draft.audience_customer",
  );
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
    maxTokens: 700,
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
  return { subject: parsed.subject, body: parsed.body };
}
