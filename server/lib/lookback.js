// Lookback: queue the big "catch up" jobs (ERP pull, shipment details sweep,
// tracking scrape) and report how fresh each mirrored dataset is.
//
// Pure logic only: no Supabase, no Express, no network. The route
// (server/routes/lookback.js) reads the rows and hands them to these functions.

export const LOOKBACK_JOBS = ["erp", "shipment_details", "tracking"];
export const JOB_SCOPE = { erp: "erp_audit", shipment_details: "shipment_details", tracking: "all" };
export const DEFAULT_THRESHOLD_HOURS = { tracking: 6, erp: 36, approvals: 36, details: 36 };

const MODES = ["LTL", "Truckload", "Parcel"];
const SHIPMENT_TYPES = ["non-parcel", "parcel", "both"];
const MAX_THRESHOLD_HOURS = 8760;

// Dataset key -> label, threshold name, and the counts key that holds its row count.
const DATASETS = [
  { key: "tracking", label: "Tracking scrape", threshold: "tracking", rowsKey: "saved" },
  { key: "erp_transactions", label: "ERP transactions", threshold: "erp", rowsKey: "uploaded" },
  { key: "audit_approvals", label: "Audit approvals", threshold: "approvals", rowsKey: "matched" },
  { key: "shipment_details", label: "Shipment details", threshold: "details", rowsKey: "saved" },
];

// ── small helpers ───────────────────────────────────────────────────────────

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function trimmed(v) {
  return typeof v === "string" ? v.trim() : "";
}

