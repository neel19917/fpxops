import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, ListTodo, RefreshCw } from "lucide-react";
import { getShipperTasks, type ShipperTask } from "../../lib/shippersApi";
import { fmtDate, fmtDateTime, fmtRelative } from "../../lib/format";

// Tasks on one shipper's shipments. Open / Done / All toggle, count badges,
// and a list that opens each task in the live task walk (/tasks/v2/:taskId,
// the route the default Tasks v2 board uses). compact = first 8 rows plus a
// "See all" button that switches the detail page to ?tab=tasks.

type TaskFilter = "open" | "done" | "all";

interface Counts {
  open: number;
  in_progress: number;
  blocked: number;
  overdue: number;
  done_30d: number;
}

const COMPACT_ROWS = 8;

const STATUS_STYLE: Record<string, string> = {
  open: "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
  in_progress: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200",
  blocked: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
  done: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  cancelled: "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
};

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const PRIORITY_STYLE: Record<string, string> = {
  urgent: "text-rose-700 font-semibold",
  high: "text-amber-700 font-medium",
  normal: "text-slate-500",
  low: "text-slate-400",
};

function StatusPill({ status }: { status: string }) {
  const cls = STATUS_STYLE[status] || "bg-slate-50 text-slate-500 ring-1 ring-slate-200";
  return (
    <span className={`shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 ${cls}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function CountBadge({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${value > 0 ? tone : "bg-slate-50 text-slate-400 ring-1 ring-slate-200"}`}>
      <span className="font-semibold tabular-nums">{value}</span> {label}
    </span>
  );
}

function assigneeLabel(a: string | null): string {
  if (!a) return "";
  const s = a.trim();
  return s.includes("@") ? s.split("@")[0] : s;
}

export function ShipperTasks({ shipperKey, compact = false }: { shipperKey: string; compact?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [tasks, setTasks] = useState<ShipperTask[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    getShipperTasks(shipperKey, { status: filter, limit: compact ? COMPACT_ROWS + 1 : 200 }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setTasks(res.tasks || []);
        setCounts(res.counts || null);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        const status = (e as { status?: number })?.status;
        setError(status === 404 ? "No shipments found for this shipper." : (e instanceof Error ? e.message : String(e)) || "Could not load tasks.");
        setTasks(null);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [shipperKey, filter, compact, reloadTick]);

  const retry = useCallback(() => setReloadTick((n) => n + 1), []);

  const visible = tasks ? (compact ? tasks.slice(0, COMPACT_ROWS) : tasks) : [];
  const hasMore = compact && ((tasks?.length || 0) > COMPACT_ROWS || (filter === "open" && counts != null && counts.open > COMPACT_ROWS));

  const openTask = (id: string) => {
    const walkIds = visible.filter((t) => t.status !== "done" && t.status !== "cancelled").map((t) => t.id);
    navigate(`/tasks/v2/${id}`, {
      state: { from: `${location.pathname}${location.search}`, walkIds: walkIds.includes(id) ? walkIds : [id] },
    });
  };

  const seeAll = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", "tasks");
      return next;
    });
  };

  const openShipment = (t: ShipperTask) => {
    const id = t.shipment_id || t.tracking_number;
    if (id) navigate(`/tracking/${encodeURIComponent(id)}`);
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
        <ListTodo className="h-4 w-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">Tasks</h3>
        <div className="ml-auto inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs">
          {(["open", "done", "all"] as TaskFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 capitalize ${filter === f ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-800"}`}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      {counts && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2">
          <CountBadge label="open" value={counts.open} tone="bg-sky-50 text-sky-700 ring-1 ring-sky-200" />
          <CountBadge label="in progress" value={counts.in_progress} tone="bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" />
          <CountBadge label="blocked" value={counts.blocked} tone="bg-rose-50 text-rose-700 ring-1 ring-rose-200" />
          <CountBadge label="overdue" value={counts.overdue} tone="bg-red-50 text-red-700 ring-1 ring-red-200" />
          {!compact && <CountBadge label="done (30d)" value={counts.done_30d} tone="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" />}
        </div>
      )}

      <div className="p-2">
        {loading && !tasks ? (
          <ul className="space-y-1.5">
            {Array.from({ length: compact ? 4 : 6 }).map((_, i) => (
              <li key={i} className="h-11 animate-pulse rounded-md bg-slate-100" />
            ))}
          </ul>
        ) : error ? (
          <div className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{error}</span>
            <button type="button" onClick={retry} className="inline-flex items-center gap-1 rounded border border-rose-200 bg-white px-2 py-0.5 text-xs hover:bg-rose-100">
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center text-sm text-slate-500">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            {filter === "open" ? "No open tasks for this shipper." : filter === "done" ? "No completed tasks yet." : "No tasks for this shipper."}
          </div>
        ) : (
          <ul className={`divide-y divide-slate-100 ${loading ? "opacity-60" : ""}`}>
            {visible.map((t) => {
              const who = assigneeLabel(t.assigned_to);
              const prio = (t.priority || "").toLowerCase();
              const doneOrCancelled = t.status === "done" || t.status === "cancelled";
              return (
                <li key={t.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openTask(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openTask(t.id);
                      }
                    }}
                    className="flex cursor-pointer flex-col gap-1 rounded-md px-2 py-2 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                  >
                    <div className="flex items-start gap-2">
                      <span className={`min-w-0 flex-1 text-sm ${doneOrCancelled ? "text-slate-500 line-through decoration-slate-300" : "text-slate-800"}`} title={t.title}>
                        <span className="line-clamp-2">{t.title || "(untitled task)"}</span>
                      </span>
                      <StatusPill status={t.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                      {prio && <span className={`capitalize ${PRIORITY_STYLE[prio] || "text-slate-500"}`}>{prio}</span>}
                      <span title={t.assigned_to || undefined}>{who || <span className="italic text-slate-400">unassigned</span>}</span>
                      {doneOrCancelled && t.completed_at ? (
                        <span title={fmtDateTime(t.completed_at)}>Done {fmtRelative(t.completed_at)}</span>
                      ) : t.due_at ? (
                        <span className={t.overdue ? "font-medium text-red-600" : ""} title={fmtDateTime(t.due_at)}>
                          {t.overdue ? "Overdue · " : "Due "}{fmtDate(t.due_at)}
                        </span>
                      ) : null}
                      {(t.shipment_id || t.tracking_number) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openShipment(t);
                          }}
                          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 hover:bg-slate-200 hover:text-slate-900"
                          title="Open shipment"
                        >
                          {t.shipment_id || t.tracking_number}
                        </button>
                      )}
                      <span className="ml-auto text-slate-400" title={fmtDateTime(t.created_at)}>{fmtRelative(t.created_at)}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {compact && hasMore && !error && (
          <div className="flex justify-end px-2 pt-1">
            <button type="button" onClick={seeAll} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-900">
              See all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
