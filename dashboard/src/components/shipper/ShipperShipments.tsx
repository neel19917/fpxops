// Tracking list for one shipper (Shippers view, "Tracking" tab + Overview card).
// Status chips, search, paginated table. Clicking a row opens the existing
// shipment drawer at /tracking/:id — that route expects fpx_shipments.id (the
// row uuid; the server's GET /api/shipments/:id looks up by `id`), so we use
// ShipperShipment.id, not the FreightPOP shipment number.
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, ListChecks, Mail, Search, Truck } from "lucide-react";
import { getShipperShipments, type ShipperShipment } from "../../lib/shippersApi";
import { fmtDate } from "../../lib/format";
import { ErrorBlock } from "../ErrorBlock";
import { LoadingState } from "../LoadingState";

type StatusFilter = "active" | "in_transit" | "exceptions" | "delivered" | "all";

const CHIPS: { id: StatusFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "in_transit", label: "In transit" },
  { id: "exceptions", label: "Exceptions" },
  { id: "delivered", label: "Delivered" },
  { id: "all", label: "All" },
];

const PAGE_SIZE = 50;
const COMPACT_SIZE = 8;

interface Props {
  shipperKey: string;
  compact?: boolean;
}

// action_required is typed boolean, but the scraper has historically stored
// "YES"/"NO" strings — accept both.
function needsAction(v: unknown): boolean {
  return v === true || String(v ?? "").toUpperCase() === "YES";
}

function statusTone(status: string | null): string {
  const s = String(status || "").toLowerCase();
  if (!s) return "bg-slate-100 text-slate-500 ring-slate-200";
  if (/out\s+for\s+delivery/.test(s)) return "bg-teal-100 text-teal-700 ring-teal-200";
  if (/\bdelivered\b/.test(s)) return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  if (/exception|cancel|fail|damage|refused|hold|delay/.test(s)) return "bg-rose-100 text-rose-700 ring-rose-200";
  if (/transit|picked\s*up|en\s*route|departed/.test(s)) return "bg-sky-100 text-sky-700 ring-sky-200";
  if (/booked|tendered|scheduled|\bnew\b|dispatched/.test(s)) return "bg-violet-100 text-violet-700 ring-violet-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function StatusPill({ status }: { status: string | null }) {
  return (
    <span className={`inline-flex max-w-[11rem] items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${statusTone(status)}`} title={status || undefined}>
      {status || "Unknown"}
    </span>
  );
}

