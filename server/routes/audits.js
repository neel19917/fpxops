import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { analyzeGpAuditRun, analyzeInvoiceAuditRun } from "./analyze.js";
import { auditHistoryRows } from "../lib/historyAudit.js";
import { MAX_GET_INVOICE_IDS, isUuid, normalizeResult, mergeResult, updateRowsRaw } from "../lib/getInvoice.js";
import {
  approvalColumnNames, findApprovalColumns, matchApprovals, mergeApproval, summarizeApprovals,
  normalizeApprovalSource,
} from "../lib/approvalMatch.js";
import { transactionRows, upsertTransactions, approvalRows, upsertApprovals } from "../lib/erpStore.js";

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

// Every row of an audit. Pages through them (Supabase caps a single read at
// 1000) in a fixed order so pages never overlap; ERP-pending runs can hold
// thousands of rows. Returns { rows, error }.
async function loadAuditRows(auditId, columns = "*") {
  const PAGE = 1000;
  const MAX_ROWS = 10000;
  const rows = [];
  let byCreated = true; // falls back to id-only if the table has no created_at
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const page = () => {
      let q = supabase.from("fpx_invoice_audit_rows").select(columns).eq("audit_id", auditId);
      if (byCreated) q = q.order("created_at", { ascending: true });
      return q.order("id", { ascending: true }).range(from, from + PAGE - 1);
    };
    let { data, error: rowErr } = await page();
    if (rowErr && byCreated && from === 0) {
      byCreated = false;
      ({ data, error: rowErr } = await page());
    }
    if (rowErr) return { rows, error: rowErr.message };
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { rows, error: null };
}

// The Excel files the hosted browser keeps for an ERP pull, in the private
// Storage bucket "erp-pulls" at <audit_id>/<file>.
const ERP_BUCKET = "erp-pulls";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXCEL_FILES = {
  "not-exported": { object: "not-exported.xlsx", key: "not_exported", label: "TransactionsData-not-exported" },
  full: { object: "full.xlsx", key: "full", label: "TransactionsData-full" },
  "recently-approved": { object: "recently-approved.xlsx", key: "recently_approved", label: "RecentlyApproved" },
  "audit-history": { object: "audit-history.xlsx", key: "audit_history", label: "AuditHistory" },
};

// Which of a pull's Excel files exist:
// { not_exported, full, recently_approved, audit_history }.
// Never throws. `ok` is false when Storage could not be read (all false then).
async function listPullFiles(auditId) {
  const files = Object.fromEntries(Object.values(EXCEL_FILES).map((f) => [f.key, false]));
  try {
    const { data, error } = await supabase.storage.from(ERP_BUCKET).list(String(auditId), { limit: 100 });
    if (error) return { files, ok: false };
    const names = new Set((data || []).map((o) => o?.name));
    for (const f of Object.values(EXCEL_FILES)) files[f.key] = names.has(f.object);
    return { files, ok: true };
  } catch {
    return { files, ok: false };
  }
}

// GET /audits/invoice/:id → { run, rows }. For an ERP pull also:
//   files: { not_exported, full, recently_approved, audit_history }  which Excel
//     files can be downloaded from /audits/invoice/:id/excel (all false if
//     Storage can't be read)
//   approval_summary: { checked_at, matched, not_found, by_edi, by_unknown,
//     by_person: { name: count }, by_source: { recently_approved, history } }
//     read from the rows' raw.approval, or null when no approval check has run.
auditsRouter.get("/invoice/:id", async (req, res) => {
  const { data: run, error } = await supabase.from("fpx_invoice_audits").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "Invoice audit not found" });
  const isErpPull = run.shipment_type === "erp_pending";
  const [loaded, listed] = await Promise.all([
    loadAuditRows(run.id),
    isErpPull ? listPullFiles(run.id) : null,
  ]);
  if (loaded.error) return res.status(500).json({ error: loaded.error });
  const rows = loaded.rows;
  // Rows go out whole (select *), so raw.get_invoice — the state of a "get
  // invoices" run for that shipment — and raw.approval reach the dashboard as
  // stored. ERP-pending rows are ranked by charge (biggest first) when they
  // are stored; the charge lives in jsonb, so put them back in that order here.
  if (isErpPull) {
    const rank = (r) => (Number.isFinite(Number(r.raw?.rank)) && r.raw?.rank !== null ? Number(r.raw.rank) : Infinity);
    rows.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra === rb ? 0 : ra < rb ? -1 : 1;
    });
    return res.json({ run, rows, files: listed.files, approval_summary: summarizeApprovals(rows) });
  }
  res.json({ run, rows });
});

