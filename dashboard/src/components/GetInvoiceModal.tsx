import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, FileText, X } from "lucide-react";
import type { ScrapeRequest } from "../lib/api";
import { GET_INVOICE_MAX, GET_INVOICE_SCOPE, getInvoiceLabel, requestGetInvoices } from "../lib/erpPull";
import { fmtDateTime, fmtNum } from "../lib/format";
import type { GetInvoiceState } from "../lib/types";

// The human-in-the-loop step before FPX presses FreightPOP's GET INVOICE
// button: the person sees exactly which shipments are about to be invoiced,
// can untick any of them, and has to say they reviewed the list before the
// button that starts the job is enabled.

export interface GetInvoiceItem {
  id: string;            // audit row id
  shipment: string;      // FreightPOP shipment id — what the job is given
  customer: string;
  carrier: string;
  charge: number | null;
  invoice: number | null;
  status: string;
  statusLabel: string;
  statusCls: string;
  flags: string[];
  invoiceState: GetInvoiceState | null;
}

const PILL_CLS: Record<string, string> = {
  requested: "bg-sky-100 text-sky-700",
  done: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  not_started: "bg-slate-100 text-slate-600",
};

/** Small pill for a row's Get Invoice state. Hover shows the note and time. */
export function InvoicePill({ state }: { state: GetInvoiceState | null }) {
  const label = getInvoiceLabel(state?.status);
  if (!state || !label) return <span className="text-slate-300">—</span>;
  const when = state.at || state.requested_at;
  const title = [
    state.note,
    state.status === "not_started" ? "The run ended before it reached this shipment." : null,
    when ? `${state.at ? label : "Requested"} ${fmtDateTime(when)}` : null,
    state.by ? `by ${state.by}` : null,
  ].filter(Boolean).join("\n");
  return (
    <span title={title || undefined} className={"text-xs rounded-full px-2 py-0.5 whitespace-nowrap " + (PILL_CLS[state.status] ?? "bg-slate-100 text-slate-700")}>
      {label}
    </span>
  );
}

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

interface Warning { key: string; text: string; ids: string[] }

interface Props {
  auditId: string;
  items: GetInvoiceItem[];
  onClose: () => void;
  /** The job was queued. The modal doesn't close itself. */
  onStarted: (request: ScrapeRequest) => void;
}