function timeMs(v) {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

function noteOf(v) {
  return typeof v === "string" ? v : null;
}

function textOf(v) {
  return typeof v === "string" && v !== "" ? v : null;
}

function numberOrNull(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function oneDecimal(n) {
  return Math.round(n * 10) / 10;
}

// Canonical, sorted list of the valid modes in `value`. Empty when the value
// means "every mode" (null, not an array, nothing valid, or all three).
function modeSet(value) {
  if (!Array.isArray(value)) return [];
  const found = MODES.filter((m) => value.some((v) => typeof v === "string" && v.trim().toLowerCase() === m.toLowerCase()));
  return found.length === MODES.length ? [] : found;
}

// Same reading of an erp_audit note as the worker.
function parseErpNote(note) {
  const text = typeof note === "string" ? note : "";
  const m = text.match(/months\s*=\s*(\d+)/i);
  const t = text.match(/type\s*=\s*(non-parcel|parcel|both)/i);
  const months = m ? Math.min(12, Math.max(1, parseInt(m[1], 10))) : 3;
  return {
    months,
    type: t ? t[1].toLowerCase() : "non-parcel",
    fixedRange: /from\s*=|backfill\s*=/i.test(text),
  };
}

// ── POST body ───────────────────────────────────────────────────────────────

export function normalizeLookbackBody(body) {
  const b = isObject(body) ? body : {};

  // jobs
  let jobs;
  if (b.jobs === undefined || b.jobs === null) {
    jobs = ["erp"];
  } else {
    const list = typeof b.jobs === "string" ? [b.jobs] : b.jobs;
    const allowed = `jobs must be one or more of: ${LOOKBACK_JOBS.join(", ")}`;
    if (!Array.isArray(list) || list.length === 0) return { ok: false, error: allowed };
    jobs = [];
    for (const raw of list) {
      const job = trimmed(raw);
      if (!LOOKBACK_JOBS.includes(job)) {
        return { ok: false, error: `Unknown job "${typeof raw === "string" ? raw : String(raw)}". ${allowed}` };
      }
      if (!jobs.includes(job)) jobs.push(job);
    }
  }

  // months
  let months = 1;
  if (b.months !== undefined && b.months !== null) {
    const n = typeof b.months === "number" ? b.months : typeof b.months === "string" && b.months.trim() !== "" ? Number(b.months) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      return { ok: false, error: "months must be a whole number from 1 to 12" };
    }
    months = n;
  }

  // shipment_type
  let shipment_type = "non-parcel";
  if (b.shipment_type !== undefined && b.shipment_type !== null) {
    const t = trimmed(b.shipment_type).toLowerCase();
    if (!SHIPMENT_TYPES.includes(t)) {
      return { ok: false, error: `shipment_type must be one of: ${SHIPMENT_TYPES.join(", ")}` };
    }
    shipment_type = t;
  }

  // modes
  let modes = null;
  if (b.modes !== undefined && b.modes !== null) {
    const list = typeof b.modes === "string" ? [b.modes] : b.modes;
    const valid = Array.isArray(list)
      ? MODES.filter((m) => list.some((v) => typeof v === "string" && v.trim().toLowerCase() === m.toLowerCase()))
      : [];
    if (valid.length === 0) return { ok: false, error: "Pick at least one mode" };
    modes = valid.length === MODES.length ? null : valid;
  }

  const run_as = trimmed(b.run_as) || null;

  return { ok: true, jobs, months, shipment_type, modes, run_as };
}

// ── who the job runs as ─────────────────────────────────────────────────────

const NEED_PERSON =
  "Lookback jobs run with a person's FreightPOP login, so they need someone to run as. " +
  "Pass run_as (an FPX user's email) or set FPX_LOOKBACK_RUN_AS.";

function asEmail(value, source) {
  const email = trimmed(value);
  if (!email.includes("@")) {
    const where =
      source === "env" ? "FPX_LOOKBACK_RUN_AS" : source === "last_runner" ? "The last runner on record" : "run_as";
    return { ok: false, status: 400, error: `${where} must be an FPX user's email address (got "${email}")` };
  }
  return { ok: true, email, source };
}

export function resolveRunAs({ user, apiKey, runAs, envRunAs, lastRunner } = {}) {
  const wanted = trimmed(runAs);

  if (user) {
    const own = trimmed(user.email);
    if (!wanted || (own && wanted.toLowerCase() === own.toLowerCase())) {
      if (!own) return { ok: false, status: 401, error: "Sign in to queue a lookback" };
      return asEmail(own, "self");
    }
    if (user.role !== "admin") {
      return { ok: false, status: 403, error: "Only admins can run a lookback as someone else" };
    }
    return asEmail(wanted, "run_as");
  }

  if (apiKey) {
    const scopes = Array.isArray(apiKey.scopes) ? apiKey.scopes : [];
    if (!scopes.includes("write") && !scopes.includes("admin")) {
      return { ok: false, status: 403, error: "API key needs the 'write' scope to queue lookbacks" };
    }
    if (wanted) return asEmail(wanted, "run_as");
    if (trimmed(envRunAs)) return asEmail(envRunAs, "env");
    if (trimmed(lastRunner)) return asEmail(lastRunner, "last_runner");
    return { ok: false, status: 400, error: NEED_PERSON };
  }

  return { ok: false, status: 401, error: "Sign in or use an API key to queue a lookback" };
}

// ── the row to queue ────────────────────────────────────────────────────────

export function planRequest(job, { months, shipment_type, modes } = {}) {
  if (job === "erp") {
    return { scope: JOB_SCOPE.erp, note: `months=${months};type=${shipment_type}`, modes: null };
  }
  if (job === "shipment_details") {
    return { scope: JOB_SCOPE.shipment_details, note: "all=1", modes: null };
  }
  if (job === "tracking") {
    return { scope: JOB_SCOPE.tracking, note: null, modes: Array.isArray(modes) && modes.length ? modes : null };
  }
  throw new Error(`Unknown lookback job: ${job}`);
}

// An already queued or running request that does the same work, or null.
export function findOpenDuplicate(job, plan, openRows) {
  const rows = Array.isArray(openRows) ? openRows.filter(isObject) : [];
  const p = isObject(plan) ? plan : {};
  let same;

  if (job === "erp") {
    const want = parseErpNote(p.note);
    same = (row) => {
      if (row.scope !== JOB_SCOPE.erp) return false;
      const got = parseErpNote(row.note);
      return !got.fixedRange && got.months === want.months && got.type === want.type;
    };
  } else if (job === "shipment_details") {
    same = (row) => row.scope === JOB_SCOPE.shipment_details && typeof row.note === "string" && /(?:^|;)\s*all=1\b/.test(row.note);
  } else if (job === "tracking") {
    const want = modeSet(p.modes).join("|");
    same = (row) => row.scope === JOB_SCOPE.tracking && modeSet(row.modes).join("|") === want;
  } else {
    return null;
  }

  const matches = rows.filter((row) => (row.status === "pending" || row.status === "claimed") && same(row));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const pa = a.status === "pending" ? 0 : 1;
    const pb = b.status === "pending" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (timeMs(b.requested_at) ?? -Infinity) - (timeMs(a.requested_at) ?? -Infinity);
  });
  return matches[0];
}

