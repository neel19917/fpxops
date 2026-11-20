import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  buildMailboxRouter, decodeConversationId, parseThreadQuery, validateConnectionBody, validateDraftBody,
  draftPathFor, plainTextToHtml, isAdminReq, sortOldestFirst, errStatus,
  sinceIso, normalizeDomain, validateParty, domainOf, orderContextTasks, shapeThread,
} from "../routes/mailbox.js";
import { htmlToText, stripQuotedHistory, buildMailboxDraftPrompt, finalizeReply, MAX_PROMPT_CHARS } from "../lib/mailbox/drafts.js";

const CONV = "AAQkAGI2/TgSdz+abc==";
const CONN_ID = "11111111-1111-4111-8111-111111111111";
const MSG_ID = "22222222-2222-4222-8222-222222222222";
const GUID = "33333333-3333-4333-8333-333333333333";

// ---------- a tiny chainable Supabase fake ----------
function fakeSupabase(handler) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, ops: [] };
      calls.push(q);
      const b = {
        then(res, rej) { return Promise.resolve().then(() => handler(q)).then(res, rej); },
      };
      for (const op of ["select", "eq", "or", "order", "range", "limit", "maybeSingle", "single", "insert", "update", "upsert", "in", "gte", "contains", "is", "neq", "not"]) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b; };
      }
      return b;
    },
  };
}

const connRow = { id: CONN_ID, mailbox: "freightsupport@freightpop.com", status: "connected", tenant_id: GUID, client_id: GUID, last_sync_at: null, backfill_done: false, last_error: null };
const msgRow = { id: MSG_ID, connection_id: CONN_ID, graph_id: "AAMk/graph+id=", conversation_id: CONV, subject: "Help", from_address: "a@b.com", from_name: "Ann", direction: "in", received_at: "2026-11-01T00:00:00Z", body_preview: "hi" };

function defaultHandler(q) {
  const has = (op) => q.ops.some((o) => o[0] === op);
  if (q.table === "fpx_mailbox_connections") {
    if (has("update") || has("upsert")) return { data: { ...connRow, status: "disconnected" }, error: null };
    return { data: has("maybeSingle") ? connRow : [connRow], error: null };
  }
  if (q.table === "fpx_mailbox_threads") {
    if (has("maybeSingle")) {
      const conv = q.ops.find((o) => o[0] === "eq" && o[1] === "conversation_id")?.[2];
      return { data: conv === CONV ? { conversation_id: CONV, subject: "Help", status: "awaiting_reply", participants: null } : null, error: null };
    }
    return { data: [{ conversation_id: CONV, participants: null }], count: 1, error: null };
  }
  if (q.table === "fpx_mailbox_messages") {
    if (has("maybeSingle")) return { data: msgRow, error: null };
    return { data: [{ ...msgRow, id: "b", received_at: "2026-11-02T00:00:00Z" }, msgRow], count: 2, error: null };
  }
  if (q.table === "fpx_mailbox_drafts") {
    if (has("insert")) return { data: { id: "d1", ...q.ops.find((o) => o[0] === "insert")[1] }, error: null };
    return { data: [], error: null };
  }
  return { data: null, error: null };
}

function makeApp({ user = { role: "user", email: "u@x.com" }, apiKey = null, deps = {} } = {}) {
  const sb = fakeSupabase(defaultHandler);
  const graphCalls = [];
  const audits = [];
  const syncs = [];
  const router = buildMailboxRouter({
    supabase: sb,
    logAudit: async (_req, e) => { audits.push(e); },
    logGovernance: async () => {},
    encryptSecret: (s) => `enc(${s})`,
    graphFetch: async (conn, path, opts) => { graphCalls.push({ conn, path, opts }); return { id: "draft-graph-id", webLink: "https://outlook/x" }; },
    loadConnection: async () => ({ ...connRow, client_secret: "SECRET" }),
    testConnection: async () => ({ ok: true, inbox_total: 5, sent_total: 3 }),
    publicConnection: (r) => { const { secret_enc, client_secret, ...rest } = r || {}; return rest; },
    requestSync: (r) => { syncs.push(r); },
    getBodyHtml: async () => "<p>Hello<br>there</p>",
    generateMailboxReply: async () => ({ body: "Hi\n\nFreightPOP Support", model: "m" }),
    ...deps,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; req.apiKey = apiKey; next(); });
  app.use("/api/mailbox", router);
  return { app, sb, graphCalls, audits, syncs };
}

