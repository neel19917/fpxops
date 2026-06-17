import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { mapShipment, mapShipmentsBulk } from "../lib/shipments.js";
import { logAudit } from "../lib/audit.js";
import { generateEmailDraft } from "../lib/emailDraft.js";
import { getSettings } from "../lib/settings.js";
import { analyzeExistingShipment, runShipmentAnalysis } from "./analyze.js";
import { extractAiJsonFields } from "../lib/anthropic.js";
import { MATERIAL_FIELDS, computeMaterialDiff, recordScrapeBatch } from "../lib/scrapeHistory.js";

// Models an operator may pick in the "Re-analyze" modal. Haiku is the cheap
// default; Sonnet/Opus are escalation options for ambiguous shipments.
const REANALYZE_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
]);

export const shipmentsRouter = Router();

// Columns selected by the list endpoint. Excludes raw_data (multi-KB JSON blob
// per row, never rendered on the list) and other drawer-only fields. Cuts the
// list-view payload roughly 10-50x at scale; the drawer (`/shipments/:id`)
// still returns full rows.
const LIST_COLUMNS = [
  "id", "scraped_at",
  "tracking_number", "shipment_id", "order_number",
  "customer_name", "customer_id", "company_name",
  "account_manager", "created_by", "seen_count",
  "carrier", "carrier_name", "mode", "service",
  "shipment_status", "action_required", "action_source",
  "ai_issue", "ai_recommendation",
  "ship_from", "ship_to",
  "shipment_date", "pickup_date", "updated_eta", "original_eta", "delivery_date",
  "appointment_set", "appointment_date", "required_arrival_date",
  "ready_time", "cut_off_time",
  "shipper_spot_quote", "spot_quote_fulfilled_by", "pickup_tendered",
  "tracking_comments", "updated_via", "last_modified_at",
  "signed_by", "notes",
  "shipment_marked_up_rate", "shipment_rate_without_markup", "shipment_gross_profit",
  "reference_one", "reference_two", "reference_three",
  "reference_four", "reference_five", "reference_six",
].join(", ");

// Strip null AI fields from the upsert payload so re-scrapes from a
// scrape-only extension don't blow away analysis the server has already
// performed. mapShipment always emits these keys; if the scraper didn't fill
// them in, we want the existing DB values preserved by the upsert.
function preserveExistingAi(rows) {
  const aiFields = ["action_required", "ai_issue", "ai_recommendation", "action_target", "action_confidence"];
  for (const r of rows) {
    for (const f of aiFields) if (r[f] == null) delete r[f];
  }
}

// Per-shipment AI runs in the background after upsert returns, so the
// extension's POST is fast. Concurrency is capped to avoid hammering Claude
// for big bulk uploads. Skips rows already analyzed (action_required set) and
// rows the user manually overrode (action_source === 'manual'). Returns the
// updated rows so autoCreateActionTasks / autoDraftEmails can fan out from
// fresh analyses.
const AUTO_ANALYZE_CONCURRENCY = 4;

// Decide which upserted shipments deserve a (re)analysis pass:
//   - never analyzed yet (no action_required)               → analyze
//   - manually overridden                                   → skip (always)
//   - material data changed since last scrape               → re-analyze
//   - already analyzed and no new info                      → skip
// `materialChangedIds` is a Set of fpx_shipments.id that had a non-null diff
// from the prior scrape. The bulk POST flow builds it before calling this.
async function autoAnalyzeUpserted(req, upsertedIds, { materialChangedIds = new Set() } = {}) {
  if (!upsertedIds.length) return [];
  const { data: rows, error } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, action_required, action_source, action_target, raw_data, ai_issue, ai_recommendation, created_by")
    .in("id", upsertedIds);
  if (error) {
    console.warn("[FPX] auto-analyze fetch failed:", error.message);
    return [];
  }
  const candidates = (rows || []).filter((r) => {
    if (r.action_source === "manual") return false;
    if (!r.action_required) return true;
    if (materialChangedIds.has(r.id)) return true;
    return false;
  });
  if (!candidates.length) return [];

  const updated = [];
  for (let i = 0; i < candidates.length; i += AUTO_ANALYZE_CONCURRENCY) {
    const batch = candidates.slice(i, i + AUTO_ANALYZE_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((row) => analyzeExistingShipment(row, { reqContext: req }))
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) updated.push(s.value);
    }
  }
  return updated;
}

