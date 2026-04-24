import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { callClaude } from "../lib/anthropic.js";
import { mapShipment } from "../lib/shipments.js";
import { SYSTEM_PROMPT, PER_SHIPMENT_PROMPT, SUMMARY_PROMPT } from "../prompts.js";

export const analyzeRouter = Router();

// POST /analyze/shipment — run per-shipment AI, upsert shipment, log analysis.
analyzeRouter.post("/shipment", async (req, res) => {
  const raw = req.body?.shipment;
  if (!raw || typeof raw !== "object") return res.status(400).json({ error: "body.shipment required" });

  const mapped = mapShipment(raw);
  let shipmentUuid = null;
  if (mapped && mapped.tracking_number) {
    const { data } = await supabase.from("fpx_shipments").insert(mapped).select("id").single();
    shipmentUuid = data?.id || null;
  }

  const system = req.body.system || SYSTEM_PROMPT;
  const template = req.body.template || PER_SHIPMENT_PROMPT;
  const userMsg = template.replace("{{data}}", JSON.stringify(slimShipment(raw)));

  const result = await callClaude({
    systemPrompt: system,
    userMessage: userMsg,
    maxTokens: 512,
    metadata: {
      kind: "per_shipment",
      tracking_number: mapped?.tracking_number || null,
      shipment_uuid: shipmentUuid,
      api_key_id: req.apiKey?.id,
    },
  });

  res.json({ ...result, shipment_id: shipmentUuid });
});

// POST /analyze/summary — executive summary across a payload of rows.
analyzeRouter.post("/summary", async (req, res) => {
  const payload = req.body?.payload || req.body?.rows;
  if (!payload) return res.status(400).json({ error: "body.payload required" });
  const system = req.body.system || SYSTEM_PROMPT;
  const template = req.body.template || SUMMARY_PROMPT;
  const userMsg = template.replace("{{allShipments}}", JSON.stringify(payload));
  const result = await callClaude({
    systemPrompt: system,
    userMessage: userMsg,
    maxTokens: 2048,
    metadata: { kind: "summary", api_key_id: req.apiKey?.id },
  });
  res.json(result);
});

// POST /analyze/gp-summary, /analyze/gp-row — GP audit AI calls.
analyzeRouter.post("/gp-summary", async (req, res) => {
  const { system, template, payload, gp_audit_id } = req.body || {};
  const s = system || "You are a freight brokerage GP (gross profit) analyst.";
  const t = template || "Below is GP audit data. Provide an executive summary.\n\nData:\n{{data}}";
  const userMsg = t.replace("{{data}}", JSON.stringify(payload || {}));
  const result = await callClaude({
    systemPrompt: s,
    userMessage: userMsg,
    maxTokens: 2048,
    metadata: { kind: "gp_audit", gp_audit_id: gp_audit_id || null, subkind: "exec_summary", api_key_id: req.apiKey?.id },
  });
  res.json(result);
});

analyzeRouter.post("/gp-row", async (req, res) => {
  const { system, template, row, gp_audit_id } = req.body || {};
  const s = system || "You are a freight brokerage GP analyst reviewing a single flagged shipment.";
  const t = template || "This shipment was flagged for review. Analyze and provide a brief note.\n\n{{row}}";
  const userMsg = t.replace("{{row}}", JSON.stringify(row || {}));
  const result = await callClaude({
    systemPrompt: s,
    userMessage: userMsg,
    maxTokens: 512,
    metadata: { kind: "gp_audit", gp_audit_id: gp_audit_id || null, subkind: "row_review", api_key_id: req.apiKey?.id },
  });
  res.json(result);
});

// POST /analyze/invoice-summary, /analyze/invoice-row — Invoice audit AI calls.
analyzeRouter.post("/invoice-summary", async (req, res) => {
  const { system, template, payload, invoice_audit_id } = req.body || {};
  const s = system || "You are a freight brokerage accounting auditor.";
  const t = template || "Below is invoice audit data. Provide an executive summary.\n\nData:\n{{data}}";
  const userMsg = t.replace("{{data}}", JSON.stringify(payload || {}));
  const result = await callClaude({
    systemPrompt: s,
    userMessage: userMsg,
    maxTokens: 2048,
    metadata: { kind: "invoice_audit", invoice_audit_id: invoice_audit_id || null, subkind: "exec_summary", api_key_id: req.apiKey?.id },
  });
  res.json(result);
});

analyzeRouter.post("/invoice-row", async (req, res) => {
  const { system, template, row, invoice_audit_id } = req.body || {};
  const s = system || "You are a freight brokerage accounting auditor reviewing a single discrepancy.";
  const t = template || "This shipment has a billing discrepancy. Analyze and provide a brief note.\n\n{{row}}";
  const userMsg = t.replace("{{row}}", JSON.stringify(row || {}));
  const result = await callClaude({
    systemPrompt: s,
    userMessage: userMsg,
    maxTokens: 512,
    metadata: { kind: "invoice_audit", invoice_audit_id: invoice_audit_id || null, subkind: "row_review", api_key_id: req.apiKey?.id },
  });
  res.json(result);
});

// POST /analyze/vision — base64 PNG screenshot → financial fields.
analyzeRouter.post("/vision", async (req, res) => {
  const base64 = req.body?.image_base64;
  if (!base64) return res.status(400).json({ error: "body.image_base64 required" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const startedAt = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
          { type: "text", text: 'Extract these financial fields from the FreightPOP shipment screenshot as JSON: {"shipmentSale": <number|null>, "shipmentCost": <number|null>, "grossProfit": <number|null>}. Numbers only, no $ or commas. Return ONLY the JSON object.' },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return res.status(500).json({ error: `Vision API ${resp.status}: ${body.slice(0, 200)}` });
  }
  const json = await resp.json();
  const text = json.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*?\}/);
  let parsed = null;
  if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
  // Log the vision call.
  try {
    await supabase.from("fpx_ai_analyses").insert({
      kind: "other",
      model,
      system_prompt: "vision:invoice-screenshot",
      user_message: "(image)",
      response_text: text,
      input_tokens: json.usage?.input_tokens || 0,
      output_tokens: json.usage?.output_tokens || 0,
      duration_ms: Date.now() - startedAt,
      source: "railway",
      metadata: { subkind: "vision", api_key_id: req.apiKey?.id },
    });
  } catch {}
  res.json({ data: parsed, raw: text });
});

// Internal helper — strip internal keys and stringify leftovers compactly.
function slimShipment(data) {
  const out = {};
  const exclude = new Set(["_aiRawAnalysis", "_inputSummary", "_outputSummary", "_needsActionSheet"]);
  for (const [k, v] of Object.entries(data)) {
    if (exclude.has(k)) continue;
    if (k.startsWith("_") && k !== "_trackingNumber") continue;
    if (v === undefined || v === null) continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (s.trim()) out[k] = s;
  }
  return out;
}
