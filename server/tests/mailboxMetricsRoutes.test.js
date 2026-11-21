import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildMailboxMetricsRouter, parseMonths, windowStart, fetchAll } from "../routes/mailboxMetrics.js";

// ---------- a tiny chainable Supabase fake ----------
function fakeSupabase(handler) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, ops: [] };
      calls.push(q);
      const b = { then(res, rej) { return Promise.resolve().then(() => handler(q)).then(res, rej); } };
      for (const op of ["select", "eq", "or", "order", "range", "limit", "in", "gte", "lt", "ilike", "not", "is"]) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b; };
      }
      return b;
    },
  };
}

const op = (q, name) => q.ops.find((o) => o[0] === name);
const sliceRange = (q, rows) => {
  const r = op(q, "range");
  return r ? rows.slice(r[1], r[2] + 1) : rows;
};

// 2,345 window messages → 3 pages (1000, 1000, 345).
const WINDOW_MSGS = Array.from({ length: 2345 }, (_, i) => ({
  id: `m${String(i).padStart(5, "0")}`,
  direction: i % 2 ? "out" : "in",
  folder: i % 2 ? "sentitems" : "inbox",
  conversation_id: `c${i % 250}`,
  received_at: "2026-11-10T00:00:00Z",
}));

function handler(q) {
  if (q.table === "fpx_mailbox_messages") {
    const sel = op(q, "select");
    if (sel?.[2]?.head) return { data: null, count: 3, error: null };
    if (op(q, "in")) {
      const ids = op(q, "in")[2];
      return { data: sliceRange(q, ids.filter((c) => c === "c1" || c === "c201").map((c) => ({ conversation_id: c }))), error: null };
    }
    if (op(q, "ilike")) return { data: sliceRange(q, [{ from_address: "shaunz@freightpop.com", from_name: "Shaun Zimmerman", internet_message_id: "<x@SA1P220MB1626.NAMP.PROD.OUTLOOK.COM>" }]), error: null };
    return { data: sliceRange(q, WINDOW_MSGS), error: null };
  }
  if (q.table === "fpx_mailbox_threads") return { data: sliceRange(q, [{ conversation_id: "c0", status: "awaiting_reply", last_inbound_at: "2026-11-19T00:00:00Z" }]), error: null };
  if (q.table === "fpx_mailbox_connections") return { data: [{ last_sync_at: "2026-11-20T17:00:00Z", mailbox: "freightsupport@freightpop.com" }], error: null };
  return { data: null, error: null };
}

const NOW = new Date("2026-11-20T18:00:00Z");

function makeApp({ user = { role: "user" }, handle = handler } = {}) {
  const sb = fakeSupabase(handle);
  const captured = [];
  const router = buildMailboxMetricsRouter({
    supabase: sb,
    now: () => NOW,
    computeMetrics: async (input) => { captured.push(input); return { ok: true, months: input.months }; },
  });
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use("/api/mailbox-metrics", router);
  return { app, sb, captured };
}

