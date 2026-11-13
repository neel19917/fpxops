import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { analyzeGpAuditRun, analyzeInvoiceAuditRun } from "./analyze.js";
import { auditHistoryRows } from "../lib/historyAudit.js";

export const auditsRouter = Router();

// ---------- GP Audits ----------
auditsRouter.get("/gp", async (_req, res) => {
  const { data, error } = await supabase
    .from("fpx_gp_audits")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

auditsRouter.get("/gp/:id", async (req, res) => {
  const { data: run, error } = await supabase.from("fpx_gp_audits").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "GP audit not found" });
  const { data: rows } = await supabase
    .from("fpx_gp_audit_rows").select("*").eq("audit_id", run.id).order("gp_pct", { ascending: true }).limit(2000);
  res.json({ run, rows: rows || [] });
});

auditsRouter.post("/gp", async (req, res) => {
  const { run, rows, ai_level } = req.body || {};
  if (!run) return res.status(400).json({ error: "body.run required" });
  const { data: created, error } = await supabase.from("fpx_gp_audits").insert(run).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (Array.isArray(rows) && rows.length) {
    const payload = rows.map((r) => ({ ...r, audit_id: created.id }));
    const { error: rowErr } = await supabase.from("fpx_gp_audit_rows").insert(payload);
    if (rowErr) return res.status(500).json({ error: rowErr.message });
  }
  // Mirror the shipments flow: kick off AI in the background after persistence
  // so the extension's POST returns fast. Default 'summary' (one Claude call);
  // 'full' adds per-row reviews. Pass ai_level: 'off' to skip entirely.
  const level = ai_level === "full" ? "full" : ai_level === "off" ? "off" : "summary";
  if (level !== "off") {
    void analyzeGpAuditRun(created.id, { reqContext: req, level })
      .catch((e) => console.warn("[FPX] gp auto-analyze failed:", e.message));
  }
  res.json({ run: created, row_count: (rows || []).length });
});

// POST /audits/gp/:id/reanalyze — manual trigger from the dashboard.
auditsRouter.post("/gp/:id/reanalyze", async (req, res) => {
  const level = req.body?.level === "full" ? "full" : "summary";
  const updated = await analyzeGpAuditRun(req.params.id, { reqContext: req, level });
  if (!updated) return res.status(404).json({ error: "GP audit not found" });
  res.json({ run: updated });
});

// ---------- Invoice Audits ----------
auditsRouter.get("/invoice", async (_req, res) => {
  const { data, error } = await supabase
    .from("fpx_invoice_audits")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

auditsRouter.get("/invoice/:id", async (req, res) => {
  const { data: run, error } = await supabase.from("fpx_invoice_audits").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "Invoice audit not found" });
  // Page through the rows (Supabase caps a single read at 1000) in a fixed
  // order so pages never overlap. ERP-pending runs can hold thousands of rows.
  const PAGE = 1000;
  const MAX_ROWS = 10000;
  const rows = [];
  let byCreated = true; // falls back to id-only if the table has no created_at
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const page = () => {
      let q = supabase.from("fpx_invoice_audit_rows").select("*").eq("audit_id", run.id);
      if (byCreated) q = q.order("created_at", { ascending: true });
      return q.order("id", { ascending: true }).range(from, from + PAGE - 1);
    };
    let { data, error: rowErr } = await page();
    if (rowErr && byCreated && from === 0) {
      byCreated = false;
      ({ data, error: rowErr } = await page());
    }
    if (rowErr) return res.status(500).json({ error: rowErr.message });
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  // ERP-pending rows are ranked by charge (biggest first) when they are stored;
  // the charge lives in jsonb, so put them back in that order here.
  if (run.shipment_type === "erp_pending") {
    const rank = (r) => (Number.isFinite(Number(r.raw?.rank)) && r.raw?.rank !== null ? Number(r.raw.rank) : Infinity);
    rows.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra === rb ? 0 : ra < rb ? -1 : 1;
    });
  }
  res.json({ run, rows });
});

