import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ExternalLink, FileText, Loader2, X } from "lucide-react";
import { fetchPushedRecords, type PushedRecords } from "../../lib/erpPushed";
import { openInFreightPop } from "../../lib/freightpopFrame";
import { fmtDateTime } from "../../lib/format";
import {
  HUB_STEP_SHORT, NotAvailableError, fetchHubShipment, fetchInvoiceDocs, hubApprover, hubDay, hubMoney,
  hubStatusSentence, hubStepNumber, isAbort, processInvoiceDocs,
  type HubRow, type InvoiceDoc,
} from "../../lib/invoicesHub";
import { ScrapeHistory } from "../ScrapeHistory";
import { SavedFiles } from "../invoicing/InvoiceRecordModal";

// One shipment's invoice, opened from the Invoices page: where it stands in
// plain words, its amounts, the documents FPX saved, what FPX read off them,
// and what changed between reads. Read only, except asking FPX to read the
// saved documents.

/** FreightPOP's own Shipment Details page for the shipment, by its quote id. */
function shipmentUrl(row: HubRow | null, quoteId: string): string {
  const p = new URLSearchParams({ FromHistory: "true", QuoteID: quoteId, FromEmailLink: "false", IsFromIframe: "false", bh: "true" });
  if (row?.charge != null) p.set("Amount", String(row.charge));
  if (row?.cost != null) p.set("co", String(row.cost));
  if (row?.charge != null && row?.cost != null) p.set("pr", (Math.round((row.charge - row.cost) * 100) / 100).toString());
  return `https://app.freightpop.com/ShipmentDetail.html?${p.toString()}`;
}

type RowState =
  | { status: "loading" }
  | { status: "ready"; row: HubRow }
  | { status: "missing" }
  | { status: "error"; message: string };

type FilesState = { status: "loading" } | { status: "ready"; data: PushedRecords } | { status: "error"; message: string };

type DocsState =
  | { status: "loading" }
  | { status: "ready"; docs: InvoiceDoc[] }
  | { status: "hidden" }
  | { status: "error"; message: string };

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={"min-w-0 " + (wide ? "col-span-2 sm:col-span-3" : "")}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900 mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <h3 className="text-sm font-semibold text-slate-900">{children}</h3>
      {aside}
    </div>
  );
}

function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl p-3 text-sm flex items-start gap-2 ring-1 bg-rose-50 ring-rose-200 text-rose-800">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words">{message}</div>
      <button type="button" onClick={onRetry} className="shrink-0 text-xs px-2 py-0.5 rounded-md ring-1 ring-rose-300 bg-white hover:bg-rose-100 whitespace-nowrap">Try again</button>
    </div>
  );
}

const quietLink = "text-sm text-sky-700 hover:text-sky-900 underline underline-offset-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50 disabled:no-underline";

