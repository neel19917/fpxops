const ROUTINE_STATUSES = new Set([
  "delivered",
  "in transit",
  "booked",
  "scheduled/tendered",
  "out for delivery",
]);

const CRITICAL_STATUSES = new Set(["issue"]);

const EXCEPTION_KEYWORDS =
  /\b(delay|exception|missed|failed|refused|damaged|lost|hold|return|cancel|wrong|incorrect|urgent|rescheduled|appointment missed|detention|claim|shortage|overage)\b/i;

function classifySingle(shipment) {
  const status = (shipment["SHIPMENT STATUS"] || "").trim().toLowerCase();
  const comments = (shipment["COMMENTS"] || "").trim();

  if (CRITICAL_STATUSES.has(status)) return "critical";
  if (EXCEPTION_KEYWORDS.test(comments)) {
    return ROUTINE_STATUSES.has(status) ? "ambiguous" : "critical";
  }
  if (ROUTINE_STATUSES.has(status)) return "routine";
  return "ambiguous";
}

export function classify(state) {
  const routine = [];
  const ambiguous = [];
  const critical = [];

  for (const s of state.shipments) {
    const bucket = classifySingle(s);
    if (bucket === "routine") routine.push({ ...s, _classification: "routine" });
    else if (bucket === "critical") critical.push({ ...s, _classification: "critical" });
    else ambiguous.push({ ...s, _classification: "ambiguous" });
  }

  return {
    classified: { routine, ambiguous, critical },
  };
}

export function classifyRouter(state) {
  const { routine, ambiguous, critical } = state.classified;
  const hasWork = ambiguous.length > 0 || critical.length > 0;
  if (!hasWork) return "markNoAction";
  return "analyzeWithAI";
}
