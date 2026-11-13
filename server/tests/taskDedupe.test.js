import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEDUPE_ACTIVE,
  taskAudience,
  planDedupe,
  applyDedupe,
  supersedeOlderFor,
  loadActiveForDedupe,
} from "../lib/taskDedupe.js";

let seq = 0;
function task(over = {}) {
  seq++;
  return {
    id: `0000000${seq}-aaaa-bbbb-cccc-000000000000`.slice(-36),
    shipment_id: "ship-1",
    tracking_number: "PRO100",
    title: "Carrier followup: get ETA",
    description: null,
    status: "open",
    priority: "normal",
    assigned_to: null,
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    archived_at: null,
    email_queued_at: null,
    email_queued_by: null,
    ...over,
  };
}

// Minimal in-memory stand-in for the supabase query builder. Supports the
// calls taskDedupe makes: from/select/update/eq/in/is/order/limit, awaited.
function fakeSupabase(rows, { failUpdateIds = [] } = {}) {
  const db = rows.map((r) => ({ ...r }));
  const updates = [];
  const selects = [];
  return {
    db,
    updates,
    selects,
    from(table) {
      const q = { table, filters: [], patch: null, max: null };
      const match = (r) => q.filters.every((f) => {
        if (f.op === "eq") return r[f.col] === f.val;
        if (f.op === "in") return f.val.includes(r[f.col]);
        if (f.op === "is") return (r[f.col] ?? null) === f.val;
        return true;
      });
      const builder = {
        select() { return builder; },
        update(patch) { q.patch = patch; return builder; },
        eq(col, val) { q.filters.push({ op: "eq", col, val }); return builder; },
        in(col, val) { q.filters.push({ op: "in", col, val }); return builder; },
        is(col, val) { q.filters.push({ op: "is", col, val }); return builder; },
        order() { return builder; },
        limit(n) { q.max = n; return builder; },
        then(resolve, reject) {
          let res;
          if (q.patch) {
            const idF = q.filters.find((f) => f.op === "eq" && f.col === "id");
            if (idF && failUpdateIds.includes(idF.val)) {
              updates.push({ id: idF.val, patch: q.patch, filters: q.filters, failed: true });
              res = { data: null, error: { message: "boom" } };
            } else {
              const hit = db.filter(match);
              for (const r of hit) Object.assign(r, q.patch);
              updates.push({ id: idF?.val, patch: q.patch, filters: q.filters, matched: hit.length });
              res = { data: hit.map((r) => ({ id: r.id })), error: null };
            }
          } else {
            selects.push({ filters: q.filters, max: q.max });
            let hit = db.filter(match);
            if (q.max != null) hit = hit.slice(0, q.max);
            res = { data: hit.map((r) => ({ ...r })), error: null };
          }
          return Promise.resolve(res).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

test("taskAudience reads the title prefix only", () => {
  assert.equal(taskAudience("Carrier followup: get ETA"), "carrier");
  assert.equal(taskAudience("CUSTOMER FOLLOWUP: notify"), "customer");
  assert.equal(taskAudience("customer followup: Redelivery — notify customer"), "customer");
  assert.equal(taskAudience("Call the carrier followup: later"), null);
  assert.equal(taskAudience("Check paperwork"), null);
  assert.equal(taskAudience(null), null);
  assert.equal(taskAudience(undefined), null);
  assert.deepEqual(DEDUPE_ACTIVE, ["open", "in_progress", "blocked"]);
});

test("newest task wins, older ones are superseded newest-first", () => {
  const a = task({ created_at: "2026-11-01T10:00:00Z" });
  const b = task({ created_at: "2026-11-03T10:00:00Z" });
  const c = task({ created_at: "2026-11-02T10:00:00Z" });
  const plan = planDedupe([a, b, c]);
  assert.equal(plan.groups.length, 1);
  const g = plan.groups[0];
  assert.equal(g.keep.id, b.id);
  assert.deepEqual(g.supersede.map((s) => s.id), [c.id, a.id]);
  assert.equal(g.shipment_id, "ship-1");
  assert.equal(g.tracking_number, "PRO100");
  assert.equal(g.audience, "carrier");
  assert.equal(plan.supersede_count, 2);
  assert.deepEqual(plan.shipments, ["ship-1"]);
  assert.deepEqual(Object.keys(g.keep).sort(), [
    "assigned_to", "created_at", "email_queued_at", "email_queued_by", "id", "priority", "status", "title",
  ]);
});

test("a carrier + customer pair on one shipment is not a duplicate", () => {
  const plan = planDedupe([
    task({ title: "Carrier followup: Redelivery — re-attempt" }),
    task({ title: "Customer followup: Redelivery — notify customer" }),
  ]);
  assert.deepEqual(plan, { groups: [], min_confidence: 0, supersede_count: 0, held_count: 0, shipments: [] });
});

test("same audience on different shipments is not a duplicate", () => {
  const plan = planDedupe([task({ shipment_id: "s1" }), task({ shipment_id: "s2" })]);
  assert.equal(plan.groups.length, 0);
});

test("same-timestamp tie is deterministic regardless of input order", () => {
  const a = task({ id: "aaaaaaaa-0000-0000-0000-000000000000" });
  const b = task({ id: "bbbbbbbb-0000-0000-0000-000000000000" });
  const c = task({ id: "cccccccc-0000-0000-0000-000000000000", updated_at: "2026-11-05T00:00:00Z" });
  // c has the latest updated_at; then id desc → b before a.
  for (const order of [[a, b, c], [c, b, a], [b, c, a], [a, c, b]]) {
    const g = planDedupe(order).groups[0];
    assert.equal(g.keep.id, c.id);
    assert.deepEqual(g.supersede.map((s) => s.id), [b.id, a.id]);
  }
  const g2 = planDedupe([a, b]).groups[0];
  assert.equal(g2.keep.id, b.id);
  assert.equal(planDedupe([b, a]).groups[0].keep.id, b.id);
});

test("untagged titles are never superseded and never supersede", () => {
  const manualNew = task({ title: "Check paperwork", created_at: "2026-11-09T00:00:00Z" });
  const manualOld = task({ title: "Check paperwork", created_at: "2026-11-01T00:00:00Z" });
  const carrier = task({ created_at: "2026-11-02T00:00:00Z" });
  const plan = planDedupe([manualNew, manualOld, carrier]);
  assert.equal(plan.groups.length, 0);
  assert.equal(plan.supersede_count, 0);
});

test("done / cancelled / archived / shipment-less tasks are ignored", () => {
  const live = task({ created_at: "2026-11-01T00:00:00Z" });
  const plan = planDedupe([
    live,
    task({ status: "done", created_at: "2026-11-05T00:00:00Z" }),
    task({ status: "cancelled", created_at: "2026-11-06T00:00:00Z" }),
    task({ archived_at: "2026-11-07T00:00:00Z", created_at: "2026-11-07T00:00:00Z" }),
    task({ shipment_id: null, created_at: "2026-11-08T00:00:00Z" }),
  ]);
  assert.equal(plan.groups.length, 0);

  // ...and a newer closed task does not shield an older active duplicate pair.
  const older = task({ created_at: "2026-10-01T00:00:00Z" });
  const plan2 = planDedupe([live, older, task({ status: "done", created_at: "2026-11-09T00:00:00Z" })]);
  assert.equal(plan2.groups[0].keep.id, live.id);
  assert.deepEqual(plan2.groups[0].supersede.map((s) => s.id), [older.id]);
});

test("carry_queue and working flags", () => {
  const keep = task({ created_at: "2026-11-05T00:00:00Z" });
  const queuedOld = task({ email_queued_at: "2026-11-02T00:00:00Z", email_queued_by: "a@x.com" });
  let g = planDedupe([keep, queuedOld]).groups[0];
  assert.equal(g.carry_queue, true);
  assert.equal(g.working, false);

  // keeper already queued → nothing to carry
  const keepQueued = task({ created_at: "2026-11-05T00:00:00Z", email_queued_at: "2026-11-05T01:00:00Z" });
  g = planDedupe([keepQueued, queuedOld]).groups[0];
  assert.equal(g.carry_queue, false);

  // nobody queued
  g = planDedupe([keep, task()]).groups[0];
  assert.equal(g.carry_queue, false);

  for (const status of ["in_progress", "blocked"]) {
    g = planDedupe([keep, task({ status })]).groups[0];
    assert.equal(g.working, true, status);
  }
  // a working KEEPER does not set the flag
  g = planDedupe([task({ status: "in_progress", created_at: "2026-11-09T00:00:00Z" }), task()]).groups[0];
  assert.equal(g.working, false);
});

test("groups are sorted by tracking number then audience", () => {
  const mk = (tn, ship, title) => [
    task({ tracking_number: tn, shipment_id: ship, title }),
    task({ tracking_number: tn, shipment_id: ship, title, created_at: "2026-11-04T00:00:00Z" }),
  ];
  const plan = planDedupe([
    ...mk("PRO300", "s3", "Carrier followup: x"),
    ...mk("PRO100", "s1", "Customer followup: x"),
    ...mk(null, "s9", "Carrier followup: x"),
    ...mk("PRO100", "s1", "Carrier followup: x"),
  ]);
  assert.deepEqual(
    plan.groups.map((g) => [g.tracking_number, g.audience]),
    [["PRO100", "carrier"], ["PRO100", "customer"], ["PRO300", "carrier"], [null, "carrier"]],
  );
  assert.equal(plan.supersede_count, 4);
  assert.deepEqual([...plan.shipments].sort(), ["s1", "s3", "s9"]);
});

test("planDedupe does not mutate its input", () => {
  const input = [
    task({ created_at: "2026-11-01T00:00:00Z", email_queued_at: "2026-11-01T05:00:00Z" }),
    task({ created_at: "2026-11-03T00:00:00Z" }),
    task({ created_at: "2026-11-02T00:00:00Z", status: "blocked" }),
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const order = input.map((t) => t.id);
  Object.freeze(input);
  input.forEach(Object.freeze);
  const plan = planDedupe(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(input.map((t) => t.id), order);
  assert.notEqual(plan.groups[0].keep, input[1]);
  assert.deepEqual(planDedupe(null), { groups: [], min_confidence: 0, supersede_count: 0, held_count: 0, shipments: [] });
});

test("applyDedupe cancels old tasks with a note, clears their queue, carries it to the keeper", async () => {
  const keep = task({ id: "99999999-1111-2222-3333-444444444444", created_at: "2026-11-05T00:00:00Z" });
  const old1 = task({
    description: "Original ask", created_at: "2026-11-01T00:00:00Z",
    email_queued_at: "2026-11-02T00:00:00Z", email_queued_by: "early@x.com", completed_at: null,
  });
  const old2 = task({
    created_at: "2026-11-03T00:00:00Z", status: "in_progress",
    email_queued_at: "2026-11-04T00:00:00Z", email_queued_by: "late@x.com",
  });
  const bystander = task({ title: "Customer followup: notify" });
  const sb = fakeSupabase([keep, old1, old2, bystander]);
  const plan = planDedupe(sb.db);
  const planSnapshot = JSON.parse(JSON.stringify(plan));

  const result = await applyDedupe(sb, plan, { who: "ops@fpx.com" });
  assert.deepEqual(plan, planSnapshot);
  assert.equal(result.superseded, 2);
  assert.equal(result.carried_queue, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual([...result.ids].sort(), [old1.id, old2.id].sort());

  const row = (id) => sb.db.find((r) => r.id === id);
  const today = new Date().toISOString().slice(0, 10);
  const note = `[${today} superseded by newer task 99999999 — ops@fpx.com — confidence 99%]`;
  assert.equal(row(old1.id).status, "cancelled");
  assert.equal(row(old1.id).description, `Original ask\n\n${note}`);
  assert.equal(row(old2.id).description, note);
  for (const id of [old1.id, old2.id]) {
    assert.equal(row(id).status, "cancelled");
    assert.equal(row(id).completed_at, null);
    assert.equal(row(id).email_queued_at, null);
    assert.equal(row(id).email_queued_by, null);
  }
  // keeper gets the MOST RECENT queue stamp and stays active
  assert.equal(row(keep.id).status, "open");
  assert.equal(row(keep.id).email_queued_at, "2026-11-04T00:00:00Z");
  assert.equal(row(keep.id).email_queued_by, "late@x.com");
  // unrelated task untouched; nothing deleted
  assert.deepEqual(row(bystander.id), bystander);
  assert.equal(sb.db.length, 4);
  // every update is guarded by the active-status filter
  assert.equal(sb.updates.length, 3);
  for (const u of sb.updates) {
    assert.ok(u.filters.some((f) => f.op === "in" && f.col === "status" && f.val === DEDUPE_ACTIVE));
  }
});

test("applyDedupe leaves a task that was closed after planning alone", async () => {
  const keep = task({ created_at: "2026-11-05T00:00:00Z" });
  const old1 = task({ created_at: "2026-11-01T00:00:00Z" });
  const old2 = task({ created_at: "2026-11-02T00:00:00Z" });
  const sb = fakeSupabase([keep, old1, old2]);
  const plan = planDedupe(sb.db);
  sb.db.find((r) => r.id === old1.id).status = "done"; // operator finished it meanwhile

  const result = await applyDedupe(sb, plan, { who: "ops" });
  assert.equal(result.superseded, 1);
  assert.deepEqual(result.ids, [old2.id]);
  assert.equal(sb.db.find((r) => r.id === old1.id).status, "done");
  assert.equal(sb.db.find((r) => r.id === old1.id).description, null);
});

test("applyDedupe skips a group whose keeper is no longer active", async () => {
  const keep = task({ created_at: "2026-11-05T00:00:00Z" });
  const old = task({ created_at: "2026-11-01T00:00:00Z" });
  const sb = fakeSupabase([keep, old]);
  const plan = planDedupe(sb.db);
  sb.db.find((r) => r.id === keep.id).status = "done";

  const result = await applyDedupe(sb, plan, { who: "ops" });
  assert.equal(result.superseded, 0);
  assert.equal(result.skipped, 1);
  assert.equal(sb.db.find((r) => r.id === old.id).status, "open");
  assert.equal(sb.updates.length, 0);
});

test("applyDedupe counts a single-row failure and keeps going", async () => {
  const keep = task({ created_at: "2026-11-05T00:00:00Z" });
  const bad = task({ created_at: "2026-11-02T00:00:00Z" });
  const good = task({ created_at: "2026-11-01T00:00:00Z" });
  const sb = fakeSupabase([keep, bad, good], { failUpdateIds: [bad.id] });
  const result = await applyDedupe(sb, planDedupe(sb.db), {});
  assert.equal(result.failed, 1);
  assert.equal(result.superseded, 1);
  assert.deepEqual(result.ids, [good.id]);
  assert.match(sb.db.find((r) => r.id === good.id).description, /— system — confidence \d+%\]$/);
});

test("applyDedupe with an empty plan does nothing", async () => {
  const sb = fakeSupabase([task()]);
  const result = await applyDedupe(sb, planDedupe(sb.db), { who: "x" });
  assert.deepEqual(result, { superseded: 0, carried_queue: 0, failed: 0, skipped: 0, ids: [] });
  assert.equal(sb.selects.length, 0);
  assert.equal(sb.updates.length, 0);
});

test("supersedeOlderFor: dry run plans without writing, real run applies", async () => {
  const rows = [
    task({ shipment_id: "s1", created_at: "2026-11-05T00:00:00Z" }),
    task({ shipment_id: "s1", created_at: "2026-11-01T00:00:00Z" }),
    task({ shipment_id: "s2", created_at: "2026-11-05T00:00:00Z" }),
    task({ shipment_id: "s2", created_at: "2026-11-01T00:00:00Z" }),
  ];
  const sb = fakeSupabase(rows);
  const dry = await supersedeOlderFor(sb, ["s1"], { who: "ops", dryRun: true });
  assert.equal(dry.result, null);
  assert.equal(dry.plan.supersede_count, 1);
  assert.deepEqual(dry.plan.shipments, ["s1"]);
  assert.equal(sb.updates.length, 0);

  const real = await supersedeOlderFor(sb, ["s1"], { who: "ops" });
  assert.equal(real.result.superseded, 1);
  assert.equal(sb.db[1].status, "cancelled");
  assert.equal(sb.db[3].status, "open"); // s2 not in scope

  const none = await supersedeOlderFor(sb, [], { who: "ops" });
  assert.equal(none.plan.supersede_count, 0);
  assert.equal(none.result.superseded, 0);
});

test("loadActiveForDedupe: taskIds widen to the whole shipment; inactive rows excluded", async () => {
  const newer = task({ shipment_id: "s1", created_at: "2026-11-05T00:00:00Z" });
  const selected = task({ shipment_id: "s1", created_at: "2026-11-01T00:00:00Z" });
  const done = task({ shipment_id: "s1", status: "done" });
  const archived = task({ shipment_id: "s1", archived_at: "2026-11-02T00:00:00Z" });
  const other = task({ shipment_id: "s2" });
  const sb = fakeSupabase([newer, selected, done, archived, other]);

  const byTask = await loadActiveForDedupe(sb, { taskIds: [selected.id] });
  assert.deepEqual(byTask.map((t) => t.id).sort(), [newer.id, selected.id].sort());

  const byShip = await loadActiveForDedupe(sb, { shipmentIds: ["s2"] });
  assert.deepEqual(byShip.map((t) => t.id), [other.id]);

  const all = await loadActiveForDedupe(sb);
  assert.equal(all.length, 3);
  assert.equal(sb.selects.at(-1).max, 3000);

  assert.deepEqual(await loadActiveForDedupe(sb, { taskIds: [] }), []);
  assert.deepEqual(await loadActiveForDedupe(sb, { taskIds: ["nope"] }), []);
});

test("loadActiveForDedupe chunks .in() by 200", async () => {
  const sb = fakeSupabase([]);
  const ids = Array.from({ length: 450 }, (_, i) => `s${i}`);
  await loadActiveForDedupe(sb, { shipmentIds: ids });
  const sizes = sb.selects.map((s) => s.filters.find((f) => f.col === "shipment_id").val.length);
  assert.deepEqual(sizes, [200, 200, 50]);
});

test("storage-risk tasks are their own lane", async () => {
  const { planDedupe } = await import("../lib/taskDedupe.js");
  const mk = (id, title, created_at) => ({ id, shipment_id: "s1", tracking_number: "T1", title, status: "open", created_at });
  const plan = planDedupe([
    mk("a", "Customer followup: Storage risk — offer options", "2026-11-12T00:00:00Z"),
    mk("b", "Customer followup: call the customer", "2026-11-13T00:00:00Z"),
    mk("c", "Customer followup: older ask", "2026-11-10T00:00:00Z"),
  ]);
  assert.equal(plan.supersede_count, 1);
  assert.equal(plan.groups[0].keep.id, "b");
  assert.equal(plan.groups[0].supersede[0].id, "c");
});

test("confidence: same-kind open duplicate is high, in-progress older is low and held back", async () => {
  const { planDedupe, dedupeConfidence, CONFIDENCE_AUTO } = await import("../lib/taskDedupe.js");
  const mk = (id, title, created_at, status = "open") => ({ id, shipment_id: "s1", tracking_number: "T1", title, status, created_at });
  const keep = mk("c", "Carrier followup: Redelivery — get a re-attempt date (attempt 3)", "2026-11-13T00:00:00Z");
  const same = mk("b", "Carrier followup: Redelivery — get a re-attempt date (attempt 2)", "2026-11-12T00:00:00Z");
  const working = mk("a", "Carrier followup: confirm pickup scan", "2026-11-11T00:00:00Z", "in_progress");
  assert.ok(dedupeConfidence(keep, same).confidence >= CONFIDENCE_AUTO);
  assert.ok(dedupeConfidence(keep, working).confidence < 50);
  const plan = planDedupe([keep, same, working], { minConfidence: CONFIDENCE_AUTO });
  assert.deepEqual(plan.groups[0].supersede.map((t) => t.id), ["b"]);
  assert.deepEqual(plan.groups[0].held.map((t) => t.id), ["a"]);
  assert.equal(plan.groups[0].working, false);
  assert.equal(plan.held_count, 1);
  assert.ok(plan.groups[0].held[0].reasons.length);
});