// GET /audits/invoice/:id/excel?which=not-exported|full|recently-approved|audit-history
// Sends one of the pull's Excel files as a download (default not-exported).
// audit-history is <audit_id>/audit-history.xlsx, sent as
// AuditHistory-<from>_to_<to>.xlsx (the pull's own dates).
// 400 for an unknown `which`; 404 { error: "No Excel file was saved for this
// pull" } when it isn't in Storage; 502 when Storage can't be read.
auditsRouter.get("/invoice/:id/excel", async (req, res) => {
  const which = req.query.which === undefined || req.query.which === "" ? "not-exported" : String(req.query.which);
  const file = Object.hasOwn(EXCEL_FILES, which) ? EXCEL_FILES[which] : null;
  if (!file) return res.status(400).json({ error: "which must be not-exported, full, recently-approved or audit-history" });
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Invoice audit not found" });
  const { data: run, error } = await supabase
    .from("fpx_invoice_audits").select("id, shipment_type, date_from, date_to").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "Invoice audit not found" });
  const missing = () => res.status(404).json({ error: "No Excel file was saved for this pull" });
  if (run.shipment_type !== "erp_pending") return missing();

  let blob = null;
  try {
    const { data, error: dlErr } = await supabase.storage.from(ERP_BUCKET).download(`${run.id}/${file.object}`);
    if (!dlErr) blob = data;
  } catch { /* handled below */ }
  if (!blob) {
    // A missing object and a Storage outage both come back as an error, so
    // look in the folder to tell them apart.
    const listed = await listPullFiles(run.id);
    if (listed.ok && !listed.files[file.key]) return missing();
    return res.status(502).json({ error: "Could not read the Excel file from storage. Try again." });
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  const day = (v) => String(v || "").slice(0, 10).replace(/[^0-9A-Za-z-]/g, "");
  const range = day(run.date_from) && day(run.date_to) ? `-${day(run.date_from)}_to_${day(run.date_to)}` : "";
  res.set({
    "Content-Type": XLSX_TYPE,
    "Content-Disposition": `attachment; filename="${file.label}${range}.xlsx"`,
    "Content-Length": String(bytes.length),
    "Cache-Control": "private, no-store",
  });
  res.send(bytes);
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

// POST /audits/invoice/:id/get-invoice-results — the hosted browser reports
// what happened when it clicked GET INVOICE for shipments of an ERP pull.
// Body: { by, results: [{ shipment_id, ok, note, at }] }, up to 200 results.
// Each result is folded into raw.get_invoice of the matching row(s):
//   { status: ok ? "done" : "failed", note, at, by } plus the requested_at /
//   requested_by / request_id written when the run was queued.
// No other column, and no other key of raw, is written. Shipment ids that are
// not in the audit are counted, not refused.
// Responds { updated, unknown, failed }: shipments saved, shipments not in
// this audit, shipments whose save failed (send those again).
auditsRouter.post("/invoice/:id/get-invoice-results", async (req, res) => {
  const results = req.body?.results;
  if (!Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: "body.results must be a list with at least one result" });
  }
  if (results.length > MAX_GET_INVOICE_IDS) {
    return res.status(400).json({ error: `Send up to ${MAX_GET_INVOICE_IDS} results at a time` });
  }
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Invoice audit not found" });
  const { data: run, error } = await supabase
    .from("fpx_invoice_audits").select("id, shipment_type").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "Invoice audit not found" });
  if (run.shipment_type !== "erp_pending") {
    return res.status(400).json({ error: "That audit is not an ERP pull" });
  }

  const by = String(req.body?.by || req.apiKey?.name || req.user?.email || "").trim() || null;
  const now = new Date().toISOString();
  // One result per shipment; if a shipment is sent twice the later one wins.
  const byShipment = new Map();
  let unknown = 0;
  for (const entry of results) {
    const r = normalizeResult(entry, { by, now });
    if (!r) { unknown += 1; continue; } // no shipment id to match
    byShipment.set(r.shipment_id, r);
  }

  const failedShipments = new Set();
  const out = await updateRowsRaw(supabase, run.id, [...byShipment.keys()], (raw, row) => {
    const r = byShipment.get(String(row.shipment_id ?? "").trim());
    return r ? mergeResult(raw, r) : null;
  }, (row) => failedShipments.add(String(row.shipment_id ?? "").trim()));
  if (out.error) return res.status(500).json({ error: out.error });

  let updated = 0;
  for (const id of byShipment.keys()) {
    if (!out.matched.has(id)) unknown += 1;
    else if (!failedShipments.has(id)) updated += 1;
  }
  if (failedShipments.size) console.warn(`[FPX] get-invoice results for ${run.id}: ${failedShipments.size} shipment(s) not saved`);
  res.json({ updated, unknown, failed: failedShipments.size });
});

