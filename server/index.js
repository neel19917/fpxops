import "dotenv/config";
import express from "express";
import cors from "cors";
import { ChatAnthropic } from "@langchain/anthropic";
import { buildGraph } from "./graph.js";
import { requireApiKey, bootstrapAdminKey } from "./lib/auth.js";
import { isDbReady } from "./lib/supabase.js";
import { shipmentsRouter } from "./routes/shipments.js";
import { analysesRouter } from "./routes/analyses.js";
import { analyzeRouter } from "./routes/analyze.js";
import { auditsRouter } from "./routes/audits.js";
import { apiKeysRouter } from "./routes/apiKeys.js";

const app = express();

// CORS — comma-separated origin allowlist, wildcard support for chrome-extension.
const rawOrigins = (process.env.CORS_ORIGINS || "chrome-extension://*,http://localhost:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    const ok = rawOrigins.some((o) => {
      if (o === "*") return true;
      if (o.endsWith("/*")) return origin.startsWith(o.slice(0, -2));
      return o === origin;
    });
    cb(ok ? null : new Error(`CORS blocked: ${origin}`), ok);
  },
  credentials: false,
  allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
}));
app.use(express.json({ limit: "20mb" }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[FPX] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

const PORT = process.env.PORT || 3210;
const startedAt = Date.now();

// Public health check — no auth.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "2.0.0",
    uptime: Math.round((Date.now() - startedAt) / 1000),
    db: isDbReady(),
  });
});

// All /api/* routes require an API key.
const api = express.Router();
api.use(requireApiKey());
api.use("/shipments", shipmentsRouter);
api.use("/analyses", analysesRouter);
api.use("/analyze", analyzeRouter);
api.use("/audits", auditsRouter);
app.use("/api", api);

// Admin routes (admin scope enforced inside the router).
app.use("/api-keys", apiKeysRouter);

// ---------- Legacy LangGraph batch endpoint ----------
// Kept for extension backwards-compat; now protected by API key.
const model = new ChatAnthropic({
  model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  maxTokens: 512,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
});
const graph = buildGraph();
const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;

app.post("/analyze", requireApiKey(), async (req, res) => {
  const { shipments } = req.body;
  if (!Array.isArray(shipments) || shipments.length === 0) {
    return res.status(400).json({ error: "shipments array is required" });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, ANALYZE_TIMEOUT_MS);
  try {
    const result = await graph.invoke({ shipments, _model: model });
    clearTimeout(timer);
    const analyzed = (result.analyzed || []).map((r) => {
      const { _model, _classification, _parseError, _aiResults, ...rest } = r;
      return rest;
    });
    res.json({ analyzed, summary: result.summary || "", errors: (result.errors || []).length, timedOut });
  } catch (e) {
    clearTimeout(timer);
    console.error("[FPX] Graph error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.message && err.message.startsWith("CORS blocked")) {
    return res.status(403).json({ error: err.message });
  }
  console.error("[FPX] Unhandled error:", err);
  res.status(500).json({ error: err.message || "Server error" });
});

app.listen(PORT, async () => {
  console.log(`[FPX] API server running on :${PORT}`);
  console.log(`[FPX] CORS origins: ${rawOrigins.join(", ") || "(none)"}`);
  if (!isDbReady()) console.warn("[FPX] ⚠️  Supabase env vars missing — reads/writes will fail");
  try { await bootstrapAdminKey(); } catch (e) { console.warn("[FPX] bootstrap failed:", e.message); }
});
