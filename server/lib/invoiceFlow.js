// The one Invoices workflow (Pull → Runs → Not exported → Report → Push to
// ERP), read side. Used by routes/invoiceFlow.js (GET/POST /api/invoice-flow).
//
//   Run              one ERP pull (an fpx_invoice_audits row of shipment_type
//                    'erp_pending') with its pipeline progress
//                    (fpx_invoice_pipeline) and the erp_audit request that
//                    pulled it (fpx_scrape_requests).
//   NotExportedRow   one shipment of the view fpx_erp_invoicing whose bucket is
//                    not 'exported', across all time.
//
// "Exported to ERP" is FreightPOP's own flag (fpx_erp_transactions.exported_to_erp).
// Get Invoice clicks are "Documents saved", never "pushed".
//
// The helpers at the top are pure (tested in tests/invoiceFlow.test.js); the
// loaders below take the Supabase client as their first argument. Nothing
// here deletes anything.
import { ERP_BUCKET } from "./invoiceDocs.js";
import { searchPlan, ilikeAny, mergeIds, chunk, compareRows } from "./invoicingSearch.js";

export const PULL_MONTHS = [1, 3, 6, 12];
export const SHIPMENT_TYPES = ["non-parcel", "parcel", "both"];
export const NOT_EXPORTED_STATUSES = ["no_invoice", "invoice_not_approved", "approved_ready"];
export const STAGES = ["pulled", "approvals", "documents", "done", "failed"];
export const ACTIVE_STAGES = ["pulled", "approvals", "documents"];
export const DEFAULT_RECIPIENTS = ["isaacs@freightpop.com"];
export const RECIPIENTS_KEY = "invoices.report_recipients";
export const MAX_RECIPIENTS = 20;
export const MAX_ZIP_FILES = 3000;

