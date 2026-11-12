import { Fragment, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, CornerDownLeft, ExternalLink, Filter, History, Loader2, MessageCircle, Navigation, PackageOpen, RotateCcw, Search, Trash2 } from "lucide-react";
import { hostedBrowser, type AssistantAction, type AssistantChatSummary } from "../lib/hostedBrowser";
import { fmtRelative } from "../lib/format";

// "Ask FPX" — one search box for the whole dashboard. Type a tracking number,
// a name or a plain-English question; Claude (via the hosted browser service)
// searches the shipment index (keyword + fuzzy + embeddings) and answers, and
// can drive the dashboard: open a shipment or task, filter Tracking, change
// page. The box lives in the header (AskSearchTrigger) and opens a centered
// search overlay (Ctrl/⌘ K, or "/").
//
// The conversation lives in sessionStorage (this tab only). `history` is the
// API-format transcript, sent back verbatim each turn.

const STORE_KEY = "fpx.assistant.v2";
const SUGGESTIONS = [
  "What should I focus on today?",
  "Late shipments not delivered yet",
  "ABF shipments that need action",
  "Which carriers have the most problems?",
];
const OPEN_EVENT = "fpx:ask-open";

// The search box shown in the header. Clicking it (or Ctrl/⌘ K) opens the
// search overlay rendered by <AssistantPanel />.
export function AskSearchTrigger() {
  if (!hostedBrowser.enabled) return null;
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className="flex items-center gap-2 w-64 max-w-full rounded-lg ring-1 ring-slate-200 bg-slate-50 hover:bg-white hover:ring-violet-300 px-3 py-1.5 text-sm text-slate-500 text-left"
      title="Search shipments and tasks, or ask a question (Ctrl/⌘ K)">
      <Search className="h-4 w-4 text-slate-400 shrink-0" />
      <span className="flex-1 truncate">Search or ask anything…</span>
      <kbd className="text-[10px] font-sans text-slate-400 ring-1 ring-slate-200 rounded px-1 bg-white">⌘K</kbd>
    </button>
  );
}

const PAGE_PATHS: Record<string, string> = {
  tracking: "/tracking", tasks: "/tasks/v2", ops: "/ops", scraping: "/scraping",
  notes: "/notes", analyses: "/analyses", gp: "/audits/gp", invoice: "/audits/invoice",
};

interface Turn { role: "user" | "assistant"; text: string; actions?: AssistantAction[]; error?: boolean }
interface Stored { id: string; turns: Turn[]; history: unknown[] }

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));
const fresh = (): Stored => ({ id: newId(), turns: [], history: [] });

function load(): Stored {
  try { const raw = sessionStorage.getItem(STORE_KEY); if (raw) { const v = JSON.parse(raw); if (v?.id) return v; } } catch { /* ignore */ }
  return fresh();
}

function actionLabel(a: AssistantAction): string {
  switch (a.type) {
    case "open_shipment": return `Opened shipment ${a.label || ""}`.trim();
    case "open_task": return `Opened task ${a.label || ""}`.trim();
    case "navigate": return `Went to ${a.page}`;
    case "filter_shipments": {
      const bits = [a.customer, a.action === "YES" ? "action needed" : a.action === "NO" ? "on track" : a.action, a.query && `"${a.query}"`].filter(Boolean);
      return `Filtered Tracking: ${bits.join(" · ") || "all"}`;
    }
  }
}

function ActionIcon({ a }: { a: AssistantAction }) {
  const cls = "h-3 w-3";
  if (a.type === "filter_shipments") return <Filter className={cls} />;
  if (a.type === "navigate") return <Navigation className={cls} />;
  return <PackageOpen className={cls} />;
}

// Minimal formatting for the assistant's replies: **bold**, [links](url),
// bare https:// links, numbered and bulleted lists, paragraphs. No HTML
// injection — everything is text nodes / React elements. Links: FPX pages
// ("/tracking/…", "/tasks/…") open in the app; only http(s) goes elsewhere.
const LINK_RE = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g;

