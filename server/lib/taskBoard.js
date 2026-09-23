// Loads the Tasks v2 board: active tasks joined to a slim shipment row and
// classified (lib/taskSegments.js). Shared by the /tasks/v2/* routes and the
// daily executive summary, which needs the same picture of the board.

import { supabase } from "./supabase.js";
import { getSettings } from "./settings.js";
import { buildBoard } from "./taskSegments.js";
import { peopleIndex, resolveWithIndex } from "./people.js";

export const BOARD_SHIPMENT_COLS = [
  "id", "tracking_number", "shipment_id", "customer_name", "carrier", "carrier_name", "mode",
  "shipment_status", "updated_eta", "delivery_date", "scraped_at", "last_modified_at", "archived_at",
  "action_required", "action_target", "action_confidence", "ai_issue", "ai_recommendation",
  "tracking_comments", "origin", "destination", "ship_from", "ship_to",
].join(", ");

export const ACTIVE_TASK_STATUSES = ["open", "in_progress", "blocked"];

// `includeClosed` adds done/cancelled tasks from the last `closedDays` so the
// board can show what was just cleared (and triage can see a shipment already
// had a worked task).
export async function loadBoard({ includeClosed = false, closedDays = 7, staleDays } = {}) {
  let q = supabase.from("fpx_shipment_tasks").select("*").is("archived_at", null)
    .order("created_at", { ascending: false }).limit(2000);
  if (includeClosed) {
    const since = new Date(Date.now() - closedDays * 86400000).toISOString();
    q = q.or(`status.in.(${ACTIVE_TASK_STATUSES.join(",")}),and(status.in.(done,cancelled),updated_at.gte.${since})`);
  } else {
    q = q.in("status", ACTIVE_TASK_STATUSES);
  }
  const { data: tasks, error } = await q;
  if (error) throw new Error(error.message);

  // Canonicalise owners onto the profile email so "Victor Zarate" and
  // "victorz@freightpop.com" are one bucket. The raw value is kept on
  // assigned_to_raw for the audit-minded; `people` maps email → name for
  // display.
  const idx = await peopleIndex();
  const normalized = (tasks || []).map((t) => ({
    ...t,
    assigned_to_raw: t.assigned_to,
    assigned_to: resolveWithIndex(idx, t.assigned_to),
  }));

  const shipIds = Array.from(new Set(normalized.map((t) => t.shipment_id).filter(Boolean)));
  const byId = await loadShipmentsById(shipIds);

  let stale = staleDays;
  if (!Number.isFinite(stale)) {
    const s = await getSettings("ui.tasks.stale_days");
    stale = Number(s["ui.tasks.stale_days"]) || 7;
  }
  const board = buildBoard(normalized, byId, { staleDays: stale });
  return { ...board, stale_days: stale, people: Object.fromEntries(idx.names) };
}

// Chunked .in() so the widest boards stay under URL-length limits.
export async function loadShipmentsById(ids) {
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const { data: ships, error } = await supabase
      .from("fpx_shipments").select(BOARD_SHIPMENT_COLS).in("id", chunk);
    if (error) throw new Error(error.message);
    for (const s of ships || []) byId.set(s.id, s);
  }
  return byId;
}