// The Excel files the hosted browser keeps for a pull, at erp-pulls/<audit_id>/.
export const RUN_FILES = [
  { name: "not-exported.xlsx", label: "Not exported to ERP (FreightPOP's Excel)", download: "TransactionsData-not-exported" },
  { name: "full.xlsx", label: "Full Transactions History Report", download: "TransactionsData-full" },
  { name: "recently-approved.xlsx", label: "Recently approved invoices", download: "RecentlyApproved" },
  { name: "audit-history.xlsx", label: "Audit history", download: "AuditHistory", prefix: "audit-history" },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID_RE.test(String(v ?? ""));

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ---------- pure helpers ----------

/**
 * What an erp_audit request's note says. Before it runs the note is
 * "months=N;type=non-parcel"; once done the worker replaces it with something
 * like "920 of 1,870 report rows not exported to ERP · audit b1064935".
 * → { months, shipment_type, not_exported, report_rows, audit_prefix } (null when not said)
 */
export function parseRequestNote(note) {
  const s = String(note ?? "");
  const out = { months: null, shipment_type: null, not_exported: null, report_rows: null, audit_prefix: null };
  const m = /(?:^|;)\s*months=(\d{1,2})/i.exec(s);
  if (m) out.months = Number(m[1]);
  const t = /(?:^|;)\s*type=([a-z-]+)/i.exec(s);
  if (t && SHIPMENT_TYPES.includes(t[1].toLowerCase())) out.shipment_type = t[1].toLowerCase();
  const r = /([\d,]+)\s+of\s+([\d,]+)\s+report\s+rows?/i.exec(s);
  if (r) { out.not_exported = num(r[1]); out.report_rows = num(r[2]); }
  const a = /\baudit[\s=:#]+([0-9a-f]{8})(?:[0-9a-f-]*)/i.exec(s);
  if (a) out.audit_prefix = a[1].toLowerCase();
  return out;
}

/** Whole months between two dates (at least 1), or null. */
export function monthsBetween(from, to) {
  const a = new Date(String(from ?? ""));
  const b = new Date(String(to ?? ""));
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return null;
  const days = (b - a) / 86_400_000;
  return Math.max(1, Math.round(days / 30.44));
}

/** { months, shipment_type } from a POST /pull body, or { error }. */
export function validatePull(body = {}) {
  const rawMonths = body?.months;
  const months = rawMonths === undefined || rawMonths === null || rawMonths === "" ? 1 : Number(rawMonths);
  if (!PULL_MONTHS.includes(months)) return { error: `months must be one of ${PULL_MONTHS.join(", ")}` };
  const rawType = body?.shipment_type;
  const shipmentType = rawType === undefined || rawType === null || rawType === "" ? "non-parcel" : String(rawType).trim().toLowerCase();
  if (!SHIPMENT_TYPES.includes(shipmentType)) return { error: `shipment_type must be one of ${SHIPMENT_TYPES.join(", ")}` };
  return { months, shipmentType };
}

/** The pull request's note, exactly as POST /api/ops/rescrape {scope:"erp_audit"} writes it. */
export const pullNote = (months, shipmentType) => `months=${months};type=${shipmentType}`;

const FREIGHTPOP_EMAIL = /^[a-z0-9._%+-]+@freightpop\.com$/i;

/** Cleaned recipients (lower case, each once) from a PUT body, or { error }. Only @freightpop.com. */
export function validateRecipients(list) {
  if (!Array.isArray(list)) return { error: "recipients must be a list of email addresses" };
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") return { error: "recipients must be a list of email addresses" };
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    if (!FREIGHTPOP_EMAIL.test(email)) return { error: `${email} is not a @freightpop.com address` };
    if (!out.includes(email)) out.push(email);
  }
  if (!out.length) return { error: "Add at least one @freightpop.com address" };
  if (out.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} recipients` };
  return { recipients: out };
}

export function isAdminReq(req) {
  if (req?.user?.role === "admin") return true;
  const scopes = req?.apiKey?.scopes;
  return Array.isArray(scopes) && scopes.includes("admin");
}

/** A Supabase error meaning the table (or view) is not there yet. */
export function isMissingTable(error) {
  if (!error) return false;
  const msg = String(error.message ?? error);
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table|schema cache/i.test(msg);
}

/**
 * Pairs each audit with the erp_audit request that pulled it:
 *   1. the pipeline row's erp_request_id
 *   2. the request whose finished note names the audit ("audit b1064935")
 *   3. a finished request that was running when the audit was created
 * Each request is used once. → Map(audit_id → request)
 */
export function matchRequests(audits, requests, pipelineByAudit = new Map()) {
  const byId = new Map((requests || []).map((r) => [r.id, r]));
  const used = new Set();
  const out = new Map();
  for (const a of audits) {
    const p = pipelineByAudit.get(a.id);
    const r = p?.erp_request_id ? byId.get(p.erp_request_id) : null;
    if (r) { out.set(a.id, r); used.add(r.id); }
  }
  for (const r of requests || []) {
    if (used.has(r.id)) continue;
    const prefix = parseRequestNote(r.note).audit_prefix;
    if (!prefix) continue;
    const a = audits.find((x) => !out.has(x.id) && String(x.id).toLowerCase().startsWith(prefix));
    if (a) { out.set(a.id, r); used.add(r.id); }
  }
  const t = (v) => (v ? new Date(v).getTime() : NaN);
  for (const a of audits) {
    if (out.has(a.id)) continue;
    const created = t(a.created_at);
    if (!Number.isFinite(created)) continue;
    const r = (requests || []).find((x) => {
      if (used.has(x.id) || !["done", "error", "claimed"].includes(x.status)) return false;
      const start = t(x.claimed_at || x.requested_at);
      const end = x.completed_at ? t(x.completed_at) + 60_000 : Infinity;
      return Number.isFinite(start) && created >= start - 1000 && created <= end;
    });
    if (r) { out.set(a.id, r); used.add(r.id); }
  }
  return out;
}

/**
 * Runs from the erp_pending audits (oldest first), their pipeline rows and
 * erp_audit requests. Run numbers come from the pipeline row, else from the
 * audit's place in created_at order. → Run[] newest first.
 */
export function buildRuns({ audits = [], pipelines = [], requests = [] } = {}) {
  const sorted = [...audits].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const pipelineByAudit = new Map(pipelines.map((p) => [p.audit_id, p]));
  const reqOf = matchRequests(sorted, requests, pipelineByAudit);
  const runs = sorted.map((a, i) => {
    const p = pipelineByAudit.get(a.id) || null;
    const r = reqOf.get(a.id) || null;
    const parsed = parseRequestNote(r?.note);
    return {
      audit_id: a.id,
      run_number: Number.isInteger(p?.run_number) ? p.run_number : i + 1,
      started_at: r ? (r.claimed_at || r.requested_at || a.created_at) : a.created_at,
      finished_at: r ? (r.completed_at ?? null) : (a.created_at ?? null),
      months: p?.months ?? parsed.months ?? monthsBetween(a.date_from, a.date_to),
      shipment_type: p?.shipment_type ?? parsed.shipment_type ?? null,
      date_from: a.date_from ?? null,
      date_to: a.date_to ?? null,
      report_rows: parsed.report_rows,
      not_exported: num(a.total_rows) ?? parsed.not_exported,
      stage: p?.stage ?? (r?.status === "error" ? "failed" : "done"),
      approval_status: p?.approval_status ?? null,
      docs_total: num(p?.docs_total) ?? 0,
      docs_done: num(p?.docs_done) ?? 0,
      docs_failed: num(p?.docs_failed) ?? 0,
      report_emailed_at: p?.report_emailed_at ?? null,
      report_email_error: p?.report_email_error ?? null,
      error: p?.error ?? (r?.status === "error" ? (r.note || "The pull failed") : null),
      requested_by: r?.requested_by ?? a.run_by ?? null,
    };
  });
  return runs.sort((x, y) => y.run_number - x.run_number || String(y.started_at ?? "").localeCompare(String(x.started_at ?? "")));
}

/** Plain words for where a run is. */
export function stageMessage(run) {
  switch (run?.stage) {
    case "pulled": return "Pulling the Transactions History Report from FreightPOP";
    case "approvals": return "Checking approvals in FreightPOP";
    case "documents": {
      const total = run.docs_total || 0;
      return total ? `Saving documents ${(run.docs_done || 0).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : "Saving documents";
    }
    case "done": return "Done";
    case "failed": return run.error ? `Failed: ${run.error}` : "Failed";
    default: return String(run?.stage ?? "");
  }
}

