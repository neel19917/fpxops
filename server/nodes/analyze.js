import { PER_SHIPMENT_PROMPT, PRIORITY_PROMPT, SYSTEM_PROMPT } from "../prompts.js";

function slimForAI(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("_") && k !== "_trackingNumber") continue;
    if (v === undefined || v === null) continue;
    const s = typeof v === "string" ? v : String(v);
    if (s.trim()) out[k] = s;
  }
  return out;
}

async function analyzeOne(shipment, model, promptTemplate) {
  const slim = slimForAI(shipment);
  const userMsg = promptTemplate.replace("{{data}}", JSON.stringify(slim));
  try {
    const response = await model.invoke([
      { role: "user", content: userMsg },
    ]);
    return { ...shipment, _aiRawAnalysis: response.content };
  } catch (e) {
    return {
      ...shipment,
      _aiRawAnalysis: e.message,
      _actionRequired: "ERROR",
      _aiIssue: e.message,
      _aiRecommendation: "",
    };
  }
}

export async function analyzeWithAI(state) {
  const { ambiguous, critical } = state.classified;
  const model = state._model;
  const toAnalyze = [...ambiguous, ...critical];
  const results = [];

  for (const shipment of toAnalyze) {
    const template =
      shipment._classification === "critical" ? PRIORITY_PROMPT : PER_SHIPMENT_PROMPT;
    const result = await analyzeOne(shipment, model, template);
    results.push(result);
  }

  return { _aiResults: results };
}
