import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  buildMailboxRouter, mailboxAccess, NO_ACCESS_ERROR, VIEW_ONLY_ERROR,
} from "../routes/mailbox.js";
import { buildUsersRouter, parseUserUpdates } from "../routes/users.js";
import { normalizeMailboxAccess } from "../lib/auth.js";

const CONV = "AAQkAGI2/TgSdz+abc==";
const CONN_ID = "11111111-1111-4111-8111-111111111111";
const MSG_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";

function fakeSupabase(handler) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, ops: [] };
      calls.push(q);
      const b = { then(res, rej) { return Promise.resolve().then(() => handler(q)).then(res, rej); } };
      for (const op of ["select", "eq", "or", "order", "range", "limit", "maybeSingle", "single", "insert", "update", "upsert", "in", "gte", "contains", "is", "neq", "not", "ilike"]) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b; };
      }
      return b;
    },
  };
}

const connRow = { id: CONN_ID, mailbox: "freightsupport@freightpop.com", status: "connected", last_sync_at: null, backfill_done: false, last_error: null };
const msgRow = { id: MSG_ID, connection_id: CONN_ID, graph_id: "AAMk", conversation_id: CONV, subject: "Help", from_address: "a@b.com", direction: "in", received_at: "2026-11-01T00:00:00Z" };

function mailboxHandler(q) {
  const has = (op) => q.ops.some((o) => o[0] === op);
  if (q.table === "fpx_mailbox_connections") return { data: has("maybeSingle") ? connRow : [connRow], error: null };
  if (q.table === "fpx_mailbox_threads") {
    if (has("maybeSingle")) return { data: { conversation_id: CONV, subject: "Help", status: "awaiting_reply" }, error: null };
    return { data: [{ conversation_id: CONV }], count: 1, error: null };
  }
  if (q.table === "fpx_mailbox_messages") {
    if (has("maybeSingle")) return { data: msgRow, error: null };
    return { data: [msgRow], count: 1, error: null };
  }
  if (q.table === "fpx_mailbox_drafts") {
    if (has("insert")) return { data: { id: "d1", ...q.ops.find((o) => o[0] === "insert")[1] }, error: null };
    return { data: [], error: null };
  }
  return { data: null, error: null };
}

