import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, FileImage, X } from "lucide-react";
import { approvalDate, approvalGroup, approvalLabel, fetchInvoiceShot, getInvoiceLabel } from "../../lib/erpPull";
import { fmtDateTime } from "../../lib/format";
import { fmtMoney, type Row } from "./model";

// The record FPX kept of one shipment's invoice: what Get Invoice reported and
// the screenshot(s) of the invoice FreightPOP showed, quote amount included.

type ShotState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

/** One saved screenshot: fetched signed in, shown from an object URL that is released on unmount. */
function Shot({ auditId, file, name, label }: { auditId: string; file: string; name: string; label: string }) {
  const [state, setState] = useState<ShotState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let gone = false;
    let url: string | null = null;
    fetchInvoiceShot(auditId, file).then(
      (blob) => {
        if (gone) return;
        url = URL.createObjectURL(blob);
        setState({ status: "ready", url });
      },
      (e: unknown) => {
        if (!gone) setState({ status: "error", message: (e as Error)?.message || "The screenshot could not be loaded." });
      },
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [auditId, file, attempt]);

  function retry() {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }

  return (
    <figure className="rounded-xl ring-1 ring-slate-200 overflow-hidden bg-white">
      <figcaption className="flex items-center justify-between gap-3 px-3 py-2 border-b border-slate-200 bg-slate-50">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        {state.status === "ready" ? (
          <a
            href={state.url}
            download={name}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1 bg-white text-violet-700 ring-1 ring-violet-200 hover:bg-violet-50 hover:text-violet-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
          >
            <Download className="h-3.5 w-3.5 shrink-0" /> Download
          </a>
        ) : null}
      </figcaption>
      {state.status === "loading" ? (
        <div role="status" className="h-48 flex items-center justify-center text-sm text-slate-500 animate-pulse bg-slate-50">
          Loading screenshot…
        </div>
      ) : state.status === "error" ? (
        <div role="alert" className="m-3 rounded-xl p-3 text-sm flex items-start gap-2 ring-1 bg-rose-50 ring-rose-200 text-rose-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 break-words">{state.message}</div>
          <button type="button" onClick={retry} className="shrink-0 text-xs px-2 py-0.5 rounded-md ring-1 ring-rose-300 bg-white text-rose-800 hover:bg-rose-100 whitespace-nowrap">
            Try again
          </button>
        </div>
      ) : (
        <a href={state.url} target="_blank" rel="noopener noreferrer" title="Open full size in a new tab" className="block bg-slate-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500">
          <img src={state.url} alt={`${label} for this shipment's invoice`} className="block w-full h-auto cursor-zoom-in" />
        </a>
      )}
    </figure>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900 mt-0.5 break-words">{children}</dd>
    </div>
  );
}

const RESULT_CLS: Record<string, string> = {
  requested: "bg-sky-50 text-sky-800 ring-sky-200",
  done: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  failed: "bg-rose-50 text-rose-800 ring-rose-200",
};

export function InvoiceRecordModal({ auditId, row, onClose }: {
  auditId: string;
  row: Row;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus goes to the close button, and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { before?.focus(); };
  }, []);

  // Escape closes this modal only (caught first, like the Get Invoice modal);
  // Tab stays inside the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const box = dialogRef.current;
      if (!box) return;
      const stops = [...box.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (!box.contains(at)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const gi = row.gi;
  const resultLabel = getInvoiceLabel(gi?.status);
  const when = gi?.at || gi?.requested_at;
  const group = approvalGroup(row.ap);
  const approved = !!group && group !== "not_approved";
  const approvedOn = approved ? approvalDate(row.ap) : "";
  const many = row.shots.length > 1;
  const fileId = (row.shipment || "shipment").replace(/[^\w.-]+/g, "_");

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-record-title"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200">
          <div className="min-w-0">
            <h2 id="invoice-record-title" className="text-lg font-semibold flex items-center gap-2">
              <FileImage className="h-5 w-5 text-violet-600 shrink-0" />
              <span className="break-words">Invoice record for shipment {row.shipment || "—"}</span>
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              What FreightPOP showed when FPX pressed Get Invoice on this shipment.
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500" aria-label="Close" title="Close (Esc)">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            <Fact label="Shipment">{row.shipment || "—"}</Fact>
            <Fact label="Customer">{row.customer || "—"}</Fact>
            <Fact label="Carrier">{row.carrier || "—"}</Fact>
            <Fact label="Charge"><span className="tabular-nums">{fmtMoney(row.charge)}</span></Fact>
            <Fact label="Get Invoice">
              {resultLabel ? (
                <span className={"inline-block text-xs rounded-full px-2.5 py-1 whitespace-nowrap ring-1 " + (RESULT_CLS[gi?.status ?? ""] ?? "bg-slate-50 text-slate-700 ring-slate-200")}>
                  {resultLabel}
                </span>
              ) : "—"}
            </Fact>
            <Fact label="When">
              {when ? fmtDateTime(when) : "—"}
              {gi?.by ? <span className="block text-xs text-slate-500">by {gi.by}</span> : null}
            </Fact>
            {approved ? (
              <Fact label="Approved by">
                {approvalLabel(row.ap)}
                {approvedOn ? <span className="block text-xs text-slate-500">{approvedOn}</span> : null}
              </Fact>
            ) : null}
          </dl>

          {gi?.note ? (
            <div className={"rounded-xl p-3 text-sm ring-1 break-words " + (row.failed ? "bg-rose-50 ring-rose-200 text-rose-800" : "bg-slate-50 ring-slate-200 text-slate-700")}>
              {gi.note}
            </div>
          ) : null}

          {row.shots.length === 0 ? (
            <div className="rounded-xl ring-1 ring-slate-200 px-6 py-10 text-center text-sm text-slate-500">
              No screenshot was saved for this shipment.
            </div>
          ) : (
            <div className="space-y-4">
              {row.shots.map((file, i) => (
                <Shot
                  key={file}
                  auditId={auditId}
                  file={file}
                  name={`invoice-${fileId}-${i + 1}.png`}
                  label={many ? `Screenshot ${i + 1} of ${row.shots.length}` : "Screenshot"}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-200">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-sm font-medium">
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
