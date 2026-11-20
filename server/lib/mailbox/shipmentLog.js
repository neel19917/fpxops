// Logs Support Mailbox threads on the FPX shipments they are linked to: one
// fpx_shipment_notes row per link ("Support email linked: ..."), with a link
// back to the thread in the dashboard. The note shows in the shipment drawer.
//
// - Only links that are not dismissed and not yet logged, created in the last
//   30 days, on a thread whose last message is in the last 30 days (or a link
//   a person made). Older links are never backfilled.
// - Claimed first (update ... where logged_at is null), so two processes can
//   never log the same link twice; then the note is inserted and its id saved.
// - fpx_shipments.notes (the people's "latest note") is never touched.
// - Nothing is ever deleted. Dismissing a link keeps its note.
import { supabase as realSupabase } from "../supabase.js";

export const _deps = { supabase: realSupabase };

export const LOG_WINDOW_DAYS = 30;
export const NOTE_AUTHOR = "Support Mailbox";
export const MAX_NOTE_CHARS = 5000;
const PAGE = 500;
const MAX_SCAN = 2000;
const CONV_CHUNK = 40;
const ID_CHUNK = 200;

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const key = (c, v) => `${c}\u0000${v}`;
const toMs = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

// Where the dashboard lives (same env var the invoice report email uses);
// "" gives a relative link.
export function dashboardBase(env = process.env) {
  return String(env.DASHBOARD_URL || env.FPX_PUBLIC_URL || "https://fpxpress.netlify.app").trim().replace(/\/+$/, "");
}

export function threadUrl(conversationId, base = dashboardBase()) {
  return `${base}/mailbox?c=${encodeURIComponent(String(conversationId || ""))}`;
}

