import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";
import {
  GET_INVOICE_SCOPE, isUuid, normalizeShipmentIds, missingShipmentIds,
  buildGetInvoiceNote, parseGetInvoiceNote, markRequested, resetRequested, updateRowsRaw,
} from "../lib/getInvoice.js";
import { APPROVAL_CHECK_SCOPE } from "../lib/approvalMatch.js";

export const opsRouter = Router();

// ---------- Rescrape command channel ----------
// Scraping is push-only (the Chrome extension scrapes FreightPOP and POSTs to
// /api/shipments). The server can't pull on demand, so the dashboard enqueues
// a request here and the extension polls + fulfills it on its next cycle.
// All routes are under the dual-auth /api router, so the extension authenticates
// with its x-api-key just like it does for POST /api/shipments.

// POST /ops/rescrape  { scope?: "all" | "selected" | "erp_audit", tracking_numbers?: string[], modes?: ("LTL"|"Truckload"|"Parcel")[], months?: 1-12 }
// Operator clicks "Rescrape". Coalesces an existing pending full rescrape so we
// don't stack duplicates the extension would run twice.
// scope "erp_audit" is not a shipment scrape: it asks the hosted browser to
// pull the Transactions History Report for the last `months` months (default
// 3) and post it to /audits/invoice/from-history. The window travels in
// note as "months=N" (the complete route later replaces note with the result).
//
// scope "get_invoice" is not a scrape either: { audit_id, shipment_ids,
// pause_after_first? } asks the hosted browser to click FreightPOP's GET
// INVOICE button for shipments a person ticked in an ERP pull. The ids travel
// in tracking_numbers and the rest in note as
// "audit=<uuid>;from=<date_from>;to=<date_to>;pause_first=<1|0>". Only one
// such run may be queued or running at a time (409 otherwise).
//
// scope "approval_check": { audit_id } asks the hosted browser to take the
// Excel export of FreightPOP's Audit → "Recently Approved" and post it to
// /audits/invoice/<audit_id>/approval-results, which says for each shipment of
// that ERP pull whether its invoice was approved and by whom. The audit
// travels in note as "audit=<uuid>". One at a time (409 otherwise).
const SCOPES = ["all", "selected", "erp_audit", GET_INVOICE_SCOPE, APPROVAL_CHECK_SCOPE];
// Only the hosted browser knows how to run an ERP audit pull, a get-invoice
// run or an approval check. Any other claimer would treat the row as a full rescrape, so it is
// never handed one.
const HOSTED_WORKER = "fpx-browser";
const HOSTED_ONLY_SCOPES = ["erp_audit", GET_INVOICE_SCOPE, APPROVAL_CHECK_SCOPE];

// Puts the rows of a get-invoice request that are still waiting ("requested")
// back to "not_started". Rows that already have a result are left alone.
// `request` must carry the original note (it names the audit). Never throws.
async function resetGetInvoiceRows(request, note) {
  try {
    const job = parseGetInvoiceNote(request?.note);
    const ids = Array.isArray(request?.tracking_numbers) ? request.tracking_numbers.map(String) : [];
    if (!job || !ids.length) return;
    const out = await updateRowsRaw(supabase, job.audit_id, ids,
      (raw) => resetRequested(raw, { request_id: request.id, note }));
    if (out.error || out.failed) {
      console.warn(`[FPX] get_invoice ${request.id}: could not reset rows (${out.error || `${out.failed} failed`})`);
    }
  } catch (e) {
    console.warn(`[FPX] get_invoice ${request?.id}: could not reset rows (${e.message})`);
  }
}