function safeHref(href: string): { internal: boolean; href: string } | null {
  const h = href.trim();
  if (/^\/(?!\/)[\w\-/?=&.%#]*$/.test(h)) return { internal: true, href: h };
  try {
    const u = new URL(h);
    if (u.protocol === "https:" || u.protocol === "http:") return { internal: false, href: u.toString() };
  } catch { /* not a URL */ }
  return null;
}

function Rich({ text, onInternal }: { text: string; onInternal: (href: string) => void }) {
  const lines = text.split("\n");
  const link = (label: string, href: string, key: number) => {
    const ok = safeHref(href);
    if (!ok) return <Fragment key={key}>{label}</Fragment>;
    const cls = "text-violet-700 underline decoration-violet-300 underline-offset-2 hover:decoration-violet-700 font-medium";
    return ok.internal
      ? <a key={key} href={ok.href} className={cls} onClick={(e) => { e.preventDefault(); onInternal(ok.href); }}>{label}</a>
      : <a key={key} href={ok.href} target="_blank" rel="noopener noreferrer" className={cls}>{label}<ExternalLink className="inline h-3 w-3 ml-0.5 -mt-0.5" /></a>;
  };
  const inline = (s: string) => s.split(LINK_RE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i} className="font-semibold text-slate-900">{inline(part.slice(2, -2))}</strong>;
    const md = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (md) return link(md[1], md[2], i);
    if (/^https?:\/\//.test(part)) return link(part.replace(/^https?:\/\//, "").slice(0, 48), part, i);
    return <Fragment key={i}>{part}</Fragment>;
  });
  return (
    <div className="space-y-1.5">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return null;
        const num = /^(\d+)\.\s+(.*)$/.exec(line.trim());
        if (num) return (
          <div key={i} className="flex gap-2">
            <span className="shrink-0 h-5 w-5 rounded-full bg-violet-100 text-violet-700 text-[11px] font-semibold flex items-center justify-center mt-px">{num[1]}</span>
            <div>{inline(num[2])}</div>
          </div>
        );
        const bullet = /^\s*[-•]\s+(.*)$/.exec(line);
        if (bullet) return <div key={i} className="flex gap-2 pl-7"><span className="text-slate-400">•</span><div>{inline(bullet[1])}</div></div>;
        return <p key={i}>{inline(line)}</p>;
      })}
    </div>
  );
}

