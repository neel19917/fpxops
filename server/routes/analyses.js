import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";

export const analysesRouter = Router();

// GET /analyses?kind=&tracking_number=&limit=500&from=&to=&model=&rating=&user_email=&source=
// `from` / `to` are ISO timestamps. `rating` accepts "up", "down",
// or "unrated" (the latter matches rows where rating IS NULL — useful
// for the admin export page to slice ratings split).
// GET /analyses/stats?kind=&subkind=&days=
// Exact totals via the fpx_analyses_stats() SQL function (see
// migrations/2026-09-23_analyses_stats_fn.sql). PostgREST caps a select at
// 1000 rows on this project, so the page can't add these up client-side —
// it was showing "1000 analyses / $4.47" against a real $197 all-time.
analysesRouter.get("/stats", async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : null;
  const { data, error } = await supabase.rpc("fpx_analyses_stats", {
    p_kind: req.query.kind ? String(req.query.kind) : null,
    p_subkind: req.query.subkind ? String(req.query.subkind) : null,
    p_days: Number.isFinite(days) && days > 0 ? Math.round(days) : null,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ stats: data });
});

analysesRouter.get("/", async (req, res) => {
  // PostgREST hard-caps at 1000 rows per request; page with `before`.
  const limit = Math.min(Number(req.query.limit) || 500, 1000);
  let q = supabase.from("fpx_ai_analyses").select("*").order("created_at", { ascending: false }).limit(limit);
  if (req.query.kind) q = q.eq("kind", String(req.query.kind));
  // Sub-kind lives in metadata (email_draft_carrier, task_triage, daily_summary, plain_summary…).
  if (req.query.subkind) q = q.contains("metadata", { subkind: String(req.query.subkind) });
  if (req.query.before) q = q.lt("created_at", String(req.query.before));
  if (req.query.tracking_number) q = q.eq("tracking_number", String(req.query.tracking_number));
  if (req.query.model) q = q.eq("model", String(req.query.model));
  if (req.query.user_email) q = q.eq("user_email", String(req.query.user_email));
  if (req.query.source) q = q.eq("source", String(req.query.source));
  if (req.query.from) q = q.gte("created_at", String(req.query.from));
  if (req.query.to) q = q.lte("created_at", String(req.query.to));
  if (req.query.rating === "up" || req.query.rating === "down") {
    q = q.eq("rating", String(req.query.rating));
  } else if (req.query.rating === "unrated") {
    q = q.is("rating", null);
  }
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const rows = data || [];
  // Cursor for the next page: created_at of the last row, or null when
  // this page came back short (no more rows).
  res.json({ data: rows, next_before: rows.length === limit ? rows[rows.length - 1].created_at : null });
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
