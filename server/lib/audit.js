import { supabase } from "./supabase.js";

// Universal audit logger. Writes to fpx_audit_log via service role so RLS
// doesn't matter; admins read it back through the dashboard /api/audit-log
// endpoint. Never throws — failures here must not break the calling request.
//
// Usage:
//   await logAudit(req, {
//     action: "update",
//     entity_type: "shipment",
//     entity_id: id,
//     summary: "marked tracking 401821050 as YES",
//     before, after, metadata,
//   });
//
// `req` carries the actor: req.user (JWT) or req.apiKey (key auth).
// Pass req=null for system-originated events (e.g. trigger-style auto-tasks).
export async function logAudit(req, entry) {
  try {
    const row = {
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id ? String(entry.entity_id) : null,
      summary: entry.summary || null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      metadata: entry.metadata ?? null,
      actor_id: req?.user?.id || null,
      actor_email: req?.user?.email || null,
      actor_name: req?.user?.email || req?.apiKey?.name || req?.header?.("x-fpx-user-name") || null,
      actor_source: req?.user ? "jwt" : req?.apiKey ? "api_key" : "system",
      api_key_id: req?.apiKey?.id || null,
    };
    const { error } = await supabase.from("fpx_audit_log").insert(row);
    if (error) console.warn("[FPX-AUDIT] insert failed:", error.message);
  } catch (e) {
    console.warn("[FPX-AUDIT] threw:", e?.message || e);
  }
}
