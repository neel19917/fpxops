import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { callClaude } from "../lib/anthropic.js";
import { mapShipment } from "../lib/shipments.js";
import { getSettings } from "../lib/settings.js";

export const analyzeRouter = Router();

// Compose a per-shipment user message from the editable template +
// editable logic block + the row JSON. If the template still contains
// `{{logic}}` we substitute in place; otherwise we append the logic at
// the end so removing the placeholder by hand never silently drops the
// rules. {{data}} is substituted last.
function buildPerShipmentUserMessage(template, logic, dataJson) {
  const tpl = String(template || "");
  const logicBlock = String(logic || "").trim();
  const withLogic = tpl.includes("{{logic}}")
    ? tpl.replace("{{logic}}", logicBlock)
    : (logicBlock ? `${tpl.trimEnd()}\n\nLogic handling:\n${logicBlock}\n` : tpl);
  return withLogic.replace("{{data}}", dataJson);
}

// Run per-shipment AI on a row that's already in fpx_shipments. Used by:
// (1) the auto-analyze path after POST /api/shipments upserts, and
// (2) the dashboard's "Re-analyze" button.
// Returns the updated shipment row (or the original row if Claude couldn't be
// reached or returned no parseable result).
export async function analyzeExistingShipment(row, { reqContext } = {}) {
  if (!row?.id) return null;
  const settings = await getSettings("prompt.system", "prompt.per_shipment", "prompt.per_shipment_logic");
  const userMsg = buildPerShipmentUserMessage(
    settings["prompt.per_shipment"],
    settings["prompt.per_shipment_logic"],
    JSON.stringify(slimShipment(row.raw_data || row)),
  );
  const result = await callClaude({
    systemPrompt: settings["prompt.system"],
    userMessage: userMsg,
    maxTokens: 512,
    metadata: {
      kind: "per_shipment",
      tracking_number: row.tracking_number,
      shipment_uuid: row.id,
      api_key_id: reqContext?.apiKey?.id,
      user_email: reqContext?.user?.email,
    },
  });

  // Stamp last_analyzed_at + action_source so re-scrapes can skip already-
  // analyzed rows and the dashboard can render the "AI" badge correctly.
  const patch = { last_analyzed_at: new Date().toISOString() };
  if (result.parsed?.action_required && row.action_source !== "manual") {
    patch.action_required = result.parsed.action_required;
    patch.action_source = "ai";
  }
  if (result.parsed?.issue) patch.ai_issue = result.parsed.issue;
  if (result.parsed?.recommendation) patch.ai_recommendation = result.parsed.recommendation;
  // action_target + action_confidence drive the auto-draft audience and the
  // confidence badge. Skip on manual override so admin choices stick.
  if (row.action_source !== "manual") {
    if (result.parsed?.action_target) patch.action_target = result.parsed.action_target;
    if (result.parsed?.action_confidence !== null && result.parsed?.action_confidence !== undefined) {
      patch.action_confidence = result.parsed.action_confidence;
    }
  }

  const { data: updated, error } = await supabase
    .from("fpx_shipments")
    .update(patch)
    .eq("id", row.id)
    .select()
    .single();
  if (error) {
    console.warn("[FPX] analyzeExistingShipment update failed:", error.message);
    return row;
  }
  return updated;
}

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

  const settings = await getSettings("prompt.system", "prompt.per_shipment", "prompt.per_shipment_logic");
  const system = req.body.system || settings["prompt.system"];
  const template = req.body.template || settings["prompt.per_shipment"];
  const logic = req.body.logic ?? settings["prompt.per_shipment_logic"];
  const userMsg = buildPerShipmentUserMessage(template, logic, JSON.stringify(slimShipment(raw)));

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

  // Persist confidence + target on the shipment row so the UI can render the
  // (customer)/(carrier) badge and so the auto-drafter can pick the audience.
  if (shipmentUuid && result.parsed) {
    const patch = {};
    if (result.parsed.action_target) patch.action_target = result.parsed.action_target;
    if (result.parsed.action_confidence !== null) patch.action_confidence = result.parsed.action_confidence;
    if (result.parsed.action_required) patch.action_required = result.parsed.action_required;
    if (result.parsed.issue) patch.ai_issue = result.parsed.issue;
    if (result.parsed.recommendation) patch.ai_recommendation = result.parsed.recommendation;
    if (Object.keys(patch).length) {
      await supabase.from("fpx_shipments").update(patch).eq("id", shipmentUuid);
    }
  }

  res.json({ ...result, shipment_id: shipmentUuid });
});

