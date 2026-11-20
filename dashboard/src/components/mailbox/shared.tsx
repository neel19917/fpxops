import { useEffect } from "react";
import { CheckCircle2, Clock, Send, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Message, Recipient, ThreadFilter, ThreadStatus } from "../../lib/mailboxApi";

export const FILTERS: { id: ThreadFilter; label: string }[] = [
  { id: "awaiting_reply", label: "Awaiting reply" },
  { id: "responded", label: "Responded" },
  { id: "all", label: "All" },
  { id: "outbound_only", label: "Sent only" },
];

export function ThreadStatusBadge({ status }: { status: ThreadStatus }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 whitespace-nowrap";
  if (status === "awaiting_reply") return <span className={`${base} bg-amber-100 text-amber-800 ring-amber-200`}><Clock className="h-3 w-3" />Awaiting reply</span>;
  if (status === "responded") return <span className={`${base} bg-emerald-100 text-emerald-700 ring-emerald-200`}><CheckCircle2 className="h-3 w-3" />Responded</span>;
  return <span className={`${base} bg-slate-100 text-slate-600 ring-slate-200`}><Send className="h-3 w-3" />Sent only</span>;
}

/** "3 hours", "2 days" since the iso time. */
export function waitingFor(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const hours = Math.max(0, Math.floor(ms / 3_600_000));
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function messageTime(m: Message): string | null {
  return m.direction === "out" ? (m.sent_at || m.received_at) : (m.received_at || m.sent_at);
}

function recipientText(r: Recipient): string {
  const name = r.emailAddress?.name ?? r.name ?? "";
  const addr = r.emailAddress?.address ?? r.address ?? "";
  if (name && addr && name !== addr) return `${name} <${addr}>`;
  return name || addr;
}

export function recipientsText(list: Recipient[] | null | undefined): string {
  if (!Array.isArray(list)) return "";
  return list.map(recipientText).filter(Boolean).join(", ");
}

export function Toast({ children, onClose, tone = "success" }: { children: ReactNode; onClose: () => void; tone?: "success" | "error" }) {
  useEffect(() => {
    const t = setTimeout(onClose, 15_000);
    return () => clearTimeout(t);
  }, [onClose]);
  const cls = tone === "success" ? "bg-emerald-50 ring-emerald-200 text-emerald-900" : "bg-rose-50 ring-rose-200 text-rose-900";
  return (
    <div role="status" className={`fixed bottom-4 right-4 left-4 sm:left-auto z-50 sm:max-w-md rounded-lg ring-1 shadow-lg px-4 py-3 text-sm flex items-start gap-3 ${cls}`}>
      <div className="min-w-0 flex-1">{children}</div>
      <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 opacity-60 hover:opacity-100"><X className="h-4 w-4" /></button>
    </div>
  );
}
