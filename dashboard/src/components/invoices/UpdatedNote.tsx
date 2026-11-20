import { RefreshCw } from "lucide-react";
import { fmtRelative } from "../../lib/format";

// A quiet "Updated 2m ago" line for numbers shown from the cache, with a
// spinner while they refresh in the background and a button to refresh now.

export function UpdatedNote({ updatedAt, refreshing, error, onRefresh }: {
  updatedAt: number | null;
  refreshing: boolean;
  /** The last refresh failed; the numbers shown are the last good ones. */
  error: string | null;
  onRefresh: () => void;
}) {
  const when = updatedAt ? new Date(updatedAt).toISOString() : null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
      <span role="status" aria-live="polite">
        {refreshing
          ? (when ? "Refreshing…" : "Loading…")
          : error && when
            ? <span className="text-amber-700" title={error}>Could not refresh. Showing numbers from {fmtRelative(when)}.</span>
            : when
              ? <span title={new Date(updatedAt!).toLocaleString()}>Updated {fmtRelative(when)}</span>
              : null}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh the numbers"
        title="Refresh the numbers"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        <RefreshCw className={"h-3.5 w-3.5 " + (refreshing ? "animate-spin" : "")} aria-hidden="true" />
      </button>
    </span>
  );
}