// POST /analyze/summary — executive summary across a payload of rows.
analyzeRouter.post("/summary", async (req, res) => {
  const payload = req.body?.payload || req.body?.rows;
  if (!payload) return res.status(400).json({ error: "body.payload required" });
  const settings = await getSettings("prompt.system", "prompt.summary");
  const system = req.body.system || settings["prompt.system"];
  const template = req.body.template || settings["prompt.summary"];
  const userMsg = template.replace("{{allShipments}}", JSON.stringify(payload));
  const result = await callClaude({
    systemPrompt: system,
    userMessage: userMsg,
    maxTokens: 2048,
    metadata: { kind: "summary", api_key_id: req.apiKey?.id },
  });
  res.json(result);
});

// ---------- GP audit defaults ----------
// Mirror the prompts the extension used so the extension-only path and the
// server-only path produce equivalent output. Settings overrides
// (prompt.gp_*, prompt.invoice_*) win when present.
const GP_DEFAULT_SYSTEM =
  "You are a freight brokerage GP (gross profit) analyst. You review GP audit reports " +
  "covering one or more business days from the FreightPOP transaction history. " +
  "Your audience is brokerage operations management. Be precise with numbers, " +
  "reference actual customer names and IDs, and clearly separate urgent items from informational observations.";

const GP_DEFAULT_EXEC_SUMMARY =
  "You are reviewing a GP audit for a freight brokerage. The JSON below contains:\n\n" +
  "• date — the shipped date(s) covered\n" +
  "• totalShipments, totalCustomers, outlierCount, reviewCount — aggregate counts\n" +
  "• customerSummaries[] — per-customer: customerId, customerName, shipments (count), avgGpPct, stdev, outliers (count)\n" +
  "• flaggedShipments[] — rows needing review: shipmentId, customerId, customerName, markedUpRate, grossProfit, gpPct, customerAvgGpPct, deviation, reason, carrier, service\n\n" +
  "GP% = Gross Profit / Marked-Up Rate × 100. Outliers are >2 standard deviations from that customer's average. Borderline = 1.5–2 STDEV.\n\n" +
  "Write an executive summary in markdown with these sections:\n" +
  "1. **Overall GP Health** — one-line verdict, then 2-3 sentences on portfolio-wide margin trends.\n" +
  "2. **Critical Outliers** — each outlier customer with ID, count, avg GP%, volatility, and specific flagged shipments.\n" +
  "3. **Patterns & Trends** — systematic underperformance, auto-pricing floors, carrier-specific variance.\n" +
  "4. **Recommended Actions** — prioritized (Immediate / This Week / Strategic). Be specific.\n\n" +
  "Rules:\n" +
  "- Reference actual customer names/IDs and shipment IDs from the data.\n" +
  "- Healthy brokerage GP benchmark is 15-20%. Flag anything consistently below 10%.\n" +
  "- Keep total length 250-400 words.\n\n" +
  "Data:\n{{data}}";

const GP_DEFAULT_ROW_REVIEW =
  "You are reviewing a single flagged shipment from a freight brokerage GP audit.\n\n" +
  "The JSON contains: shipmentId, customerId, customerName, markedUpRate, rateWithoutMarkup, " +
  "grossProfit, gpPct, customerAvgGpPct, stdev, deviation, reason, carrier, service, accountManager.\n\n" +
  "Provide a 2-3 sentence assessment:\n" +
  "1. Why this GP% is unusual for this customer.\n" +
  "2. Most likely cause.\n" +
  "3. What the account manager should verify or do next.\n\n" +
  "Be specific. Reference the actual numbers.\n\n" +
  "Shipment:\n{{row}}";

