// Lookback: queue the hosted browser's catch-up jobs in one call, and read
// back how fresh the data is. Mounted as /api/ops/lookback on the /api router,
// which already runs requireAuth(), so both routes accept a dashboard JWT
// (req.user) or an x-api-key (req.apiKey). No auth is added here.
//
// POST /api/ops/lookback
//   Body: { jobs?, months?, shipment_type?, modes?, run_as? }
//     jobs           any of "erp", "shipment_details", "tracking" (default ["erp"])
//     months         how far back the ERP pull looks (default 1)
//     shipment_type  ERP pull type, as POST /ops/rescrape scope "erp_audit" takes it
//     modes          FreightPOP modes for the tracking scrape
//     run_as         email of the person whose FreightPOP login the jobs use
//   Each job becomes one row in fpx_scrape_requests (the same queue
//   POST /ops/rescrape and POST /shipment-details/sweep write to). A job that
//   already has a matching pending or claimed row is not queued again: that
//   row is returned with coalesced: true.
//   Responds 200 { run_as, run_as_source, queued: [{ job, request_id,
//   coalesced, scope, status }], skipped: [{ job, reason }] }.
//   400 for a bad body or a run_as that cannot be used; 500 (same body plus
//   error) when nothing was queued and at least one insert failed.
//
// GET /api/ops/lookback
//   Query: tracking_hours, erp_hours, approvals_hours, details_hours (how old
//   each kind of data may be before it counts as stale).
//   Read-only. Reads the recent fpx_scrape_requests and fpx_scrape_runs rows
//   and the newest fpx_shipments.scraped_at, fpx_erp_transactions.last_seen_at,
//   fpx_audit_approvals.last_seen_at and fpx_shipment_details.captured_at, and
//   responds with buildHealth(...) plus warnings: string[]. A source that
//   could not be read (other than fpx_scrape_requests, which is a 500) is
//   treated as empty and named in warnings.
//
// Who a job runs as (run_as)
//   The hosted browser runs every request as its requested_by
//   (browser-service/src/worker.js, runJob). It refuses a request whose
//   requested_by has no "@" ("Request has no user ... rescrapes must come from
//   a signed-in rep") and one whose email has no saved FreightPOP login
//   ("<email> hasn't logged in to FreightPOP in the hosted view yet").
//   routes/ops.js stores req.user?.email || req.apiKey?.name as requested_by,
//   so a request queued there with an API key carries the key's name, which is
//   not an email, and the worker fails it. routes/shipmentDetails.js avoids
//   that by refusing API-key callers (403). This route instead works out an
//   email (resolveRunAs in lib/lookback.js):
//     "self"         the signed-in dashboard user's own email
//     "run_as"       the run_as in the body
//     "env"          FPX_LOOKBACK_RUN_AS on the server
//     "last_runner"  requested_by of the newest finished erp_audit request
//                    that has an email (looked up only for an API key that
//                    gave no run_as, when FPX_LOOKBACK_RUN_AS is empty)
//   Any source other than "self" must be an enabled row in fpx_user_profiles;
//   the email is stored as that row spells it, because the hosted browser
//   finds the saved login by the exact email string. This route cannot see
//   whether that person has signed in to FreightPOP in the hosted view: if
//   they have not, the request is queued and the worker fails it with the
//   message above.
//
// Example:
//   curl -X POST "$FPX_API/api/ops/lookback" \
//     -H "x-api-key: $FPX_API_KEY" -H "content-type: application/json" \
//     -d '{"jobs":["erp","shipment_details"],"months":1,"run_as":"rep@example.com"}'
//   curl "$FPX_API/api/ops/lookback?erp_hours=24" -H "x-api-key: $FPX_API_KEY"

import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";
import {
  normalizeLookbackBody,
  resolveRunAs,
  planRequest,
  findOpenDuplicate,
  parseThresholds,
  buildHealth,
} from "../lib/lookback.js";

export const lookbackRouter = Router();

const REQUESTS = "fpx_scrape_requests";

