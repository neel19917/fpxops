import { AlertTriangle, CheckCircle2, CircleDashed, ShieldCheck, XOctagon } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  action: string | null | undefined;
  size?: "sm" | "md";
  // When provided the badge renders as a button so callers can attach a
  // disposition popover. Hover affordance is added automatically.
  onClick?: () => void;
  title?: string;
}

export function ActionBadge({ action, size = "md", onClick, title }: Props) {
  const a = String(action || "").toUpperCase();
  const sizing = size === "sm" ? "text-[11px] px-2 py-0.5" : "text-xs px-2.5 py-1";
  const base = `inline-flex items-center gap-1.5 rounded-full font-semibold ${sizing}`;
  const interactive = !!onClick;
  const hover = interactive ? " cursor-pointer hover:brightness-95 hover:shadow-sm transition" : "";
  if (a === "YES") return wrap(<><AlertTriangle className="h-3 w-3" />Action needed</>, `${base} bg-rose-100 text-rose-700 ring-1 ring-rose-200${hover}`, onClick, title);
  if (a === "NO") return wrap(<><CheckCircle2 className="h-3 w-3" />On track</>, `${base} bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200${hover}`, onClick, title);
  if (a === "RESOLVED") return wrap(<><ShieldCheck className="h-3 w-3" />Manually resolved</>, `${base} bg-violet-100 text-violet-700 ring-1 ring-violet-200${hover}`, onClick, title);
  if (a === "ERROR") return wrap(<><XOctagon className="h-3 w-3" />Error</>, `${base} bg-amber-100 text-amber-700 ring-1 ring-amber-200${hover}`, onClick, title);
  return wrap(<><CircleDashed className="h-3 w-3" />Unknown</>, `${base} bg-slate-100 text-slate-600 ring-1 ring-slate-200${hover}`, onClick, title);
}

function wrap(children: ReactNode, cls: string, onClick?: () => void, title?: string) {
  if (onClick) {
    return <button type="button" onClick={onClick} className={cls} title={title} aria-label="Change action disposition">{children}</button>;
  }
  return <span className={cls} title={title}>{children}</span>;
}

export function KindBadge({ kind }: { kind: string | null | undefined }) {
  const map: Record<string, { label: string; cls: string }> = {
    per_shipment: { label: "Per-shipment", cls: "bg-sky-100 text-sky-700 ring-sky-200" },
    summary: { label: "Summary", cls: "bg-violet-100 text-violet-700 ring-violet-200" },
    gp_audit: { label: "GP audit", cls: "bg-emerald-100 text-emerald-700 ring-emerald-200" },
    invoice_audit: { label: "Invoice audit", cls: "bg-amber-100 text-amber-700 ring-amber-200" },
    other: { label: "Other", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
  };
  const k = String(kind || "other");
  const m = map[k] || map.other;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${m.cls}`}>{m.label}</span>;
}
