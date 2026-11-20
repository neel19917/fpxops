import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  buildLinkNote, buildUnlinkNote, logLinksToShipments, logUnlink, formatUtc, threadUrl, dashboardBase, isLoggable, NOTE_AUTHOR,
} from "../lib/mailbox/shipmentLog.js";
import { notInFpx, notInFpxCandidates, BARE_KIND, _deps as linkDeps, linkerTick, _resetLinkerState } from "../lib/mailbox/linking.js";
import { buildMailboxRouter } from "../routes/mailbox.js";

const CONN = "11111111-1111-4111-8111-111111111111";
const CONV = "AAQkAGI2/TgSdz+abc==";
const NOW = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();

// ---------- an in-memory, chainable Supabase fake ----------
function memoryDb(tables) {
  const calls = [];
  let seq = 0;
  const matches = (row, filters) => filters.every(([op, col, val]) => {
    const v = row[col];
    if (op === "eq") return String(v) === String(val);
    if (op === "neq") return String(v) !== String(val);
    if (op === "is") return val === null ? v == null : v === val;
    if (op === "in") return val.map(String).includes(String(v));
    if (op === "gte") return String(v) >= String(val);
    if (op === "lte") return String(v) <= String(val);
    return true;
  });
  return {
    calls, tables,
    from(table) {
      const q = { table, ops: [], filters: [] };
      calls.push(q);
      const rows = () => (tables[table] ||= []);
      const run = () => {
        const has = (o) => q.ops.find((x) => x[0] === o);
        const single = has("single") || has("maybeSingle");
        if (has("insert")) {
          const ins = has("insert")[1];
          const defaults = table === "fpx_mailbox_links" ? { dismissed: false, logged_at: null, note_id: null } : {};
          const list = (Array.isArray(ins) ? ins : [ins]).map((r) => ({ id: `${table}-${++seq}`, created_at: NOW.toISOString(), ...defaults, ...r }));
          rows().push(...list);
          return { data: single ? list[0] : list, error: null };
        }
        if (has("update")) {
          const hit = rows().filter((r) => matches(r, q.filters));
          for (const r of hit) Object.assign(r, has("update")[1]);
          return { data: single ? hit[0] || null : hit.map((r) => ({ ...r })), error: null };
        }
        let out = rows().filter((r) => matches(r, q.filters));
        if (has("or")) {
          const expr = has("or")[1];
          out = out.filter((r) => expr.split(/,(?=[a-z_]+\.in\.)/).some((part) => {
            const m = /^([a-z_]+)\.in\.\((.*)\)$/.exec(part);
            const vals = m[2].split(",").map((x) => x.replace(/"/g, ""));
            return r[m[1]] != null && vals.includes(String(r[m[1]]));
          }));
        }
        const ord = has("order");
        if (ord) out = [...out].sort((a, b) => (ord[2]?.ascending === false ? -1 : 1) * String(a[ord[1]] ?? "").localeCompare(String(b[ord[1]] ?? "")));
        const rg = has("range");
        if (rg) out = out.slice(rg[1], rg[2] + 1);
        if (single) return { data: out[0] ? { ...out[0] } : null, error: null };
        return { data: out.map((r) => ({ ...r })), error: null };
      };
      const b = { then(res, rej) { return Promise.resolve().then(run).then(res, rej); } };
      for (const op of ["select", "order", "range", "limit", "maybeSingle", "single", "insert", "update", "upsert", "or", "not", "contains"]) {
        b[op] = (...args) => { q.ops.push([op, ...args]); return b; };
      }
      for (const op of ["eq", "neq", "is", "in", "gte", "lte"]) {
        b[op] = (col, val) => { q.ops.push([op, col, val]); q.filters.push([op, col, val]); return b; };
      }
      return b;
    },
  };
}

function seed() {
  return {
    fpx_mailbox_links: [
      // recent auto link on a recent thread -> logged
      { id: "L1", connection_id: CONN, conversation_id: CONV, shipment_id: "15812122", matched_on: "tracking_number", matched_text: "349993297", source: "auto", created_by: null, dismissed: false, logged_at: null, note_id: null, created_at: iso(DAY) },
      // shipment not in FPX -> skipped, stays unlogged
      { id: "L2", connection_id: CONN, conversation_id: CONV, shipment_id: "99999", matched_on: "shipment_id", matched_text: "99999", source: "auto", dismissed: false, logged_at: null, note_id: null, created_at: iso(DAY) },
      // created long ago -> never backfilled
      { id: "L3", connection_id: CONN, conversation_id: CONV, shipment_id: "15812122", matched_on: "shipment_id", matched_text: "x", source: "auto", dismissed: false, logged_at: null, note_id: null, created_at: iso(60 * DAY) },
      // dismissed -> not logged
      { id: "L4", connection_id: CONN, conversation_id: CONV, shipment_id: "15812122", matched_on: "shipment_id", source: "auto", dismissed: true, logged_at: null, note_id: null, created_at: iso(DAY) },
      // recent link, but the thread is old (older-pass link) -> not logged
      { id: "L5", connection_id: CONN, conversation_id: "OLD", shipment_id: "15812122", matched_on: "shipment_id", matched_text: "15812122", source: "auto", dismissed: false, logged_at: null, note_id: null, created_at: iso(DAY) },
      // a person's link on that old thread -> logged
      { id: "L6", connection_id: CONN, conversation_id: "OLD", shipment_id: "777", matched_on: "manual", matched_text: "PRO7", source: "person", created_by: "amy@freightpop.com", dismissed: false, logged_at: null, note_id: null, created_at: iso(DAY) },
    ],
    fpx_mailbox_thread_summary: [
      { connection_id: CONN, conversation_id: CONV, subject: "RE: ABF 349993297", last_message_at: "2026-11-19T15:04:09Z", message_count: 3, last_from_name: "Jo Smith", last_from_address: "jo@acme.com", party: "customer" },
      { connection_id: CONN, conversation_id: "OLD", subject: "Old thread", last_message_at: iso(200 * DAY), message_count: 1, last_from_name: null, last_from_address: "ops@xpo.com", party: "carrier" },
    ],
    fpx_shipments: [
      { id: "row-old", shipment_id: "15812122", tracking_number: "349993297", scraped_at: "2026-11-01" },
      { id: "row-new", shipment_id: "15812122", tracking_number: "349993297", scraped_at: "2026-11-19" },
      { id: "row-777", shipment_id: "777", tracking_number: "PRO7", scraped_at: "2026-11-10" },
    ],
    fpx_shipment_notes: [],
  };
}

const savedLink = { ...linkDeps };
const savedEnv = { DASHBOARD_URL: process.env.DASHBOARD_URL, FPX_PUBLIC_URL: process.env.FPX_PUBLIC_URL };
afterEach(() => {
  Object.assign(linkDeps, savedLink);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("shipment note text", () => {
  it("auto link: subject, sender, party, counts, match and a link back", () => {
    const body = buildLinkNote(
      { conversation_id: CONV, matched_on: "tracking_number", matched_text: "349993297", source: "auto" },
      { subject: "RE: ABF 349993297", last_from_name: "Jo Smith", last_from_address: "jo@acme.com", party: "customer", message_count: 3, last_message_at: "2026-11-19T15:04:09Z" },
      { base: "https://fpx.example.com" },
    );
    assert.equal(body, [
      "Support email linked: RE: ABF 349993297",
      "From: Jo Smith <jo@acme.com> · customer · 3 messages, last 2026-11-19 15:04 UTC",
      "Matched on tracking number: 349993297",
      `Open: https://fpx.example.com/mailbox?c=${encodeURIComponent(CONV)}`,
    ].join("\n"));
  });
  it("manual link says who linked it; unknown party and one message", () => {
    const body = buildLinkNote(
      { conversation_id: "c", matched_on: "manual", matched_text: "PRO7", source: "person", created_by: "amy@freightpop.com" },
      { subject: null, last_from_address: "ops@xpo.com", party: "unknown", message_count: 1, last_message_at: null },
      { base: "" },
    );
    assert.equal(body, "Support email linked: (no subject)\nFrom: ops@xpo.com · 1 message\nLinked by amy@freightpop.com\nOpen: /mailbox?c=c");
  });
  it("is capped at 5000 characters and keeps the link", () => {
    const body = buildLinkNote({ conversation_id: CONV, matched_on: "reference", matched_text: "x".repeat(9000) }, { subject: "s".repeat(9000), last_from_name: "n".repeat(9000) }, { base: "" });
    assert.ok(body.length <= 5000);
    assert.ok(body.endsWith(`/mailbox?c=${encodeURIComponent(CONV)}`));
  });
  it("dashboard base comes from DASHBOARD_URL (else FPX_PUBLIC_URL, else the live dashboard)", () => {
    assert.equal(dashboardBase({ DASHBOARD_URL: "https://a.example/", FPX_PUBLIC_URL: "https://b.example" }), "https://a.example");
    assert.equal(dashboardBase({ FPX_PUBLIC_URL: "https://b.example" }), "https://b.example");
    assert.equal(dashboardBase({}), "https://fpxpress.netlify.app");
    assert.equal(threadUrl("a/b+c=", ""), "/mailbox?c=a%2Fb%2Bc%3D");
    assert.equal(formatUtc("bad"), null);
    assert.equal(buildUnlinkNote({ subject: "Hi" }, "amy@x.com"), "Support email unlinked: Hi (by amy@x.com)");
  });
  it("isLoggable: 30-day window; person links on old threads count", () => {
    const now = NOW.getTime();
    assert.equal(isLoggable({ created_at: iso(DAY), source: "auto" }, { last_message_at: iso(DAY) }, now), true);
    assert.equal(isLoggable({ created_at: iso(DAY), source: "auto" }, { last_message_at: iso(40 * DAY) }, now), false);
    assert.equal(isLoggable({ created_at: iso(DAY), source: "person" }, { last_message_at: iso(400 * DAY) }, now), true);
    assert.equal(isLoggable({ created_at: iso(31 * DAY), source: "person" }, { last_message_at: iso(DAY) }, now), false);
    assert.equal(isLoggable({ created_at: iso(DAY) }, null, now), false);
  });
});

describe("logLinksToShipments", () => {
  it("logs eligible links once, on the newest shipment row, and skips missing shipments", async () => {
    process.env.DASHBOARD_URL = "https://fpx.example.com";
    const db = memoryDb(seed());
    const r = await logLinksToShipments({ db, now: NOW });
    assert.equal(r.error, undefined);
    assert.equal(r.logged, 2);
    const notes = db.tables.fpx_shipment_notes;
    assert.deepEqual(notes.map((n) => [n.shipment_id, n.tracking_number, n.created_by]).sort(),
      [["row-777", "PRO7", NOTE_AUTHOR], ["row-new", "349993297", NOTE_AUTHOR]]);
    const byId = Object.fromEntries(db.tables.fpx_mailbox_links.map((l) => [l.id, l]));
    assert.ok(byId.L1.logged_at && byId.L1.note_id);
    assert.equal(notes.find((n) => n.id === byId.L1.note_id).shipment_id, "row-new");
    assert.match(notes.find((n) => n.id === byId.L1.note_id).body, /^Support email linked: RE: ABF 349993297\n/);
    assert.match(notes.find((n) => n.id === byId.L1.note_id).body, /Open: https:\/\/fpx\.example\.com\/mailbox\?c=/);
    assert.ok(byId.L6.logged_at && byId.L6.note_id);
    assert.match(notes.find((n) => n.id === byId.L6.note_id).body, /Linked by amy@freightpop\.com/);
    for (const id of ["L2", "L3", "L4", "L5"]) assert.equal(byId[id].logged_at, null, id);
    // fpx_shipments.notes (people's latest note) is never written.
    assert.ok(!db.calls.some((c) => c.table === "fpx_shipments" && c.ops.some((o) => o[0] === "update")));
    // nothing is ever deleted
    assert.ok(!db.calls.some((c) => c.ops.some((o) => o[0] === "delete")));
  });

  it("is idempotent: a second run logs nothing", async () => {
    const db = memoryDb(seed());
    assert.equal((await logLinksToShipments({ db, now: NOW })).logged, 2);
    const again = await logLinksToShipments({ db, now: NOW });
    assert.equal(again.logged, 0);
    assert.equal(db.tables.fpx_shipment_notes.length, 2);
  });

  it("a link another process already claimed is not logged twice", async () => {
    const db = memoryDb(seed());
    const realFrom = db.from.bind(db);
    // Another process claims L1 between our read and our claim.
    db.from = (table) => {
      const b = realFrom(table);
      if (table !== "fpx_mailbox_links") return b;
      const origUpdate = b.update;
      b.update = (vals) => {
        const l1 = db.tables.fpx_mailbox_links.find((l) => l.id === "L1");
        if (vals.logged_at && !l1.logged_at) l1.logged_at = "2026-11-20T11:59:00Z";
        return origUpdate(vals);
      };
      return b;
    };
    const r = await logLinksToShipments({ db, now: NOW });
    assert.equal(r.logged, 1); // only L6
    assert.equal(db.tables.fpx_shipment_notes.length, 1);
    assert.equal(db.tables.fpx_mailbox_links.find((l) => l.id === "L1").note_id, null);
  });

  it("can be scoped to one thread and never throws", async () => {
    const db = memoryDb(seed());
    const r = await logLinksToShipments({ db, now: NOW, connectionId: CONN, conversationId: "OLD" });
    assert.equal(r.logged, 1);
    assert.equal(db.tables.fpx_shipment_notes[0].shipment_id, "row-777");
    const broken = { from() { throw new Error("db down"); } };
    const e = await logLinksToShipments({ db: broken, now: NOW });
    assert.equal(e.logged, 0);
    assert.match(e.error, /db down/);
  });

  it("gives the claim back when the note cannot be saved", async () => {
    const db = memoryDb(seed());
    const realFrom = db.from.bind(db);
    db.from = (table) => {
      if (table === "fpx_shipment_notes") {
        const b = { then(res) { return Promise.resolve({ data: null, error: { message: "notes down" } }).then(res); } };
        for (const op of ["insert", "select", "single"]) b[op] = () => b;
        return b;
      }
      return realFrom(table);
    };
    const r = await logLinksToShipments({ db, now: NOW });
    assert.equal(r.logged, 0);
    assert.match(r.error, /notes down/);
    assert.equal(db.tables.fpx_mailbox_links.find((l) => l.id === "L1").logged_at, null);
  });

  it("logUnlink adds a second note only for a logged link", async () => {
    const db = memoryDb(seed());
    assert.equal((await logUnlink({ db, link: { ...seed().fpx_mailbox_links[0] }, who: "amy" })).logged, 0);
    const link = { ...seed().fpx_mailbox_links[0], logged_at: NOW.toISOString(), note_id: "n1" };
    assert.equal((await logUnlink({ db, link, who: "amy" })).logged, 1);
    assert.equal(db.tables.fpx_shipment_notes[0].body, "Support email unlinked: RE: ABF 349993297 (by amy)");
    assert.equal(db.tables.fpx_shipment_notes[0].shipment_id, "row-new");
  });

  it("runs at the end of each linker tick", async () => {
    _resetLinkerState();
    const db = memoryDb({ fpx_mailbox_threads: [], fpx_mailbox_thread_meta: [] });
    linkDeps.supabase = db;
    const seen = [];
    linkDeps.logLinksToShipments = async (o) => { seen.push(o); return { logged: 3 }; };
    const out = await linkerTick({ limit: 50 });
    assert.equal(seen.length, 1);
    assert.deepEqual(out.log, { logged: 3 });
    _resetLinkerState();
  });
});

describe("not in FPX", () => {
  it("keeps keyword-qualified numbers only (never the bare-number kind)", () => {
    assert.equal(BARE_KIND, "number");
    const c = notInFpxCandidates("RE: ABF 349993297 PRO# 55512345 PO 023489077", []);
    assert.deepEqual(c.map((x) => `${x.kind}:${x.value}`), ["tracking:55512345", "po:023489077"]);
  });

  it("drops values in FPX (any column) and a linked shipment's ids; dedups and caps at 10", async () => {
    const db = memoryDb({
      fpx_shipments: [
        { id: "r1", shipment_id: "15812122", tracking_number: "349993297" },
        { id: "r2", shipment_id: "222", reference_three: "REF77777" },
        // a value many shipments share is still "in FPX"
        ...Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, shipment_id: `M${i}`, order_number: "4455667" })),
      ],
    });
    const messages = [
      { id: "m1", direction: "in", subject: "Shipment 15812122 PRO 55512345", body_preview: "Ref REF77777, PO 4455667, BOL 99887766 and PRO 55512345 again", received_at: "2026-11-01" },
      { id: "m2", direction: "out", subject: "Shipment 15812122 PRO 55512345", body_preview: "Tracking 1Z999AA10123456784; load 1234567", sent_at: "2026-11-02" },
    ];
    const bodies = new Map([["m1", "<p>Pickup# PU556677</p>"]]);
    const out = await notInFpx({ messages, bodies, linked: [{ shipment_id: "15812122", tracking_number: "349993297" }], db });
    assert.deepEqual(out, [
      { value: "55512345", kind: "tracking" },
      { value: "99887766", kind: "bol" },
      { value: "1Z999AA10123456784", kind: "tracking" },
      { value: "1234567", kind: "load" },
      { value: "PU556677", kind: "pickup" },
    ]);
    const many = Array.from({ length: 15 }, (_, i) => `PRO ${70000000 + i}`).join(" ");
    assert.equal((await notInFpx({ messages: [{ id: "x", direction: "in", subject: many }], db })).length, 10);
    assert.deepEqual(await notInFpx({ messages: [], db }), []);
  });
});

describe("routes", () => {
  const conn = { id: CONN, mailbox: "freightsupport@freightpop.com", status: "connected", created_at: "2026-11-01" };
  function appWith(db, deps = {}) {
    const router = buildMailboxRouter({ supabase: db, logAudit: async () => {}, logGovernance: async () => {}, ...deps });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { role: "user", email: "amy@freightpop.com" }; next(); });
    app.use("/api/mailbox", router);
    return app;
  }
  async function call(app, path, opts = {}) {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const r = await fetch(`http://127.0.0.1:${port}/api/mailbox${path}`, {
        method: opts.method || "GET", headers: { "content-type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      return { status: r.status, json: await r.json() };
    } finally { server.close(); }
  }
  function routeDb() {
    const t = seed();
    return memoryDb({
      ...t,
      fpx_mailbox_connections: [conn],
      fpx_mailbox_threads: [{ connection_id: CONN, conversation_id: CONV, subject: "RE: ABF 349993297" }],
      fpx_mailbox_thread_meta: [],
      fpx_mailbox_domains: [],
      fpx_shipment_tasks: [],
      fpx_mailbox_messages: [
        { id: "m1", connection_id: CONN, conversation_id: CONV, direction: "in", subject: "RE: ABF 349993297", body_preview: "PRO 349993297 and PO 023489077", from_address: "jo@acme.com", received_at: "2026-11-19T15:04:09Z", removed_in_outlook: false, body_html: "<p>BOL 99887766</p>" },
      ],
    });
  }

  it("GET context: shipments carry logged_at, note_id, fpx_id; not_in_fpx lists the rest", async () => {
    const db = routeDb();
    await logLinksToShipments({ db, now: NOW });
    const r = await call(appWith(db), `/threads/${encodeURIComponent(CONV)}/context`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const s1 = r.json.shipments.find((s) => s.link_id === "L1");
    assert.ok(s1.logged_at);
    assert.ok(s1.note_id);
    assert.equal(s1.fpx_id, "row-new");
    const s2 = r.json.shipments.find((s) => s.link_id === "L2");
    assert.deepEqual([s2.logged_at, s2.note_id, s2.fpx_id], [null, null, null]);
    assert.deepEqual(r.json.not_in_fpx, [{ value: "023489077", kind: "po" }, { value: "99887766", kind: "bol" }]);
  });

  it("GET context still answers when the not-in-FPX lookup fails", async () => {
    const r = await call(appWith(routeDb(), { notInFpx: async () => { throw new Error("boom"); } }), `/threads/${encodeURIComponent(CONV)}/context`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.not_in_fpx, []);
  });

  it("POST links logs the new link on the shipment right away", async () => {
    const db = routeDb();
    db.tables.fpx_mailbox_links = [];
    const r = await call(appWith(db), `/threads/${encodeURIComponent(CONV)}/links`, { method: "POST", body: { shipment_id: "777" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.logged, 1);
    assert.equal(db.tables.fpx_shipment_notes.length, 1);
    assert.equal(db.tables.fpx_shipment_notes[0].shipment_id, "row-777");
    assert.match(db.tables.fpx_shipment_notes[0].body, /Linked by amy@freightpop\.com/);
  });

  it("dismissing a logged link keeps its note and adds an unlink note", async () => {
    const db = routeDb();
    await logLinksToShipments({ db, now: NOW });
    const id = "44444444-4444-4444-8444-444444444444";
    db.tables.fpx_mailbox_links.find((l) => l.id === "L1").id = id;
    const r = await call(appWith(db), `/links/${id}/dismiss`, { method: "POST" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const bodies = db.tables.fpx_shipment_notes.map((n) => n.body);
    assert.equal(bodies.length, 3);
    assert.ok(bodies.some((b) => b === "Support email unlinked: RE: ABF 349993297 (by amy@freightpop.com)"));
  });
});
