// Support Mailbox (/mailbox). The freightsupport@ shared mailbox, synced into
// FPX: which conversations still wait on a reply, which were answered, and a
// composer that saves reply DRAFTS in Outlook (FPX never sends mail).
// One toolbar across the top (search, status, range ?d= default 30 days,
// party ?party=), then two panes on wide screens (conversations,
// conversation), stacked on narrow ones. The open conversation lives in ?c=
// so a link opens it. ?shipment= shows only conversations linked to that shipment.
// An open conversation gets a details sidebar (party, shipments, tasks,
// related conversations) beside it on wide screens and under it otherwise.
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, Loader2, Mail, MailX, Package, RefreshCw, Search, X } from "lucide-react";
import { getMailboxStatus, listThreads, type PartyFilter, type RangeDays, type ThreadFilter, type ThreadList as ThreadListData } from "../lib/mailboxApi";
import { useCached } from "../lib/useCached";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import { ErrorBlock } from "../components/ErrorBlock";
import { ThreadList, ThreadListSkeleton } from "../components/mailbox/ThreadList";
import { ThreadView, prefetchThread } from "../components/mailbox/ThreadView";
import { ThreadSidebar } from "../components/mailbox/ThreadSidebar";
import { FILTERS, PARTY_CLASS, PARTY_FILTERS, RANGES } from "../components/mailbox/shared";

const PAGE_SIZE = 50;
const POLL_MS = 2 * 60_000;
// The details sidebar is an inline 4th column at >= 1536px and a slide-over
// panel on the right from 1024px to 1535px (stacked under the thread below
// 1024px). Each layout remembers its own open/closed choice: inline defaults
// to open, the slide-over to closed (it covers the thread).
const INLINE_QUERY = "(min-width: 1536px)";
const OVERLAY_QUERY = "(min-width: 1024px) and (max-width: 1535.98px)";
const sidebarPrefKey = (overlay: boolean) => (overlay ? "fpx.mailbox.sidebar.overlay" : "fpx.mailbox.sidebar");

function readSidebarPref(overlay: boolean): boolean {
  try {
    const v = window.localStorage.getItem(sidebarPrefKey(overlay));
    return v ? v === "open" : !overlay;
  } catch { return !overlay; }
}

