function repairModelJson(s) {
  let t = s;
  t = t.replace(/"actionRequired"\s*:\s*true\s+or\s+false/gi, '"actionRequired": false');
  t = t.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  return t;
}

function findAnalysisObject(obj, depth = 0) {
  if (depth > 10 || obj == null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = findAnalysisObject(item, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const keys = Object.keys(obj);
  const hasSignal = keys.some((k) =>
    /actionrequired|issue|recommendation|action_required|requiresaction/i.test(k.replace(/_/g, ""))
  );
  if (hasSignal) return obj;
  for (const k of keys) {
    if (obj[k] != null && typeof obj[k] === "object") {
      const f = findAnalysisObject(obj[k], depth + 1);
      if (f) return f;
    }
  }
  return null;
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/im);
  if (fence) t = fence[1].trim();
  t = repairModelJson(t);
  try {
    const p = JSON.parse(t);
    return findAnalysisObject(p, 0) || p;
  } catch {}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const slice = repairModelJson(t.slice(start, end + 1));
      const p = JSON.parse(slice);
      return findAnalysisObject(p, 0) || p;
    } catch {}
  }
  return null;
}

function coerceActionRequired(val) {
  if (val === undefined || val === null) return "";
  if (val === true || val === 1) return "YES";
  if (val === false || val === 0) return "NO";
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return "YES";
    if (["false", "no", "n", "0"].includes(s)) return "NO";
  }
  return "";
}

function isClearlyOnTrack(issue) {
  if (!issue || typeof issue !== "string") return true;
  const s = issue.trim().toLowerCase();
  return (
    /^(none|n\/a)\b/.test(s) ||
    /\bon track\b/.test(s) ||
    /\bno issue\b/.test(s) ||
    /\bno action needed\b/.test(s) ||
    /\bshipment is on track\b/.test(s) ||
    /\bproceeding normally\b/.test(s)
  );
}

function deriveActionRequired(coerced, issue) {
  if (coerced === "YES") return "YES";
  const actionable = issue.length > 0 && !isClearlyOnTrack(issue);
  if ((coerced === "NO" || coerced === "") && actionable) return "YES";
  return coerced;
}

function parseSingle(shipment) {
  const aiText = shipment._aiRawAnalysis;
  if (!aiText) return { ...shipment, _parseError: true };

  const parsed = extractJsonObject(aiText);
  if (!parsed) return { ...shipment, _parseError: true };

  const actionRaw =
    parsed.actionRequired ?? parsed.ActionRequired ?? parsed.action_required;
  const issue = String(parsed.issue ?? parsed.Issue ?? "").trim();
  const recommendation = String(parsed.recommendation ?? parsed.Recommendation ?? "").trim();

  const coerced = coerceActionRequired(actionRaw);
  const action = deriveActionRequired(coerced, issue);

  return {
    ...shipment,
    _actionRequired: action,
    _aiIssue: issue,
    _aiRecommendation: recommendation,
    _parseError: false,
  };
}

export function parseResponse(state) {
  const results = state._aiResults || [];
  const analyzed = [...(state.analyzed || [])];
  const retryQueue = [];
  const retryCount = state._retryCount || 0;

  for (const r of results) {
    if (r._actionRequired === "ERROR") {
      analyzed.push(r);
      continue;
    }
    const parsed = parseSingle(r);
    if (parsed._parseError && retryCount < 1) {
      retryQueue.push(r);
    } else if (parsed._parseError) {
      analyzed.push({
        ...r,
        _actionRequired: "ERROR",
        _aiIssue: "Failed to parse AI response after retry",
        _aiRecommendation: "",
      });
    } else {
      analyzed.push(parsed);
    }
  }

  return { analyzed, retryQueue, _retryCount: retryCount };
}

export function parseRouter(state) {
  if (state.retryQueue.length > 0 && (state._retryCount || 0) < 1) {
    return "retryAnalysis";
  }
  return "aggregate";
}

export { extractJsonObject, coerceActionRequired, deriveActionRequired, isClearlyOnTrack };
