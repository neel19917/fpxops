// Which Tasks page /tasks opens: the v2 board (default) or the legacy
// list. Per-browser preference; the toggle buttons on both pages set it.
// URLs stay explicit too: /tasks/v2 and /tasks/legacy always render that
// view regardless of the preference.
export type TasksView = "v2" | "legacy";

const KEY = "fpx.tasks.view";

export function getTasksView(): TasksView {
  try { return localStorage.getItem(KEY) === "legacy" ? "legacy" : "v2"; } catch { return "v2"; }
}

export function setTasksView(v: TasksView) {
  try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
}
