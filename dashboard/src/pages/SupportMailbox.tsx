// Support Mailbox (/mailbox). The freightsupport@ shared mailbox, synced into
// FPX: which conversations still wait on a reply, which were answered, and a
// composer that saves reply DRAFTS in Outlook (FPX never sends mail).
// Three panes on wide screens (filters, conversations, conversation), stacked
// on narrow ones. The open conversation lives in ?c= so a link opens it.
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, Loader2, Mail, MailX, RefreshCw, Search } from "lucide-react";
import { getMailboxStatus, listThreads, type ThreadFilter } from "../lib/mailboxApi";
import { useCached } from "../lib/useCached";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";
import { ThreadList } from "../components/mailbox/ThreadList";
import { ThreadView } from "../components/mailbox/ThreadView";
import { FILTERS } from "../components/mailbox/shared";

const PAGE_SIZE = 50;
const POLL_MS = 2 * 60_000;

export default function SupportMailbox() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const filter: ThreadFilter = FILTERS.find((f) => f.id === params.get("f"))?.id ?? "awaiting_reply";
  const q = params.get("q") || "";
  const page = Math.max(0, Number(params.get("p")) || 0);

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

  const threadsKey = `mailbox:threads:${filter}|${q}|${page}`;
  const fetchThreads = useCallback(
    (signal: AbortSignal) => listThreads({ status: filter, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }, signal),
    [filter, q, page],
  );
  const threads = useCached(threadsKey, fetchThreads);

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

  if (!st) {
    return (
      <div className="space-y-4">
        {header}
        {status.error
          ? <ErrorBlock>{status.error} <button type="button" onClick={refreshStatus} className="underline ml-1">Retry</button></ErrorBlock>
          : <LoadingState />}
      </div>
    );
  }

  if (!connected) {
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

  // ---- Three panes ----
  const counts = threads.data?.counts;
  const total = threads.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const select = (c: string | null) => setParam({ c });

  return (
    <div className="space-y-4">
      {header}
      {st.status === "error" && st.last_error ? (
        <ErrorBlock tone="warning">Last sync failed: {st.last_error}</ErrorBlock>
      ) : null}

      <div className="rounded-xl ring-1 ring-slate-200 bg-white overflow-hidden lg:grid lg:grid-cols-[11rem_minmax(18rem,24rem)_1fr] lg:h-[calc(100vh-11rem)] lg:min-h-[32rem]">
        {/* Left: filters + search */}
        <aside className={(selected ? "hidden lg:flex" : "flex") + " flex-col gap-2 p-3 border-b lg:border-b-0 lg:border-r border-slate-200 bg-slate-50/60"}>
          <label className="relative block">
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
          <nav className="flex lg:flex-col gap-1 overflow-x-auto" aria-label="Filter conversations">
            {FILTERS.map((f) => {
              const active = f.id === filter;
              const n = counts?.[f.id];
              return (
                <button key={f.id} type="button" onClick={() => setParam({ f: f.id === "awaiting_reply" ? null : f.id, p: null })}
                  aria-current={active ? "true" : undefined}
                  className={"shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left whitespace-nowrap " +
                    (active ? "bg-violet-100 text-violet-800 font-medium" : "text-slate-600 hover:bg-white")}>
                  <span className="flex-1">{f.label}</span>
                  {n != null ? (
                    <span className={"text-[11px] font-semibold rounded-full px-1.5 py-0.5 " +
                      (f.id === "awaiting_reply" && n > 0 ? "bg-amber-100 text-amber-800" : "bg-slate-200/70 text-slate-600")}>{fmtNum(n)}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Middle: conversations */}
        <section className={(selected ? "hidden lg:flex" : "flex") + " flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-slate-200"} aria-label="Conversations">
          <div className="flex-1 min-h-0 overflow-y-auto">
            {threads.data ? (
              <ThreadList threads={threads.data.threads} selected={selected} onSelect={(c) => select(c)} />
            ) : threads.error ? (
              <div className="p-3"><ErrorBlock>{threads.error} <button type="button" onClick={refreshThreads} className="underline ml-1">Retry</button></ErrorBlock></div>
            ) : <LoadingState />}
            {threads.data && threads.error ? (
              <div className="p-3"><ErrorBlock compact tone="warning">Could not refresh: {threads.error}</ErrorBlock></div>
            ) : null}
          </div>
          {threads.data ? (
            <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 text-xs text-slate-500">
              <span>
                {total ? `${fmtNum(page * PAGE_SIZE + 1)}–${fmtNum(Math.min(total, (page + 1) * PAGE_SIZE))} of ${fmtNum(total)}` : "0 conversations"}
              </span>
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

        {/* Right: the conversation */}
        <section className={(selected ? "block" : "hidden lg:block") + " min-h-0 lg:overflow-y-auto"} aria-label="Conversation">
          {selected ? (
            <ThreadView key={selected} conversationId={selected} mailbox={st.mailbox} onBack={() => select(null)} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-10 text-slate-500">
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
  );
}

function ConnectionPill({ status }: { status: string | null }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1";
  if (status === "connected") return <span className={`${base} bg-emerald-100 text-emerald-700 ring-emerald-200`}>Connected</span>;
  if (status === "error") return <span className={`${base} bg-rose-100 text-rose-700 ring-rose-200`}>Sync error</span>;
  return <span className={`${base} bg-slate-100 text-slate-600 ring-slate-200`}>{status === "disconnected" ? "Disconnected" : "Not connected"}</span>;
}
