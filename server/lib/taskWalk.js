// Walk-context resolver for the GET /api/tasks/:id route. Given the
// focused task plus the ordered list of sibling tasks (the active /
// open / done / etc. set), produce the prev/next pointers the dashboard
// drawer's chevrons need.
//
// Extracted from routes/tasks.js so it's testable without spinning up
// supabase. The route still does the DB fetch — this module just
// answers "given a focused task and a list, what's the walk shape?".

// Returns a stable walk object even when the focused task isn't in the
// supplied list. The calling code may filter to "active" while the
// drawer is parked on a Done task; we still want prev/next to navigate
// the active set, with the focused task pinned as the entry point.
export function computeWalkContext(task, list, mode) {
  if (!task || typeof task !== "object" || !task.id) {
    return null;
  }
  const safeMode = typeof mode === "string" && mode ? mode : "active";
  const baseList = Array.isArray(list) ? list.filter((t) => t && typeof t === "object" && t.id) : [];
  const idx = baseList.findIndex((t) => t.id === task.id);
  // If the focused task fell out of the filtered scope (e.g. it's Done
  // while we're walking Active), prepend it so it's still index 0 and
  // prev/next point at the next active task.
  const list2 = idx >= 0 ? baseList : [task, ...baseList];
  const i = idx >= 0 ? idx : 0;
  const prev = i > 0 ? list2[i - 1] : null;
  const next = i < list2.length - 1 ? list2[i + 1] : null;
  return {
    mode: safeMode,
    index: i,
    total: list2.length,
    prev_id: prev?.id || null,
    next_id: next?.id || null,
    prev_shipment_id: prev?.shipment_id || null,
    next_shipment_id: next?.shipment_id || null,
    ids: list2.map((t) => t.id),
  };
}