// POST /audits/invoice/:id/approval-results — the hosted browser posts the rows
// of an Excel export of FreightPOP's Audit page, and they are matched to the
// shipments of an ERP pull.
// Body: { by, columns: string[], rows: object[] (keyed by column), part?, final?,
//         source?: "recently_approved" (default) | "history" }
// A big export can be sent in parts: every part but the last sends
// final: false, the last sends final: true. A call without `part` is taken as
// the whole export unless it says final: false. `part` itself is not read.
// Each row of the audit gets raw.approval (see lib/approvalMatch.js); no other
// column, and no other key of raw, is written.
// source "recently_approved" (the "Recently Approved" tab): shipments not in
// the export are marked not_found only on the last part, and an approval
// already stored is never taken away.
// source "history" (the "History" tab, sent after Recently Approved is done):
// rows that are not approvals are left out first (see `dropped`); it only adds
// approvals — never writes not_found, and for a shipment Recently Approved
// already approved it only fills in blank fields. `final` changes nothing.
// 400 for an unknown source. 422 { error, columns } when the export has
// neither a shipment nor a tracking number column.
// The approvals of the call are also kept in fpx_audit_approvals (one row per
// tracking number + invoice number, both sources; History rows that are not
// approvals are left out). That can never fail the call: the response carries
// stored_approvals: { upserted, failed }.
// Responds { source, matched, not_found, approved_rows, by_edi, by_unknown,
// by_person, by_source, newly_matched, dropped: { not_approved,
// no_approval_info }, columns_used, failed, final }: matched … by_source
// describe the audit's rows as they now stand (everything sent so far),
// approved_rows is the rows in this call, newly_matched is the audit rows this
// call took from no approval / not_found to approved, dropped is the rows of
// this call left out (always 0 for recently_approved), columns_used.status is
// the status column the filter used (else null), failed is rows whose save
// failed (send the call again).
auditsRouter.post("/invoice/:id/approval-results", async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.rows)) return res.status(400).json({ error: "body.rows must be a list" });
  if (body.columns !== undefined && body.columns !== null && !Array.isArray(body.columns)) {
    return res.status(400).json({ error: "body.columns must be a list" });
  }
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Invoice audit not found" });
  const { data: run, error } = await supabase
    .from("fpx_invoice_audits").select("id, shipment_type").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!run) return res.status(404).json({ error: "Invoice audit not found" });
  if (run.shipment_type !== "erp_pending") {
    return res.status(400).json({ error: "That audit is not an ERP pull" });
  }

  const source = normalizeApprovalSource(body.source);
  if (!source) return res.status(400).json({ error: "body.source must be recently_approved or history" });
  const columns = approvalColumnNames(body.columns, body.rows);
  const found = findApprovalColumns(columns, { source });
  if (!found.shipment && !found.tracking) {
    const tab = source === "history" ? "History" : "Recently Approved";
    return res.status(422).json({ error: `Could not find a shipment or tracking number column in the ${tab} export`, columns });
  }

  const loaded = await loadAuditRows(run.id, "id, shipment_id, raw");
  if (loaded.error) return res.status(500).json({ error: loaded.error });
  const auditRows = loaded.rows;

  const hasPart = body.part !== undefined && body.part !== null && body.part !== "";
  const final = hasPart ? body.final === true : body.final !== false;
  const checked_by = String(body.by || req.apiKey?.name || req.user?.email || "").trim() || null;
  const checked_at = new Date().toISOString();
  const { results, dropped, columns_used: columnsUsed } = matchApprovals(auditRows, body.rows, columns, { source });

  // Rows as they stand after this call, for the numbers in the response. A row
  // whose save fails keeps what it had.
  const after = auditRows.slice();
  const changes = [];
  auditRows.forEach((row, i) => {
    const next = mergeApproval(row.raw, results[i], { checked_at, checked_by, final, source });
    if (!next) return;
    const isNew = row.raw?.approval?.status !== "approved" && next.approval?.status === "approved";
    changes.push({ i, id: row.id, raw: next, isNew });
  });
  let failed = 0;
  let newlyMatched = 0;
  const WRITE_CHUNK = 20;
  for (let i = 0; i < changes.length; i += WRITE_CHUNK) {
    await Promise.all(changes.slice(i, i + WRITE_CHUNK).map(async (c) => {
      let failedWrite = false;
      try {
        const { error: wErr } = await supabase.from("fpx_invoice_audit_rows").update({ raw: c.raw }).eq("id", c.id);
        failedWrite = !!wErr;
      } catch {
        failedWrite = true;
      }
      if (failedWrite) failed += 1;
      else {
        after[c.i] = { ...auditRows[c.i], raw: c.raw };
        if (c.isNew) newlyMatched += 1;
      }
    }));
  }
  if (failed) console.warn(`[FPX] approval results for ${run.id}: ${failed} row(s) not saved`);

  // Keep the approvals themselves, whether or not they matched a row of this
  // pull. Waited for, but a failure here never fails the call.
  const storedApprovals = { upserted: 0, failed: 0 };
  try {
    const mapped = approvalRows(body.rows, columns, { source, seenAt: checked_at });
    const out = await upsertApprovals(supabase, mapped.rows);
    storedApprovals.upserted = out.upserted;
    storedApprovals.failed = out.failed;
  } catch (e) {
    console.warn(`[FPX] approval results for ${run.id}: approvals not stored: ${e?.message || e}`);
  }

  const now = summarizeApprovals(after)
    || { matched: 0, not_found: 0, by_edi: 0, by_unknown: 0, by_person: {}, by_source: { recently_approved: 0, history: 0 } };
  res.json({
    source,
    matched: now.matched,
    not_found: now.not_found,
    approved_rows: body.rows.length,
    by_edi: now.by_edi,
    by_unknown: now.by_unknown,
    by_person: now.by_person,
    by_source: now.by_source,
    newly_matched: newlyMatched,
    dropped,
    columns_used: columnsUsed,
    failed,
    final,
    stored_approvals: storedApprovals,
  });
});

