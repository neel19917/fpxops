import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Search, X } from "lucide-react";
import { fmtNum } from "../../lib/format";
import {
  HUB_STEP_SHORT, SEARCH_FAILED_MESSAGE, fetchHubList, hubDay, hubMoney, isAbort, searchInvoiceDocs,
  type HubList, type HubRow, type InvoiceDocHit,
} from "../../lib/invoicesHub";
import { StaleDot } from "./StaleDot";

// The search at the top of the Invoices page: one box that looks through every
// shipment FPX has read from FreightPOP and through the text read off saved
// invoice documents. Read only.

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;
const SHOWN = 8;

type Shipments =
  | { status: "loading" }
  | { status: "ready"; list: HubList }
  | { status: "error" };

/** null = still looking, or not available: the group is not shown. */
type Docs = InvoiceDocHit[] | null;

const rowCls = "w-full text-left px-3 py-3 flex items-center gap-x-4 gap-y-1 flex-wrap rounded-lg hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";
const groupTitle = "text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1";

function docTitle(d: InvoiceDocHit): string {
  if (d.invoice_number) return `Invoice ${d.invoice_number}`;
  if (d.doc_type) return d.doc_type.replace(/_/g, " ");
  return (d.file || "").split("/").pop() || "Saved document";
}

export function FindInvoice({ query, onQueryChange, onOpen, totalKnown }: {
  query: string;
  onQueryChange: (q: string) => void;
  onOpen: (shipmentId: string, row?: HubRow) => void;
  totalKnown?: number | null;
}) {
  const [text, setText] = useState(query);
  // What is being searched for: the text, once typing has stopped.
  const [term, setTerm] = useState(query.trim());
  const [attempt, setAttempt] = useState(0);
  const [shipments, setShipments] = useState<Shipments>({ status: "loading" });
  const [docs, setDocs] = useState<Docs>(null);
  const [docsDone, setDocsDone] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last value this box reported, so its own echo is not taken for a change from outside.
  const reported = useRef(query.trim());
  const onChangeRef = useRef(onQueryChange);
  onChangeRef.current = onQueryChange;

  function commit(value: string) {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const v = value.trim();
    setTerm(v);
    if (v !== reported.current) {
      reported.current = v;
      onChangeRef.current(v);
    }
  }

  function onType(value: string) {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    if (!value.trim()) { commit(""); return; }
    timer.current = setTimeout(() => commit(value), DEBOUNCE_MS);
  }

  // The query changed from outside (Back, a shared link): show it.
  useEffect(() => {
    const q = query.trim();
    if (q === reported.current) return;
    reported.current = q;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setText(query);
    setTerm(q);
  }, [query]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const active = term.length >= MIN_CHARS;

  useEffect(() => {
    if (!active) return;
    const ctl = new AbortController();
    setShipments({ status: "loading" });
    setDocs(null);
    setDocsDone(false);
    fetchHubList({ q: term, limit: SHOWN }, ctl.signal).then(
      (list) => { if (!ctl.signal.aborted) setShipments({ status: "ready", list }); },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        // What the server said (a database error, say) is not shown: only the plain message.
        console.warn("[FPX] invoice search failed:", e);
        setShipments({ status: "error" });
      },
    );
    searchInvoiceDocs(term, SHOWN, ctl.signal).then(
      (res) => { if (!ctl.signal.aborted) { setDocs(res.data); setDocsDone(true); } },
      // Not there yet, or failing: this group is simply left out.
      () => { if (!ctl.signal.aborted) { setDocs(null); setDocsDone(true); } },
    );
    return () => ctl.abort();
  }, [term, active, attempt]);

  const rows = shipments.status === "ready" ? shipments.list.data : [];
  const all = shipments.status === "ready" ? shipments.list.totals.all : null;
  const docHits = docs ?? [];
  const noShipments = shipments.status === "ready" && rows.length === 0;
  // Nothing anywhere: one message for both groups, once both have answered.
  const nothing = noShipments && docsDone && docHits.length === 0;

  return (
    <section aria-labelledby="find-invoice-title" className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-6">
      <h2 id="find-invoice-title" className="text-base font-semibold text-slate-900">Find an invoice</h2>

      <form role="search" className="relative mt-3" onSubmit={(e) => { e.preventDefault(); commit(text); }}>
        <label htmlFor="find-invoice-input" className="sr-only">Shipment number, invoice number, tracking number, customer or carrier</label>
        <Search className="h-5 w-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
        <input
          id="find-invoice-input"
          type="search"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => onType(e.target.value)}
          placeholder="Shipment number, invoice number, tracking number, customer or carrier"
          className="w-full h-14 pl-12 pr-12 rounded-xl ring-1 ring-slate-300 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500 [&::-webkit-search-cancel-button]:hidden"
        />
        {text ? (
          <button
            type="button"
            onClick={() => { setText(""); commit(""); document.getElementById("find-invoice-input")?.focus(); }}
            aria-label="Clear the search"
            title="Clear"
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : null}
      </form>
      <p className="mt-2 text-sm text-slate-500">
        Searches all {totalKnown != null ? `${fmtNum(totalKnown)} ` : ""}shipments FPX has read from FreightPOP, and the text of saved invoice documents.
      </p>

      {active ? (
        <div className="mt-5 space-y-5" aria-live="polite">
          {nothing ? (
            <div className="rounded-xl ring-1 ring-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
              <div className="font-medium text-slate-900 break-words">Nothing matches “{term}”.</div>
              <div className="mt-1">Try a shipment number, a tracking number, or part of a customer or carrier name.</div>
            </div>
          ) : (
            <div>
              <h3 className={groupTitle}>Shipments</h3>
              {shipments.status === "loading" ? (
                <div role="status" className="px-3 py-3 text-sm text-slate-500 inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Searching…
                </div>
              ) : shipments.status === "error" ? (
                <p role="alert" className="px-3 py-3 text-sm text-rose-700 break-words">
                  {SEARCH_FAILED_MESSAGE}{" "}
                  <button type="button" onClick={() => setAttempt((n) => n + 1)} className="underline hover:text-rose-900 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">Try again</button>
                </p>
              ) : rows.length === 0 ? (
                <div className="px-3 py-3 text-sm text-slate-600">
                  <div className="font-medium text-slate-900 break-words">No shipment matches “{term}”.</div>
                  <div className="mt-1">Try a shipment number, a tracking number, or part of a customer or carrier name.</div>
                </div>
              ) : (
                <>
                  <ul className="divide-y divide-slate-100">
                    {rows.map((r) => {
                      const chip = HUB_STEP_SHORT[r.bucket] ?? { label: "Status not known", cls: "bg-slate-100 text-slate-700" };
                      const who = [r.customer_name, r.carrier].filter(Boolean).join(" · ");
                      return (
                        <li key={r.shipment_id}>
                          <button type="button" onClick={() => onOpen(r.shipment_id, r)} className={rowCls}>
                            <span className="font-semibold text-slate-900 whitespace-nowrap inline-flex items-center gap-1.5">
                              {r.shipment_id}
                              <StaleDot lastSeenAt={r.last_seen_at} />
                            </span>
                            <span className="min-w-0 flex-1 basis-48">
                              <span className="block text-sm text-slate-700 truncate">{who || "Customer and carrier not listed"}</span>
                              {r.tracking_number ? <span className="block text-xs text-slate-500 truncate">Tracking {r.tracking_number}</span> : null}
                            </span>
                            <span className="text-sm text-slate-900 tabular-nums whitespace-nowrap">{hubMoney(r.charge)}</span>
                            <span className={"text-xs rounded-full px-2.5 py-1 whitespace-nowrap " + chip.cls}>{chip.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {all != null && all > rows.length ? (
                    <p className="px-3 mt-2 text-sm text-slate-500">
                      Showing the first {fmtNum(rows.length)} of {fmtNum(all)}{shipments.status === "ready" && shipments.list.truncated ? "+" : ""}. The steps below show them all, split by where each one stands.
                    </p>
                  ) : null}
                  {shipments.status === "ready" && shipments.list.truncated ? (
                    <p className="px-3 mt-1 text-sm text-slate-500">
                      This search matches a lot of shipments, so only the biggest {fmtNum(all)} by charge are counted. Type more of the name or number to narrow it.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          )}

          {docHits.length > 0 ? (
            <div>
              <h3 className={groupTitle}>Found inside saved documents</h3>
              <ul className="divide-y divide-slate-100">
                {docHits.map((d) => {
                  const facts = [d.carrier, d.invoice_date ? hubDay(d.invoice_date) : ""].filter(Boolean).join(" · ");
                  const body = (
                    <>
                      <FileText className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 basis-48">
                        <span className="block text-sm text-slate-900 truncate">
                          <span className="font-semibold">{docTitle(d)}</span>
                          {facts ? <span className="text-slate-600"> · {facts}</span> : null}
                        </span>
                        {d.summary ? <span className="block text-xs text-slate-500 truncate">{d.summary}</span> : null}
                      </span>
                      <span className="text-sm text-slate-900 tabular-nums whitespace-nowrap">{hubMoney(d.total)}</span>
                      <span className="text-xs text-slate-500 whitespace-nowrap">
                        {d.shipment_id ? `Shipment ${d.shipment_id}` : "Not linked to a shipment"}
                      </span>
                    </>
                  );
                  const id = d.shipment_id;
                  return (
                    <li key={d.id}>
                      {id ? (
                        <button type="button" onClick={() => onOpen(id)} className={rowCls}>{body}</button>
                      ) : (
                        <div className="px-3 py-3 flex items-center gap-x-4 gap-y-1 flex-wrap">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
