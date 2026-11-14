import { fmtNum } from "../../lib/format";
import { fmtDollars, type BucketKey } from "./model";

// The three buckets, as large buttons. The selected one decides what the
// table below shows.

export interface BucketCard {
  key: BucketKey;
  label: string;
  count: number;
  total: number;
  /** One line under the numbers: who approved, or why not. */
  breakdown: string;
}

const TONE: Record<BucketKey, { dot: string; count: string; on: string }> = {
  approved: { dot: "bg-emerald-500", count: "text-emerald-700", on: "ring-2 ring-emerald-500 bg-emerald-50/50" },
  "not-approved": { dot: "bg-amber-500", count: "text-amber-700", on: "ring-2 ring-amber-500 bg-amber-50/50" },
  sent: { dot: "bg-slate-400", count: "text-slate-800", on: "ring-2 ring-slate-500 bg-slate-50" },
};

export function BucketCards({ cards, selected, onSelect }: {
  cards: BucketCard[]; selected: BucketKey; onSelect: (key: BucketKey) => void;
}) {
  return (
    <div className="grid gap-4 min-[900px]:grid-cols-[1.3fr_1fr_1fr]" role="group" aria-label="Shipments by invoice status">
      {cards.map((c) => {
        const tone = TONE[c.key];
        const on = selected === c.key;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onSelect(c.key)}
            aria-pressed={on}
            className={"text-left rounded-2xl p-6 shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 "
              + (on ? tone.on : "bg-white ring-1 ring-slate-200 hover:ring-slate-300 hover:bg-slate-50/60")}
          >
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <span className={"h-2 w-2 rounded-full " + tone.dot} aria-hidden="true" />
              {c.label}
            </div>
            <div className="mt-3 flex items-baseline gap-3 flex-wrap">
              <span className={"text-5xl font-semibold tracking-tight tabular-nums leading-none " + tone.count}>{fmtNum(c.count)}</span>
              <span className="text-base text-slate-600 tabular-nums">{fmtDollars(c.total)}</span>
            </div>
            <div className="mt-3 text-sm text-slate-500">{c.breakdown}</div>
          </button>
        );
      })}
    </div>
  );
}

export function BucketCardsSkeleton() {
  return (
    <div className="grid gap-4 min-[900px]:grid-cols-[1.3fr_1fr_1fr]" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-6">
          <div className="h-4 w-28 rounded bg-slate-100 animate-pulse" />
          <div className="mt-4 h-10 w-24 rounded bg-slate-100 animate-pulse" />
          <div className="mt-4 h-4 w-48 max-w-full rounded bg-slate-100 animate-pulse" />
        </div>
      ))}
    </div>
  );
}
