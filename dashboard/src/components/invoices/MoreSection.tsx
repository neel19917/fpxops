import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { downloadErpMaster, type ErpMasterWhich } from "../../lib/erpPull";

// The one quiet place for everything that is not part of everyday work on the
// Invoices page: the older screens and the two Excel downloads. Closed by default.

const LINK = "text-sm font-medium text-sky-700 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

const SCREENS: readonly { to: string; label: string; hint: string }[] = [
  { to: "/invoicing", label: "Send invoices (advanced)", hint: "The full sending screen, with every option." },
  { to: "/audits/invoice", label: "Past audit runs", hint: "Earlier checks of carrier invoices against quotes." },
  { to: "/invoicing/pushed", label: "Pushed to ERP and NetSuite match", hint: "Everything already pushed, and a way to compare it with NetSuite." },
  { to: "/invoices/reading", label: "Reading invoices (live log)", hint: "Watch FPX read each saved invoice and document with Claude, step by step." },
  { to: "/invoices/get-invoice-runs", label: "Get Invoice runs", hint: "Scrape numbers, Excel and ZIP downloads for every Get Invoice run" },
];

const DOWNLOADS: readonly { which: ErpMasterWhich; label: string; hint: string }[] = [
  { which: "transactions", label: "Download every shipment (Excel)", hint: "One file with every shipment FPX has read from FreightPOP." },
  { which: "approvals", label: "Download every approved invoice (Excel)", hint: "One file with every carrier invoice approved in FreightPOP." },
];

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
    <section className="rounded-xl bg-white ring-1 ring-slate-200" aria-label="More">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="invoices-hub-more"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left rounded-xl hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-900">More</span>
          <span className="block text-sm text-slate-500">Other screens and downloads. You do not need these for everyday work.</span>
        </span>
        <ChevronDown className={"h-4 w-4 text-slate-500 shrink-0 transition-transform " + (open ? "rotate-180" : "")} aria-hidden="true" />
      </button>

      {open ? (
        <ul id="invoices-hub-more" className="px-5 pb-4 pt-1 border-t border-slate-100 divide-y divide-slate-100">
          {SCREENS.map((s) => (
            <li key={s.to} className="py-2.5">
              <Link to={s.to} className={LINK}>{s.label}</Link>
              <p className="text-sm text-slate-500">{s.hint}</p>
            </li>
          ))}
          {DOWNLOADS.map((d) => (
            <li key={d.which} className="py-2.5">
              <button type="button" onClick={() => download(d.which)} disabled={!!busy} className={LINK + " disabled:opacity-50 disabled:no-underline"}>
                {busy === d.which ? "Preparing the file…" : d.label}
              </button>
              <p className="text-sm text-slate-500">{d.hint}</p>
              {failed?.which === d.which ? <p role="alert" className="text-xs text-rose-700 mt-0.5">{failed.message}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