export function GetInvoiceModal({ auditId, items, onClose, onStarted }: Props) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const [pauseAfterFirst, setPauseAfterFirst] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes this modal only, not the panel underneath (which also
  // listens on window): catch the key first and stop it there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!submitting) onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, submitting]);

  const chosen = useMemo(() => items.filter((i) => ticked.has(i.id)), [items, ticked]);
  // One press per shipment, even if the audit lists a shipment twice.
  const shipmentIds = useMemo(() => [...new Set(chosen.map((i) => i.shipment).filter(Boolean))], [chosen]);
  const count = shipmentIds.length;
  const totalCharge = useMemo(() => chosen.reduce((t, i) => t + (i.charge ?? 0), 0), [chosen]);

  const warnings = useMemo<Warning[]>(() => {
    const out: Warning[] = [];
    const ids = (pick: (i: GetInvoiceItem) => boolean) => chosen.filter(pick).map((i) => i.id);
    const done = ids((i) => i.invoiceState?.status === "done");
    if (done.length) out.push({ key: "done", ids: done, text: `${fmtNum(done.length)} already had Get Invoice pressed in an earlier run. Untick ${plural(done.length, "it", "them")} unless you mean to press it again.` });
    const requested = ids((i) => i.invoiceState?.status === "requested");
    if (requested.length) out.push({ key: "requested", ids: requested, text: `${fmtNum(requested.length)} ${plural(requested.length, "is", "are")} already requested and may still be waiting in another run.` });
    const failed = ids((i) => i.invoiceState?.status === "failed");
    if (failed.length) out.push({ key: "failed", ids: failed, text: `${fmtNum(failed.length)} failed last time. Hover the Failed pill to see why before trying again.` });
    const discrepancy = ids((i) => i.status === "discrepancy");
    if (discrepancy.length) out.push({ key: "discrepancy", ids: discrepancy, text: `${fmtNum(discrepancy.length)} ${plural(discrepancy.length, "has", "have")} the audit status Discrepancy: the invoice amount and the cost don't agree.` });
    const errored = ids((i) => i.status === "error");
    if (errored.length) out.push({ key: "error", ids: errored, text: `${fmtNum(errored.length)} could not be audited (status Error).` });
    const byFlag = new Map<string, string[]>();
    for (const i of chosen) for (const f of i.flags) byFlag.set(f, [...(byFlag.get(f) ?? []), i.id]);
    for (const [flag, flagIds] of [...byFlag.entries()].sort((a, b) => b[1].length - a[1].length)) {
      out.push({ key: `flag:${flag}`, ids: flagIds, text: `${fmtNum(flagIds.length)} flagged "${flag}".` });
    }
    return out;
  }, [chosen]);
  const warnedIds = useMemo(() => new Set(warnings.flatMap((w) => w.ids)), [warnings]);

  function toggle(id: string) {
    setTicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function untick(ids: string[]) {
    setTicked((prev) => { const n = new Set(prev); for (const id of ids) n.delete(id); return n; });
  }

  const tooMany = count > GET_INVOICE_MAX;
  const canConfirm = reviewed && count >= 1 && !tooMany && !submitting;

  async function confirm() {
    if (!canConfirm) return;
    setSubmitting(true); setError(null);
    try {
      const res = await requestGetInvoices(auditId, shipmentIds, pauseAfterFirst && count > 1);
      if ((res.request?.scope as string) !== GET_INVOICE_SCOPE) {
        // A server that doesn't know this job yet answers with a regular scrape request.
        setError("The server queued a regular scrape instead of the invoice run. Get Invoice needs the next server update. Nothing was pressed in FreightPOP.");
        setSubmitting(false);
        return;
      }
      onStarted(res.request);
    } catch (e) {
      setError((e as Error).message || "Could not start the invoice run.");
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={() => { if (!submitting) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="get-invoice-title"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200">
          <div className="min-w-0">
            <h2 id="get-invoice-title" className="text-lg font-semibold flex items-center gap-2">
              <FileText className="h-5 w-5 text-violet-600" />
              Get invoices
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              FPX will open FreightPOP in your hosted browser and press Get Invoice on each of these shipments, one at a time.
            </p>
          </div>
          <button onClick={onClose} disabled={submitting} className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-50 shrink-0" aria-label="Close" title="Close (Esc)">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <span className="text-2xl font-semibold text-slate-900 tabular-nums">{fmtNum(count)}</span>
              <span className="text-sm text-slate-600 ml-1.5">{plural(count, "shipment", "shipments")}</span>
            </div>
            <div>
              <span className="text-2xl font-semibold text-slate-900 tabular-nums">{fmtMoney(totalCharge)}</span>
              <span className="text-sm text-slate-600 ml-1.5">in charges</span>
            </div>
            {chosen.length !== items.length ? (
              <button onClick={() => setTicked(new Set(items.map((i) => i.id)))} className="text-xs text-sky-700 hover:text-sky-900 underline">
                {fmtNum(items.length - chosen.length)} unticked. Tick all again
              </button>
            ) : null}
          </div>

          {warnings.length ? (
            <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-3 text-sm text-amber-900">
              <div className="font-medium inline-flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" /> Check these before you start
              </div>
              <ul className="mt-1.5 space-y-1">
                {warnings.map((w) => (
                  <li key={w.key} className="flex items-start justify-between gap-3">
                    <span className="break-words">{w.text}</span>
                    <button onClick={() => untick(w.ids)} className="shrink-0 text-xs px-2 py-0.5 rounded-md ring-1 ring-amber-300 bg-white text-amber-900 hover:bg-amber-100 whitespace-nowrap">
                      Untick {plural(w.ids.length, "it", `these ${fmtNum(w.ids.length)}`)}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 text-xs opacity-80">Rows with something to check are shaded in the list below.</div>
            </div>
          ) : null}

          <div className="rounded-xl ring-1 ring-slate-200 overflow-auto max-h-[38vh]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgb(226_232_240)]">
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 w-8"><span className="sr-only">Include</span></th>
                  <th className="px-3 py-2 font-medium">Shipment</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Carrier</th>
                  <th className="px-3 py-2 font-medium text-right">Charge</th>
                  <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Invoice amount</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Invoice</th>
                  <th className="px-3 py-2 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((i) => {
                  const on = ticked.has(i.id);
                  return (
                    <tr key={i.id} onClick={() => toggle(i.id)} className={"cursor-pointer " + (!on ? "opacity-50" : warnedIds.has(i.id) ? "bg-amber-50/70" : "hover:bg-slate-50")}>
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(i.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Include shipment ${i.shipment}`}
                          className="rounded border-slate-300 text-violet-600"
                        />
                      </td>
                      <td className="px-3 py-1.5 font-medium text-slate-900 whitespace-nowrap">{i.shipment || "—"}</td>
                      <td className="px-3 py-1.5">{i.customer || "—"}</td>
                      <td className="px-3 py-1.5">{i.carrier || "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtMoney(i.charge)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtMoney(i.invoice)}</td>
                      <td className="px-3 py-1.5"><span className={"text-xs rounded-full px-2 py-0.5 whitespace-nowrap " + i.statusCls}>{i.statusLabel}</span></td>
                      <td className="px-3 py-1.5"><InvoicePill state={i.invoiceState} /></td>
                      <td className="px-3 py-1.5">
                        {i.flags.length === 0 ? <span className="text-slate-300">—</span> : (
                          <span className="flex flex-wrap gap-1">
                            {i.flags.map((f) => <span key={f} className="text-[11px] rounded-full bg-amber-50 text-amber-800 ring-1 ring-amber-200 px-2 py-0.5 whitespace-nowrap">{f}</span>)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {count > 1 ? (
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={pauseAfterFirst} onChange={(e) => setPauseAfterFirst(e.target.checked)} className="mt-0.5 rounded border-slate-300 text-violet-600" />
              <span>
                <span className="text-sm font-medium text-slate-900">Pause after the first one so I can check it</span>
                <span className="block text-xs text-slate-500 mt-0.5">
                  FPX does one shipment, then waits for you to press Resume. If nobody resumes within 30 minutes, the run stops and the other {fmtNum(count - 1)} {plural(count - 1, "is", "are")} left untouched.
                </span>
              </span>
            </label>
          ) : null}

          {tooMany ? <div className="text-sm text-rose-700">Pick up to {GET_INVOICE_MAX} shipments at a time. Untick {fmtNum(count - GET_INVOICE_MAX)} to continue.</div> : null}
          {error ? (
            <div role="alert" className="rounded-xl p-3 text-sm flex items-start gap-2 ring-1 bg-rose-50 ring-rose-200 text-rose-800">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> <div className="break-words">{error}</div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap p-5 border-t border-slate-200">
          <label className="inline-flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={submitting} className="rounded border-slate-300 text-violet-600" />
            I've reviewed these shipments
          </label>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={submitting} className="px-4 py-2 rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50">
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={!canConfirm}
              title={count === 0 ? "Tick at least one shipment" : !reviewed ? "Tick \"I've reviewed these shipments\" first" : undefined}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? "Starting…" : `Get ${fmtNum(count)} ${plural(count, "invoice", "invoices")}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