// ── health ──────────────────────────────────────────────────────────────────

export function parseThresholds(query) {
  const q = isObject(query) ? query : {};
  const out = {};
  for (const name of Object.keys(DEFAULT_THRESHOLD_HOURS)) {
    const n = numberOrNull(q[`${name}_hours`]);
    out[name] = n !== null && n > 0 && n <= MAX_THRESHOLD_HOURS ? n : DEFAULT_THRESHOLD_HOURS[name];
  }
  return out;
}

export function datasetForScope(scope) {
  if (scope === null || scope === undefined || scope === "all" || scope === "selected") return "tracking";
  if (scope === "erp_audit") return "erp_transactions";
  if (scope === "approval_check") return "audit_approvals";
  if (scope === "shipment_details") return "shipment_details";
  return null;
}

export function datasetForRun(run, scopeByRequestId) {
  if (!isObject(run)) return null;
  const id = typeof run.id === "string" ? run.id : run.id === null || run.id === undefined ? "" : String(run.id);
  if (!id) return null;
  if (scopeByRequestId && typeof scopeByRequestId.has === "function" && scopeByRequestId.has(id)) {
    return datasetForScope(scopeByRequestId.get(id));
  }
  if (id.startsWith("sch_")) return "tracking";
  if (id.startsWith("mir_")) {
    const counts = isObject(run.counts) ? run.counts : {};
    if ("approvedRows" in counts) return "audit_approvals";
    if ("uploaded" in counts || "reportRows" in counts) return "erp_transactions";
    return null;
  }
  return null;
}

function runRows(run, rowsKey) {
  return isObject(run.counts) ? numberOrNull(run.counts[rowsKey]) : null;
}

