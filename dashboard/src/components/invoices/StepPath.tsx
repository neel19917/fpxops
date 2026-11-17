import { Link } from "react-router-dom";
import { ArrowRight, ChevronRight } from "lucide-react";
import { fmtNum } from "../../lib/format";
import { HUB_STEPS, hubStep, hubStepNumber, type HubCounts, type HubStep } from "../../lib/invoicesHub";

// The guided part of the Invoices page: the four steps an invoice goes
// through, in the order the work happens, and a plain guide for the one picked.

export function StepPath({ selected, counts, loading, onSelect }: {
  selected: HubStep | null;
  counts: HubCounts | null;
  loading: boolean;
  onSelect: (step: HubStep) => void;
}) {
  return (
    <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 list-none p-0 m-0">
      {HUB_STEPS.map((info, i) => {
        const on = info.key === selected;
        const count = counts ? counts[info.key] : null;
        const waiting = loading && !counts;
        return (
          <li key={info.key} className="relative flex">
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(info.key)}
              className={"w-full rounded-xl p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 "
                + (on ? "ring-2 ring-violet-500 bg-violet-50/40" : "ring-1 ring-slate-200 bg-white hover:ring-slate-300")}
            >
              <div className="flex items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className={"h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold tabular-nums "
                    + (on ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600")}
                >
                  {hubStepNumber(info.key)}
                </span>
                <span className="text-sm font-semibold text-slate-900 leading-snug">
                  <span className="sr-only">Step {hubStepNumber(info.key)} of {HUB_STEPS.length}: </span>
                  {info.title}
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                {waiting ? (
                  <span role="status" aria-label="Counting" className="inline-block h-8 w-20 rounded bg-slate-100 animate-pulse" />
                ) : (
                  <>
                    <span className="text-3xl font-semibold tracking-tight tabular-nums text-slate-900">{count == null ? "—" : fmtNum(count)}</span>
                    <span className="text-sm text-slate-500">{count === 1 ? "shipment" : "shipments"}</span>
                  </>
                )}
              </div>
              <p className="mt-2 text-sm text-slate-600 leading-snug">{info.meaning}</p>
            </button>
            {i < HUB_STEPS.length - 1 ? (
              <span
                aria-hidden="true"
                // Centred in the gap (gap-3) between this card and the next.
                className="hidden lg:flex pointer-events-none absolute top-1/2 left-full ml-1.5 z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white ring-1 ring-slate-200 text-slate-400"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

const NOTHING: Partial<Record<HubStep, string>> = {
  approved_ready: "Nothing to send right now.",
  exported: "Nothing to match yet.",
};

export function StepGuide({ step, count }: { step: HubStep; count: number | null }) {
  const info = hubStep(step);
  return (
    <section className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-5" aria-label={`About step ${hubStepNumber(step)}: ${info.title}`}>
      <h3 className="text-base font-semibold text-slate-900">Step {hubStepNumber(step)} of {HUB_STEPS.length}: {info.title}</h3>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
        <div>
          <h4 className="text-sm font-medium text-slate-500">What this means</h4>
          <p className="mt-1 text-sm text-slate-700 leading-relaxed">{info.what}</p>
        </div>
        <div>
          <h4 className="text-sm font-medium text-slate-500">What to do next</h4>
          <p className="mt-1 text-sm text-slate-700 leading-relaxed">{info.next}</p>
        </div>
      </div>
      {info.action ? (
        <div className="mt-4">
          {count === 0 ? (
            <p className="text-sm text-slate-500">{NOTHING[step] ?? "Nothing to do right now."}</p>
          ) : (
            <Link
              to={info.action.to}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 text-sm font-medium inline-flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
            >
              {info.action.label} <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )}
        </div>
      ) : null}
    </section>
  );
}
