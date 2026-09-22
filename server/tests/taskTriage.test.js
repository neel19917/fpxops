import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTriage, extractJson, slimRowForTriage } from "../lib/taskTriage.js";

describe("extractJson", () => {
  it("parses bare JSON, fenced JSON, and JSON with prose around it", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```\nDone.'), { a: 2 });
    assert.deepEqual(extractJson('Summary first. {"a":3} trailing'), { a: 3 });
    assert.equal(extractJson("no json here"), null);
    assert.equal(extractJson(""), null);
  });
});

describe("normalizeTriage", () => {
  const known = new Set(["t1", "t2", "t3", "t4"]);
  it("drops unknown ids, dedups, ranks, and clamps dispositions", () => {
    const out = normalizeTriage({
      summary: "  two things  ",
      priority_queue: [
        { task_id: "t1", reason: "r1", first_action: "call" },
        { task_id: "ghost", reason: "x" },
        { task_id: "t1", reason: "dup" },
        { task_id: "t2" },
      ],
      close_candidates: [
        { task_id: "t3", disposition: "resolved", reason: "delivered" },
        { task_id: "t4", disposition: "made-up" },
        { task_id: "nope" },
      ],
      batches: [
        { label: "Modesto", task_ids: ["t1", "t2", "ghost"], reason: "same consignee" },
        { label: "too small", task_ids: ["t3"] },
      ],
      risks: ["a", "", null, "b"],
    }, known);
    assert.equal(out.summary, "two things");
    assert.deepEqual(out.priority_queue.map((p) => [p.task_id, p.rank]), [["t1", 1], ["t2", 2]]);
    assert.equal(out.priority_queue[1].reason, "");
    assert.deepEqual(out.close_candidates.map((c) => [c.task_id, c.disposition]), [["t3", "resolved"], ["t4", "not_actionable"]]);
    assert.deepEqual(out.batches, [{ label: "Modesto", reason: "same consignee", task_ids: ["t1", "t2"] }]);
    assert.deepEqual(out.risks, ["a", "b"]);
    assert.equal(out.dropped_ids, 3);
  });
  it("returns an empty shape for garbage input", () => {
    const out = normalizeTriage(null, known);
    assert.equal(out.summary, "");
    assert.deepEqual(out.priority_queue, []);
    assert.deepEqual(out.close_candidates, []);
    const out2 = normalizeTriage("string", ["t1"]);
    assert.deepEqual(out2.batches, []);
  });
});

describe("slimRowForTriage", () => {
  it("keeps the operator-visible fields and truncates long text", () => {
    const row = {
      task: { id: "t1", title: "T", status: "open", priority: "high", assigned_to: null },
      shipment: { id: "s1", tracking_number: "1", customer_name: "C", carrier_name: "K", ai_issue: "x".repeat(500), tracking_comments: "y".repeat(500) },
      seg: { segment: "carrier", attempt: null, flags: ["stale"], health: "Last scraped 9d ago", age_days: 2, days_since_scrape: 9 },
    };
    const slim = slimRowForTriage(row);
    assert.equal(slim.task_id, "t1");
    assert.equal(slim.shipment.ai_issue.length, 240);
    assert.equal(slim.shipment.carrier_comment.length, 160);
    assert.equal(slim.shipment.days_since_scrape, 9);
    assert.deepEqual(slim.flags, ["stale"]);
    assert.equal(slimRowForTriage({ task: { id: "t2" }, shipment: null, seg: {} }).shipment, null);
  });
});
