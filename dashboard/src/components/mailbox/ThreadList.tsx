import type { Thread } from "../../lib/mailboxApi";
import { fmtRelative } from "../../lib/format";
import { ThreadStatusBadge, waitingFor } from "./shared";

interface Props {
  threads: Thread[];
  selected: string | null;
  onSelect: (conversationId: string) => void;
}

export function ThreadList({ threads, selected, onSelect }: Props) {
  if (!threads.length) {
    return <div className="p-8 text-center text-sm text-slate-500">No conversations here.</div>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {threads.map((t) => {
        const active = t.conversation_id === selected;
        const wait = t.status === "awaiting_reply" ? waitingFor(t.last_inbound_at) : null;
        return (
          <li key={t.conversation_id}>
            <button
              type="button"
              onClick={() => onSelect(t.conversation_id)}
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
              <div className="flex items-center gap-2 flex-wrap">
                <ThreadStatusBadge status={t.status} />
                {wait ? <span className="text-[11px] text-amber-700">waiting {wait}</span> : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
