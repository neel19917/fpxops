import { Router } from "express";
import { supabase } from "../lib/supabase.js";

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
