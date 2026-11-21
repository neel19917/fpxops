import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  buildShippersRouter, emailAccess, parseListQuery, parseShipmentsQuery, parseTasksQuery,
  parseEmailsQuery, parseTimelineQuery, parseKey, errStatus,
} from "../routes/shippers.js";

const ROW = {
  key: "Acme%20Co", customer_name: "Acme Co", shipments: 10, active: 8, in_transit: 3, delivered_30d: 2, exceptions: 1,
  last_scraped_at: null, last_pickup_date: null, open_tasks: 2, overdue_tasks: 1, email_threads: 4, awaiting_reply: 1, last_email_at: null,
};

function stubDeps(overrides = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === "function" ? result(...args) : result; };
  const deps = {
    listShippers: rec("listShippers", (o) => ({ shippers: [o.includeEmail ? ROW : { ...ROW, email_threads: null, awaiting_reply: null }], totals: { shippers: 1 } })),
    getShipper: rec("getShipper", (key) => {
      if (key !== "Acme Co" && key !== "__none__") throw Object.assign(new Error("Shipper not found"), { status: 404 });
      return { shipper: ROW, carriers: [], modes: [], statuses: [] };
    }),
    getShipperShipments: rec("getShipperShipments", { shipments: [], total: 0 }),
    getShipperTasks: rec("getShipperTasks", { tasks: [], counts: { open: 0, in_progress: 0, blocked: 0, overdue: 0, done_30d: 0 } }),
    getShipperEmails: rec("getShipperEmails", { threads: [], counts: { all: 0, awaiting_reply: 0, responded: 0 } }),
    getShipperTimeline: rec("getShipperTimeline", { events: [] }),
    ...overrides,
  };
  return { deps, calls };
}

function makeApp({ user = { role: "user", email: "u@x.com" }, apiKey = null, overrides = {} } = {}) {
  const { deps, calls } = stubDeps(overrides);
  const app = express();
  app.use((req, _res, next) => { req.user = user; req.apiKey = apiKey; next(); });
  app.use("/api/shippers", buildShippersRouter(deps));
  return { app, calls };
}

