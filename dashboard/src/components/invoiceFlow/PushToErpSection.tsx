import { UploadCloud } from "lucide-react";

// The next step after the report. Nothing pushes to an ERP today; FPX only
// reads FreightPOP's own "Exported to ERP" flag.

export default function PushToErpSection() {
  return (
    <div aria-disabled="true" className="rounded-2xl ring-1 ring-slate-200 bg-slate-50 p-5 flex items-start gap-4 opacity-80">
      <div className="h-10 w-10 shrink-0 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center">
        <UploadCloud className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-semibold text-slate-700">Push to ERP</div>
          <span className="rounded-full bg-slate-200 text-slate-600 px-2 py-0.5 text-[11px] font-medium">Coming next</span>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Approved-and-ready shipments will be pushed to the ERP from here. Today FPX only reads FreightPOP's Exported to ERP flag.
        </p>
      </div>
      <button type="button" disabled className="shrink-0 px-3.5 py-2 rounded-lg bg-white text-slate-400 ring-1 ring-slate-200 text-sm font-medium cursor-not-allowed">
        Push to ERP
      </button>
    </div>
  );
}
