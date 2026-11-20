import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { DetailsLogLine } from "../lib/hostedBrowser";
import { fmtNum } from "../lib/format";

// Log pane for the shipment details job: a filter bar, the scrolling log and a
// line count. Same look and stick-to-bottom scrolling as ScrapeLog, but the
// level comes straight from the line, so there is no text classification.

type Level = "info" | "warn" | "error" | "done";
interface Row { line: DetailsLogLine; time: string; level: Level; haystack: string }

function fmtTime(t: string): string {
  const d = new Date(t);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

function toRow(line: DetailsLogLine): Row {
  const raw = String(line.level ?? "").toLowerCase();
  const level: Level = raw === "warn" || raw === "error" || raw === "done" ? raw : "info";
  const time = fmtTime(line.t);
  const text = String(line.text ?? "");
  return { line, time, level, haystack: `${time} ${text}`.toLowerCase() };
}

const ROW_CLASS: Record<Level, string> = {
  info: "border-transparent text-slate-300",
  warn: "border-amber-400 bg-amber-400/10 text-amber-200",
  error: "border-rose-400 bg-rose-500/15 text-rose-200",
  done: "border-transparent text-emerald-300 font-semibold",
};

export function DetailsLog({ lines, live = false, note, className }: {
  /** Oldest first; the newest renders at the bottom. */
  lines: DetailsLogLine[];
  /** A job is running now. */
  live?: boolean;
  /** A muted line shown above the lines. */
  note?: string | null;
  /** Applied to the root; the parent gives it height. */
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);

  const rows = useMemo(() => lines.map(toRow), [lines]);
  const errorCount = useMemo(() => rows.filter((r) => r.level === "error").length, [rows]);
  const problemCount = useMemo(() => rows.filter((r) => r.level === "error" || r.level === "warn").length, [rows]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => rows.filter((r) => {
    if (problemsOnly && r.level !== "error" && r.level !== "warn") return false;
    return !q || r.haystack.includes(q);
  }), [rows, q, problemsOnly]);

  // Stick to the newest line unless the user scrolled up to read something.
  // Changing a filter jumps back to the newest line. The server sends only the
  // latest lines, so the count can stay the same while the content moves on:
  // the last line is part of the key.
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const last = lines.length ? lines[lines.length - 1] : null;
  const lastKey = last ? `${last.t}|${last.text}` : "";
  useEffect(() => { stick.current = true; }, [q, problemsOnly]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, lastKey, q, problemsOnly]);

  const loaded = rows.length;

  return (
    <div className={"flex flex-col min-h-0 min-w-0 h-full rounded-lg bg-slate-900 ring-1 ring-slate-800 overflow-hidden " + (className ?? "")}>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 border-b border-slate-800 text-[11px] text-slate-300 font-sans">
        <div className="relative flex-1 min-w-[10rem] max-w-xs">
          <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter lines"
            aria-label="Filter log lines"
            className="w-full rounded-md bg-slate-800 ring-1 ring-slate-700 focus:ring-violet-400 focus:outline-none pl-7 pr-7 py-1 text-xs text-slate-100 placeholder:text-slate-500"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white" title="Clear filter" aria-label="Clear filter">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap hover:text-white" title="Only warnings and errors">
          <input type="checkbox" className="accent-violet-500" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
          Problems only{" "}
          <span className={"tabular-nums " + (errorCount ? "text-rose-300 font-semibold" : problemCount ? "text-amber-300 font-semibold" : "text-slate-400")}>{fmtNum(problemCount)}</span>
        </label>
      </div>

      {/* Lines */}
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="flex-1 min-h-0 overflow-y-auto py-2 font-mono text-[11px] leading-relaxed"
      >
        {note ? <div className="px-3 pb-1.5 font-sans text-xs text-slate-400">{note}</div> : null}
        {loaded === 0 ? (
          <div className="px-3 text-slate-500">{live ? "Waiting for the first log line." : "No log yet."}</div>
        ) : visible.length === 0 ? (
          <div className="px-3 text-slate-400 font-sans text-xs">
            No lines match.{" "}
            <button type="button" onClick={() => { setQuery(""); setProblemsOnly(false); }} className="underline hover:text-white">Clear filters</button>
          </div>
        ) : visible.map((r, i) => (
          <div key={i} className={"flex gap-2 px-3 border-l-2 " + ROW_CLASS[r.level]}>
            <span className="w-[11ch] shrink-0 text-right whitespace-nowrap tabular-nums font-normal text-slate-500">{r.time}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{r.line.text}</span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-slate-800 font-sans text-[11px] text-slate-500 tabular-nums">
        {visible.length < loaded
          ? `Showing ${fmtNum(visible.length)} of ${fmtNum(loaded)} lines`
          : `${fmtNum(loaded)} lines`}
      </div>
    </div>
  );
}
