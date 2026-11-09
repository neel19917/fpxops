import { Fragment, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowUp, Filter, Loader2, MessageCircle, Navigation, PackageOpen, RotateCcw, Sparkles, X } from "lucide-react";
import { hostedBrowser, type AssistantAction } from "../lib/hostedBrowser";

// "Ask FPX" — a chat panel on every signed-in page. Claude (via the hosted
// browser service) answers from live shipment/task data and can drive the
// dashboard: open a shipment or task, filter the Tracking list, change page.
//
// The conversation lives in sessionStorage (this tab only). `history` is the
// API-format transcript, sent back verbatim each turn.

const STORE_KEY = "fpx.assistant.v1";
const SUGGESTIONS = [
  "What should I focus on today?",
  "Which carriers have the most shipments needing action?",
  "Show me shipments that need action",
  "What's late and not delivered yet?",
];

const PAGE_PATHS: Record<string, string> = {
  tracking: "/tracking", tasks: "/tasks/v2", ops: "/ops", scraping: "/scraping",
  notes: "/notes", analyses: "/analyses", gp: "/audits/gp", invoice: "/audits/invoice",
};

interface Turn { role: "user" | "assistant"; text: string; actions?: AssistantAction[]; error?: boolean }
interface Stored { turns: Turn[]; history: unknown[] }

function load(): Stored {
  try { const raw = sessionStorage.getItem(STORE_KEY); if (raw) return JSON.parse(raw); } catch { /* ignore */ }
  return { turns: [], history: [] };
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

// Minimal formatting for the assistant's replies: **bold**, numbered and
// bulleted lists, paragraphs. (No HTML injection — everything is text nodes.)
function Rich({ text }: { text: string }) {
  const lines = text.split("\n");
  const bold = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>);
  return (
    <div className="space-y-1.5">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return null;
        const num = /^(\d+)\.\s+(.*)$/.exec(line.trim());
        if (num) return (
          <div key={i} className="flex gap-2">
            <span className="shrink-0 h-5 w-5 rounded-full bg-violet-100 text-violet-700 text-[11px] font-semibold flex items-center justify-center mt-px">{num[1]}</span>
            <div>{bold(num[2])}</div>
          </div>
        );
        const bullet = /^\s*[-•]\s+(.*)$/.exec(line);
        if (bullet) return <div key={i} className="flex gap-2 pl-7"><span className="text-slate-400">•</span><div>{bold(bullet[1])}</div></div>;
        return <p key={i}>{bold(line)}</p>;
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota */ } }, [state]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [state.turns.length, busy, open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);

  // Ctrl/Cmd+K toggles the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    try {
      const r = await hostedBrowser.assistantChat({ history: state.history, message, context: { page: location.pathname } });
      setState({ turns: [...turns, { role: "assistant", text: r.reply || "(no answer)", actions: r.actions }], history: r.messages });
      // Do what it said, in order (the last navigation wins).
      for (const a of r.actions) perform(a);
    } catch (e) {
      setState((s) => ({ ...s, turns: [...turns, { role: "assistant", text: (e as Error).message, error: true }] }));
    } finally {
      setBusy(false);
    }
  }

  if (!hostedBrowser.enabled) return null;

  return (
    <>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 inline-flex items-center gap-2 rounded-full bg-violet-600 text-white pl-3.5 pr-4 py-2.5 shadow-lg shadow-violet-600/30 hover:bg-violet-700 text-sm font-medium"
          title="Ask FPX (Ctrl/⌘ K)"
        >
          <Sparkles className="h-4 w-4" /> Ask FPX
        </button>
      ) : (
        <div className="fixed bottom-5 right-5 z-50 w-[min(440px,calc(100vw-2.5rem))] h-[min(640px,calc(100vh-2.5rem))] rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-violet-600 to-violet-500 text-white">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <div>
                <div className="text-sm font-semibold leading-tight">Ask FPX</div>
                <div className="text-[11px] text-violet-100 leading-tight">Finds, filters and opens shipments for you</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {state.turns.length ? (
                <button onClick={() => setState({ turns: [], history: [] })} className="p-1.5 rounded-md hover:bg-white/15" title="New chat" aria-label="New chat">
                  <RotateCcw className="h-4 w-4" />
                </button>
              ) : null}
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-md hover:bg-white/15" title="Close (Ctrl/⌘ K)" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 bg-slate-50/60">
            {state.turns.length === 0 ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 text-sm text-slate-700">
                  <MessageCircle className="h-4 w-4 mt-0.5 text-violet-600 shrink-0" />
                  <p>Ask what to work on, or tell me to find, filter or open a shipment — e.g. <em>"open 15665897"</em> or <em>"show ABF shipments that need action"</em>.</p>
                </div>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} className="text-left text-sm px-3 py-2 rounded-xl bg-white ring-1 ring-slate-200 hover:ring-violet-300 hover:bg-violet-50 text-slate-800">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {state.turns.map((t, i) => t.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-violet-600 text-white text-sm px-3.5 py-2 whitespace-pre-wrap break-words">{t.text}</div>
              </div>
            ) : (
              <div key={i} className="space-y-2">
                <div className={"text-sm leading-relaxed rounded-2xl rounded-bl-md px-3.5 py-2.5 ring-1 " + (t.error ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-white text-slate-700 ring-slate-200")}>
                  {t.error ? t.text : <Rich text={t.text} />}
                </div>
                {t.actions?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {t.actions.map((a, j) => (
                      <button key={j} onClick={() => perform(a)} title="Do this again"
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-violet-50 text-violet-800 ring-1 ring-violet-200 hover:bg-violet-100">
                        <ActionIcon a={a} /> {actionLabel(a)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {busy ? (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking at your shipments…
              </div>
            ) : null}
          </div>

          <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="border-t border-slate-100 p-3 bg-white">
            <div className="flex items-end gap-2 rounded-xl ring-1 ring-slate-200 focus-within:ring-violet-400 px-3 py-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } e.stopPropagation(); }}
                rows={1}
                placeholder="Ask about shipments, tasks, carriers…"
                className="flex-1 resize-none text-sm outline-none max-h-32 bg-transparent"
              />
              <button type="submit" disabled={busy || !input.trim()} aria-label="Send"
                className="h-8 w-8 rounded-lg bg-violet-600 text-white flex items-center justify-center disabled:opacity-40 hover:bg-violet-700 shrink-0">
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