const errText = (e) => String(e?.message || e || "unknown error");


// requested_by of the newest finished ERP pull that was run by a person.
async function findLastRunner() {
  const { data, error } = await supabase
    .from(REQUESTS).select("requested_by")
    .eq("scope", "erp_audit").eq("status", "done").ilike("requested_by", "%@%")
    .order("requested_at", { ascending: false }).limit(1);
  if (error) {
    console.warn(`[FPX] lookback: could not look up the last ERP runner (${error.message})`);
    return null;
  }
  return data?.[0]?.requested_by || null;
}

const JOB_LABELS = { erp: "ERP", shipment_details: "shipment details", tracking: "tracking" };

function describeJob(job, { months, shipment_type, modes }, email) {
  const label = JOB_LABELS[job] || job;
  let detail = "";
  if (job === "erp") {
    const parts = [`last ${months} month${months === 1 ? "" : "s"}`];
    if (shipment_type) parts.push(shipment_type);
    detail = ` (${parts.join(", ")})`;
  } else if (job === "tracking" && Array.isArray(modes) && modes.length) {
    detail = ` (${modes.join(" + ")})`;
  }
  return `Queued ${label} lookback${detail} to run as ${email}`;
}

lookbackRouter.post("/", async (req, res) => {
  try {
    const body = normalizeLookbackBody(req.body);
    if (!body.ok) return res.status(400).json({ error: body.error });
    const { jobs, months, shipment_type, modes, run_as } = body;

    // A key cannot say whose it is, and a job runs in a person's FreightPOP
    // login: only a key given the "lookback" (or "admin") scope may queue one.
    if (req.apiKey && !req.user) {
      const scopes = Array.isArray(req.apiKey.scopes) ? req.apiKey.scopes : [];
      if (!scopes.includes("lookback") && !scopes.includes("admin")) {
        return res.status(403).json({ error: "This API key needs the 'lookback' scope to queue lookbacks" });
      }
    }
    const envRunAs = process.env.FPX_LOOKBACK_RUN_AS;
    let lastRunner = null;
    if (req.apiKey && !req.user && !run_as && !String(envRunAs || "").trim()) {
      lastRunner = await findLastRunner();
    }
    const who = resolveRunAs({ user: req.user, apiKey: req.apiKey, runAs: run_as, envRunAs, lastRunner });
    if (!who.ok) return res.status(who.status || 400).json({ error: who.error });
    let email = who.email;
    const source = who.source;

    if (source !== "self") {
      // ILIKE finds the row whatever its capitals. "_" in an email also matches
      // any one character there, so the exact comparison below decides.
      const { data: profiles, error: pErr } = await supabase
        .from("fpx_user_profiles").select("email, enabled")
        .ilike("email", String(email).replace(/[%*\\]/g, "")).limit(20);
      if (pErr) return res.status(500).json({ error: pErr.message });
      const wanted = String(email).trim().toLowerCase();
      const matches = (profiles || []).filter((p) => String(p.email || "").trim().toLowerCase() === wanted);
      const profile = matches.find((p) => p.enabled) || null;
      if (!profile) {
        return res.status(400).json({ error: `${email} is not an enabled FPX user, so there is no FreightPOP login to run as` });
      }
      email = profile.email;
    }

    const { data: open, error: oErr } = await supabase
      .from(REQUESTS).select("*")
      .in("status", ["pending", "claimed"])
      .order("requested_at", { ascending: false }).limit(200);
    if (oErr) return res.status(500).json({ error: oErr.message });
    // Only the same person's request stands in for this one, and a request
    // claimed long ago is taken to be stuck, not running.
    const STUCK_MS = 4 * 3600_000;
    const openRows = (open || []).filter((r) =>
      String(r.requested_by || "").toLowerCase() === String(email).toLowerCase()
      && (r.status === "pending" || (r.claimed_at && Date.now() - Date.parse(r.claimed_at) < STUCK_MS)));

    const queued = [];
    const skipped = [];
    for (const job of jobs) {
      try {
        const plan = planRequest(job, { months, shipment_type, modes });
        const dup = findOpenDuplicate(job, plan, openRows);
        if (dup) {
          queued.push({ job, request_id: dup.id, coalesced: true, scope: dup.scope, status: dup.status });
          continue;
        }
        const { data, error } = await supabase
          .from(REQUESTS).insert({ ...plan, ...(plan.scope === "erp_audit" ? { note: `${plan.note};via=lookback` } : {}), requested_by: email }).select().single();
        if (error) {
          skipped.push({ job, reason: error.message });
          continue;
        }
        queued.push({ job, request_id: data.id, coalesced: false, scope: data.scope, status: data.status });
        openRows.unshift(data);
        logAudit(req, {
          action: "rescrape_request",
          entity_type: "scrape_request",
          entity_id: data.id,
          summary: describeJob(job, { months, shipment_type, modes: plan.modes }, email),
          metadata: {
            scope: data.scope, job, months, shipment_type, modes: plan.modes ?? null,
            run_as: email, run_as_source: source, via: "lookback",
          },
        });
      } catch (e) {
        skipped.push({ job, reason: errText(e) });
      }
    }

    const out = { run_as: email, run_as_source: source, queued, skipped };
    if (!queued.length && skipped.length) {
      return res.status(500).json({ ...out, error: `Nothing was queued: ${skipped.map((s) => `${s.job}: ${s.reason}`).join("; ")}` });
    }
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: errText(e) });
  }
});