async function requestGetInvoice(req, res) {
  const auditId = String(req.body?.audit_id || "").trim();
  if (!auditId) return res.status(400).json({ error: "audit_id required" });
  const picked = normalizeShipmentIds(req.body?.shipment_ids);
  if (picked.error) return res.status(400).json({ error: picked.error });
  const ids = picked.ids;
  const pauseFirst = req.body?.pause_after_first !== false; // on unless switched off

  if (!isUuid(auditId)) return res.status(404).json({ error: "Invoice audit not found" });
  const { data: audit, error: aErr } = await supabase
    .from("fpx_invoice_audits").select("id, shipment_type, date_from, date_to").eq("id", auditId).maybeSingle();
  if (aErr) return res.status(500).json({ error: aErr.message });
  if (!audit) return res.status(404).json({ error: "Invoice audit not found" });
  if (audit.shipment_type !== "erp_pending") {
    return res.status(400).json({ error: "That audit is not an ERP pull" });
  }
  if (!audit.date_from || !audit.date_to) {
    return res.status(400).json({ error: "That ERP pull has no date range, so its shipments can't be looked up. Run a new pull." });
  }

  const found = await updateRowsRaw(supabase, audit.id, ids, null);
  if (found.error) return res.status(500).json({ error: found.error });
  const missing = missingShipmentIds(ids, found.rows);
  if (missing.length) {
    const shown = missing.slice(0, 5).join(", ");
    const more = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
    return res.status(400).json({
      error: `${missing.length} shipment${missing.length === 1 ? " is" : "s are"} not in this ERP pull: ${shown}${more}`,
    });
  }

  const { data: busy, error: bErr } = await supabase
    .from("fpx_scrape_requests").select("id")
    .eq("scope", GET_INVOICE_SCOPE).in("status", ["pending", "claimed"]).limit(1);
  if (bErr) return res.status(500).json({ error: bErr.message });
  if (busy?.[0]) return res.status(409).json({ error: "An invoice run is already queued or running" });

  const requestedBy = req.user?.email || req.apiKey?.name || null;
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .insert({
      scope: GET_INVOICE_SCOPE,
      tracking_numbers: ids,
      note: buildGetInvoiceNote({ auditId: audit.id, from: audit.date_from, to: audit.date_to, pauseFirst }),
      requested_by: requestedBy,
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "rescrape_request",
    entity_type: "scrape_request",
    entity_id: data.id,
    summary: `Requested Get Invoice for ${ids.length} shipment(s)`,
    metadata: { scope: GET_INVOICE_SCOPE, audit_id: audit.id, count: ids.length, shipment_ids: ids, pause_after_first: pauseFirst },
  });

  // Show the chosen rows as requested. The request is already queued, so a
  // failure here is only logged.
  try {
    const stamp = { requested_at: data.requested_at || new Date().toISOString(), requested_by: requestedBy, request_id: data.id };
    const marked = await updateRowsRaw(supabase, audit.id, ids, (raw) => markRequested(raw, stamp));
    if (marked.error || marked.failed) {
      console.warn(`[FPX] get_invoice ${data.id}: could not mark rows requested (${marked.error || `${marked.failed} failed`})`);
    }
  } catch (e) {
    console.warn(`[FPX] get_invoice ${data.id}: could not mark rows requested (${e.message})`);
  }
  return res.json({ request: data });
}

async function requestApprovalCheck(req, res) {
  const auditId = String(req.body?.audit_id || "").trim();
  if (!auditId) return res.status(400).json({ error: "audit_id required" });
  if (!isUuid(auditId)) return res.status(404).json({ error: "Invoice audit not found" });
  const { data: audit, error: aErr } = await supabase
    .from("fpx_invoice_audits").select("id, shipment_type").eq("id", auditId).maybeSingle();
  if (aErr) return res.status(500).json({ error: aErr.message });
  if (!audit) return res.status(404).json({ error: "Invoice audit not found" });
  if (audit.shipment_type !== "erp_pending") {
    return res.status(400).json({ error: "That audit is not an ERP pull" });
  }

  const { data: busy, error: bErr } = await supabase
    .from("fpx_scrape_requests").select("id")
    .eq("scope", APPROVAL_CHECK_SCOPE).in("status", ["pending", "claimed"]).limit(1);
  if (bErr) return res.status(500).json({ error: bErr.message });
  if (busy?.[0]) return res.status(409).json({ error: "An approval check is already queued or running" });

  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .insert({
      scope: APPROVAL_CHECK_SCOPE,
      note: `audit=${audit.id}`,
      requested_by: req.user?.email || req.apiKey?.name || null,
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "rescrape_request",
    entity_type: "scrape_request",
    entity_id: data.id,
    summary: "Requested approval check",
    metadata: { scope: APPROVAL_CHECK_SCOPE, audit_id: audit.id },
  });
  return res.json({ request: data });
}

