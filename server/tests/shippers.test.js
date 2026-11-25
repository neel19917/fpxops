import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  _deps, NONE_KEY, NONE_LABEL, shipperKey, shipperName, listShippers, getShipper, getShipperShipments,
  getShipperTasks, getShipperEmails, getShipperTimeline, cityState, actionRequiredBool, compareTasks,
} from "../lib/shippers.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();

// ---------- a tiny chainable, thenable Supabase fake ----------
// handlers[table](q) → { data, error, count }; q = { table, select, opts, ops: [[name, ...args]] }
function fakeDb({ tables = {}, rpc = {} } = {}) {
  const calls = [];
  const builder = (table) => {
    const q = { table, ops: [] };
    calls.push(q);
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (res, rej) => {
            try {
              const h = tables[table];
              const out = h ? h(q) : { data: [], error: null };
              return Promise.resolve({ error: null, ...out }).then(res, rej);
            } catch (e) { return Promise.reject(e).then(res, rej); }
          };
        }
        return (...args) => {
          if (prop === "select") { q.select = args[0]; q.opts = args[1] || {}; }
          q.ops.push([prop, ...args]);
          return b;
        };
      },
    });
    return b;
  };
  return {
    calls,
    from: (t) => builder(t),
    rpc: async (fn, args) => {
      calls.push({ rpc: fn, args });
      const h = rpc[fn];
      return h ? { error: null, ...h(args) } : { data: [], error: null };
    },
  };
}
const op = (q, name) => q.ops.filter((o) => o[0] === name);

const LIST = [
  { customer_name: "Acme Co", shipments: 100, active: 80, in_transit: 40, delivered_30d: 5, exceptions: 3, last_scraped_at: iso(DAY), last_pickup_date: iso(2 * DAY), open_tasks: 4, overdue_tasks: 1, email_threads: 10, awaiting_reply: 2, last_email_at: iso(3600_000) },
  { customer_name: "beta & Sons/LLC", shipments: 300, active: 10, in_transit: 2, delivered_30d: 0, exceptions: 9, last_scraped_at: null, last_pickup_date: null, open_tasks: 0, overdue_tasks: 0, email_threads: 1, awaiting_reply: 5, last_email_at: iso(10 * DAY) },
  { customer_name: null, shipments: 7, active: 7, in_transit: 0, delivered_30d: 0, exceptions: 0, last_scraped_at: null, last_pickup_date: null, open_tasks: 9, overdue_tasks: 0, email_threads: 0, awaiting_reply: 0, last_email_at: null },
  { customer_name: "Zeta", shipments: 0, active: 0, in_transit: 0, delivered_30d: 0, exceptions: 0, last_scraped_at: null, last_pickup_date: null, open_tasks: 0, overdue_tasks: 0, email_threads: 0, awaiting_reply: 0, last_email_at: null },
];

let saved;
beforeEach(() => { saved = { ..._deps }; _deps.now = () => NOW; });
afterEach(() => { Object.assign(_deps, saved); });

describe("shipper keys", () => {
  it("round-trips names, including odd characters", () => {
    for (const n of ["Acme Co", "beta & Sons/LLC", "100% Fresh", "Ünïcode #1?"]) {
      assert.equal(shipperName(shipperKey(n)), n);
    }
    assert.equal(shipperKey("beta & Sons/LLC"), "beta%20%26%20Sons%2FLLC");
  });
  it("maps blank / null / label to the none key", () => {
    assert.equal(shipperKey(null), NONE_KEY);
    assert.equal(shipperKey(""), NONE_KEY);
    assert.equal(shipperKey("  "), NONE_KEY);
    assert.equal(shipperKey(NONE_LABEL), NONE_KEY);
    assert.equal(shipperName(NONE_KEY), NONE_LABEL);
    assert.equal(shipperName(""), NONE_LABEL);
  });
  it("accepts an already-decoded key (Express params)", () => {
    assert.equal(shipperName("beta & Sons/LLC"), "beta & Sons/LLC");
    assert.equal(shipperName("100%"), "100%"); // invalid encoding → raw
  });
});

