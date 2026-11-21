// Shippers view — one dashboard per shipper (fpx_shipments.customer_name):
// tracking, tasks and Support Mailbox threads for all of a shipper's shipments.
//
// Read-only. Aggregates come from the rpc functions fpx_shipper_list /
// fpx_shipper_timeline (server/migrations/2026-11-20_shippers.sql); the
// per-shipper lists are plain PostgREST queries.
//
// Data facts this relies on (checked against the live DB 2026-11-20):
//   - fpx_shipment_tasks.shipment_id is a uuid FK to fpx_shipments.id
//     (so tasks are joined with an embedded fpx_shipments!inner(...) select).
//   - fpx_mailbox_links.shipment_id is text = fpx_shipments.shipment_id (no FK).
//   - fpx_shipments.action_required is text "YES" | "NO" (returned as boolean).
//   - task priorities in use: urgent | high (normal / medium / low also ranked).
//   - origin / destination are free text like
//     "Company, 435 Calvert Dr, Gallatin, TN, 37066, US," → "Gallatin, TN".

import { supabase as realSupabase } from "./supabase.js";

export const _deps = { supabase: realSupabase, now: () => new Date() };

export const NONE_KEY = "__none__";
export const NONE_LABEL = "(No shipper)";

const DAY = 86_400_000;
const OPEN_TASK_STATUSES = ["open", "in_progress", "blocked"];
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, medium: 2, low: 3 };
const SORTS = ["shipments", "name", "open_tasks", "exceptions", "awaiting_reply", "last_email"];
const SHIPMENT_STATUSES = ["active", "in_transit", "exceptions", "delivered", "all"];
const TASK_STATUSES = ["open", "done", "all"];
const EMAIL_STATUSES = ["all", "awaiting_reply", "responded"];
const PAGE = 1000; // PostgREST default max rows per request
const IN_CHUNK = 150; // ids per `in.(…)` filter, keeps URLs short

// ---------- errors ----------
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function dbError(what, error) {
  const msg = error && (error.message || error.details || error.hint);
  return new Error(`${what} failed${msg ? `: ${msg}` : ""}`);
}

// ---------- key <-> name ----------
function isNoneName(name) {
  return name == null || String(name).trim() === "" || name === NONE_LABEL;
}
export function shipperKey(name) {
  return isNoneName(name) ? NONE_KEY : encodeURIComponent(name);
}
export function shipperName(key) {
  if (key == null || key === "" || key === NONE_KEY) return NONE_LABEL;
  const s = String(key);
  // Express already decodes route params; decode again only when it still
  // looks encoded, and keep the raw value if it isn't valid encoding.
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { return decodeURIComponent(s); } catch { return s; }
  }
  return s;
}
function nameFromKey(key) {
  const name = shipperName(key);
  return name === NONE_LABEL ? null : name; // null → shipments with no shipper
}

// customer filter on fpx_shipments (or on the embedded table)
function whereCustomer(query, name, referencedTable) {
  const col = referencedTable ? `${referencedTable}.customer_name` : "customer_name";
  if (name == null) {
    return referencedTable
      ? query.or("customer_name.is.null,customer_name.eq.", { referencedTable })
      : query.or("customer_name.is.null,customer_name.eq.");
  }
  return query.eq(col, name);
}