/**
 * What is running now: a pull that is queued or running (a pending/claimed
 * erp_audit request), else the newest run whose pipeline is not finished.
 * → { stage, run_number, message } | null
 */
export function activeFrom(runs, requests) {
  const open = (requests || []).filter((r) => ["pending", "claimed"].includes(r.status))
    .sort((a, b) => String(b.requested_at ?? "").localeCompare(String(a.requested_at ?? "")))[0];
  const next = (runs?.[0]?.run_number || 0) + 1;
  if (open) {
    return {
      stage: "pulled",
      run_number: next,
      message: open.status === "pending"
        ? "Pull queued: waiting for the hosted browser"
        : "Pulling the Transactions History Report from FreightPOP",
    };
  }
  const run = (runs || []).find((r) => ACTIVE_STAGES.includes(r.stage));
  return run ? { stage: run.stage, run_number: run.run_number, message: stageMessage(run) } : null;
}

/** A row of the fpx_erp_invoicing view → NotExportedRow. */
export function toNotExportedRow(v, { docsSaved = new Set(), lastPull = new Map(), runNumberByAudit = new Map() } = {}) {
  const id = String(v.shipment_id);
  const audit = lastPull.get(id);
  return {
    shipment_id: id,
    status: v.bucket,
    customer: v.customer_name ?? null,
    carrier: v.carrier ?? null,
    tracking: v.tracking_number ?? null,
    ship_date: v.shipped_date ?? null,
    charge: num(v.charge),
    cost: num(v.cost),
    invoice_number: v.approved_invoice_number ?? null,
    approved_by: v.approved_by ?? null,
    docs_saved: docsSaved.has(id),
    last_pulled_at: v.last_seen_at ?? null,
    run_number: audit ? (runNumberByAudit.get(audit) ?? null) : null,
  };
}

