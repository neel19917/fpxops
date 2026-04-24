import "dotenv/config";
import express from "express";
import cors from "cors";

// Surface crashes in Railway's deploy logs instead of silently exiting.
process.on("uncaughtException", (e) => {
  console.error("[FPX] uncaughtException:", e?.stack || e);
});
process.on("unhandledRejection", (e) => {
  console.error("[FPX] unhandledRejection:", e?.stack || e);
});
import { ChatAnthropic } from "@langchain/anthropic";
import { buildGraph } from "./graph.js";
import { requireAuth, bootstrapAdminKey, bootstrapAdminEmail } from "./lib/auth.js";
import { isDbReady } from "./lib/supabase.js";
import { shipmentsRouter } from "./routes/shipments.js";
import { analysesRouter } from "./routes/analyses.js";
import { analyzeRouter } from "./routes/analyze.js";
import { auditsRouter } from "./routes/audits.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { meRouter } from "./routes/me.js";
import { usersRouter } from "./routes/users.js";
import { shareLinksRouter } from "./routes/shareLinks.js";
import { publicShareRouter } from "./routes/publicShare.js";

const app = express();
app.set("trust proxy", 1);

// CORS — comma-separated origin allowlist. Wildcards supported via `host/*` suffix
// and the chrome-extension://* pattern.
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
    version: "2.1.0",
    uptime: Math.round((Date.now() - startedAt) / 1000),
    db: isDbReady(),
  });
});

// Public share viewer — no auth, rate-limited by token validity.
app.use("/share", publicShareRouter);

// Identity probe for the dashboard/extension — accepts either auth method.
app.use("/api/me", meRouter);

// Authenticated API (API key OR JWT with enabled=true).
const api = express.Router();
api.use(requireAuth());
api.use("/shipments", shipmentsRouter);
api.use("/analyses", analysesRouter);
api.use("/analyze", analyzeRouter);
api.use("/audits", auditsRouter);
api.use("/share-links", shareLinksRouter);
app.use("/api", api);

// Admin routes (admin scope OR admin role).
app.use("/api/users", usersRouter);
app.use("/api-keys", apiKeysRouter);

// ---------- Legacy LangGraph batch endpoint ----------
// Kept for extension backwards-compat; now dual-auth.
const model = new ChatAnthropic({
  model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  maxTokens: 512,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
});
const graph = buildGraph();
const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;

app.post("/analyze", requireAuth(), async (req, res) => {
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

const HOST = process.env.HOST || "0.0.0.0";
const server = app.listen(PORT, HOST, () => {
  console.log(`[FPX] API server listening on ${HOST}:${PORT}`);
  console.log(`[FPX] CORS origins: ${rawOrigins.join(", ") || "(none)"}`);
  if (!isDbReady()) console.warn("[FPX] ⚠️  Supabase env vars missing — reads/writes will fail");
});
server.on("error", (e) => {
  console.error("[FPX] server.listen error:", e.stack || e);
  process.exit(1);
});

// Bootstrap after listener is up. Failures here must NOT crash the server —
// health check needs to respond regardless.
(async () => {
  try { await bootstrapAdminKey(); } catch (e) { console.warn("[FPX] bootstrapAdminKey failed:", e.message); }
  try { await bootstrapAdminEmail(); } catch (e) { console.warn("[FPX] bootstrapAdminEmail failed:", e.message); }
})();
