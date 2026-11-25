// Support Mailbox metrics: pure functions, no database access.
//
// Everything here works on rows already read from fpx_mailbox_messages /
// fpx_mailbox_threads so it can be tested with fixtures.
//
// Rep attribution: every outbound message is "FP Freight Support" with no
// signature, so the rep is found from the Exchange server in the Message-ID
// (<...@SA1P220MB1626.NAMP220.PROD.OUTLOOK.COM> -> SA1P220MB1626).
// - folder 'sentitems'            -> typed in the shared mailbox -> "Shared mailbox (unknown)"
// - folder 'inbox', direction out -> sent from a rep's own mailbox; the host is
//   that rep's mailbox server. Confirmed when a @freightpop.com person has sent
//   inbound mail from the same host; otherwise the hard-coded LIKELY map; else
//   "Unmatched sender".

export const DEFAULT_TZ = "America/Los_Angeles";
export const SHARED_REP = "Shared mailbox (unknown)";
export const UNMATCHED_REP = "Unmatched sender";
export const DEFAULT_MAILBOX = "freightsupport@freightpop.com";
const INTERNAL_DOMAIN = "@freightpop.com";
const DAY = 86_400_000;

// Hosts believed (not proven by data) to be a rep's mailbox server. Edit freely.
// Victor Z: confirmed on PH7P220MB0857 (Aug 24–Sep 8 2026); his mailbox then
// moved EA2P220MB1522 (Sep 8–17) -> DM4P220MB0867 (Sep 18–Oct 26) ->
// CC6P220MB712026 (Oct 27–) with no gaps or overlaps.
const VICTOR = { rep: "Victor Z", email: "victorz@freightpop.com" };
export const LIKELY_REP_HOSTS = {
  PH7P220MB0857: VICTOR,
  EA2P220MB1522: VICTOR,
  DM4P220MB0867: VICTOR,
  CC6P220MB712026: VICTOR,
};

// Internal senders that are systems/shared boxes, never a person.
const SYSTEM_LOCALS = new Set(["support", "ap", "api", "integrationsupport", "freightsupport"]);

export function isSystemSender(address) {
  const a = String(address || "").trim().toLowerCase();
  const local = a.split("@")[0];
  return SYSTEM_LOCALS.has(local) || local.startsWith("microsoftexchange");
}

const isInternal = (address) => String(address || "").trim().toLowerCase().endsWith(INTERNAL_DOMAIN);

/** Exchange host from a Message-ID, upper-cased, or null. */
export function messageHost(internetMessageId) {
  if (!internetMessageId) return null;
  const m = /@([^.>]+)/.exec(String(internetMessageId));
  if (!m) return null;
  const host = m[1].trim().toUpperCase();
  return host || null;
}