describe("helpers", () => {
  it("cityState pulls City, ST from free-text addresses", () => {
    assert.equal(cityState("ASSOCIATED PACKAGING, INC., 435 Calvert Dr, Gallatin, TN, 37066, US,"), "Gallatin, TN");
    assert.equal(cityState("A L PATTERSON INC , , FAIRLESS HILLS , PA , 19030"), "FAIRLESS HILLS, PA");
    assert.equal(cityState("Dallas, tx"), "Dallas, TX");
    assert.equal(cityState(null), null);
    assert.equal(cityState("Somewhere"), "Somewhere");
  });
  it("actionRequiredBool reads YES/NO", () => {
    assert.equal(actionRequiredBool("YES"), true);
    assert.equal(actionRequiredBool("NO"), false);
    assert.equal(actionRequiredBool(null), null);
  });
});

describe("listShippers", () => {
  it("sorts by shipments desc by default and totals", async () => {
    _deps.supabase = fakeDb({ rpc: { fpx_shipper_list: () => ({ data: LIST }) } });
    const r = await listShippers({});
    assert.deepEqual(r.shippers.map((s) => s.customer_name), ["beta & Sons/LLC", "Acme Co", NONE_LABEL, "Zeta"]);
    const none = r.shippers.find((s) => s.customer_name === NONE_LABEL);
    assert.equal(none.key, NONE_KEY);
    assert.equal(r.shippers[0].key, "beta%20%26%20Sons%2FLLC");
    assert.deepEqual(r.totals, { shippers: 4, shipments: 407, active: 97, open_tasks: 13, exceptions: 12, awaiting_reply: 7 });
  });
  it("supports every sort", async () => {
    _deps.supabase = fakeDb({ rpc: { fpx_shipper_list: () => ({ data: LIST }) } });
    const names = async (sort) => (await listShippers({ sort })).shippers.map((s) => s.customer_name);
    assert.deepEqual(await names("name"), [NONE_LABEL, "Acme Co", "beta & Sons/LLC", "Zeta"]);
    assert.equal((await names("open_tasks"))[0], NONE_LABEL);
    assert.equal((await names("exceptions"))[0], "beta & Sons/LLC");
    assert.equal((await names("awaiting_reply"))[0], "beta & Sons/LLC");
    assert.deepEqual((await names("last_email")).slice(0, 2), ["Acme Co", "beta & Sons/LLC"]);
    await assert.rejects(listShippers({ sort: "bogus" }), (e) => e.status === 400);
  });
  it("filters by q case-insensitively", async () => {
    _deps.supabase = fakeDb({ rpc: { fpx_shipper_list: () => ({ data: LIST }) } });
    const r = await listShippers({ q: "ACME" });
    assert.deepEqual(r.shippers.map((s) => s.customer_name), ["Acme Co"]);
    assert.equal(r.totals.shippers, 1);
  });
  it("includeEmail=false nulls the email fields and total", async () => {
    _deps.supabase = fakeDb({ rpc: { fpx_shipper_list: () => ({ data: LIST }) } });
    const r = await listShippers({ includeEmail: false });
    for (const s of r.shippers) {
      assert.equal(s.email_threads, null);
      assert.equal(s.awaiting_reply, null);
      assert.equal(s.last_email_at, null);
    }
    assert.equal(r.totals.awaiting_reply, null);
  });
  it("wraps rpc errors in a plain Error", async () => {
    _deps.supabase = fakeDb({ rpc: { fpx_shipper_list: () => ({ data: null, error: { message: "boom", code: "42883" } }) } });
    await assert.rejects(listShippers({}), (e) => e instanceof Error && /boom/.test(e.message) && !e.code);
  });
});

