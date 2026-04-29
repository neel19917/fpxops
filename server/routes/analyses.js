import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";

export const analysesRouter = Router();

// GET /analyses?kind=&tracking_number=&limit=500
analysesRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  let q = supabase.from("fpx_ai_analyses").select("*").order("created_at", { ascending: false }).limit(limit);
  if (req.query.kind) q = q.eq("kind", String(req.query.kind));
  if (req.query.tracking_number) q = q.eq("tracking_number", String(req.query.tracking_number));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

analysesRouter.get("/:id", async (req, res) => {
  const { data, error } = await supabase.from("fpx_ai_analyses").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Analysis not found" });
  res.json({ analysis: data });
});

// POST /analyses/:id/rating  { rating: 'up' | 'down' | null, reason?: string }
// Reps rate prompts with thumbs up/down so the team can see which
// generations are landing well vs which need prompt tweaks. Passing
// `null` clears the rating (mistaken click). Rating + reason + who +
// when are stored on the analyses row itself — see migration
// 2026-04-29_add_rating_columns_to_ai_analyses.sql.
analysesRouter.post("/:id/rating", async (req, res) => {
  const allowed = [null, "up", "down"];
  const incoming = req.body?.rating === undefined ? null : req.body.rating;
  const rating = allowed.includes(incoming) ? incoming : null;
  if (req.body?.rating !== undefined && !allowed.includes(req.body.rating)) {
    return res.status(400).json({ error: "rating must be 'up', 'down', or null" });
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : null;
  const ratedBy = req.user?.email || req.apiKey?.name || req.header("x-fpx-user-name") || null;

  // Read current state for audit-log diffing — small overhead, but
  // gives the team a paper trail when ratings flip.
  const { data: before } = await supabase
    .from("fpx_ai_analyses")
    .select("id, kind, model, rating, rating_reason, rated_by, rated_at")
    .eq("id", req.params.id)
    .maybeSingle();
  if (!before) return res.status(404).json({ error: "Analysis not found" });

  const patch = {
    rating,
    rating_reason: rating ? (reason || null) : null,
    rated_by: rating ? ratedBy : null,
    rated_at: rating ? new Date().toISOString() : null,
  };
  const { data, error } = await supabase
    .from("fpx_ai_analyses")
    .update(patch)
    .eq("id", req.params.id)
    .select("id, rating, rating_reason, rated_by, rated_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  logAudit(req, {
    action: "rate", entity_type: "analysis", entity_id: data.id,
    summary: rating
      ? `Rated analysis ${rating === "up" ? "👍" : "👎"}${reason ? ` — ${reason.slice(0, 80)}` : ""}`
      : `Cleared rating on analysis`,
    before, after: data,
    metadata: { rating, model: before.model, kind: before.kind },
  });
  res.json({ analysis: data });
});
