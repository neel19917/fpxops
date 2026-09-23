// Daily executive summary for the Tasks v2 page.
//
// Two halves:
//   1. shapeDigest()  — pure. Turns raw rows (tasks touched in the window,
//      the current board, shipments, analyses, audit log, notes) into a
//      compact, numeric-first "digest": what was created / completed /
//      dismissed, what is live and dangerous right now, who did what, what
//      the scraper and the AI cost, and where the data is unhealthy.
//   2. runDailySummary() — hands the digest to the heavy model and asks for
//      a long-form Markdown brief with fixed sections. The model may only
//      cite facts from the digest; the digest is returned alongside so the
//      page can show the numbers even if the prose is off.
//
// collectDailyDigest() does the supabase reads. Everything else is testable
// without a database.

import { supabase } from "./supabase.js";
import { callClaude } from "./anthropic.js";
import { getSettings } from "./settings.js";
import { loadBoard } from "./taskBoard.js";
import { segmentForTitle, attemptFor } from "./taskSegments.js";

const HOUR = 3_600_000;

function inWindow(iso, fromMs, toMs) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= fromMs && t <= toMs;
}
function shortTitle(title) {
  return String(title || "")
    .replace(/^(carrier|customer) followup:\s*/i, "")
    .replace(/^(redelivery|return\/claim|storage risk) — /i, "")
    .slice(0, 140);
}
function countBy(list, keyFn) {
  const out = {};
  for (const x of list) { const k = keyFn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}
function top(obj, n = 8) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}
function isActive(s) { return s === "open" || s === "in_progress" || s === "blocked"; }

function slimTask(t, ship) {
  const segment = segmentForTitle(t.title);
  return {
    task_id: t.id,
    tracking_number: t.tracking_number || ship?.tracking_number || null,
    customer: ship?.customer_name || null,
    carrier: ship?.carrier_name || ship?.carrier || null,
    segment,
    attempt: attemptFor(t.title, segment),
    assigned_to: t.assigned_to || null,
    priority: t.priority,
    status: t.status,
    title: shortTitle(t.title),
    created_at: t.created_at,
    completed_at: t.completed_at || null,
  };
}