export function AssistantPanel() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Stored>(load);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");      // answer streaming in
  const [status, setStatus] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chats, setChats] = useState<AssistantChatSummary[] | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);

  async function openHistory() {
    setShowHistory(true); setHistoryErr(null);
    try { setChats((await hostedBrowser.listChats()).chats); } catch (e) { setHistoryErr((e as Error).message); }
  }
  async function resume(id: string) {
    try {
      const { chat } = await hostedBrowser.getChat(id);
      setState({ id: chat.id, turns: chat.turns, history: chat.history });
      setShowHistory(false);
    } catch (e) { setHistoryErr((e as Error).message); }
  }
  async function remove(id: string) {
    if (!confirm("Delete this chat?")) return;
    try {
      await hostedBrowser.deleteChat(id);
      setChats((c) => (c || []).filter((x) => x.id !== id));
      if (state.id === id) setState(fresh());
    } catch (e) { setHistoryErr((e as Error).message); }
  }
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota */ } }, [state]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [state.turns.length, busy, open, draft.length > 0, status]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);

  // Ctrl/Cmd+K toggles the search; "/" opens it when not typing elsewhere;
  // Esc closes it. The header search box opens it via OPEN_EVENT.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); setOpen((v) => !v); return; }
      if (e.key === "Escape") { setOpen(false); return; }
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setOpen(true); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, []);

  function perform(a: AssistantAction) {
    if (a.type === "open_shipment") navigate(`/tracking/${a.id}`);
    else if (a.type === "open_task") navigate(`/tasks/v2/${a.task_id}`);
    else if (a.type === "navigate") navigate(PAGE_PATHS[a.page] || "/tracking");
    else if (a.type === "filter_shipments") {
      const p = new URLSearchParams({ reset: "1" });
      if (a.query) p.set("q", a.query);
      if (a.action) p.set("action", a.action);
      if (a.customer) p.set("customer", a.customer);
      navigate(`/tracking?${p}`);
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    const turns: Turn[] = [...state.turns, { role: "user", text: message }];
    setState((s) => ({ ...s, turns }));
    setDraft(""); setStatus(null);
    try {
      const r = await hostedBrowser.assistantStream({ history: state.history, message, context: { page: location.pathname }, chatId: state.id }, (ev) => {
        if (ev.type === "text") { setStatus(null); setDraft((d) => d + ev.delta); }
        else if (ev.type === "reset") setDraft("");
        else if (ev.type === "status") setStatus(ev.text);
      });
      setState((s) => ({ id: s.id, turns: [...turns, { role: "assistant", text: r.reply || "(no answer)", actions: r.actions }], history: r.messages }));
      // Do what it said, in order (the last navigation wins), and get out of
      // the way so the page it opened is visible.
      for (const a of r.actions) perform(a);
      if (r.actions.length) setOpen(false);
    } catch (e) {
      setState((s) => ({ ...s, turns: [...turns, { role: "assistant", text: (e as Error).message, error: true }] }));
    } finally {
      setBusy(false); setDraft(""); setStatus(null);
    }
  }

  if (!hostedBrowser.enabled || !open) return null;

  const empty = state.turns.length === 0 && !busy;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-start justify-center p-4 pt-[10vh]" onClick={() => setOpen(false)}>
      <div className="w-full max-w-2xl max-h-[78vh] rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search FPX">
        {/* The search box */}
        <form onSubmit={(e) => { e.preventDefault(); setShowHistory(false); send(input); }} className="flex items-center gap-3 px-4 py-3 border-b border-slate-100">
          {busy ? <Loader2 className="h-5 w-5 text-violet-600 animate-spin shrink-0" /> : <Search className="h-5 w-5 text-slate-400 shrink-0" />}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}
            placeholder={state.turns.length ? "Ask a follow-up, or search again…" : "Search a tracking number, customer, carrier, or ask a question…"}
            className="flex-1 text-base outline-none bg-transparent placeholder:text-slate-400"
            aria-label="Search or ask"
            autoComplete="off"
          />
          <button type="submit" disabled={busy || !input.trim()} className="text-[11px] text-slate-500 inline-flex items-center gap-1 ring-1 ring-slate-200 rounded px-1.5 py-0.5 disabled:opacity-40 hover:bg-slate-50" title="Search (Enter)">
            <CornerDownLeft className="h-3 w-3" /> Enter
          </button>
        </form>

        {showHistory ? (
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
              <button onClick={() => setShowHistory(false)} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>
              <span className="text-xs text-slate-500">Past searches</span>
            </div>
            {historyErr ? <div className="m-3 text-xs text-rose-700">{historyErr}</div> : null}
            {!chats && !historyErr ? <div className="p-4 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div> : null}
            {chats && !chats.length ? <div className="p-4 text-sm text-slate-500">Nothing yet. Searches are saved here automatically.</div> : null}
            <ul className="divide-y divide-slate-100">
              {(chats || []).map((c) => (
                <li key={c.id} className={"group flex items-start gap-2 px-4 py-2.5 hover:bg-slate-50 cursor-pointer " + (c.id === state.id ? "bg-violet-50/60" : "")} onClick={() => resume(c.id)}>
                  <MessageCircle className="h-4 w-4 mt-0.5 text-violet-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-800 truncate">{c.title}</div>
                    <div className="text-[11px] text-slate-500">{fmtRelative(c.updated_at)} · {c.turn_count} question{c.turn_count === 1 ? "" : "s"}</div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); remove(c.id); }} className="p-1 rounded text-slate-400 hover:text-rose-600 opacity-0 group-hover:opacity-100 focus:opacity-100" title="Delete" aria-label="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : empty ? (
          <div className="px-4 py-3">
            <div className="text-[11px] uppercase font-semibold text-slate-400 mb-1.5">Try</div>
            <ul>
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button onClick={() => send(s)} className="w-full text-left text-sm px-2 py-1.5 rounded-lg hover:bg-violet-50 text-slate-700 inline-flex items-center gap-2">
                    <Search className="h-3.5 w-3.5 text-slate-400" /> {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {state.turns.map((t, i) => t.role === "user" ? (
              <div key={i} className="text-xs font-medium text-slate-500 inline-flex items-center gap-1.5 pt-1"><Search className="h-3 w-3" /> {t.text}</div>
            ) : (
              <div key={i} className="space-y-2">
                <div className={"text-sm leading-relaxed " + (t.error ? "rounded-lg px-3 py-2 bg-rose-50 text-rose-800 ring-1 ring-rose-200" : "text-slate-700")}>
                  {t.error ? t.text : <Rich text={t.text} onInternal={(href) => { navigate(href); setOpen(false); }} />}
                </div>
                {t.actions?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {t.actions.map((a, j) => (
                      <button key={j} onClick={() => { perform(a); setOpen(false); }} title="Go there again"
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-violet-50 text-violet-800 ring-1 ring-violet-200 hover:bg-violet-100">
                        <ActionIcon a={a} /> {actionLabel(a)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {busy && draft ? (
              <div className="text-sm leading-relaxed text-slate-700">
                <Rich text={draft} onInternal={(href) => { navigate(href); setOpen(false); }} />
                <span className="inline-block w-1.5 h-4 align-middle bg-violet-400 animate-pulse ml-0.5" />
              </div>
            ) : null}
            {busy && !draft ? <div className="text-xs text-slate-500">{status || "Searching…"}</div> : null}
          </div>
        )}

        <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-100 bg-slate-50/60 text-[11px] text-slate-500">
          <span>Searches shipments and tasks by number, name or meaning</span>
          <span className="ml-auto inline-flex items-center gap-3">
            {state.turns.length ? <button onClick={() => { setState(fresh()); setShowHistory(false); setInput(""); inputRef.current?.focus(); }} className="inline-flex items-center gap-1 hover:text-slate-900"><RotateCcw className="h-3 w-3" /> New search</button> : null}
            <button onClick={() => (showHistory ? setShowHistory(false) : openHistory())} className="inline-flex items-center gap-1 hover:text-slate-900"><History className="h-3 w-3" /> History</button>
            <span>Esc to close</span>
          </span>
        </div>
      </div>
    </div>
  );
}
