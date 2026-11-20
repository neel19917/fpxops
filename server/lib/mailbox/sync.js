// Syncs the support mailbox's Inbox and Sent Items into fpx_mailbox_messages
// with Microsoft Graph delta queries.
//
// - The first delta round of a folder is its full history (all time). The
//   @odata.nextLink is saved to delta_links[folder].next after EVERY page, so a
//   backfill stopped by the time box (or a restart) resumes where it was.
// - When a round ends Graph hands back an @odata.deltaLink; it is saved to
//   delta_links[folder].delta and next is cleared. Later runs start from it
//   and only see changes.
// - Items marked "@removed" (deleted or moved out of the folder in Outlook)
//   set removed_in_outlook = true. Rows are never deleted.
// - One run at a time (single flight), ~4 minutes at most.
import { supabase, isDbReady } from "../supabase.js";
import { graphFetch, loadConnection, loadConnectionById, mailboxPath } from "./graph.js";
import { withInlineImages } from "./images.js";

export const FOLDERS = ["inbox", "sentitems"];
export const MESSAGE_SELECT = [
  "id", "internetMessageId", "conversationId", "subject", "from", "toRecipients", "ccRecipients",
  "receivedDateTime", "sentDateTime", "bodyPreview", "hasAttachments", "isRead", "importance",
  "categories", "webLink",
].join(",");
export const PAGE_PREFER = "odata.maxpagesize=100";
const RUN_BUDGET_MS = 4 * 60_000;
const UPSERT_CHUNK = 100;
const LOOKUP_CHUNK = 40; // immutable ids are long; keep the in() filter's URL short

const isTestRun = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.some((a) => a.startsWith("--test"));
export const mailboxSyncEnabled = () => isDbReady() && !isTestRun();

const warned = new Map();
function warnOnce(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) || 0) < 10 * 60_000) return;
  warned.set(key, now);
  console.warn(`[FPX] support mailbox: ${message}`);
}

// ---------------------------------------------------------------------------
// Pure helpers

export const normalizeAddress = (a) => (typeof a === "string" ? a.trim().toLowerCase() : "") || null;

// 'out' when the sender is the mailbox itself (case-insensitive). With no
// sender at all, the folder decides.
export function detectDirection(msg, mailbox, folder) {
  const from = normalizeAddress(msg?.from?.emailAddress?.address);
  if (from) return from === normalizeAddress(mailbox) ? "out" : "in";
  return folder === "sentitems" ? "out" : "in";
}

const mapRecipients = (list) => (Array.isArray(list) ? list : []).map((r) => ({
  name: r?.emailAddress?.name ?? null,
  address: normalizeAddress(r?.emailAddress?.address),
}));

// A Graph message -> an fpx_mailbox_messages row (without body_html, which
// is filled lazily and must not be overwritten by a sync).
export function mapGraphMessage(msg, { connectionId, folder, mailbox, now = new Date().toISOString() }) {
  return {
    connection_id: connectionId,
    graph_id: msg.id,
    internet_message_id: msg.internetMessageId ?? null,
    conversation_id: msg.conversationId ?? null,
    folder,
    direction: detectDirection(msg, mailbox, folder),
    subject: msg.subject ?? null,
    from_address: normalizeAddress(msg.from?.emailAddress?.address),
    from_name: msg.from?.emailAddress?.name ?? null,
    to_recipients: mapRecipients(msg.toRecipients),
    cc_recipients: mapRecipients(msg.ccRecipients),
    received_at: msg.receivedDateTime ?? null,
    sent_at: msg.sentDateTime ?? null,
    body_preview: msg.bodyPreview ?? null,
    has_attachments: msg.hasAttachments ?? null,
    is_read: msg.isRead ?? null,
    importance: msg.importance ?? null,
    categories: Array.isArray(msg.categories) ? msg.categories : [],
    web_link: msg.webLink ?? null,
    removed_in_outlook: false,
    updated_at: now,
  };
}