const INV_DEFAULT_SYSTEM =
  "You are a freight brokerage accounting auditor. You compare carrier invoices (bills) against " +
  "FreightPOP's recorded shipment cost to identify billing discrepancies. Be precise with dollar amounts and percentages.\n\n" +
  "Primary comparison: Bill Amount [CI] vs Shipment Cost [FPX]";

const INV_DEFAULT_EXEC_SUMMARY =
  "You are reviewing an invoice audit for a freight brokerage. The JSON below contains:\n\n" +
  "• totalAudited, totalMatched, totalDiscrepancies, totalErrors, totalSkipped, totalVariance\n" +
  "• discrepancies[] — each: shipmentId, vendor, invoiceNumber, billAmount, shipmentCost, shipmentSale, grossProfit, difference, pctDifference, direction (OVER/UNDER)\n" +
  "• matches[] — sample of shipments that matched (bill ≈ FPX cost within $0.01)\n\n" +
  "Write an executive summary in markdown:\n" +
  "1. **Overall Assessment** — verdict + totals + net $ variance.\n" +
  "2. **Discrepancies** — each with shipment ID, vendor, invoice #, amounts, likely cause.\n" +
  "3. **Vendor Patterns** — any vendor consistently over/under billing?\n" +
  "4. **Recommended Actions** — prioritized: dispute / verify / accept.\n\n" +
  "Rules:\n" +
  "- Reference actual shipment IDs and vendor names.\n" +
  "- OVER means carrier invoiced MORE than FPX cost.\n" +
  "- Keep to 200-400 words.\n\n" +
  "Data:\n{{data}}";

const INV_DEFAULT_ROW_REVIEW =
  "You are reviewing a single carrier bill discrepancy.\n\n" +
  "The JSON contains: shipmentId, vendor, invoiceNumber, billAmount, shipmentCost, shipmentSale, " +
  "grossProfit, difference, pctDifference, direction (OVER/UNDER).\n\n" +
  "Provide a 2-3 sentence assessment of the most likely cause and what the accounting team should do.\n\n" +
  "Shipment:\n{{row}}";

// Build the AI payload that the exec-summary prompt consumes from a list of
// fpx_gp_audit_rows + the audit run record. Mirrors the shape the extension
// used to send so prompts behave identically.
function buildGpExecPayload(run, rows) {
  const customerStats = new Map();
  for (const r of rows) {
    const cid = r.raw?.["Customer Id"] || r.raw?.customerId || "";
    if (!cid) continue;
    if (!customerStats.has(cid)) {
      customerStats.set(cid, {
        customerId: cid,
        customerName: r.customer_name || r.raw?.["Customer Name"] || "",
        shipments: 0,
        gpPctSum: 0,
        outliers: 0,
      });
    }
    const s = customerStats.get(cid);
    s.shipments++;
    if (typeof r.gp_pct === "number") s.gpPctSum += Number(r.gp_pct);
    if (r.is_outlier) s.outliers++;
  }
  const customerSummaries = [];
  for (const s of customerStats.values()) {
    customerSummaries.push({
      customerId: s.customerId,
      customerName: s.customerName,
      shipments: s.shipments,
      avgGpPct: s.shipments ? +(s.gpPctSum / s.shipments).toFixed(2) : null,
      outliers: s.outliers,
    });
  }
  customerSummaries.sort((a, b) => b.outliers - a.outliers);

  const flaggedShipments = rows
    .filter((r) => r.is_outlier || (typeof r.gp_pct === "number" && Number(r.gp_pct) < 2))
    .map((r) => ({
      shipmentId: r.shipment_id,
      customerName: r.customer_name,
      markedUpRate: r.marked_up_rate,
      grossProfit: r.gross_profit,
      gpPct: r.gp_pct,
      stdDeviations: r.std_deviations,
      isOutlier: !!r.is_outlier,
      raw: r.raw || null,
    }));

  return {
    date: run.date_from === run.date_to ? run.date_from : `${run.date_from} — ${run.date_to}`,
    totalShipments: run.total_rows ?? rows.length,
    totalCustomers: customerStats.size,
    outlierCount: run.outlier_count ?? rows.filter((r) => r.is_outlier).length,
    reviewCount: flaggedShipments.length,
    customerSummaries,
    flaggedShipments,
  };
}