function CountCell({ n, icon: Icon, tone }: { n: number | null; icon: typeof Mail; tone: string }) {
  if (n == null) return <span className="text-slate-300">—</span>;
  if (n === 0) return <span className="text-slate-300">0</span>;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${tone}`}>
      <Icon className="h-3 w-3" />{n}
    </span>
  );
}

export function ShipperShipments({ shipperKey, compact = false }: Props) {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<StatusFilter>("active");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ShipperShipment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const firstLoad = useRef(true);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // Reset paging when the shipper changes.
  useEffect(() => { setPage(0); }, [shipperKey]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const limit = compact ? COMPACT_SIZE : PAGE_SIZE;
    getShipperShipments(
      shipperKey,
      { status, q: compact ? undefined : q || undefined, limit, offset: compact ? 0 : page * PAGE_SIZE },
      ctrl.signal,
    )
      .then((r) => {
        if (ctrl.signal.aborted) return;
        setRows(r.shipments || []);
        setTotal(r.total || 0);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) { setLoading(false); firstLoad.current = false; }
      });
    return () => ctrl.abort();
  }, [shipperKey, status, q, page, compact, reload]);

  function pickStatus(next: StatusFilter) {
    setStatus(next);
    setPage(0);
  }

  function openShipment(s: ShipperShipment) {
    const id = s.id || s.shipment_id || s.tracking_number;
    if (!id) return;
    navigate(`/tracking/${encodeURIComponent(id)}`);
  }

  function seeAll() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", "tracking");
      return next;
    });
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const colCount = 10;

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Truck className="h-4 w-4 text-slate-500" />
          Tracking
          {!loading || !firstLoad.current ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{total.toLocaleString()}</span>
          ) : null}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          {CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickStatus(c.id)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition ${
                status === c.id
                  ? c.id === "exceptions"
                    ? "bg-amber-500 text-white ring-amber-500"
                    : "bg-slate-900 text-white ring-slate-900"
                  : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {!compact ? (
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Shipment, tracking, order, reference…"
              className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-sm placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="p-4">
          <ErrorBlock>
            <div className="flex flex-wrap items-center gap-2">
              <span>{/not found|404/i.test(error) ? "This shipper has no shipments." : `Couldn't load shipments: ${error}`}</span>
              <button type="button" onClick={() => setReload((n) => n + 1)} className="rounded-md bg-white px-2 py-0.5 text-xs font-medium ring-1 ring-rose-200 hover:bg-rose-50">
                Retry
              </button>
            </div>
          </ErrorBlock>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Shipment</th>
                <th className="px-3 py-2 font-medium">Tracking #</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Carrier · mode</th>
                <th className="px-3 py-2 font-medium">Lane</th>
                <th className="px-3 py-2 font-medium">Pickup</th>
                <th className="px-3 py-2 font-medium">ETA / delivered</th>
                <th className="px-3 py-2 font-medium">Issue</th>
                <th className="px-3 py-2 font-medium text-center">Tasks</th>
                <th className="px-3 py-2 font-medium text-center">Emails</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && rows.length === 0 ? (
                <LoadingState variant="row" colSpan={colCount} label="Loading shipments…" />
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="p-8 text-center text-sm text-slate-500">
                    {q ? `No shipments match "${q}".` : "No shipments in this view."}
                  </td>
                </tr>
              ) : (
                rows.map((s) => {
                  const action = needsAction(s.action_required);
                  const delivered = !!s.delivery_date;
                  const carrierMode = [s.carrier_name, s.mode].filter(Boolean).join(" · ");
                  const lane = s.origin || s.destination ? `${s.origin || "?"} → ${s.destination || "?"}` : "";
                  return (
                    <tr
                      key={s.id}
                      onClick={() => openShipment(s)}
                      onKeyDown={(e) => { if (e.key === "Enter") openShipment(s); }}
                      tabIndex={0}
                      className={`cursor-pointer transition hover:bg-slate-50 focus:bg-slate-50 focus:outline-none ${loading ? "opacity-60" : ""}`}
                    >
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-sky-700">{s.shipment_id || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-700">{s.tracking_number || "—"}</td>
                      <td className="px-3 py-2"><StatusPill status={s.shipment_status} /></td>
                      <td className="max-w-[12rem] truncate px-3 py-2 text-slate-700" title={carrierMode || undefined}>{carrierMode || "—"}</td>
                      <td className="max-w-[16rem] truncate px-3 py-2 text-slate-700" title={lane || undefined}>{lane || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{fmtDate(s.pickup_date)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                        {delivered ? (
                          <span className="text-emerald-700" title="Delivered">{fmtDate(s.delivery_date)}</span>
                        ) : (
                          <span title="Estimated arrival">{fmtDate(s.estimated_arrival)}</span>
                        )}
                      </td>
                      <td className="max-w-[18rem] px-3 py-2">
                        {s.ai_issue ? (
                          <span
                            className={`flex items-center gap-1 truncate text-xs ${action ? "font-medium text-amber-700" : "text-slate-600"}`}
                            title={s.ai_issue}
                          >
                            {action ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : null}
                            <span className="truncate">{s.ai_issue}</span>
                          </span>
                        ) : action ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                            <AlertTriangle className="h-3.5 w-3.5" />Action needed
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <CountCell n={s.open_tasks} icon={ListChecks} tone="bg-violet-50 text-violet-700 ring-violet-200" />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <CountCell n={s.email_threads} icon={Mail} tone="bg-sky-50 text-sky-700 ring-sky-200" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {!error && compact && total > rows.length ? (
        <footer className="border-t border-slate-200 px-4 py-2 text-right">
          <button type="button" onClick={seeAll} className="text-sm font-medium text-sky-700 hover:text-sky-900">
            See all {total.toLocaleString()} →
          </button>
        </footer>
      ) : null}

      {!error && !compact && total > PAGE_SIZE ? (
        <footer className="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-2 text-sm text-slate-600">
          <span>{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page === 0 || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 ring-1 ring-slate-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />Prev
            </button>
            <span className="px-2 text-xs text-slate-500">Page {page + 1} of {pageCount}</span>
            <button
              type="button"
              disabled={page + 1 >= pageCount || loading}
              onClick={() => setPage((p) => p + 1)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 ring-1 ring-slate-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next<ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}