export function shapeDigest({
  from, to,
  tasksTouched = [], shipmentsById = new Map(),
  board = { rows: [], summary: {}, stale_days: 7 },
  scrapedCount = 0, lastScrapeAt = null, newlyFlagged = [], activeYesCount = 0,
  deliveredCount = 0, archivedCount = 0,
  analyses = [], audit = [], notes = [],
}) {
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  const shipOf = (t) => shipmentsById.get(t.shipment_id) || null;

  const created = tasksTouched.filter((t) => inWindow(t.created_at, fromMs, toMs)).map((t) => slimTask(t, shipOf(t)));
  const completed = tasksTouched.filter((t) => t.status === "done" && inWindow(t.completed_at || t.updated_at, fromMs, toMs)).map((t) => slimTask(t, shipOf(t)));
  const dismissed = tasksTouched.filter((t) => t.status === "cancelled" && inWindow(t.updated_at, fromMs, toMs)).map((t) => slimTask(t, shipOf(t)));

  const rows = board.rows || [];
  const active = rows.filter((r) => isActive(r.task.status));
  const attention = active
    .filter((r) => !r.seg.flags.includes("resolved_upstream")
      && (["redelivery", "return_claim", "storage_risk"].includes(r.seg.segment) || r.seg.flags.includes("repeat")))
    .map((r) => ({
      task_id: r.task.id,
      tracking_number: r.shipment?.tracking_number || r.task.tracking_number || null,
      customer: r.shipment?.customer_name || null,
      carrier: r.shipment?.carrier_name || r.shipment?.carrier || null,
      segment: r.seg.segment,
      attempt: r.seg.attempt,
      flags: r.seg.flags,
      health: r.seg.health,
      age_days: r.seg.age_days,
      assigned_to: r.task.assigned_to || null,
      shipment_status: r.shipment?.shipment_status || null,
      eta: r.shipment?.updated_eta || null,
      destination: r.shipment?.destination || null,
      ai_issue: r.shipment?.ai_issue ? String(r.shipment.ai_issue).slice(0, 260) : null,
      title: shortTitle(r.task.title),
    }));
  const aging = active
    .filter((r) => r.seg.flags.includes("aging"))
    .sort((a, b) => (b.seg.age_days || 0) - (a.seg.age_days || 0))
    .slice(0, 15)
    .map((r) => ({
      tracking_number: r.shipment?.tracking_number || null, customer: r.shipment?.customer_name || null,
      carrier: r.shipment?.carrier_name || null, age_days: r.seg.age_days, assigned_to: r.task.assigned_to || null,
      status: r.task.status, title: shortTitle(r.task.title),
    }));
  const likelyResolved = active.filter((r) => r.seg.flags.includes("resolved_upstream"));

  const analysesByKind = {};
  let aiCost = 0;
  for (const a of analyses) {
    const k = a.kind === "other" && a.metadata?.subkind ? `other/${a.metadata.subkind}` : (a.kind || "other");
    if (!analysesByKind[k]) analysesByKind[k] = { count: 0, cost_usd: 0 };
    analysesByKind[k].count++;
    analysesByKind[k].cost_usd += Number(a.cost_usd) || 0;
    aiCost += Number(a.cost_usd) || 0;
  }
  for (const v of Object.values(analysesByKind)) v.cost_usd = Math.round(v.cost_usd * 1000) / 1000;

  const byActor = {};
  for (const a of audit) {
    const who = a.actor_email || a.actor_name || "(system)";
    if (!byActor[who]) byActor[who] = { total: 0, by_action: {} };
    byActor[who].total++;
    byActor[who].by_action[a.action] = (byActor[who].by_action[a.action] || 0) + 1;
  }

  return {
    window: { from, to, hours: Math.round(((toMs - fromMs) / HOUR) * 10) / 10 },
    tasks: {
      created_count: created.length,
      created_by_segment: countBy(created, (t) => t.segment),
      created_by_assignee: countBy(created, (t) => t.assigned_to || "(unassigned)"),
      created: created.slice(0, 60),
      completed_count: completed.length,
      completed_by_assignee: countBy(completed, (t) => t.assigned_to || "(unassigned)"),
      completed: completed.slice(0, 60),
      dismissed_count: dismissed.length,
      dismissed_by_assignee: countBy(dismissed, (t) => t.assigned_to || "(unassigned)"),
      dismissed: dismissed.slice(0, 40),
    },
    board: {
      active: active.length,
      by_status: board.summary?.by_status || {},
      by_segment: board.summary?.by_segment || {},
      by_flag: board.summary?.by_flag || {},
      by_assignee: board.summary?.by_assignee || {},
      needs_attention_count: attention.length,
      needs_attention: attention,
      aging_count: active.filter((r) => r.seg.flags.includes("aging")).length,
      aging_oldest: aging,
      likely_resolved_count: likelyResolved.length,
      likely_resolved_sample: likelyResolved.slice(0, 12).map((r) => ({
        tracking_number: r.shipment?.tracking_number || null, customer: r.shipment?.customer_name || null,
        health: r.seg.health, assigned_to: r.task.assigned_to || null,
      })),
      stale_count: active.filter((r) => r.seg.flags.includes("stale")).length,
      stale_days: board.stale_days,
      unassigned_count: active.filter((r) => r.seg.flags.includes("unassigned")).length,
      top_carriers: top(countBy(active, (r) => r.shipment?.carrier_name || r.shipment?.carrier || "(unknown)")),
      top_customers: top(countBy(active, (r) => r.shipment?.customer_name || "(unknown)")),
    },
    shipments: {
      scraped_in_window: scrapedCount,
      last_scrape_at: lastScrapeAt,
      active_action_required: activeYesCount,
      newly_flagged_count: newlyFlagged.length,
      newly_flagged: newlyFlagged.slice(0, 40).map((s) => ({
        tracking_number: s.tracking_number, customer: s.customer_name, carrier: s.carrier_name || s.carrier,
        mode: s.mode, status: s.shipment_status, target: s.action_target, confidence: s.action_confidence,
        issue: s.ai_issue ? String(s.ai_issue).slice(0, 220) : null,
      })),
      delivered_in_window: deliveredCount,
      archived_in_window: archivedCount,
    },
    ai: { calls: analyses.length, cost_usd: Math.round(aiCost * 1000) / 1000, by_kind: analysesByKind },
    team: {
      audit_events: audit.length,
      by_actor: byActor,
      notes_count: notes.length,
      notes: notes.slice(0, 20).map((n) => ({
        at: n.created_at, by: n.created_by, tracking_number: n.tracking_number || null, body: String(n.body || "").slice(0, 200),
      })),
    },
  };
}