function buildInvoiceExecPayload(run, rows) {
  const discrepancies = rows
    .filter((r) => r.status === "discrepancy" || (typeof r.difference === "number" && Math.abs(Number(r.difference)) > 0.01))
    .map((r) => ({
      shipmentId: r.shipment_id,
      vendor: r.carrier || r.raw?.vendor,
      invoiceNumber: r.raw?.invoiceNumber,
      billAmount: r.bill_amount,
      shipmentCost: r.shipment_cost,
      shipmentSale: r.raw?.shipmentSale,
      grossProfit: r.raw?.grossProfit,
      difference: r.difference,
      pctDifference: r.raw?.pctDifference,
      direction: r.raw?.direction || (Number(r.difference) > 0 ? "OVER" : "UNDER"),
    }));
  const matches = rows
    .filter((r) => r.status === "match" || (typeof r.difference === "number" && Math.abs(Number(r.difference)) <= 0.01))
    .slice(0, 20)
    .map((r) => ({
      shipmentId: r.shipment_id,
      vendor: r.carrier || r.raw?.vendor,
      billAmount: r.bill_amount,
      shipmentCost: r.shipment_cost,
    }));
  const totalVariance = discrepancies.reduce((s, d) => s + (Number(d.difference) || 0), 0);
  return {
    totalAudited: run.total_rows ?? rows.length,
    totalMatched: run.match_count ?? matches.length,
    totalDiscrepancies: run.discrepancy_count ?? discrepancies.length,
    totalErrors: run.unmatched_count ?? 0,
    totalVariance: +totalVariance.toFixed(2),
    discrepancies,
    matches,
  };
}

// Run AI on a GP audit run that already exists in fpx_gp_audits + rows.
// Persists the exec summary back onto the run row, per-row notes onto each
// row, and stamps last_analyzed_at. Safe to call from the POST handler in the
// background AND from a future "Re-analyze" button. Returns the patched run.
export async function analyzeGpAuditRun(auditId, { reqContext, level = "summary" } = {}) {
  if (!auditId) return null;
  const { data: run } = await supabase.from("fpx_gp_audits").select("*").eq("id", auditId).maybeSingle();
  if (!run) return null;
  const { data: rows } = await supabase.from("fpx_gp_audit_rows").select("*").eq("audit_id", auditId).limit(2000);
  const allRows = rows || [];

  const settings = await getSettings(
    "prompt.gp_system", "prompt.gp_exec_summary", "prompt.gp_row_review"
  );
  const system = settings["prompt.gp_system"] || GP_DEFAULT_SYSTEM;
  const execTpl = settings["prompt.gp_exec_summary"] || GP_DEFAULT_EXEC_SUMMARY;
  const rowTpl = settings["prompt.gp_row_review"] || GP_DEFAULT_ROW_REVIEW;

  const payload = buildGpExecPayload(run, allRows);
  const userMsg = execTpl.replace("{{data}}", JSON.stringify(payload));

  const result = await callClaude({
    systemPrompt: system,
    userMessage: userMsg,
    maxTokens: 2048,
    metadata: {
      kind: "gp_audit",
      gp_audit_id: auditId,
      subkind: "exec_summary",
      api_key_id: reqContext?.apiKey?.id,
      user_email: reqContext?.user?.email,
    },
  });

  const patch = { last_analyzed_at: new Date().toISOString() };
  if (result.text) patch.exec_summary = result.text;
  const { data: updatedRun } = await supabase
    .from("fpx_gp_audits").update(patch).eq("id", auditId).select().single();

  // Per-row review only when level==='full'. Cap the number of rows so a
  // 2000-row audit can't burn through Claude credits in one click.
  if (level === "full" && allRows.length) {
    const flagged = allRows.filter((r) => r.is_outlier).slice(0, 50);
    for (const r of flagged) {
      const rowMsg = rowTpl.replace("{{row}}", JSON.stringify({
        shipmentId: r.shipment_id,
        customerName: r.customer_name,
        markedUpRate: r.marked_up_rate,
        rateWithoutMarkup: r.rate_without_markup,
        grossProfit: r.gross_profit,
        gpPct: r.gp_pct,
        stdDeviations: r.std_deviations,
        isOutlier: r.is_outlier,
        raw: r.raw,
      }));
      const rowResult = await callClaude({
        systemPrompt: system,
        userMessage: rowMsg,
        maxTokens: 512,
        metadata: {
          kind: "gp_audit",
          gp_audit_id: auditId,
          subkind: "row_review",
          api_key_id: reqContext?.apiKey?.id,
        },
      });
      if (rowResult.text) {
        await supabase.from("fpx_gp_audit_rows")
          .update({ ai_notes: rowResult.text }).eq("id", r.id);
      }
    }
  }
  return updatedRun || run;
}