// "2026-11-20T15:04:09Z" -> "2026-11-20 15:04 UTC"
export function formatUtc(v) {
  const ms = toMs(v);
  if (ms == null) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const MATCH_LABELS = {
  shipment_id: "shipment id", tracking_number: "tracking number", order_number: "order number",
  pickup_number: "pickup number", confirmation_number: "confirmation number", reference: "reference",
};

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// link: { conversation_id, matched_on, matched_text, source, created_by }
// thread: { subject, last_from_name, last_from_address, party, message_count, last_message_at }
export function buildLinkNote(link = {}, thread = {}, { base = dashboardBase() } = {}) {
  const subject = oneLine(thread.subject) || "(no subject)";
  const name = oneLine(thread.last_from_name);
  const addr = oneLine(thread.last_from_address);
  const from = name && addr ? `${name} <${addr}>` : (name || addr || "(unknown sender)");
  const party = thread.party && thread.party !== "unknown" ? ` · ${thread.party}` : "";
  const n = Number(thread.message_count) || 0;
  const last = formatUtc(thread.last_message_at);
  const counts = `${n} message${n === 1 ? "" : "s"}${last ? `, last ${last}` : ""}`;
  const manual = link.source === "person" || link.matched_on === "manual";
  const how = manual
    ? `Linked by ${oneLine(link.created_by) || "a person"}`
    : `Matched on ${MATCH_LABELS[link.matched_on] || oneLine(link.matched_on) || "number"}: ${oneLine(link.matched_text)}`;
  const open = `Open: ${threadUrl(link.conversation_id, base)}`;
  const head = [
    `Support email linked: ${subject.slice(0, 300)}`,
    `From: ${from.slice(0, 300)}${party} · ${counts}`,
    how.slice(0, 400),
  ].join("\n");
  // Keep the link intact; trim the text above it if needed.
  const room = MAX_NOTE_CHARS - open.length - 1;
  return `${head.slice(0, Math.max(0, room))}\n${open}`.slice(0, MAX_NOTE_CHARS);
}

export function buildUnlinkNote(thread = {}, who = null) {
  const subject = oneLine(thread.subject) || "(no subject)";
  return `Support email unlinked: ${subject.slice(0, 300)} (by ${oneLine(who) || "a person"})`.slice(0, MAX_NOTE_CHARS);
}

// Is a link old enough that it must not be logged?
export function isLoggable(link, thread, nowMs = Date.now()) {
  if (!link || !thread) return false;
  const cutoff = nowMs - LOG_WINDOW_DAYS * 86_400_000;
  const created = toMs(link.created_at);
  if (created != null && created < cutoff) return false;
  if (link.source === "person") return true;
  const last = toMs(thread.last_message_at);
  return last != null && last >= cutoff;
}

const LINK_SELECT = "id, connection_id, conversation_id, shipment_id, matched_on, matched_text, source, created_by, created_at";
const SUMMARY_SELECT = "connection_id, conversation_id, subject, last_message_at, message_count, last_from_name, last_from_address, party";

async function loadSummaries(db, links) {
  const out = new Map();
  const byConn = new Map();
  for (const l of links) {
    if (!byConn.has(l.connection_id)) byConn.set(l.connection_id, new Set());
    byConn.get(l.connection_id).add(l.conversation_id);
  }
  for (const [cid, convs] of byConn) {
    for (const part of chunk([...convs], CONV_CHUNK)) {
      const { data, error } = await db.from("fpx_mailbox_thread_summary").select(SUMMARY_SELECT)
        .eq("connection_id", cid).in("conversation_id", part);
      if (error) throw new Error(`threads not read: ${error.message}`);
      for (const r of data || []) out.set(key(r.connection_id, r.conversation_id), r);
    }
  }
  return out;
}

// FreightPOP shipment id -> newest fpx_shipments row { id, tracking_number }.
export async function latestShipmentRows(db, shipmentIds) {
  const out = new Map();
  for (const part of chunk([...new Set(shipmentIds.map(String))], ID_CHUNK)) {
    const { data, error } = await db.from("fpx_shipments").select("id, shipment_id, tracking_number, scraped_at")
      .in("shipment_id", part).order("scraped_at", { ascending: false }).limit(5000);
    if (error) throw new Error(`shipments not read: ${error.message}`);
    for (const r of data || []) {
      const k = String(r.shipment_id);
      if (r.id && !out.has(k)) out.set(k, r);
    }
  }
  return out;
}

// Log one link (already known loggable). -> true when a note was written.
async function logOne(db, link, thread, ship, nowIso, base) {
  // Claim: only one process gets the row back.
  const { data: claimed, error: cErr } = await db.from("fpx_mailbox_links").update({ logged_at: nowIso })
    .eq("id", link.id).is("logged_at", null).select("id");
  if (cErr) throw new Error(`link not claimed: ${cErr.message}`);
  if (!(Array.isArray(claimed) ? claimed.length : claimed)) return false;

  const body = buildLinkNote(link, thread, { base });
  const { data: note, error: nErr } = await db.from("fpx_shipment_notes")
    .insert({ shipment_id: ship.id, tracking_number: ship.tracking_number ?? null, body, created_by: NOTE_AUTHOR })
    .select("id").single();
  if (nErr || !note?.id) {
    // Give the claim back so a later tick can try again (no note was written).
    await db.from("fpx_mailbox_links").update({ logged_at: null }).eq("id", link.id).is("note_id", null);
    throw new Error(`note not saved: ${nErr?.message || "no id returned"}`);
  }
  const { error: uErr } = await db.from("fpx_mailbox_links").update({ note_id: note.id }).eq("id", link.id);
  if (uErr) console.warn(`[FPX] mailbox log: note ${note.id} saved but not recorded on link ${link.id}: ${uErr.message}`);
  return true;
}

// -> { logged, skipped, error? }. Never throws.
//   connectionId / conversationId  only this thread (after a manual link)
//   db                             supabase client (defaults to the shared one)
export async function logLinksToShipments({ limit = 200, connectionId = null, conversationId = null, db = null, now = new Date() } = {}) {
  const out = { logged: 0, skipped: 0 };
  try {
    const client = db || _deps.supabase;
    const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso = new Date(nowMs - LOG_WINDOW_DAYS * 86_400_000).toISOString();
    const base = dashboardBase();
    const errors = [];

    for (let off = 0; off < MAX_SCAN && out.logged < lim; off += PAGE) {
      let q = client.from("fpx_mailbox_links").select(LINK_SELECT)
        .is("logged_at", null).eq("dismissed", false).gte("created_at", cutoffIso);
      if (connectionId) q = q.eq("connection_id", connectionId);
      if (conversationId) q = q.eq("conversation_id", conversationId);
      const { data, error } = await q.order("created_at", { ascending: false }).range(off, off + PAGE - 1);
      if (error) throw new Error(`links not read: ${error.message}`);
      const links = data || [];
      if (!links.length) break;

      const threads = await loadSummaries(client, links);
      const ready = [];
      for (const l of links) {
        const t = threads.get(key(l.connection_id, l.conversation_id));
        if (isLoggable(l, t, nowMs)) ready.push({ link: l, thread: t }); else out.skipped += 1;
      }
      const ships = ready.length ? await latestShipmentRows(client, ready.map((r) => r.link.shipment_id)) : new Map();
      for (const { link, thread } of ready) {
        if (out.logged >= lim) break;
        const ship = ships.get(String(link.shipment_id));
        if (!ship) { out.skipped += 1; continue; } // not in FPX: stays unlogged
        try {
          if (await logOne(client, link, thread, ship, nowIso, base)) out.logged += 1;
        } catch (e) {
          errors.push(e?.message || String(e));
        }
      }
      if (links.length < PAGE) break;
    }
    if (errors.length) { out.error = errors[0]; console.warn(`[FPX] mailbox log: ${errors[0]}`); }
    return out;
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn(`[FPX] mailbox log: ${msg}`);
    return { ...out, error: msg };
  }
}

// After a logged link is dismissed: a second note saying so. The first note is
// kept. -> { logged } Never throws.
export async function logUnlink({ link, who = null, db = null } = {}) {
  try {
    if (!link?.logged_at || !link.note_id) return { logged: 0 };
    const client = db || _deps.supabase;
    const { data: t } = await client.from("fpx_mailbox_thread_summary").select("subject")
      .eq("connection_id", link.connection_id).eq("conversation_id", link.conversation_id).maybeSingle();
    const ships = await latestShipmentRows(client, [link.shipment_id]);
    const ship = ships.get(String(link.shipment_id));
    if (!ship) return { logged: 0 };
    const { error } = await client.from("fpx_shipment_notes")
      .insert({ shipment_id: ship.id, tracking_number: ship.tracking_number ?? null, body: buildUnlinkNote(t || {}, who), created_by: NOTE_AUTHOR });
    if (error) throw new Error(error.message);
    return { logged: 1 };
  } catch (e) {
    console.warn(`[FPX] mailbox log: unlink note not saved: ${e?.message || e}`);
    return { logged: 0, error: e?.message || String(e) };
  }
}