// ---------- ERP data kept in Supabase ----------
// fpx_erp_transactions (every shipment of the History Report), fpx_audit_approvals
// (every approved carrier invoice) and the view fpx_erp_invoicing that matches
// them by tracking number. See lib/erpStore.js.

// POST /audits/erp/transactions — the hosted browser posts ALL rows of the
// Transactions History Report (exported to ERP or not), keyed by FreightPOP's
// column titles. Each shipment is inserted or brought up to date.
// Body: { audit_id?: uuid, shipment_type?: string, rows: object[], part?, final? }
// A big report can be sent in several calls; `part` and `final` are not read.
// Responds { received, stored, skipped_no_id, failed } (+ error when failed):
// rows in the call, shipments saved (several rows for one shipment count
// once), rows without a shipment id, shipments whose save failed (send the
// call again). Always 200 once the body is valid.
auditsRouter.post("/erp/transactions", async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.rows)) return res.status(400).json({ error: "body.rows must be a list" });
  const hasAudit = body.audit_id !== undefined && body.audit_id !== null && body.audit_id !== "";
  if (hasAudit && !isUuid(body.audit_id)) return res.status(400).json({ error: "body.audit_id must be an audit id" });
  const shipmentType = typeof body.shipment_type === "string" ? body.shipment_type.trim().slice(0, 40) : "";
  const mapped = transactionRows(body.rows, {
    auditId: hasAudit ? body.audit_id : undefined,
    shipmentType: shipmentType || undefined,
    seenAt: new Date().toISOString(),
  });
  let out = { upserted: 0, failed: mapped.rows.length };
  try {
    out = await upsertTransactions(supabase, mapped.rows);
  } catch (e) {
    out.error = e?.message || String(e);
  }
  res.json({
    received: mapped.received,
    stored: out.upserted,
    skipped_no_id: mapped.skipped_no_id,
    failed: out.failed,
    ...(out.error ? { error: out.error } : {}),
  });
});

const ERP_BUCKETS = ["exported", "approved_ready", "invoice_not_approved", "no_invoice"];
const APPROVER_KINDS = ["edi", "person", "unknown"];

