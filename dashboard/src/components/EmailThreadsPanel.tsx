import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Mail, RefreshCw } from "lucide-react";
import { useAuth } from "../lib/auth";
import { ThreadView } from "./mailbox/ThreadView";
import { ThreadSidebar } from "./mailbox/ThreadSidebar";
import {
  getThreadsForShipment,
  getThreadsForTask,
  mailboxShipmentHref,
  mailboxThreadHref,
  MailboxLinksForbiddenError,
  MailboxLinksUnavailableError,
  type LinkedThread,
} from "../lib/mailboxLinks";

// Support Mailbox threads linked to a shipment (or to a task's shipment).
// Loads on mount, so render it only when its section is open.

const PARTY_STYLE: Record<string, string> = {
  customer: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  carrier: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  internal: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
  other: "bg-slate-50 text-slate-500 ring-1 ring-slate-300",
  unknown: "bg-white text-slate-400 border border-dashed border-slate-300",
};

const PARTY_LABEL: Record<string, string> = {
  customer: "Customer",
  carrier: "Carrier",
  internal: "Internal",
  other: "Other",
  unknown: "Unknown",
};

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

function StatusPill({ status }: { status: string }) {
  if (status === "awaiting_reply") {
    return <span className="text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-amber-50 text-amber-700 ring-1 ring-amber-200">Awaiting reply</span>;
  }
  if (status === "responded") {
    return <span className="text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Responded</span>;
  }
  return <span className="text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-slate-50 text-slate-500 ring-1 ring-slate-200">Sent</span>;
}

// `inline`: clicking a thread opens it right here (messages + the same Details
// sidebar as the Support Mailbox) instead of going to /mailbox.
export function EmailThreadsPanel({ shipmentId, taskId, compact = false, inline = false }: { shipmentId?: string | null; taskId?: string | null; compact?: boolean; inline?: boolean }) {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const access = (profile as { mailbox_access?: string } | null)?.mailbox_access;
  const canDraft = isAdmin || !access || access === "draft";
  const [open, setOpen] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [threads, setThreads] = useState<LinkedThread[] | null>(null);
  const [resolvedShipmentId, setResolvedShipmentId] = useState<string | null>(shipmentId || null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!shipmentId && !taskId) { setThreads([]); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let mounted = true;
    setLoading(true); setError(null); setUnavailable(false); setForbidden(false);
    const p = shipmentId
      ? getThreadsForShipment(shipmentId, ctrl.signal).then((r) => ({ shipment_id: shipmentId, threads: r.threads }))
      : getThreadsForTask(taskId as string, ctrl.signal);
    p.then((r) => {
      if (!mounted) return;
      setThreads(Array.isArray(r.threads) ? r.threads : []);
      setResolvedShipmentId(r.shipment_id || shipmentId || null);
    })
      .catch((e: unknown) => {
        if (!mounted) return;
        if (e instanceof MailboxLinksUnavailableError) { setUnavailable(true); setThreads([]); return; }
        if (e instanceof MailboxLinksForbiddenError) { setForbidden(true); setThreads([]); return; }
        if (e instanceof DOMException && e.name === "AbortError") { setError("The server took too long to answer. Try again."); return; }
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { clearTimeout(timer); if (mounted) setLoading(false); });
    return () => { mounted = false; clearTimeout(timer); ctrl.abort(); };
  }, [shipmentId, taskId, reloadKey]);

  const pad = compact ? "px-2 py-1.5" : "px-3 py-2";

  let body: ReactNode;
  if (forbidden) {
    body = <p className="text-sm text-slate-500">You don't have access to the Support Mailbox.</p>;
  } else if (unavailable) {
    body = <p className="text-sm text-slate-500">Emails will appear here once the mailbox update is live.</p>;
  } else if (error) {
    body = (
      <div className="text-sm text-rose-700 flex items-center gap-2">
        <span>{error}</span>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 underline">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  } else if (threads === null || (loading && threads.length === 0)) {
    body = <p className="text-sm text-slate-400">Loading emails…</p>;
  } else if (threads.length === 0) {
    body = <p className="text-sm text-slate-500">No emails linked yet.</p>;
  } else {
    body = (
      <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200 bg-white">
        {threads.map((t) => {
          const party = String(t.party || "unknown");
          return (
            <li key={t.conversation_id}>
              <Link to={mailboxThreadHref(t.conversation_id)} className={`block ${pad} hover:bg-slate-50`}
                onClick={inline ? (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); setOpen(t.conversation_id); } : undefined}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 ${PARTY_STYLE[party] || PARTY_STYLE.unknown}`}>
                    {PARTY_LABEL[party] || party}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-sm font-medium text-slate-800">{t.subject || "(no subject)"}</span>
                  <span className="shrink-0 text-[11px] text-slate-400" title={t.last_message_at ? new Date(t.last_message_at).toLocaleString() : undefined}>
                    {relTime(t.last_message_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500 min-w-0">
                  <StatusPill status={String(t.status)} />
                  {t.last_from_name ? <span className="truncate">{t.last_from_name}</span> : null}
                  {t.message_count ? <span className="shrink-0 text-slate-400">{t.message_count} message{t.message_count === 1 ? "" : "s"}</span> : null}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  if (inline && open && !forbidden) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setOpen(null)} className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900">
            <ArrowLeft className="h-3.5 w-3.5" /> All emails for this shipment
          </button>
          <Link to={mailboxThreadHref(open)} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-900">
            <Mail className="h-3.5 w-3.5" /> Open in Support Mailbox
          </Link>
        </div>
        {/* Side by side when the drawer is wide enough, stacked otherwise. */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 basis-[420px] min-w-0 rounded-lg ring-1 ring-slate-200 bg-white overflow-hidden">
            <ThreadView key={open} conversationId={open} mailbox={null} onBack={() => setOpen(null)}
              canDraft={canDraft} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
          </div>
          {sidebarOpen ? (
            <aside aria-label="Conversation details" className="grow basis-72 max-w-full sm:max-w-[340px] rounded-lg ring-1 ring-slate-200 bg-slate-50">
              <ThreadSidebar key={open} conversationId={open} readOnly={!canDraft}
                onOpenThread={(c) => setOpen(c)} onClose={() => setSidebarOpen(false)} />
            </aside>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {body}
      {resolvedShipmentId && !unavailable && !forbidden ? (
        <Link to={mailboxShipmentHref(resolvedShipmentId)} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-900">
          <Mail className="h-3.5 w-3.5" /> See all in Support Mailbox
        </Link>
      ) : null}
    </div>
  );
}

export default EmailThreadsPanel;