function nameFromEmail(email) {
  const local = String(email || "").split("@")[0];
  if (!local) return email || "Unknown";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * Build host -> rep from inbound mail sent by @freightpop.com people.
 * Confirmed hosts come from data; LIKELY_REP_HOSTS fill in hosts not confirmed.
 */
export function buildRepIndex({ inboundInternal = [], likely = LIKELY_REP_HOSTS } = {}) {
  // host -> email -> { count, name }
  const seen = new Map();
  for (const row of inboundInternal || []) {
    const email = String(row?.from_address || "").trim().toLowerCase();
    if (!email || !isInternal(email) || isSystemSender(email)) continue;
    const host = messageHost(row.internet_message_id);
    if (!host) continue;
    if (!seen.has(host)) seen.set(host, new Map());
    const byEmail = seen.get(host);
    const cur = byEmail.get(email) || { count: 0, name: null };
    cur.count += 1;
    if (!cur.name && row.from_name && String(row.from_name).trim()) cur.name = String(row.from_name).trim();
    byEmail.set(email, cur);
  }
  const hostToRep = new Map();
  for (const [host, byEmail] of seen) {
    // If several people share a host (rare), the most frequent sender wins.
    let best = null;
    for (const [email, v] of byEmail) {
      if (!best || v.count > best.count || (v.count === best.count && email < best.email)) best = { email, ...v };
    }
    hostToRep.set(host, { rep: best.name || nameFromEmail(best.email), email: best.email, confidence: "confirmed" });
  }
  // A likely host uses the person's name as the data spells it (from any
  // confirmed host for the same email), so one person never splits into two rows.
  const nameByEmail = new Map();
  for (const v of hostToRep.values()) if (v.email && !nameByEmail.has(v.email)) nameByEmail.set(v.email, v.rep);
  for (const [host, info] of Object.entries(likely || {})) {
    const h = host.toUpperCase();
    const email = info.email ? String(info.email).toLowerCase() : null;
    const rep = (email && nameByEmail.get(email)) || info.rep;
    if (!hostToRep.has(h)) hostToRep.set(h, { rep, email, confidence: "likely" });
  }
  return { hostToRep };
}

/** Who sent an outbound message. */
// The host is checked first in every folder: once Exchange saves sent-as
// copies (MessageCopyForSentAsEnabled), a rep's personal send also lands in
// Sent Items with the rep's host. Only an unmatched Sent Items row is "typed
// in the shared mailbox".
export function attributeRep(msg, repIndex) {
  const host = messageHost(msg?.internet_message_id);
  const hit = host && repIndex?.hostToRep?.get(host);
  if (hit) return { rep: hit.rep, email: hit.email ?? null, confidence: hit.confidence };
  if (msg?.folder === "sentitems") return { rep: SHARED_REP, email: null, confidence: "unknown" };
  return { rep: UNMATCHED_REP, email: null, confidence: "unknown" };
}

// Rows that could be "a customer replied to mail FPX never saw": inbound,
// external sender, RE:/AW: subject. The route checks these conversations for
// outbound mail of any age (outboundEverConversations).
export function neverSeenCandidates(messages = []) {
  const out = new Set();
  for (const m of messages || []) {
    if (!m || m.direction !== "in" || !m.conversation_id) continue;
    if (isInternal(m.from_address)) continue;
    if (!REPLY_SUBJECT_RE.test(String(m.subject || ""))) continue;
    out.add(m.conversation_id);
  }
  return out;
}

// One row per message: by id (offset paging can repeat a row while the sync
// writes), then outbound by Message-ID (the same send can be stored in both
// Inbox and Sent Items).
export function dedupeMessages(messages = []) {
  const seenId = new Set();
  const seenMid = new Set();
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.id != null) { if (seenId.has(m.id)) continue; seenId.add(m.id); }
    if (m.direction === "out" && m.internet_message_id) {
      const mid = String(m.internet_message_id).trim().toLowerCase();
      if (seenMid.has(mid)) continue;
      seenMid.add(mid);
    }
    out.push(m);
  }
  return out;
}

// ---------- time zone helpers (no hard-coded offsets) ----------

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    }));
  }
  return dtfCache.get(tz);
}
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `date` in `tz`. */
export function zonedParts(date, tz = DEFAULT_TZ) {
  const out = {};
  for (const p of dtf(tz).formatToParts(new Date(date))) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute, second: +out.second,
    weekday: WEEKDAYS[out.weekday],
  };
}