// ---------- small helpers ----------
const int = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? 0 : Number(v));
const intOrNull = (v) => (v == null ? null : int(v));
function clampInt(v, def, max, min = 1) {
  if (v == null || v === "") return def;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
// strip characters that would break PostgREST or() / ilike syntax
function cleanQ(q) {
  return String(q || "").replace(/[,()"'\\%*:]/g, " ").replace(/\s+/g, " ").trim();
}
export function actionRequiredBool(v) {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

const titleCase = (t) => t.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

// "Company, 435 Calvert Dr, Gallatin, TN, 37066, US," → "Gallatin, TN"
export function cityState(raw) {
  if (raw == null) return null;
  const parts = String(raw).split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  // Packed "ARLINGTONTX76018" (city + state + zip, no separators).
  if (parts.length === 1) {
    const m = /^([A-Za-z][A-Za-z .'-]*?)\s*([A-Za-z]{2})\s*(\d{5}(?:-?\d{4})?)$/.exec(parts[0]);
    if (m) return `${titleCase(m[1].trim())}, ${m[2].toUpperCase()}`;
  }
  const isState = (p) => /^[A-Za-z]{2}$/.test(p);
  const isZip = (p) => /^\d{5}(-\d{4})?$/.test(p) || /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/.test(p);
  let idx = -1;
  for (let i = parts.length - 2; i >= 1; i--) {
    if (isState(parts[i]) && isZip(parts[i + 1])) { idx = i; break; }
  }
  if (idx < 0) {
    for (let i = parts.length - 1; i >= 1; i--) {
      if (!isState(parts[i])) continue;
      if (i === parts.length - 1 && /^(us|ca|mx)$/i.test(parts[i]) && parts.length > 2) continue;
      idx = i; break;
    }
  }
  if (idx >= 1) return `${parts[idx - 1]}, ${parts[idx].toUpperCase()}`;
  return parts.join(", ");
}

// page through a query builder factory until fewer than PAGE rows come back
async function fetchAll(makeQuery, what, maxPages = 40) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await makeQuery().range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw dbError(what, error);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// ---------- list ----------
function toShipperRow(r, includeEmail) {
  const name = isNoneName(r.customer_name) ? NONE_LABEL : r.customer_name;
  return {
    key: shipperKey(name),
    customer_name: name,
    shipments: int(r.shipments),
    active: int(r.active),
    in_transit: int(r.in_transit),
    delivered_30d: int(r.delivered_30d),
    exceptions: int(r.exceptions),
    last_scraped_at: r.last_scraped_at ?? null,
    last_pickup_date: r.last_pickup_date ?? null,
    open_tasks: int(r.open_tasks),
    overdue_tasks: int(r.overdue_tasks),
    email_threads: includeEmail ? int(r.email_threads) : null,
    awaiting_reply: includeEmail ? int(r.awaiting_reply) : null,
    last_email_at: includeEmail ? (r.last_email_at ?? null) : null,
  };
}

async function shipperRows(includeEmail) {
  const { data, error } = await _deps.supabase.rpc("fpx_shipper_list");
  if (error) throw dbError("Loading shippers", error);
  return (data || []).map((r) => toShipperRow(r, includeEmail));
}

const byName = (a, b) => a.customer_name.localeCompare(b.customer_name, undefined, { sensitivity: "base" });
const desc = (f) => (a, b) => (f(b) - f(a)) || byName(a, b);
const time = (v) => (v ? Date.parse(v) || 0 : 0);
const SORTERS = {
  shipments: desc((r) => r.shipments),
  name: byName,
  open_tasks: desc((r) => r.open_tasks),
  exceptions: desc((r) => r.exceptions),
  awaiting_reply: desc((r) => r.awaiting_reply ?? -1),
  last_email: desc((r) => time(r.last_email_at)),
};

export async function listShippers({ q, sort, includeEmail = true } = {}) {
  const s = sort || "shipments";
  if (!SORTS.includes(s)) throw httpError(400, `sort must be one of ${SORTS.join(", ")}`);
  let rows = await shipperRows(includeEmail);
  const needle = String(q || "").trim().toLowerCase();
  if (needle) rows = rows.filter((r) => r.customer_name.toLowerCase().includes(needle));
  rows.sort(SORTERS[s]);
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  return {
    shippers: rows,
    totals: {
      shippers: rows.length,
      shipments: sum((r) => r.shipments),
      active: sum((r) => r.active),
      open_tasks: sum((r) => r.open_tasks),
      exceptions: sum((r) => r.exceptions),
      awaiting_reply: includeEmail ? sum((r) => r.awaiting_reply || 0) : null,
    },
  };
}

// ---------- one shipper ----------
async function findShipper(key, includeEmail) {
  const name = shipperName(key);
  const rows = await shipperRows(includeEmail);
  const row = rows.find((r) => r.customer_name === name);
  if (!row || row.shipments === 0) throw httpError(404, `Shipper not found: ${name}`);
  return row;
}

function topCounts(rows, field, max) {
  const m = new Map();
  for (const r of rows) {
    const v = r[field] == null || String(r[field]).trim() === "" ? "Unknown" : String(r[field]).trim();
    m.set(v, (m.get(v) || 0) + 1);
  }
  const out = [...m].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return max ? out.slice(0, max) : out;
}

export async function getShipper(key, { includeEmail = true } = {}) {
  const shipper = await findShipper(key, includeEmail);
  const name = nameFromKey(key);
  const active = await fetchAll(
    () => whereCustomer(
      _deps.supabase.from("fpx_shipments").select("carrier_name, carrier, mode, shipment_status").is("archived_at", null),
      name,
    ).order("id", { ascending: true }),
    "Loading shipper shipments",
  );
  for (const r of active) if (!r.carrier_name && r.carrier) r.carrier_name = r.carrier;
  return {
    shipper,
    carriers: topCounts(active, "carrier_name", 8),
    modes: topCounts(active, "mode"),
    statuses: topCounts(active, "shipment_status"),
  };
}

// ---------- shipments ----------
const SHIPMENT_COLS = [
  "id", "shipment_id", "tracking_number", "shipment_status", "action_required", "carrier_name", "carrier", "mode",
  "origin", "destination", "pickup_date", "estimated_arrival", "updated_eta", "delivery_date", "scraped_at",
  "archived_at", "ai_issue",
].join(", ");

function applyShipmentStatus(query, status) {
  switch (status) {
    case "active": return query.is("archived_at", null);
    // Same rules as fpx_shipper_list (server/migrations/2026-11-20_shippers.sql).
    case "in_transit": return query.is("archived_at", null).or("shipment_status.ilike.*transit*,shipment_status.ilike.*out*delivery*");
    case "exceptions": return query.is("archived_at", null).ilike("action_required", "yes");
    // No "Delivered" status exists; a shipment that dropped off the FreightPOP
    // dashboard is the delivered signal.
    case "delivered": return query.or("delivery_date.not.is.null,shipment_status.ilike.*delivered*,archived_reason.eq.absent_from_dashboard");
    default: return query;
  }
}

async function openTaskCounts(ids) {
  const counts = new Map();
  const results = await Promise.all(chunk(ids, IN_CHUNK).map((part) => _deps.supabase.from("fpx_shipment_tasks").select("shipment_id")
    .in("shipment_id", part).in("status", OPEN_TASK_STATUSES).is("archived_at", null)));
  for (const { data, error } of results) {
    if (error) throw dbError("Loading task counts", error);
    for (const t of data || []) counts.set(t.shipment_id, (counts.get(t.shipment_id) || 0) + 1);
  }
  return counts;
}

async function liveLinks(shipmentIds, cols = "shipment_id, connection_id, conversation_id") {
  // Chunks run in parallel (a big shipper has ~15 chunks).
  const results = await Promise.all(chunk(shipmentIds, IN_CHUNK).map((part) =>
    _deps.supabase.from("fpx_mailbox_links").select(cols).in("shipment_id", part).eq("dismissed", false)));
  const out = [];
  for (const { data, error } of results) {
    if (error) throw dbError("Loading email links", error);
    out.push(...(data || []));
  }
  return out;
}

export async function getShipperShipments(key, { status = "active", q, limit, offset, includeEmail = true } = {}) {
  const st = status || "active";
  if (!SHIPMENT_STATUSES.includes(st)) throw httpError(400, `status must be one of ${SHIPMENT_STATUSES.join(", ")}`);
  const lim = clampInt(limit, 50, 200);
  const off = clampInt(offset, 0, 1_000_000, 0);
  const name = nameFromKey(key);

  let query = _deps.supabase.from("fpx_shipments").select(SHIPMENT_COLS, { count: "exact" });
  query = whereCustomer(query, name);
  query = applyShipmentStatus(query, st);
  const needle = cleanQ(q);
  if (needle) {
    const p = `*${needle}*`;
    query = query.or(["shipment_id", "tracking_number", "order_number", "reference_one"].map((c) => `${c}.ilike.${p}`).join(","));
  }
  const { data, error, count } = await query
    .order("pickup_date", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .range(off, off + lim - 1);
  if (error) throw dbError("Loading shipper shipments", error);
  const rows = data || [];

  const taskCounts = rows.length ? await openTaskCounts(rows.map((r) => r.id)) : new Map();
  let threadCounts = null;
  if (includeEmail) {
    threadCounts = new Map();
    const sids = [...new Set(rows.map((r) => r.shipment_id).filter(Boolean))];
    const links = sids.length ? await liveLinks(sids) : [];
    const seen = new Map();
    for (const l of links) {
      const set = seen.get(l.shipment_id) || new Set();
      set.add(`${l.connection_id}|${l.conversation_id}`);
      seen.set(l.shipment_id, set);
    }
    for (const [sid, set] of seen) threadCounts.set(sid, set.size);
  }

  return {
    total: count ?? rows.length,
    shipments: rows.map((r) => ({
      id: r.id,
      shipment_id: r.shipment_id ?? null,
      tracking_number: r.tracking_number ?? null,
      shipment_status: r.shipment_status ?? null,
      action_required: actionRequiredBool(r.action_required),
      carrier_name: r.carrier_name || r.carrier || null,
      mode: r.mode ?? null,
      origin: cityState(r.origin),
      destination: cityState(r.destination),
      pickup_date: r.pickup_date ?? null,
      estimated_arrival: r.estimated_arrival ?? r.updated_eta ?? null,
      delivery_date: r.delivery_date ?? null,
      scraped_at: r.scraped_at ?? null,
      archived_at: r.archived_at ?? null,
      ai_issue: r.ai_issue ?? null,
      open_tasks: taskCounts.get(r.id) || 0,
      email_threads: threadCounts ? (r.shipment_id ? threadCounts.get(r.shipment_id) || 0 : 0) : null,
    })),
  };
}

// ---------- tasks ----------
const TASK_COLS = "id, shipment_id, tracking_number, title, status, priority, assigned_to, due_at, created_at, completed_at, archived_at, fpx_shipments!inner(shipment_id, customer_name)";

function isOverdue(t, now) {
  return OPEN_TASK_STATUSES.includes(t.status) && !t.archived_at && !!t.due_at && Date.parse(t.due_at) < now;
}
export function compareTasks(a, b) {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const pa = PRIORITY_RANK[String(a.priority || "").toLowerCase()] ?? 4;
  const pb = PRIORITY_RANK[String(b.priority || "").toLowerCase()] ?? 4;
  if (pa !== pb) return pa - pb;
  const da = a.due_at ? Date.parse(a.due_at) : Infinity;
  const db = b.due_at ? Date.parse(b.due_at) : Infinity;
  if (da !== db) return da < db ? -1 : 1;
  return time(b.created_at) - time(a.created_at);
}

function taskQuery(name) {
  const q = _deps.supabase.from("fpx_shipment_tasks").select(TASK_COLS);
  return whereCustomer(q, name, "fpx_shipments");
}

export async function getShipperTasks(key, { status = "open", limit } = {}) {
  const st = status || "open";
  if (!TASK_STATUSES.includes(st)) throw httpError(400, `status must be one of ${TASK_STATUSES.join(", ")}`);
  const lim = clampInt(limit, 100, 200);
  const name = nameFromKey(key);
  const now = _deps.now().getTime();

  // open tasks are few; always load them all (they feed the counts too)
  const open = await fetchAll(
    () => taskQuery(name).in("status", OPEN_TASK_STATUSES).is("archived_at", null).order("created_at", { ascending: false }),
    "Loading shipper tasks",
  );
  const since = new Date(now - 30 * DAY).toISOString();
  const { count: done30, error: doneErr } = await whereCustomer(
    _deps.supabase.from("fpx_shipment_tasks").select("id, fpx_shipments!inner(customer_name)", { count: "exact", head: true }),
    name, "fpx_shipments",
  ).eq("status", "done").gte("completed_at", since);
  if (doneErr) throw dbError("Counting done tasks", doneErr);

  let closed = [];
  if (st !== "open") {
    let q = taskQuery(name);
    q = st === "done" ? q.eq("status", "done") : q.not("status", "in", `(${OPEN_TASK_STATUSES.join(",")})`);
    const { data, error } = await q
      .order(st === "done" ? "completed_at" : "created_at", { ascending: false, nullsFirst: false })
      .limit(lim);
    if (error) throw dbError("Loading shipper tasks", error);
    closed = data || [];
  }

  const shape = (t) => ({
    id: t.id,
    shipment_id: t.fpx_shipments?.shipment_id ?? null,
    tracking_number: t.tracking_number ?? null,
    title: t.title || "",
    status: t.status,
    priority: t.priority ?? null,
    assigned_to: t.assigned_to ?? null,
    due_at: t.due_at ?? null,
    created_at: t.created_at,
    completed_at: t.completed_at ?? null,
    overdue: isOverdue(t, now),
  });

  let tasks;
  if (st === "open") tasks = open.map(shape).sort(compareTasks);
  else if (st === "done") tasks = closed.map(shape); // newest completed first
  else {
    // all: archived open-status tasks are excluded from `open` but are not "closed" either; fine to omit
    tasks = [...open.map(shape), ...closed.map(shape)].sort(compareTasks);
  }

  const counts = { open: 0, in_progress: 0, blocked: 0, overdue: 0, done_30d: done30 || 0 };
  for (const t of open) {
    counts[t.status] = (counts[t.status] || 0) + 1;
    if (isOverdue(t, now)) counts.overdue++;
  }
  return { tasks: tasks.slice(0, lim), counts };
}

// ---------- emails ----------
async function shipperShipmentIds(name) {
  const rows = await fetchAll(
    () => whereCustomer(_deps.supabase.from("fpx_shipments").select("shipment_id").not("shipment_id", "is", null), name)
      .order("id", { ascending: true }),
    "Loading shipper shipments",
  );
  return [...new Set(rows.map((r) => r.shipment_id).filter(Boolean))];
}

export async function getShipperEmails(key, { status = "all", days = 90, limit } = {}) {
  const st = status || "all";
  if (!EMAIL_STATUSES.includes(st)) throw httpError(400, `status must be one of ${EMAIL_STATUSES.join(", ")}`);
  const d = days == null || days === "" ? 90 : days;
  if (!(d === "all" || [7, 30, 90].includes(Number(d)))) throw httpError(400, "days must be 7, 30, 90 or all");
  const lim = clampInt(limit, 100, 200);
  const name = nameFromKey(key);
  const empty = { threads: [], counts: { all: 0, awaiting_reply: 0, responded: 0 } };

  const sids = await shipperShipmentIds(name);
  if (!sids.length) return empty;
  const links = await liveLinks(sids);
  if (!links.length) return empty;

  // conversation → this shipper's linked shipment ids
  const byConv = new Map();
  for (const l of links) {
    const k = `${l.connection_id}|${l.conversation_id}`;
    const e = byConv.get(k) || { connection_id: l.connection_id, conversation_id: l.conversation_id, ids: new Set() };
    e.ids.add(l.shipment_id);
    byConv.set(k, e);
  }

  const convIds = [...new Set([...byConv.values()].map((e) => e.conversation_id))];
  const summaries = [];
  const parts = await Promise.all(chunk(convIds, IN_CHUNK).map((part) => _deps.supabase.from("fpx_mailbox_thread_summary")
    .select("connection_id, conversation_id, subject, last_message_at, status, party, message_count, last_from_name, last_from_address, preview")
    .in("conversation_id", part)));
  for (const { data, error } of parts) {
    if (error) throw dbError("Loading email threads", error);
    summaries.push(...(data || []));
  }

  const cutoff = d === "all" ? null : _deps.now().getTime() - Number(d) * DAY;
  const threads = [];
  for (const s of summaries) {
    const link = byConv.get(`${s.connection_id}|${s.conversation_id}`);
    if (!link) continue; // same conversation id on another mailbox connection
    if (cutoff != null && !(s.last_message_at && Date.parse(s.last_message_at) >= cutoff)) continue;
    threads.push({
      conversation_id: s.conversation_id,
      subject: s.subject ?? null,
      last_message_at: s.last_message_at ?? null,
      status: s.status || "",
      party: s.party || "",
      message_count: int(s.message_count),
      last_from_name: s.last_from_name ?? null,
      last_from_address: s.last_from_address ?? null,
      preview: s.preview ?? null,
      linked_shipment_ids: [...link.ids].sort(),
    });
  }
  threads.sort((a, b) => time(b.last_message_at) - time(a.last_message_at));

  const counts = {
    all: threads.length,
    awaiting_reply: threads.filter((t) => t.status === "awaiting_reply").length,
    responded: threads.filter((t) => t.status === "responded").length,
  };
  const filtered = st === "all" ? threads : threads.filter((t) => t.status === st);
  return { threads: filtered.slice(0, lim), counts };
}

// ---------- timeline ----------
export async function getShipperTimeline(key, { limit, includeEmail = true } = {}) {
  const lim = clampInt(limit, 100, 200);
  const name = shipperName(key); // rpc takes '(No shipper)' for null/blank
  const { data, error } = await _deps.supabase.rpc("fpx_shipper_timeline", {
    p_customer: name,
    p_limit: includeEmail ? lim : Math.min(lim * 2, 400),
  });
  if (error) throw dbError("Loading shipper activity", error);
  let events = (data || []).map((e) => ({
    at: e.at,
    kind: e.kind,
    title: e.title || "",
    detail: e.detail ?? null,
    shipment_id: e.shipment_id ?? null,
    tracking_number: e.tracking_number ?? null,
    ref_id: e.ref_id ?? null,
    actor: e.actor ?? null,
  }));
  if (!includeEmail) events = events.filter((e) => e.kind !== "email");
  return { events: events.slice(0, lim) };
}
