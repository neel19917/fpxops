import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
import { classify, classifyRouter } from "./nodes/classify.js";
import { analyzeWithAI } from "./nodes/analyze.js";
import { parseResponse, parseRouter } from "./nodes/parse.js";
import { summarize } from "./nodes/summarize.js";

const ShipmentState = Annotation.Root({
  shipments: Annotation({ reducer: (_, b) => b, default: () => [] }),
  classified: Annotation({
    reducer: (_, b) => b,
    default: () => ({ routine: [], ambiguous: [], critical: [] }),
  }),
  analyzed: Annotation({ reducer: (_, b) => b, default: () => [] }),
  summary: Annotation({ reducer: (_, b) => b, default: () => "" }),
  errors: Annotation({ reducer: (_, b) => b, default: () => [] }),
  retryQueue: Annotation({ reducer: (_, b) => b, default: () => [] }),
  _aiResults: Annotation({ reducer: (_, b) => b, default: () => [] }),
  _retryCount: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  _model: Annotation({ reducer: (_, b) => b, default: () => null }),
  // Action-required confidence cutoff, threaded from the /analyze route (read
  // from fpx_settings: action.threshold). Declared so LangGraph keeps it in
  // state; parse.js reads it instead of hardcoding 0.7.
  _threshold: Annotation({ reducer: (_, b) => b, default: () => 0.7 }),
});

function markNoAction(state) {
  const routine = state.classified.routine || [];
  const analyzed = [
    ...(state.analyzed || []),
    ...routine.map((s) => ({
      ...s,
      _actionRequired: "NO",
      _aiIssue: "None - shipment is on track",
      _aiRecommendation: "No action needed (auto-classified).",
      _needsActionSheet: false,
    })),
  ];
  return { analyzed };
}

function aggregate(state) {
  const routine = state.classified.routine || [];
  const routineAnalyzed = routine.map((s) => ({
    ...s,
    _actionRequired: "NO",
    _aiIssue: "None - shipment is on track",
    _aiRecommendation: "No action needed (auto-classified).",
    _needsActionSheet: false,
  }));

  const existingAnalyzed = state.analyzed || [];
  const hasRoutineAlready = existingAnalyzed.some(
    (r) => r._classification === "routine"
  );

  const analyzed = hasRoutineAlready
    ? existingAnalyzed
    : [...routineAnalyzed, ...existingAnalyzed];

  const errors = analyzed.filter((r) => r._actionRequired === "ERROR");
  return { analyzed, errors };
}

async function retryAnalysis(state) {
  const model = state._model;
  const queue = state.retryQueue || [];
  const results = [];

  for (const shipment of queue) {
    try {
      const response = await model.invoke([
        {
          role: "user",
          content: `Respond ONLY with valid JSON. No explanation.\n\n{"actionRequired": true or false, "issue": "...", "recommendation": "..."}\n\nShipment: ${JSON.stringify(shipment._trackingNumber || "unknown")}`,
        },
      ]);
      results.push({ ...shipment, _aiRawAnalysis: response.content });
    } catch (e) {
      results.push({
        ...shipment,
        _actionRequired: "ERROR",
        _aiIssue: e.message,
        _aiRecommendation: "",
      });
    }
  }

  return {
    _aiResults: results,
    retryQueue: [],
    _retryCount: (state._retryCount || 0) + 1,
  };
}

export function buildGraph() {
  const graph = new StateGraph(ShipmentState)
    .addNode("classify", classify)
    .addNode("markNoAction", markNoAction)
    .addNode("analyzeWithAI", analyzeWithAI)
    .addNode("parseResponse", parseResponse)
    .addNode("retryAnalysis", retryAnalysis)
    .addNode("aggregate", aggregate)
    .addNode("summarize", summarize)
    .addEdge(START, "classify")
    .addConditionalEdges("classify", classifyRouter, {
      markNoAction: "markNoAction",
      analyzeWithAI: "analyzeWithAI",
    })
    .addEdge("markNoAction", "summarize")
    .addEdge("analyzeWithAI", "parseResponse")
    .addConditionalEdges("parseResponse", parseRouter, {
      retryAnalysis: "retryAnalysis",
      aggregate: "aggregate",
    })
    .addEdge("retryAnalysis", "parseResponse")
    .addEdge("aggregate", "summarize")
    .addEdge("summarize", END);

  return graph.compile();
}