// After an upsert batch, look at the newly-flagged action-needed shipments and
// create one open task per shipment that doesn't already have one. The task
// title comes from the AI recommendation (or issue) so the broker sees what
// to do without clicking in. Returns the count created.
// Shared post-upsert pipeline used by both the single and bulk POST
// branches. Records scrape history, flags stale manual overrides,
// stamps last_material_change_at on materially-changed rows, and
// kicks off the background analyze + auto-task + auto-draft pass.
// Inputs are pre-built by the caller so both branches stay symmetric:
//   mapped[]:       the rows we just upserted (shape from mapShipment*)
//   data[]:         the upsert response — id + canonical columns
//   rawByTracking:  raw extension payloads keyed by tracking_number
//   priorByTracking: prior shipments keyed by tracking_number (pre-upsert)
//   diffByTracking:  material diff keyed by tracking_number
//   runnerName:     who scraped (header / api key name / email)
// Returns { materialChangedIds: Set, staleTargets: string[] }.
async function runPostUpsertFlow(req, {
  mapped, data, rawByTracking, priorByTracking, diffByTracking, runnerName,
}) {
  const idByTracking = new Map(data.map((r) => [r.tracking_number, r.id]));
  const materialChangedIds = new Set(
    Array.from(diffByTracking.keys())
      .map((t) => idByTracking.get(t))
      .filter(Boolean),
  );

  // Persist one fpx_shipment_scrapes row per scraped item.
  const scrapePayloads = mapped.map((m) => ({
    shipmentId: idByTracking.get(m.tracking_number),
    trackingNumber: m.tracking_number,
    scrapedBy: runnerName,
    raw: rawByTracking.get(m.tracking_number) || {},
    diff: diffByTracking.get(m.tracking_number) || null,
    triggeredReanalysis: false,
  }));
  const scrapeRecordPromise = recordScrapeBatch(scrapePayloads);

  // Mark manual overrides as stale when new material data arrives.
  const staleTargets = mapped
    .filter((m) => diffByTracking.has(m.tracking_number) && priorByTracking.get(m.tracking_number)?.action_source === "manual")
    .map((m) => idByTracking.get(m.tracking_number))
    .filter(Boolean);
  if (staleTargets.length) {
    await supabase.from("fpx_shipments")
      .update({ action_override_stale: true })
      .in("id", staleTargets);
  }

  // Stamp last_material_change_at for every materially-changed shipment.
  if (materialChangedIds.size) {
    const stamp = new Date().toISOString();
    await supabase.from("fpx_shipments")
      .update({ last_material_change_at: stamp })
      .in("id", Array.from(materialChangedIds));
  }

  // Background: re-analyze + tasks + drafts. The diffByTracking flows
  // into auto-task creation so each task description ends with a Change
  // log section showing what moved between scrapes.
  const upsertedIds = data.map((r) => r.id);
  const backgroundWork = (async () => {
    const freshlyAnalyzed = await autoAnalyzeUpserted(req, upsertedIds, { materialChangedIds });
    const byId = new Map(data.map((r) => [r.id, r]));
    for (const r of freshlyAnalyzed) byId.set(r.id, r);
    const settled = Array.from(byId.values());
    const tasks = await autoCreateActionTasks(req, settled, { diffByTracking });
    const drafts = await autoDraftEmails(settled);
    if (tasks || drafts || freshlyAnalyzed.length) {
      console.log(`[FPX] post-upload: ${freshlyAnalyzed.length} (re)analyzed, ${tasks} task(s), ${drafts} draft(s)`);
    }
  })().catch((e) => console.warn("[FPX] post-upload background failed:", e.message));
  // Don't await — let scrape recording + background drain on their own.
  void backgroundWork;
  void scrapeRecordPromise;

  return { materialChangedIds, staleTargets };
}

// Format a material-diff object as a human-readable change log block.
// Returns "" when there's nothing to log so callers can safely concat
// without an extra section header for unchanged shipments.
function formatChangeLog(diff) {
  if (!diff || typeof diff !== "object") return "";
  const lines = [];
  for (const [field, change] of Object.entries(diff)) {
    if (!change || typeof change !== "object") continue;
    const prev = change.prev == null || change.prev === "" ? "—" : String(change.prev);
    const next = change.next == null || change.next === "" ? "—" : String(change.next);
    lines.push(`- ${field}: ${prev} → ${next}`);
  }
  if (!lines.length) return "";
  return ["Change log:", ...lines].join("\n");
}

async function autoCreateActionTasks(req, upsertedRows, { diffByTracking = new Map() } = {}) {
  // Parcel shipments don't get auto-tasks by default — operators don't
  // follow up on parcel exceptions the same way, so the noise was drowning
  // out the LTL/truckload work that actually needs human action. Gated on
  // the ui.tracking.show_parcels admin switch (default OFF) so a single
  // toggle governs both Tracking-page visibility and task spawn across
  // every scrape source. No audit row is emitted for the skip: the audit
  // log only fires on successful inserts below.
  const { "ui.tracking.show_parcels": showParcels } = await getSettings("ui.tracking.show_parcels");
  const candidates = (upsertedRows || []).filter(
    (s) => String(s.action_required || "").toUpperCase() === "YES"
        && (showParcels === true || String(s.mode || "").trim().toLowerCase() !== "parcel")
  );
  if (!candidates.length) return 0;
  const ids = candidates.map((s) => s.id);
  // Skip shipments where the rep has already engaged with a task — open
  // and in_progress are obviously dedup'd, but a *done* or *cancelled*
  // task means the rep already worked it; we shouldn't re-spawn the
  // same task on the next scrape and stomp their decision. Archived
  // tasks (shipment was delivered/auto-archived) still don't count —
  // a shipment that comes back into the dashboard with a new issue
  // should get a fresh task.
  const { data: existing } = await supabase
    .from("fpx_shipment_tasks")
    .select("shipment_id")
    .in("shipment_id", ids)
    .in("status", ["open", "in_progress", "done", "cancelled"])
    .is("archived_at", null);
  const taken = new Set((existing || []).map((r) => r.shipment_id));
  const toCreate = candidates.filter((s) => !taken.has(s.id));
  if (!toCreate.length) return 0;

  const rows = toCreate.map((s) => {
    const reasonLine = s.ai_recommendation
      ? String(s.ai_recommendation).split(/[.!?]\s/)[0].slice(0, 140)
      : (s.ai_issue ? String(s.ai_issue).slice(0, 140) : "Action needed on this shipment");
    // When the AI knows who to chase (action_target), prefix the task
    // title with the matching followup convention so the task lands
    // in the Carrier Followups or Customer Followups panel on /tasks.
    // Without this prefix, auto-created tasks were "stranded" in the
    // generic Kanban — the operator had to hand-tag every one to
    // surface it in the grouped view.
    const tgt = String(s.action_target || "").toLowerCase();
    const prefix =
      tgt === "carrier" ? "Carrier followup: "
      : tgt === "customer" ? "Customer followup: "
      : "";
    // Append the material diff (what moved between scrapes) so the rep
    // sees exactly what changed without opening the drawer's history
    // tab. First-sighting shipments have no diff and the section is
    // omitted cleanly.
    const changeLog = formatChangeLog(diffByTracking.get(s.tracking_number));
    const description = [s.ai_issue, s.ai_recommendation, changeLog]
      .filter(Boolean).join("\n\n");
    return {
      shipment_id: s.id,
      tracking_number: s.tracking_number,
      title: prefix + reasonLine,
      description,
      status: "open",
      priority: "high",
      assigned_to: s.created_by || null,
      created_by: "system (auto-flag)",
    };
  });
  const { data, error } = await supabase
    .from("fpx_shipment_tasks").insert(rows).select("id, shipment_id, tracking_number, title");
  if (error) {
    console.warn("[FPX] auto-task insert failed:", error.message);
    return 0;
  }
  // Audit each auto-created task.
  for (const t of data || []) {
    logAudit(req, {
      action: "auto_task",
      entity_type: "task",
      entity_id: t.id,
      summary: `Auto-created task for action-needed shipment ${t.tracking_number}: ${t.title}`,
      after: t,
      metadata: { reason: "action_required=YES" },
    });
  }
  return (data || []).length;
}

