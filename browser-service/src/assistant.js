import Anthropic from "@anthropic-ai/sdk";
import { freshness } from "./freshness.js";

// "Ask FPX" — an ops assistant for the dashboard, on the Claude API.
//
// Two kinds of tools:
//   * data tools  — run here against Supabase (read-only): what to focus on,
//                   search shipments, one shipment's detail, a summary.
//   * UI tools    — not executed here; collected and returned to the browser,
//                   which performs them (navigate, filter the Tracking list,
//                   open a shipment or task drawer).
//
// The browser keeps the conversation and sends it back each turn exactly as
// returned (append-only — required so thinking blocks stay valid).

// Sonnet 5.5: fast and about half Opus's price — right for a chat that
// mostly looks things up. ASSISTANT_MODEL=claude-opus-5-5 switches back.
const MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";
const MAX_STEPS = 8;              // tool round-trips per user message
const OFF_DASHBOARD_MS = 24 * 3600_000;

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const assistantEnabled = !!(process.env.ANTHROPIC_API_KEY && SB_URL && SB_KEY);

const client = assistantEnabled ? new Anthropic() : null;

// Every read has a deadline. Before, fetch() had none: one slow query (the
// DISTINCT ON view fpx_shipments_latest filtered by a non-key column, or an
// ilike over it) left the chat waiting with "Searching…" on screen forever.
const SB_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 12_000;      // per tool call; the model gets an error result to explain
const CLAUDE_TIMEOUT_MS = 90_000;    // per model request (streaming)
const TURN_DEADLINE_MS = 150_000;    // a whole question, all steps together

function timeoutError(what, ms) {
  const e = new Error(`${what} timed out after ${Math.round(ms / 1000)} s`);
  e.timeout = true;
  return e;
}

async function sbFetch(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw timeoutError("Database read", timeoutMs);
    throw e;
  }
}

