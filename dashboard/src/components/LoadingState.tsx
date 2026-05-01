// Single loading surface for the dashboard. Three variants:
//
//   <LoadingState />                       — standalone block ("Loading…" with padding)
//   <LoadingState variant="row" colSpan />  — table-row variant (full-width <td>)
//   <LoadingState variant="inline" />       — inline single-line spinner-style
//
// Replaces a half-dozen one-off "Loading…" renderings with different
// paddings and parents so visual cadence is consistent.
import { Loader2 } from "lucide-react";

interface Props {
  variant?: "block" | "row" | "inline";
  colSpan?: number;
  label?: string;
  className?: string;
}

export function LoadingState({ variant = "block", colSpan, label = "Loading…", className = "" }: Props) {
  if (variant === "row") {
    return (
      <tr>
        <td colSpan={colSpan ?? 1} className={`p-8 text-center text-slate-500 ${className}`}>
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            {label}
          </span>
        </td>
      </tr>
    );
  }
  if (variant === "inline") {
    return (
      <span className={`inline-flex items-center gap-2 text-sm text-slate-500 ${className}`}>
        <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        {label}
      </span>
    );
  }
  return (
    <div className={`p-8 text-center text-slate-500 ${className}`}>
      <span className="inline-flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        {label}
      </span>
    </div>
  );
}