// Pull everything the digest needs for the trailing `hours` window.
export async function collectDailyDigest({ hours = 24 } = {}) {
  const h = Math.max(1, Math.min(Number(hours) || 24, 168));
  const to = new Date();
  const from = new Date(to.getTime() - h * HOUR);
  const fromIso = from.toISOString();

  const [board, tasksRes, scrapedRes, lastScrapeRes, flaggedRes, yesRes, deliveredRes, archivedRes, analysesRes, auditRes, notesRes] = await Promise.all([
    loadBoard({ includeClosed: false }),
    supabase.from("fpx_shipment_tasks").select("*").is("archived_at", null)
      .or(`created_at.gte.${fromIso},updated_at.gte.${fromIso},completed_at.gte.${fromIso}`)
      .order("created_at", { ascending: false }).limit(2000),
    supabase.from("fpx_shipments").select("id", { count: "exact", head: true }).gte("scraped_at", fromIso),
    supabase.from("fpx_shipments").select("scraped_at").order("scraped_at", { ascending: false }).limit(1),
    supabase.from("fpx_shipments")
      .select("id, tracking_number, customer_name, carrier, carrier_name, mode, shipment_status, action_target, action_confidence, ai_issue")
      .eq("action_required", "YES").is("archived_at", null).gte("last_analyzed_at", fromIso)
      .order("last_analyzed_at", { ascending: false }).limit(80),
    supabase.from("fpx_shipments").select("id", { count: "exact", head: true }).eq("action_required", "YES").is("archived_at", null),
    supabase.from("fpx_shipments").select("id", { count: "exact", head: true }).gte("delivery_date", fromIso),
    supabase.from("fpx_shipments").select("id", { count: "exact", head: true }).gte("archived_at", fromIso),
    supabase.from("fpx_ai_analyses").select("kind, cost_usd, metadata").gte("created_at", fromIso).limit(5000),
    supabase.from("fpx_audit_log").select("actor_email, actor_name, action").gte("created_at", fromIso).limit(5000),
    supabase.from("fpx_shipment_notes").select("shipment_id, body, created_by, created_at").gte("created_at", fromIso)
      .order("created_at", { ascending: false }).limit(200),
  ]);
  for (const r of [tasksRes, flaggedRes, analysesRes, auditRes, notesRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  // Tasks touched today may be on shipments that are no longer on the
  // active board; fetch those shipments so the digest can name them.
  const tasks = tasksRes.data || [];
  const shipmentsById = new Map();
  for (const r of board.rows) if (r.shipment) shipmentsById.set(r.shipment.id, r.shipment);
  const missing = Array.from(new Set(tasks.map((t) => t.shipment_id).filter((id) => id && !shipmentsById.has(id))));
  const noteShipIds = Array.from(new Set((notesRes.data || []).map((n) => n.shipment_id).filter((id) => id && !shipmentsById.has(id))));
  const need = Array.from(new Set([...missing, ...noteShipIds]));
  for (let i = 0; i < need.length; i += 400) {
    const { data } = await supabase.from("fpx_shipments").select("id, tracking_number, customer_name, carrier, carrier_name").in("id", need.slice(i, i + 400));
    for (const s of data || []) shipmentsById.set(s.id, s);
  }
  const notes = (notesRes.data || []).map((n) => ({ ...n, tracking_number: shipmentsById.get(n.shipment_id)?.tracking_number || null }));

  return shapeDigest({
    from: fromIso, to: to.toISOString(),
    tasksTouched: tasks, shipmentsById, board,
    scrapedCount: scrapedRes.count ?? 0,
    lastScrapeAt: lastScrapeRes.data?.[0]?.scraped_at || null,
    newlyFlagged: flaggedRes.data || [],
    activeYesCount: yesRes.count ?? 0,
    deliveredCount: deliveredRes.count ?? 0,
    archivedCount: archivedRes.count ?? 0,
    analyses: analysesRes.data || [],
    audit: auditRes.data || [],
    notes,
  });
}

export function stripFences(text) {
  const t = String(text || "").trim();
  const m = t.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : t;
}

export async function runDailySummary({ digest, notes, callMeta }) {
  if (!digest) return { error: "digest required" };
  const { "prompt.daily_summary.system": systemPrompt, "prompt.daily_summary.model": model } =
    await getSettings("prompt.daily_summary.system", "prompt.daily_summary.model");

  const userMessage = [
    `Window: ${digest.window.from} → ${digest.window.to} (${digest.window.hours}h). Generated ${new Date().toISOString()}.`,
    notes ? `Notes from the operator requesting this brief: ${String(notes).slice(0, 1500)}` : null,
    "Digest (JSON, the only source of facts):",
    JSON.stringify(digest),
    "Write the brief now, Markdown only.",
  ].filter(Boolean).join("\n\n");

  const result = await callClaude({
    systemPrompt,
    userMessage,
    maxTokens: 20000,
    modelOverride: model,
    metadata: {
      kind: "other",
      ...(callMeta || {}),
      metadata: {
        subkind: "daily_summary",
        window: digest.window,
        counts: {
          created: digest.tasks.created_count, completed: digest.tasks.completed_count, dismissed: digest.tasks.dismissed_count,
          active: digest.board.active, needs_attention: digest.board.needs_attention_count,
          scraped: digest.shipments.scraped_in_window, newly_flagged: digest.shipments.newly_flagged_count,
        },
        digest,
        ...((callMeta?.metadata) || {}),
      },
    },
  });
  if (result.error) return { error: result.error };
  const markdown = stripFences(result.text);
  return {
    markdown: result.stop_reason === "max_tokens" ? `${markdown}\n\n> _Output was cut off at the token limit._` : markdown,
    model: result.model,
    cost_usd: result.cost_usd,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    stop_reason: result.stop_reason || null,
    analysis_id: result.analysis_id,
  };
}
