// Task segmentation for the Tasks v2 board.
//
// The classic /tasks page groups by status and by the Carrier/Customer title
// prefix only. That hid the things operators actually complained about on
// 2026-09-22: redelivery pairs stacked on already-worked shipments, tasks on
// freight that was delivered months ago but never re-scraped, and the same
// shipment carrying three "attempt N" pairs. This module turns a task + its
// shipment row into one primary segment plus a set of health flags so the
// board can put each task in exactly one bucket and still surface the
// cross-cutting problems (stale, resolved upstream, duplicate).
//
// Pure functions only — no supabase — so the whole thing is unit-testable.

import { isRedeliveryTitle } from "./redelivery.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Primary segments. Exactly one per task. Order here is the display order
// on the board rail.
export const TASK_SEGMENTS = [
  { id: "redelivery",   label: "Redelivery",        description: "LTL failed delivery attempts (carrier re-attempt + customer notify pairs)." },
  { id: "return_claim", label: "Return / claim",    description: "Freight coming back to the shipper; disposition or claim needed." },
  { id: "carrier",      label: "Carrier follow-ups", description: "FPX needs something from the carrier (ETA, POD, pickup confirmation)." },
  { id: "customer",     label: "Customer follow-ups", description: "FPX needs something from the shipper or consignee." },
  { id: "other",        label: "Other",             description: "Manually created or untagged tasks." },
];

// Health flags. Zero or more per task. `tone` drives the chip color on the
// board; `label` is what the operator reads.
export const TASK_FLAGS = [
  { id: "resolved_upstream", label: "Likely resolved", tone: "emerald",
    description: "Shipment is delivered, archived, or the AI no longer flags it — the task is probably moot." },
  { id: "stale",     label: "Stale data", tone: "amber",
    description: "Shipment has not been scraped recently, so the task is working from old carrier data." },
  { id: "duplicate", label: "Duplicate", tone: "violet",
    description: "Another active task exists on the same shipment." },
  { id: "repeat",    label: "Repeat failure", tone: "rose",
    description: "This is a 2nd+ failed delivery attempt on the shipment." },
  { id: "aging",     label: "Aging", tone: "orange",
    description: "Open for 5+ days without being completed." },
  { id: "unassigned", label: "Unassigned", tone: "slate",
    description: "No owner." },
  { id: "blocked",   label: "Blocked", tone: "amber",
    description: "Marked blocked by an operator." },
];

const RETURN_CLAIM_RE = /^(carrier|customer) followup:\s*return\/claim — /i;
const ATTEMPT_RE = /\(attempt\s+(\d+)\)\s*$/i;

function lower(s) { return String(s || "").toLowerCase(); }

export function isReturnClaimTitle(title) {
  return typeof title === "string" && RETURN_CLAIM_RE.test(title);
}

// Mirrors isCarrierFollowupTitle / isCustomerFollowupTitle in routes/tasks.js
// (kept there because the followups endpoints own them). Duplicated as
// private helpers so this module stays import-free of the route layer.
function isCarrierTitle(title) {
  const t = lower(title);
  return t.includes("carrier") && t.includes("follow");
}
function isCustomerTitle(title) {
  const t = lower(title);
  return t.includes("customer") && t.includes("follow") && !t.includes("carrier");
}

export function segmentForTitle(title) {
  if (isRedeliveryTitle(title)) return "redelivery";
  if (isReturnClaimTitle(title)) return "return_claim";
  if (isCarrierTitle(title)) return "carrier";
  if (isCustomerTitle(title)) return "customer";
  return "other";
}

// "(attempt 3)" suffix → 3. Missing suffix → 1 for redelivery tasks (the
// first pair has no suffix), null for everything else.
export function attemptFor(title, segment) {
  const m = typeof title === "string" ? title.match(ATTEMPT_RE) : null;
  if (m) return Number(m[1]);
  return segment === "redelivery" ? 1 : null;
}