export function buildHealth({ now, thresholds, requests, runs, newest } = {}) {
  const nowMs = timeMs(now) ?? Date.now();
  const limits = { ...DEFAULT_THRESHOLD_HOURS };
  if (isObject(thresholds)) {
    for (const name of Object.keys(limits)) {
      const n = numberOrNull(thresholds[name]);
      if (n !== null && n > 0) limits[name] = n;
    }
  }
  const requestRows = Array.isArray(requests) ? requests.filter(isObject) : [];
  const runRowsList = Array.isArray(runs) ? runs.filter(isObject) : [];
  const newestBy = isObject(newest) ? newest : {};

  const scopeByRequestId = new Map();
  const requestById = new Map();
  for (const r of requestRows) {
    if (r.id === null || r.id === undefined) continue;
    scopeByRequestId.set(String(r.id), r.scope);
    requestById.set(String(r.id), r);
  }
  const runById = new Map();
  for (const run of runRowsList) {
    if (run.id !== null && run.id !== undefined) runById.set(String(run.id), run);
  }

  // Finished jobs per dataset, from both sources, each job once.
  const events = new Map(DATASETS.map((d) => [d.key, []]));
  const active = new Map(DATASETS.map((d) => [d.key, []]));
  const rowsKeyOf = new Map(DATASETS.map((d) => [d.key, d.rowsKey]));
  const settledRequestIds = new Set();

  for (const r of requestRows) {
    const key = datasetForScope(r.scope);
    if (!key) continue;
    const id = r.id === null || r.id === undefined ? null : String(r.id);

    if (r.status === "pending" || r.status === "claimed") {
      active.get(key).push({
        request_id: r.id ?? null,
        status: r.status,
        requested_by: textOf(r.requested_by),
        requested_at: r.requested_at ?? null,
        claimed_at: r.claimed_at ?? null,
        note: noteOf(r.note),
      });
      continue;
    }
    if (r.status !== "done" && r.status !== "error") continue;

    const run = id ? runById.get(id) : undefined;
    const at = timeMs(r.completed_at) ?? (run ? timeMs(run.finished_at) : null);
    if (at === null) continue; // leave it to the run, if it has a time
    if (id) settledRequestIds.add(id);
    const ok = r.status === "done";
    let rows = numberOrNull(r.result_count);
    if (rows === null && run) rows = runRows(run, rowsKeyOf.get(key));
    events.get(key).push({ ok, at, by: textOf(r.requested_by), rows, note: noteOf(r.note), id: r.id, via: "request" });
  }

  for (const run of runRowsList) {
    const id = run.id === null || run.id === undefined ? null : String(run.id);
    if (id && settledRequestIds.has(id)) continue; // already counted as its request
    if (run.ok !== true && run.ok !== false) continue;
    const key = datasetForRun(run, scopeByRequestId);
    if (!key) continue;
    const at = timeMs(run.finished_at);
    if (at === null) continue;
    const request = id ? requestById.get(id) : undefined;
    events.get(key).push({
      ok: run.ok,
      at,
      by: textOf(run.user_email) ?? (request ? textOf(request.requested_by) : null),
      rows: runRows(run, rowsKeyOf.get(key)),
      note: noteOf(run.note),
      id: run.id,
      via: run.source === "schedule" ? "schedule" : "run",
    });
  }

  const newestEvent = (list, ok) => {
    let best = null;
    for (const e of list) if (e.ok === ok && (!best || e.at > best.at)) best = e;
    return best;
  };

  const datasets = DATASETS.map((d) => {
    const limit = limits[d.threshold];
    const newestMs = timeMs(newestBy[d.key]);
    const ageRaw = newestMs === null ? null : Math.max(0, (nowMs - newestMs) / 3_600_000);
    const age = ageRaw === null ? null : oneDecimal(ageRaw);
    const stale = ageRaw === null || ageRaw > limit;
    const stale_reason = !stale ? null : ageRaw === null ? "No data yet" : `Newest data is ${age.toFixed(1)} hours old (limit ${limit})`;

    const success = newestEvent(events.get(d.key), true);
    const failure = newestEvent(events.get(d.key), false);

    const open = active.get(d.key).slice().sort((a, b) => (timeMs(a.requested_at) ?? Infinity) - (timeMs(b.requested_at) ?? Infinity));

    return {
      key: d.key,
      label: d.label,
      newest_data_at: iso(newestMs),
      age_hours: age,
      threshold_hours: limit,
      stale,
      stale_reason,
      failing: Boolean(failure && (!success || failure.at > success.at)),
      last_success: success
        ? { at: iso(success.at), by: success.by, rows: success.rows, note: success.note, id: success.id, via: success.via }
        : null,
      last_failure: failure
        ? { at: iso(failure.at), by: failure.by, note: failure.note, id: failure.id, via: failure.via }
        : null,
      active: open,
    };
  });

  return {
    generated_at: iso(nowMs),
    ok: datasets.every((d) => !d.stale && !d.failing),
    thresholds_hours: limits,
    datasets,
  };
}
