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

// Most rows of one invoice audit a public link sends.
const PUBLIC_ROW_CAP = 5000;
// Most rows read for an ERP pull before ranking (same ceiling as
// GET /audits/invoice/:id).
const ERP_LOAD_MAX = 10000;

// Rows of one invoice audit, oldest first, read 1,000 at a time because
// Supabase caps a single request at 1,000 rows. Same loop as loadAuditRows in
// routes/audits.js. Stops at `max` rows. `total` is the table's own count for
// the audit (null if the count did not come back).
async function loadInvoiceAuditRows(auditId, max) {
  const PAGE = 1000;
  const rows = [];
  let total = null;
  let byCreated = true; // falls back to id-only if the table has no created_at
  for (let from = 0; from < max; from += PAGE) {
    const page = () => {
      let q = supabase.from("fpx_invoice_audit_rows")
        .select("*", from === 0 ? { count: "exact" } : undefined)
        .eq("audit_id", auditId);
      if (byCreated) q = q.order("created_at", { ascending: true });
      return q.order("id", { ascending: true }).range(from, Math.min(from + PAGE, max) - 1);
    };
    let { data, error, count } = await page();
    if (error && byCreated && from === 0) {
      byCreated = false;
      ({ data, error, count } = await page());
    }
    if (error) return { rows, total, error: error.message };
    if (from === 0 && Number.isFinite(count)) total = count;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { rows, total, error: null };
}

// What a public link shows of one ERP-pull row. Everything else on the row
// stays private: ai_notes, and in raw the invoice number, tracking number,
// account manager, user, get_invoice state, and the approval's notes,
// uploader, amounts and who ran the check.
function publicErpRow(row) {
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const approval = raw.approval && typeof raw.approval === "object" ? raw.approval : null;
  return {
    id: row.id,
    shipment_id: row.shipment_id ?? null,
    carrier: row.carrier ?? null,
    customer_name: row.customer_name ?? null,
    bill_amount: row.bill_amount ?? null,
    shipment_cost: row.shipment_cost ?? null,
    difference: row.difference ?? null,
    status: row.status ?? null,
    raw: {
      rank: raw.rank ?? null,
      charge: raw.charge ?? null,
      gross_profit: raw.gross_profit ?? null,
      shipped_date: raw.shipped_date ?? null,
      flags: Array.isArray(raw.flags) ? raw.flags : [],
      approval: approval
        ? {
            status: approval.status ?? null,
            approved_by: approval.approved_by ?? null,
            approved_by_kind: approval.approved_by_kind ?? null,
            approved_at: approval.approved_at ?? null,
          }
        : null,
    },
  };
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
    const isErpPull = run.shipment_type === "erp_pending";
    // An ERP pull is ranked by a value inside jsonb, so every row is read
    // before the best-ranked ones are kept; a carrier-bill run only needs the
    // rows it will send (plus the count).
    const loaded = await loadInvoiceAuditRows(run.id, isErpPull ? ERP_LOAD_MAX : PUBLIC_ROW_CAP);
    if (loaded.error) {
      console.error(`[share] invoice audit ${run.id}: rows could not be read: ${loaded.error}`);
      return { loadError: "Could not load this shared audit. Try again in a minute." };
    }
    let rows = loaded.rows;
    const out = { run };
    if (isErpPull) {
      const rank = (r) => (Number.isFinite(Number(r.raw?.rank)) && r.raw?.rank !== null ? Number(r.raw.rank) : Infinity);
      rows.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        return ra === rb ? 0 : ra < rb ? -1 : 1;
      });
      out.approved_count = rows.filter((r) => r.raw?.approval?.status === "approved").length;
    }
    const total = Math.max(loaded.total ?? 0, rows.length);
    if (total > PUBLIC_ROW_CAP || rows.length > PUBLIC_ROW_CAP) {
      rows = rows.slice(0, PUBLIC_ROW_CAP);
      out.truncated = true;
    }
    out.total_rows = total;
    out.rows = isErpPull ? rows.map(publicErpRow) : rows;
    return out;
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
    if (data.loadError) return res.status(500).json({ error: data.loadError });
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
  if (data.loadError) return res.status(500).json({ error: data.loadError });

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
