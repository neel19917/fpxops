// "Read from FreightPOP": when FPX last and first read one thing from
// FreightPOP, and what each later read changed (when, field, from → to).
// Read-only; it shows what the server recorded.
import { useEffect, useState } from "react";
import { fmtDateTime } from "../lib/format";
import {
  fetchScrapeHistory,
  historyFieldLabel,
  historyValue,
  type ScrapeHistoryResponse,
  type ScrapeHistorySource,
} from "../lib/scrapeHistory";

const SHOWN = 10;

export function ScrapeHistory({ source, entityKey, refreshKey }: {
  source: ScrapeHistorySource;
  entityKey: string | null;
  /** Change it to load again (for example the time of the latest read). */
  refreshKey?: string | number | null;
}) {
  // Kept with the entity it belongs to, so an answer for another one is never shown.
  const [loaded, setLoaded] = useState<{ id: string; res: ScrapeHistoryResponse } | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [nonce, setNonce] = useState(0);
  const id = entityKey ? `${source}:${entityKey}` : null;

  useEffect(() => {
    if (!entityKey || !id) return;
    let cancelled = false;
    fetchScrapeHistory(source, entityKey, { limit: 100 }).then((res) => {
      if (cancelled) return;
      setLoaded({ id, res });
      setFailed(null);
    }).catch((e) => {
      if (!cancelled) setFailed({ id, message: (e as Error).message });
    });
    return () => { cancelled = true; };
  }, [source, entityKey, id, refreshKey, nonce]);

  useEffect(() => { setShowAll(false); }, [id]);

  if (!id) return null;
  const res = loaded?.id === id ? loaded.res : null;
  const error = failed?.id === id ? failed.message : null;

  const changes = (res?.events || []).filter((e) => e.event === "changed" && Object.keys(e.changes || {}).length > 0);
  const shown = showAll ? changes : changes.slice(0, SHOWN);

  return (
    <section className="mb-6" aria-label="Read from FreightPOP">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Read from FreightPOP</h3>
      <div className="rounded-xl ring-1 ring-slate-200 bg-slate-50 p-4 text-sm">
        {!res && error ? (
          <p role="alert" className="text-rose-800">
            FPX could not load when this was read. {error}{" "}
            <button type="button" onClick={() => setNonce((n) => n + 1)} className="underline text-rose-700 hover:text-rose-900">Try again</button>
          </p>
        ) : !res ? (
          <p role="status" className="text-slate-500">Loading…</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 mb-3">
              <div>
                <dt className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Last read</dt>
                <dd className="text-slate-900" title={res.last_read_at ? new Date(res.last_read_at).toLocaleString() : undefined}>
                  {res.last_read_at ? fmtDateTime(res.last_read_at) : "Not read yet"}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">First seen</dt>
                <dd className="text-slate-900" title={res.first_seen_at ? new Date(res.first_seen_at).toLocaleString() : undefined}>
                  {res.first_seen_at ? fmtDateTime(res.first_seen_at) : "—"}
                </dd>
              </div>
            </dl>

            {changes.length === 0 ? (
              <p className="text-slate-600">No changes since it was first read</p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <caption className="sr-only">What each read changed</caption>
                  <thead>
                    <tr className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                      <th scope="col" className="text-left font-medium pb-1 pr-3">When</th>
                      <th scope="col" className="text-left font-medium pb-1 pr-3">Field</th>
                      <th scope="col" className="text-left font-medium pb-1">Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 border-t border-slate-200">
                    {shown.flatMap((e) => Object.entries(e.changes).map(([field, c], i) => (
                      <tr key={`${e.id}-${field}`} className="align-top text-slate-800">
                        <td className="py-1.5 pr-3 whitespace-nowrap text-slate-600" title={new Date(e.scraped_at).toLocaleString()}>
                          {i === 0 ? fmtDateTime(e.scraped_at) : <span className="sr-only">{fmtDateTime(e.scraped_at)}</span>}
                        </td>
                        <td className="py-1.5 pr-3">{historyFieldLabel(field)}</td>
                        <td className="py-1.5 break-words tabular-nums">
                          <span className="text-slate-500">{historyValue(field, c?.from)}</span>
                          <span aria-hidden="true"> → </span>
                          <span className="sr-only"> changed to </span>
                          <span className="font-medium text-slate-900">{historyValue(field, c?.to)}</span>
                        </td>
                      </tr>
                    )))}
                  </tbody>
                </table>
                {changes.length > SHOWN ? (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="mt-2 text-xs text-sky-700 hover:text-sky-900 underline"
                  >
                    {showAll ? "Show fewer" : `Show all ${changes.length} reads that changed something`}
                  </button>
                ) : null}
              </>
            )}
            {error ? <p role="alert" className="mt-2 text-xs text-rose-700">FPX could not check for newer changes. {error}</p> : null}
          </>
        )}
      </div>
    </section>
  );
}