// Fire-and-forget: for each action-required shipment with a known target,
// generate one email draft addressed to that target. Drafts are persisted as
// fpx_ai_analyses rows with metadata.subkind=email_draft_<audience>, which is
// what the dashboard's Drafts sub-tab already reads. Skips shipments that
// already have a recent draft for the same audience.
async function autoDraftEmails(upsertedRows) {
  const { "action.auto_draft_enabled": enabled } = await getSettings("action.auto_draft_enabled");
  if (!enabled) return 0;

  const candidates = (upsertedRows || []).filter((s) => {
    if (String(s.action_required || "").toUpperCase() !== "YES") return false;
    const tgt = String(s.action_target || "").toLowerCase();
    return tgt === "customer" || tgt === "carrier";
  });
  if (!candidates.length) return 0;

  // Skip shipments that already have a draft for this audience in the last 24h
  // — auto-drafts shouldn't pile up on every re-scrape.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ids = candidates.map((s) => s.id);
  const { data: recent } = await supabase
    .from("fpx_ai_analyses")
    .select("shipment_uuid, metadata")
    .in("shipment_uuid", ids)
    .gte("created_at", since);
  const drafted = new Set();
  for (const r of recent || []) {
    const sub = r?.metadata?.subkind;
    if (typeof sub === "string" && sub.startsWith("email_draft_")) {
      drafted.add(`${r.shipment_uuid}::${sub.slice("email_draft_".length)}`);
    }
  }

  let count = 0;
  // Need the full shipment row for context; fetch in one query.
  const todo = candidates.filter((s) => !drafted.has(`${s.id}::${String(s.action_target).toLowerCase()}`));
  if (!todo.length) return 0;
  const { data: ships } = await supabase
    .from("fpx_shipments").select("*").in("id", todo.map((s) => s.id));
  for (const ship of ships || []) {
    const audience = String(ship.action_target || "").toLowerCase();
    if (audience !== "customer" && audience !== "carrier") continue;
    try {
      const draft = await generateEmailDraft({ ship, audience, callMeta: { metadata: { auto: true } } });
      if (!draft.error) count++;
    } catch (e) {
      console.warn("[FPX] auto email draft failed:", ship.tracking_number, e.message);
    }
  }
  return count;
}

