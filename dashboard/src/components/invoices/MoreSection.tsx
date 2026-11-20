import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { downloadErpMaster, type ErpMasterWhich } from "../../lib/erpPull";
import { invalidateHubCache } from "../../lib/invoicesHub";

// The one quiet place for everything that is not part of everyday work on the
// Invoices page: the other screens and the two Excel downloads. Closed by default.

const SCREENS: readonly { to: string; label: string; hint: string; changesData?: boolean }[] = [
  { to: "/invoicing", label: "Send invoices (advanced)", hint: "The full sending screen, every option.", changesData: true },
  { to: "/audits/invoice", label: "Past audit runs", hint: "Earlier checks of carrier invoices against quotes." },
  { to: "/invoicing/pushed", label: "Pushed to ERP and NetSuite match", hint: "Everything pushed, compared with NetSuite." },
  { to: "/invoices/reading", label: "Reading invoices (live log)", hint: "Watch FPX read each saved document." },
  { to: "/invoices/get-invoice-runs", label: "Get Invoice runs", hint: "Scrape numbers, Excel and ZIP per run." },
];

const DOWNLOADS: readonly { which: ErpMasterWhich; label: string; hint: string }[] = [
  { which: "transactions", label: "Download every shipment (Excel)", hint: "Every shipment FPX has read from FreightPOP." },
  { which: "approvals", label: "Download every approved invoice (Excel)", hint: "Every carrier invoice approved in FreightPOP." },
];

const TILE = "block h-full rounded-lg px-3 py-2 ring-1 ring-slate-200 bg-white hover:bg-slate-50 hover:ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

export function MoreSection() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ErpMasterWhich | null>(null);
  const [failed, setFailed] = useState<{ which: ErpMasterWhich; message: string } | null>(null);

  async function download(which: ErpMasterWhich) {
    if (busy) return;
    setBusy(which);
    setFailed(null);
    try {
      await downloadErpMaster(which);
    } catch (e) {
      setFailed({ which, message: (e as Error)?.message || "The file could not be downloaded." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl bg-white ring-1 ring-slate-200" aria-labelledby="invoices-hub-more-title">
      <h2 id="invoices-hub-more-title" className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="invoices-hub-more"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left rounded-xl hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          <span className="min-w-0 text-sm">
            <span className="font-semibold text-slate-900">More</span>
            <span className="font-normal text-slate-500"> · other screens and Excel downloads</span>
          </span>
          <ChevronDown className={"h-4 w-4 text-slate-500 shrink-0 transition-transform " + (open ? "rotate-180" : "")} aria-hidden="true" />
        </button>
      </h2>

      {open ? (
        <div id="invoices-hub-more" className="px-4 pb-4 pt-3 border-t border-slate-100 space-y-4">
          <div>
            <h3 id="invoices-hub-more-screens" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Screens</h3>
            <ul aria-labelledby="invoices-hub-more-screens" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 list-none p-0 m-0">
              {SCREENS.map((s) => (
                <li key={s.to}>
                  <Link to={s.to} className={TILE} onClick={s.changesData ? () => invalidateHubCache() : undefined}>
                    <span className="block text-sm font-medium text-sky-700">{s.label}</span>
                    <span className="block text-xs text-slate-500 sm:truncate">{s.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 id="invoices-hub-more-downloads" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Downloads</h3>
            <ul aria-labelledby="invoices-hub-more-downloads" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 list-none p-0 m-0">
              {DOWNLOADS.map((d) => (
                <li key={d.which}>
                  <button
                    type="button"
                    onClick={() => download(d.which)}
                    disabled={!!busy}
                    aria-busy={busy === d.which}
                    className={TILE + " w-full text-left disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-white"}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium text-sky-700">
                      {busy === d.which
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
                      {busy === d.which ? "Preparing the file…" : d.label}
                    </span>
                    <span className="block text-xs text-slate-500 sm:truncate">{d.hint}</span>
                  </button>
                  {failed?.which === d.which ? <p role="alert" className="text-xs text-rose-700 mt-1">{failed.message}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
