// Shared constants, helpers and small UI atoms for the Tasks v2 board.
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { TaskBoardRow, TaskFlag, TaskPriority, TaskSegment, TaskStatus } from "../../lib/types";
import { carrierTrackingUrl } from "../../lib/format";

export type SegFilter = "all" | "attention" | TaskSegment;
export type GroupBy = "none" | "segment" | "carrier" | "customer" | "assignee" | "shipment" | "mode";
export type SortBy = "smart" | "age" | "priority" | "scrape";

export const BOARD_KEY = "tasks.v2.board";
export const PREF_KEY = "fpx.tasks.v2.prefs";

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
export const PRIORITY_CLS: Record<TaskPriority, string> = {
  urgent: "bg-rose-100 text-rose-800 ring-rose-200",
  high: "bg-amber-100 text-amber-800 ring-amber-200",
  normal: "bg-sky-50 text-sky-800 ring-sky-200",
  low: "bg-slate-100 text-slate-600 ring-slate-200",
};
export const STATUS_CLS: Record<TaskStatus, string> = {
  open: "bg-slate-100 text-slate-700 ring-slate-200",
  in_progress: "bg-indigo-100 text-indigo-800 ring-indigo-200",
  blocked: "bg-amber-100 text-amber-800 ring-amber-200",
  done: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  cancelled: "bg-slate-100 text-slate-500 ring-slate-200 line-through",
};
export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open", in_progress: "In progress", blocked: "Blocked", done: "Done", cancelled: "Dismissed",
};
export const SEGMENT_CLS: Record<TaskSegment, string> = {
  redelivery: "bg-rose-50 text-rose-800 ring-rose-200",
  return_claim: "bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-200",
  storage_risk: "bg-amber-50 text-amber-900 ring-amber-300",
  carrier: "bg-sky-50 text-sky-800 ring-sky-200",
  customer: "bg-teal-50 text-teal-800 ring-teal-200",
  other: "bg-slate-100 text-slate-700 ring-slate-200",
};
export const SEGMENT_SHORT: Record<TaskSegment, string> = {
  redelivery: "Redelivery", return_claim: "Return / claim", storage_risk: "Storage risk", carrier: "Carrier", customer: "Customer", other: "Other",
};
export const FLAG_CLS: Record<string, string> = {
  emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  violet: "bg-violet-50 text-violet-800 ring-violet-200",
  rose: "bg-rose-50 text-rose-800 ring-rose-200",
  orange: "bg-orange-50 text-orange-800 ring-orange-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};
export const DISPOSITION_LABEL: Record<string, string> = {
  resolved: "Resolved upstream", stale: "Stale data", duplicate: "Duplicate", superseded: "Superseded", not_actionable: "Not actionable",
};

export function isActive(s: TaskStatus) { return s === "open" || s === "in_progress" || s === "blocked"; }

// Same bucketing rule as the classic page so a status reads the same color
// on both boards.
export function shipmentStatusTone(status: string | null | undefined): { label: string; cls: string } {
  const raw = (status || "").trim();
  const s = raw.toLowerCase();
  if (!s) return { label: "no status", cls: "bg-slate-100 text-slate-500 ring-slate-200" };
  if (s.includes("deliver")) return { label: raw, cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" };
  if (s.includes("out for")) return { label: raw, cls: "bg-teal-50 text-teal-800 ring-teal-200" };
  if (s.includes("transit") || s.includes("en route") || s.includes("moving")) return { label: raw, cls: "bg-sky-50 text-sky-800 ring-sky-200" };
  if (s.includes("issue") || s.includes("exception") || s.includes("problem") || s.includes("delay")) return { label: raw, cls: "bg-rose-50 text-rose-800 ring-rose-200" };
  if (s.includes("pickup") || s.includes("booked") || s.includes("scheduled") || s.includes("dispatch")) return { label: raw, cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  return { label: raw, cls: "bg-slate-100 text-slate-700 ring-slate-200" };
}

export function Pill({ children, cls, title }: { children: ReactNode; cls: string; title?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 whitespace-nowrap ${cls}`} title={title}>
      {children}
    </span>
  );
}

// Tracking number as a link: click opens the task/shipment in the drawer,
// the small arrow opens the carrier's public tracking page in a new tab.
export function TrackingLink({ tracking, carrier, onOpen, className = "" }: {
  tracking: string | null | undefined; carrier?: string | null; onOpen?: () => void; className?: string;
}) {
  const tn = (tracking || "").trim();
  if (!tn) return <span className={`font-mono text-slate-400 ${className}`}>—</span>;
  const ext = carrierTrackingUrl(carrier, tn);
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {onOpen ? (
        <button type="button" onClick={onOpen} className="font-mono text-sky-700 hover:text-sky-900 hover:underline" title="Open in FPX">{tn}</button>
      ) : (
        <span className="font-mono text-slate-800">{tn}</span>
      )}
      {ext ? (
        <a href={ext} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-slate-400 hover:text-sky-700" title={`Track on ${carrier || "carrier site"}`} aria-label="Carrier tracking page">
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </span>
  );
}

// Strip the "Carrier followup: Redelivery — " scaffolding so the title
// column shows the actual ask; the segment badge already says the rest.
export function shortTitle(title: string): string {
  return title
    .replace(/^(carrier|customer) followup:\s*/i, "")
    .replace(/^(redelivery|return\/claim|storage risk) — /i, "")
    .trim();
}

export interface Prefs { seg: SegFilter; flags: TaskFlag[]; groupBy: GroupBy; sortBy: SortBy; triageOpen: boolean; dailyOpen: boolean; includeClosed: boolean; onDashboardOnly: boolean }
export const DEFAULT_PREFS: Prefs = { seg: "all", flags: [], groupBy: "none", sortBy: "smart", triageOpen: true, dailyOpen: true, includeClosed: false, onDashboardOnly: true };

// A shipment has "left the FreightPOP dashboard" when it wasn't seen within
// this long of the NEWEST scrape on the board. Relative to the latest scrape,
// not to now, so a quiet day without scraping doesn't hide every task.
// (Delivered shipments drop off FreightPOP's dashboard; the full-sweep
// auto-archive only runs when a Refresh All completes unfiltered.)
export const OFF_DASHBOARD_WINDOW_MS = 24 * 3600_000;

// Delivered shipments FreightPOP still lists as "In Transit" (signed POD, no
// status flip yet): the tracking comment or the AI's read says delivered and
// nothing's wrong. Claim / damage / return / redelivery tasks stay — those
// are exactly the post-delivery work.
export const POST_DELIVERY_WORK = /\b(claim|damage|shortage|overage|refus|return|redeliver|storage|osd)\w*/i;
export function looksDelivered(r: TaskBoardRow): boolean {
  const s = r.shipment;
  if (!s) return false;
  if (POST_DELIVERY_WORK.test(`${r.task.title || ""} ${r.task.description || ""}`)) return false;
  if (s.delivery_date) return true;
  if (/^\s*delivered\b/i.test(s.tracking_comments || "")) return true;
  return String(s.action_required || "").toUpperCase() === "NO" && /\bdelivered (on|at)\b/i.test(s.ai_issue || "");
}
export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

export function IconBtn({ children, title, onClick, cls }: { children: ReactNode; title: string; onClick: () => void; cls: string }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} className={`p-1.5 rounded-md transition ${cls}`}>{children}</button>;
}

// Shipment mode of a task's shipment, as FreightPOP names it ("LTL",
// "Truckload", "Parcel"); "" when the task has no shipment or no mode.
export const taskMode = (r: { shipment: { mode?: string | null } | null }) => (r.shipment?.mode || "").trim();
export const MODE_CLS: Record<string, string> = {
  LTL: "bg-sky-100 text-sky-800 ring-sky-200",
  Truckload: "bg-indigo-100 text-indigo-800 ring-indigo-200",
  Parcel: "bg-amber-100 text-amber-800 ring-amber-200",
};

// Opens every task in its own browser tab. Past SLOW_TABS it warns first that
// loading takes a moment. Returns the ids the browser's pop-up blocker
// refused (empty when all opened, or when the user backed out).
export const SLOW_TABS = 20;
export function openTasksInTabs(ids: string[], { quiet = false } = {}): string[] {
  if (!quiet && ids.length > SLOW_TABS && !window.confirm(`Opening ${ids.length} tabs. That many will take a second to load.`)) return [];
  return ids.filter((id) => !window.open(`/tasks/v2/${id}`, "_blank"));
}

// Shown when the pop-up blocker stopped some tabs. A browser lets a site open
// one tab per click until pop-ups are allowed for it, so this explains the
// one-time fix and offers a retry for the tabs that didn't open.
export function BlockedTabsDialog({ ids, total, onRetry, onClose }: { ids: string[]; total: number; onRetry: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 p-5" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label="Tabs blocked">
        <h2 className="font-semibold text-slate-900">Your browser blocked {ids.length} of {total} tabs</h2>
        <p className="mt-2 text-sm text-slate-600">
          {total - ids.length} opened. Browsers only let a site open several tabs at once after you allow pop-ups for it. This is a one-time setting:
        </p>
        <ol className="mt-2 text-sm text-slate-700 list-decimal pl-5 space-y-1">
          <li>Click the icon at the <b>left</b> of the address bar (next to the web address), then <b>Site settings</b>.</li>
          <li>Find <b>Pop-ups and redirects</b> and change it to <b>Allow</b>.</li>
          <li>Come back to this tab and press <b>Open the other {ids.length}</b>.</li>
        </ol>
        <p className="mt-2 text-xs text-slate-500">
          No Site settings there? Open a new tab, go to <span className="font-mono">chrome://settings/content/popups</span>, and under
          “Allowed to send pop-ups” add <span className="font-mono">{window.location.origin}</span>.
          Or skip tabs: “Open {total}” steps through the same tasks in the drawer with no permission needed.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">Close</button>
          <button onClick={onRetry} className="rounded-lg px-3 py-2 text-sm bg-slate-900 text-white hover:bg-slate-800">Open the other {ids.length}</button>
        </div>
      </div>
    </div>
  );
}