function mailboxApp({ user = null, apiKey = null } = {}) {
  const graphCalls = [];
  const router = buildMailboxRouter({
    supabase: fakeSupabase(mailboxHandler),
    logAudit: async () => {},
    logGovernance: async () => {},
    encryptSecret: (s) => s,
    graphFetch: async (_c, path) => { graphCalls.push(path); return { id: "g", webLink: "https://outlook/x" }; },
    loadConnection: async () => ({ ...connRow, client_secret: "S" }),
    testConnection: async () => ({ ok: true }),
    publicConnection: (r) => r,
    requestSync: () => {},
    getBodyHtml: async () => "<p>hi</p>",
    generateMailboxReply: async () => ({ body: "Hi", model: "m" }),
    classifyDomainChange: async () => ({ updated: 0 }),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; req.apiKey = apiKey; next(); });
  app.use("/api/mailbox", router);
  return { app, graphCalls };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

async function call(base, path, { method = "GET", body } = {}) {
  const r = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const IDENTITIES = {
  none: { user: { role: "member", email: "n@x.com", mailbox_access: "none" } },
  view: { user: { role: "member", email: "v@x.com", mailbox_access: "view" } },
  draft: { user: { role: "member", email: "d@x.com", mailbox_access: "draft" } },
  legacy: { user: { role: "member", email: "l@x.com" } }, // no column → draft
  admin: { user: { role: "admin", email: "a@x.com", mailbox_access: "none" } }, // admin overrides
  adminKey: { apiKey: { name: "k", scopes: ["read", "write", "admin"] } },
  readKey: { apiKey: { name: "k", scopes: ["read", "write"] } },
};

const enc = encodeURIComponent(CONV);
const READS = [
  ["GET", "/api/mailbox/threads"],
  ["GET", `/api/mailbox/threads/${enc}`],
  ["GET", `/api/mailbox/messages/${MSG_ID}/body`],
  ["GET", "/api/mailbox/by-shipment/12345"],
];
const WRITES = [
  ["POST", `/api/mailbox/messages/${MSG_ID}/draft`, { body: "Hello" }],
  ["POST", `/api/mailbox/messages/${MSG_ID}/ai-draft`, {}],
  ["POST", `/api/mailbox/threads/${enc}/links`, { shipment_id: "12345" }],
  ["PUT", `/api/mailbox/threads/${enc}/party`, { party: "customer" }],
  ["POST", `/api/mailbox/links/${LINK_ID}/dismiss`, {}],
  ["PUT", "/api/mailbox/domains/acme.com", { party: "customer" }],
];

// Expected: true = passes the guard (any non-403 status), else the 403 message.
const MATRIX = {
  none: { read: NO_ACCESS_ERROR, write: NO_ACCESS_ERROR },
  view: { read: true, write: VIEW_ONLY_ERROR },
  draft: { read: true, write: true },
  legacy: { read: true, write: true },
  admin: { read: true, write: true },
  adminKey: { read: true, write: true },
  readKey: { read: true, write: VIEW_ONLY_ERROR },
};

describe("mailboxAccess(req)", () => {
  it("maps identities to levels", () => {
    assert.equal(mailboxAccess({ user: { role: "member", mailbox_access: "none" } }), "none");
    assert.equal(mailboxAccess({ user: { role: "member", mailbox_access: "view" } }), "view");
    assert.equal(mailboxAccess({ user: { role: "member", mailbox_access: "draft" } }), "draft");
    assert.equal(mailboxAccess({ user: { role: "member" } }), "draft");
    assert.equal(mailboxAccess({ user: { role: "member", mailbox_access: "bogus" } }), "draft");
    assert.equal(mailboxAccess({ user: { role: "admin", mailbox_access: "none" } }), "draft");
    assert.equal(mailboxAccess({ apiKey: { scopes: ["admin"] } }), "draft");
    assert.equal(mailboxAccess({ apiKey: { scopes: ["read", "write"] } }), "view");
    assert.equal(mailboxAccess({}), "none");
  });

  it("auth normalizes a missing/null column to draft", () => {
    assert.equal(normalizeMailboxAccess(undefined), "draft");
    assert.equal(normalizeMailboxAccess(null), "draft");
    assert.equal(normalizeMailboxAccess("view"), "view");
    assert.equal(normalizeMailboxAccess("none"), "none");
  });
});

describe("mailbox route guard matrix", () => {
  for (const [who, ident] of Object.entries(IDENTITIES)) {
    it(`${who}: reads ${MATRIX[who].read === true ? "allowed" : "blocked"}, writes ${MATRIX[who].write === true ? "allowed" : "blocked"}`, async () => {
      const { app } = mailboxApp(ident);
      await withServer(app, async (base) => {
        for (const [kind, routes] of [["read", READS], ["write", WRITES]]) {
          const want = MATRIX[who][kind];
          for (const [method, path, body] of routes) {
            const r = await call(base, path, { method, body });
            if (want === true) {
              assert.ok(r.status !== 403 || !/Support Mailbox/.test(r.json?.error || ""), `${who} ${method} ${path} should pass the guard, got ${r.status} ${r.json?.error}`);
            } else {
              assert.equal(r.status, 403, `${who} ${method} ${path}`);
              assert.equal(r.json.error, want, `${who} ${method} ${path}`);
            }
          }
        }
      });
    });
  }

  it("view user's blocked draft never reaches Graph", async () => {
    const { app, graphCalls } = mailboxApp(IDENTITIES.view);
    await withServer(app, async (base) => {
      const r = await call(base, `/api/mailbox/messages/${MSG_ID}/draft`, { method: "POST", body: { body: "x" } });
      assert.equal(r.status, 403);
    });
    assert.equal(graphCalls.length, 0);
  });

  it("draft user can create a draft end to end", async () => {
    const { app, graphCalls } = mailboxApp(IDENTITIES.draft);
    await withServer(app, async (base) => {
      const r = await call(base, `/api/mailbox/messages/${MSG_ID}/draft`, { method: "POST", body: { body: "Hello" } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    });
    assert.ok(graphCalls.length > 0);
  });

  it("admin-only routes keep 'Admins only' for non-admins (incl. none)", async () => {
    for (const who of ["none", "view", "draft", "readKey"]) {
      const { app } = mailboxApp(IDENTITIES[who]);
      await withServer(app, async (base) => {
        for (const [method, path] of [["GET", "/api/mailbox/connection"], ["POST", "/api/mailbox/sync"], ["POST", "/api/mailbox/connection/disconnect"]]) {
          const r = await call(base, path, { method, body: method === "GET" ? undefined : {} });
          assert.equal(r.status, 403, `${who} ${path}`);
          assert.equal(r.json.error, "Admins only");
        }
      });
    }
  });
});

describe("GET /status access", () => {
  it("returns access for each level; 'none' gets only connected + access", async () => {
    const expected = { none: "none", view: "view", draft: "draft", legacy: "draft", admin: "draft", adminKey: "draft", readKey: "view" };
    for (const [who, access] of Object.entries(expected)) {
      const { app } = mailboxApp(IDENTITIES[who]);
      await withServer(app, async (base) => {
        const r = await call(base, "/api/mailbox/status");
        assert.equal(r.status, 200, who);
        assert.equal(r.json.access, access, who);
        if (access === "none") assert.deepEqual(r.json, { connected: true, access: "none" });
        else assert.equal(r.json.mailbox, connRow.mailbox, who);
      });
    }
  });
});

describe("parseUserUpdates", () => {
  it("accepts each mailbox_access level", () => {
    for (const v of ["none", "view", "draft"]) assert.deepEqual(parseUserUpdates({ mailbox_access: v }), { updates: { mailbox_access: v } });
  });
  it("rejects invalid mailbox_access", () => {
    for (const v of ["admin", "", null, 1, "VIEW"]) assert.match(parseUserUpdates({ mailbox_access: v }).error, /mailbox_access must be/);
  });
  it("still handles the old fields and empty bodies", () => {
    assert.deepEqual(parseUserUpdates({ role: "member", enabled: false }), { updates: { role: "member", enabled: false } });
    assert.equal(parseUserUpdates({}).error, "No valid fields to update");
    assert.equal(parseUserUpdates({ role: "boss" }).error, "No valid fields to update");
  });
});

describe("PATCH /api/users/:id mailbox_access", () => {
  function usersApp({ prev = "draft", missing = false } = {}) {
    const audits = [];
    let cleared = 0;
    const sb = fakeSupabase((q) => {
      if (q.table !== "fpx_user_profiles") return { data: null, error: null };
      if (missing) return { data: null, error: null };
      const upd = q.ops.find((o) => o[0] === "update")?.[1];
      if (upd) return { data: { id: USER_ID, email: "rep@x.com", role: "member", enabled: true, mailbox_access: prev, ...upd }, error: null };
      if (q.ops.some((o) => o[0] === "order")) return { data: [{ id: USER_ID, email: "rep@x.com", mailbox_access: prev }], error: null };
      return { data: { id: USER_ID, email: "rep@x.com", mailbox_access: prev }, error: null };
    });
    const router = buildUsersRouter({
      supabase: sb,
      logAudit: (_req, e) => { audits.push(e); },
      clearAuthCache: () => { cleared++; },
      auth: (req, _res, next) => { req.user = { role: "admin", email: "a@x.com" }; next(); },
    });
    const app = express();
    app.use(express.json());
    app.use("/api/users", router);
    return { app, sb, audits, get cleared() { return cleared; } };
  }

  it("sets a valid level, clears the auth cache and audits the change", async () => {
    const ctx = usersApp({ prev: "draft" });
    await withServer(ctx.app, async (base) => {
      const r = await call(base, `/api/users/${USER_ID}`, { method: "PATCH", body: { mailbox_access: "view" } });
      assert.equal(r.status, 200);
      assert.equal(r.json.user.mailbox_access, "view");
    });
    const upd = ctx.sb.calls.find((q) => q.ops.some((o) => o[0] === "update"));
    assert.deepEqual(upd.ops.find((o) => o[0] === "update")[1], { mailbox_access: "view" });
    assert.equal(ctx.cleared, 1);
    assert.equal(ctx.audits.length, 1);
    assert.deepEqual(ctx.audits[0].before, { mailbox_access: "draft" });
    assert.deepEqual(ctx.audits[0].after, { mailbox_access: "view" });
    assert.equal(ctx.audits[0].entity_type, "user");
  });

  it("400s an invalid level without touching the DB", async () => {
    const ctx = usersApp();
    await withServer(ctx.app, async (base) => {
      const r = await call(base, `/api/users/${USER_ID}`, { method: "PATCH", body: { mailbox_access: "full" } });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, "mailbox_access must be none, view or draft");
    });
    assert.equal(ctx.sb.calls.length, 0);
    assert.equal(ctx.audits.length, 0);
  });

  it("404s an unknown user", async () => {
    const ctx = usersApp({ missing: true });
    await withServer(ctx.app, async (base) => {
      const r = await call(base, `/api/users/${USER_ID}`, { method: "PATCH", body: { mailbox_access: "none" } });
      assert.equal(r.status, 404);
    });
  });

  it("no audit when the level doesn't change", async () => {
    const ctx = usersApp({ prev: "view" });
    await withServer(ctx.app, async (base) => {
      const r = await call(base, `/api/users/${USER_ID}`, { method: "PATCH", body: { mailbox_access: "view" } });
      assert.equal(r.status, 200);
    });
    assert.equal(ctx.audits.length, 0);
  });

  it("GET /api/users selects mailbox_access", async () => {
    const ctx = usersApp({ prev: "none" });
    await withServer(ctx.app, async (base) => {
      const r = await call(base, "/api/users");
      assert.equal(r.status, 200);
      assert.equal(r.json.data[0].mailbox_access, "none");
    });
    const sel = ctx.sb.calls[0].ops.find((o) => o[0] === "select")[1];
    assert.match(sel, /mailbox_access/);
  });

  it("POST /api/users seed validates mailbox_access", async () => {
    const ctx = usersApp();
    await withServer(ctx.app, async (base) => {
      const bad = await call(base, "/api/users", { method: "POST", body: { email: "rep@x.com", mailbox_access: "nope" } });
      assert.equal(bad.status, 400);
      const ok = await call(base, "/api/users", { method: "POST", body: { email: "rep@x.com", mailbox_access: "view" } });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.user.mailbox_access, "view");
    });
    assert.equal(ctx.audits.length, 1);
  });
});
