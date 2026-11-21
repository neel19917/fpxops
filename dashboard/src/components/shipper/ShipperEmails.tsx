import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Mail, RefreshCw } from "lucide-react";
import { ThreadView } from "../mailbox/ThreadView";
import { ThreadSidebar } from "../mailbox/ThreadSidebar";
import { mailboxThreadHref } from "../../lib/mailboxLinks";
import { getShipperEmails, ShipperEmailForbiddenError, type ShipperThread } from "../../lib/shippersApi";

// Support Mailbox threads linked to any of a shipper's shipments. Clicking a
// thread opens it in place (reader + the Support Mailbox Details sidebar),
// same pattern as EmailThreadsPanel. The open thread lives in ?thread= so the
// compact card on Overview can hand off to the full Emails tab.

type StatusFilter = "all" | "awaiting_reply" | "responded";
type RangeFilter = 7 | 30 | 90 | "all";
type Counts = { all: number; awaiting_reply: number; responded: number };

const COMPACT_LIMIT = 8;

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

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "awaiting_reply", label: "Awaiting reply" },
  { value: "responded", label: "Responded" },
];

const RANGE_OPTIONS: { value: RangeFilter; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: "all", label: "All time" },
];

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
    return <span className="shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-amber-50 text-amber-700 ring-1 ring-amber-200">Awaiting reply</span>;
  }
  if (status === "responded") {
    return <span className="shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Responded</span>;
  }
  return <span className="shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-slate-50 text-slate-500 ring-1 ring-slate-200">Sent</span>;
}

function isPlainClick(e: React.MouseEvent) {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}

