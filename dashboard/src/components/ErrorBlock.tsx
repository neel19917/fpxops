import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

// Single source of truth for error surfaces across the dashboard.
// Three drifted variants existed before this (rounded-lg/-xl, with/without
// ring, rose/red shades, text-rose-700/-800). All admin and operator pages
// should import from here so a future tone change lands in one file.
//
// Use `tone="warning"` for soft warnings (amber). Default tone is the
// hard-error rose. Use the `compact` prop on tight rows where the
// vertical padding crowds neighbors.
export function ErrorBlock({
  children,
  tone = "error",
  compact = false,
  className = "",
  icon = true,
}: {
  children: ReactNode;
  tone?: "error" | "warning";
  compact?: boolean;
  className?: string;
  icon?: boolean;
}) {
  const toneCls = tone === "warning"
    ? "bg-amber-50 ring-amber-200 text-amber-800"
    : "bg-rose-50 ring-rose-200 text-rose-800";
  const padding = compact ? "px-3 py-2" : "px-4 py-3";
  return (
    <div className={`rounded-lg ring-1 ${toneCls} ${padding} text-sm flex items-start gap-2 ${className}`}>
      {icon ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> : null}
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
    </div>
  );
}