// POST /audits/invoice/from-history — ERP-pending audit fed by FreightPOP's
// Transactions "History Report" (pulled by the hosted browser), not a carrier
// bill. Body:
//   { run: { date_from, date_to, run_by, total_report_rows }, rows: object[],
//     ai_level?: "off" | "summary" | "full", audit_id?: string, final?: boolean }
// Without audit_id a new run is created. With audit_id the rows are appended
// to that run and its counts updated, so a big report can be sent in chunks.
// Rows already exported to ERP are dropped here even if the sender filtered.
// Responds { audit_id, total, pending }: rows stored for the run so far (all of
// them are pending, i.e. not exported).
auditsRouter.post("/invoice/from-history", async (req, res) => {
  const { run: runIn, rows: rawRows, ai_level, audit_id, final } = req.body || {};
  if (rawRows !== undefined && rawRows !== null && !Array.isArray(rawRows)) {
    return res.status(400).json({ error: "body.rows must be an array" });
  }
  const appending = audit_id !== undefined && audit_id !== null && audit_id !== "";

  let run;
  let stored = 0; // rows already saved for this run; ranks continue from here
  if (appending) {
    const { data: existing, error } = await supabase
      .from("fpx_invoice_audits").select("*").eq("id", String(audit_id)).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!existing) return res.status(404).json({ error: "Invoice audit not found" });
    if (existing.shipment_type !== "erp_pending") {
      return res.status(400).json({ error: "That audit is not an ERP-pending run" });
    }
    const { count, error: countErr } = await supabase
      .from("fpx_invoice_audit_rows").select("id", { count: "exact", head: true }).eq("audit_id", existing.id);
    if (countErr) return res.status(500).json({ error: countErr.message });
    run = existing;
    stored = count || 0;
  } else {
    const { data: created, error } = await supabase.from("fpx_invoice_audits").insert({
      run_by: runIn?.run_by || req.user?.email || req.apiKey?.name || null,
      date_from: runIn?.date_from || null,
      date_to: runIn?.date_to || null,
      shipment_type: "erp_pending",
      carrier_bill_file: "FreightPOP History Report",
      total_rows: 0,
      match_count: 0,
      discrepancy_count: 0,
      unmatched_count: 0,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    run = created;
  }

  // Each call sorts its own rows by charge and ranks them after the rows
  // already stored, so with several chunks the order is "chunk, then rank
  // within the chunk" — not a global sort. Send the report in one call (or
  // pre-sorted chunks) for a true biggest-first order. The read route orders
  // by created_at, id and then re-sorts ERP-pending runs by raw.rank.
  const { rows: audited } = auditHistoryRows(rawRows || [], { rankOffset: stored });

  const counts = {
    total_rows: (appending ? run.total_rows : 0) || 0,
    match_count: (appending ? run.match_count : 0) || 0,
    discrepancy_count: (appending ? run.discrepancy_count : 0) || 0,
    unmatched_count: (appending ? run.unmatched_count : 0) || 0, // rows with no invoice
  };
  const CHUNK = 500;
  let insertError = null;
  for (let i = 0; i < audited.length; i += CHUNK) {
    const chunk = audited.slice(i, i + CHUNK);
    const { error: rowErr } = await supabase
      .from("fpx_invoice_audit_rows").insert(chunk.map((r) => ({ ...r, audit_id: run.id })));
    if (rowErr) { insertError = rowErr; break; }
    stored += chunk.length;
    for (const r of chunk) {
      counts.total_rows += 1;
      if (r.status === "match") counts.match_count += 1;
      else if (r.status === "discrepancy") counts.discrepancy_count += 1;
      else counts.unmatched_count += 1;
    }
  }
  // Keep the run's counts true to what was actually saved, even on a failure.
  if (audited.length) {
    const { error: updErr } = await supabase.from("fpx_invoice_audits").update(counts).eq("id", run.id);
    if (updErr && !insertError) return res.status(500).json({ error: updErr.message, audit_id: run.id });
  }
  if (insertError) return res.status(500).json({ error: insertError.message, audit_id: run.id, total: stored });

  // Same background AI kick-off as POST /invoice. A chunked sender skips it
  // until the last chunk: appends only analyze with final: true, and a first
  // call can hold off by sending final: false.
  const level = ai_level === "full" ? "full" : ai_level === "off" ? "off" : "summary";
  const lastCall = appending ? final === true : final !== false;
  if (level !== "off" && lastCall) {
    void analyzeInvoiceAuditRun(run.id, { reqContext: req, level })
      .catch((e) => console.warn("[FPX] history-audit auto-analyze failed:", e.message));
  }
  // How many of this call's rows each key column could be read from, so the
  // puller can warn when FreightPOP's column titles don't match.
  const fields = {
    rows: audited.length,
    shipment_id: audited.filter((r) => r.shipment_id).length,
    charge: audited.filter((r) => r.raw?.charge != null).length,
    cost: audited.filter((r) => r.shipment_cost != null).length,
    invoice: audited.filter((r) => r.bill_amount != null).length,
  };
  res.json({ audit_id: run.id, total: stored, pending: stored, fields });
});

auditsRouter.post("/invoice", async (req, res) => {
  const { run, rows, ai_level } = req.body || {};
  if (!run) return res.status(400).json({ error: "body.run required" });
  const { data: created, error } = await supabase.from("fpx_invoice_audits").insert(run).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (Array.isArray(rows) && rows.length) {
    const payload = rows.map((r) => ({ ...r, audit_id: created.id }));
    const { error: rowErr } = await supabase.from("fpx_invoice_audit_rows").insert(payload);
    if (rowErr) return res.status(500).json({ error: rowErr.message });
  }
  const level = ai_level === "full" ? "full" : ai_level === "off" ? "off" : "summary";
  if (level !== "off") {
    void analyzeInvoiceAuditRun(created.id, { reqContext: req, level })
      .catch((e) => console.warn("[FPX] invoice auto-analyze failed:", e.message));
  }
  res.json({ run: created, row_count: (rows || []).length });
});

// POST /audits/invoice/:id/reanalyze — manual trigger from the dashboard.
auditsRouter.post("/invoice/:id/reanalyze", async (req, res) => {
  const level = req.body?.level === "full" ? "full" : "summary";
  const updated = await analyzeInvoiceAuditRun(req.params.id, { reqContext: req, level });
  if (!updated) return res.status(404).json({ error: "Invoice audit not found" });
  res.json({ run: updated });
});
