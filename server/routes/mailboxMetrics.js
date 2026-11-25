import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAdmin, DEFAULT_MAILBOX } from "./mailbox.js";

// Support Mailbox Metrics — mounted at /api/mailbox-metrics on the
// authenticated api router. Admin only. Read only: loads mailbox messages,
// threads and the connection's last sync, then hands them to computeMetrics
// (lib/mailbox/metrics.js) for today / week / month, per-rep, monthly trend
// and data-gap numbers. Never writes to the database or the mailbox.

const PAGE = 1000;
const ID_CHUNK = 100;
const LOOKUP_CONCURRENCY = 6;
const TZ = "America/Los_Angeles";

// lib/mailbox/metrics.js is loaded on first use so the router (and its tests)
// don't depend on it at import time.
let metricsMod;
function metricsModule() {
  metricsMod ||= import("../lib/mailbox/metrics.js");
  return metricsMod;
}

export function parseMonths(raw) {
  const n = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(n)) return 6;
  return Math.min(12, Math.max(1, n));
}

function ptParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

// PT midnight on the 1st of (year, month), month 1-12 (may be out of range; normalised).
function ptMonthStart(year, month) {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  // 08:00 UTC is midnight PST; in PDT it reads 01:00, so step back an hour.
  const guess = new Date(Date.UTC(y, m - 1, 1, 8));
  return new Date(guess.getTime() - ptParts(guess).hour * 3600_000);
}

// First day (PT midnight) of the month `months - 1` months before now's PT month.
export function windowStart(now, months) {
  const { year, month } = ptParts(now);
  return ptMonthStart(year, month - (months - 1));
}

// Run `build()` (a fresh query each call) page by page until a short page.
export async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

export function buildMailboxMetricsRouter(deps = {}) {
  const d = {
    supabase,
    computeMetrics: async (...args) => (await metricsModule()).computeMetrics(...args),
    now: () => new Date(),
    ...deps,
  };
  const db = () => d.supabase;
  const router = Router();

  router.get("/", requireAdmin, async (req, res) => {
    try {
      const now = d.now();
      const months = parseMonths(req.query.months);
      const start = windowStart(now, months);
      const startIso = start.toISOString();

      const messages = await fetchAll(() => db().from("fpx_mailbox_messages")
        .select("id, direction, folder, conversation_id, received_at, sent_at, internet_message_id, from_address, from_name, subject, body_preview")
        .eq("removed_in_outlook", false)
        .or(`received_at.gte.${startIso},sent_at.gte.${startIso}`)
        .order("id", { ascending: true }));

      const metricsLib = await metricsModule();
      // Chunked .in() lookups, a few at a time in parallel.
      async function convLookup(ids, build) {
        const found = new Set();
        const chunks = [];
        for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
        for (let i = 0; i < chunks.length; i += LOOKUP_CONCURRENCY) {
          const pages = await Promise.all(chunks.slice(i, i + LOOKUP_CONCURRENCY).map((chunk) => fetchAll(() => build(chunk))));
          for (const rows of pages) for (const r of rows) if (r.conversation_id) found.add(r.conversation_id);
        }
        return found;
      }

      // Outbound conversations in the window that already had an inbound
      // message before the window started (so they're replies, not new).
      // A row with no received_at falls back to sent_at.
      const outConvs = [...new Set(messages.filter((m) => m.direction === "out" && m.conversation_id).map((m) => m.conversation_id))];
      const priorInboundConversations = await convLookup(outConvs, (chunk) => db().from("fpx_mailbox_messages")
        .select("conversation_id")
        .eq("direction", "in")
        .eq("removed_in_outlook", false)
        .in("conversation_id", chunk)
        .or(`received_at.lt.${startIso},and(received_at.is.null,sent_at.lt.${startIso})`)
        .order("id", { ascending: true }));

      // "Customer replied to mail FPX never saw" must mean no outbound EVER,
      // not just inside the window, so the count doesn't move with ?months.
      const outInWindow = new Set(outConvs);
      const candidates = [...metricsLib.neverSeenCandidates(messages)].filter((c) => !outInWindow.has(c));
      const outboundEverConversations = await convLookup(candidates, (chunk) => db().from("fpx_mailbox_messages")
        .select("conversation_id")
        .eq("direction", "out")
        .eq("removed_in_outlook", false)
        .in("conversation_id", chunk)
        .order("id", { ascending: true }));

      const threads = await fetchAll(() => db().from("fpx_mailbox_threads")
        .select("conversation_id, status, last_inbound_at")
        .gte("last_inbound_at", startIso)
        .order("conversation_id", { ascending: true }));

      const inboundInternal = await fetchAll(() => db().from("fpx_mailbox_messages")
        .select("from_address, from_name, internet_message_id")
        .eq("direction", "in")
        .ilike("from_address", "%@freightpop.com")
        .order("id", { ascending: true }));

      const conn = await db().from("fpx_mailbox_connections")
        .select("last_sync_at, mailbox")
        .not("last_sync_at", "is", null)
        .order("last_sync_at", { ascending: false })
        .limit(1);
      if (conn.error) throw new Error(conn.error.message);
      const lastSyncAt = conn.data?.[0]?.last_sync_at ?? null;
      const mailbox = conn.data?.[0]?.mailbox || DEFAULT_MAILBOX;

      const removed = await db().from("fpx_mailbox_messages")
        .select("id", { count: "exact", head: true })
        .eq("removed_in_outlook", true);
      if (removed.error) throw new Error(removed.error.message);
      const removedEverCount = removed.count ?? 0;

      const metrics = await d.computeMetrics({
        now, messages, threads, inboundInternal, lastSyncAt, removedEverCount, months, mailbox, priorInboundConversations, outboundEverConversations,
      });
      res.json(metrics);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}

export const mailboxMetricsRouter = buildMailboxMetricsRouter();
