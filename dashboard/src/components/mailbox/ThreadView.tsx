import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, FileText, PanelRightClose, PanelRightOpen, RefreshCw, Sparkles } from "lucide-react";
import { getThread, type Draft, type Message } from "../../lib/mailboxApi";
import { useCached } from "../../lib/useCached";
import { cachedFetch, invalidateCache } from "../../lib/sessionCache";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { ErrorBlock } from "../ErrorBlock";
import { MessageItem, prefetchMessageBody } from "./MessageItem";
import { ReplyComposer } from "./ReplyComposer";
import { PartyTag, ThreadStatusBadge, Toast, waitingFor } from "./shared";

export const threadCacheKey = (conversationId: string) => `mailbox:thread:${conversationId}`;

/** A detail fetched less than this long ago is not asked for again by a prefetch. */
const PREFETCH_FRESH_MS = 60_000;

/**
 * Warm a conversation before it is opened (first rows of a list, row hover):
 * its detail goes into the cache, then its latest message body (the one that
 * opens expanded). Never throws.
 */
export function prefetchThread(conversationId: string): void {
  cachedFetch(threadCacheKey(conversationId), (s) => getThread(conversationId, s), { maxAgeMs: PREFETCH_FRESH_MS })
    .then((d) => {
      const last = d.messages[d.messages.length - 1];
      if (last) prefetchMessageBody(last.id);
    })
    .catch(() => {});
}

interface Props {
  conversationId: string;
  mailbox: string | null;
  onBack: () => void;
  /** The details sidebar (party, shipments, tasks) is showing. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
}

export function ThreadView({ conversationId, mailbox, onBack, sidebarOpen, onToggleSidebar }: Props) {
  const fetcher = useCallback((signal: AbortSignal) => getThread(conversationId, signal), [conversationId]);
  const { data, error, refreshing, refresh } = useCached(threadCacheKey(conversationId), fetcher);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [toast, setToast] = useState<Draft | null>(null);
  const closeToast = useCallback(() => setToast(null), []);

  const messages = data?.messages ?? [];
  const latestInbound = useMemo(() => [...messages].reverse().find((m) => m.direction === "in") ?? null, [messages]);
  const target: Message | null =
    messages.find((m) => m.id === replyToId) ?? latestInbound ?? messages[messages.length - 1] ?? null;

  const onCreated = (d: Draft) => {
    setToast(d);
    invalidateCache(threadCacheKey(conversationId));
    invalidateCache("mailbox:threads:");
  };

  if (!data) {
    return (
      <div className="p-4">
        <BackButton onBack={onBack} />
        {error ? <ErrorBlock>{error} <button type="button" onClick={refresh} className="underline ml-1">Retry</button></ErrorBlock> : <ThreadSkeleton />}
      </div>
    );
  }

  const { thread, drafts } = data;
  const wait = thread.status === "awaiting_reply" ? waitingFor(thread.last_inbound_at) : null;

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-4 pt-3 pb-2 border-b border-slate-200 space-y-1">
        <BackButton onBack={onBack} />
        <div className="flex items-start gap-2">
          <h2 className="text-base font-semibold text-slate-900 min-w-0 flex-1 break-words">{thread.subject || "(no subject)"}</h2>
          <button type="button" onClick={refresh} title="Refresh conversation" aria-label="Refresh conversation"
            className="shrink-0 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <RefreshCw className={"h-4 w-4" + (refreshing ? " animate-spin" : "")} />
          </button>
          {onToggleSidebar ? (
            <button type="button" onClick={onToggleSidebar} aria-pressed={!!sidebarOpen}
              title={sidebarOpen ? "Hide details" : "Show details: party, shipments, tasks"}
              aria-label={sidebarOpen ? "Hide details" : "Show details"}
              className={"shrink-0 p-1 rounded hover:bg-slate-100 " + (sidebarOpen ? "text-violet-700" : "text-slate-400 hover:text-slate-700")}>
              {sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500">
          <ThreadStatusBadge status={thread.status} />
          {thread.party !== undefined ? <PartyTag party={thread.party} /> : null}
          {wait ? <span className="text-amber-700">waiting {wait}</span> : null}
          <span>{thread.message_count} message{thread.message_count === 1 ? "" : "s"}</span>
          <span>· last {fmtRelative(thread.last_message_at)}</span>
        </div>
        {error ? <ErrorBlock compact tone="warning">Could not refresh: {error}</ErrorBlock> : null}
      </div>

      <div className="p-4 space-y-3">
        {messages.length ? messages.map((m, i) => (
          <MessageItem
            key={m.id}
            message={m}
            mailbox={mailbox}
            defaultOpen={i === messages.length - 1}
            isReplyTarget={target?.id === m.id}
            onReplyTo={() => setReplyToId(m.id)}
          />
        )) : <div className="text-sm text-slate-500">No messages in this conversation.</div>}
      </div>

      {drafts.length ? (
        <div className="px-4 pb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Drafts created from FPX</h3>
          <ul className="space-y-1.5">
            {drafts.map((d) => (
              <li key={d.id} className="rounded-lg ring-1 ring-slate-200 bg-slate-50 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <FileText className="h-3.5 w-3.5 text-slate-400" />
                  <span className="font-medium text-slate-700">{d.reply_all ? "Reply all" : "Reply"} draft</span>
                  {d.ai_generated ? <span className="inline-flex items-center gap-0.5 text-violet-700"><Sparkles className="h-3 w-3" />AI</span> : null}
                  <span className="text-slate-500" title={fmtDateTime(d.created_at)}>{fmtRelative(d.created_at)}{d.created_by ? ` by ${d.created_by}` : ""}</span>
                  {d.web_link ? (
                    <a href={d.web_link} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-violet-700 hover:underline">
                      <ExternalLink className="h-3.5 w-3.5" /> Open draft in Outlook
                    </a>
                  ) : null}
                </div>
                {d.body ? <p className="mt-1 text-slate-600 line-clamp-2 whitespace-pre-wrap">{d.body}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="sticky bottom-0 border-t border-slate-200 bg-white px-4 py-3">
        <ReplyComposer key={conversationId} target={target} onCreated={onCreated} />
      </div>

      {toast ? (
        <Toast onClose={closeToast}>
          <div className="font-medium">Draft saved in Outlook. Nothing was sent.</div>
          {toast.web_link ? (
            <a href={toast.web_link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 mt-1 underline">
              <ExternalLink className="h-3.5 w-3.5" /> Open draft in Outlook
            </a>
          ) : <div className="text-xs mt-0.5">Find it in the support mailbox's Drafts folder.</div>}
        </Toast>
      ) : null}
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-label="Loading conversation">
      <div className="h-5 w-2/3 rounded bg-slate-200" />
      <div className="flex gap-2"><div className="h-4 w-24 rounded-full bg-slate-100" /><div className="h-4 w-16 rounded-full bg-slate-100" /></div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg ring-1 ring-slate-100 p-3 space-y-2">
          <div className="flex gap-2"><div className="h-3 w-36 rounded bg-slate-200" /><div className="ml-auto h-3 w-12 rounded bg-slate-100" /></div>
          {i === 2 ? <div className="h-32 rounded bg-slate-100" /> : null}
        </div>
      ))}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="lg:hidden inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 mb-1">
      <ArrowLeft className="h-3.5 w-3.5" /> All conversations
    </button>
  );
}
