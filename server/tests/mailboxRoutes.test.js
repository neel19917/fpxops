import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  buildMailboxRouter, decodeConversationId, parseThreadQuery, validateConnectionBody, validateDraftBody,
  draftPathFor, plainTextToHtml, isAdminReq, sortOldestFirst, errStatus,
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
      for (const op of ["select", "eq", "or", "order", "range", "limit", "maybeSingle", "single", "insert", "update", "upsert", "in"]) {
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
    assert.deepEqual(parseThreadQuery({}), { status: "all", limit: 50, offset: 0, search: "" });
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
