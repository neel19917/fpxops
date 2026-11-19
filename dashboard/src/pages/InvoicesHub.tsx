import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ErrorBlock } from "../components/ErrorBlock";
import { FindInvoice } from "../components/invoices/FindInvoice";
import { InvoiceDetail } from "../components/invoices/InvoiceDetail";
import { MoreSection } from "../components/invoices/MoreSection";
import { ShipmentList } from "../components/invoices/ShipmentList";
import { StepGuide, StepHint, StepPath } from "../components/invoices/StepPath";
import { UpdatedNote } from "../components/invoices/UpdatedNote";
import { fmtRelative } from "../lib/format";
import { hideFrame } from "../lib/freightpopFrame";
import {
  hubListKey, invalidateHubCache, isHubStep, useHubList, useHubSummary,
  type HubCounts, type HubRow, type HubStep, type HubSummary,
} from "../lib/invoicesHub";

// Invoices: the guided way in. Find any invoice with one search box, or pick
// one of the four steps an invoice goes through to see its shipments and what
// to do next. The search, the step and the open shipment live in the URL
// (?q=, ?step=, ?shipment=), so a link can be shared and Back works.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The later of the two times FPX last read FreightPOP, or null. */
function lastRead(s: HubSummary): string | null {
  const times = [s.transactions?.last_seen_at, s.approvals?.last_seen_at].filter((t): t is string => !!t && Number.isFinite(Date.parse(t)));
  if (!times.length) return null;
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export function InvoicesHubPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const stepParam = params.get("step");
  const step: HubStep | null = isHubStep(stepParam) ? stepParam : null;
  const shipment = (params.get("shipment") ?? "").trim();

  // ── URL state ──

  const setQ = useCallback((next: string) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (next.trim()) n.set("q", next);
      else n.delete("q");
      return n;
    }, { replace: true });
  }, [setParams]);

  const selectStep = useCallback((next: HubStep) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (n.get("step") === next) n.delete("step");
      else n.set("step", next);
      return n;
    });
  }, [setParams]);

  // The row that was clicked, so the drawer has something to show at once.
  const [openedRow, setOpenedRow] = useState<HubRow | null>(null);
  const open = useCallback((shipmentId: string, row?: HubRow) => {
    setOpenedRow(row ?? null);
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("shipment", shipmentId);
      return n;
    });
  }, [setParams]);
  const close = useCallback(() => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("shipment");
      return n;
    });
  }, [setParams]);

  // A shipment opened in FreightPOP from the drawer closes when the page is left.
  useEffect(() => () => { hideFrame(); }, []);

  // ── When FreightPOP was last read ──
  // Both the summary and the counts come from the cache at once (the last
  // answer this tab saw) and are asked for again in the background.

  const summary = useHubSummary();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const summaryData = summary.data;
  const readAt = summaryData ? lastRead(summaryData) : null;
  const stale = !!readAt && now - Date.parse(readAt) > DAY_MS;

  // ── How many shipments are in each step ──

  const countsFilters = { q, limit: 1 };
  const countsKey = hubListKey(countsFilters);
  const countsCall = useHubList(countsFilters);
  const counts: HubCounts | null = countsCall.data?.counts ?? null;

  // When fresh counts differ from the ones shown, the data changed since the
  // last look: cached list pages are marked stale and the open list reloads.
  const [listVersion, setListVersion] = useState(0);
  const seenCounts = useRef<{ key: string; json: string } | null>(null);
  useEffect(() => {
    if (!counts) return;
    const json = JSON.stringify(counts);
    const seen = seenCounts.current;
    seenCounts.current = { key: countsKey, json };
    if (seen && seen.key === countsKey && seen.json !== json) {
      invalidateHubCache(countsKey);
      setListVersion((v) => v + 1);
    }
  }, [counts, countsKey]);

  const refreshAll = useCallback(() => {
    invalidateHubCache(); // the summary and counts hooks ask again on their own
    setListVersion((v) => v + 1);
  }, []);

  const searching = q.trim();
  const quietLink = "text-sm text-slate-500 hover:text-slate-900 underline underline-offset-2 decoration-slate-300 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Invoices</h1>
        <p className="text-sm text-slate-600 mt-1 max-w-3xl">
          Find any invoice, and see where every shipment's invoice stands, from waiting on the carrier to pushed to the ERP.
        </p>
        {!summaryData && summary.refreshing ? (
          <p className="text-xs text-slate-400 mt-2">Checking when FreightPOP was last read…</p>
        ) : readAt ? (
          <p className="text-xs text-slate-500 mt-2">
            {/* `now` keeps this line fresh: the page re-renders each minute. */}
            <span title={new Date(readAt).toLocaleString()}>Data last read from FreightPOP {fmtRelative(readAt)}.</span>
            {stale ? (
              <span className="ml-2 inline-block rounded-md bg-amber-50 text-amber-800 ring-1 ring-amber-200 px-2 py-0.5">
                This is more than a day old, so newer invoices may be missing.
              </span>
            ) : null}
          </p>
        ) : summaryData ? (
          <p className="text-xs text-slate-500 mt-2">Nothing has been read from FreightPOP yet.</p>
        ) : null}
      </header>

      <FindInvoice query={q} onQueryChange={setQ} onOpen={open} totalKnown={summaryData?.transactions?.rows ?? null} />

      <section aria-labelledby="invoices-steps-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 id="invoices-steps-title" className="text-lg font-semibold text-slate-900">Where every invoice stands</h2>
            {searching ? (
              <p className="text-sm text-slate-600 mt-0.5">
                Counts show only shipments matching “{searching}”.{" "}
                <button type="button" onClick={() => setQ("")} className={quietLink}>Clear search</button>
              </p>
            ) : null}
          </div>
          <UpdatedNote
            updatedAt={countsCall.updatedAt}
            refreshing={countsCall.refreshing || summary.refreshing}
            error={countsCall.data ? countsCall.error : null}
            onRefresh={refreshAll}
          />
        </div>

        {countsCall.error && !countsCall.data ? (
          <ErrorBlock>
            The step counts could not be loaded. {countsCall.error}{" "}
            <button type="button" onClick={countsCall.refresh} className="underline ml-1">Try again</button>
          </ErrorBlock>
        ) : null}

        <StepPath selected={step} counts={counts} loading={countsCall.refreshing} onSelect={selectStep} />

        {step ? (
          <>
            <StepGuide step={step} count={counts?.[step] ?? null} />
            <ShipmentList key={listVersion} step={step} query={q} onOpen={open} />
          </>
        ) : (
          <StepHint counts={counts} onSelect={selectStep} />
        )}
      </section>

      <MoreSection />

      {shipment ? (
        <InvoiceDetail
          key={shipment}
          shipmentId={shipment}
          row={openedRow && String(openedRow.shipment_id) === shipment ? openedRow : undefined}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
