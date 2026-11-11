import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { supabase } from "../lib/supabase.js";
import { callClaude } from "../lib/anthropic.js";
import { getSettings } from "../lib/settings.js";
import { logAudit } from "../lib/audit.js";
import { logGovernance, featureForKey } from "../lib/governance.js";
import {
  generateEmailDraft, generateCarrierGroupEmail, generateCustomerGroupEmail, emailModelExtras,
} from "../lib/emailDraft.js";
import { isCarrierFollowupTitle, isCustomerFollowupTitle } from "./tasks.js";

// Email Studio: admins rewrite the email-draft prompts, ask Claude to revise
// them from plain-English instructions, and preview the result on real
// shipments BEFORE saving. Saving goes through the normal settings PUT.
export const emailStudioRouter = Router();
emailStudioRouter.use(requireAuth({ scope: "admin", role: "admin" }));

const EMAIL_KEY = /^prompt\.email_draft\./;
const ACTIVE = new Set(["open", "in_progress"]);
const MAX_PROMPT = 40_000;

function cleanOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (EMAIL_KEY.test(k) && typeof v === "string" && v.length <= MAX_PROMPT) out[k] = v;
  }
  return out;
}

// GET /api/email-studio/samples — shipments with active follow-up tasks, so
// the preview can run on something real. Grouped client-side by carrier /
// customer for the group emails.
emailStudioRouter.get("/samples", async (_req, res) => {
  const { data: tasks, error } = await supabase
    .from("fpx_shipment_tasks")
    .select("id, title, status, shipment_id, created_at")
    .in("status", ["open", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(400);
  if (error) return res.status(500).json({ error: error.message });
  const ids = [...new Set((tasks || []).map((t) => t.shipment_id).filter(Boolean))].slice(0, 200);
  if (!ids.length) return res.json({ data: [] });
  const { data: ships, error: e2 } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, shipment_id, carrier_name, carrier, customer_name, shipment_status, archived_at")
    .in("id", ids);
  if (e2) return res.status(500).json({ error: e2.message });
  const byId = new Map((ships || []).filter((s) => !s.archived_at).map((s) => [s.id, s]));
  const seen = new Set();
  const data = [];
  for (const t of tasks || []) {
    const s = byId.get(t.shipment_id);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    data.push({
      tracking_number: s.tracking_number,
      shipment_id: s.shipment_id,
      carrier: s.carrier_name || s.carrier || null,
      customer: s.customer_name || null,
      status: s.shipment_status || null,
      task: t.title,
      carrier_followup: isCarrierFollowupTitle(t.title),
      customer_followup: isCustomerFollowupTitle(t.title),
    });
  }
  res.json({ data });
});

// POST /api/email-studio/rewrite  { key, text, instructions }
// Claude revises one prompt from plain-English instructions. Nothing is
// saved — the admin reviews the result, previews it, then saves.
emailStudioRouter.post("/rewrite", async (req, res) => {
  const key = String(req.body?.key || "");
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const instructions = typeof req.body?.instructions === "string" ? req.body.instructions.trim() : "";
  if (!EMAIL_KEY.test(key) || /\.model$/.test(key)) return res.status(400).json({ error: "Not an email prompt" });
  if (!text.trim()) return res.status(400).json({ error: "The prompt is empty" });
  if (!instructions) return res.status(400).json({ error: "Say what to change" });
  if (text.length > MAX_PROMPT || instructions.length > 4000) return res.status(400).json({ error: "Too long" });

  const s = await getSettings("prompt.email_draft.model");
  const model = s["prompt.email_draft.model"] || undefined;
  const extras = emailModelExtras(model);
  const systemPrompt = [
    "You edit the instructions (a system prompt) that an AI uses to draft freight-logistics emails for FPX, a freight broker.",
    "Apply the requested changes to the prompt and return the complete revised prompt.",
    "Rules:",
    "- Change only what the request asks for (plus anything that now contradicts it). Keep everything else as written.",
    "- Keep every {{placeholder}} exactly as it appears (for example {{audienceCopy}}).",
    "- Keep any required output format (such as JSON with subject and body) unless told otherwise.",
    "- Write plain instructions to the drafting AI, in the prompt's existing voice.",
    "Return ONLY the revised prompt text: no preamble, no explanation, no code fences.",
  ].join("\n");
  const userMessage = `Prompt setting: ${key}\n\n<current_prompt>\n${text}\n</current_prompt>\n\n<requested_changes>\n${instructions}\n</requested_changes>`;
  const result = await callClaude({
    systemPrompt,
    userMessage,
    maxTokens: extras ? 12000 : 6000,
    modelOverride: model,
    extraBody: extras ? { ...extras, output_config: { effort: "medium" } } : null,
    metadata: { kind: "other", user_email: req.user?.email, metadata: { subkind: "email_studio_rewrite", key } },
  });
  if (result.error) return res.status(500).json({ error: result.error });
  let out = String(result.text || "").trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (!out) return res.status(500).json({ error: "Claude returned nothing" });
  logGovernance(req, {
    event_type: "ai_rewrite", feature: featureForKey(key), setting_key: key,
    summary: `AI rewrote ${key} (suggestion — not saved): ${instructions.slice(0, 140)}`,
    before: text, after: out, analysis_id: result.analysis_id || null,
    metadata: { instructions, model: result.model || model || null },
  });
  const lost = [...text.matchAll(/\{\{\s*\w+\s*\}\}/g)].map((m) => m[0]).filter((ph) => !out.includes(ph));
  res.json({ text: out, model: result.model || model || null, warnings: lost.length ? [`Placeholder ${[...new Set(lost)].join(", ")} was dropped — the email won't get that part.`] : [] });
});

// POST /api/email-studio/preview
//   { type: "carrier" | "customer" | "carrier_group" | "customer_group",
//     tracking_numbers: [...], notes?, overrides?: { "prompt.email_draft.…": "unsaved text" } }
// Drafts an email with the (unsaved) prompts, without sending anything.
emailStudioRouter.post("/preview", async (req, res) => {
  const type = String(req.body?.type || "");
  if (!["carrier", "customer", "carrier_group", "customer_group"].includes(type)) return res.status(400).json({ error: "type required" });
  const trackings = (Array.isArray(req.body?.tracking_numbers) ? req.body.tracking_numbers : [])
    .map((t) => String(t || "").trim()).filter(Boolean).slice(0, 12);
  if (!trackings.length) return res.status(400).json({ error: "Pick at least one shipment" });
  const overrides = cleanOverrides(req.body?.overrides);
  const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 2000) : undefined;
  const callMeta = { user_email: req.user?.email, metadata: { subkind: "email_studio_preview", studio_type: type } };

  const { data: ships, error } = await supabase.from("fpx_shipments").select("*").in("tracking_number", trackings);
  if (error) return res.status(500).json({ error: error.message });
  if (!ships?.length) return res.status(404).json({ error: "No matching shipments" });

  let result;
  if (type === "carrier" || type === "customer") {
    result = await generateEmailDraft({ ship: ships[0], audience: type, notes, callMeta, overrides });
  } else {
    const { data: tasks } = await supabase
      .from("fpx_shipment_tasks").select("*").in("shipment_id", ships.map((s) => s.id))
      .order("created_at", { ascending: false });
    const match = type === "carrier_group" ? isCarrierFollowupTitle : isCustomerFollowupTitle;
    const items = ships.map((s) => {
      const mine = (tasks || []).filter((t) => t.shipment_id === s.id && ACTIVE.has(t.status));
      return { shipment: s, task: mine.find((t) => match(t.title)) || mine[0] || null };
    });
    if (type === "carrier_group") {
      const carrier = String(req.body?.group || ships[0].carrier_name || ships[0].carrier || "");
      result = await generateCarrierGroupEmail({ carrier, items, notes, callMeta, overrides });
    } else {
      const customer = String(req.body?.group || ships[0].customer_name || "");
      result = await generateCustomerGroupEmail({ customer, items, notes, callMeta, overrides });
    }
  }
  if (result.error) return res.status(500).json({ error: result.error });
  logGovernance(req, {
    event_type: "ai_preview", feature: `email_draft.${type}`,
    summary: `Previewed ${type.replace("_", " ")} email on ${ships.length} shipment(s)${Object.keys(overrides).length ? " with unsaved prompt edits" : ""}`,
    after: { subject: result.subject, body: result.body },
    metadata: { tracking_numbers: trackings, overridden: Object.keys(overrides), model: result.model || null },
  });
  logAudit(req, {
    action: "create", entity_type: "email_draft",
    summary: `Email Studio preview (${type}) on ${ships.length} shipment(s)`,
    metadata: { type, tracking_numbers: trackings, overridden: Object.keys(overrides) },
  });
  res.json({ subject: result.subject, body: result.body, model: result.model || null, count: ships.length });
});
