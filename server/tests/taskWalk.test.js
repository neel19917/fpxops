import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeWalkContext } from "../lib/taskWalk.js";

// computeWalkContext is the core of the GET /api/tasks/:id?walk=...
// response. It produces the prev/next pointers the dashboard drawer's
// chevrons consume. These tests cover the failure modes I've actually
// hit during development plus a swarm of boundary cases.

const T = (id, extra = {}) => ({ id, shipment_id: `s-${id}`, ...extra });

describe("computeWalkContext — null / shape guards", () => {
  it("returns null when no focused task is supplied", () => {
    assert.equal(computeWalkContext(null, [T("a")]), null);
    assert.equal(computeWalkContext(undefined, [T("a")]), null);
  });

  it("returns null when focused task has no id", () => {
    assert.equal(computeWalkContext({}, [T("a")]), null);
    assert.equal(computeWalkContext({ id: "" }, [T("a")]), null);
    assert.equal(computeWalkContext({ id: null }, [T("a")]), null);
  });

  it("never throws on weird `list` arguments", () => {
    const t = T("a");
    for (const bad of [null, undefined, {}, "list", 42, NaN]) {
      const v = computeWalkContext(t, bad);
      assert.equal(typeof v, "object");
      assert.equal(v.total, 1, `bad list ${JSON.stringify(bad)} should pin the focused task as a 1-of-1`);
    }
  });
});

describe("computeWalkContext — focused-task placement in the list", () => {
  it("idx 0: prev null, next is item 1", () => {
    const w = computeWalkContext(T("a"), [T("a"), T("b"), T("c")]);
    assert.equal(w.index, 0);
    assert.equal(w.total, 3);
    assert.equal(w.prev_id, null);
    assert.equal(w.next_id, "b");
    assert.equal(w.prev_shipment_id, null);
    assert.equal(w.next_shipment_id, "s-b");
    assert.deepEqual(w.ids, ["a", "b", "c"]);
  });

  it("middle: prev and next both populated", () => {
    const w = computeWalkContext(T("b"), [T("a"), T("b"), T("c")]);
    assert.equal(w.index, 1);
    assert.equal(w.prev_id, "a");
    assert.equal(w.next_id, "c");
  });

  it("last: prev populated, next null", () => {
    const w = computeWalkContext(T("c"), [T("a"), T("b"), T("c")]);
    assert.equal(w.index, 2);
    assert.equal(w.prev_id, "b");
    assert.equal(w.next_id, null);
  });

  it("single-item list: prev and next both null", () => {
    const w = computeWalkContext(T("a"), [T("a")]);
    assert.equal(w.index, 0);
    assert.equal(w.total, 1);
    assert.equal(w.prev_id, null);
    assert.equal(w.next_id, null);
  });
});

describe("computeWalkContext — focused task missing from list", () => {
  // This is the case where the user opened a task in walk-active mode,
  // marked it Done, and the new lookup happens against the active set
  // which no longer contains them. With no created_at signal we fall
  // back to prepending the focused task; with created_at we splice into
  // the right slot so the operator's walking direction is preserved.
  it("prepends the focused task when neither side has created_at", () => {
    const w = computeWalkContext(T("z"), [T("a"), T("b")]);
    assert.equal(w.index, 0);
    assert.equal(w.total, 3);
    assert.equal(w.prev_id, null);
    assert.equal(w.next_id, "a");
    assert.deepEqual(w.ids, ["z", "a", "b"]);
  });

  it("empty list + missing focus → 1-of-1 with no siblings", () => {
    const w = computeWalkContext(T("z"), []);
    assert.equal(w.total, 1);
    assert.equal(w.prev_id, null);
    assert.equal(w.next_id, null);
    assert.deepEqual(w.ids, ["z"]);
  });

  // Regression: completing a task mid-walk used to send the user back
  // to the first active task (next_id = list[0]). The fix splices the
  // focused task back into its created_at slot so next_id is the task
  // they were *about* to walk to, not index 0 of whatever remains.
  it("splices focused task into its created_at slot (DESC order)", () => {
    // List sorted created_at DESC: c (newest) → b → a (oldest).
    // Focused task `mid` was created between c and b, but its status
    // changed so it's no longer in the active list.
    const list = [
      { id: "c", shipment_id: "s-c", created_at: "2026-04-30T12:00:00Z" },
      { id: "b", shipment_id: "s-b", created_at: "2026-04-29T12:00:00Z" },
      { id: "a", shipment_id: "s-a", created_at: "2026-04-28T12:00:00Z" },
    ];
    const focused = { id: "mid", shipment_id: "s-mid", created_at: "2026-04-30T06:00:00Z" };
    const w = computeWalkContext(focused, list);
    assert.equal(w.index, 1, "should slot between c and b");
    assert.equal(w.total, 4);
    assert.equal(w.prev_id, "c", "previous in DESC order is the newer task");
    assert.equal(w.next_id, "b", "next in DESC order is the older task — what user was walking to");
    assert.deepEqual(w.ids, ["c", "mid", "b", "a"]);
  });

  it("appends to the end when focused is older than every active task", () => {
    const list = [
      { id: "c", shipment_id: "s-c", created_at: "2026-04-30T12:00:00Z" },
      { id: "b", shipment_id: "s-b", created_at: "2026-04-29T12:00:00Z" },
    ];
    const focused = { id: "old", shipment_id: "s-old", created_at: "2025-01-01T00:00:00Z" };
    const w = computeWalkContext(focused, list);
    assert.equal(w.index, 2);
    assert.equal(w.prev_id, "b");
    assert.equal(w.next_id, null, "nothing older to walk to");
  });

  it("prepends when focused is newer than every active task", () => {
    const list = [
      { id: "b", shipment_id: "s-b", created_at: "2026-04-29T12:00:00Z" },
      { id: "a", shipment_id: "s-a", created_at: "2026-04-28T12:00:00Z" },
    ];
    const focused = { id: "new", shipment_id: "s-new", created_at: "2026-05-01T00:00:00Z" };
    const w = computeWalkContext(focused, list);
    assert.equal(w.index, 0);
    assert.equal(w.prev_id, null);
    assert.equal(w.next_id, "b");
  });
});

