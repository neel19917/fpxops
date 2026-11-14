import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { GET_INVOICE_MAX } from "../../lib/erpPull";
import { fmtNum } from "../../lib/format";
import { fmtMoney } from "./model";

// The page's small controls: the filter switch, the "More" menu, the slim
// progress strip under the header and the bar that appears once shipments are
// ticked.

const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1";

export function Segmented<T extends string | number>({ label, value, choices, onPick, disabled }: {
  label: string; value: T; choices: readonly (readonly [T, ReactNode])[]; onPick: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5" role="group" aria-label={label}>
      {choices.map(([id, text]) => (
        <button
          key={String(id)}
          type="button"
          onClick={() => onPick(id)}
          disabled={disabled}
          aria-pressed={value === id}
          className={"px-3 py-1.5 rounded-md text-sm whitespace-nowrap disabled:opacity-50 " + FOCUS + " "
            + (value === id ? "bg-white text-slate-900 font-medium shadow-sm" : "text-slate-600 hover:text-slate-900")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A filter label with its count in muted numerals. */
export function Counted({ children, n }: { children: ReactNode; n: number }) {
  return <>{children} <span className="tabular-nums text-slate-400 font-normal">{fmtNum(n)}</span></>;
}

/** The quiet "More" control next to the Refresh button. Closes on Escape or a click outside. */
export function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) { if (!wrap.current?.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={"px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 inline-flex items-center gap-1 " + FOCUS}
      >
        More <ChevronDown className={"h-4 w-4 transition-transform " + (open ? "rotate-180" : "")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-2 z-20 w-[22rem] max-w-[calc(100vw-3rem)] rounded-2xl bg-white ring-1 ring-slate-200 shadow-xl p-4 space-y-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** One plain action inside the More menu: a title and a line saying what it does. */
export function MenuAction({ title, hint, onClick, disabled, disabledReason }: {
  title: string; hint: string; onClick: () => void; disabled?: boolean; disabledReason?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={"w-full text-left rounded-lg px-3 py-2 -mx-1 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent " + FOCUS}
    >
      <div className="text-sm font-medium text-slate-900">{title}</div>
      <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
    </button>
  );
}

// ── Progress strip ──

export type StepState = "idle" | "queued" | "running" | "done" | "failed" | "stopped" | "skipped";

function StepDot({ n, state }: { n: number; state: StepState }) {
  const live = state === "running" || state === "queued";
  const cls = state === "done" ? "bg-emerald-600 text-white"
    : live ? "bg-violet-600 text-white"
    : state === "failed" ? "bg-rose-600 text-white"
    : state === "stopped" ? "bg-amber-500 text-white"
    : "bg-slate-100 text-slate-500";
  return (
    <span className={"h-5 w-5 shrink-0 rounded-full inline-flex items-center justify-center text-[11px] font-semibold " + cls}>
      {state === "done" ? <Check className="h-3 w-3" /> : live ? <Loader2 className="h-3 w-3 animate-spin" /> : state === "failed" ? <X className="h-3 w-3" /> : n}
    </span>
  );
}

/**
 * The slim strip under the header while FPX is working in FreightPOP (and just
 * after): where the refresh is, what it is doing, and a way to open the live
 * session, which holds the live view, the log, Pause and Stop.
 */
export function ProgressStrip({ steps, text, tone, expanded, onToggle, onDismiss }: {
  /** The two steps of a refresh; none for an invoice run. */
  steps: { title: string; state: StepState }[] | null;
  text: string;
  tone: "working" | "done" | "failed" | "stopped";
  expanded: boolean;
  onToggle: () => void;
  onDismiss?: () => void;
}) {
  const working = tone === "working";
  return (
    <div
      role="status"
      className={"rounded-xl ring-1 px-4 py-2.5 flex items-center gap-x-4 gap-y-2 flex-wrap text-sm "
        + (tone === "failed" ? "bg-rose-50 ring-rose-200" : tone === "stopped" ? "bg-amber-50 ring-amber-200" : tone === "done" ? "bg-emerald-50 ring-emerald-200" : "bg-white ring-violet-200")}
    >
      {steps ? (
        <div className="flex items-center gap-2 shrink-0">
          {steps.map((s, i) => (
            <span key={s.title} className="inline-flex items-center gap-2" aria-current={s.state === "running" || s.state === "queued" ? "step" : undefined}>
              {i > 0 ? <ChevronRight className="h-4 w-4 text-slate-300" aria-hidden="true" /> : null}
              <StepDot n={i + 1} state={s.state} />
              <span className={s.state === "idle" || s.state === "skipped" ? "text-slate-400" : "text-slate-900 font-medium"}>{s.title}</span>
            </span>
          ))}
        </div>
      ) : working ? (
        <Loader2 className="h-4 w-4 animate-spin text-violet-600 shrink-0" aria-hidden="true" />
      ) : null}
      <span className={"flex-1 min-w-[12rem] break-words " + (tone === "failed" ? "text-rose-800" : tone === "stopped" ? "text-amber-900" : tone === "done" ? "text-emerald-900" : "text-slate-600")}>
        {text}
      </span>
      <span className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={"px-2.5 py-1 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-900/5 inline-flex items-center gap-1 " + FOCUS}
        >
          {expanded ? "Hide live view" : working ? "Show live view · Pause / Stop" : "Show details"}
          <ChevronDown className={"h-4 w-4 transition-transform " + (expanded ? "rotate-180" : "")} aria-hidden="true" />
        </button>
        {onDismiss ? (
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className={"p-1 rounded-lg text-slate-500 hover:bg-slate-900/5 " + FOCUS}>
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

// ── Bulk action ──

/** Sticks to the bottom of the window while shipments are ticked. */
export function SelectionBar({ count, total, moreAfterBatch, blocked, onGet, onClear }: {
  count: number; total: number; moreAfterBatch: boolean; blocked: string | null; onGet: () => void; onClear: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-20 flex justify-center pointer-events-none">
      <div role="region" aria-label="Selected shipments" className="pointer-events-auto rounded-2xl bg-slate-900 text-white shadow-xl px-5 py-3 flex items-center gap-x-5 gap-y-2 flex-wrap max-w-full">
        <div className="text-sm">
          <span className="font-semibold tabular-nums">{fmtNum(count)} selected</span>
          <span className="text-slate-300 tabular-nums"> · {fmtMoney(total)}</span>
          {moreAfterBatch ? <div className="text-xs text-slate-400 mt-0.5">{fmtNum(GET_INVOICE_MAX)} is one run's worth. Run the next batch after this one.</div> : null}
          {blocked ? <div className="text-xs text-amber-300 mt-0.5">{blocked}</div> : null}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button type="button" onClick={onClear} className="px-3 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
            Clear
          </button>
          <button
            type="button"
            onClick={onGet}
            disabled={!!blocked}
            className="px-4 py-2 rounded-lg bg-violet-500 text-white hover:bg-violet-400 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            Get invoices
          </button>
        </div>
      </div>
    </div>
  );
}