// Newest non-null value of one timestamp column. Never throws.
async function newestValue(table, col) {
  try {
    const { data, error } = await supabase
      .from(table).select(col).not(col, "is", null)
      .order(col, { ascending: false }).limit(1);
    if (error) return { value: null, error: error.message };
    return { value: data?.[0]?.[col] ?? null, error: null };
  } catch (e) {
    return { value: null, error: errText(e) };
  }
}

// Runs a query and turns a thrown error into { data: null, error }.
async function settle(query) {
  try {
    return await query;
  } catch (e) {
    return { data: null, error: { message: errText(e) } };
  }
}

const NEWEST_SOURCES = [
  ["tracking", "fpx_shipments", "scraped_at"],
  ["erp_transactions", "fpx_erp_transactions", "last_seen_at"],
  ["audit_approvals", "fpx_audit_approvals", "last_seen_at"],
  ["shipment_details", "fpx_shipment_details", "captured_at"],
];

lookbackRouter.get("/", async (req, res) => {
  try {
    const thresholds = parseThresholds(req.query);
    const [reqs, runs, ...stamps] = await Promise.all([
      settle(supabase
        .from(REQUESTS)
        .select("id, status, scope, requested_by, requested_at, claimed_at, claimed_by, completed_at, result_count, note, modes")
        .order("requested_at", { ascending: false }).limit(400)),
      settle(supabase
        .from("fpx_scrape_runs")
        .select("id, source, user_email, schedule_id, schedule_name, started_at, finished_at, duration_ms, ok, note, counts, modes")
        .order("started_at", { ascending: false }).limit(300)),
      ...NEWEST_SOURCES.map(([, table, col]) => newestValue(table, col)),
    ]);
    if (reqs.error) return res.status(500).json({ error: reqs.error.message });

    const warnings = [];
    if (runs.error) warnings.push(`fpx_scrape_runs could not be read: ${runs.error.message}`);
    const newest = {};
    NEWEST_SOURCES.forEach(([key, table, col], i) => {
      newest[key] = stamps[i].value;
      if (stamps[i].error) warnings.push(`${table}.${col} could not be read: ${stamps[i].error}`);
    });

    return res.json({
      ...buildHealth({
        now: new Date(),
        thresholds,
        requests: reqs.data || [],
        runs: runs.error ? [] : runs.data || [],
        newest,
      }),
      warnings,
    });
  } catch (e) {
    return res.status(500).json({ error: errText(e) });
  }
});