opsRouter.post("/rescrape", async (req, res) => {
  const scope = SCOPES.includes(req.body?.scope) ? req.body.scope : "all";
  if (scope === GET_INVOICE_SCOPE) return requestGetInvoice(req, res);
  if (scope === APPROVAL_CHECK_SCOPE) return requestApprovalCheck(req, res);
  if (scope === "erp_audit") {
    const rawMonths = req.body?.months;
    const months = rawMonths === undefined || rawMonths === null || rawMonths === "" ? 3 : Number(rawMonths);
    if (!Number.isInteger(months) || months < 1 || months > 12) {
      return res.status(400).json({ error: "months must be a whole number from 1 to 12" });
    }
    const { data: existing } = await supabase
      .from("fpx_scrape_requests")
      .select("*").eq("status", "pending").eq("scope", "erp_audit")
      .order("requested_at", { ascending: false }).limit(1);
    if (existing?.[0]) return res.json({ request: existing[0], coalesced: true });
    const { data, error } = await supabase
      .from("fpx_scrape_requests")
      .insert({
        scope,
        note: `months=${months};type=${["parcel", "both"].includes(req.body?.shipment_type) ? req.body.shipment_type : "non-parcel"}`,
        requested_by: req.user?.email || req.apiKey?.name || null,
      })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    logAudit(req, {
      action: "rescrape_request",
      entity_type: "scrape_request",
      entity_id: data.id,
      summary: `Requested ERP audit pull (last ${months} month${months === 1 ? "" : "s"})`,
      metadata: { scope, months },
    });
    return res.json({ request: data });
  }
  const tns = Array.isArray(req.body?.tracking_numbers)
    ? req.body.tracking_numbers.map(String).filter(Boolean)
    : null;
  if (scope === "selected" && (!tns || !tns.length)) {
    return res.status(400).json({ error: "selected scope requires tracking_numbers" });
  }
  // Optional: only these FreightPOP modes. All three (or none) = every mode.
  const KNOWN = ["LTL", "Truckload", "Parcel"];
  let modes = Array.isArray(req.body?.modes) ? [...new Set(req.body.modes.map(String).filter((m) => KNOWN.includes(m)))] : null;
  if (Array.isArray(req.body?.modes) && !modes.length) return res.status(400).json({ error: "Pick at least one mode" });
  if (modes && modes.length === KNOWN.length) modes = null;
  if (scope === "all") {
    const { data: existing } = await supabase
      .from("fpx_scrape_requests")
      .select("*").eq("status", "pending").eq("scope", "all")
      .order("requested_at", { ascending: false }).limit(5);
    const same = (existing || []).find((r) => JSON.stringify((r.modes || []).slice().sort()) === JSON.stringify((modes || []).slice().sort()));
    if (same) return res.json({ request: same, coalesced: true });
  }
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .insert({
      scope,
      modes,
      tracking_numbers: tns,
      requested_by: req.user?.email || req.apiKey?.name || null,
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "rescrape_request",
    entity_type: "scrape_request",
    entity_id: data.id,
    summary: `Requested ${scope} rescrape${modes ? ` (${modes.join(" + ")})` : ""}`,
    metadata: { scope, modes, count: tns?.length || null },
  });
  res.json({ request: data });
});