export function ShipperEmails({ shipperKey, compact = false, canDraft }: { shipperKey: string; compact?: boolean; canDraft: boolean }) {
  const [params, setParams] = useSearchParams();
  const openThread = compact ? null : params.get("thread");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [days, setDays] = useState<RangeFilter>(90);
  const [threads, setThreads] = useState<ShipperThread[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const effStatus: StatusFilter = compact ? "all" : status;
  const effDays: RangeFilter = compact ? 90 : days;

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let mounted = true;
    setLoading(true); setError(null); setForbidden(false);
    getShipperEmails(shipperKey, { status: effStatus, days: effDays, limit: compact ? COMPACT_LIMIT : 200 }, ctrl.signal)
      .then((r) => {
        if (!mounted) return;
        setThreads(Array.isArray(r.threads) ? r.threads : []);
        setCounts(r.counts ?? null);
      })
      .catch((e: unknown) => {
        if (!mounted) return;
        if (e instanceof ShipperEmailForbiddenError) { setForbidden(true); setThreads([]); return; }
        if (e instanceof DOMException && e.name === "AbortError") { setError("The server took too long to answer. Try again."); return; }
        const status = (e as { status?: number } | null)?.status;
        if (status === 404) { setError("This shipper has no shipments."); return; }
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { clearTimeout(timer); if (mounted) setLoading(false); });
    return () => { mounted = false; clearTimeout(timer); ctrl.abort(); };
  }, [shipperKey, effStatus, effDays, compact, reloadKey]);

  const setThreadParam = (conversationId: string | null, switchTab = false) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (switchTab) next.set("tab", "emails");
      if (conversationId) next.set("thread", conversationId);
      else next.delete("thread");
      return next;
    });
  };

  const seeAll = () => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set("tab", "emails");
    next.delete("thread");
    return next;
  });

  if (forbidden) {
    return <p className="text-sm text-slate-500">You don't have access to the Support Mailbox.</p>;
  }

  // Thread open in place: reader + Details sidebar side by side, stacked when narrow.
  if (openThread) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setThreadParam(null)} className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900">
            <ArrowLeft className="h-3.5 w-3.5" /> All emails for this shipper
          </button>
          <Link to={mailboxThreadHref(openThread)} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-900">
            <Mail className="h-3.5 w-3.5" /> Open in Support Mailbox
          </Link>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 basis-[420px] min-w-0 rounded-lg ring-1 ring-slate-200 bg-white overflow-hidden">
            <ThreadView key={openThread} conversationId={openThread} mailbox={null} onBack={() => setThreadParam(null)}
              canDraft={canDraft} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
          </div>
          {sidebarOpen ? (
            <aside aria-label="Conversation details" className="grow basis-72 max-w-full sm:max-w-[340px] rounded-lg ring-1 ring-slate-200 bg-slate-50">
              <ThreadSidebar key={openThread} conversationId={openThread} readOnly={!canDraft}
                onOpenThread={(c) => setThreadParam(c)} onClose={() => setSidebarOpen(false)} />
            </aside>
          ) : null}
        </div>
      </div>
    );
  }

  const pad = compact ? "px-2.5 py-2" : "px-3 py-2.5";
  const shown = threads ? (compact ? threads.slice(0, COMPACT_LIMIT) : threads) : null;

  let body: ReactNode;
  if (error) {
    body = (
      <div className="text-sm text-rose-700 flex items-center gap-2">
        <span>{error}</span>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 underline">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  } else if (shown === null || (loading && shown.length === 0)) {
    body = (
      <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200 bg-white" aria-busy="true">
        {Array.from({ length: compact ? 4 : 6 }).map((_, i) => (
          <li key={i} className={pad}>
            <div className="h-3.5 w-2/3 rounded bg-slate-100 animate-pulse" />
            <div className="mt-2 h-3 w-1/3 rounded bg-slate-100 animate-pulse" />
          </li>
        ))}
      </ul>
    );
  } else if (shown.length === 0) {
    body = (
      <p className="text-sm text-slate-500">
        {effStatus === "all" && effDays === "all" ? "No emails linked to this shipper's shipments yet." : "No emails match these filters."}
      </p>
    );
  } else {
    body = (
      <ul className={`divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200 bg-white ${loading ? "opacity-60" : ""}`}>
        {shown.map((t) => {
          const party = String(t.party || "unknown");
          const ids = Array.isArray(t.linked_shipment_ids) ? t.linked_shipment_ids : [];
          const maxChips = compact ? 2 : 4;
          return (
            <li key={t.conversation_id} className={`${pad} hover:bg-slate-50`}>
              <Link to={mailboxThreadHref(t.conversation_id)} className="block"
                onClick={(e) => { if (!isPlainClick(e)) return; e.preventDefault(); setThreadParam(t.conversation_id, compact); }}>
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
                  {t.last_from_name || t.last_from_address ? (
                    <span className="truncate" title={t.last_from_address || undefined}>{t.last_from_name || t.last_from_address}</span>
                  ) : null}
                  {t.message_count ? <span className="shrink-0 text-slate-400">{t.message_count} message{t.message_count === 1 ? "" : "s"}</span> : null}
                </div>
                {!compact && t.preview ? <p className="mt-0.5 text-xs text-slate-400 truncate">{t.preview}</p> : null}
              </Link>
              {ids.length ? (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {ids.slice(0, maxChips).map((id) => (
                    <Link key={id} to={`/tracking/${encodeURIComponent(id)}`}
                      className="text-[10px] font-mono rounded px-1.5 py-0.5 bg-slate-100 text-slate-600 hover:bg-sky-50 hover:text-sky-700">
                      {id}
                    </Link>
                  ))}
                  {ids.length > maxChips ? <span className="text-[10px] text-slate-400">+{ids.length - maxChips} more</span> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const countFor = (s: StatusFilter) => (counts ? counts[s] : null);

  return (
    <div className="space-y-2">
      {compact ? (
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-1.5"><Mail className="h-4 w-4 text-slate-400" /> Emails</h3>
          {counts ? (
            <span className="text-xs text-slate-500">
              {counts.all} in 90 days{counts.awaiting_reply ? <> · <span className="text-amber-700">{counts.awaiting_reply} awaiting reply</span></> : null}
            </span>
          ) : null}
          <button type="button" onClick={seeAll} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-900">
            See all <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white p-0.5" role="group" aria-label="Status">
            {STATUS_OPTIONS.map((o) => {
              const n = countFor(o.value);
              const active = status === o.value;
              return (
                <button key={o.value} type="button" onClick={() => setStatus(o.value)} aria-pressed={active}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  {o.label}{n !== null ? <span className={`ml-1 ${active ? "text-slate-300" : "text-slate-400"}`}>{n}</span> : null}
                </button>
              );
            })}
          </div>
          <select value={String(days)} onChange={(e) => setDays(e.target.value === "all" ? "all" : (Number(e.target.value) as RangeFilter))}
            aria-label="Date range"
            className="text-xs rounded-lg border-0 ring-1 ring-slate-200 bg-white py-1.5 pl-2 pr-7 text-slate-700">
            {RANGE_OPTIONS.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
          </select>
          {loading && threads && threads.length > 0 ? <span className="text-xs text-slate-400">Loading…</span> : null}
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} title="Refresh"
            className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      )}
      {body}
      {compact && counts && counts.all > COMPACT_LIMIT ? (
        <button type="button" onClick={seeAll} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-900">
          See all {counts.all} emails <ArrowRight className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export default ShipperEmails;