/** Counts by bucket and the not-exported charge total, from aggregate rows [{ bucket, count, sum }]. */
export function countsFromAggregate(rows) {
  const counts = { no_invoice: 0, invoice_not_approved: 0, approved_ready: 0, exported: 0 };
  let charge = 0;
  for (const r of rows || []) {
    if (!Object.hasOwn(counts, r.bucket)) continue;
    counts[r.bucket] += Number(r.count) || 0;
    if (r.bucket !== "exported") charge += Number(r.sum) || 0;
  }
  return { ...counts, charge_total: Math.round(charge * 100) / 100 };
}

/** Which of RUN_FILES are in a listing of the run's folder → [{ ...file, object }]. */
export function presentRunFiles(names) {
  const set = new Set(names || []);
  const out = [];
  for (const f of RUN_FILES) {
    const object = set.has(f.name) ? f.name
      : f.prefix ? [...set].find((n) => n.startsWith(f.prefix) && n.endsWith(".xlsx")) : null;
    if (object) out.push({ ...f, object });
  }
  return out;
}

// ---------- loaders (Supabase) ----------

const rowsOf = (r) => { if (r.error) throw new Error(r.error.message || String(r.error)); return r.data || []; };

/** Every erp_pending audit, pipeline row and erp_audit request. fpx_invoice_pipeline may not exist yet. */
export async function loadRunInputs(sb) {
  const [audits, pipe, requests] = await Promise.all([
    sb.from("fpx_invoice_audits").select("id, created_at, date_from, date_to, run_by, total_rows")
      .eq("shipment_type", "erp_pending").order("created_at", { ascending: true }).limit(5000).then(rowsOf),
    sb.from("fpx_invoice_pipeline").select("*").limit(5000),
    sb.from("fpx_scrape_requests").select("id, status, requested_at, claimed_at, completed_at, requested_by, note, result_count")
      .eq("scope", "erp_audit").order("requested_at", { ascending: false }).limit(1000).then(rowsOf),
  ]);
  let pipelines = [];
  if (pipe.error) {
    if (!isMissingTable(pipe.error)) console.warn(`[FPX] invoice flow: fpx_invoice_pipeline not read (${pipe.error.message})`);
  } else pipelines = pipe.data || [];
  return { audits, pipelines, requests };
}

export async function loadRuns(sb) {
  const inputs = await loadRunInputs(sb);
  return { runs: buildRuns(inputs), requests: inputs.requests };
}

/** Counts by bucket (+ exported) and the not-exported charge total, from the view. */
export async function loadCounts(sb) {
  const agg = await sb.from("fpx_erp_invoicing").select("bucket, count:shipment_id.count(), sum:charge.sum()");
  if (!agg.error && Array.isArray(agg.data)) return countsFromAggregate(agg.data);
  // Aggregates switched off in PostgREST: count each bucket, add up the charges page by page.
  const buckets = [...NOT_EXPORTED_STATUSES, "exported"];
  const counted = await Promise.all(buckets.map((b) =>
    sb.from("fpx_erp_invoicing").select("shipment_id", { count: "exact", head: true }).eq("bucket", b)));
  const out = { charge_total: 0 };
  buckets.forEach((b, i) => {
    if (counted[i].error) throw new Error(counted[i].error.message);
    out[b] = counted[i].count || 0;
  });
  const pending = NOT_EXPORTED_STATUSES.reduce((s, b) => s + out[b], 0);
  let charge = 0;
  for (let from = 0; from < pending && from < 200_000; from += 1000) {
    const page = rowsOf(await sb.from("fpx_erp_invoicing").select("shipment_id, charge")
      .in("bucket", NOT_EXPORTED_STATUSES).order("shipment_id", { ascending: true }).range(from, from + 999));
    for (const r of page) charge += Number(r.charge) || 0;
    if (page.length < 1000) break;
  }
  out.charge_total = Math.round(charge * 100) / 100;
  return out;
}

