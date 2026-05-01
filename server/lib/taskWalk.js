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
// the active set without resetting the operator's position.
//
// When the focused task is missing from the list (e.g. user just marked
// it Done while walking Active), we splice it back in at the slot it
// would have occupied if its status hadn't changed — using created_at
// against the sorted list. That keeps "next" pointing at the *next*
// task the operator was about to walk to, instead of jumping to index 0
// (which felt like "going back to the start" — the previous behavior).
export function computeWalkContext(task, list, mode) {
  if (!task || typeof task !== "object" || !task.id) {
    return null;
  }
  const safeMode = typeof mode === "string" && mode ? mode : "active";
  const baseList = Array.isArray(list) ? list.filter((t) => t && typeof t === "object" && t.id) : [];
  const idx = baseList.findIndex((t) => t.id === task.id);
  let list2;
  let i;
  if (idx >= 0) {
    list2 = baseList;
    i = idx;
  } else {
    // Focused task fell out of filtered scope. Splice it into the slot
    // its created_at would have occupied so prev/next preserve the
    // operator's walking direction. The route sorts the list
    // `created_at DESC`, so we look for the first list item with
    // created_at strictly less than the focused task's — that's our
    // insertion index. If created_at is missing on either side we fall
    // back to prepending (matches the previous behavior).
    const focusedAt = task.created_at ? Date.parse(task.created_at) : NaN;
    let insertAt = 0;
    if (Number.isFinite(focusedAt)) {
      const found = baseList.findIndex((t) => {
        const at = t.created_at ? Date.parse(t.created_at) : NaN;
        return Number.isFinite(at) && at < focusedAt;
      });
      insertAt = found === -1 ? baseList.length : found;
    }
    list2 = [...baseList.slice(0, insertAt), task, ...baseList.slice(insertAt)];
    i = insertAt;
  }
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
