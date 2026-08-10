import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";

export const opsRouter = Router();

// ---------- Rescrape command channel ----------
// Scraping is push-only (the Chrome extension scrapes FreightPOP and POSTs to
// /api/shipments). The server can't pull on demand, so the dashboard enqueues
// a request here and the extension polls + fulfills it on its next cycle.
// All routes are under the dual-auth /api router, so the extension authenticates
// with its x-api-key just like it does for POST /api/shipments.

// POST /ops/rescrape  { scope?: "all" | "selected", tracking_numbers?: string[] }
// Operator clicks "Rescrape". Coalesces an existing pending full rescrape so we
// don't stack duplicates the extension would run twice.
opsRouter.post("/rescrape", async (req, res) => {
  const scope = req.body?.scope === "selected" ? "selected" : "all";
  const tns = Array.isArray(req.body?.tracking_numbers)
    ? req.body.tracking_numbers.map(String).filter(Boolean)
    : null;
  if (scope === "selected" && (!tns || !tns.length)) {
    return res.status(400).json({ error: "selected scope requires tracking_numbers" });
  }
  if (scope === "all") {
    const { data: existing } = await supabase
      .from("fpx_scrape_requests")
      .select("*").eq("status", "pending").eq("scope", "all")
      .order("requested_at", { ascending: false }).limit(1);
    if (existing?.[0]) return res.json({ request: existing[0], coalesced: true });
  }
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .insert({
      scope,
      tracking_numbers: tns,
      requested_by: req.user?.email || req.apiKey?.name || null,
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "rescrape_request",
    entity_type: "scrape_request",
    entity_id: data.id,
    summary: `Requested ${scope} rescrape`,
    metadata: { scope, count: tns?.length || null },
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

// GET /ops/rescrape/pending?claim=1&by=<name> — extension poll. With claim=1 it
// atomically flips the oldest pending request to 'claimed' (guarded on
// status='pending' so two pollers can't grab the same one).
opsRouter.get("/rescrape/pending", async (req, res) => {
  const claim = req.query.claim === "1" || req.query.claim === "true";
  const by = req.query.by ? String(req.query.by) : (req.apiKey?.name || null);
  const { data: rows, error } = await supabase
    .from("fpx_scrape_requests")
    .select("*").eq("status", "pending")
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

// POST /ops/rescrape/:id/complete  { result_count?, note?, error? } — extension
// reports back after fulfilling (or failing) a request.
opsRouter.post("/rescrape/:id/complete", async (req, res) => {
  const result_count = Number.isFinite(Number(req.body?.result_count)) ? Number(req.body.result_count) : null;
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  const status = req.body?.error ? "error" : "done";
  const { data, error } = await supabase
    .from("fpx_scrape_requests")
    .update({ status, completed_at: new Date().toISOString(), result_count, note })
    .eq("id", req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "request not found" });
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