// Offset (ms) of tz from UTC at instant t: wall time read as UTC minus t.
function tzOffset(t, tz) {
  const p = zonedParts(t, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(t / 1000) * 1000;
}

/** The instant of local midnight on y-m-d in tz (month 1-12; day may overflow). */
export function zonedMidnight(year, month, day, tz = DEFAULT_TZ) {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - tzOffset(guess, tz);
  const t2 = guess - tzOffset(t, tz);
  if (t2 !== t) t = t2;
  return new Date(t);
}

/** PT-midnight starts of today, this week (Monday) and this month. */
export function periodStarts(now = new Date(), tz = DEFAULT_TZ) {
  const p = zonedParts(now, tz);
  const sinceMonday = (p.weekday + 6) % 7;
  return {
    today: zonedMidnight(p.year, p.month, p.day, tz),
    week: zonedMidnight(p.year, p.month, p.day - sinceMonday, tz),
    month: zonedMidnight(p.year, p.month, 1, tz),
  };
}

/** "YYYY-MM" of `date` in tz. */
export function monthKey(date, tz = DEFAULT_TZ) {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

// Mon–Fri calendar days strictly after the PT date of `from` and strictly
// before the PT date of `now` (today, still in progress, does not count).
export function businessDaysBetween(from, now, tz = DEFAULT_TZ) {
  const a = zonedParts(from, tz);
  const b = zonedParts(now, tz);
  const startDay = Date.UTC(a.year, a.month - 1, a.day);
  const endDay = Date.UTC(b.year, b.month - 1, b.day);
  let n = 0;
  for (let d = startDay + DAY; d < endDay; d += DAY) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

// ---------- text ----------

const CAUTION_RE = /Caution: This email originated outside FreightPOP[\s\S]*?verify the message\./g;

/** Strip the external-mail Caution banner, collapse whitespace, cap at 160 chars. */
export function cleanPreview(text, max = 160) {
  if (text == null) return null;
  const s = String(text).replace(CAUTION_RE, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// ---------- metrics ----------

const toMs = (v) => {
  if (v == null || v === "") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Message timestamp: received first for inbound, sent first for outbound. */
export function messageTime(m) {
  return m.direction === "in"
    ? toMs(m.received_at) ?? toMs(m.sent_at)
    : toMs(m.sent_at) ?? toMs(m.received_at);
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const REPLY_SUBJECT_RE = /^\s*(re|aw)\s*:/i;

function fmtPt(ms, tz) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) + " PT";
}

/**
 * Compute the MailboxMetrics payload.
 * messages: non-removed rows since the start of the trend window.
 * threads: fpx_mailbox_threads rows ({conversation_id,status,last_inbound_at}).
 * priorInboundConversations: conversations with inbound mail before the window.
 */
export function computeMetrics({
  now = new Date(),
  messages = [],
  threads = [],
  inboundInternal = [],
  lastSyncAt = null,
  removedEverCount = null,
  months = 6,
  mailbox = DEFAULT_MAILBOX,
  priorInboundConversations = new Set(),
  outboundEverConversations = new Set(),
  tz = DEFAULT_TZ,
  repIndex = null,
} = {}) {
  const nowMs = new Date(now).getTime();
  const index = repIndex || buildRepIndex({ inboundInternal });
  const starts = periodStarts(new Date(nowMs), tz);
  const prior = priorInboundConversations instanceof Set ? priorInboundConversations : new Set(priorInboundConversations || []);
  const monthCount = Math.min(12, Math.max(1, Math.floor(Number(months) || 6)));

  // Enrich + sort oldest first so "inbound before" is a single pass.
  const rows = [];
  const outEver = outboundEverConversations instanceof Set ? outboundEverConversations : new Set(outboundEverConversations || []);
  for (const m of dedupeMessages(messages)) {
    if (!m || m.removed_in_outlook === true) continue;
    const at = messageTime(m);
    if (at == null || at > nowMs) continue;
    rows.push({ m, at, out: m.direction === "out" });
  }
  rows.sort((a, b) => a.at - b.at);

  const firstInbound = new Map(); // conversation -> earliest inbound ms
  const hasOutbound = new Set();
  for (const r of rows) {
    const c = r.m.conversation_id;
    if (!c) continue;
    if (r.out) hasOutbound.add(c);
    else if (!firstInbound.has(c)) firstInbound.set(c, r.at);
  }
  for (const r of rows) {
    if (!r.out) continue;
    const c = r.m.conversation_id;
    const fi = c ? firstInbound.get(c) : undefined;
    r.reply = Boolean(c && (prior.has(c) || (fi != null && fi < r.at)));
    r.attr = attributeRep(r.m, index);
  }

  // ---- periods ----
  const periods = [["today", starts.today], ["week", starts.week], ["month", starts.month]].map(([period, start]) => {
    const s = start.getTime();
    let received = 0, sent = 0, replies = 0;
    const repliedConv = new Set(), newConv = new Set(), inConv = new Set();
    for (const r of rows) {
      if (r.at < s) continue;
      const c = r.m.conversation_id;
      if (r.out) {
        sent += 1;
        if (r.reply) { replies += 1; if (c) repliedConv.add(c); }
        else if (c) newConv.add(c);
      } else {
        received += 1;
        if (c) inConv.add(c);
      }
    }
    const awaiting = (threads || []).filter((t) => t?.status === "awaiting_reply" && toMs(t.last_inbound_at) != null && toMs(t.last_inbound_at) >= s).length;
    return {
      period, start: start.toISOString(), received, sent, replies,
      conversationsReplied: repliedConv.size, newOutbound: newConv.size, inboundConversations: inConv.size, awaiting,
    };
  });
  const monthPeriod = periods[2];

  // ---- reps ----
  const repMap = new Map();
  const monthStart = starts.month.getTime();
  for (const r of rows) {
    if (!r.out) continue;
    const { rep, email, confidence } = r.attr;
    // Keyed by email when known, so one person is one row even if their
    // display name differs between servers.
    const key = email ? `e:${email}` : `n:${rep}`;
    let e = repMap.get(key);
    if (!e) {
      e = { rep, email, confidence, today: 0, week: 0, month: 0, monthReplies: 0, _conv: new Set(), lastSentAt: null, _last: -Infinity, _sends: [] };
      repMap.set(key, e);
    }
    // Rows are oldest first, so the latest send sets the current identity.
    if (r.at >= e._last) { e._last = r.at; e.email = email ?? e.email; e.confidence = confidence; }
    e._sends.push(r.at);
    if (r.at >= starts.today.getTime()) e.today += 1;
    if (r.at >= starts.week.getTime()) e.week += 1;
    if (r.at >= monthStart) {
      e.month += 1;
      if (r.reply) { e.monthReplies += 1; if (r.m.conversation_id) e._conv.add(r.m.conversation_id); }
    }
  }
  const repOrder = (e) => (e.rep === SHARED_REP || e.rep === UNMATCHED_REP ? 1 : 0);
  const repsFull = [...repMap.values()].sort((a, b) =>
    repOrder(a) - repOrder(b) || b.month - a.month || b.week - a.week || b._last - a._last || a.rep.localeCompare(b.rep));
  const reps = repsFull.map((e) => ({
    rep: e.rep, email: e.email ?? null, confidence: e.confidence,
    today: e.today, week: e.week, month: e.month,
    monthReplies: e.monthReplies, monthConversationsReplied: e._conv.size,
    lastSentAt: Number.isFinite(e._last) ? new Date(e._last).toISOString() : null,
  }));

  // ---- monthly ----
  const nowP = zonedParts(new Date(nowMs), tz);
  const monthly = [];
  const monthIdx = new Map();
  for (let i = monthCount - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(nowP.year, nowP.month - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthIdx.set(key, monthly.length);
    monthly.push({ month: key, received: 0, sent: 0, replies: 0, byRep: {} });
  }
  for (const r of rows) {
    const i = monthIdx.get(monthKey(new Date(r.at), tz));
    if (i == null) continue;
    const b = monthly[i];
    if (r.out) {
      b.sent += 1;
      if (r.reply) b.replies += 1;
      b.byRep[r.attr.rep] = (b.byRep[r.attr.rep] || 0) + 1;
    } else b.received += 1;
  }

  // ---- latest ----
  const latest = rows.slice(-10).reverse().map((r) => ({
    id: String(r.m.id),
    direction: r.out ? "out" : "in",
    sender: r.m.from_name || r.m.from_address || null,
    subject: r.m.subject ?? null,
    at: new Date(r.at).toISOString(),
    preview: cleanPreview(r.m.body_preview),
    rep: r.out ? r.attr.rep : null,
  }));

  // ---- gaps ----
  const gaps = [];
  const monthOut = rows.filter((r) => r.out && r.at >= monthStart);
  const sentOnlyViaCopy = monthOut.filter((r) => r.m.folder === "inbox").length;
  if (sentOnlyViaCopy > 0) {
    gaps.push({
      id: "sent-copies-missing", owner: "Allen", severity: "high",
      title: "Sent copies from personal mailboxes are not saved",
      detail: `${sentOnlyViaCopy} of ${monthOut.length} sends this month were only seen because freightsupport@ was on the email. Replies sent from personal mailboxes without freightsupport@ on To/CC are invisible to FPX.`,
      fix: "Save a copy of mail sent as / on behalf of the shared mailbox in its Sent Items: Set-Mailbox freightsupport@freightpop.com -MessageCopyForSentAsEnabled $true -MessageCopyForSendOnBehalfEnabled $true",
      metric: sentOnlyViaCopy,
    });
  }

  const neverSeen = new Set();
  for (const r of rows) {
    if (r.out || r.at < monthStart) continue;
    const c = r.m.conversation_id;
    if (!c || hasOutbound.has(c) || outEver.has(c)) continue;
    if (isInternal(r.m.from_address)) continue;
    if (!REPLY_SUBJECT_RE.test(String(r.m.subject || ""))) continue;
    neverSeen.add(c);
  }
  if (neverSeen.size > 0) {
    gaps.push({
      id: "replies-never-seen", owner: "Support team", severity: "high",
      title: "Customer replies to emails FPX never saw",
      detail: `Customers or carriers replied (RE:/AW:) to ${plural(neverSeen.size, "email")} this month that FPX never saw go out, so those threads count as awaiting reply.`,
      fix: "Reply from the shared mailbox, or keep freightsupport@freightpop.com on To/CC when replying from your own mailbox.",
      metric: neverSeen.size,
    });
  }

  const sharedSends = monthOut.filter((r) => r.m.folder === "sentitems").length;
  if (sharedSends > 0) {
    gaps.push({
      id: "no-rep-identity", owner: "Allen", severity: "medium",
      title: "Sends from the shared mailbox have no rep",
      detail: `${sharedSends} of ${monthOut.length} sends this month were typed directly in the shared mailbox, so they can't be attributed to a person.`,
      fix: "Turn on mailbox auditing for Send As on freightsupport@freightpop.com, or have reps add their first name to the sign-off.",
      metric: sharedSends,
    });
  }

  for (const e of repsFull) {
    if (e.confidence !== "likely") continue;
    gaps.push({
      id: `rep-unconfirmed:${e.email || e.rep}`, owner: "Support team", severity: "low",
      title: `${e.rep} is matched by a likely server, not confirmed`,
      detail: `${plural(e._sends.length, "send")} are attributed to ${e.rep} because their mail server is believed to be theirs; FPX has not seen an email from ${e.email || e.rep} on that server.`,
      fix: `Ask ${e.rep} to send one email to freightsupport@freightpop.com from their own mailbox so the server can be matched.`,
      metric: e._sends.length,
    });
  }

  const trailing = nowMs - 30 * DAY;
  for (const e of repsFull) {
    if (e.rep === SHARED_REP || e.rep === UNMATCHED_REP) continue;
    const recent = e._sends.filter((t) => t >= trailing).length;
    if (recent < 10) continue;
    const idle = businessDaysBetween(e._last, nowMs, tz);
    if (idle < 2) continue;
    gaps.push({
      id: `rep-quiet:${e.email || e.rep}`, owner: "Support team", severity: "medium",
      title: `${e.rep} has gone quiet`,
      detail: `${e.rep} sent ${recent} emails in the last 30 days but nothing in the last ${plural(idle, "business day")}; last send ${fmtPt(e._last, tz)}. Check they are still copying freightsupport@ or are out.`,
      fix: `Check with ${e.rep}: if they are replying from their own mailbox, keep freightsupport@freightpop.com on To/CC.`,
      metric: idle,
    });
  }

  if (monthPeriod.awaiting > 0) {
    gaps.push({
      id: "awaiting-backlog", owner: "Support team", severity: "medium",
      title: "Threads awaiting reply",
      detail: `${plural(monthPeriod.awaiting, "thread")} with mail this month ${monthPeriod.awaiting === 1 ? "is" : "are"} awaiting a reply.` +
        (neverSeen.size > 0 ? ` ${neverSeen.size} of them may already be answered from a personal mailbox (see "Customer replies to emails FPX never saw").` : ""),
      fix: "Work the awaiting-reply list in the Support Mailbox; reply from the shared mailbox so FPX sees it.",
      metric: monthPeriod.awaiting,
    });
  }

  if (removedEverCount === 0) {
    gaps.push({
      id: "removed-never-tracked", owner: "FPX", severity: "low",
      title: "Filing/deleting in Outlook has never been recorded",
      detail: "0 messages have ever been marked removed in Outlook, so the sync's removal handling is unverified. Filed or deleted emails may still be counted.",
      fix: "Move a test email out of the freightsupport@ Inbox and confirm the next sync marks it removed_in_outlook.",
      metric: 0,
    });
  }

  return {
    asOf: new Date(nowMs).toISOString(),
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    mailbox,
    periods,
    reps,
    monthly,
    latest,
    gaps,
  };
}
