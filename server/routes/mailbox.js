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
const THREAD_COLS = "conversation_id, subject, last_message_at, last_inbound_at, last_outbound_at, message_count, preview, last_from_name, last_from_address, participants, status";

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
  return { status, limit, offset, search };
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

  // GET /status — any user
  router.get("/status", async (_req, res) => {
    try {
      const conn = await activeConnectionRow();
      if (!conn) {
        return res.json({ connected: false, mailbox: DEFAULT_MAILBOX, status: "not_connected", last_sync_at: null, backfill_done: false, message_count: 0, last_error: null });
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
      res.json({ thread: { ...thread, participants: thread.participants || [] }, messages, drafts: drafts || [] });
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
      const base = (cols, opts) => applySearch(db().from("fpx_mailbox_threads").select(cols, opts).eq("connection_id", conn.id));

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
        threads: (list.data || []).map((t) => ({ ...t, participants: t.participants || [] })),
        total: list.count ?? (list.data || []).length,
        counts,
      });
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