const text = (v: unknown): string => (v == null ? "" : String(v).trim());
const docFileName = (file: string | null): string => (file ? file.split("/").pop() || file : "");
const docTypeLabel = (t: string | null): string => {
  const s = text(t).replace(/[_-]+/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Document";
};
const fieldLabel = (k: string): string => {
  const s = k.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
};
/** A number as money; anything else as it was read. */
const cellMoney = (v: number | string | null): string => {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? hubMoney(n) : String(v);
};

/** What FPX read off one saved document. */
function DocCard({ doc, approved }: { doc: InvoiceDoc; approved: number | null }) {
  const name = docFileName(doc.file);
  const statusWord = doc.status === "done" ? "Read"
    : doc.status === "failed" ? "Could not be read"
    : doc.status === "skipped" ? "Not read"
    : "Being read…";
  const statusCls = doc.status === "done" ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
    : doc.status === "failed" ? "bg-rose-50 text-rose-800 ring-rose-200"
    : doc.status === "skipped" ? "bg-slate-50 text-slate-700 ring-slate-200"
    : "bg-sky-50 text-sky-800 ring-sky-200";

  const named: [string, string][] = ([
    ["Invoice number", text(doc.invoice_number)],
    ["Invoice date", hubDay(doc.invoice_date)],
    ["Due date", hubDay(doc.due_date)],
    ["Carrier", text(doc.carrier)],
    ["Bill to", text(doc.bill_to)],
    ["Ship from", text(doc.ship_from)],
    ["Ship to", text(doc.ship_to)],
    ["Tracking number", text(doc.tracking_number)],
    ["BOL number", text(doc.bol_number)],
    ["PO number", text(doc.po_number)],
    ["SO number", text(doc.so_number)],
    ["Terms", text(doc.terms)],
    ["Subtotal", doc.subtotal != null ? hubMoney(doc.subtotal) : ""],
    ["Fuel surcharge", doc.fuel_surcharge != null ? hubMoney(doc.fuel_surcharge) : ""],
    ["Accessorials", doc.accessorial_total != null ? hubMoney(doc.accessorial_total) : ""],
    ["Total", doc.total != null ? `${hubMoney(doc.total)}${doc.currency && doc.currency.toUpperCase() !== "USD" ? ` ${doc.currency}` : ""}` : ""],
  ] as [string, string][]).filter(([, v]) => v);
  const extra: [string, string][] = Object.entries(doc.fields ?? {})
    .map(([k, v]) => [fieldLabel(k), text(v)] as [string, string])
    .filter(([, v]) => v);
  const lines = Array.isArray(doc.line_items) ? doc.line_items : [];
  const warnings = (Array.isArray(doc.warnings) ? doc.warnings : doc.warnings ? [doc.warnings] : []).map(text).filter(Boolean);
  const differs = doc.status === "done" && doc.total != null && approved != null && Math.abs(Number(doc.total) - approved) > 0.01;

  return (
    <article className="rounded-xl ring-1 ring-slate-200 bg-white overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <div className="min-w-0 flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium text-slate-900">{docTypeLabel(doc.doc_type)}</span>
          {name ? <span className="text-xs text-slate-500 truncate" title={name}>{name}</span> : null}
        </div>
        <span className={"shrink-0 text-xs rounded-full px-2.5 py-0.5 ring-1 whitespace-nowrap " + statusCls}>{statusWord}</span>
      </header>
      <div className="p-4 space-y-4">
        {doc.status === "pending" || doc.status === "processing" ? (
          <p role="status" className="text-sm text-slate-600 inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Being read…
          </p>
        ) : doc.status === "failed" ? (
          <p className="text-sm text-rose-800 break-words">FPX could not read this file.{doc.error ? ` ${doc.error}` : ""}</p>
        ) : doc.status === "skipped" ? (
          <p className="text-sm text-slate-600 break-words">FPX did not read this file.{doc.error ? ` ${doc.error}` : ""}</p>
        ) : (
          <>
            {differs ? (
              <div role="note" className="rounded-xl p-3 text-sm flex items-start gap-2 ring-1 bg-amber-50 ring-amber-200 text-amber-900">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                <div>This document's total ({hubMoney(doc.total)}) is different from the amount approved in FreightPOP ({hubMoney(approved)}).</div>
              </div>
            ) : null}
            {doc.summary ? <p className="text-sm text-slate-700 leading-relaxed">{doc.summary}</p> : null}
            {named.length || extra.length ? (
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
                {[...named, ...extra].map(([label, value], i) => (
                  <Fact key={`${label}-${i}`} label={label}><span className="whitespace-pre-line">{value}</span></Fact>
                ))}
              </dl>
            ) : !doc.summary && !lines.length ? (
              <p className="text-sm text-slate-600">FPX read this file but found no invoice details in it.</p>
            ) : null}
            {lines.length ? (
              <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
                <table className="w-full text-sm">
                  <caption className="sr-only">Lines on this document</caption>
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-slate-500 bg-slate-50">
                      <th scope="col" className="text-left font-medium px-3 py-2">Description</th>
                      <th scope="col" className="text-right font-medium px-3 py-2">Quantity</th>
                      <th scope="col" className="text-right font-medium px-3 py-2">Rate</th>
                      <th scope="col" className="text-right font-medium px-3 py-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((l, i) => (
                      <tr key={i} className="align-top text-slate-800">
                        <td className="px-3 py-2 break-words">{text(l.description) || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{text(l.quantity) || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{cellMoney(l.rate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{cellMoney(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {warnings.length ? (
              <div role="note" className="rounded-xl p-3 text-sm ring-1 bg-amber-50 ring-amber-200 text-amber-900">
                <div className="font-medium">Worth a second look</div>
                <ul className="mt-1 list-disc pl-5 space-y-0.5">
                  {warnings.map((w, i) => <li key={i} className="break-words">{w}</li>)}
                </ul>
              </div>
            ) : null}
            {doc.extracted_at ? <p className="text-xs text-slate-500">Read {fmtDateTime(doc.extracted_at)}</p> : null}
          </>
        )}
      </div>
    </article>
  );
}

export function InvoiceDetail({ shipmentId, row, onClose }: { shipmentId: string; row?: HubRow | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus goes to the close button, and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { before?.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // ── The shipment itself (loaded here when opened from a shared link) ──
  const [loadedRow, setLoadedRow] = useState<RowState>({ status: "loading" });
  const [rowAttempt, setRowAttempt] = useState(0);
  const given = row && row.shipment_id === shipmentId ? row : null;
  useEffect(() => {
    if (given) return;
    const ctl = new AbortController();
    setLoadedRow({ status: "loading" });
    fetchHubShipment(shipmentId, ctl.signal).then(
      (r) => { if (!ctl.signal.aborted) setLoadedRow(r ? { status: "ready", row: r } : { status: "missing" }); },
      (e: unknown) => { if (!ctl.signal.aborted && !isAbort(e)) setLoadedRow({ status: "error", message: (e as Error)?.message || "The shipment could not be loaded." }); },
    );
    return () => ctl.abort();
  }, [shipmentId, given, rowAttempt]);
  const rowState: RowState = given ? { status: "ready", row: given } : loadedRow;
  const r = rowState.status === "ready" ? rowState.row : null;

  // ── Saved documents ──
  const [files, setFiles] = useState<FilesState>({ status: "loading" });
  const [filesAttempt, setFilesAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    setFiles({ status: "loading" });
    fetchPushedRecords(shipmentId).then(
      (data) => { if (!gone) setFiles({ status: "ready", data }); },
      (e: unknown) => { if (!gone) setFiles({ status: "error", message: (e as Error)?.message || "The saved files could not be loaded." }); },
    );
    return () => { gone = true; };
  }, [shipmentId, filesAttempt]);

  const records = files.status === "ready" ? files.data : null;
  // Files are kept per pull; one viewer for each pull that saved any.
  const groups = new Map<string, { files: string[]; at: string | null; by: string | null }>();
  for (const rec of records?.records ?? []) {
    if (!rec.audit_id || rec.files.length === 0) continue;
    const g = groups.get(rec.audit_id) ?? { files: [], at: rec.captured_at, by: rec.captured_by };
    for (const f of rec.files) if (!g.files.includes(f)) g.files.push(f);
    groups.set(rec.audit_id, g);
  }
  const quoteId = records?.quote_id ?? null;
  const fileId = (shipmentId || "shipment").replace(/[^\w.-]+/g, "_");

  // ── What FPX read from the invoice ──
  const [docs, setDocs] = useState<DocsState>({ status: "loading" });
  const [docsNonce, setDocsNonce] = useState(0);
  const [ask, setAsk] = useState<{ state: "idle" | "sending" | "asked" } | { state: "failed"; message: string }>({ state: "idle" });
  useEffect(() => { setDocs({ status: "loading" }); setAsk({ state: "idle" }); }, [shipmentId]);
  useEffect(() => {
    const ctl = new AbortController();
    fetchInvoiceDocs(shipmentId, ctl.signal).then(
      (list) => { if (!ctl.signal.aborted) setDocs({ status: "ready", docs: list }); },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        if (e instanceof NotAvailableError) { setDocs({ status: "hidden" }); return; }
        // A failed re-check keeps what is already shown.
        setDocs((prev) => (prev.status === "ready" ? prev : { status: "error", message: (e as Error)?.message || "It could not be loaded." }));
      },
    );
    return () => ctl.abort();
  }, [shipmentId, docsNonce]);

  const docList = docs.status === "ready" ? docs.docs : [];
  const reading = docList.some((d) => d.status === "pending" || d.status === "processing");
  const anyFailed = docList.some((d) => d.status === "failed");
  const asked = ask.state === "asked";
  // While something is being read (or was just asked for), look again every few seconds.
  useEffect(() => {
    if (docs.status !== "ready" || (!reading && !asked)) return;
    const id = setTimeout(() => setDocsNonce((n) => n + 1), 5000);
    return () => clearTimeout(id);
  }, [docs, reading, asked]);
  // "Asked" stops being said once the reading shows up, or after two minutes.
  useEffect(() => {
    if (!asked) return;
    if (reading) { setAsk({ state: "idle" }); return; }
    const id = setTimeout(() => setAsk({ state: "idle" }), 120_000);
    return () => clearTimeout(id);
  }, [asked, reading]);

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function readNow() {
    if (ask.state === "sending") return;
    setAsk({ state: "sending" });
    try {
      await processInvoiceDocs(shipmentId);
      if (!alive.current) return;
      setAsk({ state: "asked" });
      setTimeout(() => { if (alive.current) setDocsNonce((n) => n + 1); }, 4000);
    } catch (e) {
      if (alive.current) setAsk({ state: "failed", message: (e as Error)?.message || "FPX could not start reading." });
    }
  }
  const canAsk = docs.status === "ready" && (docList.length === 0 || reading || anyFailed);

  // ── Amounts ──
  const approvedAmount = r ? (r.approved_amount ?? r.approved_invoice_amount) : null;
  const step = r ? HUB_STEP_SHORT[r.bucket] : null;
  const who = r ? hubApprover(r) : "";
  const approvedOn = r ? hubDay(r.approved_date) : "";
  const subtitle = r ? [r.customer_name, r.carrier].filter(Boolean).join(" · ") : "";

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-detail-title"
        className="fixed top-0 right-0 h-full w-full sm:w-[760px] max-w-full bg-white shadow-2xl flex flex-col"
      >
        <div className="shrink-0 flex items-start justify-between gap-3 px-6 py-5 border-b border-slate-200">
          <div className="min-w-0">
            <h2 id="invoice-detail-title" className="text-lg font-semibold text-slate-900 break-words">Shipment {shipmentId || "—"}</h2>
            {subtitle ? <p className="text-sm text-slate-600 mt-0.5 break-words">{subtitle}</p> : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={!quoteId}
              onClick={() => { if (quoteId) { openInFreightPop({ url: shipmentUrl(r, quoteId), label: `Shipment ${shipmentId}`, customerName: r?.customer_name ?? null }); onClose(); } }}
              title={quoteId ? "Open this shipment in FreightPOP, in your hosted browser" : "FreightPOP's quote id for this shipment has not been read, so it cannot be opened from here"}
              className="px-3 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open in FreightPOP
            </button>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-8">
          {rowState.status === "loading" ? (
            <div role="status" className="rounded-xl ring-1 ring-slate-200 px-6 py-8 text-sm text-slate-500 flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading this shipment…
            </div>
          ) : rowState.status === "error" ? (
            <ErrorLine message={rowState.message} onRetry={() => setRowAttempt((n) => n + 1)} />
          ) : rowState.status === "missing" ? (
            <div className="rounded-xl ring-1 ring-slate-200 bg-slate-50 px-6 py-8 text-center text-sm text-slate-600">
              <div className="font-medium text-slate-900">FPX does not know a shipment with this number.</div>
              <div className="mt-1">Check the number, or search for it by customer, carrier or tracking number.</div>
            </div>
          ) : r ? (
            <section aria-label="Where this invoice stands" className="space-y-5">
              <div className="rounded-xl ring-1 ring-violet-100 bg-violet-50/60 p-4">
                {step ? (
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className={"text-xs font-medium rounded-full px-2.5 py-0.5 " + step.cls}>{step.label}</span>
                    <span className="text-xs text-slate-500">Step {hubStepNumber(r.bucket)} of 4</span>
                  </div>
                ) : null}
                <p className="text-base text-slate-900 leading-relaxed">{hubStatusSentence(r)}</p>
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
                <Fact label="Customer charge"><span className="tabular-nums">{hubMoney(r.charge)}</span></Fact>
                <Fact label="Carrier cost"><span className="tabular-nums">{hubMoney(r.cost)}</span></Fact>
                <Fact label="Profit"><span className="tabular-nums">{hubMoney(r.gross_profit)}</span></Fact>
                <Fact label="Approved invoice amount"><span className="tabular-nums">{hubMoney(approvedAmount)}</span></Fact>
                {r.not_approved_invoice_amount != null && r.not_approved_invoice_amount !== 0 ? (
                  <Fact label="Invoice not approved yet"><span className="tabular-nums">{hubMoney(r.not_approved_invoice_amount)}</span></Fact>
                ) : null}
                {r.approval_variance != null && Math.abs(r.approval_variance) > 0.004 ? (
                  <Fact label="Difference"><span className="tabular-nums text-amber-800">{hubMoney(r.approval_variance)}</span></Fact>
                ) : null}
                <Fact label="Carrier invoice number">{r.approved_invoice_number || "—"}</Fact>
                <Fact label="Tracking number">{r.tracking_number || "—"}</Fact>
                <Fact label="Shipped">{hubDay(r.shipped_date) || "—"}</Fact>
                <Fact label="Approved by">
                  {who || (r.approved ? "Not listed" : "—")}
                  {approvedOn ? <span className="block text-xs text-slate-500">on {approvedOn}</span> : null}
                </Fact>
                {r.approval_notes ? <Fact label="Approval notes" wide><span className="whitespace-pre-line">{r.approval_notes}</span></Fact> : null}
              </dl>
            </section>
          ) : null}

          <section aria-label="Saved documents">
            <Heading>Saved documents</Heading>
            {files.status === "loading" ? (
              <div role="status" className="rounded-xl ring-1 ring-slate-200 px-6 py-8 text-sm text-slate-500 flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the saved files…
              </div>
            ) : files.status === "error" ? (
              <ErrorLine message={files.message} onRetry={() => setFilesAttempt((n) => n + 1)} />
            ) : groups.size === 0 ? (
              <div className="rounded-xl ring-1 ring-slate-200 px-6 py-8 text-center text-sm text-slate-600">
                <div className="font-medium text-slate-900">Nothing has been saved for this shipment yet.</div>
                <div className="mt-1">FPX keeps screenshots and documents only for shipments it has opened in FreightPOP. Use Open in FreightPOP to see this one live.</div>
              </div>
            ) : (
              <div className="space-y-6">
                {[...groups.entries()].map(([auditId, g]) => (
                  <div key={auditId} className="space-y-3">
                    <div className="text-xs text-slate-500">
                      Saved {g.at ? fmtDateTime(g.at) : "at an unknown time"}{g.by ? ` by ${g.by}` : ""} · {g.files.length} file{g.files.length === 1 ? "" : "s"}
                    </div>
                    <SavedFiles auditId={auditId} files={g.files} fileId={fileId} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {docs.status === "hidden" ? null : (
            <section aria-label="What FPX read from the invoice">
              <Heading
                aside={canAsk ? (
                  ask.state === "asked" ? <span role="status" className="text-sm text-slate-600">Asked. This can take a minute.</span> : (
                    <button type="button" onClick={() => { void readNow(); }} disabled={ask.state === "sending"} className={quietLink}>
                      {ask.state === "sending" ? "Asking…" : docList.length === 0 ? "Read the saved documents now" : "Read this document now"}
                    </button>
                  )
                ) : null}
              >
                What FPX read from the invoice
              </Heading>
              {ask.state === "failed" ? <p role="alert" className="text-sm text-rose-700 mb-3 break-words">FPX could not start reading. {ask.message}</p> : null}
              {docs.status === "loading" ? (
                <div role="status" className="rounded-xl ring-1 ring-slate-200 px-6 py-8 text-sm text-slate-500 flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
                </div>
              ) : docs.status === "error" ? (
                <ErrorLine message={docs.message} onRetry={() => { setDocs({ status: "loading" }); setDocsNonce((n) => n + 1); }} />
              ) : docList.length === 0 ? (
                <div className="rounded-xl ring-1 ring-slate-200 px-6 py-8 text-center text-sm text-slate-600">
                  <div className="font-medium text-slate-900">FPX has not read an invoice for this shipment yet.</div>
                  <div className="mt-1">Once a saved invoice has been read, its numbers, dates and amounts appear here.</div>
                </div>
              ) : (
                <div className="space-y-4">
                  {docList.map((d) => <DocCard key={d.id} doc={d} approved={approvedAmount} />)}
                </div>
              )}
            </section>
          )}

          <section aria-label="History">
            <Heading>History</Heading>
            <ScrapeHistory source="erp_transactions" entityKey={shipmentId || null} refreshKey={r?.last_seen_at ?? null} />
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
