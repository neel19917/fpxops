import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { logAudit } from "../lib/audit.js";
import { logGovernance } from "../lib/governance.js";
import { encryptSecret } from "../lib/mailbox/crypto.js";
import { graphFetch, loadConnection, testConnection, publicConnection } from "../lib/mailbox/graph.js";
import { requestSync, getBodyHtml } from "../lib/mailbox/sync.js";
import { generateMailboxReply } from "../lib/mailbox/drafts.js";

// Support Mailbox (freightsupport@freightpop.com) — mounted at /api/mailbox on
// the authenticated api router. House rules: never send mail, never delete
// anything (Outlook or FPX rows). Drafts are created in Outlook's Drafts
// folder for a person to review and send from Outlook.

export const DEFAULT_MAILBOX = "freightsupport@freightpop.com";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = GUID_RE;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const THREAD_STATUSES = ["awaiting_reply", "responded", "outbound_only"];
const MAX_DRAFT_CHARS = 50_000;

// Columns safe for the browser — never secret_enc / client_secret.
const CONNECTION_COLS = "id, mailbox, tenant_id, client_id, secret_hint, status, last_error, connected_by, connected_at, last_sync_at, last_sync_result, backfill_done, created_at, updated_at";
const MESSAGE_COLS = "id, conversation_id, folder, direction, subject, from_address, from_name, to_recipients, cc_recipients, received_at, sent_at, body_preview, has_attachments, is_read, web_link";
const DRAFT_COLS = "id, conversation_id, reply_to_message_id, web_link, body, ai_generated, reply_all, created_by, created_at";
const THREAD_COLS = "conversation_id, subject, last_message_at, last_inbound_at, last_outbound_at, message_count, preview, last_from_name, last_from_address, participants, status, party, linked_shipment_ids, linked_count";
const LINK_COLS = "id, connection_id, conversation_id, shipment_id, matched_on, matched_text, source, created_by, dismissed, dismissed_by, dismissed_at, created_at";
// Added by 2026-11-20_mailbox_link_log.sql; read separately so an older DB
// without them still serves the sidebar.
const LINK_LOG_COLS = "note_id, logged_at";
const isMissingColumn = (err) => /note_id|logged_at/.test(String(err?.message || "")) && /column|schema cache/i.test(String(err?.message || ""));
const SHIPMENT_CARD_COLS = "id, shipment_id, tracking_number, customer_name, carrier_name, mode, shipment_status, pickup_date, estimated_arrival, delivery_date, origin, destination, scraped_at";
const TASK_COLS = "id, shipment_id, tracking_number, title, status, priority, assigned_to, due_at, created_at";

export const PARTIES = ["customer", "carrier", "internal", "other"];
export const PARTY_FILTERS = ["all", ...PARTIES, "unknown"];
export const DAY_RANGES = ["7", "30", "90", "all"];
const OPEN_TASK_STATUSES = ["open", "in_progress", "blocked"];
const MAX_DONE_TASKS = 20;
const MAX_RELATED_THREADS = 10;
const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Lazy so this module (and its tests) load even before linking.js exists.
async function linkingModule() {
  return import("../lib/mailbox/linking.js");
}

// ---------- pure helpers (exported for tests) ----------

export function isAdminReq(req) {
  if (req?.user?.role === "admin") return true;
  const scopes = req?.apiKey?.scopes;
  return Array.isArray(scopes) && scopes.includes("admin");
}

export function requireAdmin(req, res, next) {
  if (isAdminReq(req)) return next();
  return res.status(403).json({ error: "Admins only" });
}

// Support Mailbox access for the caller: 'none' | 'view' | 'draft'.
// Admins (role or admin-scope key) always draft; other API keys view; a
// signed-in user gets their profile's mailbox_access (missing → draft, so an
// old DB without the column never locks anyone out).
export const MAILBOX_ACCESS_LEVELS = ["none", "view", "draft"];
export const NO_ACCESS_ERROR = "You don't have access to the Support Mailbox. Ask an admin.";
export const VIEW_ONLY_ERROR = "Your Support Mailbox access is view only. Ask an admin to allow drafts.";

export function mailboxAccess(req) {
  if (isAdminReq(req)) return "draft";
  if (req?.user) {
    const v = req.user.mailbox_access;
    return MAILBOX_ACCESS_LEVELS.includes(v) ? v : "draft";
  }
  if (req?.apiKey) return "view";
  return "none";
}