// Splits a delta page's items into live messages and removed ids.
export function splitDeltaItems(items) {
  const upserts = [];
  const removed = [];
  for (const it of items || []) {
    if (!it?.id) continue;
    if (it["@removed"]) removed.push(it.id);
    else upserts.push(it);
  }
  return { upserts, removed };
}

export function initialDeltaPath(mailbox, folder) {
  return `${mailboxPath(mailbox)}/mailFolders/${folder}/messages/delta?$select=${MESSAGE_SELECT}`;
}

// Where a folder's next run starts: a saved nextLink (backfill / round in
// progress), else the saved deltaLink, else a full-history delta.
export function startUrlFor(links, mailbox, folder) {
  const l = links?.[folder] || {};
  return l.next || l.delta || initialDeltaPath(mailbox, folder);
}

// Walks one folder's delta pages. Calls onPage(items) for each page and then
// saveLinks(newFolderLinks) after it, so progress is durable page by page.
// Stops before fetching another page once shouldStop() is true.
// Returns { pages, done } — done means a deltaLink was reached.
export async function pageDelta({ fetchPage, startUrl, folderLinks = {}, onPage, saveLinks, shouldStop = () => false }) {
  let url = startUrl;
  let links = { ...folderLinks };
  let pages = 0;
  while (url) {
    if (shouldStop()) return { pages, done: false, links };
    const page = await fetchPage(url);
    pages += 1;
    await onPage(Array.isArray(page?.value) ? page.value : []);
    const next = page?.["@odata.nextLink"];
    const delta = page?.["@odata.deltaLink"];
    if (next) {
      links = { ...links, next };
      await saveLinks(links);
      url = next;
    } else if (delta) {
      links = { delta };
      await saveLinks(links);
      return { pages, done: true, links };
    } else {
      throw new Error("Graph delta page had neither @odata.nextLink nor @odata.deltaLink");
    }
  }
  return { pages, done: false, links };
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// ---------------------------------------------------------------------------
// Database writes

async function existingIds(connectionId, graphIds) {
  const have = new Set();
  for (const part of chunk(graphIds, LOOKUP_CHUNK)) {
    const { data, error } = await supabase.from("fpx_mailbox_messages")
      .select("graph_id").eq("connection_id", connectionId).in("graph_id", part);
    if (error) throw new Error(`messages not read: ${error.message}`);
    for (const r of data || []) have.add(r.graph_id);
  }
  return have;
}

async function storePage(conn, folder, items, totals) {
  const { upserts, removed } = splitDeltaItems(items);
  if (upserts.length) {
    const now = new Date().toISOString();
    // A message can appear twice in one round; keep the last version.
    const byId = new Map();
    for (const m of upserts) byId.set(m.id, mapGraphMessage(m, { connectionId: conn.id, folder, mailbox: conn.mailbox, now }));
    const rows = [...byId.values()];
    const have = await existingIds(conn.id, rows.map((r) => r.graph_id));
    for (const part of chunk(rows, UPSERT_CHUNK)) {
      const { error } = await supabase.from("fpx_mailbox_messages").upsert(part, { onConflict: "connection_id,graph_id" });
      if (error) throw new Error(`messages not saved: ${error.message}`);
    }
    for (const r of rows) {
      if (have.has(r.graph_id)) totals.updated += 1;
      else totals.added += 1;
    }
  }
  for (const part of chunk(removed, LOOKUP_CHUNK)) {
    // Only rows last seen in THIS folder: a message moved Inbox -> Sent Items
    // is re-added there with its new folder and must stay live.
    const { data, error } = await supabase.from("fpx_mailbox_messages")
      .update({ removed_in_outlook: true, updated_at: new Date().toISOString() })
      .eq("connection_id", conn.id).eq("folder", folder).eq("removed_in_outlook", false).in("graph_id", part)
      .select("id");
    if (error) throw new Error(`removed messages not marked: ${error.message}`);
    totals.removed += data?.length || 0;
  }
}

async function saveDeltaLinks(connId, links) {
  const { error } = await supabase.from("fpx_mailbox_connections")
    .update({ delta_links: links, updated_at: new Date().toISOString() }).eq("id", connId);
  if (error) throw new Error(`sync position not saved: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Sync run

let running = null;
let again = null;
export const mailboxSyncRunning = () => Boolean(running);

async function runSync({ reason, budgetMs = RUN_BUDGET_MS } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const totals = { added: 0, updated: 0, removed: 0, pages: 0 };
  let connRow = null;
  try {
    connRow = await loadConnection();
  } catch (e) {
    warnOnce("load", e?.message || String(e));
    // The row may exist but its secret can't be decrypted: record that on it.
    try {
      await supabase.from("fpx_mailbox_connections")
        .update({ status: "error", last_error: e?.message || String(e), updated_at: new Date().toISOString() })
        .neq("status", "disconnected");
    } catch { /* nothing more to do */ }
    return { ...totals, backfill_done: false, error: e?.message || String(e) };
  }
  if (!connRow) return { ...totals, backfill_done: false, skipped: "no connection" };

  const conn = connRow;
  const links = { ...(conn.delta_links || {}) };
  const folders = {};
  let error = null;
  let timedOut = false;
  try {
    for (const folder of FOLDERS) {
      const shouldStop = () => Date.now() >= deadline;
      const run = async () => pageDelta({
        fetchPage: (url) => graphFetch(conn, url, { headers: { Prefer: PAGE_PREFER } }),
        startUrl: startUrlFor(links, conn.mailbox, folder),
        folderLinks: links[folder] || {},
        onPage: (items) => storePage(conn, folder, items, totals),
        saveLinks: async (fl) => { links[folder] = fl; await saveDeltaLinks(conn.id, links); },
        shouldStop,
      });
      let r;
      try {
        r = await run();
      } catch (e) {
        // 410 Gone: the saved delta/next token expired. Start that folder
        // over from full history (upserts make it safe to re-read).
        if (e?.status !== 410) throw e;
        warnOnce(`reset-${folder}`, `${folder} sync token expired; re-reading the folder from the start`);
        links[folder] = {};
        await saveDeltaLinks(conn.id, links);
        r = await run();
      }
      totals.pages += r.pages;
      folders[folder] = { pages: r.pages, done: r.done };
      if (!r.done) { timedOut = true; break; }
    }
  } catch (e) {
    error = e?.message || String(e);
    warnOnce("sync", `sync stopped: ${error}`);
  }

  const backfillDone = FOLDERS.every((f) => Boolean(links[f]?.delta));
  const finishedAt = new Date().toISOString();
  const result = {
    reason: reason || null,
    started_at: new Date(startedAt).toISOString(),
    finished_at: finishedAt,
    ms: Date.now() - startedAt,
    ...totals,
    folders,
    timed_out: timedOut,
    backfill_done: backfillDone,
    ...(error ? { error } : {}),
  };
  const patch = {
    last_sync_at: finishedAt,
    last_sync_result: result,
    backfill_done: backfillDone,
    status: error ? "error" : "connected",
    last_error: error,
    updated_at: finishedAt,
  };
  // Never revive a connection someone disconnected while the run was going.
  const { error: upErr } = await supabase.from("fpx_mailbox_connections")
    .update(patch).eq("id", conn.id).neq("status", "disconnected");
  if (upErr) warnOnce("status", `sync result not saved: ${upErr.message}`);
  if (totals.added || totals.updated || totals.removed) {
    console.log(`[FPX] support mailbox: +${totals.added} new, ${totals.updated} updated, ${totals.removed} removed in ${totals.pages} page(s)${timedOut ? " (time box reached; continuing)" : ""}`);
  }
  return { added: totals.added, updated: totals.updated, removed: totals.removed, pages: totals.pages, backfill_done: backfillDone, timed_out: timedOut, ...(error ? { error } : {}) };
}

// Single flight. A call during a run returns that run's promise. Never
// rejects: failures come back as { error }.
export function syncMailbox({ reason } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      return await runSync({ reason });
    } catch (e) {
      const msg = e?.message || String(e);
      warnOnce("run", `sync failed: ${msg}`);
      return { added: 0, updated: 0, removed: 0, pages: 0, backfill_done: false, error: msg };
    } finally {
      running = null;
    }
  })();
  running.then((r) => {
    // A request that arrived mid-run, or an unfinished backfill: go again soon.
    const pending = again;
    again = null;
    if (pending) requestSync(pending);
    else if (r?.timed_out && !r?.error) requestSync("backfill");
  });
  return running;
}

// Kicks a sync soon without waiting for it. Does nothing without a database
// or under `node --test`.
export function requestSync(reason) {
  if (!mailboxSyncEnabled()) return;
  if (running) { again = reason || "requested"; return; }
  setTimeout(() => { syncMailbox({ reason }); }, 1000).unref();
}

// Call once after the server starts listening. Every 2 minutes, while a
// connection that is not 'disconnected' exists (an 'error' connection keeps
// being retried so a passing outage heals itself), runs a sync.
let timer = null;
export function startMailboxSyncWorker({ intervalMs = 2 * 60_000, firstRunMs = 30_000 } = {}) {
  try {
    if (!mailboxSyncEnabled()) return false;
    if (timer) return true;
    const tick = async () => {
      try {
        if (running) return;
        const { data, error } = await supabase.from("fpx_mailbox_connections")
          .select("id").neq("status", "disconnected").limit(1);
        if (error) { warnOnce("tick", `connection not read: ${error.message}`); return; }
        if (!data?.length) return;
        await syncMailbox({ reason: "timer" });
      } catch (e) {
        warnOnce("tick", `timer: ${e?.message || e}`);
      }
    };
    setTimeout(tick, firstRunMs).unref();
    timer = setInterval(tick, intervalMs);
    timer.unref();
    return true;
  } catch (e) {
    warnOnce("start", `worker not started: ${e?.message || e}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Message body (lazy)

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function bodyToHtml(body) {
  if (!body) return "";
  const content = body.content ?? "";
  if (String(body.contentType || "").toLowerCase() === "html") return content;
  return `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(content)}</pre>`;
}

export async function getBodyHtml(messageRowId) {
  const { data: row, error } = await supabase.from("fpx_mailbox_messages")
    .select("id, connection_id, graph_id, body_html").eq("id", messageRowId).maybeSingle();
  if (error) throw new Error(`message not read: ${error.message}`);
  if (!row) throw Object.assign(new Error("Message not found"), { status: 404 });

  let conn = null;
  const getConn = async () => (conn ??= await loadConnectionById(row.connection_id));
  if (row.body_html == null) {
    await getConn();
    if (!conn) throw Object.assign(new Error("Mailbox connection not found"), { status: 404 });
    const msg = await graphFetch(conn, `${mailboxPath(conn.mailbox)}/messages/${encodeURIComponent(row.graph_id)}?$select=body`);
    row.body_html = bodyToHtml(msg?.body);
    const { error: upErr } = await supabase.from("fpx_mailbox_messages")
      .update({ body_html: row.body_html, updated_at: new Date().toISOString() }).eq("id", row.id);
    if (upErr) warnOnce("body", `message body not cached: ${upErr.message}`);
  }
  // body_html stays stored with its cid: refs; inline images are served from
  // the Storage cache through fresh signed URLs. Not gated on has_attachments:
  // Graph reports hasAttachments=false for messages whose only attachments are inline.
  if (!/cid:/i.test(row.body_html)) return row.body_html;
  return withInlineImages(getConn, row);
}