/** When the not-exported report was last emailed: a run's report_emailed_at or a manual send in the audit log. */
export async function lastEmailedAt(sb, runs) {
  let best = null;
  for (const r of runs || []) if (r.report_emailed_at && (!best || r.report_emailed_at > best)) best = r.report_emailed_at;
  try {
    const { data, error } = await sb.from("fpx_audit_log").select("created_at, metadata")
      .eq("action", "invoice_report_email").order("created_at", { ascending: false }).limit(10);
    if (!error) {
      const sent = (data || []).find((r) => r.metadata?.sent === true);
      if (sent?.created_at && (!best || sent.created_at > best)) best = sent.created_at;
    }
  } catch { /* the runs' time stands */ }
  return best;
}

const VIEW_COLUMNS = "shipment_id, bucket, customer_name, carrier, tracking_number, shipped_date, charge, cost, approved_invoice_number, approved_by, last_seen_at";

/** The shipment ids a search matches (base tables, like GET /audits/erp/invoicing?q=), not exported. */
async function searchIds(sb, q, cap = 1000) {
  const plan = searchPlan(q, { cap });
  if (plan.kind === "empty") return [];
  const direct = plan.tx.length
    ? sb.from("fpx_erp_transactions").select("shipment_id").or(ilikeAny(plan.tx, plan.term))
      .not("exported_to_erp", "is", true).order("charge", { ascending: false, nullsFirst: false }).limit(cap).then(rowsOf)
    : Promise.resolve([]);
  const viaApprovals = plan.approvals.length
    ? sb.from("fpx_audit_approvals").select("tracking_key").or(ilikeAny(plan.approvals, plan.term))
      .not("tracking_key", "is", null).limit(cap).then(rowsOf)
      .then(async (rows) => {
        const keys = [...new Set(rows.map((r) => r.tracking_key).filter(Boolean))].slice(0, cap);
        const parts = await Promise.all(chunk(keys).map((part) =>
          sb.from("fpx_erp_transactions").select("shipment_id").in("tracking_key", part).then(rowsOf)));
        return parts.flat();
      })
    : Promise.resolve([]);
  const [a, b] = await Promise.all([direct, viaApprovals]);
  return mergeIds([a.map((r) => r.shipment_id), b.map((r) => r.shipment_id)], cap).ids;
}

/** For a page of shipments: which have saved invoice documents, and the audit of their last pull. */
export async function pageLookups(sb, ids) {
  if (!ids.length) return { docsSaved: new Set(), lastPull: new Map() };
  const [records, docs, tx] = await Promise.all([
    sb.from("fpx_shipment_records").select("shipment_id, files").eq("kind", "invoice").in("shipment_id", ids).then(rowsOf),
    sb.from("fpx_invoice_documents").select("shipment_id").in("shipment_id", ids).limit(5000).then(rowsOf),
    sb.from("fpx_erp_transactions").select("shipment_id, last_pull_audit_id").in("shipment_id", ids).then(rowsOf),
  ]);
  const docsSaved = new Set();
  for (const r of records) if (Array.isArray(r.files) && r.files.length) docsSaved.add(String(r.shipment_id));
  for (const d of docs) docsSaved.add(String(d.shipment_id));
  const lastPull = new Map(tx.filter((t) => t.last_pull_audit_id).map((t) => [String(t.shipment_id), t.last_pull_audit_id]));
  return { docsSaved, lastPull };
}

/**
 * One page of the all-time not-exported list, biggest charge first.
 * `counts` (from loadCounts) gives the total without a count query when there
 * is no search. → { rows: view rows, total }
 */