// Admin-only routes keep their own requireAdmin check; /status answers every
// caller (with { access }) so the nav can hide itself.
const ACCESS_EXEMPT_PATHS = new Set(["/status", "/connection", "/connection/test", "/connection/disconnect", "/sync"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Router-wide guard: any route needs view or draft; any write needs draft.
export function requireMailboxAccess(req, res, next) {
  if (ACCESS_EXEMPT_PATHS.has(req.path)) return next();
  const access = mailboxAccess(req);
  if (access === "none") return res.status(403).json({ error: NO_ACCESS_ERROR, code: "mailbox_no_access" });
  if (!READ_METHODS.has(req.method) && access !== "draft") {
    return res.status(403).json({ error: VIEW_ONLY_ERROR, code: "mailbox_view_only" });
  }
  return next();
}

// Graph conversation ids contain / + = . Accept them as a URL-encoded path
// segment (/threads/<encodeURIComponent(id)>, which Express has already
// decoded once) or as ?id=. A query string decodes "+" to a space and
// conversation ids never contain spaces, so spaces go back to "+".
export function decodeConversationId({ pathValue, queryValue } = {}) {
  let v = pathValue != null && String(pathValue) !== "" ? String(pathValue) : null;
  if (v == null && queryValue != null && String(queryValue) !== "") {
    v = String(Array.isArray(queryValue) ? queryValue[0] : queryValue).replace(/ /g, "+");
  }
  if (v == null) return null;
  // A proxy that leaves %2F etc. un-decoded (or a client that double-encoded)
  // still lands on the right id: decode once more only when it looks encoded.
  if (/%[0-9a-f]{2}/i.test(v)) {
    try { v = decodeURIComponent(v); } catch { /* keep as-is */ }
  }
  v = v.trim();
  if (!v || v.length > 1024) return null;
  return v;
}

export function parseThreadQuery(q = {}) {
  const status = String(q.status || "all");
  if (status !== "all" && !THREAD_STATUSES.includes(status)) {
    return { error: `status must be one of all, ${THREAD_STATUSES.join(", ")}` };
  }
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit)) limit = 50;
  limit = Math.max(1, Math.min(200, limit));
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  // PostgREST or() syntax uses , ( ) and : — strip them (and wildcards) from
  // the search text instead of trying to escape them.
  const search = String(q.q || "").replace(/[,()*%\\:"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const party = String(q.party || "all").toLowerCase();
  if (!PARTY_FILTERS.includes(party)) return { error: `party must be one of ${PARTY_FILTERS.join(", ")}` };
  const shipment_id = q.shipment_id != null && String(q.shipment_id).trim() !== "" ? String(q.shipment_id).trim().slice(0, 100) : null;
  // Default range is the last 30 days — except when filtering to one
  // shipment, where every linked thread matters (deep links from a shipment
  // or task). An explicit ?days= always wins.
  const daysRaw = q.days != null && String(q.days) !== "" ? String(q.days).toLowerCase() : (shipment_id ? "all" : "30");
  if (!DAY_RANGES.includes(daysRaw)) return { error: `days must be one of ${DAY_RANGES.join(", ")}` };
  const days = daysRaw === "all" ? null : Number(daysRaw);
  return { status, limit, offset, search, party, days, shipment_id };
}

// ISO cutoff for a day range (null = all time).
export function sinceIso(days, now = Date.now()) {
  if (days == null) return null;
  return new Date(now - days * 86_400_000).toISOString();
}

export function normalizeDomain(raw) {
  const v = String(raw || "").trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  return DOMAIN_RE.test(v) ? v : null;
}

export function validateParty(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return PARTIES.includes(v) ? v : null;
}

export function domainOf(address) {
  const m = /@([^@\s>]+)\s*>?$/.exec(String(address || "").trim().toLowerCase());
  return m ? normalizeDomain(m[1]) : null;
}

// Open work first, then at most MAX_DONE_TASKS recent closed ones; newest
// first within each group.
export function orderContextTasks(tasks) {
  const byNewest = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  const open = (tasks || []).filter((t) => OPEN_TASK_STATUSES.includes(t.status)).sort(byNewest);
  const closed = (tasks || []).filter((t) => !OPEN_TASK_STATUSES.includes(t.status)).sort(byNewest).slice(0, MAX_DONE_TASKS);
  return [...open, ...closed];
}

export function shapeThread(t) {
  return {
    ...t,
    participants: t?.participants || [],
    party: t?.party || "unknown",
    linked_shipment_ids: t?.linked_shipment_ids || [],
    linked_count: t?.linked_count ?? (t?.linked_shipment_ids || []).length,
  };
}

export function validateConnectionBody(body = {}) {
  const tenant_id = String(body.tenant_id || "").trim();
  const client_id = String(body.client_id || "").trim();
  const client_secret = typeof body.client_secret === "string" ? body.client_secret.trim() : "";
  const mailbox = String(body.mailbox || DEFAULT_MAILBOX).trim().toLowerCase();
  if (!GUID_RE.test(tenant_id)) return { error: "Tenant (directory) ID must be a GUID like 00000000-0000-0000-0000-000000000000" };
  if (!GUID_RE.test(client_id)) return { error: "Application (client) ID must be a GUID like 00000000-0000-0000-0000-000000000000" };
  if (!client_secret) return { error: "Client secret is required" };
  if (client_secret.length > 1024) return { error: "Client secret is too long" };
  if (!EMAIL_RE.test(mailbox)) return { error: "Mailbox must be an email address" };
  return { tenant_id, client_id, client_secret, mailbox };
}

export function validateDraftBody(body = {}) {
  if (typeof body.body !== "string" || !body.body.trim()) return { error: "body (plain text) is required" };
  if (body.body.length > MAX_DRAFT_CHARS) return { error: `body is too long (max ${MAX_DRAFT_CHARS} characters)` };
  if (body.reply_all !== undefined && typeof body.reply_all !== "boolean") return { error: "reply_all must be true or false" };
  if (body.ai_generated !== undefined && typeof body.ai_generated !== "boolean") return { error: "ai_generated must be true or false" };
  return { body: body.body.replace(/\r\n/g, "\n").trim(), reply_all: body.reply_all === true, ai_generated: body.ai_generated === true };
}

// The only Graph write this module ever makes. createReply / createReplyAll
// put a draft in Drafts; nothing here can send.
export function draftPathFor(mailbox, graphId, replyAll) {
  const action = replyAll ? "createReplyAll" : "createReply";
  return `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}/${action}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Outlook drafts are HTML; a plain-text comment would lose its line breaks.
export function plainTextToHtml(text) {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

export function sortOldestFirst(rows) {
  const t = (m) => String(m?.received_at || m?.sent_at || "");
  return [...(rows || [])].sort((a, b) => t(a).localeCompare(t(b)));
}

function actorOf(req) {
  return req?.realUser?.email || req?.user?.email || req?.apiKey?.name || null;
}

// Graph's 401/403 mean the APP lacks mailbox access, not that the FPX session
// expired — passing them through would make the dashboard sign the user out.
export function errStatus(e, fallback = 500) {
  const s = Number(e?.status);
  if (s === 401 || s === 403) return 502;
  return s >= 400 && s < 600 ? s : fallback;
}

// ---------- router ----------

export function buildMailboxRouter(deps = {}) {
  const d = {
    supabase, logAudit, logGovernance, encryptSecret, graphFetch, loadConnection, testConnection,
    publicConnection, requestSync, getBodyHtml, generateMailboxReply,
    classifyDomainChange: async (...args) => (await linkingModule()).classifyDomainChange(...args),
    // Log links on their shipments as notes (never throws).
    logLinksToShipments: async (opts = {}) => (await linkingModule()).logLinksToShipments({ db: d.supabase, ...opts }),
    logUnlink: async (opts = {}) => (await linkingModule()).logUnlink({ db: d.supabase, ...opts }),
    // "Not in FPX" numbers for a thread.
    notInFpx: async (opts = {}) => (await linkingModule()).notInFpx({ db: d.supabase, ...opts }),
    ...deps,
  };
  const db = () => d.supabase;
  const router = Router();

  // Newest connection row (any status — a disconnected mailbox's history
  // stays readable). Never selects the secret.
  async function activeConnectionRow() {
    const { data, error } = await db().from("fpx_mailbox_connections")
      .select(CONNECTION_COLS).order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data?.[0] || null;
  }

  async function loadMessage(id, cols = `${MESSAGE_COLS}, connection_id, graph_id`) {
    const { data, error } = await db().from("fpx_mailbox_messages").select(cols).eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async function threadMessages(connectionId, conversationId) {
    const { data, error } = await db().from("fpx_mailbox_messages").select(MESSAGE_COLS)
      .eq("connection_id", connectionId).eq("conversation_id", conversationId)
      .eq("removed_in_outlook", false).limit(1000);
    if (error) throw new Error(error.message);
    return sortOldestFirst(data);
  }

  router.use(requireMailboxAccess);

  // GET /status — any user. `access` is the caller's level; with 'none' only
  // connected comes back so the dashboard can hide the mailbox.
  router.get("/status", async (req, res) => {
    try {
      const access = mailboxAccess(req);
      const conn = await activeConnectionRow();
      if (access === "none") return res.json({ connected: conn?.status === "connected", access });
      if (!conn) {
        return res.json({ connected: false, mailbox: DEFAULT_MAILBOX, status: "not_connected", last_sync_at: null, backfill_done: false, message_count: 0, last_error: null, access });
      }
      const { count } = await db().from("fpx_mailbox_messages")
        .select("id", { count: "exact", head: true })
        .eq("connection_id", conn.id).eq("removed_in_outlook", false);
      res.json({
        connected: conn.status === "connected",
        mailbox: conn.mailbox,
        status: conn.status,
        last_sync_at: conn.last_sync_at || null,
        backfill_done: !!conn.backfill_done,
        message_count: count || 0,
        last_error: conn.last_error || null,
        access,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /connection — admin
  router.get("/connection", requireAdmin, async (_req, res) => {
    try {
      const conn = await activeConnectionRow();
      res.json({ connection: conn ? d.publicConnection(conn) : null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /connection — admin. Tests first; saves nothing on failure.
  router.post("/connection", requireAdmin, async (req, res) => {
    const v = validateConnectionBody(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const test = await d.testConnection(v);
      if (!test?.ok) {
        logAuditSafe(req, {
          action: "test", entity_type: "mailbox_connection", entity_id: v.mailbox,
          summary: `Support mailbox connect failed for ${v.mailbox}`,
          metadata: { mailbox: v.mailbox, tenant_id: v.tenant_id, client_id: v.client_id, ok: false, error: test?.error || null },
        });
        return res.status(400).json({ error: test?.error || "Could not reach the mailbox with these credentials" });
      }
      const now = new Date().toISOString();
      const row = {
        mailbox: v.mailbox,
        tenant_id: v.tenant_id,
        client_id: v.client_id,
        secret_enc: d.encryptSecret(v.client_secret),
        secret_hint: v.client_secret.slice(-4),
        status: "connected",
        last_error: null,
        connected_by: actorOf(req),
        connected_at: now,
        updated_at: now,
      };
      // Upsert by mailbox: a re-connect replaces credentials only — messages,
      // delta links and backfill progress are untouched.
      const { data, error } = await db().from("fpx_mailbox_connections")
        .upsert(row, { onConflict: "mailbox" }).select(CONNECTION_COLS).single();
      if (error) return res.status(500).json({ error: error.message });
      logAuditSafe(req, {
        action: "connect", entity_type: "mailbox_connection", entity_id: data?.id || v.mailbox,
        summary: `Connected support mailbox ${v.mailbox}`,
        after: { mailbox: v.mailbox, tenant_id: v.tenant_id, client_id: v.client_id, secret_hint: row.secret_hint, status: "connected" },
        metadata: { mailbox: v.mailbox, inbox_total: test.inbox_total ?? null, sent_total: test.sent_total ?? null },
      });
      try { d.requestSync("connect"); } catch (e) { console.warn("[FPX-MAILBOX] requestSync failed:", e?.message || e); }
      res.json({ connection: d.publicConnection(data), test });
    } catch (e) {
      res.status(errStatus(e)).json({ error: e.message });
    }
  });

  // POST /connection/test — admin, using the saved connection.
  router.post("/connection/test", requireAdmin, async (req, res) => {
    try {
      const conn = await d.loadConnection({ includeDisconnected: true });
      if (!conn) return res.status(404).json({ error: "No mailbox connection saved yet" });
      const test = await d.testConnection({ tenant_id: conn.tenant_id, client_id: conn.client_id, client_secret: conn.client_secret, mailbox: conn.mailbox });
      // A disconnected mailbox stays disconnected — testing must not restart sync.
      if (conn.status !== "disconnected") {
        const patch = test?.ok
          ? { status: "connected", last_error: null, updated_at: new Date().toISOString() }
          : { status: "error", last_error: test?.error || "Test failed", updated_at: new Date().toISOString() };
        const { error } = await db().from("fpx_mailbox_connections").update(patch).eq("id", conn.id);
        if (error) console.warn("[FPX-MAILBOX] test status update failed:", error.message);
      }
      logAuditSafe(req, {
        action: "test", entity_type: "mailbox_connection", entity_id: conn.id,
        summary: `Tested support mailbox ${conn.mailbox}: ${test?.ok ? "ok" : "failed"}`,
        metadata: { mailbox: conn.mailbox, ok: !!test?.ok, error: test?.ok ? null : (test?.error || null) },
      });
      res.json({ test });
    } catch (e) {
      res.status(errStatus(e)).json({ error: e.message });
    }
  });

  // POST /connection/disconnect — admin. Stops sync; keeps every row.
  router.post("/connection/disconnect", requireAdmin, async (req, res) => {
    try {
      const conn = await activeConnectionRow();
      if (!conn) return res.status(404).json({ error: "No mailbox connection saved yet" });
      const { data, error } = await db().from("fpx_mailbox_connections")
        .update({ status: "disconnected", updated_at: new Date().toISOString() })
        .eq("id", conn.id).select(CONNECTION_COLS).single();
      if (error) return res.status(500).json({ error: error.message });
      logAuditSafe(req, {
        action: "disconnect", entity_type: "mailbox_connection", entity_id: conn.id,
        summary: `Disconnected support mailbox ${conn.mailbox} (all synced mail kept)`,
        before: { status: conn.status }, after: { status: "disconnected" },
        metadata: { mailbox: conn.mailbox },
      });
      res.json({ connection: d.publicConnection(data) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /sync — admin
  router.post("/sync", requireAdmin, async (req, res) => {
    try {
      const conn = await activeConnectionRow();
      if (!conn || conn.status === "disconnected") return res.status(409).json({ error: "The support mailbox is not connected" });
      d.requestSync("manual");
      logAuditSafe(req, {
        action: "sync", entity_type: "mailbox_connection", entity_id: conn.id,
        summary: `Requested a sync of ${conn.mailbox}`,
        metadata: { mailbox: conn.mailbox, reason: "manual" },
      });
      res.json({ started: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  async function sendThread(req, res, conversationId) {
    if (!conversationId) return res.status(400).json({ error: "conversation id required" });
    try {
      const conn = await activeConnectionRow();
      if (!conn) return res.status(404).json({ error: "Thread not found" });
      const { data: thread, error } = await db().from("fpx_mailbox_threads").select(THREAD_COLS)
        .eq("connection_id", conn.id).eq("conversation_id", conversationId).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!thread) return res.status(404).json({ error: "Thread not found" });
      const messages = await threadMessages(conn.id, conversationId);
      const { data: drafts, error: dErr } = await db().from("fpx_mailbox_drafts").select(DRAFT_COLS)
        .eq("connection_id", conn.id).eq("conversation_id", conversationId)
        .order("created_at", { ascending: false });
      if (dErr) return res.status(500).json({ error: dErr.message });
      res.json({ thread: shapeThread(thread), messages, drafts: drafts || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  // GET /threads — list. With ?id=<conversationId> it returns one thread
  // (same shape as /threads/:conversationId), for clients/proxies that mangle
  // encoded slashes in paths.
  router.get("/threads", async (req, res) => {
    if (req.query.id !== undefined) {
      return sendThread(req, res, decodeConversationId({ queryValue: req.query.id }));
    }
    const p = parseThreadQuery(req.query);
    if (p.error) return res.status(400).json({ error: p.error });
    try {
      const conn = await activeConnectionRow();
      const emptyCounts = { all: 0, awaiting_reply: 0, responded: 0, outbound_only: 0 };
      if (!conn) return res.json({ threads: [], total: 0, counts: emptyCounts });
      const applySearch = (qb) => p.search
        ? qb.or(`subject.ilike.%${p.search}%,last_from_address.ilike.%${p.search}%,last_from_name.ilike.%${p.search}%`)
        : qb;
      const since = sinceIso(p.days);
      const base = (cols, opts) => {
        let q = applySearch(db().from("fpx_mailbox_threads").select(cols, opts).eq("connection_id", conn.id));
        if (since) q = q.gte("last_message_at", since);
        if (p.party !== "all") q = q.eq("party", p.party);
        if (p.shipment_id) q = q.contains("linked_shipment_ids", [p.shipment_id]);
        return q;
      };

      let listQ = base(THREAD_COLS, { count: "exact" });
      if (p.status !== "all") listQ = listQ.eq("status", p.status);
      listQ = listQ.order("last_message_at", { ascending: false, nullsFirst: false }).range(p.offset, p.offset + p.limit - 1);

      const countQ = (status) => {
        let q = base("conversation_id", { count: "exact", head: true });
        if (status) q = q.eq("status", status);
        return q;
      };
      const [list, cAll, ...cStatus] = await Promise.all([listQ, countQ(null), ...THREAD_STATUSES.map(countQ)]);
      const firstErr = [list, cAll, ...cStatus].find((r) => r?.error);
      if (firstErr) return res.status(500).json({ error: firstErr.error.message });
      const counts = { all: cAll.count || 0 };
      THREAD_STATUSES.forEach((s, i) => { counts[s] = cStatus[i].count || 0; });
      res.json({
        threads: (list.data || []).map(shapeThread),
        total: list.count ?? (list.data || []).length,
        counts,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- linking: shipments, party, related threads ----------

  async function threadRow(connectionId, conversationId, cols = THREAD_COLS) {
    const { data, error } = await db().from("fpx_mailbox_threads").select(cols)
      .eq("connection_id", connectionId).eq("conversation_id", conversationId).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  // Resolve what a person typed (FreightPOP shipment id, an fpx_shipments row
  // uuid, or a tracking/PRO number) to the FreightPOP shipment id that links
  // are keyed by. null when no fpx_shipments row matches.
  async function resolveShipmentId(raw) {
    const v = String(raw || "").trim();
    if (!v || v.length > 100) return null;
    if (UUID_RE.test(v)) {
      const { data, error } = await db().from("fpx_shipments").select("shipment_id").eq("id", v).maybeSingle();
      if (error) throw new Error(error.message);
      if (data?.shipment_id) return String(data.shipment_id);
    }
    const byId = await db().from("fpx_shipments").select("shipment_id").eq("shipment_id", v).limit(1);
    if (byId.error) throw new Error(byId.error.message);
    if (byId.data?.length) return String(byId.data[0].shipment_id);
    const byTracking = await db().from("fpx_shipments").select("shipment_id").eq("tracking_number", v)
      .order("scraped_at", { ascending: false }).limit(1);
    if (byTracking.error) throw new Error(byTracking.error.message);
    const sid = byTracking.data?.[0]?.shipment_id;
    return sid ? String(sid) : null;
  }

  // Threads linked (non-dismissed) to one shipment, newest first.
  async function threadsForShipment(shipmentId) {
    const conn = await activeConnectionRow();
    if (!conn || !shipmentId) return [];
    const { data: links, error } = await db().from("fpx_mailbox_links").select("conversation_id")
      .eq("connection_id", conn.id).eq("shipment_id", shipmentId).eq("dismissed", false).limit(500);
    if (error) throw new Error(error.message);
    const convs = [...new Set((links || []).map((l) => l.conversation_id).filter(Boolean))];
    if (!convs.length) return [];
    const { data: threads, error: tErr } = await db().from("fpx_mailbox_threads").select(THREAD_COLS)
      .eq("connection_id", conn.id).in("conversation_id", convs)
      .order("last_message_at", { ascending: false, nullsFirst: false }).limit(200);
    if (tErr) throw new Error(tErr.message);
    return (threads || []).map(shapeThread);
  }

  // Newest scrape row per FreightPOP shipment id.
  async function latestShipments(shipmentIds) {
    if (!shipmentIds.length) return new Map();
    const { data, error } = await db().from("fpx_shipments").select(SHIPMENT_CARD_COLS)
      .in("shipment_id", shipmentIds).order("scraped_at", { ascending: false }).limit(2000);
    if (error) throw new Error(error.message);
    const out = new Map();
    for (const r of data || []) {
      const k = String(r.shipment_id);
      if (!out.has(k)) out.set(k, r);
    }
    return out;
  }

  // Tasks reference an fpx_shipments row uuid (any scrape) and carry the
  // tracking number; match on either. Archived tasks are excluded.
  async function tasksForShipments(shipmentIds, latest) {
    if (!shipmentIds.length) return [];
    const { data: rows, error } = await db().from("fpx_shipments").select("id, shipment_id")
      .in("shipment_id", shipmentIds).limit(5000);
    if (error) throw new Error(error.message);
    const rowToShipment = new Map((rows || []).map((r) => [r.id, String(r.shipment_id)]));
    const trackingToShipment = new Map();
    for (const [sid, r] of latest) if (r.tracking_number) trackingToShipment.set(String(r.tracking_number), sid);
    const rowIds = [...rowToShipment.keys()];
    const trackings = [...trackingToShipment.keys()];
    const queries = [];
    if (rowIds.length) queries.push(db().from("fpx_shipment_tasks").select(TASK_COLS).in("shipment_id", rowIds).is("archived_at", null).limit(500));
    if (trackings.length) queries.push(db().from("fpx_shipment_tasks").select(TASK_COLS).in("tracking_number", trackings).is("archived_at", null).limit(500));
    const results = await Promise.all(queries);
    const bad = results.find((r) => r?.error);
    if (bad) throw new Error(bad.error.message);
    const seen = new Map();
    for (const r of results) for (const t of r.data || []) if (!seen.has(t.id)) seen.set(t.id, t);
    return orderContextTasks([...seen.values()]).map((t) => ({
      id: t.id,
      shipment_id: rowToShipment.get(t.shipment_id) || trackingToShipment.get(String(t.tracking_number || "")) || null,
      title: t.title,
      status: t.status,
      priority: t.priority ?? null,
      assigned_to: t.assigned_to ?? null,
      due_at: t.due_at ?? null,
      created_at: t.created_at,
    }));
  }

  async function sendContext(req, res, conversationId) {
    if (!conversationId) return res.status(400).json({ error: "conversation id required" });
    try {
      const conn = await activeConnectionRow();
      if (!conn) return res.status(404).json({ error: "Thread not found" });
      const thread = await threadRow(conn.id, conversationId, "conversation_id");
      if (!thread) return res.status(404).json({ error: "Thread not found" });

      const linksQuery = (cols) => db().from("fpx_mailbox_links").select(cols)
        .eq("connection_id", conn.id).eq("conversation_id", conversationId).eq("dismissed", false)
        .order("created_at", { ascending: true });
      let [metaRes, linksRes, messages] = await Promise.all([
        db().from("fpx_mailbox_thread_meta").select("party, party_source, party_reason, party_set_by")
          .eq("connection_id", conn.id).eq("conversation_id", conversationId).maybeSingle(),
        linksQuery(`${LINK_COLS}, ${LINK_LOG_COLS}`),
        threadMessages(conn.id, conversationId),
      ]);
      if (linksRes.error && isMissingColumn(linksRes.error)) linksRes = await linksQuery(LINK_COLS);
      if (metaRes.error) return res.status(500).json({ error: metaRes.error.message });
      if (linksRes.error) return res.status(500).json({ error: linksRes.error.message });
      const meta = metaRes.data || null;
      const links = linksRes.data || [];

      // External sender domains (the mailbox's own domain is internal by definition).
      const ownDomain = domainOf(conn.mailbox);
      const domains = [...new Set(messages.filter((m) => m.direction !== "out").map((m) => domainOf(m.from_address)).filter(Boolean))]
        .filter((dm) => dm !== ownDomain);
      let domainParty = new Map();
      if (domains.length) {
        const { data: drows, error: dErr } = await db().from("fpx_mailbox_domains").select("domain, party").in("domain", domains);
        if (dErr) return res.status(500).json({ error: dErr.message });
        domainParty = new Map((drows || []).map((r) => [r.domain, r.party]));
      }

      const shipmentIds = [...new Set(links.map((l) => String(l.shipment_id)))];
      const latest = await latestShipments(shipmentIds);
      const shipments = links.map((l) => {
        const s = latest.get(String(l.shipment_id)) || {};
        return {
          shipment_id: String(l.shipment_id),
          tracking_number: s.tracking_number ?? null,
          customer_name: s.customer_name ?? null,
          carrier_name: s.carrier_name ?? null,
          mode: s.mode ?? null,
          shipment_status: s.shipment_status ?? null,
          pickup_date: s.pickup_date ?? null,
          estimated_arrival: s.estimated_arrival ?? null,
          delivery_date: s.delivery_date ?? null,
          origin: s.origin ?? null,
          destination: s.destination ?? null,
          matched_on: l.matched_on ?? null,
          matched_text: l.matched_text ?? null,
          source: l.source ?? null,
          link_id: l.id,
          logged_at: l.logged_at ?? null,
          note_id: l.note_id ?? null,
          fpx_id: s.id ?? null,
        };
      });

      // Shipment-looking numbers in the thread that match no FPX shipment.
      // Best effort: a failure here never breaks the sidebar.
      let not_in_fpx = [];
      try {
        const newestIn = [...messages].reverse().find((m) => m.direction === "in") || null;
        let bodies = new Map();
        if (newestIn?.id) {
          const { data: b } = await db().from("fpx_mailbox_messages").select("id, body_html").eq("id", newestIn.id).maybeSingle();
          if (b?.body_html) bodies = new Map([[b.id || newestIn.id, b.body_html]]);
        }
        const out = await d.notInFpx({ messages, bodies, linked: shipments });
        not_in_fpx = Array.isArray(out) ? out : [];
      } catch (e) {
        console.warn(`[FPX] mailbox: not-in-FPX numbers skipped: ${e?.message || e}`);
      }

      const tasks = await tasksForShipments(shipmentIds, latest);

      let related_threads = [];
      if (shipmentIds.length) {
        const { data: rl, error: rlErr } = await db().from("fpx_mailbox_links").select("conversation_id")
          .eq("connection_id", conn.id).in("shipment_id", shipmentIds).eq("dismissed", false)
          .neq("conversation_id", conversationId).limit(500);
        if (rlErr) return res.status(500).json({ error: rlErr.message });
        const convs = [...new Set((rl || []).map((r) => r.conversation_id).filter((c) => c && c !== conversationId))];
        if (convs.length) {
          const { data: rt, error: rtErr } = await db().from("fpx_mailbox_threads")
            .select("conversation_id, subject, last_message_at, status, party")
            .eq("connection_id", conn.id).in("conversation_id", convs)
            .order("last_message_at", { ascending: false, nullsFirst: false }).limit(MAX_RELATED_THREADS);
          if (rtErr) return res.status(500).json({ error: rtErr.message });
          related_threads = (rt || []).map((t) => ({
            conversation_id: t.conversation_id, subject: t.subject ?? null, last_message_at: t.last_message_at ?? null,
            status: t.status ?? null, party: t.party || "unknown",
          }));
        }
      }

      res.json({
        party: {
          party: meta?.party || "unknown",
          source: meta?.party_source || null,
          reason: meta?.party_reason || null,
          set_by: meta?.party_set_by || null,
        },
        sender_domains: domains.map((dm) => ({ domain: dm, party: domainParty.get(dm) || null })),
        shipments,
        tasks,
        related_threads,
        not_in_fpx,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  async function addLink(req, res, conversationId) {
    if (!conversationId) return res.status(400).json({ error: "conversation id required" });
    const raw = req.body?.shipment_id;
    if (raw == null || (typeof raw !== "string" && typeof raw !== "number") || !String(raw).trim()) {
      return res.status(400).json({ error: "shipment_id is required" });
    }
    try {
      const conn = await activeConnectionRow();
      if (!conn) return res.status(404).json({ error: "Thread not found" });
      const thread = await threadRow(conn.id, conversationId, "conversation_id, subject");
      if (!thread) return res.status(404).json({ error: "Thread not found" });
      const shipmentId = await resolveShipmentId(raw);
      if (!shipmentId) return res.status(404).json({ error: `No shipment found for "${String(raw).trim().slice(0, 100)}"` });

      const actor = actorOf(req);
      const { data: existing, error: exErr } = await db().from("fpx_mailbox_links").select(LINK_COLS)
        .eq("connection_id", conn.id).eq("conversation_id", conversationId).eq("shipment_id", shipmentId).maybeSingle();
      if (exErr) return res.status(500).json({ error: exErr.message });
      let link;
      if (existing) {
        if (!existing.dismissed) return res.json({ link: existing });
        // Re-linking a dismissed link restores it (rows are never deleted).
        const { data, error } = await db().from("fpx_mailbox_links")
          .update({ dismissed: false, dismissed_by: null, dismissed_at: null, source: "person", created_by: existing.created_by || actor })
          .eq("id", existing.id).select(LINK_COLS).single();
        if (error) return res.status(500).json({ error: error.message });
        link = data;
      } else {
        const { data, error } = await db().from("fpx_mailbox_links").insert({
          connection_id: conn.id, conversation_id: conversationId, shipment_id: shipmentId,
          matched_on: "manual", matched_text: String(raw).trim().slice(0, 200), source: "person", created_by: actor,
        }).select(LINK_COLS).single();
        if (error) return res.status(500).json({ error: error.message });
        link = data;
      }
      logAuditSafe(req, {
        action: "link", entity_type: "mailbox_link", entity_id: link?.id || null,
        summary: `Linked email "${String(thread.subject || "(no subject)").slice(0, 120)}" to shipment ${shipmentId}`,
        before: existing ? { dismissed: true } : null, after: { shipment_id: shipmentId, dismissed: false },
        metadata: { conversation_id: conversationId, shipment_id: shipmentId, input: String(raw).trim().slice(0, 200) },
      });
      // Log it on the shipment's notes right away (never fails the request).
      let logged = 0;
      try {
        const r = await d.logLinksToShipments({ connectionId: conn.id, conversationId, limit: 20 });
        logged = Number(r?.logged) || 0;
      } catch { /* the linker tick will retry */ }
      res.json({ link, logged });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  async function setThreadParty(req, res, conversationId) {
    if (!conversationId) return res.status(400).json({ error: "conversation id required" });
    const party = validateParty(req.body?.party);
    if (!party) return res.status(400).json({ error: `party must be one of ${PARTIES.join(", ")}` });
    try {
      const conn = await activeConnectionRow();
      if (!conn) return res.status(404).json({ error: "Thread not found" });
      const thread = await threadRow(conn.id, conversationId, "conversation_id, subject, party");
      if (!thread) return res.status(404).json({ error: "Thread not found" });
      const actor = actorOf(req);
      const row = {
        connection_id: conn.id, conversation_id: conversationId, party, party_source: "person",
        party_reason: `Set by ${actor || "a person"}`, party_set_by: actor, updated_at: new Date().toISOString(),
      };
      const { data, error } = await db().from("fpx_mailbox_thread_meta")
        .upsert(row, { onConflict: "connection_id,conversation_id" })
        .select("party, party_source, party_reason, party_set_by").single();
      if (error) return res.status(500).json({ error: error.message });
      logAuditSafe(req, {
        action: "update", entity_type: "mailbox_thread", entity_id: conversationId,
        summary: `Marked email "${String(thread.subject || "(no subject)").slice(0, 120)}" as ${party}`,
        before: { party: thread.party || "unknown" }, after: { party, party_source: "person" },
        metadata: { conversation_id: conversationId },
      });
      res.json({ party: { party: data?.party || party, source: data?.party_source || "person", reason: data?.party_reason ?? row.party_reason, set_by: data?.party_set_by ?? actor } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  // GET /threads/<encoded id>/context (or /threads/context?id=)
  router.get(/^\/threads\/(?:(.+)\/)?context$/, (req, res) =>
    sendContext(req, res, decodeConversationId({ pathValue: req.params[0], queryValue: req.query.id })));

  // POST /threads/<encoded id>/links { shipment_id } (or /threads/links?id=)
  router.post(/^\/threads\/(?:(.+)\/)?links$/, (req, res) =>
    addLink(req, res, decodeConversationId({ pathValue: req.params[0], queryValue: req.query.id })));

  // PUT /threads/<encoded id>/party { party } (or /threads/party?id=)
  router.put(/^\/threads\/(?:(.+)\/)?party$/, (req, res) =>
    setThreadParty(req, res, decodeConversationId({ pathValue: req.params[0], queryValue: req.query.id })));

  // POST /links/:linkId/dismiss — sets dismissed; never deletes.
  router.post("/links/:linkId/dismiss", async (req, res) => {
    const id = String(req.params.linkId || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "link id must be a uuid" });
    try {
      const { data: link, error } = await db().from("fpx_mailbox_links").select(LINK_COLS).eq("id", id).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!link) return res.status(404).json({ error: "Link not found" });
      if (link.dismissed) return res.json({ link });
      const { data, error: uErr } = await db().from("fpx_mailbox_links")
        .update({ dismissed: true, dismissed_by: actorOf(req), dismissed_at: new Date().toISOString() })
        .eq("id", id).select(LINK_COLS).single();
      if (uErr) return res.status(500).json({ error: uErr.message });
      // If the link had been logged on the shipment, say it was unlinked
      // (the first note is kept). Best effort.
      try {
        const { data: lg, error: lgErr } = await db().from("fpx_mailbox_links").select(LINK_LOG_COLS).eq("id", id).maybeSingle();
        if (!lgErr && lg?.logged_at && lg?.note_id) await d.logUnlink({ link: { ...link, ...lg }, who: actorOf(req) });
      } catch { /* ignore */ }
      logAuditSafe(req, {
        action: "dismiss", entity_type: "mailbox_link", entity_id: id,
        summary: `Unlinked shipment ${link.shipment_id} from an email thread`,
        before: { dismissed: false }, after: { dismissed: true },
        metadata: { conversation_id: link.conversation_id, shipment_id: link.shipment_id, matched_on: link.matched_on, source: link.source },
      });
      res.json({ link: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /domains/:domain { party } — a person's rule; re-classifies that
  // domain's threads in the background.
  router.put("/domains/:domain", async (req, res) => {
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: "domain must look like example.com" });
    const party = validateParty(req.body?.party);
    if (!party) return res.status(400).json({ error: `party must be one of ${PARTIES.join(", ")}` });
    try {
      const { data: before } = await db().from("fpx_mailbox_domains").select("domain, party, source").eq("domain", domain).maybeSingle();
      const actor = actorOf(req);
      const { data, error } = await db().from("fpx_mailbox_domains")
        .upsert({ domain, party, source: "person", set_by: actor, updated_at: new Date().toISOString() }, { onConflict: "domain" })
        .select("domain, party, source, set_by, updated_at").single();
      if (error) return res.status(500).json({ error: error.message });
      logAuditSafe(req, {
        action: "update", entity_type: "mailbox_domain", entity_id: domain,
        summary: `Always treat ${domain} as ${party}`,
        before: before ? { party: before.party, source: before.source } : null, after: { party, source: "person" },
        metadata: { domain },
      });
      // Fire-and-forget: re-classify threads from this domain.
      Promise.resolve().then(() => d.classifyDomainChange(domain, party))
        .catch((e) => console.warn("[FPX-MAILBOX] classifyDomainChange failed:", e?.message || e));
      res.json({ domain: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /by-shipment/:shipmentId — FreightPOP shipment id, fpx_shipments row
  // uuid, or tracking number.
  router.get("/by-shipment/:shipmentId", async (req, res) => {
    const raw = String(req.params.shipmentId || "").trim();
    if (!raw || raw.length > 100) return res.status(400).json({ error: "shipment id required" });
    try {
      const shipmentId = (await resolveShipmentId(raw)) || raw;
      const threads = await threadsForShipment(shipmentId);
      res.json({ shipment_id: shipmentId, threads });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /by-task/:taskId → { shipment_id, threads }
  router.get("/by-task/:taskId", async (req, res) => {
    const taskId = String(req.params.taskId || "").trim();
    if (!taskId || taskId.length > 100) return res.status(400).json({ error: "task id required" });
    try {
      const { data: task, error } = await db().from("fpx_shipment_tasks").select("id, shipment_id, tracking_number").eq("id", taskId).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!task) return res.status(404).json({ error: "Task not found" });
      let shipmentId = null;
      let tracking = task.tracking_number || null;
      if (task.shipment_id) {
        const { data: ship, error: sErr } = await db().from("fpx_shipments").select("shipment_id, tracking_number").eq("id", task.shipment_id).maybeSingle();
        if (sErr) return res.status(500).json({ error: sErr.message });
        if (ship?.shipment_id) shipmentId = String(ship.shipment_id);
        tracking = tracking || ship?.tracking_number || null;
      }
      if (!shipmentId && tracking) {
        const { data: rows, error: tErr } = await db().from("fpx_shipments").select("shipment_id").eq("tracking_number", tracking)
          .not("shipment_id", "is", null).order("scraped_at", { ascending: false }).limit(1);
        if (tErr) return res.status(500).json({ error: tErr.message });
        if (rows?.[0]?.shipment_id) shipmentId = String(rows[0].shipment_id);
      }
      const threads = shipmentId ? await threadsForShipment(shipmentId) : [];
      res.json({ shipment_id: shipmentId, threads });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /threads/<encodeURIComponent(conversationId)> — the id can contain
  // "/", so match the rest of the path rather than a single segment.
  router.get(/^\/threads\/(.+)$/, (req, res) => {
    return sendThread(req, res, decodeConversationId({ pathValue: req.params[0], queryValue: req.query.id }));
  });

  // GET /messages/:id/body — any user
  router.get("/messages/:id/body", async (req, res) => {
    const id = String(req.params.id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "message id must be a uuid" });
    try {
      // getBodyHtml throws { status: 404 } for an unknown id.
      const body_html = await d.getBodyHtml(id);
      res.json({ body_html: body_html || "" });
    } catch (e) {
      res.status(errStatus(e)).json({ error: e.message });
    }
  });

  // POST /messages/:id/ai-draft — any user. Text only; Outlook is not touched.
  router.post("/messages/:id/ai-draft", async (req, res) => {
    const id = String(req.params.id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "message id must be a uuid" });
    const instructions = req.body?.instructions;
    if (instructions !== undefined && instructions !== null && typeof instructions !== "string") {
      return res.status(400).json({ error: "instructions must be text" });
    }
    try {
      const msg = await loadMessage(id);
      if (!msg) return res.status(404).json({ error: "Message not found" });
      const messages = msg.conversation_id ? await threadMessages(msg.connection_id, msg.conversation_id) : [msg];
      let bodyHtml = "";
      try { bodyHtml = await d.getBodyHtml(id); } catch (e) {
        console.warn("[FPX-MAILBOX] body fetch for ai-draft failed, using preview:", e?.message || e);
      }
      const { data: connRow } = await db().from("fpx_mailbox_connections").select("mailbox").eq("id", msg.connection_id).maybeSingle();
      const result = await d.generateMailboxReply({
        messages: messages.length ? messages : [msg],
        replyTo: msg,
        replyBodyHtml: bodyHtml,
        instructions: instructions || "",
        mailbox: connRow?.mailbox || DEFAULT_MAILBOX,
        callMeta: { user_email: actorOf(req), metadata: { conversation_id: msg.conversation_id, message_id: id } },
      });
      if (result?.error) return res.status(502).json({ error: result.error });
      d.logGovernance(req, {
        event_type: "ai_draft", feature: "mailbox_draft", setting_key: "prompt.mailbox_draft.system",
        summary: `AI drafted a support reply to "${String(msg.subject || "(no subject)").slice(0, 120)}" (not saved to Outlook)`,
        after: { body: result.body }, analysis_id: result.analysis_id || null,
        metadata: { conversation_id: msg.conversation_id, message_id: id, instructions: instructions || null, model: result.model || null },
      });
      res.json({ body: result.body });
    } catch (e) {
      res.status(errStatus(e)).json({ error: e.message });
    }
  });

  // POST /messages/:id/draft — any user. Creates a reply DRAFT in Outlook
  // (createReply / createReplyAll). Never sends.
  router.post("/messages/:id/draft", async (req, res) => {
    const id = String(req.params.id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "message id must be a uuid" });
    const v = validateDraftBody(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const msg = await loadMessage(id);
      if (!msg) return res.status(404).json({ error: "Message not found" });
      const conn = await d.loadConnection();
      if (!conn || conn.status !== "connected") return res.status(409).json({ error: "The support mailbox is not connected" });
      if (conn.id !== msg.connection_id) return res.status(409).json({ error: "This message belongs to a mailbox connection that is no longer active" });
      if (!msg.graph_id) return res.status(409).json({ error: "This message has no Outlook id yet; sync and try again" });

      const path = draftPathFor(conn.mailbox, msg.graph_id, v.reply_all);
      const created = await d.graphFetch(
        { tenant_id: conn.tenant_id, client_id: conn.client_id, client_secret: conn.client_secret, mailbox: conn.mailbox },
        path,
        { method: "POST", body: { comment: plainTextToHtml(v.body) } },
      );
      const draftRow = {
        connection_id: conn.id,
        conversation_id: msg.conversation_id || created?.conversationId || null,
        reply_to_message_id: msg.id,
        draft_graph_id: created?.id || null,
        web_link: created?.webLink || null,
        body: v.body,
        ai_generated: v.ai_generated,
        reply_all: v.reply_all,
        created_by: actorOf(req),
      };
      const { data, error } = await db().from("fpx_mailbox_drafts").insert(draftRow).select(DRAFT_COLS).single();
      logAuditSafe(req, {
        action: "create", entity_type: "mailbox_draft", entity_id: data?.id || created?.id || null,
        summary: `Created an Outlook ${v.reply_all ? "reply-all" : "reply"} draft for "${String(msg.subject || "(no subject)").slice(0, 120)}"${v.ai_generated ? " (AI-written)" : ""}`,
        after: { body: v.body },
        metadata: { conversation_id: msg.conversation_id, message_id: msg.id, reply_all: v.reply_all, ai_generated: v.ai_generated, chars: v.body.length, saved: !error },
      });
      if (error) {
        // The Outlook draft exists; only our record of it failed.
        console.warn("[FPX-MAILBOX] draft row insert failed:", error.message);
        return res.json({
          draft: { id: null, conversation_id: draftRow.conversation_id, reply_to_message_id: msg.id, web_link: draftRow.web_link, body: v.body, ai_generated: v.ai_generated, reply_all: v.reply_all, created_by: draftRow.created_by, created_at: new Date().toISOString() },
          warning: `Draft created in Outlook, but FPX could not record it: ${error.message}`,
        });
      }
      res.json({ draft: data });
    } catch (e) {
      res.status(errStatus(e, 502)).json({ error: e.message });
    }
  });

  function logAuditSafe(req, entry) {
    try {
      const p = d.logAudit(req, entry);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* never break the request */ }
  }

  return router;
}

export const mailboxRouter = buildMailboxRouter();
