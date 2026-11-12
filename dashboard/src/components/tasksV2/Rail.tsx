// Left rail: filter sections (segments, health flags, owner).
import type { ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { FLAG_CLS } from "./shared";

export function RailSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl ring-1 ring-slate-200 bg-white p-2 shadow-sm">
      <div className="px-2 pt-1 pb-1.5 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
        {hint ? <div className="text-[10px] text-slate-400">{hint}</div> : null}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function RailItem({ active, onClick, label, count, title, tone, checkbox }: {
  active: boolean; onClick: () => void; label: string; count: number; title?: string; tone?: string; checkbox?: boolean;
}) {
  const dot = tone ? (FLAG_CLS[tone] || FLAG_CLS.slate) : "";
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-left transition ${active ? "bg-violet-50 text-violet-900 ring-1 ring-violet-200" : "text-slate-700 hover:bg-slate-50"}`}
    >
      <span className="inline-flex items-center gap-2 min-w-0">
        {checkbox ? <span className={`h-3.5 w-3.5 rounded ring-1 inline-flex items-center justify-center ${active ? "bg-violet-600 ring-violet-600 text-white" : "bg-white ring-slate-300"}`}>{active ? <CheckCircle2 className="h-3 w-3" /> : null}</span> : null}
        {tone && !checkbox ? <span className={`h-2 w-2 rounded-full ring-1 ${dot}`} /> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className={`text-xs tabular-nums ${count ? "text-slate-600" : "text-slate-300"}`}>{count}</span>
    </button>
  );
}
