import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { hostedBrowser, type ScrapeLogLine } from "../lib/hostedBrowser";
import { fmtNum } from "../lib/format";

// Scrape log viewer: a filter bar, the scrolling log, and a footer with the
// line counts and the full-log download.
//
// A run writes one "Scraped …" line per shipment, which buries the lines that
// show the run's shape (pages, uploads, the result) and its problems. So the
// per-shipment lines are hidden by default, unless they are problems
// themselves. Lines are classified by the level the hosted browser sends plus
// forgiving text matches; anything unrecognised stays a plain line.

type Severity = "error" | "warn" | null;
interface Row { line: ScrapeLogLine; time: string; shipment: boolean; severity: Severity; milestone: boolean; haystack: string }

// A label some lines may carry in front of the text ("WARN: …", "[error] …",
// "⚠ …"). Removed before looking at how the line starts.
const LEAD_RE = /^(?:\s*(?:[[(]?\b(?:warn(?:ing)?|error|err|info|retry|debug)\b[\])]?\s*[:\-–—]?|[^\w\s]+)\s*)*/i;
const LEAD_ERROR_RE = /^\s*(?:[[(]?\s*(?:error|err|fail(?:ed|ure)?)\b|[✗✖❌⛔])/i;
const LEAD_WARN_RE = /^\s*(?:[[(]?\s*(?:warn(?:ing)?|retry)\b|[⚠❗])/i;

const SHIPMENT_RE = /^scraped\b/i;
// "0 failed", "no errors": mentions of a problem word that are not problems.
const NO_PROBLEM_RE = /\b(?:0|no|zero|without)\s+(?:upload\s+)?(?:errors?|failures?|failed|retries|retried|warnings?|skipped|timeouts?)\b/gi;
const ERROR_RE = /\b(?:errors?|fail(?:ed|ure|ures|s|ing)?|could\s?n[o']t|cannot|can't|unable to|exception|crash(?:ed)?|aborted|gave up|expired)\b/i;
const WARN_RE = /\b(?:retry|retries|retried|retrying|queued for retry|warn(?:ing|ings)?|time(?:d|s)?[\s-]?out|skipp?(?:ed|ing)|stop requested|partial|grid data only|not found|missing)\b/i;
// A per-shipment line carries shipment data (status, carrier, customer), so a
// status like "Delivery Failed" must not count. Only the scraper's own note.
const SHIPMENT_WARN_RE = /\(?\b(?:grid data only|partial)\b/i;
const MILESTONE_RE = /^(?:page\s+\d+|uploading|uploaded|saved|archived|done\b|finished|complete|failed\b|upload failed|grid loaded|opened|start(?:ing|ed)\b|limited to|stop requested|scheduled run|manual run|refresh all|checking for next page|no more pages|last page)/i;
const PAGE_RE = /\bpage\s+\d+\b/i;

function fmtTime(t: string): string {
  const d = new Date(t);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

function classify(line: ScrapeLogLine): Row {
  const text = String(line.text ?? "");
  const level = String(line.level ?? "").toLowerCase();
  const body = text.replace(LEAD_RE, "");
  const shipment = level === "data" || SHIPMENT_RE.test(body);

  let severity: Severity = null;
  if (level === "error" || level === "fatal" || LEAD_ERROR_RE.test(text)) severity = "error";
  else if (level === "warn" || level === "warning" || LEAD_WARN_RE.test(text)) severity = "warn";
  else if (shipment) severity = SHIPMENT_WARN_RE.test(body) ? "warn" : null;
  else {
    const t = body.replace(NO_PROBLEM_RE, "");
    severity = ERROR_RE.test(t) ? "error" : WARN_RE.test(t) ? "warn" : null;
  }

  const milestone = !shipment && (level === "done" || MILESTONE_RE.test(body) || PAGE_RE.test(body));
  const time = fmtTime(line.t);
  return { line, time, shipment, severity, milestone, haystack: `${time} ${text}`.toLowerCase() };
}

function rowClass(r: Row): string {
  if (r.severity === "error") return "border-rose-400 bg-rose-500/15 text-rose-200" + (r.shipment ? "" : " font-medium");
  if (r.severity === "warn") return "border-amber-400 bg-amber-400/10 text-amber-200" + (r.shipment ? "" : " font-medium");
  if (String(r.line.level) === "done") return "border-transparent text-emerald-300 font-semibold";
  if (r.milestone) return "border-transparent text-slate-100 font-semibold";
  if (r.shipment) return "border-transparent text-sky-200/90";
  return "border-transparent text-slate-300";
}

export function ScrapeLog({ lines, total, live = false, tall = false }: {
  lines: ScrapeLogLine[];
  /** Lines in the whole run. The page only gets the latest few hundred. */
  total?: number;
  live?: boolean;
  /** Fill the parent's height (full-screen view). */
  tall?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [showShipments, setShowShipments] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rows = useMemo(() => lines.map(classify), [lines]);
  const shipmentCount = useMemo(() => rows.filter((r) => r.shipment).length, [rows]);
  const problemCount = useMemo(() => rows.filter((r) => r.severity).length, [rows]);
  const errorCount = useMemo(() => rows.filter((r) => r.severity === "error").length, [rows]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => rows.filter((r) => {
    if (problemsOnly && !r.severity) return false;
    // Typing a filter searches every line, so a tracking number is found
    // even while the per-shipment lines are hidden.
    if (q) return r.haystack.includes(q);
    return showShipments || !r.shipment || !!r.severity;
  }), [rows, q, showShipments, problemsOnly]);

  // Stick to the newest line unless the user scrolled up to read something.
  // Changing a filter jumps back to the newest line.
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useEffect(() => { stick.current = true; }, [q, showShipments, problemsOnly, expanded]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, q, showShipments, problemsOnly, expanded]);

  const loaded = rows.length;
  const hidden = loaded - visible.length;
  const filtered = !!q || problemsOnly;
  const windowed = total != null && total > loaded;
  const hiddenWhy = filtered ? "by the filters" : "per-shipment lines";

  const check = "inline-flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap hover:text-white";

  return (
    <div className={"flex flex-col min-w-0 " + (tall ? "h-full min-h-0" : "")}>
      <div className={"flex flex-col min-w-0 rounded-lg bg-slate-900 ring-1 ring-slate-800 overflow-hidden "
        + (tall ? "flex-1 min-h-[300px]" : live ? (expanded ? "h-[75vh]" : "h-[420px]") : "")}>
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 border-b border-slate-800 text-[11px] text-slate-300 font-sans">
          <div className="relative flex-1 min-w-[10rem] max-w-xs">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter lines…"
              aria-label="Filter log lines"
              className="w-full rounded-md bg-slate-800 ring-1 ring-slate-700 focus:ring-violet-400 focus:outline-none pl-7 pr-7 py-1 text-xs text-slate-100 placeholder:text-slate-500"
            />
            {query ? (
              <button onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white" title="Clear filter" aria-label="Clear filter">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <label className={check} title="One line per shipment scraped. Hidden by default; problem lines always show.">
            <input type="checkbox" className="accent-violet-500" checked={showShipments} onChange={(e) => setShowShipments(e.target.checked)} />
            Shipment lines <span className="tabular-nums text-slate-400">{fmtNum(shipmentCount)}</span>
          </label>
          <label className={check} title="Only warnings, retries, skips and errors">
            <input type="checkbox" className="accent-violet-500" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
            Problems only{" "}
            <span className={"tabular-nums " + (errorCount ? "text-rose-300 font-semibold" : problemCount ? "text-amber-300 font-semibold" : "text-slate-400")}>{fmtNum(problemCount)}</span>
          </label>
          {!tall ? (
            <button onClick={() => setExpanded((v) => !v)} className="ml-auto inline-flex items-center gap-1 text-slate-400 hover:text-white whitespace-nowrap">
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {expanded ? "Shorter" : "Taller"}
            </button>
          ) : null}
        </div>

        {/* Lines */}
        <div
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className={"flex-1 min-h-0 overflow-y-auto py-2 font-mono text-[11px] leading-relaxed "
            + (tall || live ? "" : expanded ? "max-h-[75vh]" : "max-h-96")}
        >
          {loaded === 0 ? (
            <div className="px-3 text-slate-500">{live ? "Waiting for the first log line…" : "No log."}</div>
          ) : visible.length === 0 ? (
            <div className="px-3 text-slate-400 font-sans text-xs">
              {problemsOnly && !q ? "No problems in these lines." : "No lines match."}{" "}
              <button onClick={() => { setQuery(""); setProblemsOnly(false); }} className="underline hover:text-white">Clear filters</button>
            </div>
          ) : visible.map((r, i) => (
            <div key={i} className={"flex gap-2 px-3 border-l-2 " + rowClass(r)}>
              <span className="w-[11ch] shrink-0 text-right whitespace-nowrap tabular-nums font-normal text-slate-500">{r.time}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{r.line.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] text-slate-500 mt-1">
        <span>
          {hidden > 0
            ? `Showing ${fmtNum(visible.length)} of ${fmtNum(loaded)} lines · ${fmtNum(hidden)} hidden (${hiddenWhy})`
            : `${fmtNum(loaded)} lines`}
          {windowed ? ` · latest ${fmtNum(loaded)} of ${fmtNum(total)} in this run` : ""}
          {err ? <span className="text-rose-600"> · {err}</span> : null}
        </span>
        <button
          onClick={() => { setErr(null); hostedBrowser.downloadLog().catch((e) => setErr((e as Error).message)); }}
          className="underline hover:text-slate-800"
          title="Every line of the run, unfiltered"
        >
          Download full log
        </button>
      </div>
    </div>
  );
}