export async function loadNotExportedPage(sb, { status = "all", q = "", limit = 50, offset = 0, counts = null } = {}) {
  const buckets = status === "all" ? NOT_EXPORTED_STATUSES : [status];
  if (q) {
    const ids = await searchIds(sb, q);
    const found = (await Promise.all(chunk(ids).map((part) =>
      sb.from("fpx_erp_invoicing").select(VIEW_COLUMNS).in("shipment_id", part).in("bucket", buckets).then(rowsOf)))).flat();
    found.sort(compareRows);
    return { rows: found.slice(offset, offset + limit), total: found.length };
  }
  const { data, error, count } = await sb.from("fpx_erp_invoicing")
    .select(VIEW_COLUMNS, counts ? undefined : { count: "exact" })
    .in("bucket", buckets)
    .order("charge", { ascending: false, nullsFirst: false })
    .order("shipment_id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  const total = counts ? buckets.reduce((s, b) => s + (counts[b] || 0), 0) : (count ?? (data || []).length);
  return { rows: data || [], total };
}

/** Every object name in a Storage folder (paged). */
export async function listFolder(sb, prefix, { max = 20_000 } = {}) {
  const names = [];
  for (let offset = 0; offset < max; offset += 1000) {
    const { data, error } = await sb.storage.from(ERP_BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(error.message);
    // Folders come back with no id.
    for (const o of data || []) if (o?.name && o.id !== null) names.push(o.name);
    if (!data || data.length < 1000) break;
  }
  return names;
}

/** A run's Excel files with 1-hour signed links, and how many documents were saved for it. */
export async function loadRunFiles(sb, run) {
  const id = run.audit_id;
  const [top, docs] = await Promise.all([
    listFolder(sb, id, { max: 1000 }).catch(() => []),
    listFolder(sb, `${id}/invoices`).catch(() => []),
  ]);
  const day = (v) => String(v || "").slice(0, 10).replace(/[^0-9A-Za-z-]/g, "");
  const range = day(run.date_from) && day(run.date_to) ? `-${day(run.date_from)}_to_${day(run.date_to)}` : "";
  const files = [];
  for (const f of presentRunFiles(top)) {
    try {
      const { data, error } = await sb.storage.from(ERP_BUCKET)
        .createSignedUrl(`${id}/${f.object}`, 3600, { download: `${f.download}-run-${run.run_number}${range}.xlsx` });
      if (!error && data?.signedUrl) files.push({ name: f.name, label: f.label, url: data.signedUrl });
    } catch { /* that file is left out */ }
  }
  return { files, docs_count: docs.length };
}

/** Every saved document of a run, from erp-pulls/<audit_id>/invoices/*, as zip entries. */
export async function loadRunDocuments(sb, auditId, { concurrency = 6, max = MAX_ZIP_FILES } = {}) {
  const names = await listFolder(sb, `${auditId}/invoices`);
  if (names.length > max) return { tooMany: names.length, entries: [], missing: [] };
  const entries = [];
  const missing = [];
  for (let i = 0; i < names.length; i += concurrency) {
    await Promise.all(names.slice(i, i + concurrency).map(async (name) => {
      try {
        const { data, error } = await sb.storage.from(ERP_BUCKET).download(`${auditId}/invoices/${name}`);
        if (error || !data) throw new Error(error?.message || "not found");
        entries.push({ name, data: Buffer.from(await data.arrayBuffer()) });
      } catch (e) {
        missing.push(`${name} (${e?.message || e})`);
      }
    }));
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, missing, tooMany: 0 };
}

/**
 * Queues an ERP pull (an erp_audit request), the same row POST
 * /api/ops/rescrape {scope:"erp_audit"} inserts. Only one at a time:
 * → { conflict: message } when one is queued or running, else { request }.
 */
export async function queueErpPull(sb, { months, shipmentType, requestedBy = null }) {
  const busy = rowsOf(await sb.from("fpx_scrape_requests").select("id, status")
    .eq("scope", "erp_audit").in("status", ["pending", "claimed"]).limit(1));
  if (busy[0]) {
    return { conflict: busy[0].status === "pending" ? "A pull is already queued" : "A pull is already running" };
  }
  const { data, error } = await sb.from("fpx_scrape_requests")
    .insert({ scope: "erp_audit", note: pullNote(months, shipmentType), requested_by: requestedBy })
    .select().single();
  if (error) throw new Error(error.message);
  return { request: data };
}
