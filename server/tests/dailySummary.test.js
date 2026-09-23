import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shapeDigest, stripFences } from "../lib/dailySummary.js";
import { buildBoard } from "../lib/taskSegments.js";

const NOW = Date.parse("2026-09-23T16:00:00Z");
const iso = (h) => new Date(NOW - h * 3_600_000).toISOString();
const from = iso(24), to = iso(0);

const ship = (id, over = {}) => ({
  id, tracking_number: `T${id}`, customer_name: `Cust ${id}`, carrier_name: "XPO LTL", mode: "LTL",
  shipment_status: "In Transit", scraped_at: iso(1), delivery_date: null, archived_at: null, action_required: "YES", ...over,
});
const task = (id, over = {}) => ({
  id: `t${id}`, shipment_id: `s${id}`, tracking_number: `Ts${id}`, status: "open", assigned_to: "Allen", priority: "high",
  title: "Carrier followup: call the carrier", created_at: iso(2), updated_at: iso(2), completed_at: null, ...over,
});

describe("shapeDigest", () => {
  const ships = new Map([["s1", ship("s1")], ["s2", ship("s2", { carrier_name: "SAIA" })], ["s3", ship("s3", { delivery_date: iso(3) })], ["s9", ship("s9")]]);
  const tasks = [
    task(1, { title: "Customer followup: Storage risk — move the appointment" }),                       // created today, active, storage
    task(2, { status: "done", completed_at: iso(5), created_at: iso(30), updated_at: iso(5), assigned_to: "Victor" }), // completed today
    task(3, { status: "cancelled", created_at: iso(40), updated_at: iso(6) }),                          // dismissed today
    task(4, { created_at: iso(40), updated_at: iso(40), shipment_id: "s3", title: "Carrier followup: Redelivery — x (attempt 2)" }), // old, on delivered shipment
    task(9, { created_at: iso(40), updated_at: iso(40), assigned_to: null, created_at_: 0 }),           // old, unassigned, aging
  ];
  tasks[4].created_at = iso(24 * 6);
  const board = buildBoard(tasks.filter((t) => t.status !== "done" && t.status !== "cancelled"), ships, { now: NOW, staleDays: 7 });

  const digest = shapeDigest({
    from, to, tasksTouched: tasks, shipmentsById: ships, board,
    scrapedCount: 519, lastScrapeAt: iso(1), activeYesCount: 40, deliveredCount: 3, archivedCount: 0,
    newlyFlagged: [ship("s1", { ai_issue: "Storage risk: 70h" })],
    analyses: [
      { kind: "per_shipment", cost_usd: 0.01 }, { kind: "per_shipment", cost_usd: 0.02 },
      { kind: "other", cost_usd: 0.26, metadata: { subkind: "task_triage" } },
    ],
    audit: [{ actor_email: "allen@x", action: "update" }, { actor_email: "allen@x", action: "shipment_note" }, { actor_email: null, actor_name: null, action: "auto_task" }],
    notes: [{ created_at: iso(2), created_by: "allen@x", tracking_number: "Ts1", body: "Called XPO" }],
  });

  it("windows created / completed / dismissed correctly", () => {
    assert.equal(digest.window.hours, 24);
    assert.equal(digest.tasks.created_count, 1);
    assert.equal(digest.tasks.created[0].segment, "storage_risk");
    assert.equal(digest.tasks.completed_count, 1);
    assert.deepEqual(digest.tasks.completed_by_assignee, { Victor: 1 });
    assert.equal(digest.tasks.dismissed_count, 1);
  });
  it("board section: attention excludes resolved-upstream, aging + unassigned counted", () => {
    assert.equal(digest.board.active, 3);
    // t4 is redelivery+repeat but its shipment is delivered → not attention
    assert.equal(digest.board.needs_attention_count, 1);
    assert.equal(digest.board.needs_attention[0].segment, "storage_risk");
    assert.equal(digest.board.likely_resolved_count, 1);
    assert.equal(digest.board.unassigned_count, 1);
    assert.equal(digest.board.aging_count, 1);
    assert.equal(digest.board.aging_oldest[0].age_days, 6);
    assert.equal(digest.board.top_carriers[0].key, "XPO LTL");
  });
  it("shipments, ai and team sections roll up", () => {
    assert.equal(digest.shipments.scraped_in_window, 519);
    assert.equal(digest.shipments.newly_flagged_count, 1);
    assert.equal(digest.shipments.newly_flagged[0].issue, "Storage risk: 70h");
    assert.equal(digest.ai.calls, 3);
    assert.equal(digest.ai.cost_usd, 0.29);
    assert.equal(digest.ai.by_kind["other/task_triage"].count, 1);
    assert.equal(digest.team.by_actor["allen@x"].total, 2);
    assert.equal(digest.team.by_actor["(system)"].by_action.auto_task, 1);
    assert.equal(digest.team.notes[0].tracking_number, "Ts1");
  });
  it("tolerates empty inputs", () => {
    const d = shapeDigest({ from, to });
    assert.equal(d.tasks.created_count, 0);
    assert.equal(d.board.active, 0);
    assert.equal(d.ai.cost_usd, 0);
  });
});

describe("stripFences", () => {
  it("unwraps a fenced markdown block and leaves plain text alone", () => {
    assert.equal(stripFences("```markdown\n# Hi\n\ntext\n```"), "# Hi\n\ntext");
    assert.equal(stripFences("# Hi"), "# Hi");
    assert.equal(stripFences(null), "");
  });
});
