import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity, AlertCircle, CheckCircle2, ListPlus, Mail, RefreshCw, StickyNote, Truck,
} from "lucide-react";
import { getShipperTimeline, type TimelineEvent } from "../../lib/shippersApi";
import { useCached } from "../../lib/useCached";
import { fmtRelative } from "../../lib/format";
import { getTasksView } from "../../lib/tasksView";

// Vertical activity feed for one shipper: notes, tasks created / done,
// linked emails and status changes, grouped by day. Each event links to
// where it lives (shipment drawer, task walk, Support Mailbox thread).

const COMPACT_LIMIT = 10;
const FULL_LIMIT = 100;
const MAX_LIMIT = 200;

type Kind = TimelineEvent["kind"];

const KIND_META: Record<Kind, { label: string; icon: typeof Activity; tone: string }> = {
  note: { label: "Note", icon: StickyNote, tone: "bg-amber-100 text-amber-700 ring-amber-200" },
  task_created: { label: "Task created", icon: ListPlus, tone: "bg-sky-100 text-sky-700 ring-sky-200" },
  task_done: { label: "Task done", icon: CheckCircle2, tone: "bg-emerald-100 text-emerald-700 ring-emerald-200" },
  email: { label: "Email", icon: Mail, tone: "bg-violet-100 text-violet-700 ring-violet-200" },
  status: { label: "Status", icon: Truck, tone: "bg-slate-100 text-slate-700 ring-slate-200" },
};

const metaOf = (k: string) => KIND_META[k as Kind] ?? { label: k, icon: Activity, tone: "bg-slate-100 text-slate-700 ring-slate-200" };

