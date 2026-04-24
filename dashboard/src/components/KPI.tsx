import type { LucideIcon } from "lucide-react";

interface Props {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone?: "default" | "success" | "warn" | "danger" | "brand";
  hint?: string;
}

const TONE_MAP = {
  default: "bg-white ring-slate-200 text-slate-900",
  success: "bg-emerald-50 ring-emerald-200 text-emerald-900",
  warn: "bg-amber-50 ring-amber-200 text-amber-900",
  danger: "bg-rose-50 ring-rose-200 text-rose-900",
  brand: "bg-sky-50 ring-sky-200 text-sky-900",
} as const;

const ICON_TONE_MAP = {
  default: "bg-slate-100 text-slate-500",
  success: "bg-emerald-100 text-emerald-600",
  warn: "bg-amber-100 text-amber-600",
  danger: "bg-rose-100 text-rose-600",
  brand: "bg-sky-100 text-sky-600",
} as const;

export function KPI({ label, value, icon: Icon, tone = "default", hint }: Props) {
  return (
    <div className={`rounded-2xl ring-1 ${TONE_MAP[tone]} px-5 py-4 flex items-start gap-4 shadow-sm`}>
      <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${ICON_TONE_MAP[tone]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</div>
        <div className="text-2xl font-semibold mt-0.5">{value}</div>
        {hint ? <div className="text-xs text-slate-500 mt-0.5">{hint}</div> : null}
      </div>
    </div>
  );
}
