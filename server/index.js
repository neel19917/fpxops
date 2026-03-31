import "dotenv/config";
import express from "express";
import cors from "cors";
import { ChatAnthropic } from "@langchain/anthropic";
import { buildGraph } from "./graph.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3210;
const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
const startedAt = Date.now();

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[LangGraph] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

const model = new ChatAnthropic({
  model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  maxTokens: 512,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
});

const graph = buildGraph();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "1.0.0",
    uptime: Math.round((Date.now() - startedAt) / 1000),
  });
});

app.post("/analyze", async (req, res) => {
  const { shipments } = req.body;
  if (!Array.isArray(shipments) || shipments.length === 0) {
    return res.status(400).json({ error: "shipments array is required" });
  }

  console.log(`[LangGraph] Received ${shipments.length} shipment(s)`);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, ANALYZE_TIMEOUT_MS);

  try {
    const result = await graph.invoke({
      shipments,
      _model: model,
    });

    clearTimeout(timer);

    const analyzed = (result.analyzed || []).map((r) => {
      const { _model, _classification, _parseError, _aiResults, ...rest } = r;
      return rest;
    });

    console.log(
      `[LangGraph] Done: ${analyzed.length} analyzed, ${(result.errors || []).length} errors${timedOut ? " (timeout reached)" : ""}`
    );

    res.json({
      analyzed,
      summary: result.summary || "",
      errors: (result.errors || []).length,
      timedOut,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error("[LangGraph] Graph error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[LangGraph] Server running on http://localhost:${PORT}`);
  console.log(`[LangGraph] POST /analyze   — analyze shipment batch`);
  console.log(`[LangGraph] GET  /health    — health check`);
});
