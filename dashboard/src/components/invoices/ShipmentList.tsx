import { useEffect, useRef, useState } from "react";
import { fmtNum } from "../../lib/format";
import {
  SEARCH_FAILED_MESSAGE, fetchHubList, hubApprover, hubDay, hubMoney, hubStep, isAbort,
  type ApproverKind, type HubList, type HubRow, type HubStep,
} from "../../lib/invoicesHub";
import { StaleDot } from "./StaleDot";

// The shipments in one step of the Invoices page, 50 at a time, biggest
// charge first. Read only; clicking a shipment opens its details.

const PAGE = 50;

type ApproverPick = "edi" | "person" | null;
const APPROVER_CHOICES: readonly { key: ApproverPick; label: string }[] = [
  { key: null, label: "Anyone" },
  { key: "edi", label: "EDI" },
  { key: "person", label: "A person" },
];

const TH = "text-[11px] uppercase tracking-wide text-slate-500 font-medium px-4 py-2.5 whitespace-nowrap";
const QUIET_BUTTON = "px-3 py-1.5 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

export function ShipmentList({ step, query, onOpen }: {
  step: HubStep;
  query: string;
  onOpen: (shipmentId: string, row?: HubRow) => void;
}) {
  const info = hubStep(step);
  const q = query.trim();
  const [pick, setPick] = useState<ApproverPick>(null);
  const approvedBy: ApproverKind | null = info.approverFilter ? pick : null;
  const [page, setPage] = useState(0);
  const [list, setList] = useState<HubList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A step without the filter goes back to "Anyone".
  useEffect(() => { if (!info.approverFilter) setPick(null); }, [info.approverFilter]);

  // A new step, search or filter starts again at the first page. The key is
  // compared during render so the fetch below never asks for a stale page.
  const filterKey = `${step}|${q}|${approvedBy ?? ""}`;
  const lastKey = useRef(filterKey);
  let shownPage = page;
  if (lastKey.current !== filterKey) shownPage = 0;
  useEffect(() => {
    if (lastKey.current !== filterKey) { lastKey.current = filterKey; setPage(0); }
  }, [filterKey]);

  // Rows of another step are not shown while the new step loads.
  const listStep = useRef<HubStep | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    fetchHubList({ step, q, approvedBy, limit: PAGE, offset: shownPage * PAGE }, ctl.signal).then(
      (res) => {
        if (ctl.signal.aborted) return;
        listStep.current = step;
        setList(res);
        setLoading(false);
      },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        // A failed search says one plain thing, never what the database said.
        console.warn("[FPX] invoice list failed:", e);
        setError(q ? SEARCH_FAILED_MESSAGE : "The shipments could not be loaded. Try again in a moment.");
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [step, q, approvedBy, shownPage, attempt]);

  const current = list && listStep.current === step ? list : null;
  const rows = current?.data ?? [];
  const total = current?.totals.matching ?? null;
  const offset = current?.offset ?? 0;
  const pageNow = Math.floor(offset / PAGE) + 1;
  const pages = total != null ? Math.max(1, Math.ceil(total / PAGE)) : null;
  const hasNext = total != null ? offset + rows.length < total : rows.length === PAGE;
  const hasPrev = offset > 0;

  const extra: "none" | "invoice" | "approved" =
    step === "no_invoice" ? "none" : step === "invoice_not_approved" ? "invoice" : "approved";
  const columns = extra === "none" ? 5 : 6;

  const countLine = !current
    ? (loading ? "Loading shipments…" : "")
    : rows.length === 0
      ? (total ? `${fmtNum(total)} ${total === 1 ? "shipment" : "shipments"}` : "No shipments")
      : `${fmtNum(offset + 1)}–${fmtNum(offset + rows.length)}${total != null ? ` of ${fmtNum(total)}` : ""} ${total === 1 ? "shipment" : "shipments"}`;

  return (
    <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm overflow-hidden" aria-label={`Shipments: ${info.title}`}>
      <div className="px-5 py-3.5 flex items-center justify-between gap-x-4 gap-y-2 flex-wrap border-b border-slate-200">
        <div className="min-w-0 text-sm">
          <span className="font-medium text-slate-900" aria-live="polite">
            {countLine}{current && q ? <span className="font-normal text-slate-600"> matching “{q}”</span> : null}
          </span>
          <span className="text-slate-500"> · Biggest charge first</span>
        </div>
        {info.approverFilter ? (
          <div className="flex items-center gap-2">
            <span id="hub-approved-by" className="text-xs font-medium text-slate-500">Approved by</span>
            <div role="group" aria-labelledby="hub-approved-by" className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white p-0.5">
              {APPROVER_CHOICES.map((c) => {
                const on = c.key === pick;
                return (
                  <button
                    key={c.label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPick(c.key)}
                    className={"px-3 py-1 rounded-md text-sm whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 "
                      + (on ? "bg-violet-50 text-violet-800 font-medium" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50")}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="px-5 py-3 text-sm text-rose-800 bg-rose-50 border-b border-rose-200">
          {error}{" "}
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="underline text-rose-700 hover:text-rose-900">Try again</button>
        </div>
      ) : null}

      {!current && loading ? (
        <div role="status" aria-label="Loading shipments" className="p-5 space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-9 rounded bg-slate-100 animate-pulse" />)}
        </div>
      ) : !current ? null : rows.length === 0 ? (
        <div className={"px-6 py-12 text-center text-sm text-slate-600 " + (loading ? "opacity-60" : "")}>
          {q ? <>No shipment in this step matches “{q}”.</> : info.empty}
        </div>
      ) : (
        <div className={"overflow-x-auto transition-opacity " + (loading ? "opacity-60" : "")} aria-busy={loading}>
          <table className="w-full text-sm">
            <caption className="sr-only">{info.title}: shipments, biggest charge first. Select a shipment to see its details.</caption>
            <thead>
              <tr className="text-left bg-slate-50">
                <th scope="col" className={TH}>Shipment</th>
                <th scope="col" className={TH}>Customer</th>
                <th scope="col" className={TH}>Carrier</th>
                <th scope="col" className={TH}>Shipped</th>
                <th scope="col" className={TH + " text-right"}>Charge</th>
                {extra === "invoice" ? <th scope="col" className={TH + " text-right"}>Invoice amount</th> : null}
                {extra === "approved" ? <th scope="col" className={TH}>Approved</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const who = hubApprover(r);
                const day = hubDay(r.approved_date);
                const amount = r.approved_amount ?? r.approved_invoice_amount;
                return (
                  <tr key={r.shipment_id} onClick={() => onOpen(r.shipment_id, r)} className="hover:bg-slate-50 cursor-pointer align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpen(r.shipment_id, r); }}
                        title="See this shipment's invoice details"
                        className="font-medium text-sky-700 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                      >
                        {r.shipment_id}
                      </button>
                      <StaleDot lastSeenAt={r.last_seen_at} />
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-800 max-w-[16rem] break-words">{r.customer_name || "—"}</td>
                    <td className="px-4 py-2.5 text-slate-800 max-w-[14rem] break-words">{r.carrier || "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{hubDay(r.shipped_date) || "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-900 whitespace-nowrap">{hubMoney(r.charge)}</td>
                    {extra === "invoice" ? (
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-900 whitespace-nowrap">{hubMoney(r.not_approved_invoice_amount)}</td>
                    ) : null}
                    {extra === "approved" ? (
                      <td className="px-4 py-2.5 text-slate-800">
                        <div className="break-words">
                          {who || day ? <>{who ? `By ${who}` : "Approved"}{day ? ` on ${day}` : ""}</> : "—"}
                        </div>
                        {amount != null ? <div className="text-xs text-slate-500 tabular-nums">{hubMoney(amount)}</div> : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {rows.length === 0 ? <tr><td colSpan={columns} /></tr> : null}
            </tbody>
          </table>
        </div>
      )}

      {current && (hasPrev || hasNext) ? (
        <div className="px-5 py-3 flex items-center justify-between gap-3 border-t border-slate-200">
          <button type="button" disabled={!hasPrev || loading} onClick={() => setPage(Math.max(0, pageNow - 2))} className={QUIET_BUTTON}>Previous</button>
          <span className="text-sm text-slate-500 tabular-nums">Page {fmtNum(pageNow)}{pages != null ? ` of ${fmtNum(pages)}` : ""}</span>
          <button type="button" disabled={!hasNext || loading} onClick={() => setPage(pageNow)} className={QUIET_BUTTON}>Next</button>
        </div>
      ) : null}
    </section>
  );
}
