import { isStale, staleTitle } from "../../lib/invoicesHub";

/** A small amber dot on a row whose ERP data FPX read from FreightPOP more than 36 hours ago. Nothing otherwise. */
export function StaleDot({ lastSeenAt }: { lastSeenAt: string | null | undefined }) {
  if (!isStale(lastSeenAt)) return null;
  const title = staleTitle(lastSeenAt);
  return (
    <span title={title} className="inline-flex items-center align-middle shrink-0">
      <span className="h-2 w-2 rounded-full bg-amber-500 ring-2 ring-amber-100" aria-hidden="true" />
      <span className="sr-only">{title}</span>
    </span>
  );
}