describe("getShipper", () => {
  it("404s for unknown shippers and shippers with no shipments", async () => {
    _deps.supabase = fakeDb({ rpc: { fpx_shipper_list: () => ({ data: LIST }) } });
    await assert.rejects(getShipper("Nobody"), (e) => e.status === 404);
    await assert.rejects(getShipper("Zeta"), (e) => e.status === 404);
  });
  it("returns the row plus carrier / mode / status counts", async () => {
    const db = fakeDb({
      rpc: { fpx_shipper_list: () => ({ data: LIST }) },
      tables: {
        fpx_shipments: () => ({ data: [
          { carrier_name: "FedEx", mode: "LTL", shipment_status: "In Transit" },
          { carrier_name: "FedEx", mode: "LTL", shipment_status: "Booked" },
          { carrier_name: null, carrier: "UPS", mode: "Parcel", shipment_status: "In Transit" },
        ] }),
      },
    });
    _deps.supabase = db;
    const r = await getShipper(encodeURIComponent("Acme Co"), { includeEmail: false });
    assert.equal(r.shipper.customer_name, "Acme Co");
    assert.equal(r.shipper.email_threads, null);
    assert.deepEqual(r.carriers, [{ name: "FedEx", count: 2 }, { name: "UPS", count: 1 }]);
    assert.deepEqual(r.statuses[0], { name: "In Transit", count: 2 });
    const q = db.calls.find((c) => c.table === "fpx_shipments");
    assert.deepEqual(op(q, "eq")[0], ["eq", "customer_name", "Acme Co"]);
    assert.deepEqual(op(q, "is")[0], ["is", "archived_at", null]);
  });
  it("the none key filters null/blank customer_name", async () => {
    const db = fakeDb({ rpc: { fpx_shipper_list: () => ({ data: LIST }) }, tables: { fpx_shipments: () => ({ data: [] }) } });
    _deps.supabase = db;
    const r = await getShipper(NONE_KEY);
    assert.equal(r.shipper.key, NONE_KEY);
    const q = db.calls.find((c) => c.table === "fpx_shipments");
    assert.deepEqual(op(q, "or")[0], ["or", "customer_name.is.null,customer_name.eq."]);
  });
});

describe("getShipperShipments", () => {
  it("shapes rows and batches task / email counts", async () => {
    const db = fakeDb({
      tables: {
        fpx_shipments: () => ({ count: 2, data: [
          { id: "u1", shipment_id: "S1", tracking_number: "T1", action_required: "YES", carrier: "UPS", origin: "X, 1 Main, Gallatin, TN, 37066, US,", destination: null, updated_eta: "2026-11-22T00:00:00Z" },
          { id: "u2", shipment_id: "S2", tracking_number: "T2", action_required: "NO", carrier_name: "FedEx" },
        ] }),
        fpx_shipment_tasks: () => ({ data: [{ shipment_id: "u1" }, { shipment_id: "u1" }] }),
        fpx_mailbox_links: () => ({ data: [
          { shipment_id: "S1", connection_id: "c", conversation_id: "a" },
          { shipment_id: "S1", connection_id: "c", conversation_id: "a" },
          { shipment_id: "S1", connection_id: "c", conversation_id: "b" },
        ] }),
      },
    });
    _deps.supabase = db;
    const r = await getShipperShipments("Acme Co", { status: "exceptions", q: "S1,(x)", limit: 999 });
    assert.equal(r.total, 2);
    const [a, b] = r.shipments;
    assert.equal(a.action_required, true);
    assert.equal(b.action_required, false);
    assert.equal(a.carrier_name, "UPS");
    assert.equal(a.origin, "Gallatin, TN");
    assert.equal(a.estimated_arrival, "2026-11-22T00:00:00Z");
    assert.equal(a.open_tasks, 2);
    assert.equal(b.open_tasks, 0);
    assert.equal(a.email_threads, 2);
    assert.equal(b.email_threads, 0);
    const q = db.calls.find((c) => c.table === "fpx_shipments");
    assert.deepEqual(op(q, "range")[0], ["range", 0, 199]); // limit capped at 200
    assert.ok(op(q, "ilike").some((o) => o[1] === "action_required"));
    const orQ = op(q, "or").map((o) => o[1]).join(" ");
    assert.ok(!/[()]x/.test(orQ) && orQ.includes("shipment_id.ilike.*S1 x*"));
    assert.equal(db.calls.filter((c) => c.table === "fpx_shipment_tasks").length, 1); // batched, not N+1
  });
  it("includeEmail=false skips links and nulls email_threads", async () => {
    const db = fakeDb({ tables: { fpx_shipments: () => ({ count: 1, data: [{ id: "u1", shipment_id: "S1" }] }) } });
    _deps.supabase = db;
    const r = await getShipperShipments("Acme Co", { includeEmail: false });
    assert.equal(r.shipments[0].email_threads, null);
    assert.equal(db.calls.some((c) => c.table === "fpx_mailbox_links"), false);
  });
  it("rejects a bad status", async () => {
    _deps.supabase = fakeDb();
    await assert.rejects(getShipperShipments("Acme Co", { status: "nope" }), (e) => e.status === 400);
  });
});