function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export default function SupportMailbox() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const filter: ThreadFilter = FILTERS.find((f) => f.id === params.get("f"))?.id ?? "awaiting_reply";
  const q = params.get("q") || "";
  const page = Math.max(0, Number(params.get("p")) || 0);
  const shipment = (params.get("shipment") || "").trim();
  // Linked to one shipment: show all time unless a range was picked.
  const days: RangeDays = RANGES.find((r) => r.id === params.get("d"))?.id ?? (shipment ? "all" : "30");
  const party: PartyFilter = PARTY_FILTERS.find((f) => f.id === params.get("party"))?.id ?? "all";

  const overlay = useMediaQuery(OVERLAY_QUERY);
  useMediaQuery(INLINE_QUERY); // re-render when crossing 1536px
  const [sidebarPrefs, setSidebarPrefs] = useState(() => ({ inline: readSidebarPref(false), overlay: readSidebarPref(true) }));
  const sidebarOpen = overlay ? sidebarPrefs.overlay : sidebarPrefs.inline;
  const setSidebarOpen = useCallback((open: boolean) => {
    try { window.localStorage.setItem(sidebarPrefKey(overlay), open ? "open" : "closed"); } catch { /* private mode */ }
    setSidebarPrefs((p) => (overlay ? { ...p, overlay: open } : { ...p, inline: open }));
  }, [overlay]);
  const toggleSidebar = () => setSidebarOpen(!sidebarOpen);
  // Esc closes the slide-over.
  useEffect(() => {
    if (!overlay || !sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) setSidebarOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, sidebarOpen, setSidebarOpen]);

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
      return n;
    }, { replace: true });
  }, [setParams]);

  // Debounced search box -> ?q=
  const [qInput, setQInput] = useState(q);
  useEffect(() => { setQInput(q); }, [q]);
  useEffect(() => {
    if (qInput.trim() === q) return;
    const t = setTimeout(() => setParam({ q: qInput.trim() || null, p: null }), 350);
    return () => clearTimeout(t);
  }, [qInput, q, setParam]);

  const status = useCached("mailbox:status", getMailboxStatus);
  const connected = !!status.data?.connected;

  const threadsKey = `mailbox:threads:${filter}|${q}|${page}|${days}|${party}|${shipment}`;
  const fetchThreads = useCallback(
    (signal: AbortSignal) => listThreads({
      status: filter, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE, days, party, shipment_id: shipment || undefined,
    }, signal),
    [filter, q, page, days, party, shipment],
  );
  const threads = useCached(threadsKey, fetchThreads);
  // useCached already serves each query key from cache at once, revalidates,
  // and aborts the request of a key that is no longer shown.

  // The last list shown, kept on screen (dimmed) while another key loads.
  const [lastList, setLastList] = useState<ThreadListData | null>(null);
  useEffect(() => { if (threads.data) setLastList(threads.data); }, [threads.data]);

  // Warm the first 3 conversations of each list.
  useEffect(() => {
    for (const t of (threads.data?.threads ?? []).slice(0, 3)) prefetchThread(t.conversation_id);
  }, [threads.data]);

  // The sync worker runs every 2 minutes; follow it while the page is open.
  const { refresh: refreshStatus } = status;
  const { refresh: refreshThreads } = threads;
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshStatus();
      refreshThreads();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connected, refreshStatus, refreshThreads]);

  const refreshAll = () => { refreshStatus(); refreshThreads(); };

  // ---- Header + gates ----
  const st = status.data;
  const header = (
    <div className="flex items-end justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold flex items-center gap-2"><Mail className="h-5 w-5 text-violet-600" /> Support Mailbox</h1>
        {st?.mailbox ? (
          <div className="text-sm text-slate-500 mt-0.5 flex items-center gap-x-3 gap-y-1 flex-wrap">
            <span className="font-medium text-slate-700 break-all">{st.mailbox}</span>
            <ConnectionPill status={st.status} />
            <span title={fmtDateTime(st.last_sync_at)}>Last sync {st.last_sync_at ? fmtRelative(st.last_sync_at) : "not yet"}</span>
            <span>{fmtNum(st.message_count)} messages</span>
            {connected && !st.backfill_done ? (
              <span className="inline-flex items-center gap-1 text-sky-700"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing history…</span>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500 mt-0.5">Conversations in the shared support mailbox, and which ones still need a reply.</p>
        )}
      </div>
      {connected ? (
        <button type="button" onClick={refreshAll}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 text-slate-700">
          <RefreshCw className={"h-4 w-4" + (status.refreshing || threads.refreshing ? " animate-spin" : "")} /> Refresh
        </button>
      ) : null}
    </div>
  );

  // Status and the list load in parallel: the list is not held back while
  // status is in flight. Only a known "not connected" replaces the mailbox.
  if (!st && status.error && !threads.data) {
    return (
      <div className="space-y-4">
        {header}
        <ErrorBlock>{status.error} <button type="button" onClick={refreshStatus} className="underline ml-1">Retry</button></ErrorBlock>
      </div>
    );
  }

  if (st && !connected) {
    return (
      <div className="space-y-4">
        {header}
        <div className="rounded-xl ring-1 ring-slate-200 bg-white p-10 text-center max-w-xl mx-auto">
          <MailX className="h-10 w-10 text-slate-300 mx-auto" />
          <h2 className="mt-3 text-base font-semibold text-slate-900">The support mailbox is not connected</h2>
          <p className="mt-1 text-sm text-slate-500">
            {st.status === "disconnected" ? "It was disconnected. Messages already synced are kept. " : ""}
            An admin needs to connect the mailbox before conversations show up here.
          </p>
          {st.last_error ? <ErrorBlock compact tone="warning" className="mt-3 text-left">{st.last_error}</ErrorBlock> : null}
          {isAdmin ? (
            <Link to="/admin/support-mailbox" className="mt-4 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700">
              Connect the mailbox
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  // ---- Toolbar + panes ----
  // While a new filter loads, keep showing the previous list, dimmed.
  const shown = threads.data ?? lastList;
  const stale = !threads.data && !!lastList;
  const counts = shown?.counts;
  const total = shown?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const select = (c: string | null) => setParam({ c });

  return (
    <div className="space-y-4">
      {header}
      {st?.status === "error" && st.last_error ? (
        <ErrorBlock tone="warning">Last sync failed: {st.last_error}</ErrorBlock>
      ) : null}

      <div className="rounded-xl ring-1 ring-slate-200 bg-white overflow-hidden lg:flex lg:flex-col lg:h-[calc(100vh-11rem)] lg:min-h-[32rem]">
        {/* Toolbar: search · status · range · party (wraps on narrow widths) */}
        <div className={(selected ? "hidden lg:flex" : "flex") + " flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-slate-200 bg-slate-50/60"}>
          <label className="relative block w-full sm:w-[260px] shrink-0">
            <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search"
              aria-label="Search conversations"
              className="w-full text-sm rounded-lg ring-1 ring-slate-200 bg-white pl-8 pr-2 py-1.5 focus:outline-none focus:ring-violet-400"
            />
          </label>
          <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white p-0.5 max-w-full overflow-x-auto [scrollbar-width:none]" role="group" aria-label="Filter conversations">
            {FILTERS.map((f) => {
              const active = f.id === filter;
              const n = counts?.[f.id];
              return (
                <button key={f.id} type="button" onClick={() => setParam({ f: f.id === "awaiting_reply" ? null : f.id, p: null })}
                  aria-pressed={active}
                  className={"shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs whitespace-nowrap transition " +
                    (active ? "bg-violet-100 text-violet-800 font-semibold" : "text-slate-600 hover:bg-slate-50")}>
                  {f.label}
                  {n != null ? (
                    <span className={"text-[10px] font-semibold rounded-full px-1.5 py-px " +
                      (f.id === "awaiting_reply" && n > 0 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600")}>{fmtNum(n)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <label htmlFor="mailbox-range" className="sr-only">Time range</label>
          <select
            id="mailbox-range"
            value={days}
            onChange={(e) => setParam({ d: e.target.value === (shipment ? "all" : "30") ? null : e.target.value, p: null })}
            className="text-xs rounded-lg ring-1 ring-slate-200 bg-white px-2 py-1.5 text-slate-700 focus:outline-none focus:ring-violet-400"
          >
            {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <div className="flex gap-1 flex-wrap" role="group" aria-label="Who the conversation is with">
            {PARTY_FILTERS.map((f) => {
              const active = f.id === party;
              const tone = f.id === "all" ? "bg-slate-100 text-slate-700 ring-1 ring-slate-200" : PARTY_CLASS[f.id];
              return (
                <button key={f.id} type="button" onClick={() => setParam({ party: f.id === "all" ? null : f.id, p: null })}
                  aria-pressed={active}
                  className={"rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap transition " +
                    (active ? tone + " outline outline-2 outline-offset-1 outline-violet-400" : "text-slate-500 ring-1 ring-slate-200 bg-white hover:bg-slate-50")}>
                  {f.label}
                </button>
              );
            })}
          </div>
          {shipment ? (
            <span className="inline-flex items-center gap-1 min-w-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium bg-sky-50 text-sky-800 ring-1 ring-sky-200">
              <Package className="h-3 w-3 shrink-0" />
              <span className="truncate">Shipment {shipment}</span>
              <button type="button" onClick={() => setParam({ shipment: null, p: null })} aria-label="Show all shipments"
                className="shrink-0 rounded hover:bg-sky-100"><X className="h-3 w-3" /></button>
            </span>
          ) : null}
        </div>

        <div className="relative lg:flex-1 lg:min-h-0 lg:grid lg:grid-cols-[minmax(20rem,26.25rem)_1fr]">
        {/* Left: conversations */}
        <section className={(selected ? "hidden lg:flex" : "flex") + " flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-slate-200"} aria-label="Conversations">
          <div className={"flex-1 min-h-0 overflow-y-auto transition-opacity " + (stale ? "opacity-50" : "")} aria-busy={!threads.data}>
            {shown ? (
              <ThreadList threads={shown.threads} selected={selected} onSelect={(c) => select(c)} onHover={prefetchThread} />
            ) : threads.error ? (
              <div className="p-3"><ErrorBlock>{threads.error} <button type="button" onClick={refreshThreads} className="underline ml-1">Retry</button></ErrorBlock></div>
            ) : <ThreadListSkeleton />}
            {shown && threads.error ? (
              <div className="p-3"><ErrorBlock compact tone="warning">Could not refresh: {threads.error}</ErrorBlock></div>
            ) : null}
          </div>
          {shown ? (
            <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 text-xs text-slate-500">
              <span>
                {total ? `${fmtNum(page * PAGE_SIZE + 1)}–${fmtNum(Math.min(total, (page + 1) * PAGE_SIZE))} of ${fmtNum(total)}` : "0 conversations"}
              </span>
              {threads.refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-label="Updating" /> : null}
              <div className="ml-auto flex items-center gap-1">
                <button type="button" disabled={page <= 0} onClick={() => setParam({ p: page - 1 > 0 ? String(page - 1) : null })}
                  className="p-1 rounded hover:bg-slate-100 disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
                <span>{page + 1} / {pages}</span>
                <button type="button" disabled={page + 1 >= pages} onClick={() => setParam({ p: String(page + 1) })}
                  className="p-1 rounded hover:bg-slate-100 disabled:opacity-40" aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          ) : null}
        </section>

        {/* Right: the conversation (+ details sidebar) */}
        <section className={(selected ? "block" : "hidden lg:block") + " min-h-0 lg:overflow-y-auto 2xl:overflow-hidden 2xl:flex"} aria-label="Conversation">
          {selected ? (
            <>
              <div className="2xl:flex-1 2xl:min-w-0 2xl:overflow-y-auto">
                <ThreadView key={selected} conversationId={selected} mailbox={st?.mailbox ?? null} onBack={() => select(null)}
                  sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
              </div>
              {sidebarOpen ? (
                <aside aria-label="Conversation details"
                  className={"border-t border-slate-200 bg-slate-50/60 " +
                    // 1024-1535px: slide-over on the right edge of the mailbox area, over the thread.
                    "lg:absolute lg:inset-y-0 lg:right-0 lg:z-20 lg:w-[340px] lg:max-w-full lg:border-t-0 lg:border-l lg:bg-slate-50 lg:shadow-[-8px_0_24px_-8px_rgba(15,23,42,0.18)] lg:overflow-y-auto " +
                    // >= 1536px: inline column.
                    "2xl:static 2xl:z-auto 2xl:w-80 2xl:shrink-0 2xl:shadow-none 2xl:bg-slate-50/60"}>
                  <ThreadSidebar key={selected} conversationId={selected} onOpenThread={(c) => select(c)}
                    onClose={() => setSidebarOpen(false)} />
                </aside>
              ) : null}
            </>
          ) : (
            <div className="h-full w-full flex flex-col items-center justify-center text-center p-10 text-slate-500">
              <Inbox className="h-10 w-10 text-slate-300" />
              <p className="mt-2 text-sm">Pick a conversation to read it and draft a reply.</p>
              {counts?.awaiting_reply ? (
                <p className="mt-1 text-xs inline-flex items-center gap-1 text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" /> {fmtNum(counts.awaiting_reply)} waiting on a reply
                </p>
              ) : null}
            </div>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}

function ConnectionPill({ status }: { status: string | null }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1";
  if (status === "connected") return <span className={`${base} bg-emerald-100 text-emerald-700 ring-emerald-200`}>Connected</span>;
  if (status === "error") return <span className={`${base} bg-rose-100 text-rose-700 ring-rose-200`}>Sync error</span>;
  return <span className={`${base} bg-slate-100 text-slate-600 ring-slate-200`}>{status === "disconnected" ? "Disconnected" : "Not connected"}</span>;
}
