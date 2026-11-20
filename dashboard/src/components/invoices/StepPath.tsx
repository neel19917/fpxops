import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { fmtNum } from "../../lib/format";
import { HUB_STEPS, hubStep, hubStepNumber, invalidateHubCache, type HubCounts, type HubStep } from "../../lib/invoicesHub";

// The guided part of the Invoices page: the four steps an invoice goes
// through, in the order the work happens, and a plain guide for the one picked.
// Steps 2 and 3 are where people do the work, so they lead; steps 1 and 4 are
// quieter, since nothing needs doing there.

const NEEDS_WORK: Partial<Record<HubStep, { tag: string; edge: string; tagCls: string }>> = {
  invoice_not_approved: { tag: "To approve", edge: "before:bg-amber-400", tagCls: "bg-amber-50 text-amber-800 ring-amber-200" },
  approved_ready: { tag: "To send", edge: "before:bg-violet-500", tagCls: "bg-violet-50 text-violet-800 ring-violet-200" },
};

const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";

export function StepPath({ selected, counts, loading, onSelect }: {
  selected: HubStep | null;
  counts: HubCounts | null;
  loading: boolean;
  onSelect: (step: HubStep) => void;
}) {
  const waiting = loading && !counts;
  return (
    <ol
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(0,0.85fr)] gap-3 list-none p-0 m-0"
    >
      {HUB_STEPS.map((info) => {
        const on = info.key === selected;
        const count = counts ? counts[info.key] : null;
        const work = NEEDS_WORK[info.key];
        const n = hubStepNumber(info.key);
        const countText = count == null ? "—" : fmtNum(count);
        return (
          <li key={info.key} className="flex min-w-0">
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(info.key)}
              title={work ? undefined : info.meaning}
              className={
                "relative w-full overflow-hidden rounded-xl text-left transition-colors " + FOCUS + " "
                + (work
                  ? "p-4 before:absolute before:inset-y-0 before:left-0 before:w-1 " + work.edge + " "
                  : "px-4 py-3 ")
                + (on
                  ? "ring-2 ring-violet-600 bg-violet-50/60"
                  : work
                    ? "ring-1 ring-slate-200 bg-white shadow-sm hover:ring-slate-300"
                    : "ring-1 ring-slate-200 bg-slate-50 hover:bg-white hover:ring-slate-300")
              }
            >
              <span className="sr-only">Step {n} of {HUB_STEPS.length}: </span>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={"h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold tabular-nums "
                    + (on ? "bg-violet-600 text-white" : work ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600")}
                >
                  {n}
                </span>
                <span className={"min-w-0 text-sm leading-snug " + (work ? "font-semibold text-slate-900" : "font-medium text-slate-600")}>
                  {info.title}
                </span>
              </span>

              <span className={"flex items-baseline gap-1.5 " + (work ? "mt-3" : "mt-1.5")}>
                {waiting ? (
                  <span role="status" aria-label="Counting" className={"inline-block rounded bg-slate-200/70 animate-pulse " + (work ? "h-8 w-20" : "h-5 w-14")} />
                ) : (
                  <>
                    <span className={"tabular-nums tracking-tight " + (work ? "text-3xl font-semibold text-slate-900" : "text-lg font-medium text-slate-500")}>
                      {countText}
                    </span>
                    <span className={work ? "text-sm text-slate-500" : "text-xs text-slate-400"}>{count === 1 ? "shipment" : "shipments"}</span>
                    {work && count != null && count > 0 ? (
                      <span className={"ml-auto self-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 " + work.tagCls}>{work.tag}</span>
                    ) : null}
                  </>
                )}
              </span>

              {work ? <span className="mt-1.5 block text-xs text-slate-500 leading-snug">{info.meaning}</span> : <span className="sr-only">. {info.meaning}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Shown in place of a step's shipments when no step is picked: one line, and a way straight into the work. */
export function StepHint({ counts, onSelect }: { counts: HubCounts | null; onSelect: (step: HubStep) => void }) {
  const toApprove = counts?.invoice_not_approved ?? 0;
  const toSend = counts?.approved_ready ?? 0;
  const chip = "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm font-medium ring-1 " + FOCUS;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
      <span>Pick a step to see its shipments and what to do next.</span>
      {toApprove > 0 || toSend > 0 ? (
        <span className="flex flex-wrap items-center gap-2">
          {toApprove > 0 ? (
            <button type="button" onClick={() => onSelect("invoice_not_approved")} className={chip + " bg-white text-amber-800 ring-amber-200 hover:bg-amber-50"}>
              {fmtNum(toApprove)} to approve <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          {toSend > 0 ? (
            <button type="button" onClick={() => onSelect("approved_ready")} className={chip + " bg-white text-violet-800 ring-violet-200 hover:bg-violet-50"}>
              {fmtNum(toSend)} to send <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const NOTHING: Partial<Record<HubStep, string>> = {
  approved_ready: "Nothing to send right now.",
  exported: "Nothing to match yet.",
};

export function StepGuide({ step, count }: { step: HubStep; count: number | null }) {
  const info = hubStep(step);
  const work = !!NEEDS_WORK[step];
  return (
    <section className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-4 sm:p-5" aria-labelledby="invoices-step-guide-title">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <h3 id="invoices-step-guide-title" className="text-base font-semibold text-slate-900">
          Step {hubStepNumber(step)} of {HUB_STEPS.length}: {info.title}
        </h3>
        {info.action ? (
          count === 0 ? (
            <p className="text-sm text-slate-500">{NOTHING[step] ?? "Nothing to do right now."}</p>
          ) : (
            <Link
              to={info.action.to}
              // Sending or matching changes what this page counts: the next look asks the server.
              onClick={() => invalidateHubCache()}
              className={"shrink-0 px-3.5 py-1.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 " + FOCUS + " "
                + (work ? "bg-violet-600 text-white hover:bg-violet-700" : "bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-100")}
            >
              {info.action.label} <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
        <div>
          <dt className="font-medium text-slate-500">What this means</dt>
          <dd className="mt-0.5 text-slate-700 leading-relaxed">{info.what}</dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">What to do next</dt>
          <dd className="mt-0.5 text-slate-700 leading-relaxed">{info.next}</dd>
        </div>
      </dl>
    </section>
  );
}
