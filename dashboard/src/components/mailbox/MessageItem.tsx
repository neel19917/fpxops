import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CornerUpLeft, ExternalLink, Paperclip } from "lucide-react";
import { getMessageBody, type Message } from "../../lib/mailboxApi";
import { fmtDateTime, fmtRelative } from "../../lib/format";
import { ErrorBlock } from "../ErrorBlock";
import { LoadingState } from "../LoadingState";
import { messageTime, recipientsText } from "./shared";

// Bodies never change: kept for the session by message id (and in-flight
// requests shared), so re-opening is instant and a prefetch is reused.
const bodyCache = new Map<string, string>();
const bodyInflight = new Map<string, Promise<string>>();

/** The message's HTML, from the session cache or the server (one request per id). */
export function loadMessageBody(id: string): Promise<string> {
  const hit = bodyCache.get(id);
  if (hit != null) return Promise.resolve(hit);
  let p = bodyInflight.get(id);
  if (!p) {
    p = getMessageBody(id)
      .then((r) => { const html = r.body_html || ""; bodyCache.set(id, html); return html; })
      .finally(() => { bodyInflight.delete(id); });
    bodyInflight.set(id, p);
  }
  return p;
}

/** Start loading a body in the background; errors are left for the real open. */
export function prefetchMessageBody(id: string): void {
  if (bodyCache.has(id)) return;
  loadMessageBody(id).catch(() => {});
}

// Put before the email's own markup: the parser moves these into <head>, so
// they apply whatever the email contains. The frame is also sandbox="" (no
// scripts, no forms, no popups, unique origin), so this is belt and braces.
const FRAME_HEAD =
  `<meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">` +
  `<base target="_blank">` +
  `<style>html,body{margin:0;padding:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style>`;

/** Renders untrusted email HTML in a sandboxed frame. Never injected into the page. */
export function SafeEmailFrame({ html, title }: { html: string; title: string }) {
  return (
    <div className="rounded-md ring-1 ring-slate-200 overflow-hidden resize-y min-h-[160px] h-[420px] max-h-[85vh] bg-white">
      <iframe
        title={title}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={FRAME_HEAD + html}
        className="w-full h-full block border-0"
      />
    </div>
  );
}

interface Props {
  message: Message;
  mailbox: string | null;
  defaultOpen?: boolean;
  isReplyTarget: boolean;
  /** Omitted when the user cannot draft replies: the reply button is hidden. */
  onReplyTo?: () => void;
}

export function MessageItem({ message: m, mailbox, defaultOpen = false, isReplyTarget, onReplyTo }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [body, setBody] = useState<string | null>(() => bodyCache.get(m.id) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const out = m.direction === "out";
  const when = messageTime(m);

  useEffect(() => {
    if (!open || body != null) return;
    let live = true;
    setErr(null);
    // Shared with prefetches; not aborted on unmount so a prefetch can finish.
    loadMessageBody(m.id).then(
      (html) => { if (live) setBody(html); },
      (e: unknown) => { if (live) setErr((e as Error)?.message || "Could not load the message."); },
    );
    return () => { live = false; };
  }, [open, body, m.id, nonce]);

  const to = recipientsText(m.to_recipients);
  const cc = recipientsText(m.cc_recipients);

  return (
    <article
      className={
        "rounded-lg ring-1 " +
        (out ? "bg-sky-50/70 ring-sky-200 sm:ml-8" : "bg-white ring-slate-200 sm:mr-8") +
        (isReplyTarget ? " outline outline-2 outline-violet-300" : "")
      }
    >
      <header className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-start gap-2 min-w-0 flex-1 text-left"
        >
          {open ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-slate-400" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              {out ? (
                <span className="text-sm font-semibold text-sky-800">FreightPOP Support replied</span>
              ) : (
                <span className="text-sm font-semibold text-slate-900 truncate">{m.from_name || m.from_address || "Unknown sender"}</span>
              )}
              {!out && m.from_name && m.from_address ? <span className="text-xs text-slate-500 truncate">{m.from_address}</span> : null}
              {out && m.from_address && m.from_address.toLowerCase() !== (mailbox || "").toLowerCase()
                ? <span className="text-xs text-slate-500 truncate">{m.from_address}</span> : null}
              {m.has_attachments ? <Paperclip className="h-3.5 w-3.5 text-slate-400" aria-label="Has attachments" /> : null}
              <span className="ml-auto text-[11px] text-slate-500 shrink-0" title={fmtDateTime(when)}>{fmtRelative(when)}</span>
            </div>
            {open ? (
              <div className="text-xs text-slate-500 mt-0.5 space-y-0.5">
                {to ? <div className="break-words"><span className="text-slate-400">To:</span> {to}</div> : null}
                {cc ? <div className="break-words"><span className="text-slate-400">Cc:</span> {cc}</div> : null}
                <div>{fmtDateTime(when)}</div>
              </div>
            ) : (
              <div className="text-xs text-slate-500 truncate mt-0.5">{m.body_preview || ""}</div>
            )}
          </div>
        </button>
      </header>
      {open ? (
        <div className="px-3 pb-3 space-y-2">
          {err ? (
            <ErrorBlock compact>{err} <button type="button" onClick={() => setNonce((n) => n + 1)} className="underline ml-1">Retry</button></ErrorBlock>
          ) : body == null ? (
            <LoadingState variant="inline" label="Loading message…" />
          ) : body.trim() ? (
            <SafeEmailFrame html={body} title={`Message from ${m.from_name || m.from_address || "sender"}`} />
          ) : (
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{m.body_preview || "(empty message)"}</p>
          )}
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {m.web_link ? (
              <a href={m.web_link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-violet-700 hover:underline">
                <ExternalLink className="h-3.5 w-3.5" /> Open in Outlook
              </a>
            ) : null}
            {onReplyTo ? (
              <button type="button" onClick={onReplyTo} disabled={isReplyTarget}
                className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 disabled:text-violet-700 disabled:cursor-default">
                <CornerUpLeft className="h-3.5 w-3.5" /> {isReplyTarget ? "Replying to this message" : "Reply to this message"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}