function daysBetween(fromIso, nowMs) {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

function isActive(status) {
  return status === "open" || status === "in_progress" || status === "blocked";
}

// Classify one task. `shipment` may be null (orphan task). `activeOnShipment`
// is the count of active tasks on the same shipment INCLUDING this one; the
// board computes it once per shipment and passes it in.
export function classifyTask(task, shipment, { now = Date.now(), staleDays = 7, agingDays = 5, activeOnShipment = 1 } = {}) {
  const segment = segmentForTitle(task?.title);
  const attempt = attemptFor(task?.title, segment);
  const ageDays = daysBetween(task?.created_at, now);
  const daysSinceScrape = shipment ? daysBetween(shipment.scraped_at, now) : null;
  const flags = [];

  const delivered = !!(shipment?.delivery_date);
  const archived = !!(shipment?.archived_at);
  const ar = String(shipment?.action_required || "").toUpperCase();
  const aiSaysNo = ar === "NO" || ar === "RESOLVED";
  if (shipment && (delivered || archived || aiSaysNo)) flags.push("resolved_upstream");

  // No scrape stamp at all counts as stale — we have no idea how old the
  // carrier data is.
  if (shipment && (daysSinceScrape === null || daysSinceScrape >= staleDays)) flags.push("stale");
  if (activeOnShipment > 1 && isActive(task?.status)) flags.push("duplicate");
  if (attempt !== null && attempt > 1) flags.push("repeat");
  if (isActive(task?.status) && ageDays !== null && ageDays >= agingDays) flags.push("aging");
  if (!String(task?.assigned_to || "").trim()) flags.push("unassigned");
  if (task?.status === "blocked") flags.push("blocked");

  return {
    segment,
    attempt,
    flags,
    age_days: ageDays,
    days_since_scrape: daysSinceScrape,
    // One-line reason for the most important health flag, for the board
    // and for the triage prompt. Priority: resolved > repeat > stale >
    // duplicate > blocked > aging > unassigned.
    health: healthLine({ delivered, archived, aiSaysNo, attempt, daysSinceScrape, staleDays, activeOnShipment, status: task?.status, ageDays }),
  };
}

function healthLine({ delivered, archived, aiSaysNo, attempt, daysSinceScrape, staleDays, activeOnShipment, status, ageDays }) {
  if (delivered) return "Shipment has a delivery date";
  if (archived) return "Shipment is archived";
  if (aiSaysNo) return "AI no longer flags this shipment";
  if (attempt !== null && attempt > 1) return `Failed attempt #${attempt}`;
  if (daysSinceScrape === null) return "Never scraped";
  if (daysSinceScrape >= staleDays) return `Last scraped ${daysSinceScrape}d ago`;
  if (activeOnShipment > 1) return `${activeOnShipment} active tasks on this shipment`;
  if (status === "blocked") return "Blocked";
  if (ageDays !== null && ageDays >= 5) return `Open ${ageDays}d`;
  return null;
}

// Build the board: one row per task with its shipment + classification, and
// a summary block with counts the rail and KPI strip read directly.
export function buildBoard(tasks, shipmentsById, opts = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const byId = shipmentsById instanceof Map ? shipmentsById : new Map(Object.entries(shipmentsById || {}));

  const activeCount = new Map();
  for (const t of list) {
    if (!t?.shipment_id || !isActive(t.status)) continue;
    activeCount.set(t.shipment_id, (activeCount.get(t.shipment_id) || 0) + 1);
  }

  const rows = list.map((task) => {
    const shipment = task?.shipment_id ? byId.get(task.shipment_id) || null : null;
    const seg = classifyTask(task, shipment, { ...opts, activeOnShipment: activeCount.get(task?.shipment_id) || 1 });
    return { task, shipment: slimShipment(shipment), seg };
  });

  const summary = {
    total: rows.length,
    active: rows.filter((r) => isActive(r.task.status)).length,
    by_status: countBy(rows, (r) => r.task.status || "unknown"),
    by_segment: countBy(rows, (r) => r.seg.segment),
    by_flag: countFlags(rows),
    by_assignee: countBy(rows, (r) => (r.task.assigned_to || "").trim() || "(unassigned)"),
    by_carrier: countBy(rows, (r) => (r.shipment?.carrier_name || r.shipment?.carrier || "").trim() || "(unknown)"),
    by_customer: countBy(rows, (r) => (r.shipment?.customer_name || "").trim() || "(unknown)"),
    // "Needs attention" = the segments FPX Directory asked to be worked
    // explicitly plus repeat failures, minus anything already moot.
    needs_attention: rows.filter((r) =>
      isActive(r.task.status)
      && !r.seg.flags.includes("resolved_upstream")
      && (r.seg.segment === "redelivery" || r.seg.segment === "return_claim" || r.seg.flags.includes("repeat")),
    ).length,
  };
  return { rows, summary };
}

// The board only needs a slice of the shipment; keep the payload small.
function slimShipment(s) {
  if (!s) return null;
  return {
    id: s.id,
    tracking_number: s.tracking_number ?? null,
    shipment_id: s.shipment_id ?? null,
    customer_name: s.customer_name ?? null,
    carrier: s.carrier ?? null,
    carrier_name: s.carrier_name ?? null,
    mode: s.mode ?? null,
    shipment_status: s.shipment_status ?? null,
    updated_eta: s.updated_eta ?? null,
    delivery_date: s.delivery_date ?? null,
    scraped_at: s.scraped_at ?? null,
    last_modified_at: s.last_modified_at ?? null,
    archived_at: s.archived_at ?? null,
    action_required: s.action_required ?? null,
    action_target: s.action_target ?? null,
    action_confidence: s.action_confidence ?? null,
    ai_issue: s.ai_issue ?? null,
    ai_recommendation: s.ai_recommendation ?? null,
    tracking_comments: s.tracking_comments ?? null,
    origin: s.origin ?? s.ship_from ?? null,
    destination: s.destination ?? s.ship_to ?? null,
  };
}

function countBy(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function countFlags(rows) {
  const out = {};
  for (const f of TASK_FLAGS) out[f.id] = 0;
  for (const r of rows) for (const f of r.seg.flags) out[f] = (out[f] || 0) + 1;
  return out;
}