describe("getShipperTasks", () => {
  const open = [
    { id: "t-low-old", status: "open", priority: "low", due_at: null, created_at: iso(5 * DAY), fpx_shipments: { shipment_id: "S1" } },
    { id: "t-high-due2", status: "in_progress", priority: "high", due_at: iso(-2 * DAY), created_at: iso(DAY), fpx_shipments: { shipment_id: "S1" } },
    { id: "t-high-due1", status: "open", priority: "high", due_at: iso(-1 * DAY), created_at: iso(DAY), fpx_shipments: { shipment_id: "S2" } },
    { id: "t-overdue-low", status: "blocked", priority: "low", due_at: iso(DAY), created_at: iso(DAY), fpx_shipments: { shipment_id: "S2" } },
    { id: "t-urgent", status: "open", priority: "urgent", due_at: null, created_at: iso(DAY), fpx_shipments: { shipment_id: "S3" } },
    { id: "t-high-nodue-new", status: "open", priority: "high", due_at: null, created_at: iso(1000), fpx_shipments: { shipment_id: "S3" } },
    { id: "t-high-nodue-old", status: "open", priority: "high", due_at: null, created_at: iso(DAY), fpx_shipments: { shipment_id: "S3" } },
  ];
  const tasksTable = (q) => {
    if (q.opts?.head) return { count: 6, data: null };
    if (op(q, "in").length) return { data: open };
    return { data: [{ id: "d1", status: "done", priority: "high", created_at: iso(DAY), completed_at: iso(3600_000), fpx_shipments: { shipment_id: "S9" } }] };
  };

  it("orders overdue first, then priority, due date, newest", async () => {
    _deps.supabase = fakeDb({ tables: { fpx_shipment_tasks: tasksTable } });
    const r = await getShipperTasks("Acme Co");
    assert.deepEqual(r.tasks.map((t) => t.id), [
      "t-overdue-low", "t-urgent", "t-high-due1", "t-high-due2", "t-high-nodue-new", "t-high-nodue-old", "t-low-old",
    ]);
    assert.equal(r.tasks[0].overdue, true);
    assert.equal(r.tasks[0].shipment_id, "S2");
    assert.deepEqual(r.counts, { open: 5, in_progress: 1, blocked: 1, overdue: 1, done_30d: 6 });
  });
  it("done lists closed tasks; all merges; filters by embedded customer", async () => {
    const db = fakeDb({ tables: { fpx_shipment_tasks: tasksTable } });
    _deps.supabase = db;
    const done = await getShipperTasks("Acme Co", { status: "done" });
    assert.deepEqual(done.tasks.map((t) => t.id), ["d1"]);
    const all = await getShipperTasks("Acme Co", { status: "all", limit: 3 });
    assert.equal(all.tasks.length, 3);
    assert.ok(db.calls.filter((c) => c.table === "fpx_shipment_tasks")
      .every((c) => op(c, "eq").some((o) => o[1] === "fpx_shipments.customer_name" && o[2] === "Acme Co")));
    await assert.rejects(getShipperTasks("Acme Co", { status: "x" }), (e) => e.status === 400);
  });
  it("compareTasks treats unknown priority as lowest", () => {
    const a = { overdue: false, priority: null, created_at: iso(0) };
    const b = { overdue: false, priority: "low", created_at: iso(0) };
    assert.ok(compareTasks(b, a) < 0);
  });
});