async function withServer(ctx, fn) {
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/mailbox`;
  try { return await fn(base); } finally { server.close(); }
}

async function call(base, path, { method = "GET", body } = {}) {
  const r = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ---------- pure helpers ----------
describe("mailbox route helpers", () => {
  it("decodeConversationId: path value (already decoded by Express), query fallback, + restored", () => {
    assert.equal(decodeConversationId({ pathValue: CONV }), CONV);
    assert.equal(decodeConversationId({ pathValue: encodeURIComponent(CONV) }), CONV); // proxy left it encoded
    assert.equal(decodeConversationId({ queryValue: CONV.replace("+", " ") }), CONV);
    assert.equal(decodeConversationId({ queryValue: [CONV] }), CONV);
    assert.equal(decodeConversationId({ pathValue: "", queryValue: CONV }), CONV);
    assert.equal(decodeConversationId({}), null);
    assert.equal(decodeConversationId({ pathValue: "x".repeat(2000) }), null);
    assert.equal(decodeConversationId({ pathValue: "bad%zz" }), "bad%zz");
  });

  it("parseThreadQuery: defaults, clamps, status check, search sanitized", () => {
    assert.deepEqual(parseThreadQuery({}), { status: "all", limit: 50, offset: 0, search: "", party: "all", days: 30, shipment_id: null });
    assert.equal(parseThreadQuery({ limit: "9999" }).limit, 200);
    assert.equal(parseThreadQuery({ limit: "0" }).limit, 1);
    assert.equal(parseThreadQuery({ offset: "-5" }).offset, 0);
    assert.ok(parseThreadQuery({ status: "nope" }).error);
    assert.equal(parseThreadQuery({ status: "responded" }).status, "responded");
    assert.equal(parseThreadQuery({ q: "a,b(c)%*:d" }).search, "a b c d");
  });

  it("validateConnectionBody: GUIDs, secret, default mailbox", () => {
    assert.ok(validateConnectionBody({ tenant_id: "x", client_id: GUID, client_secret: "s" }).error);
    assert.ok(validateConnectionBody({ tenant_id: GUID, client_id: "x", client_secret: "s" }).error);
    assert.ok(validateConnectionBody({ tenant_id: GUID, client_id: GUID }).error);
    assert.ok(validateConnectionBody({ tenant_id: GUID, client_id: GUID, client_secret: "s", mailbox: "nope" }).error);
    const ok = validateConnectionBody({ tenant_id: GUID, client_id: GUID, client_secret: " s3cret " });
    assert.equal(ok.mailbox, "freightsupport@freightpop.com");
    assert.equal(ok.client_secret, "s3cret");
  });

  it("validateDraftBody", () => {
    assert.ok(validateDraftBody({}).error);
    assert.ok(validateDraftBody({ body: "   " }).error);
    assert.ok(validateDraftBody({ body: "x", reply_all: "yes" }).error);
    assert.ok(validateDraftBody({ body: "x".repeat(50_001) }).error);
    assert.deepEqual(validateDraftBody({ body: "a\r\nb", reply_all: true }), { body: "a\nb", reply_all: true, ai_generated: false });
  });

  it("draftPathFor never targets /send", () => {
    const p1 = draftPathFor("freightsupport@freightpop.com", "AAMk/x+y=", false);
    const p2 = draftPathFor("freightsupport@freightpop.com", "AAMk/x+y=", true);
    assert.match(p1, /\/createReply$/);
    assert.match(p2, /\/createReplyAll$/);
    for (const p of [p1, p2]) assert.doesNotMatch(p, /\/send/i);
    assert.ok(p1.includes(encodeURIComponent("AAMk/x+y=")));
  });

  it("plainTextToHtml escapes and keeps line breaks", () => {
    assert.equal(plainTextToHtml("a<b>\nc & d"), "a&lt;b&gt;<br>c &amp; d");
  });

  it("isAdminReq: admin role or admin-scope key only", () => {
    assert.equal(isAdminReq({ user: { role: "admin" } }), true);
    assert.equal(isAdminReq({ user: { role: "user" } }), false);
    assert.equal(isAdminReq({ apiKey: { scopes: ["admin"] } }), true);
    assert.equal(isAdminReq({ apiKey: { scopes: ["read"] } }), false);
    assert.equal(isAdminReq({}), false);
  });

  it("errStatus: Graph 401/403 never reach the browser as auth failures", () => {
    assert.equal(errStatus({ status: 401 }), 502);
    assert.equal(errStatus({ status: 403 }), 502);
    assert.equal(errStatus({ status: 404 }), 404);
    assert.equal(errStatus({}), 500);
  });

  it("sortOldestFirst uses received_at or sent_at", () => {
    const out = sortOldestFirst([{ id: 2, sent_at: "2026-02-01" }, { id: 1, received_at: "2026-01-01" }]);
    assert.deepEqual(out.map((m) => m.id), [1, 2]);
  });
});

describe("mailbox drafts helpers", () => {
  it("htmlToText strips tags and decodes entities", () => {
    assert.equal(htmlToText("<style>x{}</style><p>Hi&nbsp;Bob</p><p>A &amp; B<br>C</p>"), "Hi Bob\nA & B\nC");
    assert.equal(htmlToText(""), "");
  });
  it("stripQuotedHistory cuts Outlook quoted history", () => {
    assert.equal(stripQuotedHistory("New text\n\nFrom: Someone\nSent: Monday\nTo: x\nold"), "New text");
    assert.equal(stripQuotedHistory("Only text"), "Only text");
  });
  it("buildMailboxDraftPrompt: oldest first, capped, includes instructions, no FPX brokerage framing", () => {
    const msgs = [
      { direction: "in", from_name: "B", received_at: "2026-11-02", body_preview: "second" },
      { direction: "out", from_name: "Support", sent_at: "2026-11-01", body_preview: "first" },
    ];
    const p = buildMailboxDraftPrompt({ messages: msgs, replyTo: msgs[0], replyBodyText: "full text", instructions: "be brief" });
    assert.ok(p.indexOf("first") < p.indexOf("second"));
    assert.ok(p.includes("full text") && p.includes("be brief"));
    assert.doesNotMatch(p, /brokerage/i);
    const big = Array.from({ length: 200 }, (_, i) => ({ direction: "in", received_at: `2026-01-${String(i).padStart(3, "0")}`, body_preview: "y".repeat(500) }));
    const p2 = buildMailboxDraftPrompt({ messages: big, replyTo: big[199], replyBodyText: "z".repeat(20000) });
    assert.ok(p2.length <= MAX_PROMPT_CHARS + 200);
    assert.match(p2, /older message\(s\) omitted/);
  });
  it("finalizeReply adds the signature when missing", () => {
    assert.match(finalizeReply("Hello"), /FreightPOP Support$/);
    assert.equal(finalizeReply("Hi\nFreightPOP Support"), "Hi\nFreightPOP Support");
    assert.equal(finalizeReply("```\nHi\n```"), "Hi\n\nBest regards,\nFreightPOP Support");
  });
});

// ---------- HTTP ----------
describe("mailbox router over HTTP", () => {
  it("admin routes reject non-admins with 403", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      for (const [method, path] of [["GET", "/connection"], ["POST", "/connection"], ["POST", "/connection/test"], ["POST", "/connection/disconnect"], ["POST", "/sync"]]) {
        const r = await call(base, path, { method, body: method === "POST" ? {} : undefined });
        assert.equal(r.status, 403, `${method} ${path}`);
      }
    });
    assert.equal(ctx.syncs.length, 0);
  });

  it("admin-scope API key passes the admin guard", async () => {
    const ctx = makeApp({ user: null, apiKey: { scopes: ["admin"], name: "k" } });
    await withServer(ctx, async (base) => {
      const r = await call(base, "/sync", { method: "POST" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { started: true });
    });
    assert.deepEqual(ctx.syncs, ["manual"]);
  });

  it("POST /connection validates, tests, never returns the secret", async () => {
    const ctx = makeApp({ user: { role: "admin", email: "a@x.com" } });
    await withServer(ctx, async (base) => {
      const bad = await call(base, "/connection", { method: "POST", body: { tenant_id: "nope", client_id: GUID, client_secret: "s" } });
      assert.equal(bad.status, 400);
      const ok = await call(base, "/connection", { method: "POST", body: { tenant_id: GUID, client_id: GUID, client_secret: "topsecret1234" } });
      assert.equal(ok.status, 200);
      assert.ok(ok.json.connection);
      assert.equal(ok.json.test.ok, true);
      assert.doesNotMatch(JSON.stringify(ok.json), /topsecret|secret_enc|client_secret/);
    });
    assert.deepEqual(ctx.syncs, ["connect"]);
    assert.doesNotMatch(JSON.stringify(ctx.audits), /topsecret/);
    const upsert = ctx.sb.calls.find((c) => c.ops.some((o) => o[0] === "upsert"));
    assert.equal(upsert.ops.find((o) => o[0] === "upsert")[1].secret_enc, "enc(topsecret1234)");
  });

  it("POST /connection saves nothing when the test fails", async () => {
    const ctx = makeApp({ user: { role: "admin" }, deps: { testConnection: async () => ({ ok: false, error: "role missing" }) } });
    await withServer(ctx, async (base) => {
      const r = await call(base, "/connection", { method: "POST", body: { tenant_id: GUID, client_id: GUID, client_secret: "s" } });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, "role missing");
    });
    assert.ok(!ctx.sb.calls.some((c) => c.ops.some((o) => o[0] === "upsert")));
    assert.equal(ctx.syncs.length, 0);
  });

  it("GET /threads/<encoded id> and /threads?id= both resolve the conversation id", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const a = await call(base, `/threads/${encodeURIComponent(CONV)}`);
      assert.equal(a.status, 200, JSON.stringify(a.json));
      assert.equal(a.json.thread.conversation_id, CONV);
      assert.deepEqual(a.json.thread.participants, []);
      assert.deepEqual(a.json.messages.map((m) => m.id), [MSG_ID, "b"]); // oldest first
      assert.deepEqual(a.json.drafts, []);
      const b = await call(base, `/threads?id=${encodeURIComponent(CONV)}`);
      assert.equal(b.status, 200);
      assert.equal(b.json.thread.conversation_id, CONV);
      const missing = await call(base, `/threads/${encodeURIComponent("other")}`);
      assert.equal(missing.status, 404);
    });
  });

  it("GET /threads lists with counts and validates status", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await call(base, "/threads?status=awaiting_reply&q=acme");
      assert.equal(r.status, 200);
      assert.equal(r.json.total, 1);
      assert.deepEqual(Object.keys(r.json.counts).sort(), ["all", "awaiting_reply", "outbound_only", "responded"]);
      const bad = await call(base, "/threads?status=weird");
      assert.equal(bad.status, 400);
    });
    const listQ = ctx.sb.calls.find((c) => c.table === "fpx_mailbox_threads" && c.ops.some((o) => o[0] === "range"));
    assert.ok(listQ.ops.some((o) => o[0] === "eq" && o[1] === "connection_id" && o[2] === CONN_ID));
    assert.ok(listQ.ops.some((o) => o[0] === "or" && /subject\.ilike\.%acme%/.test(o[1])));
  });

  it("POST /messages/:id/draft creates a reply draft and never hits /send", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const bad = await call(base, `/messages/${MSG_ID}/draft`, { method: "POST", body: {} });
      assert.equal(bad.status, 400);
      const badId = await call(base, "/messages/not-a-uuid/draft", { method: "POST", body: { body: "x" } });
      assert.equal(badId.status, 400);
      const r1 = await call(base, `/messages/${MSG_ID}/draft`, { method: "POST", body: { body: "Hello <you>\nThanks" } });
      assert.equal(r1.status, 200, JSON.stringify(r1.json));
      assert.equal(r1.json.draft.web_link, "https://outlook/x");
      const r2 = await call(base, `/messages/${MSG_ID}/draft`, { method: "POST", body: { body: "Hi all", reply_all: true, ai_generated: true } });
      assert.equal(r2.status, 200);
      assert.equal(r2.json.draft.reply_all, true);
    });
    assert.equal(ctx.graphCalls.length, 2);
    for (const c of ctx.graphCalls) {
      assert.doesNotMatch(c.path, /\/send/i);
      assert.equal(c.opts.method, "POST");
    }
    assert.match(ctx.graphCalls[0].path, /\/createReply$/);
    assert.match(ctx.graphCalls[1].path, /\/createReplyAll$/);
    assert.equal(ctx.graphCalls[0].opts.body.comment, "Hello &lt;you&gt;<br>Thanks");
    assert.equal(ctx.audits.filter((a) => a.entity_type === "mailbox_draft").length, 2);
  });

  it("POST /messages/:id/draft refuses when the mailbox is disconnected", async () => {
    const ctx = makeApp({ deps: { loadConnection: async () => null } });
    await withServer(ctx, async (base) => {
      const r = await call(base, `/messages/${MSG_ID}/draft`, { method: "POST", body: { body: "x" } });
      assert.equal(r.status, 409);
    });
    assert.equal(ctx.graphCalls.length, 0);
  });

  it("POST /messages/:id/ai-draft returns a body and does not touch Outlook", async () => {
    let seen = null;
    const ctx = makeApp({ deps: { generateMailboxReply: async (args) => { seen = args; return { body: "Hi\n\nFreightPOP Support" }; } } });
    await withServer(ctx, async (base) => {
      const bad = await call(base, `/messages/${MSG_ID}/ai-draft`, { method: "POST", body: { instructions: 5 } });
      assert.equal(bad.status, 400);
      const r = await call(base, `/messages/${MSG_ID}/ai-draft`, { method: "POST", body: { instructions: "mention the KB" } });
      assert.equal(r.status, 200);
      assert.equal(r.json.body, "Hi\n\nFreightPOP Support");
    });
    assert.equal(ctx.graphCalls.length, 0);
    assert.equal(seen.instructions, "mention the KB");
    assert.equal(seen.replyBodyHtml, "<p>Hello<br>there</p>");
    assert.equal(seen.messages[0].id, MSG_ID);
  });

  it("GET /status works for any user", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await call(base, "/status");
      assert.equal(r.status, 200);
      assert.equal(r.json.connected, true);
      assert.equal(r.json.mailbox, "freightsupport@freightpop.com");
      assert.equal(r.json.message_count, 2);
    });
  });
});

// ---------- linking: party, shipments, tasks, related threads ----------
const LINK_ID = "44444444-4444-4444-8444-444444444444";
const SHIP_ROW_ID = "55555555-5555-4555-8555-555555555555";
const OLD_ROW_ID = "66666666-6666-4666-8666-666666666666";
const TASK_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_CONV = "AAQkOther/conv=";

function linkingHandler(overrides = {}) {
  const state = { links: [{ id: LINK_ID, connection_id: CONN_ID, conversation_id: CONV, shipment_id: "15812122", matched_on: "shipment_id", matched_text: "shipID15812122", source: "auto", dismissed: false, created_at: "2026-11-10T00:00:00Z" }], ...overrides };
  return (q) => {
    const has = (op) => q.ops.some((o) => o[0] === op);
    const eqv = (col) => q.ops.find((o) => o[0] === "eq" && o[1] === col)?.[2];
    const inv = (col) => q.ops.find((o) => o[0] === "in" && o[1] === col)?.[2];
    if (q.table === "fpx_mailbox_thread_meta") {
      if (has("upsert")) {
        const r = q.ops.find((o) => o[0] === "upsert")[1];
        return { data: { party: r.party, party_source: r.party_source, party_reason: r.party_reason, party_set_by: r.party_set_by }, error: null };
      }
      return { data: { party: "customer", party_source: "rule", party_reason: "acme.com is a customer", party_set_by: null }, error: null };
    }
    if (q.table === "fpx_mailbox_links") {
      if (has("insert")) return { data: { id: "new-link", dismissed: false, ...q.ops.find((o) => o[0] === "insert")[1] }, error: null };
      if (has("update")) return { data: { ...state.links[0], ...q.ops.find((o) => o[0] === "update")[1] }, error: null };
      let rows = state.links.filter((l) => !l.dismissed || eqv("dismissed") === undefined);
      if (eqv("id")) rows = state.links.filter((l) => l.id === eqv("id"));
      if (eqv("conversation_id")) rows = rows.filter((l) => l.conversation_id === eqv("conversation_id"));
      if (eqv("shipment_id")) rows = rows.filter((l) => l.shipment_id === eqv("shipment_id"));
      if (inv("shipment_id")) rows = rows.filter((l) => inv("shipment_id").includes(l.shipment_id));
      const neq = q.ops.find((o) => o[0] === "neq" && o[1] === "conversation_id")?.[2];
      if (neq) rows = rows.filter((l) => l.conversation_id !== neq);
      if (has("maybeSingle")) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
    if (q.table === "fpx_mailbox_domains") {
      if (has("upsert")) return { data: { ...q.ops.find((o) => o[0] === "upsert")[1] }, error: null };
      if (has("maybeSingle")) return { data: null, error: null };
      return { data: [{ domain: "acme.com", party: "customer" }], error: null };
    }
    if (q.table === "fpx_shipments") {
      if (eqv("id") === SHIP_ROW_ID) return { data: { shipment_id: "15812122", tracking_number: "PRO1" }, error: null };
      if (eqv("id")) return { data: null, error: null };
      if (eqv("shipment_id") === "15812122") return { data: [{ shipment_id: "15812122" }], error: null };
      if (eqv("shipment_id")) return { data: [], error: null };
      if (eqv("tracking_number") === "PRO1") return { data: [{ shipment_id: "15812122" }], error: null };
      if (eqv("tracking_number")) return { data: [], error: null };
      if (inv("shipment_id")) {
        const sel = q.ops.find((o) => o[0] === "select")[1];
        if (sel === "id, shipment_id") return { data: [{ id: SHIP_ROW_ID, shipment_id: "15812122" }, { id: OLD_ROW_ID, shipment_id: "15812122" }], error: null };
        return { data: [
          { id: SHIP_ROW_ID, shipment_id: "15812122", tracking_number: "PRO1", customer_name: "Acme", carrier_name: "ABF", shipment_status: "In Transit", scraped_at: "2026-11-19" },
          { id: OLD_ROW_ID, shipment_id: "15812122", tracking_number: "PRO1", customer_name: "Acme", carrier_name: "ABF", shipment_status: "Booked", scraped_at: "2026-11-01" },
        ], error: null };
      }
      return { data: null, error: null };
    }
    if (q.table === "fpx_shipment_tasks") {
      if (has("maybeSingle")) {
        if (eqv("id") === TASK_ID) return { data: { id: TASK_ID, shipment_id: overrides.taskShipmentRow === undefined ? SHIP_ROW_ID : overrides.taskShipmentRow, tracking_number: "PRO1" }, error: null };
        return { data: null, error: null };
      }
      if (inv("shipment_id")) return { data: [
        { id: "t1", shipment_id: OLD_ROW_ID, tracking_number: "PRO1", title: "Done old", status: "done", created_at: "2026-11-02" },
        { id: "t2", shipment_id: SHIP_ROW_ID, tracking_number: "PRO1", title: "Call carrier", status: "open", created_at: "2026-11-01" },
      ], error: null };
      if (inv("tracking_number")) return { data: [{ id: "t2", shipment_id: SHIP_ROW_ID, tracking_number: "PRO1", title: "Call carrier", status: "open", created_at: "2026-11-01" }], error: null };
      return { data: [], error: null };
    }
    if (q.table === "fpx_mailbox_threads") {
      if (inv("conversation_id")) {
        return { data: inv("conversation_id").map((c) => ({ conversation_id: c, subject: `S ${c}`, last_message_at: "2026-11-15", status: "responded", party: null, participants: null, linked_shipment_ids: ["15812122"], linked_count: 1 })), error: null };
      }
    }
    if (q.table === "fpx_mailbox_messages" && !has("maybeSingle")) {
      return { data: [
        { ...msgRow, from_address: "Jo@Acme.com", direction: "in" },
        { ...msgRow, id: "c", from_address: "x@ups.com", direction: "in" },
        { ...msgRow, id: "d", from_address: "freightsupport@freightpop.com", direction: "out" },
      ], error: null };
    }
    return defaultHandler(q);
  };
}

function makeLinkApp(handlerOverrides, deps = {}) {
  const ctx = makeApp({ deps });
  const sb = fakeSupabase(linkingHandler(handlerOverrides));
  const classify = [];
  const router = buildMailboxRouter({
    supabase: sb,
    logAudit: async (_req, e) => { ctx.audits.push(e); },
    logGovernance: async () => {},
    classifyDomainChange: async (...a) => { classify.push(a); },
    ...deps,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { role: "user", email: "u@x.com" }; next(); });
  app.use("/api/mailbox", router);
  return { app, sb, audits: ctx.audits, classify };
}

describe("mailbox linking helpers", () => {
  it("parseThreadQuery: party, days, shipment_id", () => {
    assert.ok(parseThreadQuery({ party: "vendor" }).error);
    assert.equal(parseThreadQuery({ party: "Carrier" }).party, "carrier");
    assert.equal(parseThreadQuery({ party: "unknown" }).party, "unknown");
    assert.equal(parseThreadQuery({ days: "7" }).days, 7);
    assert.equal(parseThreadQuery({ days: "all" }).days, null);
    assert.ok(parseThreadQuery({ days: "45" }).error);
    // A shipment filter without an explicit range looks at all time.
    assert.equal(parseThreadQuery({ shipment_id: " 15812122 " }).shipment_id, "15812122");
    assert.equal(parseThreadQuery({ shipment_id: "15812122" }).days, null);
    assert.equal(parseThreadQuery({ shipment_id: "15812122", days: "90" }).days, 90);
  });
  it("sinceIso", () => {
    assert.equal(sinceIso(null), null);
    assert.equal(sinceIso(1, Date.parse("2026-11-20T00:00:00Z")), "2026-11-19T00:00:00.000Z");
  });
  it("normalizeDomain / validateParty / domainOf", () => {
    assert.equal(normalizeDomain(" @ACME.com "), "acme.com");
    assert.equal(normalizeDomain("mail.acme.co.uk"), "mail.acme.co.uk");
    for (const bad of ["acme", "a@b.com", "acme..com", "-x.com", "x".repeat(300) + ".com", "acme.com/x", ""]) assert.equal(normalizeDomain(bad), null, bad);
    assert.equal(validateParty("Customer"), "customer");
    assert.equal(validateParty("unknown"), null);
    assert.equal(validateParty("vendor"), null);
    assert.equal(domainOf("Jo <jo@Acme.com>"), "acme.com");
    assert.equal(domainOf("nobody"), null);
  });
  it("orderContextTasks: open first, then recent closed (capped)", () => {
    const closed = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, status: "done", created_at: `2026-10-${String(i + 1).padStart(2, "0")}` }));
    const out = orderContextTasks([...closed, { id: "o1", status: "open", created_at: "2026-01-01" }, { id: "o2", status: "in_progress", created_at: "2026-02-01" }]);
    assert.deepEqual(out.slice(0, 2).map((t) => t.id), ["o2", "o1"]);
    assert.equal(out.length, 22);
    assert.equal(out[2].id, "c24");
  });
  it("shapeThread defaults the linking columns", () => {
    assert.deepEqual(shapeThread({ conversation_id: "x" }), { conversation_id: "x", participants: [], party: "unknown", linked_shipment_ids: [], linked_count: 0 });
  });
});

describe("mailbox linking routes over HTTP", () => {
  it("GET /threads applies days (default 30), party and shipment filters to list and counts", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await call(base, "/threads?party=customer");
      assert.equal(r.status, 200);
      assert.equal(r.json.threads[0].party, "unknown");
      assert.deepEqual(r.json.threads[0].linked_shipment_ids, []);
      assert.equal((await call(base, "/threads?party=nope")).status, 400);
      assert.equal((await call(base, "/threads?days=3")).status, 400);
    });
    const threadQs = ctx.sb.calls.filter((c) => c.table === "fpx_mailbox_threads");
    assert.equal(threadQs.length, 5); // list + 4 counts
    for (const q of threadQs) {
      const gte = q.ops.find((o) => o[0] === "gte");
      assert.ok(gte && gte[1] === "last_message_at");
      const ageDays = (Date.now() - Date.parse(gte[2])) / 86_400_000;
      assert.ok(ageDays > 29.9 && ageDays < 30.1);
      assert.ok(q.ops.some((o) => o[0] === "eq" && o[1] === "party" && o[2] === "customer"));
    }
    const ctx2 = makeApp();
    await withServer(ctx2, async (base) => {
      assert.equal((await call(base, "/threads?days=all&shipment_id=15812122")).status, 200);
    });
    for (const q of ctx2.sb.calls.filter((c) => c.table === "fpx_mailbox_threads")) {
      assert.ok(!q.ops.some((o) => o[0] === "gte"));
      assert.ok(!q.ops.some((o) => o[0] === "eq" && o[1] === "party"));
      assert.ok(q.ops.some((o) => o[0] === "contains" && o[1] === "linked_shipment_ids" && o[2][0] === "15812122"));
    }
  });

  it("GET /threads/<id>/context and /threads/context?id= return party, domains, shipments, tasks, related", async () => {
    const ctx = makeLinkApp({ links: [
      { id: LINK_ID, connection_id: CONN_ID, conversation_id: CONV, shipment_id: "15812122", matched_on: "shipment_id", matched_text: "shipID15812122", source: "auto", dismissed: false },
      { id: "l2", connection_id: CONN_ID, conversation_id: OTHER_CONV, shipment_id: "15812122", matched_on: "tracking_number", source: "auto", dismissed: false },
    ] });
    await withServer(ctx, async (base) => {
      const r = await call(base, `/threads/${encodeURIComponent(CONV)}/context`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.party, { party: "customer", source: "rule", reason: "acme.com is a customer", set_by: null });
      assert.deepEqual(r.json.sender_domains, [{ domain: "acme.com", party: "customer" }, { domain: "ups.com", party: null }]);
      assert.equal(r.json.shipments.length, 1);
      const s = r.json.shipments[0];
      assert.equal(s.shipment_id, "15812122");
      assert.equal(s.shipment_status, "In Transit"); // newest scrape row
      assert.equal(s.tracking_number, "PRO1");
      assert.equal(s.link_id, LINK_ID);
      assert.equal(s.matched_on, "shipment_id");
      assert.deepEqual(r.json.tasks.map((t) => [t.id, t.status, t.shipment_id]), [["t2", "open", "15812122"], ["t1", "done", "15812122"]]);
      assert.deepEqual(r.json.related_threads.map((t) => [t.conversation_id, t.party]), [[OTHER_CONV, "unknown"]]);
      const q = await call(base, `/threads/context?id=${encodeURIComponent(CONV)}`);
      assert.equal(q.status, 200);
      assert.equal(q.json.shipments[0].shipment_id, "15812122");
      assert.equal((await call(base, `/threads/${encodeURIComponent("missing")}/context`)).status, 404);
    });
    const taskQs = ctx.sb.calls.filter((c) => c.table === "fpx_shipment_tasks");
    assert.ok(taskQs.length && taskQs.every((c) => c.ops.some((o) => o[0] === "is" && o[1] === "archived_at" && o[2] === null)));
  });

  it("POST /threads/<id>/links validates the shipment and records a manual link", async () => {
    const ctx = makeLinkApp({ links: [] });
    await withServer(ctx, async (base) => {
      assert.equal((await call(base, `/threads/${encodeURIComponent(CONV)}/links`, { method: "POST", body: {} })).status, 400);
      assert.equal((await call(base, `/threads/${encodeURIComponent(CONV)}/links`, { method: "POST", body: { shipment_id: "999" } })).status, 404);
      assert.equal((await call(base, `/threads/${encodeURIComponent("missing")}/links`, { method: "POST", body: { shipment_id: "15812122" } })).status, 404);
      const r = await call(base, `/threads/${encodeURIComponent(CONV)}/links`, { method: "POST", body: { shipment_id: "PRO1" } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.link.shipment_id, "15812122"); // tracking number resolved
      assert.equal(r.json.link.matched_on, "manual");
      assert.equal(r.json.link.source, "person");
      assert.equal(r.json.link.created_by, "u@x.com");
    });
    assert.equal(ctx.audits.filter((a) => a.entity_type === "mailbox_link").length, 1);
  });

  it("POST /threads/<id>/links restores a dismissed link instead of inserting", async () => {
    const ctx = makeLinkApp({ links: [{ id: LINK_ID, connection_id: CONN_ID, conversation_id: CONV, shipment_id: "15812122", dismissed: true, source: "auto" }] });
    await withServer(ctx, async (base) => {
      const r = await call(base, `/threads/links?id=${encodeURIComponent(CONV)}`, { method: "POST", body: { shipment_id: 15812122 } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.link.dismissed, false);
    });
    assert.ok(!ctx.sb.calls.some((c) => c.ops.some((o) => o[0] === "insert")));
  });

  it("POST /links/:id/dismiss flags the link and never deletes", async () => {
    const ctx = makeLinkApp();
    await withServer(ctx, async (base) => {
      assert.equal((await call(base, "/links/nope/dismiss", { method: "POST" })).status, 400);
      assert.equal((await call(base, `/links/${GUID}/dismiss`, { method: "POST" })).status, 404);
      const r = await call(base, `/links/${LINK_ID}/dismiss`, { method: "POST" });
      assert.equal(r.status, 200);
      assert.equal(r.json.link.dismissed, true);
      assert.equal(r.json.link.dismissed_by, "u@x.com");
    });
    assert.ok(!ctx.sb.calls.some((c) => c.ops.some((o) => o[0] === "delete")));
    assert.equal(ctx.audits.filter((a) => a.action === "dismiss").length, 1);
  });

  it("PUT /threads/<id>/party saves a person's choice", async () => {
    const ctx = makeLinkApp();
    await withServer(ctx, async (base) => {
      assert.equal((await call(base, `/threads/${encodeURIComponent(CONV)}/party`, { method: "PUT", body: { party: "vendor" } })).status, 400);
      const r = await call(base, `/threads/${encodeURIComponent(CONV)}/party`, { method: "PUT", body: { party: "carrier" } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.party, { party: "carrier", source: "person", reason: "Set by u@x.com", set_by: "u@x.com" });
    });
    const up = ctx.sb.calls.find((c) => c.table === "fpx_mailbox_thread_meta" && c.ops.some((o) => o[0] === "upsert"));
    const [, row, opts] = up.ops.find((o) => o[0] === "upsert");
    assert.equal(row.party_source, "person");
    assert.equal(row.conversation_id, CONV);
    assert.equal(opts.onConflict, "connection_id,conversation_id");
    assert.equal(ctx.audits.length, 1);
  });

  it("PUT /domains/:domain saves a person rule and re-classifies in the background", async () => {
    const ctx = makeLinkApp();
    await withServer(ctx, async (base) => {
      assert.equal((await call(base, "/domains/not_a_domain", { method: "PUT", body: { party: "customer" } })).status, 400);
      assert.equal((await call(base, "/domains/acme.com", { method: "PUT", body: { party: "x" } })).status, 400);
      const r = await call(base, "/domains/ACME.com", { method: "PUT", body: { party: "customer" } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.domain.domain, "acme.com");
      assert.equal(r.json.domain.source, "person");
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ctx.classify, [["acme.com", "customer"]]);
    assert.equal(ctx.audits.filter((a) => a.entity_type === "mailbox_domain").length, 1);
  });

  it("PUT /domains/:domain still answers when re-classification fails", async () => {
    const ctx = makeLinkApp(undefined, { classifyDomainChange: async () => { throw new Error("boom"); } });
    await withServer(ctx, async (base) => {
      const r = await call(base, "/domains/acme.com", { method: "PUT", body: { party: "other" } });
      assert.equal(r.status, 200);
    });
  });

  it("GET /by-shipment accepts a shipment id, row uuid or tracking number", async () => {
    const ctx = makeLinkApp();
    await withServer(ctx, async (base) => {
      for (const id of ["15812122", SHIP_ROW_ID, "PRO1"]) {
        const r = await call(base, `/by-shipment/${encodeURIComponent(id)}`);
        assert.equal(r.status, 200, id);
        assert.equal(r.json.shipment_id, "15812122");
        assert.deepEqual(r.json.threads.map((t) => t.conversation_id), [CONV]);
        assert.equal(r.json.threads[0].party, "unknown");
      }
      const none = await call(base, "/by-shipment/000");
      assert.deepEqual(none.json.threads, []);
    });
  });

  it("GET /by-task resolves the task's shipment (row id, then tracking fallback)", async () => {
    const ctx = makeLinkApp();
    await withServer(ctx, async (base) => {
      const r = await call(base, `/by-task/${TASK_ID}`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.shipment_id, "15812122");
      assert.equal(r.json.threads.length, 1);
      assert.equal((await call(base, `/by-task/${GUID}`)).status, 404);
    });
    const ctx2 = makeLinkApp({ taskShipmentRow: null });
    await withServer(ctx2, async (base) => {
      const r = await call(base, `/by-task/${TASK_ID}`);
      assert.equal(r.json.shipment_id, "15812122");
    });
  });
});
