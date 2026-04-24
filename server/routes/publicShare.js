import crypto from "node:crypto";
import { Router } from "express";
import { supabase } from "../lib/supabase.js";

export const publicShareRouter = Router();

function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}

async function loadLinkByToken(token) {
  const { data } = await supabase
    .from("fpx_share_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!data) return { error: "not_found", status: 404 };
  if (data.revoked_at) return { error: "revoked", status: 410 };
  if (data.expires_at && new Date(data.expires_at) < new Date()) return { error: "expired", status: 410 };
  return { link: data };
}

async function loadResource(link) {
  if (link.resource_type === "shipment") {
    const { data: shipment } = await supabase.from("fpx_shipments").select("*").eq("id", link.resource_id).maybeSingle();
    if (!shipment) return null;
    const { data: analyses } = await supabase
      .from("fpx_ai_analyses").select("id, created_at, kind, model, issue, recommendation, response_text, action_required")
      .or(`shipment_uuid.eq.${shipment.id},tracking_number.eq.${shipment.tracking_number || "__none__"}`)
      .order("created_at", { ascending: false }).limit(20);
    return { shipment, analyses: analyses || [] };
  }
  if (link.resource_type === "gp_audit") {
    const { data: run } = await supabase.from("fpx_gp_audits").select("*").eq("id", link.resource_id).maybeSingle();
    if (!run) return null;
    const { data: rows } = await supabase.from("fpx_gp_audit_rows").select("*").eq("audit_id", run.id).limit(2000);
    return { run, rows: rows || [] };
  }
  if (link.resource_type === "invoice_audit") {
    const { data: run } = await supabase.from("fpx_invoice_audits").select("*").eq("id", link.resource_id).maybeSingle();
    if (!run) return null;
    const { data: rows } = await supabase.from("fpx_invoice_audit_rows").select("*").eq("audit_id", run.id).limit(2000);
    return { run, rows: rows || [] };
  }
  if (link.resource_type === "analysis") {
    const { data: analysis } = await supabase.from("fpx_ai_analyses").select("*").eq("id", link.resource_id).maybeSingle();
    if (!analysis) return null;
    return { analysis };
  }
  return null;
}

// GET /share/:token  — metadata (password gate check). Never returns resource
// data if a password is required; client must call the view POST with password.
publicShareRouter.get("/:token", async (req, res) => {
  const r = await loadLinkByToken(req.params.token);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const link = r.link;
  const requiresPassword = Boolean(link.password_hash);
  const meta = {
    label: link.label,
    resource_type: link.resource_type,
    created_at: link.created_at,
    expires_at: link.expires_at,
    requires_password: requiresPassword,
  };
  if (!requiresPassword) {
    const data = await loadResource(link);
    if (!data) return res.status(404).json({ error: "Resource deleted" });
    return res.json({ meta, data });
  }
  res.json({ meta });
});

// POST /share/:token/view  { password? } — records a view + returns the data.
publicShareRouter.post("/:token/view", async (req, res) => {
  const r = await loadLinkByToken(req.params.token);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const link = r.link;
  if (link.password_hash) {
    const pw = String(req.body?.password || "");
    if (!pw || hashPassword(pw) !== link.password_hash) {
      return res.status(401).json({ error: "Wrong password" });
    }
  }
  const data = await loadResource(link);
  if (!data) return res.status(404).json({ error: "Resource deleted" });

  // Log the view + increment counter. Best-effort; don't fail the response.
  const ip = (req.header("x-forwarded-for") || "").split(",")[0].trim() || req.ip || null;
  const ua = req.header("user-agent") || null;
  const referrer = req.header("referer") || null;
  supabase.from("fpx_share_link_views").insert({
    link_id: link.id,
    viewer_ip: ip,
    viewer_user_agent: ua,
    referrer,
  }).then(() => {});
  supabase.from("fpx_share_links").update({
    view_count: (link.view_count || 0) + 1,
    last_viewed_at: new Date().toISOString(),
  }).eq("id", link.id).then(() => {});

  res.json({
    meta: {
      label: link.label,
      resource_type: link.resource_type,
      created_at: link.created_at,
    },
    data,
  });
});