// GET /ops/rescrape — recent requests (dashboard reflects pending/done state).
opsRouter.get("/rescrape", async (req, res) => {
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .select("*").order("requested_at", { ascending: false }).limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requests: data || [] });
});

// An ERP pull that the hosted worker can't run (older build) is closed out
// after 2 minutes, so it can't sit "queued" forever and block the Scraping
// page from starting a scrape.
async function expireStaleErpRequests() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await supabase.from("fpx_scrape_requests")
    .update({ status: "error", completed_at: new Date().toISOString(), note: "Not picked up — the hosted browser needs an update before it can run ERP pulls." })
    .eq("status", "pending").eq("scope", "erp_audit").lt("requested_at", cutoff);
}

// Same close-out for get-invoice runs, and their rows go back to
// "not_started" so the person can pick them again.
async function expireStaleGetInvoiceRequests() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const note = "Not picked up — the hosted browser needs an update before it can get invoices.";
  const { data: stale } = await supabase.from("fpx_scrape_requests")
    .select("id, note, tracking_numbers")
    .eq("status", "pending").eq("scope", GET_INVOICE_SCOPE).lt("requested_at", cutoff);
  for (const request of stale || []) {
    // Guarded on pending so a request claimed in the meantime is left alone.
    const { data: closed } = await supabase.from("fpx_scrape_requests")
      .update({ status: "error", completed_at: new Date().toISOString(), note })
      .eq("id", request.id).eq("status", "pending")
      .select("id").maybeSingle();
    if (closed) await resetGetInvoiceRows(request, note);
  }
}

// And for approval checks (nothing to reset on the rows).
async function expireStaleApprovalChecks() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await supabase.from("fpx_scrape_requests")
    .update({ status: "error", completed_at: new Date().toISOString(), note: "Not picked up — the hosted browser needs an update before it can check approvals." })
    .eq("status", "pending").eq("scope", APPROVAL_CHECK_SCOPE).lt("requested_at", cutoff);
}

// GET /ops/rescrape/pending?claim=1&by=<name>&caps=<a,b> — extension poll. With claim=1 it
// atomically flips the oldest pending request to 'claimed' (guarded on
// status='pending' so two pollers can't grab the same one).
//
// Rows come back whole, so the caller sees scope ("all" | "selected" |
// "erp_audit" | "get_invoice" | "approval_check") and, for erp_audit, note
// "months=N". erp_audit, get_invoice and approval_check rows are only handed
// to a claimer named "fpx-browser" (the hosted worker) whose caps list names
// that scope, e.g. caps=erp_audit,get_invoice,approval_check: anyone else
// claiming skips past them to the next shipment rescrape. A get_invoice row
// carries the shipment ids in tracking_numbers and note
// "audit=<uuid>;from=…;to=…;pause_first=<1|0>"; an approval_check row carries
// note "audit=<uuid>".
opsRouter.get("/rescrape/pending", async (req, res) => {
  const claim = req.query.claim === "1" || req.query.claim === "true";
  const by = req.query.by ? String(req.query.by) : (req.apiKey?.name || null);
  let query = supabase
    .from("fpx_scrape_requests")
    .select("*").eq("status", "pending");
  // …and only when it says it knows how (caps=erp_audit). A hosted worker
  // build from before this job existed would run the row as a full rescrape.
  const caps = String(req.query.caps || "").split(",").map((c) => c.trim()).filter(Boolean);
  // A worker polling without the cap can't run ERP pulls: close out any that
  // have waited, so they don't sit "queued" forever. Same for get-invoice runs.
  if (claim && by === HOSTED_WORKER && !caps.includes("erp_audit")) await expireStaleErpRequests();
  if (claim && by === HOSTED_WORKER && !caps.includes(GET_INVOICE_SCOPE)) await expireStaleGetInvoiceRequests();
  if (claim && by === HOSTED_WORKER && !caps.includes(APPROVAL_CHECK_SCOPE)) await expireStaleApprovalChecks();
  if (claim) {
    for (const hostedScope of HOSTED_ONLY_SCOPES) {
      if (by !== HOSTED_WORKER || !caps.includes(hostedScope)) query = query.neq("scope", hostedScope);
    }
  }
  // only=scrape | invoicing: the hosted worker runs shipment scrapes and the
  // invoicing jobs (ERP pull, get invoices, approval check) in two separate
  // sessions, each polling for its own kind.
  const only = String(req.query.only || "");
  if (only === "invoicing") query = query.in("scope", HOSTED_ONLY_SCOPES);
  else if (only === "scrape") query = query.not("scope", "in", `(${HOSTED_ONLY_SCOPES.join(",")})`);
  const { data: rows, error } = await query
    .order("requested_at", { ascending: true }).limit(1);
  if (error) return res.status(500).json({ error: error.message });
  const pending = rows?.[0] || null;
  if (!pending) return res.json({ request: null });
  if (!claim) return res.json({ request: pending });
  const { data: claimed, error: cErr } = await supabase
    .from("fpx_scrape_requests")
    .update({ status: "claimed", claimed_at: new Date().toISOString(), claimed_by: by })
    .eq("id", pending.id).eq("status", "pending")
    .select().maybeSingle();
  if (cErr) return res.status(500).json({ error: cErr.message });
  res.json({ request: claimed || null });
});