export async function analyzeInvoiceAuditRun(auditId, { reqContext, level = "summary" } = {}) {
  if (!auditId) return null;
  const { data: run } = await supabase.from("fpx_invoice_audits").select("*").eq("id", auditId).maybeSingle();
  if (!run) return null;
  const { data: rows } = await supabase.from("fpx_invoice_audit_rows").select("*").eq("audit_id", auditId).limit(2000);
  const allRows = rows || [];

  const settings = await getSettings(
    "prompt.invoice_system", "prompt.invoice_exec_summary", "prompt.invoice_row_review"
  );
  const system = settings["prompt.invoice_system"] || INV_DEFAULT_SYSTEM;
  const execTpl = settings["prompt.invoice_exec_summary"] || INV_DEFAULT_EXEC_SUMMARY;
  const rowTpl = settings["prompt.invoice_row_review"] || INV_DEFAULT_ROW_REVIEW;

  const payload = buildInvoiceExecPayload(run, allRows);
  const userMsg = execTpl.replace("{{data}}", JSON.stringify(payload));

  const result = await callClaude({
    systemPrompt: system,
    userMessage: userMsg,
    maxTokens: 2048,
    metadata: {
      kind: "invoice_audit",
      invoice_audit_id: auditId,
      subkind: "exec_summary",
      api_key_id: reqContext?.apiKey?.id,
      user_email: reqContext?.user?.email,
    },
  });

  const patch = { last_analyzed_at: new Date().toISOString() };
  if (result.text) patch.exec_summary = result.text;
  const { data: updatedRun } = await supabase
    .from("fpx_invoice_audits").update(patch).eq("id", auditId).select().single();

  if (level === "full" && allRows.length) {
    const discrepancies = allRows
      .filter((r) => r.status === "discrepancy" || (typeof r.difference === "number" && Math.abs(Number(r.difference)) > 0.01))
      .slice(0, 50);
    for (const r of discrepancies) {
      const rowMsg = rowTpl.replace("{{row}}", JSON.stringify({
        shipmentId: r.shipment_id,
        vendor: r.carrier || r.raw?.vendor,
        invoiceNumber: r.raw?.invoiceNumber,
        billAmount: r.bill_amount,
        shipmentCost: r.shipment_cost,
        shipmentSale: r.raw?.shipmentSale,
        grossProfit: r.raw?.grossProfit,
        difference: r.difference,
        pctDifference: r.raw?.pctDifference,
        direction: r.raw?.direction,
      }));
      const rowResult = await callClaude({
        systemPrompt: system,
        userMessage: rowMsg,
        maxTokens: 512,
        metadata: {
          kind: "invoice_audit",
          invoice_audit_id: auditId,
          subkind: "row_review",
          api_key_id: reqContext?.apiKey?.id,
        },
      });
      if (rowResult.text) {
        await supabase.from("fpx_invoice_audit_rows")
          .update({ ai_notes: rowResult.text }).eq("id", r.id);
      }
    }
  }
  return updatedRun || run;
}

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