async function get(app, path) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/mailbox-metrics${path}`);
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { server.close(); }
}

describe("mailbox metrics helpers", () => {
  it("parseMonths clamps to 1–12, default 6", () => {
    assert.equal(parseMonths(undefined), 6);
    assert.equal(parseMonths("abc"), 6);
    assert.equal(parseMonths("3"), 3);
    assert.equal(parseMonths("0"), 1);
    assert.equal(parseMonths("-4"), 1);
    assert.equal(parseMonths("99"), 12);
    assert.equal(parseMonths(["2", "9"]), 2);
  });

  it("windowStart is PT midnight on the 1st, months-1 months back (DST aware)", () => {
    assert.equal(windowStart(NOW, 1).toISOString(), "2026-11-01T07:00:00.000Z"); // Nov 1 is still PDT
    assert.equal(windowStart(NOW, 6).toISOString(), "2026-06-01T07:00:00.000Z");
    assert.equal(windowStart(NOW, 12).toISOString(), "2025-12-01T08:00:00.000Z"); // PST, previous year
    assert.equal(windowStart(new Date("2027-01-15T12:00:00Z"), 2).toISOString(), "2026-12-01T08:00:00.000Z");
    // 03:00 UTC Dec 1 is still Nov 30 in PT.
    assert.equal(windowStart(new Date("2026-12-01T03:00:00Z"), 1).toISOString(), "2026-11-01T07:00:00.000Z");
  });

  it("fetchAll stops on a short page and throws on error", async () => {
    const sb = fakeSupabase((q) => ({ data: sliceRange(q, Array.from({ length: 1000 }, (_, i) => i)), error: null }));
    const rows = await fetchAll(() => sb.from("t").select("*"));
    assert.equal(rows.length, 1000);
    assert.equal(sb.calls.length, 2); // full page, then an empty one
    const bad = fakeSupabase(() => ({ data: null, error: { message: "boom" } }));
    await assert.rejects(fetchAll(() => bad.from("t").select("*")), /boom/);
  });
});

describe("GET /api/mailbox-metrics", () => {
  it("403 for non-admins and never touches the database", async () => {
    const { app, sb, captured } = makeApp({ user: { role: "user" } });
    const r = await get(app, "/");
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "Admins only" });
    assert.equal(sb.calls.length, 0);
    assert.equal(captured.length, 0);
  });

  it("200 for admins: pages every table, builds inputs, default 6 months", async () => {
    const { app, sb, captured } = makeApp({ user: { role: "admin" } });
    const r = await get(app, "/");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, months: 6 });
    assert.equal(captured.length, 1);
    const input = captured[0];
    assert.equal(input.months, 6);
    assert.equal(input.now.toISOString(), NOW.toISOString());
    assert.equal(input.messages.length, 2345, "all three pages fetched");
    assert.equal(new Set(input.messages.map((m) => m.id)).size, 2345);
    assert.equal(input.threads.length, 1);
    assert.equal(input.inboundInternal.length, 1);
    assert.equal(input.lastSyncAt, "2026-11-20T17:00:00Z");
    assert.equal(input.removedEverCount, 3);
    assert.equal(input.mailbox, "freightsupport@freightpop.com");
    assert.ok(input.priorInboundConversations instanceof Set);
    assert.deepEqual([...input.priorInboundConversations].sort(), ["c1", "c201"]);

    // Window messages: removed filter, OR on received/sent from the window start, 3 ranged pages.
    const winCalls = sb.calls.filter((q) => q.table === "fpx_mailbox_messages" && op(q, "or") && !op(q, "in"));
    assert.equal(winCalls.length, 3);
    assert.deepEqual(winCalls.map((q) => op(q, "range").slice(1)), [[0, 999], [1000, 1999], [2000, 2999]]);
    assert.deepEqual(op(winCalls[0], "eq"), ["eq", "removed_in_outlook", false]);
    assert.equal(op(winCalls[0], "or")[1], "received_at.gte.2026-06-01T07:00:00.000Z,sent_at.gte.2026-06-01T07:00:00.000Z");

    // Prior-inbound lookup: 125 outbound conversations (odd c1..c249) → chunks of 100 and 25.
    // Chunks run in parallel; rows with no received_at fall back to sent_at.
    const inCalls = sb.calls.filter((q) => op(q, "in") && q.ops.some((o) => o[0] === "eq" && o[1] === "direction" && o[2] === "in"));
    assert.deepEqual(inCalls.map((q) => op(q, "in")[2].length).sort((a, b) => b - a), [100, 25]);
    assert.ok(inCalls.every((q) => op(q, "or")[1] === "received_at.lt.2026-06-01T07:00:00.000Z,and(received_at.is.null,sent_at.lt.2026-06-01T07:00:00.000Z)"));
    assert.ok(input.outboundEverConversations instanceof Set);

    const threadCall = sb.calls.find((q) => q.table === "fpx_mailbox_threads");
    assert.deepEqual(op(threadCall, "gte"), ["gte", "last_inbound_at", "2026-06-01T07:00:00.000Z"]);
    // Read only.
    assert.ok(sb.calls.every((q) => !q.ops.some((o) => ["insert", "update", "upsert", "delete"].includes(o[0]))));
  });

  it("parses and clamps ?months", async () => {
    for (const [qs, want] of [["?months=3", 3], ["?months=0", 1], ["?months=40", 12], ["?months=x", 6]]) {
      const { app, captured } = makeApp({ user: { role: "admin" } });
      const r = await get(app, qs);
      assert.equal(r.status, 200);
      assert.equal(captured[0].months, want, qs);
    }
  });

  it("500 with the error message when a query fails", async () => {
    const { app } = makeApp({
      user: { role: "admin" },
      handle: (q) => (q.table === "fpx_mailbox_threads" ? { data: null, error: { message: "threads down" } } : handler(q)),
    });
    const r = await get(app, "/");
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: "threads down" });
  });
});