// POST /ops/rescrape/release-orphans { by } — the worker calls this when it
// starts: anything it had claimed can't still be running (the process just
// restarted), so close it out instead of leaving it "claimed" forever (the
// Scraping page treats claimed as running and disables Refresh).
opsRouter.post("/rescrape/release-orphans", async (req, res) => {
  const by = String(req.body?.by || req.apiKey?.name || "").trim();
  if (!by) return res.status(400).json({ error: "by required" });
  // Read get-invoice runs first: the update below replaces note, which is
  // what names their audit.
  const { data: invoiceRuns } = await supabase
    .from("fpx_scrape_requests").select("id, note, tracking_numbers")
    .eq("status", "claimed").eq("claimed_by", by).eq("scope", GET_INVOICE_SCOPE);
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .update({ status: "error", completed_at: new Date().toISOString(), note: "Interrupted — the hosted browser restarted mid-run. Re-run if needed." })
    .eq("status", "claimed").eq("claimed_by", by)
    .select("id");
  if (error) return res.status(500).json({ error: error.message });
  const released = new Set((data || []).map((r) => r.id));
  for (const request of invoiceRuns || []) {
    if (released.has(request.id)) {
      await resetGetInvoiceRows(request, "Not run — the hosted browser restarted mid-run. Pick it again to retry.");
    }
  }
  res.json({ released: (data || []).map((r) => r.id) });
});

// POST /ops/rescrape/:id/complete  { result_count?, note?, error? } — extension
// reports back after fulfilling (or failing) a request.
opsRouter.post("/rescrape/:id/complete", async (req, res) => {
  const result_count = Number.isFinite(Number(req.body?.result_count)) ? Number(req.body.result_count) : null;
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  const status = req.body?.error ? "error" : "done";
  // The update replaces note, which for a get-invoice run names its audit, so
  // read that first.
  const { data: before } = await supabase
    .from("fpx_scrape_requests").select("id, scope, note, tracking_numbers")
    .eq("id", req.params.id).maybeSingle();
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .update({ status, completed_at: new Date().toISOString(), result_count, note })
    .eq("id", req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "request not found" });
  // A get-invoice run that ends with shipments it never reported on (it
  // paused after the first, or stopped early) frees those rows to be picked
  // again. Rows with a result are left alone.
  if (before?.scope === GET_INVOICE_SCOPE) {
    await resetGetInvoiceRows(before, status === "error"
      ? "Not run — the invoice run stopped early. Pick it again to retry."
      : "Not run in this pass. Pick it again to continue.");
  }
  res.json({ request: data });
});

