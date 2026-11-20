import { useEffect, useRef } from "react";
import type { Thread } from "../../lib/mailboxApi";
import { fmtRelative } from "../../lib/format";
import { Package } from "lucide-react";
import { PartyTag, ThreadStatusBadge, waitingFor } from "./shared";

const MAX_CHIPS = 3;

interface Props {
  threads: Thread[];
  selected: string | null;
  onSelect: (conversationId: string) => void;
  /** Called after the pointer rests on a row for 150ms (to prefetch it). */
  onHover?: (conversationId: string) => void;
}

const HOVER_MS = 150;

/** Grey placeholder rows while the first list loads. */
export function ThreadListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-slate-100 animate-pulse" aria-label="Loading conversations">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="px-3 py-3 space-y-2">
          <div className="flex gap-2"><div className="h-3 w-32 rounded bg-slate-200" /><div className="ml-auto h-3 w-10 rounded bg-slate-100" /></div>
          <div className="h-3 w-3/4 rounded bg-slate-200" />
          <div className="h-2.5 w-full rounded bg-slate-100" />
          <div className="h-4 w-24 rounded-full bg-slate-100" />
        </li>
      ))}
    </ul>
  );
}

export function ThreadList({ threads, selected, onSelect, onHover }: Props) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHover = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => cancelHover, []);
  const startHover = (id: string) => {
    if (!onHover) return;
    cancelHover();
    timer.current = setTimeout(() => onHover(id), HOVER_MS);
  };
  if (!threads.length) {
    return <div className="p-8 text-center text-sm text-slate-500">No conversations here.</div>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {threads.map((t) => {
        const active = t.conversation_id === selected;
        const wait = t.status === "awaiting_reply" ? waitingFor(t.last_inbound_at) : null;
        const shipments = (t.linked_shipment_ids || []).filter(Boolean);
        return (
          <li key={t.conversation_id}>
            <button
              type="button"
              onClick={() => onSelect(t.conversation_id)}
              onPointerEnter={() => startHover(t.conversation_id)}
              onPointerLeave={cancelHover}
              onFocus={() => startHover(t.conversation_id)}
              aria-current={active ? "true" : undefined}
              className={
                "w-full text-left px-3 py-2.5 flex flex-col gap-1 border-l-2 transition " +
                (active ? "bg-violet-50 border-violet-600" : "border-transparent hover:bg-slate-50")
              }
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className={"truncate text-sm " + (t.status === "awaiting_reply" ? "font-semibold text-slate-900" : "font-medium text-slate-700")}>
                  {t.last_from_name || t.last_from_address || "Unknown sender"}
                </span>
                {t.message_count > 1 ? (
                  <span className="shrink-0 text-[10px] font-semibold rounded-full px-1.5 py-0.5 bg-slate-100 text-slate-600" title={`${t.message_count} messages`}>{t.message_count}</span>
                ) : null}
                <span className="ml-auto shrink-0 text-[11px] text-slate-500" title={t.last_message_at || ""}>{fmtRelative(t.last_message_at)}</span>
              </div>
              <div className="truncate text-sm text-slate-800">{t.subject || "(no subject)"}</div>
              <div className="truncate text-xs text-slate-500">{t.preview || ""}</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <ThreadStatusBadge status={t.status} />
                {t.party !== undefined ? <PartyTag party={t.party} /> : null}
                {wait ? <span className="text-[11px] text-amber-700">waiting {wait}</span> : null}
              </div>
              {shipments.length ? (
                <div className="flex items-center gap-1 flex-wrap">
                  {shipments.slice(0, MAX_CHIPS).map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-sky-50 text-sky-800 ring-1 ring-sky-200">
                      <Package className="h-3 w-3" />Shipment {id}
                    </span>
                  ))}
                  {shipments.length > MAX_CHIPS ? (
                    <span className="text-[11px] text-slate-500">+{shipments.length - MAX_CHIPS} more</span>
                  ) : null}
                </div>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
