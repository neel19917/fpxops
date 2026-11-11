import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { supabase } from "../lib/supabase.js";
import { governanceLoggingEnabled } from "../lib/governance.js";

// AI Governance (admin): usage by AI feature, the governance trail (prompt /
// model changes with before → after, AI rewrites, previews, human reviews),
// and the per-call AI log with full prompt + response.
export const governanceRouter = Router();
governanceRouter.use(requireAuth({ scope: "admin", role: "admin" }));

const CALL_COLS = "id, created_at, kind, model, tracking_number, user_email, cost_usd, input_tokens, output_tokens, duration_ms, error, rating, rated_by, metadata";

// GET /api/governance/summary?days=30
governanceRouter.get("/summary", async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const [{ data: features, error }, { count: changes }, logging] = await Promise.all([
    supabase.rpc("fpx_ai_governance_summary", { p_days: days }),
    supabase.from("fpx_ai_governance_log").select("id", { count: "exact", head: true })
      .gte("created_at", since).in("event_type", ["prompt_change", "model_change", "ai_setting_change", "logging_change"]),
    governanceLoggingEnabled(),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ days, logging, features: features || [], changes: changes || 0 });
});

// GET /api/governance/pipeline — live counts for the Data Flow chart.
governanceRouter.get("/pipeline", async (_req, res) => {
  const day = new Date(Date.now() - 86400_000).toISOString();
  const month = new Date(Date.now() - 30 * 86400_000).toISOString();
  const count = (q) => q.then((r) => r.count ?? 0);
  try {
    const [scraped24, analyses24, openTasks, indexRows, embedded, indexMeta, chat30] = await Promise.all([
      count(supabase.from("fpx_shipments").select("id", { count: "exact", head: true }).gte("scraped_at", day)),
      count(supabase.from("fpx_ai_analyses").select("id", { count: "exact", head: true }).gte("created_at", day)),
      count(supabase.from("fpx_shipment_tasks").select("id", { count: "exact", head: true }).is("archived_at", null).in("status", ["open", "in_progress", "blocked"])),
      count(supabase.from("fpx_assistant_index").select("shipment_uuid", { count: "exact", head: true })),
      count(supabase.from("fpx_assistant_index").select("shipment_uuid", { count: "exact", head: true }).not("embedding", "is", null)),
      supabase.from("fpx_assistant_index").select("indexed_at").order("indexed_at", { ascending: false }).limit(1),
      supabase.from("fpx_ai_analyses").select("cost_usd, user_email, duration_ms").contains("metadata", { subkind: "ask_fpx" }).gte("created_at", month).limit(5000),
    ]);
    const chats = chat30.data || [];
    res.json({
      scraped_24h: scraped24,
      analyses_24h: analyses24,
      open_tasks: openTasks,
      index: { rows: indexRows, embedded, built_at: indexMeta.data?.[0]?.indexed_at || null },
      chat_30d: {
        turns: chats.length,
        people: new Set(chats.map((c) => c.user_email).filter(Boolean)).size,
        cost_usd: Math.round(chats.reduce((a, c) => a + Number(c.cost_usd || 0), 0) * 10000) / 10000,
        avg_ms: chats.length ? Math.round(chats.reduce((a, c) => a + Number(c.duration_ms || 0), 0) / chats.length) : null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/governance/events?type=&limit=100&before=ISO
governanceRouter.get("/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  let q = supabase.from("fpx_ai_governance_log").select("*").order("created_at", { ascending: false }).limit(limit);
  if (req.query.type) q = q.in("event_type", String(req.query.type).split(","));
  if (req.query.before) q = q.lt("created_at", String(req.query.before));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// GET /api/governance/calls?feature=&by=kind|subkind&user=&errors=1&limit=100&before=ISO
governanceRouter.get("/calls", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  let q = supabase.from("fpx_ai_analyses").select(CALL_COLS).order("created_at", { ascending: false }).limit(limit);
  const f = String(req.query.feature || "").replace(/[^a-z0-9_.-]/gi, "");
  // A feature is either a sub-kind (email_draft_carrier, plain_summary…) or,
  // for calls without one, the kind itself (per_shipment, gp, invoice…).
  if (f) q = req.query.by === "kind" ? q.eq("kind", f) : q.contains("metadata", { subkind: f });
  if (req.query.user === "system") q = q.is("user_email", null);
  else if (req.query.user) q = q.eq("user_email", String(req.query.user));
  if (req.query.errors === "1") q = q.not("error", "is", null);
  if (req.query.before) q = q.lt("created_at", String(req.query.before));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// GET /api/governance/calls/:id — full prompt + response
governanceRouter.get("/calls/:id", async (req, res) => {
  const { data, error } = await supabase.from("fpx_ai_analyses").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ call: data });
});