// GET /api/ops/metrics?days=30  →  Director-of-Ops rollup.
//
// Three primary signals over the requested window:
//   shipments_analyzed   = fpx_ai_analyses where kind='per_shipment'
//   tasks_completed      = fpx_shipment_tasks where status='done', keyed on completed_at
//   emails_generated     = fpx_ai_analyses where metadata->>'subkind' LIKE 'email_draft_%'
//                          (covers carrier/customer per-shipment + the new
//                          carrier_group consolidations)
//
// Output is structured for a one-screen dashboard: top-line totals,
// daily series for trend lines, plus a per-operator leaderboard
// computed off the assigned_to / user_email fields. Aggregation
// happens in JS — volume is small (analyses + tasks for a 30d window
// fit in a single query each) and Postgres date_trunc gymnastics
// would only complicate the code without a measurable win.
//
// Date bucketing uses UTC ISO yyyy-mm-dd. Day boundaries shift up to
// ~6h vs America/Chicago, but for a directional dashboard this is
// fine and avoids per-tenant timezone settings. Can be revisited if
// directors want strict CT bucketing later.
opsRouter.get("/metrics", async (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  // Anchor `from` at 00:00 UTC so the first bucket is a full day.
  from.setUTCHours(0, 0, 0, 0);
  const fromIso = from.toISOString();

  // All three queries are independent; fan them out in parallel.
  const [
    analysesRes,
    tasksRes,
  ] = await Promise.all([
    supabase
      .from("fpx_ai_analyses")
      // cost_usd + token columns added so we can roll up AI spend on
      // the Ops dashboard. system_prompt / user_message stay out of
      // the select — they're text and we don't need them here.
      .select("id, kind, model, created_at, metadata, cost_usd, input_tokens, output_tokens")
      .gte("created_at", fromIso)
      .limit(20000),
    supabase
      .from("fpx_shipment_tasks")
      .select("id, status, completed_at, created_at, assigned_to, title")
      .gte("created_at", fromIso)
      .limit(10000),
  ]);
  if (analysesRes.error) return res.status(500).json({ error: analysesRes.error.message });
  if (tasksRes.error) return res.status(500).json({ error: tasksRes.error.message });

  // Pre-seed a row per day in [from, to] so the chart never has gaps —
  // a quiet day should render as 0, not be missing entirely.
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const days_list = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    days_list.push(d.toISOString().slice(0, 10));
  }
  const dailyByKey = new Map(days_list.map((k) => [k, {
    date: k,
    shipments_analyzed: 0,
    tasks_completed: 0,
    emails_generated: 0,
    // cost is summed across every analyses row landing in this day's
    // bucket (per-shipment + email drafts + bulk groups). The chart
    // doesn't render this yet — it powers the new "AI cost" KPI.
    cost_usd: 0,
  }]));

  // Email-draft analyses also count as "emails_generated" — but we DO NOT
  // double-count them as "shipments_analyzed" since the per_shipment
  // analyses are what the title implies.
  let totalShipments = 0, totalEmails = 0, totalTasks = 0;
  // Cost rollups: total AI spend in window + breakdown by category so
  // the Ops dashboard can show where the money is going (per-shipment
  // analysis vs single-shipment emails vs bulk group emails).
  const cost = {
    total: 0,
    per_shipment: 0,            // kind = per_shipment
    email_single: 0,            // subkind = email_draft_carrier / customer
    email_group: 0,             // subkind = email_draft_carrier_group / customer_group
    other: 0,                   // anything else (gp/invoice audits, ad-hoc)
  };
  const opEmails = new Map();
  for (const a of analysesRes.data || []) {
    const k = dayKey(a.created_at);
    const bucket = dailyByKey.get(k);
    if (!bucket) continue;
    const c = Number(a.cost_usd) || 0;
    bucket.cost_usd += c;
    cost.total += c;
    if (a.kind === "per_shipment") {
      bucket.shipments_analyzed++;
      totalShipments++;
      cost.per_shipment += c;
      continue;
    }
    const sub = (a.metadata && typeof a.metadata === "object" && a.metadata.subkind) || null;
    if (typeof sub === "string" && sub.startsWith("email_draft_")) {
      bucket.emails_generated++;
      totalEmails++;
      // Group emails are tagged email_draft_carrier_group / _customer_group.
      // Single-shipment drafts are email_draft_carrier / _customer.
      if (sub.endsWith("_group")) cost.email_group += c;
      else cost.email_single += c;
      const operator = (a.metadata && typeof a.metadata === "object" && a.metadata.user_email) || "(automated)";
      opEmails.set(operator, (opEmails.get(operator) || 0) + 1);
      continue;
    }
    cost.other += c;
  }

  const opTasks = new Map();
  for (const t of tasksRes.data || []) {
    if (t.status !== "done") continue;
    const completedAt = t.completed_at || t.created_at;
    const k = dayKey(completedAt);
    const bucket = dailyByKey.get(k);
    if (!bucket) continue;
    bucket.tasks_completed++;
    totalTasks++;
    const op = t.assigned_to || "(unassigned)";
    opTasks.set(op, (opTasks.get(op) || 0) + 1);
  }

  // Merge operator buckets so the leaderboard is one row per
  // operator with both columns populated.
  const opMap = new Map();
  for (const [op, n] of opTasks.entries()) opMap.set(op, { operator: op, tasks_completed: n, emails_generated: 0 });
  for (const [op, n] of opEmails.entries()) {
    const cur = opMap.get(op) || { operator: op, tasks_completed: 0, emails_generated: 0 };
    cur.emails_generated = n;
    opMap.set(op, cur);
  }
  const byOperator = Array.from(opMap.values())
    .sort((a, b) => (b.tasks_completed + b.emails_generated) - (a.tasks_completed + a.emails_generated))
    .slice(0, 25);

  // "Today" rollup = the most recent UTC bucket so the KPI strip
  // matches the right-most bar on the daily chart.
  const todayKey = days_list[days_list.length - 1];
  const today = dailyByKey.get(todayKey) || { shipments_analyzed: 0, tasks_completed: 0, emails_generated: 0, cost_usd: 0 };
  // 7d rollup is the trailing 7 buckets of `daily` (inclusive of today).
  const last7 = days_list.slice(-7);
  let s7 = 0, t7 = 0, e7 = 0, c7 = 0;
  for (const k of last7) {
    const b = dailyByKey.get(k); if (!b) continue;
    s7 += b.shipments_analyzed; t7 += b.tasks_completed; e7 += b.emails_generated; c7 += b.cost_usd;
  }

  res.json({
    range: { from: fromIso, to: to.toISOString(), days },
    totals: {
      shipments_analyzed: totalShipments,
      tasks_completed: totalTasks,
      emails_generated: totalEmails,
      // AI spend over the window. cost.total covers everything in
      // fpx_ai_analyses; the per-category breakdown (per_shipment vs
      // single-shipment emails vs bulk group emails) sits alongside
      // so the dashboard can show where the money goes.
      cost_usd: cost.total,
      cost_breakdown: {
        per_shipment_analysis: cost.per_shipment,
        email_single: cost.email_single,
        email_group: cost.email_group,
        other: cost.other,
      },
    },
    today: {
      date: todayKey,
      shipments_analyzed: today.shipments_analyzed,
      tasks_completed: today.tasks_completed,
      emails_generated: today.emails_generated,
      cost_usd: today.cost_usd || 0,
    },
    last7: { shipments_analyzed: s7, tasks_completed: t7, emails_generated: e7, cost_usd: c7 },
    daily: days_list.map((k) => dailyByKey.get(k)),
    byOperator,
  });
});