const EMAIL_STATUS: Record<string, string> = {
  awaiting_reply: "Awaiting reply",
  responded: "Responded",
  outbound_only: "Outbound only",
};

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return "Today";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeOf(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function taskHref(id: string): string {
  return getTasksView() === "legacy" ? `/tasks/${encodeURIComponent(id)}` : `/tasks/v2/${encodeURIComponent(id)}`;
}

/** Where clicking the event goes, or null when it has no target of its own. */
function eventHref(e: TimelineEvent): string | null {
  if (e.kind === "email" && e.ref_id) return `/mailbox?c=${encodeURIComponent(e.ref_id)}`;
  if ((e.kind === "task_created" || e.kind === "task_done") && e.ref_id) return taskHref(e.ref_id);
  const sid = e.shipment_id || e.tracking_number;
  if (sid) return `/tracking/${encodeURIComponent(sid)}`;
  return null;
}

interface Group { key: string; label: string; events: TimelineEvent[] }

function groupByDay(events: TimelineEvent[]): Group[] {
  const out: Group[] = [];
  for (const e of events) {
    const d = new Date(e.at);
    const valid = !isNaN(d.getTime());
    const key = valid ? dayKey(d) : "unknown";
    const last = out[out.length - 1];
    if (last && last.key === key) last.events.push(e);
    else out.push({ key, label: valid ? dayLabel(d) : "Undated", events: [e] });
  }
  return out;
}

export function ShipperTimeline({ shipperKey, compact = false }: { shipperKey: string; compact?: boolean }) {
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const [limit, setLimit] = useState(compact ? COMPACT_LIMIT : FULL_LIMIT);

  const { data, error, refreshing, refresh } = useCached(
    `shippers:${shipperKey}:timeline:${limit}`,
    (signal) => getShipperTimeline(shipperKey, { limit }, signal),
  );

  const events = useMemo(() => (data?.events ?? []).slice(0, limit), [data, limit]);
  const groups = useMemo(() => groupByDay(events), [events]);

  const seeAll = () => setParams((p) => {
    const n = new URLSearchParams(p);
    n.set("tab", "activity");
    return n;
  });

  const is404 = !!error && /not found|404|no shipments/i.test(error);

  return (
    <section className="bg-white rounded-xl ring-1 ring-slate-200 shadow-sm">
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Activity className="w-4 h-4 text-slate-500" /> Activity
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            title="Refresh"
            className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          {compact && (
            <button type="button" onClick={seeAll} className="text-xs font-medium text-sky-700 hover:underline">
              See all →
            </button>
          )}
        </div>
      </header>

      <div className="px-4 py-3">
        {error && !data ? (
          <div className="flex flex-col items-start gap-2 text-sm">
            <div className="flex items-center gap-2 text-rose-700">
              <AlertCircle className="w-4 h-4" />
              {is404 ? "No shipments found for this shipper." : `Could not load activity: ${error}`}
            </div>
            {!is404 && (
              <button
                type="button"
                onClick={refresh}
                className="px-2.5 py-1 rounded-md text-xs ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
              >Retry</button>
            )}
          </div>
        ) : !data ? (
          <ul className="space-y-3" aria-busy="true">
            {Array.from({ length: compact ? 4 : 6 }).map((_, i) => (
              <li key={i} className="flex gap-3 animate-pulse">
                <div className="w-7 h-7 rounded-full bg-slate-100" />
                <div className="flex-1 space-y-1.5 py-0.5">
                  <div className="h-3 w-2/3 rounded bg-slate-100" />
                  <div className="h-3 w-1/3 rounded bg-slate-100" />
                </div>
              </li>
            ))}
          </ul>
        ) : events.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No activity yet for this shipper.</p>
        ) : (
          <div className="space-y-4">
            {error && (
              <p className="text-xs text-amber-700">Showing the last loaded activity; refresh failed: {error}</p>
            )}
            {groups.map((g) => (
              <div key={g.key}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.label}</div>
                <ol className="relative ml-3.5 border-l border-slate-200">
                  {g.events.map((e, i) => (
                    <TimelineItem key={`${e.kind}:${e.ref_id ?? ""}:${e.at}:${i}`} e={e} onOpen={(h) => navigate(h)} />
                  ))}
                </ol>
              </div>
            ))}
            {!compact && data.events.length >= limit && limit < MAX_LIMIT && (
              <div className="pt-1 text-center">
                <button
                  type="button"
                  onClick={() => setLimit(MAX_LIMIT)}
                  className="px-3 py-1.5 rounded-lg text-xs ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                >Load more</button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function TimelineItem({ e, onOpen }: { e: TimelineEvent; onOpen: (href: string) => void }) {
  const meta = metaOf(e.kind);
  const Icon = meta.icon;
  const href = eventHref(e);
  const shipId = e.shipment_id || e.tracking_number;
  const detail = e.kind === "email" && e.detail ? (EMAIL_STATUS[e.detail] ?? e.detail) : e.detail;

  return (
    <li className="relative pl-6 pb-3 last:pb-0">
      <span className={`absolute -left-3.5 top-0 flex w-7 h-7 items-center justify-center rounded-full ring-2 ring-white ${meta.tone}`}>
        <Icon className="w-3.5 h-3.5" />
      </span>
      <div
        role={href ? "link" : undefined}
        tabIndex={href ? 0 : undefined}
        onClick={href ? () => onOpen(href) : undefined}
        onKeyDown={href ? (ev) => { if (ev.key === "Enter") onOpen(href); } : undefined}
        className={`rounded-lg px-2 py-1 -mx-2 ${href ? "cursor-pointer hover:bg-slate-50" : ""}`}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[11px] font-medium text-slate-500">{meta.label}</span>
          <span className="text-sm font-medium text-slate-800 break-words min-w-0">{e.title || "(untitled)"}</span>
        </div>
        {detail && (
          <p className="mt-0.5 text-xs text-slate-600 line-clamp-2 break-words">{detail}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
          {shipId && (
            <Link
              to={`/tracking/${encodeURIComponent(shipId)}`}
              onClick={(ev) => ev.stopPropagation()}
              className="px-1.5 py-0.5 rounded bg-slate-100 font-mono text-slate-700 hover:bg-slate-200"
              title="Open shipment"
            >{e.shipment_id || e.tracking_number}</Link>
          )}
          {e.actor && <span className="truncate max-w-[12rem]">{e.actor}</span>}
          <span title={new Date(e.at).toLocaleString()}>{timeOf(e.at)} · {fmtRelative(e.at)}</span>
        </div>
      </div>
    </li>
  );
}
