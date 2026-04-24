import crypto from "node:crypto";
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";

export const shareLinksRouter = Router();

// Requires an enabled dashboard user — not for API-key clients.
shareLinksRouter.use(requireAuth({ acceptApiKey: false }));

const VALID_TYPES = new Set(["shipment", "gp_audit", "invoice_audit", "analysis"]);

function generateToken() {
  // URL-safe, human-scannable length.
  return crypto.randomBytes(18).toString("base64url");
}
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}

// GET /api/share-links — lists links you created (admins see all).
shareLinksRouter.get("/", async (req, res) => {
  let q = supabase
    .from("fpx_share_links")
    .select("id, token, resource_type, resource_id, label, expires_at, revoked_at, view_count, last_viewed_at, created_at, created_by")
    .order("created_at", { ascending: false });
  if (req.user.role !== "admin") q = q.eq("created_by", req.user.id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// GET /api/share-links/:id  — with recent views for analytics.
shareLinksRouter.get("/:id", async (req, res) => {
  const { data: link, error } = await supabase
    .from("fpx_share_links").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!link) return res.status(404).json({ error: "Not found" });
  if (link.created_by !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "Not your link" });
  }
  const { data: views } = await supabase
    .from("fpx_share_link_views")
    .select("*").eq("link_id", link.id)
    .order("viewed_at", { ascending: false }).limit(200);
  res.json({ link, views: views || [] });
});

// POST /api/share-links { resource_type, resource_id, label?, expires_in_days?, password? }
shareLinksRouter.post("/", async (req, res) => {
  const { resource_type, resource_id, label, expires_in_days, password } = req.body || {};
  if (!VALID_TYPES.has(resource_type)) return res.status(400).json({ error: "Invalid resource_type" });
  if (!resource_id) return res.status(400).json({ error: "resource_id is required" });

  const row = {
    token: generateToken(),
    resource_type,
    resource_id,
    label: label || null,
    created_by: req.user.id,
    password_hash: password ? hashPassword(String(password)) : null,
    expires_at: Number(expires_in_days)
      ? new Date(Date.now() + Number(expires_in_days) * 86400 * 1000).toISOString()
      : null,
  };
  const { data, error } = await supabase.from("fpx_share_links").insert(row).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ link: data });
});

// DELETE /api/share-links/:id — soft revoke.
shareLinksRouter.delete("/:id", async (req, res) => {
  const { data: link } = await supabase
    .from("fpx_share_links").select("id, created_by").eq("id", req.params.id).maybeSingle();
  if (!link) return res.status(404).json({ error: "Not found" });
  if (link.created_by !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "Not your link" });
  }
  const { error } = await supabase
    .from("fpx_share_links").update({ revoked_at: new Date().toISOString() }).eq("id", link.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