describe("computeWalkContext — list sanitization", () => {
  it("drops list entries that aren't task-shaped", () => {
    const w = computeWalkContext(T("a"), [
      T("a"),
      null,
      undefined,
      "not-a-task",
      { },                  // no id
      { id: "" },           // empty id
      T("b"),
    ]);
    assert.deepEqual(w.ids, ["a", "b"]);
    assert.equal(w.total, 2);
    assert.equal(w.next_id, "b");
  });

  it("preserves duplicate ids by sticking with the first match", () => {
    // Should never happen in prod (DB UUIDs are unique) but the
    // resolver shouldn't break if it does.
    const w = computeWalkContext(T("b"), [T("a"), T("b"), T("b"), T("c")]);
    assert.equal(w.index, 1);
    assert.equal(w.total, 4, "duplicates preserved in list");
  });
});

describe("computeWalkContext — mode passthrough", () => {
  it("uses 'active' as the default mode", () => {
    const w = computeWalkContext(T("a"), [T("a")]);
    assert.equal(w.mode, "active");
  });

  it("passes through any string mode the caller supplies", () => {
    for (const m of ["open", "in_progress", "blocked", "done", "all", "active"]) {
      const w = computeWalkContext(T("a"), [T("a")], m);
      assert.equal(w.mode, m);
    }
  });

  it("falls back to 'active' when mode is empty / missing / not a string", () => {
    assert.equal(computeWalkContext(T("a"), [T("a")], "").mode, "active");
    assert.equal(computeWalkContext(T("a"), [T("a")], null).mode, "active");
    assert.equal(computeWalkContext(T("a"), [T("a")], undefined).mode, "active");
    assert.equal(computeWalkContext(T("a"), [T("a")], 42).mode, "active");
  });
});

describe("computeWalkContext — shipment_id forwarding", () => {
  it("propagates shipment ids onto prev/next pointers", () => {
    const list = [
      { id: "a", shipment_id: "ship-1" },
      { id: "b", shipment_id: "ship-2" },
      { id: "c", shipment_id: "ship-3" },
    ];
    const w = computeWalkContext(list[1], list);
    assert.equal(w.prev_shipment_id, "ship-1");
    assert.equal(w.next_shipment_id, "ship-3");
  });

  it("sets shipment ids to null on items missing one (orphan tasks)", () => {
    const list = [
      { id: "a" }, // no shipment_id
      { id: "b", shipment_id: "ship-2" },
    ];
    const w = computeWalkContext(list[1], list);
    assert.equal(w.prev_shipment_id, null, "orphan prev → null shipment id");
    assert.equal(w.next_shipment_id, null, "no next at all");
    assert.equal(w.prev_id, "a");
  });
});

describe("computeWalkContext — long lists (perf sanity)", () => {
  it("indexes correctly in a 1000-item list", () => {
    const list = Array.from({ length: 1000 }, (_, i) => T(`t-${i}`));
    const focus = list[500];
    const w = computeWalkContext(focus, list);
    assert.equal(w.index, 500);
    assert.equal(w.total, 1000);
    assert.equal(w.prev_id, "t-499");
    assert.equal(w.next_id, "t-501");
    // ids array should be a 1:1 projection.
    assert.equal(w.ids.length, 1000);
    assert.equal(w.ids[0], "t-0");
    assert.equal(w.ids[999], "t-999");
  });
});