// GET /shipments?limit=200&before=<scraped_at iso>&customer=Acme&action=YES&status=Issue&q=track123&source=ai|manual
// Reads from fpx_shipments_latest (view) — one row per tracking_number, most recent
// scrape. Base table fpx_shipments keeps the full history; hit /shipments/:id to see it.
//
// Pagination: cursor-based on scraped_at desc. The dashboard fetches
// ?limit=200 on initial mount and pages with ?before=<oldest scraped_at
// from prior page>&limit=500 on each "Load more" click. Cursor beats
// offset because new scrapes can land between pages and offset would
// double-count or skip rows; with a strict-less-than scraped_at filter
// the next page is always the next chunk of older rows.
shipmentsRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  let q = supabase.from("fpx_shipments_latest").select(LIST_COLUMNS).order("scraped_at", { ascending: false }).limit(limit);
  if (req.query.before) {
    // Parse to ISO so a malformed cursor returns 400 instead of an
    // opaque postgres error. The view's scraped_at is timestamptz —
    // a strict `lt` on iso strings sorts correctly.
    const cursor = new Date(String(req.query.before));
    if (Number.isNaN(cursor.getTime())) {
      return res.status(400).json({ error: "before cursor must be an ISO timestamp" });
    }
    q = q.lt("scraped_at", cursor.toISOString());
  }
  if (req.query.customer) q = q.eq("customer_name", String(req.query.customer));
  if (req.query.action) q = q.eq("action_required", String(req.query.action));
  if (req.query.source && ["ai", "manual", "none"].includes(String(req.query.source))) {
    q = q.eq("action_source", String(req.query.source));
  }
  if (req.query.status) q = q.eq("shipment_status", String(req.query.status));
  if (req.query.q) {
    const s = String(req.query.q);
    q = q.or(`tracking_number.ilike.%${s}%,customer_name.ilike.%${s}%,carrier_name.ilike.%${s}%,ai_issue.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  // Surface the "next" cursor when we returned a full page so the
  // dashboard knows whether to keep showing the Load more button.
  // null = end of list.
  const nextCursor = (data && data.length === limit && data[data.length - 1]?.scraped_at) || null;
  res.json({ data: data || [], next_cursor: nextCursor });
});

// GET /shipments/stats?parcels=1 — TRUE counts over the whole latest view, not
// just the page the grid happens to have loaded. The dashboard's status pills
// were counting baseRows (default 200-row page), so "Total 200" was really
// "first page", not the dataset. We return total + issues + a raw per-status
// tally; the client folds the tally into pills with its own STATUS_MATCHERS so
// the booked/in-transit/etc. logic stays single-sourced in one place.
//
// Registered BEFORE GET /:id so "stats" isn't captured as a shipment id.
// Paginates in 1000-row pages to beat PostgREST's default max-rows cap.
shipmentsRouter.get("/stats", async (req, res) => {
  const includeParcels = req.query.parcels === "1" || req.query.parcels === "true";
  const PAGE = 1000;
  let from = 0;
  let total = 0;
  let issues = 0;
  const statuses = {};
  for (;;) {
    const { data, error } = await supabase
      .from("fpx_shipments_latest")
      .select("shipment_status, action_required, mode")
      .order("scraped_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return res.status(500).json({ error: error.message });
    const batch = data || [];
    for (const r of batch) {
      if (!includeParcels && String(r.mode || "").trim().toLowerCase() === "parcel") continue;
      total++;
      if (String(r.action_required || "").toUpperCase() === "YES") issues++;
      const st = r.shipment_status || "";
      statuses[st] = (statuses[st] || 0) + 1;
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  res.json({ total, issues, statuses });
});

shipmentsRouter.get("/:id", async (req, res) => {
  const { data: ship, error } = await supabase.from("fpx_shipments").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ship) return res.status(404).json({ error: "Shipment not found" });
  const [analysesRes, historyRes, tasksRes, notesRes, recentDiffRes] = await Promise.all([
    supabase
      .from("fpx_ai_analyses").select("*")
      .or(`shipment_uuid.eq.${ship.id},tracking_number.eq.${ship.tracking_number || "__none__"}`)
      .order("created_at", { ascending: false }).limit(50),
    ship.tracking_number
      ? supabase.from("fpx_shipments").select("id, scraped_at, shipment_status, action_required, ai_issue")
          .eq("tracking_number", ship.tracking_number).neq("id", ship.id)
          .order("scraped_at", { ascending: false }).limit(20)
      : Promise.resolve({ data: [] }),
    supabase.from("fpx_shipment_tasks").select("*").eq("shipment_id", ship.id).order("created_at", { ascending: false }),
    // Append-only operator notes log, newest first. Drives the drawer's
    // Notes section (a running log, not a single editable field).
    supabase.from("fpx_shipment_notes").select("*").eq("shipment_id", ship.id).order("created_at", { ascending: false }),
    // Most recent material diff from fpx_shipment_scrapes — same row
    // the AI per-shipment prompt now sees as recent_changes. Surfacing
    // it on the drawer lets the rep eyeball "what moved since last
    // scrape" without diffing two snapshots manually. Best-effort —
    // a missing scrape row just hides the section in the UI.
    supabase.from("fpx_shipment_scrapes")
      .select("scraped_at, scraped_by, diff")
      .eq("shipment_id", ship.id)
      .not("diff", "is", null)
      .order("scraped_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  res.json({
    shipment: ship,
    analyses: analysesRes.data || [],
    history: historyRes.data || [],
    tasks: tasksRes.data || [],
    notes_log: notesRes.data || [],
    recent_diff: recentDiffRes.data || null,
  });
});

// POST /shipments — single or bulk upsert keyed on tracking_number. Repeat
// scrapes update the existing row (seen_count auto-bumps via trigger) instead
// of growing the table. The x-fpx-user-name header (set by the extension popup)
// gets stamped as created_by on first insert; the trigger preserves it on
// subsequent upserts so task auto-assignment is stable.
// Body: { shipment: {...} } or { shipments: [...] }
shipmentsRouter.post("/", async (req, res) => {
  const runnerName = (req.header("x-fpx-user-name") || req.user?.email || req.apiKey?.name || "").trim() || null;
  const single = req.body.shipment;
  const bulk = req.body.shipments;
  if (single) {
    const mapped = mapShipment(single, runnerName);
    if (!mapped || !mapped.tracking_number) return res.status(400).json({ error: "tracking_number required" });
    preserveExistingAi([mapped]);

    // Pull prior so the diff sees what moved before the upsert clobbers
    // the row. Mirrors the bulk path so single-shipment scrapes get the
    // same Change log + dedup + scrape history treatment.
    const cols = ["id", "tracking_number", "action_source", ...MATERIAL_FIELDS].join(", ");
    const { data: prior } = await supabase
      .from("fpx_shipments").select(cols).eq("tracking_number", mapped.tracking_number).maybeSingle();
    const priorByTracking = new Map();
    if (prior) priorByTracking.set(mapped.tracking_number, prior);
    const diff = computeMaterialDiff(prior, mapped);
    const diffByTracking = new Map();
    if (diff) diffByTracking.set(mapped.tracking_number, diff);

    const { data, error } = await supabase
      .from("fpx_shipments")
      .upsert(mapped, { onConflict: "tracking_number" })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const rawByTracking = new Map([[mapped.tracking_number, single]]);
    await runPostUpsertFlow(req, {
      mapped: [mapped],
      data: [data],
      rawByTracking,
      priorByTracking,
      diffByTracking,
      runnerName,
    });
    return res.json({ shipment: data });
  }
  if (Array.isArray(bulk)) {
    const mapped = mapShipmentsBulk(bulk, runnerName);
    if (!mapped.length) return res.json({ count: 0, ids: [] });

    // Scrape-only extension uploads carry no AI fields. Preserve whatever the
    // server has already analyzed instead of overwriting with nulls.
    preserveExistingAi(mapped);

    // ---- Scrape history ------------------------------------------------
    // Pull the prior snapshot for every tracking_number so we can compute a
    // material-field diff before the upsert clobbers the row. Only the
    // fields we compare on are pulled — keeps the query small.
    const trackingNumbers = mapped.map((m) => m.tracking_number).filter(Boolean);
    const priorByTracking = new Map();
    if (trackingNumbers.length) {
      const cols = ["id", "tracking_number", "action_source", ...MATERIAL_FIELDS].join(", ");
      const { data: priors } = await supabase
        .from("fpx_shipments").select(cols).in("tracking_number", trackingNumbers);
      for (const p of priors || []) priorByTracking.set(p.tracking_number, p);
    }
    // Compute the diff per scraped row (null if first sighting / no change).
    const diffByTracking = new Map();
    for (const m of mapped) {
      const prev = priorByTracking.get(m.tracking_number);
      const diff = computeMaterialDiff(prev, m);
      if (diff) diffByTracking.set(m.tracking_number, diff);
    }
    // ---- Upsert (latest-snapshot table) --------------------------------
    const { data, error } = await supabase
      .from("fpx_shipments")
      .upsert(mapped, { onConflict: "tracking_number" })
      .select("id,tracking_number,seen_count,created_by,action_required,action_source,action_target,ai_issue,ai_recommendation");
    if (error) return res.status(500).json({ error: error.message });

    const upsertedIds = data.map((r) => r.id);

    // Single shared post-upsert pipeline. Records scrape history,
    // flags stale manual overrides, stamps last_material_change_at,
    // and runs the background analyze + auto-task + auto-draft pass
    // (with the diff plumbed through so each task description gets a
    // Change log section).
    const rawByTracking = new Map();
    for (let i = 0; i < mapped.length; i += 1) {
      rawByTracking.set(mapped[i].tracking_number, bulk[i]);
    }
    const { materialChangedIds, staleTargets } = await runPostUpsertFlow(req, {
      mapped, data, rawByTracking, priorByTracking, diffByTracking, runnerName,
    });

    logAudit(req, {
      action: "bulk_create",
      entity_type: "shipment",
      summary: `Upserted ${data.length} shipments` + (materialChangedIds.size ? ` (${materialChangedIds.size} with material changes)` : ""),
      metadata: {
        count: data.length,
        runner: runnerName,
        material_changes: materialChangedIds.size,
        stale_overrides_flagged: staleTargets.length,
      },
    });
    return res.json({
      count: data.length,
      ids: upsertedIds,
      material_changes: materialChangedIds.size,
      stale_overrides: staleTargets.length,
    });
  }
  res.status(400).json({ error: "Provide { shipment } or { shipments: [] }" });
});

// POST /shipments/sweep-complete
//   body: { tracking_numbers: ["...", ...] }   // every TN seen during the sweep
//   header: x-fpx-user-name (the runner)
//
// Called once at the end of an UNFILTERED full-grid scrape. FreightPOP hides
// delivered shipments from the default Tracking grid, so any of the runner's
// previously-scraped shipments whose tracking_number is NOT in the supplied
// set were delivered between scrapes. Soft-archive them and their open tasks
// so the dashboard stops showing stale "in transit" rows that 404 when
// clicked.
//
// Safety:
//   - Refuses an empty tracking_numbers list (would archive everything for
//     this runner — that's almost always a broken scrape, not a real signal).
//   - Scoped strictly to created_by = runner; never touches other reps' rows.
//   - Soft-archive only (archived_at + archived_reason); reversible via SQL.
//   - The extension only fires this on a clean unfiltered completion (the
//     gate lives in content.js — server trusts that).
shipmentsRouter.post("/sweep-complete", async (req, res) => {
  const runner = (req.header("x-fpx-user-name") || req.user?.email || req.apiKey?.name || "").trim();
  if (!runner) {
    return res.status(400).json({ error: "x-fpx-user-name header required to scope sweep" });
  }
  const seen = Array.isArray(req.body?.tracking_numbers) ? req.body.tracking_numbers : null;
  if (!seen) return res.status(400).json({ error: "body.tracking_numbers array required" });
  const seenSet = new Set(seen.map((t) => String(t).trim()).filter(Boolean));
  if (seenSet.size === 0) {
    // Refuse: scraper saw nothing → almost certainly a broken run, not a
    // signal that every previously-tracked shipment was delivered.
    return res.status(400).json({ error: "tracking_numbers is empty — refusing to archive" });
  }

  // Pull this runner's currently-active shipments. Only id + tracking_number
  // here — we'll only update the rows we actually need to archive.
  const { data: active, error: fetchErr } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number")
    .eq("created_by", runner)
    .is("archived_at", null);
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const stale = (active || []).filter(
    (r) => r.tracking_number && !seenSet.has(r.tracking_number),
  );
  if (!stale.length) {
    return res.json({ archived_shipments: 0, archived_tasks: 0, runner, scanned: active?.length || 0 });
  }

  const staleIds = stale.map((r) => r.id);
  const archivedAt = new Date().toISOString();

  // Archive shipments — set archived_at + a reason so we can tell apart
  // operator-deleted rows (hard delete) from auto-archived (soft).
  const { error: shipErr } = await supabase
    .from("fpx_shipments")
    .update({ archived_at: archivedAt, archived_reason: "absent_from_dashboard" })
    .in("id", staleIds);
  if (shipErr) return res.status(500).json({ error: shipErr.message });

  // Archive open/in-progress/blocked tasks for those shipments. We mark the
  // task done + completed_at + archived_at so it disappears from the open
  // list AND the kanban "completed" lane shows when it landed and why.
  // Tasks already in 'done' or 'cancelled' are left alone.
  const { data: archivedTasks, error: taskErr } = await supabase
    .from("fpx_shipment_tasks")
    .update({
      status: "done",
      completed_at: archivedAt,
      archived_at: archivedAt,
      archived_reason: "shipment_delivered",
    })
    .in("shipment_id", staleIds)
    .in("status", ["open", "in_progress", "blocked"])
    .select("id");
  if (taskErr) {
    // Shipments are already archived — surface the task error but don't
    // unwind. Operator can re-run the sweep and the task update will
    // pick up where this one left off (idempotent on archived_at).
    console.warn("[FPX] sweep-complete task archive failed:", taskErr.message);
  }

  logAudit(req, {
    action: "sweep_archive",
    entity_type: "shipment",
    summary: `Auto-archived ${staleIds.length} shipment${staleIds.length === 1 ? "" : "s"} absent from dashboard for runner ${runner}` +
      (archivedTasks?.length ? ` (${archivedTasks.length} task${archivedTasks.length === 1 ? "" : "s"})` : ""),
    metadata: {
      runner,
      scanned: active.length,
      archived_shipments: staleIds.length,
      archived_tasks: archivedTasks?.length || 0,
      sample_tracking: stale.slice(0, 10).map((r) => r.tracking_number),
    },
  });

  res.json({
    archived_shipments: staleIds.length,
    archived_tasks: archivedTasks?.length || 0,
    runner,
    scanned: active.length,
  });
});

// POST /shipments/bulk-delete  { ids: [uuid, ...] }
// Hard-deletes shipments. fpx_shipment_tasks rows cascade automatically;
// fpx_ai_analyses rows have their shipment_uuid set to NULL so the analysis
// history survives. Returns the count actually removed (after RLS / missing IDs
// are filtered out).
shipmentsRouter.post("/bulk-delete", async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(String).filter(Boolean)
    : [];
  if (!ids.length) return res.status(400).json({ error: "body.ids array required" });

  // Snapshot for audit before the delete fires.
  const { data: before } = await supabase
    .from("fpx_shipments").select("id, tracking_number, customer_name").in("id", ids);
  const { error, data } = await supabase
    .from("fpx_shipments").delete().in("id", ids).select("id");
  if (error) return res.status(500).json({ error: error.message });
  const deleted = (data || []).length;

  logAudit(req, {
    action: "bulk_delete",
    entity_type: "shipment",
    summary: `Deleted ${deleted} shipment${deleted === 1 ? "" : "s"}`,
    before: { rows: before || [] },
    metadata: { count: deleted, requested: ids.length },
  });

  res.json({ deleted });
});

// POST /shipments/bulk-reanalyze  { ids: [uuid, ...] }
// Re-runs per-shipment AI across the selection and REPLACES the stored verdict
// on each row (analyzeExistingShipment respects manual overrides). Re-analysis
// of N rows is N model calls — minutes + real cost for a big selection — so we
// respond immediately with { queued } and process in the background with
// bounded concurrency. The operator hits Refresh to see updated verdicts; each
// run is logged to fpx_ai_analyses (incl. the calibration metadata).
shipmentsRouter.post("/bulk-reanalyze", async (req, res) => {
  const scope = req.body?.scope === "all" ? "all" : "ids";
  let ids;
  if (scope === "all") {
    // "Re-analyze all": pull the latest row per tracking number from the view
    // (not the base table, which holds full scrape history — that'd re-analyze
    // stale duplicates). Paginated past PostgREST's 1000-row cap.
    ids = [];
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("fpx_shipments_latest")
        .select("id").order("scraped_at", { ascending: false }).range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      const batch = data || [];
      for (const r of batch) if (r.id) ids.push(r.id);
      if (batch.length < PAGE) break;
      from += PAGE;
    }
  } else {
    ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
  }
  if (!ids.length) return res.status(400).json({ error: "no shipments to re-analyze" });

  // Safety ceiling so a runaway request can't fan out unbounded paid calls.
  const MAX = 5000;
  const slice = ids.slice(0, MAX);
  // Respond before the work starts — this is fire-and-forget on purpose.
  res.json({ queued: slice.length, capped: ids.length > MAX, scope });

  const CONCURRENCY = 4;
  let cursor = 0;
  let done = 0;
  let failed = 0;
  async function worker() {
    while (cursor < slice.length) {
      const id = slice[cursor++];
      try {
        const { data: row } = await supabase.from("fpx_shipments").select("*").eq("id", id).maybeSingle();
        if (row) {
          await analyzeExistingShipment(row, { reqContext: req });
          done++;
        }
      } catch (e) {
        failed++;
        console.warn("[FPX] bulk-reanalyze row failed:", id, e.message);
      }
    }
  }
  Promise.all(Array.from({ length: CONCURRENCY }, worker))
    .then(() => {
      console.log(`[FPX] bulk-reanalyze complete: ${done} ok, ${failed} failed of ${slice.length}`);
      logAudit(req, {
        action: "bulk_reanalyze",
        entity_type: "shipment",
        summary: `Bulk re-analyzed ${done} shipment${done === 1 ? "" : "s"} (${scope})`,
        metadata: { scope, requested: ids.length, processed: done, failed, capped: ids.length > MAX },
      });
    })
    .catch((e) => console.error("[FPX] bulk-reanalyze batch error:", e));
});

// POST /shipments/:id/reanalyze — manual trigger from the dashboard. Runs
// per-shipment AI again (regardless of last_analyzed_at), updates the row,
// and returns the fresh shipment + a one-row analysis result. Manual
// overrides are still preserved by analyzeExistingShipment.
shipmentsRouter.post("/:id/reanalyze", async (req, res) => {
  const { data: row, error } = await supabase
    .from("fpx_shipments").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: "Shipment not found" });
  const updated = await analyzeExistingShipment(row, { reqContext: req });
  logAudit(req, {
    action: "reanalyze",
    entity_type: "shipment",
    entity_id: row.id,
    summary: `Re-analyzed ${row.tracking_number || row.id}`,
    before: { action_required: row.action_required, ai_issue: row.ai_issue },
    after:  { action_required: updated?.action_required, ai_issue: updated?.ai_issue },
  });
  res.json({ shipment: updated || row });
});

// POST /shipments/:id/reanalyze/preview  { model? }
// Run per-shipment AI on the chosen model and return the proposed verdict
// WITHOUT touching the shipment row. The run is still logged to
// fpx_ai_analyses (so it shows in the Analysis history and is auditable),
// but the shipment's action_*/ai_* fields only change if the operator later
// confirms via /reanalyze/apply. Powers the "Re-analyze" modal.
shipmentsRouter.post("/:id/reanalyze/preview", async (req, res) => {
  const model = req.body?.model;
  if (model && !REANALYZE_MODELS.has(model)) {
    return res.status(400).json({ error: `Unsupported model: ${model}` });
  }
  const { data: row, error } = await supabase
    .from("fpx_shipments").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: "Shipment not found" });

  const result = await runShipmentAnalysis(row, {
    reqContext: req,
    modelOverride: model || undefined,
  });
  if (!result || result.error) {
    return res.status(502).json({ error: result?.error || "Analysis failed" });
  }

  res.json({
    preview: {
      analysis_id: result.analysis_id,
      model: result.model,
      issue: result.parsed?.issue ?? null,
      recommendation: result.parsed?.recommendation ?? null,
      action_required: result.parsed?.action_required ?? null,
      action_target: result.parsed?.action_target ?? null,
      action_confidence: result.parsed?.action_confidence ?? null,
      cost_usd: result.cost_usd ?? null,
      input_tokens: result.input_tokens ?? null,
      output_tokens: result.output_tokens ?? null,
    },
    current: {
      ai_issue: row.ai_issue,
      ai_recommendation: row.ai_recommendation,
      action_required: row.action_required,
      action_target: row.action_target,
      action_confidence: row.action_confidence,
      action_source: row.action_source,
      last_analyzed_at: row.last_analyzed_at,
    },
  });
});

// POST /shipments/:id/reanalyze/apply  { analysis_id }
// Commit a previously-previewed analysis onto the shipment row: copies its
// issue/recommendation + (unless a manual override is in force) the
// action verdict, stamps last_analyzed_at, and writes an audit-log entry so
// the replacement is traceable. analysis_id must be a per_shipment analysis
// belonging to this shipment.
shipmentsRouter.post("/:id/reanalyze/apply", async (req, res) => {
  const analysisId = req.body?.analysis_id;
  if (!analysisId) return res.status(400).json({ error: "analysis_id required" });

  const { data: an } = await supabase
    .from("fpx_ai_analyses")
    .select("id, shipment_uuid, kind, model, issue, recommendation, action_required, response_text")
    .eq("id", analysisId).maybeSingle();
  if (!an) return res.status(404).json({ error: "Analysis not found" });
  if (an.shipment_uuid !== req.params.id) {
    return res.status(400).json({ error: "Analysis does not belong to this shipment" });
  }

  const { data: before } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, action_required, action_source, action_target, action_confidence, ai_issue, ai_recommendation, last_analyzed_at")
    .eq("id", req.params.id).maybeSingle();
  if (!before) return res.status(404).json({ error: "Shipment not found" });

  // action_target / action_confidence aren't columns on fpx_ai_analyses —
  // re-derive them from the stored response JSON using the same threshold the
  // live analyzer uses.
  const { "action.threshold": threshold } = await getSettings("action.threshold");
  const parsed = extractAiJsonFields(an.response_text || "", Number(threshold) || 0.7);

  const patch = { last_analyzed_at: new Date().toISOString() };
  const issue = an.issue || parsed.issue;
  const recommendation = an.recommendation || parsed.recommendation;
  if (issue) patch.ai_issue = issue;
  if (recommendation) patch.ai_recommendation = recommendation;
  // Respect a manual override: only the issue/recommendation text refreshes;
  // the human's action decision stays pinned.
  if (before.action_source !== "manual") {
    const actionReq = an.action_required || parsed.action_required;
    if (actionReq) {
      patch.action_required = actionReq;
      patch.action_source = "ai";
    }
    if (parsed.action_target) patch.action_target = parsed.action_target;
    if (parsed.action_confidence !== null && parsed.action_confidence !== undefined) {
      patch.action_confidence = parsed.action_confidence;
    }
  }

  const { data: updated, error } = await supabase
    .from("fpx_shipments").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  logAudit(req, {
    action: "reanalyze",
    entity_type: "shipment",
    entity_id: updated.id,
    summary: `Replaced analysis on ${updated.tracking_number || updated.id} with ${an.model || "AI"} verdict`,
    before: {
      action_required: before.action_required,
      action_confidence: before.action_confidence,
      ai_issue: before.ai_issue,
    },
    after: {
      action_required: updated.action_required,
      action_confidence: updated.action_confidence,
      ai_issue: updated.ai_issue,
    },
    metadata: { model: an.model, analysis_id: an.id, replaced: true },
  });

  res.json({ shipment: updated });
});

// PATCH /shipments/:id/action  { action_required, reason? }
// Manually override the AI's action_required value. Pins action_source='manual'
// so subsequent scrapes don't reset it (enforced by the bump-seen trigger).
// Pass null/empty to clear the override.
shipmentsRouter.patch("/:id/action", async (req, res) => {
  const value = req.body?.action_required;
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
  const overrideName = req.user?.email || req.apiKey?.name || req.header("x-fpx-user-name") || "unknown";

  // Pre-fetch for audit `before` snapshot.
  const { data: before } = await supabase
    .from("fpx_shipments")
    .select("id, tracking_number, action_required, action_source, action_overridden_by")
    .eq("id", req.params.id).maybeSingle();
  if (!before) return res.status(404).json({ error: "Shipment not found" });

  const patch = value == null
    ? {
        action_source: "ai",
        action_overridden_by: null,
        action_overridden_at: null,
        action_override_reason: null,
      }
    : {
        action_required: String(value),
        action_source: "manual",
        action_overridden_by: overrideName,
        action_overridden_at: new Date().toISOString(),
        action_override_reason: reason,
      };

  const { data, error } = await supabase
    .from("fpx_shipments")
    .update(patch)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  logAudit(req, {
    action: "override",
    entity_type: "shipment",
    entity_id: data.id,
    summary: value == null
      ? `Cleared manual override on ${data.tracking_number}`
      : `Set ${data.tracking_number} action to ${String(value).toUpperCase()} (manual)` + (reason ? ` — ${reason}` : ""),
    before: { action_required: before.action_required, action_source: before.action_source },
    after:  { action_required: data.action_required,   action_source: data.action_source },
    metadata: { reason },
  });

  res.json({ shipment: data });
});

// PATCH /shipments/:id/notes  { notes }
// Free-form operator notes shown in the dashboard drawer. Pass empty string
// or null to clear.
shipmentsRouter.patch("/:id/notes", async (req, res) => {
  const raw = req.body?.notes;
  const notes = raw == null || raw === "" ? null : String(raw).slice(0, 5000);
  const { data: before } = await supabase
    .from("fpx_shipments").select("id, tracking_number, notes").eq("id", req.params.id).maybeSingle();
  if (!before) return res.status(404).json({ error: "Shipment not found" });
  const { data, error } = await supabase
    .from("fpx_shipments").update({ notes }).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  logAudit(req, {
    action: "update_notes",
    entity_type: "shipment",
    entity_id: data.id,
    summary: `Updated notes on ${data.tracking_number || data.id}`,
    before: { notes: before.notes },
    after: { notes: data.notes },
  });
  res.json({ shipment: data });
});

// POST /shipments/:id/notes  { body }
// Append a new entry to the shipment's notes log. Each entry is immutable —
// this is a running log, not an editable field. We also denormalize the
// latest entry onto fpx_shipments.notes so the Tracking "With notes" filter
// and /notes cross-shipment view keep working off the single column, and we
// write an fpx_audit_log row (action='shipment_note') that the Audit log
// page's Notes tab surfaces.
shipmentsRouter.post("/:id/notes", async (req, res) => {
  const body = String(req.body?.body || "").trim().slice(0, 5000);
  if (!body) return res.status(400).json({ error: "body required" });
  const { data: ship, error: shipErr } = await supabase
    .from("fpx_shipments").select("id, tracking_number").eq("id", req.params.id).maybeSingle();
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  if (!ship) return res.status(404).json({ error: "Shipment not found" });
  const author = req.user?.email || req.apiKey?.name || req.header("x-fpx-user-name") || null;
  const { data: note, error } = await supabase
    .from("fpx_shipment_notes")
    .insert({ shipment_id: ship.id, tracking_number: ship.tracking_number, body, created_by: author })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Denormalize latest entry onto the shipment for the list-side filter/view.
  const { data: shipUpdated } = await supabase
    .from("fpx_shipments").update({ notes: body }).eq("id", ship.id).select().single();
  logAudit(req, {
    action: "shipment_note",
    entity_type: "shipment",
    entity_id: ship.id,
    summary: `Note on ${ship.tracking_number || ship.id}: ${body.slice(0, 140)}`,
    after: { body },
    metadata: { note_id: note.id },
  });
  res.json({ note, shipment: shipUpdated || null });
});

// ----- Tasks scoped to a shipment -----

// GET /shipments/:id/tasks — list tasks for a shipment (newest first).
shipmentsRouter.get("/:id/tasks", async (req, res) => {
  const { data, error } = await supabase
    .from("fpx_shipment_tasks")
    .select("*")
    .eq("shipment_id", req.params.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// POST /shipments/:id/tasks — create a task. assigned_to defaults to the
// shipment's created_by (the runner who scraped it).
shipmentsRouter.post("/:id/tasks", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "title required" });
  const { data: ship, error: shipErr } = await supabase
    .from("fpx_shipments").select("id, tracking_number, created_by").eq("id", req.params.id).maybeSingle();
  if (shipErr) return res.status(500).json({ error: shipErr.message });
  if (!ship) return res.status(404).json({ error: "Shipment not found" });
  const creatorName = req.user?.email || req.apiKey?.name || req.header("x-fpx-user-name") || null;
  // Allow callers to specify an initial status — the followup add-task
  // modal needs in_progress / blocked options because operators
  // sometimes know the shipment is already mid-pursuit at creation
  // time. "done"/"cancelled" intentionally not allowed via this path
  // (use the separate update flow with completed_at handling).
  const allowedStatus = ["open", "in_progress", "blocked"];
  const row = {
    shipment_id: ship.id,
    tracking_number: ship.tracking_number,
    title,
    description: req.body?.description ? String(req.body.description) : null,
    priority: ["low","normal","high","urgent"].includes(req.body?.priority) ? req.body.priority : "normal",
    status: allowedStatus.includes(req.body?.status) ? req.body.status : "open",
    assigned_to: req.body?.assigned_to || ship.created_by || null,
    created_by: creatorName,
    due_at: req.body?.due_at || null,
  };
  const { data, error } = await supabase.from("fpx_shipment_tasks").insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ task: data });
});

// POST /shipments/:id/email-draft  { audience: "carrier" | "customer", notes? }
// Returns { subject, body } generated by Claude using the shipment context.
shipmentsRouter.post("/:id/email-draft", async (req, res) => {
  const audience = req.body?.audience === "customer" ? "customer" : "carrier";
  const { data: ship, error } = await supabase
    .from("fpx_shipments").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ship) return res.status(404).json({ error: "Shipment not found" });

  const result = await generateEmailDraft({
    ship,
    audience,
    notes: req.body?.notes,
    callMeta: { api_key_id: req.apiKey?.id, user_email: req.user?.email },
  });
  if (result.error) return res.status(500).json({ error: result.error });
  res.json(result);
});