async function withServer(ctx, fn) {
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/shippers`;
  try { return await fn(base); } finally { server.close(); }
}

async function get(base, path) {
  const r = await fetch(base + path);
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ---------- pure helpers ----------
describe("shippers route helpers", () => {
  it("emailAccess: admin draft, user profile value, missing → draft, API key view", () => {
    assert.equal(emailAccess({ user: { role: "admin", mailbox_access: "none" } }), "draft");
    assert.equal(emailAccess({ user: { role: "user", mailbox_access: "none" } }), "none");
    assert.equal(emailAccess({ user: { role: "user", mailbox_access: "view" } }), "view");
    assert.equal(emailAccess({ user: { role: "user" } }), "draft");
    assert.equal(emailAccess({ apiKey: { scopes: ["read"] } }), "view");
    assert.equal(emailAccess({ apiKey: { scopes: ["admin"] } }), "draft");
  });

  it("parseListQuery: defaults and validation", () => {
    assert.deepEqual(parseListQuery({}), { q: "", sort: "shipments" });
    assert.deepEqual(parseListQuery({ q: "  acme ", sort: "NAME" }), { q: "acme", sort: "name" });
    assert.ok(parseListQuery({ sort: "bogus" }).error);
    assert.ok(parseListQuery({ q: "x".repeat(201) }).error);
  });

  it("parseShipmentsQuery: defaults, enums, limit/offset bounds", () => {
    assert.deepEqual(parseShipmentsQuery({}), { status: "active", q: "", limit: 50, offset: 0 });
    assert.deepEqual(parseShipmentsQuery({ status: "in_transit", q: "PRO1", limit: "8", offset: "16" }), { status: "in_transit", q: "PRO1", limit: 8, offset: 16 });
    assert.ok(parseShipmentsQuery({ status: "lost" }).error);
    assert.ok(parseShipmentsQuery({ limit: "201" }).error);
    assert.ok(parseShipmentsQuery({ limit: "0" }).error);
    assert.ok(parseShipmentsQuery({ limit: "abc" }).error);
    assert.ok(parseShipmentsQuery({ offset: "-1" }).error);
  });

  it("parseTasksQuery / parseTimelineQuery", () => {
    assert.deepEqual(parseTasksQuery({}), { status: "open", limit: 100 });
    assert.deepEqual(parseTasksQuery({ status: "done", limit: "5" }), { status: "done", limit: 5 });
    assert.ok(parseTasksQuery({ status: "blocked" }).error);
    assert.deepEqual(parseTimelineQuery({}), { limit: 100 });
    assert.ok(parseTimelineQuery({ limit: "1.5" }).error);
  });

  it("parseEmailsQuery: days number or 'all'", () => {
    assert.deepEqual(parseEmailsQuery({}), { status: "all", days: 90, limit: 100 });
    assert.deepEqual(parseEmailsQuery({ status: "awaiting_reply", days: "7", limit: "8" }), { status: "awaiting_reply", days: 7, limit: 8 });
    assert.equal(parseEmailsQuery({ days: "all" }).days, "all");
    assert.ok(parseEmailsQuery({ days: "14" }).error);
    assert.ok(parseEmailsQuery({ status: "outbound_only" }).error);
  });

  it("parseKey / errStatus", () => {
    assert.equal(parseKey("Acme Co").value, "Acme Co");
    assert.ok(parseKey("").error);
    assert.ok(parseKey("x".repeat(501)).error);
    assert.equal(errStatus({ status: 404 }), 404);
    assert.equal(errStatus(new Error("x")), 500);
    assert.equal(errStatus({ status: 200 }), 500);
  });
});

// ---------- HTTP ----------
describe("shippers routes", () => {
  it("GET / → listShippers with includeEmail per access", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await get(base, "/?q=acme&sort=open_tasks");
      assert.equal(r.status, 200);
      assert.equal(r.json.shippers[0].customer_name, "Acme Co");
      assert.deepEqual(ctx.calls[0], ["listShippers", { q: "acme", sort: "open_tasks", includeEmail: true }]);
    });
    const none = makeApp({ user: { role: "user", mailbox_access: "none" } });
    await withServer(none, async (base) => {
      const r = await get(base, "/");
      assert.equal(r.status, 200);
      assert.equal(r.json.shippers[0].email_threads, null);
      assert.equal(none.calls[0][1].includeEmail, false);
    });
  });

  it("GET / → 400 on a bad sort, lib not called", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await get(base, "/?sort=nope");
      assert.equal(r.status, 400);
      assert.match(r.json.error, /sort/);
      assert.equal(ctx.calls.length, 0);
    });
  });

  it("GET /:key decodes the key and adds email_access", async () => {
    const ctx = makeApp({ user: { role: "user", mailbox_access: "view" } });
    await withServer(ctx, async (base) => {
      const r = await get(base, `/${encodeURIComponent("Acme Co")}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.email_access, "view");
      assert.equal(r.json.shipper.customer_name, "Acme Co");
      assert.deepEqual(ctx.calls[0], ["getShipper", "Acme Co", { includeEmail: true }]);
    });
  });

  it("GET /:key handles keys with slashes and the __none__ key", async () => {
    const ctx = makeApp({ user: { role: "admin" } });
    await withServer(ctx, async (base) => {
      const r = await get(base, "/__none__");
      assert.equal(r.status, 200);
      assert.equal(r.json.email_access, "draft");
      const s = await get(base, `/${encodeURIComponent("A/B Co")}/tasks`);
      assert.equal(s.status, 200);
      assert.equal(ctx.calls.at(-1)[1], "A/B Co");
    });
  });

  it("GET /:key → 404 passthrough with the lib's message", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await get(base, "/Nobody");
      assert.equal(r.status, 404);
      assert.equal(r.json.error, "Shipper not found");
    });
  });

  it("errors without a status → 500 { error }", async () => {
    const ctx = makeApp({ overrides: { getShipperTasks: async () => { throw new Error("db down"); } } });
    const orig = console.error; console.error = () => {};
    try {
      await withServer(ctx, async (base) => {
        const r = await get(base, "/Acme%20Co/tasks");
        assert.equal(r.status, 500);
        assert.equal(r.json.error, "db down");
      });
    } finally { console.error = orig; }
  });

  it("GET /:key/shipments passes parsed params; 400 on bad status/limit", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await get(base, "/Acme%20Co/shipments?status=exceptions&q=PRO&limit=8&offset=8");
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { shipments: [], total: 0 });
      assert.deepEqual(ctx.calls[0], ["getShipperShipments", "Acme Co", { status: "exceptions", q: "PRO", limit: 8, offset: 8, includeEmail: true }]);
      assert.equal((await get(base, "/Acme%20Co/shipments?status=gone")).status, 400);
      assert.equal((await get(base, "/Acme%20Co/shipments?limit=500")).status, 400);
      assert.equal(ctx.calls.length, 1);
    });
  });

  it("GET /:key/tasks passes parsed params; 400 on bad status", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await get(base, "/Acme%20Co/tasks?status=all&limit=20");
      assert.equal(r.status, 200);
      assert.deepEqual(ctx.calls[0], ["getShipperTasks", "Acme Co", { status: "all", limit: 20 }]);
      assert.equal((await get(base, "/Acme%20Co/tasks?status=x")).status, 400);
    });
  });

  it("GET /:key/emails → 403 mailbox_no_access for access none (lib not called)", async () => {
    const ctx = makeApp({ user: { role: "user", mailbox_access: "none" } });
    await withServer(ctx, async (base) => {
      const r = await get(base, "/Acme%20Co/emails");
      assert.equal(r.status, 403);
      assert.equal(r.json.code, "mailbox_no_access");
      assert.ok(r.json.error);
      assert.equal(ctx.calls.length, 0);
    });
  });

  it("GET /:key/emails passes parsed params for view users and API keys; 400 on bad days", async () => {
    const ctx = makeApp({ user: { role: "user", mailbox_access: "view" } });
    await withServer(ctx, async (base) => {
      const r = await get(base, "/Acme%20Co/emails?status=awaiting_reply&days=30&limit=8");
      assert.equal(r.status, 200);
      assert.deepEqual(ctx.calls[0], ["getShipperEmails", "Acme Co", { status: "awaiting_reply", days: 30, limit: 8 }]);
      assert.equal((await get(base, "/Acme%20Co/emails?days=5")).status, 400);
    });
    const key = makeApp({ user: null, apiKey: { name: "k", scopes: ["read"] } });
    await withServer(key, async (base) => {
      const r = await get(base, "/Acme%20Co/emails?days=all");
      assert.equal(r.status, 200);
      assert.equal(key.calls[0][2].days, "all");
    });
  });

  it("GET /:key/timeline passes includeEmail per access", async () => {
    const ctx = makeApp();
    await withServer(ctx, async (base) => {
      const r = await get(base, "/Acme%20Co/timeline?limit=10");
      assert.equal(r.status, 200);
      assert.deepEqual(ctx.calls[0], ["getShipperTimeline", "Acme Co", { limit: 10, includeEmail: true }]);
    });
    const none = makeApp({ user: { role: "user", mailbox_access: "none" } });
    await withServer(none, async (base) => {
      await get(base, "/Acme%20Co/timeline");
      assert.deepEqual(none.calls[0], ["getShipperTimeline", "Acme Co", { limit: 100, includeEmail: false }]);
      assert.equal((await get(base, "/Acme%20Co/timeline?limit=0")).status, 400);
    });
  });

  it("no write routes exist", async () => {
    const ctx = makeApp({ user: { role: "admin" } });
    await withServer(ctx, async (base) => {
      const r = await fetch(base + "/Acme%20Co", { method: "POST" });
      assert.equal(r.status, 404);
      assert.equal(ctx.calls.length, 0);
    });
  });
});