async function sb(pathAndQuery, timeoutMs = SB_TIMEOUT_MS) {
  const res = await sbFetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  }, timeoutMs);
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function sbPost(path, body, prefer, timeoutMs = SB_TIMEOUT_MS) {
  const res = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(prefer ? { prefer } : {}) },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Resolves with the promise, or rejects after ms (the work itself is left to
// finish or hit its own fetch deadline).
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(what, ms)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const enc = encodeURIComponent;
const trim = (s, n = 280) => (s == null ? null : String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

// Shipments count as "on the FreightPOP dashboard" when seen within 24h of
// the newest scrape (FreightPOP drops delivered shipments; archiving only
// happens after a complete sweep, so the table holds many stale rows).
let cutoffCache = { at: 0, value: null };
async function dashboardCutoff() {
  if (Date.now() - cutoffCache.at < 60_000) return cutoffCache.value;
  // The base table, not fpx_shipments_latest: ordering the DISTINCT ON view
  // sorts every row first; the newest scraped_at is the same either way.
  const rows = await sb("fpx_shipments?select=scraped_at&scraped_at=not.is.null&order=scraped_at.desc&limit=1");
  const newest = rows?.[0]?.scraped_at ? Date.parse(rows[0].scraped_at) : Date.now();
  cutoffCache = { at: Date.now(), value: new Date(newest - OFF_DASHBOARD_MS).toISOString() };
  return cutoffCache.value;
}

const SHIP_COLS = "id,shipment_id,tracking_number,customer_name,carrier_name,carrier,mode,shipment_status,action_required,ai_issue,ai_recommendation,updated_eta,estimated_arrival,delivery_date,appointment_date,destination,scraped_at";

function compactShipment(s) {
  return {
    id: s.id,                         // internal id — use for open_shipment
    shipment: s.shipment_id,          // FreightPOP shipment number
    tracking: s.tracking_number,
    customer: s.customer_name,
    carrier: s.carrier_name || s.carrier,
    mode: s.mode,
    status: s.shipment_status,
    action_needed: s.action_required === "YES",
    issue: trim(s.ai_issue, 220),
    eta: s.updated_eta || s.estimated_arrival || null,
    delivered: s.delivery_date || null,
    appointment: s.appointment_date || null,
    destination: s.destination,
    last_seen: s.scraped_at,
  };
}

// ---------------- data tools ----------------

async function toolFocusList({ limit = 40, assignee } = {}) {
  const cutoff = await dashboardCutoff();
  const tasks = await sb(
    `fpx_shipment_tasks?select=id,shipment_id,tracking_number,title,status,assigned_to,created_at,due_at` +
    `&archived_at=is.null&status=in.(open,in_progress,blocked)&order=created_at.asc&limit=1000` +
    (assignee ? `&assigned_to=ilike.*${enc(assignee)}*` : ""),
  );
  const ids = [...new Set(tasks.map((t) => t.shipment_id).filter(Boolean))];
  const ships = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    for (const s of await sb(`fpx_shipments?select=${SHIP_COLS}&id=in.(${chunk.join(",")})`)) ships.set(s.id, s);
  }
  const rows = tasks
    .map((t) => ({ t, s: ships.get(t.shipment_id) }))
    .filter(({ s }) => !s || !s.scraped_at || s.scraped_at >= cutoff);  // drop shipments that left the dashboard
  // A cheap pre-rank so the model sees the likeliest candidates first; the
  // model makes the real call from the facts.
  const now = Date.now();
  const score = ({ t, s }) => {
    let x = 0;
    if (s?.action_required === "YES") x += 40;
    if (s?.shipment_status === "Issue") x += 30;
    const eta = Date.parse(s?.updated_eta || s?.estimated_arrival || "");
    if (Number.isFinite(eta) && eta < now && !s?.delivery_date) x += 25;
    if (t.status === "blocked") x += 10;
    x += Math.min(20, (now - Date.parse(t.created_at)) / 86_400_000 * 2);
    return x;
  };
  rows.sort((a, b) => score(b) - score(a));
  return {
    open_tasks_on_dashboard: rows.length,
    left_dashboard_excluded: tasks.length - rows.length,
    candidates: rows.slice(0, Math.min(60, limit)).map(({ t, s }) => ({
      task_id: t.id, task: trim(t.title, 160), task_status: t.status, assigned_to: t.assigned_to,
      task_age_days: Math.round((now - Date.parse(t.created_at)) / 86_400_000 * 10) / 10,
      shipment: s ? compactShipment(s) : { tracking: t.tracking_number },
    })),
  };
}

async function toolSearchShipments({ query, status, action_needed, carrier, customer, include_off_dashboard = false, limit = 25 } = {}) {
  const parts = [`select=${SHIP_COLS}`, `order=scraped_at.desc`, `limit=${Math.min(50, limit)}`];
  if (!include_off_dashboard) parts.push(`scraped_at=gte.${enc(await dashboardCutoff())}`);
  if (status) parts.push(`shipment_status=ilike.${enc(status)}`);
  if (action_needed === true) parts.push("action_required=eq.YES");
  if (action_needed === false) parts.push("action_required=eq.NO");
  if (carrier) parts.push(`or=(carrier_name.ilike.*${enc(carrier)}*,carrier.ilike.*${enc(carrier)}*)`);
  if (customer) parts.push(`customer_name=ilike.*${enc(customer)}*`);
  if (query) {
    const q = enc(String(query).replace(/[(),*]/g, " ").trim());
    parts.push(`or=(tracking_number.ilike.*${q}*,shipment_id.ilike.*${q}*,customer_name.ilike.*${q}*,carrier_name.ilike.*${q}*,destination.ilike.*${q}*)`);
  }
  const rows = await sb(`fpx_shipments_latest?${parts.join("&")}`);
  return { count: rows.length, shipments: rows.map(compactShipment) };
}

async function toolGetShipment({ shipment, tracking, id } = {}) {
  let q;
  if (id) q = `id=eq.${enc(id)}`;
  else if (shipment) q = `shipment_id=eq.${enc(shipment)}`;
  else if (tracking) q = `tracking_number=eq.${enc(tracking)}`;
  else return { error: "Give shipment, tracking or id" };
  // The base table, newest read first. fpx_shipments_latest is DISTINCT ON
  // (tracking_number), so a shipment_id filter on it can't use an index and
  // sorts the whole table — this lookup is what hung for shipments that are
  // not in the assistant index (delivered / invoicing-stage ones).
  const rows = await sb(`fpx_shipments?select=${SHIP_COLS},ship_from,ship_to,origin,comments,tracking_comments,pickup_response&${q}&order=scraped_at.desc.nullslast&limit=1`);
  const s = rows[0];
  if (!s) return { error: "Not found (it may have been archived)" };
  const tasks = await sb(`fpx_shipment_tasks?select=id,title,status,assigned_to,created_at&shipment_id=eq.${s.id}&archived_at=is.null&order=created_at.desc&limit=10`);
  return {
    ...compactShipment(s),
    recommendation: trim(s.ai_recommendation, 400),
    origin: s.origin, ship_from: trim(s.ship_from, 120), ship_to: trim(s.ship_to, 120),
    tracking_comments: trim(s.tracking_comments, 300), pickup_response: trim(s.pickup_response, 160),
    on_dashboard: !s.scraped_at || s.scraped_at >= (await dashboardCutoff()),
    tasks: tasks.map((t) => ({ task_id: t.id, task: trim(t.title, 160), status: t.status, assigned_to: t.assigned_to, created_at: t.created_at })),
  };
}

async function toolSummary() {
  const cutoff = await dashboardCutoff();
  const rows = await sb(`fpx_shipments_latest?select=shipment_status,action_required,carrier_name&scraped_at=gte.${enc(cutoff)}&limit=5000`);
  const by = (k) => rows.reduce((m, r) => ((m[r[k] || "(none)"] = (m[r[k] || "(none)"] || 0) + 1), m), {});
  const carriers = Object.entries(rows.filter((r) => r.action_required === "YES")
    .reduce((m, r) => ((m[r.carrier_name || "(unknown)"] = (m[r.carrier_name || "(unknown)"] || 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { on_dashboard: rows.length, by_status: by("shipment_status"), action_needed: by("action_required").YES || 0, action_needed_by_carrier: Object.fromEntries(carriers) };
}

// ---------------- retrieval index (RAG) ----------------
// fpx_assistant_index holds one record per non-archived shipment (facts, open
// and closed tasks, all notes, tracking history), full-text + trigram
// searchable, with a precomputed focus score; on_dashboard marks the ones
// FreightPOP currently lists. Its text is split into ~1,000-character chunks
// in fpx_assistant_chunks and every chunk is embedded. Rebuilt in the database
// by fpx_assistant_reindex() every few minutes and after each scrape. Every
// lookup is then one indexed query instead of several round trips; the
// original queries above remain as the fallback.

const INDEX_STALE_MS = 30 * 60_000;
let indexState = { at: 0, ok: false, rows: 0, ms: 0 };

export async function reindexAssistant(reason = "timer") {
  if (!assistantEnabled) return null;
  const t0 = Date.now();
  try {
    const rows = await sbPost("rpc/fpx_assistant_reindex", {}, undefined, 150_000); // runs up to its 120 s statement_timeout
    indexState = { at: Date.now(), ok: true, rows: Number(rows) || 0, ms: Date.now() - t0 };
    focusCache = { at: 0, rows: null };
    if (reason !== "timer") console.log(`[assistant] index rebuilt (${reason}): ${indexState.rows} shipments in ${indexState.ms}ms`);
    // Embed whatever changed (runs in the background; no-op when nothing did).
    embedPending(reason).catch(() => {});
  } catch (e) {
    indexState = { ...indexState, ok: false };
    console.warn("[assistant] reindex failed:", e.message);
  }
  return indexState;
}

// ---- embeddings (Supabase edge function fpx-embed, built-in gte-small) ----
// After every rebuild, embed the records whose text changed. The function
// caps CPU per request, so it embeds ~5 per call and we loop (2 in parallel).
let embedState = { running: false, at: 0, embedded: 0, lastError: null };
const embedFn = (body, timeoutMs = 60_000) => sbFetch(`${SB_URL}/functions/v1/fpx-embed`, {
  method: "POST",
  headers: { apikey: SB_KEY, "content-type": "application/json" },
  body: JSON.stringify(body),
}, timeoutMs).then(async (r) => {
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`fpx-embed ${r.status}: ${j?.error || j?.message || ""}`);
  return j;
});

export async function embedPending(reason = "") {
  if (!assistantEnabled || embedState.running) return embedState;
  embedState = { ...embedState, running: true, lastError: null };
  const t0 = Date.now();
  let total = 0;
  try {
    // One caller, small batches: the edge function caps CPU per request and
    // answers 546 when a batch is too heavy — back off and retry rather than stop.
    let failures = 0;
    for (let i = 0; i < 1200 && Date.now() - t0 < 30 * 60_000; i++) {
      let r;
      try {
        r = await embedFn({ mode: "pending", limit: 3 });
        failures = 0;
      } catch (e) {
        if (++failures >= 5) throw e;
        await new Promise((res) => setTimeout(res, 2000 * failures));
        continue;
      }
      total += r.embedded || 0;
      if (!r.more) break;
    }
  } catch (e) {
    embedState.lastError = e.message;
    console.warn("[assistant] embedding stopped:", e.message);
  } finally {
    embedState = { ...embedState, running: false, at: Date.now(), embedded: total };
    if (total) console.log(`[assistant] embedded ${total} record(s)${reason ? ` (${reason})` : ""} in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  return embedState;
}

export function assistantIndexStatus() {
  return { index: indexState, embeddings: embedState };
}

// Semantic search only for real phrases — ids and short names are matched
// exactly/fuzzily without it (and skip the ~0.3s embedding call).
async function queryEmbedding(text) {
  const t = String(text || "").trim();
  if (t.length < 6 || /^[\d\s-]+$/.test(t) || t.split(/\s+/).length < 2) return null;
  try { return (await embedFn({ mode: "query", text: t }, 6_000)).embedding || null; } catch { return null; } // no embedding → keyword search only
}

export function startAssistantIndexer() {
  if (!assistantEnabled) return;
  setTimeout(() => reindexAssistant("startup"), 15_000);
  setInterval(() => reindexAssistant(), 5 * 60_000).unref();
}

const indexFresh = () => indexState.ok && Date.now() - indexState.at < INDEX_STALE_MS;

// All shipments with open tasks, best first (≈ a few hundred rows) — cached briefly.
let focusCache = { at: 0, rows: null };
async function indexFocusRows() {
  if (focusCache.rows && Date.now() - focusCache.at < 60_000) return focusCache.rows;
  const rows = await sb("fpx_assistant_index?select=facts,focus_score,on_dashboard&open_tasks=gt.0&order=focus_score.desc&limit=1000");
  focusCache = { at: Date.now(), rows };
  return rows;
}

// What the model needs to rank and act — keeps tool results small (cost + speed).
function slimFacts(f = {}) {
  return {
    id: f.id, shipment: f.shipment, tracking: f.tracking, customer: f.customer, carrier: f.carrier, mode: f.mode,
    status: f.status, action_needed: f.action_needed, issue: trim(f.issue, 160), eta: f.eta, delivered: f.delivered,
    appointment: f.appointment, destination: trim(f.destination, 60),
    latest_note: f.latest_note ? trim(f.latest_note.note, 120) : undefined,
    open_tasks: (f.tasks || []).length || undefined,
  };
}

async function ixFocusList({ limit = 20, assignee } = {}) {
  const rows = await indexFocusRows();
  const onDash = rows.filter((r) => r.on_dashboard);
  const who = assignee ? String(assignee).toLowerCase() : null;
  const picked = [];
  for (const r of onDash) {
    for (const t of r.facts.tasks || []) {
      if (who && !String(t.assigned_to || "").toLowerCase().includes(who)) continue;
      picked.push({ task_id: t.task_id, task: trim(t.task, 120), task_status: t.status, assigned_to: t.assigned_to, task_age_days: t.age_days, shipment: slimFacts(r.facts) });
    }
  }
  return {
    open_tasks_on_dashboard: picked.length,
    left_dashboard_excluded: rows.length - onDash.length,
    candidates: picked.slice(0, Math.min(40, limit)),
  };
}

async function ixSearch({ query, status, action_needed, carrier, customer, include_off_dashboard = false, limit = 12 } = {}) {
  const n = Math.min(30, limit);
  let list;
  if (query && String(query).trim()) {
    const embedding = await queryEmbedding(query);
    const rows = await sbPost("rpc/fpx_assistant_search", {
      p_query: String(query), p_include_off_dashboard: !!include_off_dashboard, p_limit: 50,
      p_embedding: embedding ? JSON.stringify(embedding) : null,
    });
    list = (rows || []).map((r) => r.facts);
  } else {
    const parts = ["select=facts", "order=focus_score.desc", "limit=200"];
    if (!include_off_dashboard) parts.push("on_dashboard=eq.true");
    if (status) parts.push(`status=ilike.${enc(status)}`);
    if (action_needed === true) parts.push("action_needed=eq.true");
    if (action_needed === false) parts.push("action_needed=eq.false");
    if (carrier) parts.push(`carrier=ilike.*${enc(carrier)}*`);
    if (customer) parts.push(`customer=ilike.*${enc(customer)}*`);
    list = (await sb(`fpx_assistant_index?${parts.join("&")}`)).map((r) => r.facts);
  }
  const lc = (v) => String(v || "").toLowerCase();
  list = list.filter((f) =>
    (!status || lc(f.status) === lc(status)) &&
    (action_needed == null || !!f.action_needed === action_needed) &&
    (!carrier || lc(f.carrier).includes(lc(carrier))) &&
    (!customer || lc(f.customer).includes(lc(customer))));
  return { count: list.length, shown: Math.min(n, list.length), shipments: list.slice(0, n).map(slimFacts) };
}

async function ixGetShipment(args = {}) {
  const { shipment, tracking, id } = args;
  const q = id ? `shipment_uuid=eq.${enc(id)}` : shipment ? `shipment_id=eq.${enc(shipment)}` : tracking ? `tracking_number=eq.${enc(tracking)}` : null;
  if (!q) return { error: "Give shipment, tracking or id" };
  const rows = await sb(`fpx_assistant_index?select=facts&${q}&limit=1`);
  if (rows?.[0]) return rows[0].facts;
  return toolGetShipment(args); // not on the dashboard and no open tasks → original lookup
}

async function ixSummary() {
  // Counted in the database — a plain select is capped at 1,000 rows.
  try {
    const s = await sbPost("rpc/fpx_assistant_summary", {});
    if (s && typeof s.on_dashboard === "number") {
      return { ...s, action_needed_by_carrier: Object.fromEntries(Object.entries(s.action_needed_by_carrier || {}).sort((a, b) => b[1] - a[1]).slice(0, 8)) };
    }
  } catch { /* fall through to the row count */ }
  const rows = await sb("fpx_assistant_index?select=status,action_needed,carrier&on_dashboard=eq.true&limit=5000");
  const by = {};
  const carriers = {};
  for (const r of rows) {
    const k = r.status || "(none)"; by[k] = (by[k] || 0) + 1;
    if (r.action_needed) carriers[r.carrier || "(unknown)"] = (carriers[r.carrier || "(unknown)"] || 0) + 1;
  }
  return {
    on_dashboard: rows.length, by_status: by,
    action_needed: rows.filter((r) => r.action_needed).length,
    action_needed_by_carrier: Object.fromEntries(Object.entries(carriers).sort((a, b) => b[1] - a[1]).slice(0, 8)),
  };
}

// Index first; the original live queries if the index is stale or errors.
const withFallback = (ix, live) => async (args) => {
  if (indexFresh()) {
    try { return await ix(args); } catch (e) { console.warn("[assistant] index lookup failed, using live data:", e.message); }
  }
  return live(args);
};

const DATA_TOOLS = {
  focus_list: withFallback(ixFocusList, toolFocusList),
  search_shipments: withFallback(ixSearch, toolSearchShipments),
  get_shipment: withFallback(ixGetShipment, toolGetShipment),
  dashboard_summary: withFallback(ixSummary, toolSummary),
  get_invoice_record: toolInvoiceRecord,
  search_invoice_documents: toolSearchInvoiceDocuments,
};

// Tools that read several tables get a longer deadline than the default.
const TOOL_TIMEOUTS = { get_invoice_record: 20_000, search_invoice_documents: 15_000 };

// ---------------- invoice / shipment analysis ----------------
// Everything FPX holds about one shipment's money and paperwork, by its
// FreightPOP shipment number. Every read is an eq on a key or an indexed
// column — never an ilike on fpx_erp_transactions or the fpx_erp_invoicing
// view (which joins ~48k transactions to ~22k approvals and times out).

const TX_COLS = "shipment_id,tracking_number,tracking_key,customer_name,carrier,service,status,shipped_date,charge,cost,gross_profit,approved_invoice_amount,invoice_approved_date,not_approved_invoice_amount,billing_invoice_number,exported_to_erp,first_seen_at,last_seen_at,last_pull_audit_id,quote_id:data->>QuoteID";
const APPROVAL_COLS = "approval_key,invoice_number,invoice_amount,approved_date,approved_by,approved_by_kind,exported_date,variance,notes,last_seen_at";
const DOC_COLS = "doc_type,file,invoice_number,invoice_date,carrier,tracking_number,bol_number,po_number,total,subtotal,fuel_surcharge,accessorial_total,line_items,summary,confidence,warnings,extracted_at";
const DETAIL_COLS = "sale,cost,gross_profit,financials_source,quote_id,quote_number,quote_freight,quote_fuel,quote_accessorial_total,quote_total,quote_accessorials,carrier,tracking_number,po_number,so_number,captured_at";
const TRACK_COLS = "id,shipment_status,carrier_name,tracking_number,customer_name,scraped_at,archived_at";

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const newest = (rows, key) => rows.map((r) => r?.[key]).filter(Boolean).sort().pop() || null;

// Where the invoice stands, in plain words — same rule as fpx_erp_invoicing.bucket.
function invoiceStage(tx, approvals) {
  if (!tx) return { stage: "not_in_erp_report", words: "Not in the ERP transactions report FPX pulled" };
  if (tx.exported_to_erp === true) return { stage: "pushed_to_erp", words: "Pushed to the ERP" };
  if (approvals.length || (num(tx.approved_invoice_amount) || 0) !== 0) return { stage: "approved", words: "Carrier invoice approved — not pushed to the ERP yet" };
  if ((num(tx.not_approved_invoice_amount) || 0) !== 0) return { stage: "not_approved", words: "Carrier invoice received but not approved" };
  return { stage: "waiting_for_carrier_invoice", words: "Waiting for the carrier invoice" };
}

async function toolInvoiceRecord({ shipment_id } = {}) {
  const id = String(shipment_id || "").trim();
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) return { error: "Give the FreightPOP shipment number, e.g. 15631966" };
  const e = enc(id);
  const errors = [];
  const settle = async (label, p, fallback) => {
    try { return await p; } catch (err) { errors.push(`${label}: ${err.message}`); return fallback; }
  };
  const [txRows, detailRows, trackRows, docRows, history] = await Promise.all([
    settle("ERP transactions", sb(`fpx_erp_transactions?select=${TX_COLS}&shipment_id=eq.${e}&limit=1`, 8_000), []),
    settle("shipment details", sb(`fpx_shipment_details?select=${DETAIL_COLS}&shipment_id=eq.${e}&limit=1`, 8_000), []),
    settle("tracking", sb(`fpx_shipments?select=${TRACK_COLS}&shipment_id=eq.${e}&order=scraped_at.desc.nullslast&limit=1`, 8_000), []),
    settle("documents", sb(`fpx_invoice_documents?select=${DOC_COLS}&shipment_id=eq.${e}&status=eq.done&order=extracted_at.desc.nullslast&limit=12`, 8_000), []),
    settle("change history", sb(`fpx_scrape_history?select=source,event,scraped_at,changes&source=in.(erp_transactions,shipment_details)&entity_key=eq.${e}&order=scraped_at.desc&limit=10`, 8_000), []),
  ]);
  const tx = txRows?.[0] || null;
  const det = detailRows?.[0] || null;
  const trk = trackRows?.[0] || null;
  const docs = docRows || [];
  const approvals = tx?.tracking_key
    ? await settle("approvals", sb(`fpx_audit_approvals?select=${APPROVAL_COLS}&tracking_key=eq.${enc(tx.tracking_key)}&order=approved_date.desc.nullslast,last_seen_at.desc&limit=10`, 8_000), [])
    : [];
  const approvalHistory = approvals.length
    ? await settle("approval history", sb(`fpx_scrape_history?select=source,entity_key,event,scraped_at,changes&source=eq.audit_approvals&entity_key=in.(${approvals.map((a) => `"${String(a.approval_key).replace(/"/g, "")}"`).map(enc).join(",")})&order=scraped_at.desc&limit=10`, 8_000), [])
    : [];

  if (!tx && !det && !trk && !docs.length) {
    return { shipment_id: id, found: false, errors: errors.length ? errors : undefined,
      note: errors.length ? "Some reads failed (see errors) — say so; the shipment may exist." : "FPX has no ERP, shipment details, tracking or document record for this shipment number." };
  }

  const charge = num(tx?.charge), cost = num(tx?.cost);
  const gp = num(tx?.gross_profit) ?? (charge != null && cost != null ? charge - cost : null);
  const approved = num(tx?.approved_invoice_amount);
  const customerInvoices = docs.filter((d) => d.doc_type === "invoice" && num(d.total) != null);
  const checks = [];
  if (approved != null && approved !== 0 && cost != null && Math.abs(approved - cost) >= 0.01) {
    checks.push({ check: "approved_carrier_amount_vs_cost", ok: false, approved_carrier_amount: approved, freightpop_cost: cost, difference: round2(approved - cost) });
  } else if (approved != null && approved !== 0 && cost != null) {
    checks.push({ check: "approved_carrier_amount_vs_cost", ok: true });
  }
  // The invoice FPX saved is the one sent to the customer: check it against the charge.
  for (const d of customerInvoices) {
    const total = num(d.total);
    if (charge != null) checks.push({ check: "customer_invoice_total_vs_charge", file: d.file, invoice_number: d.invoice_number, ok: Math.abs(total - charge) < 0.01, invoice_total: total, charge, difference: round2(total - charge) });
  }
  if (det && charge != null && num(det.sale) != null && Math.abs(num(det.sale) - charge) >= 0.01) {
    checks.push({ check: "shipment_details_sale_vs_erp_charge", ok: false, shipment_details_sale: num(det.sale), erp_charge: charge, difference: round2(num(det.sale) - charge) });
  }
  // Reference numbers the documents carry vs. what FreightPOP holds.
  const refs = { tracking: tx?.tracking_number || trk?.tracking_number || det?.tracking_number || null, po: det?.po_number || null };
  const norm = (v) => String(v || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  for (const d of docs) {
    if (d.tracking_number && refs.tracking) checks.push({ check: "document_pro_matches_tracking", file: d.file, ok: norm(d.tracking_number) === norm(refs.tracking), document: d.tracking_number, freightpop: refs.tracking });
    if (d.po_number && refs.po) checks.push({ check: "document_po_matches", file: d.file, ok: norm(d.po_number) === norm(refs.po), document: d.po_number, freightpop: refs.po });
  }

  const fresh = freshness({
    tracking: trk?.scraped_at || null,
    erp_transactions: tx?.last_seen_at || null,
    ...(approvals.length ? { audit_approvals: newest(approvals, "last_seen_at") } : {}),
    shipment_details: det?.captured_at || null,
    documents: newest(docs, "extracted_at"),
  });
  const quoteId = tx?.quote_id || det?.quote_id || null;

  return {
    shipment_id: id,
    found: true,
    status: invoiceStage(tx, approvals),
    // For open_in_freightpop (FreightPOP's Shipment Details needs the quote id).
    quote_id: quoteId,
    tracking_internal_id: trk?.id || null, // for open_shipment
    customer: tx?.customer_name || trk?.customer_name || null,
    carrier: tx?.carrier || trk?.carrier_name || det?.carrier || null,
    money: {
      charge, cost, gross_profit: round2(gp),
      margin_pct: charge ? round2((gp / charge) * 100) : null,
      approved_carrier_amount: approved, not_approved_carrier_amount: num(tx?.not_approved_invoice_amount),
    },
    erp_transaction: tx ? { ...tx, tracking_key: undefined, quote_id: undefined } : null,
    approvals: approvals.map((a) => ({ ...a, notes: trim(a.notes, 300) })),
    shipment_details: det ? { ...det, quote_accessorials: (det.quote_accessorials || []).slice(0, 15) } : null,
    tracking: trk ? { status: trk.shipment_status, carrier: trk.carrier_name, tracking_number: trk.tracking_number, scraped_at: trk.scraped_at, archived_at: trk.archived_at } : null,
    documents: docs.map((d) => ({
      ...d,
      line_items: Array.isArray(d.line_items) ? d.line_items.slice(0, 15) : d.line_items,
      summary: trim(d.summary, 400),
    })),
    checks,
    recent_changes: [...(history || []), ...approvalHistory]
      .sort((a, b) => String(b.scraped_at).localeCompare(String(a.scraped_at))).slice(0, 10)
      .map((h) => ({ ...h, changes: trim(JSON.stringify(h.changes), 400) })),
    freshness: fresh,
    errors: errors.length ? errors : undefined,
  };
}

async function toolSearchInvoiceDocuments({ q, limit = 10 } = {}) {
  const query = String(q || "").trim();
  if (!query) return { error: "Give something to search for" };
  const embedding = await queryEmbedding(query);
  const rows = await sbPost("rpc/fpx_invoice_documents_search", {
    p_query: query, p_embedding: embedding ? JSON.stringify(embedding) : null, p_limit: Math.min(20, Math.max(1, limit)),
  }, undefined, 12_000);
  return {
    count: (rows || []).length,
    documents: (rows || []).map((r) => ({
      shipment_id: r.doc?.shipment_id, doc_type: r.doc?.doc_type, invoice_number: r.doc?.invoice_number,
      carrier: r.doc?.carrier, total: r.doc?.total, summary: trim(r.doc?.summary, 240), score: Math.round((r.score || 0) * 100) / 100,
    })),
  };
}

// Pre-loaded brief for the first question of a conversation: the top focus
// items + dashboard counts, so "what should I focus on" needs no tool call.
async function preloadedBrief() {
  if (!indexFresh()) return null;
  try {
    // Never hold the question up for the brief: without it the model just calls a tool.
    const [focus, summary] = await withTimeout(Promise.all([ixFocusList({ limit: 8 }), ixSummary()]), 5_000, "Pre-loaded brief");
    // Lean: just what's needed to rank and say the next step (≈2–3k tokens).
    const slim = focus.candidates;
    return { built: new Date(indexState.at).toISOString(), dashboard: summary, open_tasks_on_dashboard: focus.open_tasks_on_dashboard, top_focus: slim };
  } catch { return null; }
}

// ---------------- UI tools (performed by the browser) ----------------

const UI_TOOLS = new Set(["open_shipment", "open_task", "filter_shipments", "navigate", "open_invoice", "open_in_freightpop"]);

const PAGES = ["tracking", "shipment_details", "tasks", "ops", "scraping", "notes", "analyses", "gp", "invoice", "invoices", "invoice_reading", "pushed", "send_invoices"];
const SHIPMENT_TABS = ["overview", "tasks", "email", "history", "intel", "freightpop"];

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: "focus_list",
    description: "Open tasks whose shipment is still on the FreightPOP dashboard, pre-ranked by urgency signals (action needed, Issue status, past-ETA undelivered, task age). Use for 'what should I focus on' questions. Returns candidates with their shipment facts.",
    input_schema: obj({
      limit: { type: "integer", description: "How many candidates (max 40). Default 20." },
      assignee: { type: "string", description: "Only tasks assigned to this person (email or name fragment)." },
    }),
  },
  {
    name: "search_shipments",
    description: "Search shipments on the FreightPOP dashboard by free text (tracking #, shipment #, customer, carrier, destination) and/or filters.",
    input_schema: obj({
      query: { type: "string" },
      status: { type: "string", description: "In Transit | Booked | Out For Delivery | Issue" },
      action_needed: { type: "boolean" },
      carrier: { type: "string" },
      customer: { type: "string" },
      include_off_dashboard: { type: "boolean", description: "Also search shipments that left the dashboard (usually delivered). Default false." },
      limit: { type: "integer", description: "Max 30. Default 12 — ask for more only if needed." },
    }),
  },
  {
    name: "get_shipment",
    description: "Full detail for one shipment (by FreightPOP shipment number, tracking number, or internal id), including its open tasks.",
    input_schema: obj({ shipment: { type: "string" }, tracking: { type: "string" }, id: { type: "string" } }),
  },
  {
    name: "dashboard_summary",
    description: "Counts of shipments on the dashboard by status, how many need action, and which carriers have the most action-needed shipments.",
    input_schema: obj({}),
  },
  {
    name: "open_shipment",
    description: "Open a shipment's detail drawer in the user's dashboard. Needs the internal id from a search/focus/get result. Set tab to land on one part of it: \"freightpop\" is the FreightPOP details tab (carrier, sale, cost, gross profit, quote breakdown).",
    input_schema: obj({ id: { type: "string" }, label: { type: "string", description: "e.g. the shipment number, for the confirmation chip" }, tab: { type: "string", enum: SHIPMENT_TABS, description: "Which drawer tab to show; omit for the overview" } }, ["id"]),
  },
  {
    name: "open_task",
    description: "Open a task in the dashboard's task walk.",
    input_schema: obj({ task_id: { type: "string" }, label: { type: "string" } }, ["task_id"]),
  },
  {
    name: "filter_shipments",
    description: "Show the Tracking page filtered. Set every filter you want in ONE call; omitted fields are cleared. For 'action needed' views set action to \"YES\". customer must be an exact customer name from results.",
    input_schema: obj({
      query: { type: "string", description: "Free-text search box (tracking #, shipment #, customer, carrier…)" },
      action: { type: "string", enum: ["YES", "NO", "ERROR"], description: "YES = action needed, NO = on track" },
      customer: { type: "string" },
    }),
  },
  {
    name: "navigate",
    description: "Go to a dashboard page. shipment_details: every shipment's sale, cost and gross profit read from FreightPOP. invoices: the Invoices hub (where each shipment's invoice stands; refresh ERP data there). invoice_reading: the invoice documents FPX has read. pushed: invoices pushed to the ERP. send_invoices: send customer invoices. scraping: the Scraping page, where tracking and shipment details reads are run.",
    input_schema: obj({ page: { type: "string", enum: PAGES } }, ["page"]),
  },
  {
    name: "get_invoice_record",
    description: "Everything FPX holds about one shipment's invoicing, by FreightPOP shipment number: ERP transaction (charge, cost, GP, approved/not-approved carrier amounts, pushed to ERP), carrier invoice approvals, invoice documents FPX read (totals, line items, PRO/BOL/PO), Shipment Details financials, the tracking row, recent changes, pre-computed checks, a plain-words status, and a freshness block saying how old each source is and whether it is stale. Use for any 'analyze / check / audit this shipment or invoice' question.",
    input_schema: obj({ shipment_id: { type: "string", description: "FreightPOP shipment number, e.g. 15631966" } }, ["shipment_id"]),
  },
  {
    name: "search_invoice_documents",
    description: "Search the invoice documents FPX has read (invoices, BOLs, rate confirmations) by invoice/PRO/BOL/PO number, carrier, bill-to, or a phrase like 'liftgate fee disputed'. Returns shipment numbers with document type, invoice number, total, summary.",
    input_schema: obj({ q: { type: "string" }, limit: { type: "integer", description: "Max 20. Default 10." } }, ["q"]),
  },
  {
    name: "open_invoice",
    description: "Open one shipment's panel on the Invoices page in the rep's dashboard.",
    input_schema: obj({ shipment_id: { type: "string", description: "FreightPOP shipment number" } }, ["shipment_id"]),
  },
  {
    name: "open_in_freightpop",
    description: "Open the shipment's Shipment Details page in FreightPOP itself (the rep's hosted FreightPOP window). Needs quote_id from get_invoice_record; pass charge and cost from it too when known.",
    input_schema: obj({
      shipment_id: { type: "string" },
      quote_id: { type: "string" },
      charge: { type: "number", description: "money.charge, when known" },
      cost: { type: "number", description: "money.cost, when known" },
      customer: { type: "string" },
    }, ["shipment_id", "quote_id"]),
  },
].map((t) => ({ ...t, strict: true }));

const SYSTEM = `You are "Ask FPX", the operations assistant inside the FPX Control Station dashboard used by FreightPOP's freight support team. Reps track customer shipments (LTL, truckload, parcel), follow up with carriers and customers, and work a queue of tasks the AI raises.

What you do:
- Tell the rep what to focus on, and why, in plain words. Lead with the few shipments that need a person today: action needed, Issue status, missed delivery appointments, out for delivery past ETA with no delivery, stale tasks. Say what to do next (call the carrier, update the customer, book an appointment).
- Find shipments and answer questions about them from the data tools. Never invent shipment facts; if the data doesn't say, say so.
- A shipment's \`financials\` (sale, cost, gross_profit, margin_pct, and the quote's freight, fuel and accessorials) were read from FreightPOP's own Shipment Details page at \`read_from_freightpop_at\`. A shipment with no \`financials\` has not been read yet: say that, and never estimate a sale, cost or profit. When the rep asks to see a shipment's sale, cost, gross profit, margin or quote, also open it with open_shipment and tab "freightpop"; for all shipments' figures, navigate to shipment_details.
- Drive the dashboard when it helps: open a shipment or task, filter the Tracking list, or go to a page. When the rep asks to see/open/show something, do it with the UI tools rather than only describing it. Opening is cheap — open the one they asked about. For a list, prefer filter_shipments.

Data notes:
- "On the dashboard" means seen in FreightPOP's dashboard grid recently. Shipments that left it are usually delivered; ignore them unless asked.
- Shipment numbers (e.g. 15665897) and tracking numbers are different identifiers. open_shipment and open_task need internal ids from tool results.
- Every open task is marked "high" priority, so priority alone doesn't rank anything — use the shipment facts.
- The first message of a conversation may carry a pre-loaded brief: dashboard counts and only the TOP 8 focus items. Answer "what should I focus on" / "how are we doing" from it directly. For anything else — a category ("stuck at a terminal", "waiting on appointments", a carrier, a customer), a specific shipment, or more than the top items — call search_shipments or focus_list; the brief is not the whole board.

Invoices and money ("analyze / check / audit this shipment", "what's going on with the invoice for 15631966"): call get_invoice_record with the shipment number (not get_shipment — an invoicing-stage shipment has usually left the tracking board). Answer as a short structured verdict, using only what it returns:
- **Status** — status.words, in plain words (waiting for carrier invoice / not approved / approved / pushed to ERP).
- **Money** — charge, cost, gross profit and margin; approved carrier amount vs FreightPOP cost; the customer invoice document total vs charge.
- **Documents** — what the documents FPX read say, and whether their PRO / BOL / PO match FreightPOP (see checks).
- **Doesn't line up** — every check with ok false, with the amounts and difference. Say "nothing" if all line up.
- **Freshness** — if freshness.any_stale, say it plainly, e.g. "ERP data last read 3 days ago — may be out of date", and offer to open the page that refreshes it (each stale source has refresh_page: invoices for ERP data/approvals, scraping for tracking and shipment details). If nothing is stale, one short line with the oldest read is enough.
Never invent a number. When a source has nothing (no ERP row, no documents, details never read), say so. If the result has errors, say which reads failed. Offer open_invoice (the Invoices page panel) and open_in_freightpop (needs quote_id — say it can't be opened in FreightPOP when quote_id is null); do them when the rep asks to see or open it.
- A tool result with an error (including "timed out") means that read failed: tell the rep in one line and answer from what did come back. Don't retry the same call more than once.

Links: the reply is rendered with Markdown links. Link every shipment you mention to its page in FPX — [15496050](/tracking/<id>) using the internal id from tool results — and tasks as [task](/tasks/v2/<task_id>). You may also use full https:// links that appear in the data. Never invent URLs.

Style: short and scannable — reps read this between calls. Default to under 120 words. For lists, at most 5 items, ONE line each: shipment number · customer · carrier — the problem — the next step. Offer "want more?" instead of listing everything. Use names and numbers, not internal ids. No preamble, no closing summary.`;

// One user turn. history: prior Anthropic.MessageParam[] exactly as returned
// by previous calls. Returns { messages, reply, actions, usage }.
// onEvent (optional) streams progress to the browser:
//   { type: "text", delta }      words of the answer as they're written
//   { type: "status", text }     a lookup is running ("Searching shipments…")
//   { type: "reset" }            discard the draft (the model went to look something up)
const STATUS = {
  focus_list: "Ranking open tasks…", search_shipments: "Searching shipments…",
  get_shipment: "Opening the shipment…", dashboard_summary: "Counting the dashboard…",
  get_invoice_record: "Reading the invoice record…", search_invoice_documents: "Searching invoice documents…",
};

// A stale source on an invoice record becomes a chip in the panel ("Data is
// N days old — open"). It is never performed automatically; the rep clicks it.
function addStaleAction(actions, rec) {
  const f = rec.freshness;
  const worst = Object.values(f.sources || {}).filter((s) => s.stale).sort((a, b) => (b.age_hours || 0) - (a.age_hours || 0))[0];
  if (!worst) return;
  const i = actions.findIndex((a) => a.type === "stale_data");
  if (i >= 0) actions.splice(i, 1);
  actions.push({
    type: "stale_data",
    shipment_id: rec.shipment_id,
    age_hours: worst.age_hours,
    sources: f.stale,
    label: worst.label,
    page: worst.refresh_page || "invoices",
  });
}

// signal (optional): aborted when the browser goes away — stops the model call.
export async function chat({ history = [], message, who, context, onEvent, signal }) {
  if (!assistantEnabled) throw new Error("Assistant not configured (ANTHROPIC_API_KEY / Supabase)");
  const t0 = Date.now();
  const messages = [...history];
  const ctx = context ? `\n\n[Dashboard context: ${trim(JSON.stringify(context), 600)}]` : "";
  // First question of a conversation: hand over the pre-loaded brief so the
  // common questions need no tool round trip.
  const brief = history.length === 0 ? await preloadedBrief() : null;
  const pre = brief ? `\n\n[Pre-loaded brief — current as of ${brief.built}; use it directly when it answers the question:\n${JSON.stringify(brief)}]` : "";
  messages.push({ role: "user", content: `${message}${ctx}${pre}` });
  const actions = [];
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, steps: 0, tools: [] };
  const done = (out) => { logChatCost({ who, message, reply: out.reply, usage, ms: Date.now() - t0, actions, preloaded: !!brief }); return out; };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) throw new Error("The browser closed the request");
    if (step > 0 && Date.now() - t0 > TURN_DEADLINE_MS) {
      return done({ messages, reply: "This is taking too long — some lookups were slow. Try again, or ask about one shipment at a time.", actions, usage, timedOut: true });
    }
    const params = {
      model: MODEL,
      max_tokens: 16000,
      // Opt-in server-side fallback if a request is declined by a safeguard.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      output_config: { effort: "low" }, // chat: fast, fewer tool calls
      system: `${SYSTEM}\n\nThe rep you're helping is ${who?.email || "a team member"}. Today is ${new Date().toISOString().slice(0, 10)}.`,
      tools: TOOLS,
      messages,
    };
    // A deadline per request (the SDK default is 10 minutes, retried twice —
    // long enough to look like a hang) and the browser's abort signal.
    const reqOpts = { timeout: CLAUDE_TIMEOUT_MS, maxRetries: 1, ...(signal ? { signal } : {}) };
    let response;
    if (onEvent) {
      const stream = client.beta.messages.stream(params, reqOpts);
      stream.on("text", (delta) => onEvent({ type: "text", delta }));
      response = await stream.finalMessage();
    } else {
      response = await client.beta.messages.create(params, reqOpts);
    }
    usage.input += response.usage?.input_tokens || 0;
    usage.output += response.usage?.output_tokens || 0;
    usage.cache_read += response.usage?.cache_read_input_tokens || 0;
    usage.cache_write += response.usage?.cache_creation_input_tokens || 0;
    usage.steps++;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      return done({ messages, reply: "I can't help with that one.", actions, usage });
    }
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") {
      const reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return done({ messages, reply, actions, usage });
    }

    // UI actions are recorded in order; data lookups run in parallel.
    const blocks = response.content.filter((b) => b.type === "tool_use");
    if (onEvent) {
      onEvent({ type: "reset" });
      const look = blocks.map((b) => STATUS[b.name]).filter(Boolean);
      if (look.length) onEvent({ type: "status", text: [...new Set(look)].join(" ") });
    }
    const results = await Promise.all(blocks.map(async (block) => {
      usage.tools.push(block.name);
      try {
        let out;
        if (UI_TOOLS.has(block.name)) {
          const action = { type: block.name, ...block.input };
          // Keep only the latest action of each kind (one filter, one open).
          const i = actions.findIndex((a) => a.type === action.type);
          if (i >= 0) actions.splice(i, 1);
          actions.push(action);
          out = { done: true, applied: block.input, note: "Applied in the rep's dashboard exactly as shown in `applied`. Don't call it again for the same request." };
        } else if (DATA_TOOLS[block.name]) {
          const ms = TOOL_TIMEOUTS[block.name] || TOOL_TIMEOUT_MS;
          try {
            out = await withTimeout(DATA_TOOLS[block.name](block.input || {}), ms, `Lookup ${block.name}`);
          } catch (e) {
            // Hand the model an error it can explain instead of failing the turn.
            console.warn(`[assistant] tool ${block.name} failed:`, e.message);
            return { type: "tool_result", tool_use_id: block.id, is_error: true, content: JSON.stringify({ error: e.message, timed_out: !!e.timeout }) };
          }
          if (block.name === "get_invoice_record" && out?.freshness?.any_stale) addStaleAction(actions, out);
        } else {
          out = { error: `Unknown tool ${block.name}` };
        }
        return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) };
      } catch (e) {
        return { type: "tool_result", tool_use_id: block.id, is_error: true, content: String(e.message || e) };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  return done({ messages, reply: "That took more steps than I allow per question — try narrowing it down.", actions, usage });
}


// ---------------- cost logging ----------------
// Every chat turn goes to the AI log (fpx_ai_analyses, subkind "ask_fpx"), so
// AI Governance shows Ask FPX usage and cost per person. Prices per 1M tokens
// for MODEL; cache reads bill at 10% of input, 5-minute cache writes at 125%.
const PRICES = {
  "claude-opus-5-5": { input: 4.0, output: 20.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
const PRICE = PRICES[MODEL] || PRICES["claude-opus-5-5"];

function chatCost(u) {
  return (u.input * PRICE.input + u.cache_read * PRICE.input * 0.1 + u.cache_write * PRICE.input * 1.25 + u.output * PRICE.output) / 1_000_000;
}

function logChatCost({ who, message, reply, usage, ms, actions, preloaded }) {
  const cost = chatCost(usage);
  sbPost("fpx_ai_analyses", {
    kind: "other",
    model: MODEL,
    user_message: trim(message, 4000),
    response_text: trim(reply, 8000),
    input_tokens: usage.input + usage.cache_read + usage.cache_write,
    output_tokens: usage.output,
    cost_usd: Math.round(cost * 1e6) / 1e6,
    duration_ms: ms,
    source: "fpx-browser",
    user_email: who?.email || null,
    metadata: {
      subkind: "ask_fpx",
      steps: usage.steps,
      tools: usage.tools,
      uncached_input_tokens: usage.input,
      cache_read_tokens: usage.cache_read,
      cache_write_tokens: usage.cache_write,
      actions: actions.map((a) => a.type),
      preloaded_brief: preloaded,
      index_fresh: indexFresh(),
    },
  }, "return=minimal").catch((e) => console.warn("[assistant] cost log failed:", e.message));
  usage.cost_usd = cost;
}

// ---------------- chat history ----------------
// One row per conversation in fpx_assistant_chats, per person. The server
// saves after every answer (the browser sends a chat id); people only ever
// read, list or delete their own.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HISTORY_BYTES = 1_500_000;

async function sbReq(method, path, body, prefer) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(prefer ? { prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function saveChatTurn({ chatId, email, message, reply, actions, messages }) {
  if (!assistantEnabled || !UUID_RE.test(String(chatId || "")) || !email) return;
  const owner = String(email).toLowerCase();
  const rows = await sbReq("GET", `fpx_assistant_chats?id=eq.${chatId}&select=user_email,turns,title`);
  const prev = rows?.[0];
  if (prev && prev.user_email !== owner) return; // never write into someone else's chat
  const turns = [...(prev?.turns || []), { role: "user", text: message }, { role: "assistant", text: reply, actions }];
  let history = messages || [];
  // Keep the transcript bounded; the oldest turns drop first (as in the panel).
  while (history.length > 2 && JSON.stringify(history).length > MAX_HISTORY_BYTES) history = history.slice(2);
  await sbReq("POST", "fpx_assistant_chats?on_conflict=id", {
    id: chatId, user_email: owner,
    title: prev?.title || trim(message.replace(/\s+/g, " "), 80),
    turns, history, turn_count: turns.length / 2, updated_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=minimal");
}

export async function listChats(email, limit = 40) {
  return sbReq("GET", `fpx_assistant_chats?user_email=eq.${enc(String(email).toLowerCase())}&select=id,title,turn_count,updated_at&order=updated_at.desc&limit=${Math.min(100, limit)}`);
}

export async function getChat(email, id) {
  if (!UUID_RE.test(String(id))) return null;
  const rows = await sbReq("GET", `fpx_assistant_chats?id=eq.${id}&user_email=eq.${enc(String(email).toLowerCase())}&select=id,title,turns,history,updated_at`);
  return rows?.[0] || null;
}

export async function deleteChat(email, id) {
  if (!UUID_RE.test(String(id))) return;
  await sbReq("DELETE", `fpx_assistant_chats?id=eq.${id}&user_email=eq.${enc(String(email).toLowerCase())}`, undefined, "return=minimal");
}