describe("getShipperEmails", () => {
  const db = () => fakeDb({
    tables: {
      fpx_shipments: () => ({ data: [{ shipment_id: "S1" }, { shipment_id: "S2" }] }),
      fpx_mailbox_links: () => ({ data: [
        { shipment_id: "S1", connection_id: "c1", conversation_id: "A" },
        { shipment_id: "S2", connection_id: "c1", conversation_id: "A" },
        { shipment_id: "S2", connection_id: "c1", conversation_id: "B" },
        { shipment_id: "S1", connection_id: "c1", conversation_id: "OLD" },
      ] }),
      fpx_mailbox_thread_summary: () => ({ data: [
        { connection_id: "c1", conversation_id: "A", subject: "a", last_message_at: iso(DAY), status: "awaiting_reply", party: "customer", message_count: 3 },
        { connection_id: "c1", conversation_id: "B", subject: "b", last_message_at: iso(3600_000), status: "responded", party: "carrier", message_count: 1 },
        { connection_id: "c2", conversation_id: "B", subject: "other mailbox", last_message_at: iso(0), status: "responded", party: "x", message_count: 1 },
        { connection_id: "c1", conversation_id: "OLD", subject: "old", last_message_at: iso(100 * DAY), status: "responded", party: "x", message_count: 1 },
      ] }),
    },
  });
  it("lists linked threads newest first with this shipper's shipment ids", async () => {
    _deps.supabase = db();
    const r = await getShipperEmails("Acme Co");
    assert.deepEqual(r.threads.map((t) => t.conversation_id), ["B", "A"]);
    assert.deepEqual(r.threads[1].linked_shipment_ids, ["S1", "S2"]);
    assert.deepEqual(r.counts, { all: 2, awaiting_reply: 1, responded: 1 });
  });
  it("filters by status and days", async () => {
    _deps.supabase = db();
    const r = await getShipperEmails("Acme Co", { status: "awaiting_reply", days: "all" });
    assert.deepEqual(r.threads.map((t) => t.conversation_id), ["A"]);
    assert.deepEqual(r.counts, { all: 3, awaiting_reply: 1, responded: 2 });
    await assert.rejects(getShipperEmails("Acme Co", { days: 5 }), (e) => e.status === 400);
  });
});

describe("getShipperTimeline", () => {
  it("passes the label for the none key and drops email when not allowed", async () => {
    const events = [
      { at: iso(0), kind: "email", title: "e", ref_id: "conv" },
      { at: iso(1), kind: "note", title: "n", detail: "d", actor: "me" },
    ];
    const db = fakeDb({ rpc: { fpx_shipper_timeline: () => ({ data: events }) } });
    _deps.supabase = db;
    const all = await getShipperTimeline(NONE_KEY, {});
    assert.equal(all.events.length, 2);
    assert.deepEqual(db.calls[0].args, { p_customer: NONE_LABEL, p_limit: 100 });
    const noEmail = await getShipperTimeline("Acme Co", { includeEmail: false, limit: 1 });
    assert.deepEqual(noEmail.events.map((e) => e.kind), ["note"]);
    assert.equal(noEmail.events[0].shipment_id, null);
  });
});

import { cityState as _cityState } from "../lib/shippers.js";
import { test as _t } from "node:test";
import _assert from "node:assert/strict";
_t("cityState unpacks city+state+zip without separators", () => {
  _assert.equal(_cityState("ARLINGTONTX76018"), "Arlington, TX");
  _assert.equal(_cityState("SUGAR LANDTX77478"), "Sugar Land, TX");
  _assert.equal(_cityState("Addison, IL"), "Addison, IL");
});