// The `q` and `approved_by_kind` filters of the invoicing list, on a query of
// the fpx_erp_invoicing view.
function erpInvoicingFilters(query, { q, kind }) {
  let out = query;
  if (kind) out = out.eq("approved_by_kind", kind);
  if (q) {
    const like = `"%${q}%"`;
    out = out.or(["shipment_id", "tracking_number", "customer_name", "carrier"].map((c) => `${c}.ilike.${like}`).join(","));
  }
  return out;
}

// GET /audits/erp/invoicing?bucket=&approved_by_kind=&q=&limit=&offset=
// Each shipment with its latest approval (the fpx_erp_invoicing view), biggest
// charge first.
//   bucket            exported | approved_ready | invoice_not_approved | no_invoice
//   approved_by_kind  edi | person | unknown
//   q                 part of a shipment id, tracking number, customer or carrier
//   limit             default 200, at most 1000;  offset  default 0
// Responds { data, counts: { exported, approved_ready, invoice_not_approved,
// no_invoice }, totals: { all, matching }, limit, offset }. counts are per
// bucket with `q` and `approved_by_kind` applied (not `bucket`); a count that
// could not be read is null. totals.all is their sum, totals.matching the rows
// the whole filter matches (for paging).
auditsRouter.get("/erp/invoicing", async (req, res) => {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const bucket = String(one(req.query.bucket) ?? "").trim();
  if (bucket && !ERP_BUCKETS.includes(bucket)) {
    return res.status(400).json({ error: `bucket must be one of ${ERP_BUCKETS.join(", ")}` });
  }
  const kind = String(one(req.query.approved_by_kind) ?? "").trim().toLowerCase();
  if (kind && !APPROVER_KINDS.includes(kind)) {
    return res.status(400).json({ error: `approved_by_kind must be one of ${APPROVER_KINDS.join(", ")}` });
  }
  // Quotes and backslashes would break out of the quoted filter value.
  const q = String(one(req.query.q) ?? "").replace(/["\\]/g, "").trim().slice(0, 100);
  const int = (v, fallback) => {
    const n = Number.parseInt(String(one(v) ?? ""), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const limit = Math.min(1000, Math.max(1, int(req.query.limit, 200)));
  const offset = Math.max(0, int(req.query.offset, 0));

  let list = erpInvoicingFilters(supabase.from("fpx_erp_invoicing").select("*"), { q, kind });
  if (bucket) list = list.eq("bucket", bucket);
  list = list
    .order("charge", { ascending: false, nullsFirst: false })
    .order("shipment_id", { ascending: true })
    .range(offset, offset + limit - 1);
  const countOf = async (b) => {
    try {
      const { count, error } = await erpInvoicingFilters(
        supabase.from("fpx_erp_invoicing").select("shipment_id", { count: "exact", head: true }), { q, kind },
      ).eq("bucket", b);
      return error ? null : count || 0;
    } catch {
      return null;
    }
  };
  const [{ data, error }, ...bucketCounts] = await Promise.all([list, ...ERP_BUCKETS.map(countOf)]);
  if (error) return res.status(500).json({ error: error.message });
  const counts = Object.fromEntries(ERP_BUCKETS.map((b, i) => [b, bucketCounts[i]]));
  const known = bucketCounts.every((c) => c !== null);
  const all = known ? bucketCounts.reduce((a, c) => a + c, 0) : null;
  res.json({
    data: data || [],
    counts,
    totals: { all, matching: bucket ? counts[bucket] : all },
    limit,
    offset,
  });
});

// GET /audits/erp/summary → how much is stored and how fresh it is:
// { transactions: { rows, last_seen_at }, approvals: { rows, last_seen_at } }.
auditsRouter.get("/erp/summary", async (_req, res) => {
  const about = async (table, key) => {
    const [counted, latest] = await Promise.all([
      supabase.from(table).select(key, { count: "exact", head: true }),
      supabase.from(table).select("last_seen_at").order("last_seen_at", { ascending: false }).limit(1),
    ]);
    if (counted.error || latest.error) throw new Error((counted.error || latest.error).message);
    return { rows: counted.count || 0, last_seen_at: latest.data?.[0]?.last_seen_at ?? null };
  };
  try {
    const [transactions, approvals] = await Promise.all([
      about("fpx_erp_transactions", "shipment_id"),
      about("fpx_audit_approvals", "approval_key"),
    ]);
    res.json({ transactions, approvals });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
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
