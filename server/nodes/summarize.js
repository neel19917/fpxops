import { SUMMARY_PROMPT, SYSTEM_PROMPT } from "../prompts.js";

function buildCompactPayload(analyzed, errors) {
  const actionItems = analyzed.filter(
    (r) => r._actionRequired === "YES" || r._actionRequired === "ERROR"
  );
  const noActionCount = analyzed.filter((r) => r._actionRequired === "NO").length;
  const KEYS = [
    "_trackingNumber", "SHIPMENT STATUS", "CARRIER NAME", "MODE",
    "UPDATED ETA", "DELIVERY DATE", "_actionRequired", "_aiIssue",
    "_aiRecommendation",
  ];
  const compact = (r) => {
    const o = {};
    for (const k of KEYS) {
      const v = r[k];
      if (v !== undefined && v !== "") o[k] = v;
    }
    return o;
  };
  return {
    total: analyzed.length,
    actionNeeded: actionItems.length,
    noAction: noActionCount,
    errors: errors.length,
    actionItems: actionItems.map(compact),
    sample: analyzed.filter((r) => r._actionRequired === "NO").slice(0, 30).map(compact),
  };
}

export async function summarize(state) {
  const model = state._model;
  const allAnalyzed = state.analyzed || [];
  const errors = state.errors || [];
  const payload = buildCompactPayload(allAnalyzed, errors);
  const userMsg = SUMMARY_PROMPT.replace("{{allShipments}}", JSON.stringify(payload));

  try {
    const response = await model.invoke([
      { role: "user", content: userMsg },
    ]);
    return { summary: response.content };
  } catch (e) {
    return { summary: "Summary error: " + e.message };
  }
}
