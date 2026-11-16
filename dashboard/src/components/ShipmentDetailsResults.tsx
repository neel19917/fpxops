import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import type { ShipmentDetailsList, ShipmentDetailsListRow } from "../lib/shipmentDetails";
import { fmtDateTime, fmtNum } from "../lib/format";

// The stored FreightPOP details for the tracked shipments: totals, a search
// box and a sortable table. The page supplies the card and heading around it.

type SortKey = "shipment" | "customer" | "carrier" | "sale" | "cost" | "gross_profit" | "margin" | "quote_total" | "captured_at";
type SortDir = "asc" | "desc";
type SortValue = string | number | null;

const PLACEHOLDER = "—";

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return PLACEHOLDER;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Gross profit as a share of the sale, in percent. Null when it cannot be worked out.
function marginOf(r: ShipmentDetailsListRow): number | null {
  if (typeof r.gross_profit !== "number" || typeof r.sale !== "number" || r.sale === 0) return null;
  const m = (r.gross_profit / r.sale) * 100;
  return Number.isFinite(m) ? m : null;
}

function text(s: string | null): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function time(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

const COLUMNS: { key: SortKey; label: string; numeric: boolean; firstDir: SortDir; value: (r: ShipmentDetailsListRow) => SortValue }[] = [
  { key: "shipment", label: "Shipment", numeric: false, firstDir: "asc", value: (r) => text(r.shipment_id) },
  { key: "customer", label: "Customer", numeric: false, firstDir: "asc", value: (r) => text(r.customer) },
  { key: "carrier", label: "Carrier", numeric: false, firstDir: "asc", value: (r) => text(r.carrier) },
  { key: "sale", label: "Sale", numeric: true, firstDir: "desc", value: (r) => r.sale },
  { key: "cost", label: "Cost", numeric: true, firstDir: "desc", value: (r) => r.cost },
  { key: "gross_profit", label: "Gross profit", numeric: true, firstDir: "desc", value: (r) => r.gross_profit },
  { key: "margin", label: "Margin %", numeric: true, firstDir: "desc", value: marginOf },
  { key: "quote_total", label: "Quote total", numeric: true, firstDir: "desc", value: (r) => r.quote_total },
  { key: "captured_at", label: "Read at", numeric: false, firstDir: "desc", value: (r) => time(r.captured_at) },
];

function compare(a: SortValue, b: SortValue, dir: SortDir): number {
  // Rows without a value go last whichever way the column is sorted.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const c = typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), "en-US", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

export function ShipmentDetailsResults({ data, loading, error, onRetry }: {
  data: ShipmentDetailsList | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "gross_profit", dir: "desc" });

  const q = query.trim().toLowerCase();
  const rows = data?.rows;

  const visible = useMemo(() => {
    if (!rows) return [];
    const col = COLUMNS.find((c) => c.key === sort.key) ?? COLUMNS[0];
    const matched = q
      ? rows.filter((r) => [r.shipment_id, r.customer, r.carrier].some((v) => (v ?? "").toLowerCase().includes(q)))
      : rows;
    return matched
      .map((row) => ({ row, v: col.value(row) }))
      .sort((a, b) => compare(a.v, b.v, sort.dir))
      .map((x) => x.row);
  }, [rows, q, sort]);

  const pickSort = (key: SortKey, firstDir: SortDir) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir }));

  const errorBox = error ? (
    <div role="alert" className="flex items-start gap-3 rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800">
      <div className="min-w-0 flex-1 break-words">{error}</div>
      <button
        type="button"
        onClick={onRetry}
        disabled={loading}
        className="shrink-0 text-xs px-2 py-0.5 rounded-md ring-1 ring-rose-300 bg-white text-rose-800 hover:bg-rose-100 whitespace-nowrap disabled:opacity-60"
      >
        Try again
      </button>
    </div>
  ) : null;

  if (!data) {
    return (
      <div className="space-y-3">
        {errorBox}
        {!error && loading ? <p role="status" className="text-sm text-slate-600">Loading stored details.</p> : null}
      </div>
    );
  }

  const total = data.rows.length;

  return (
    <div className="space-y-4">
      {errorBox}

      <div className="flex flex-wrap items-end gap-3">
        <Tile label="Total sale" value={money(data.totals.sale)} />
        <Tile label="Total cost" value={money(data.totals.cost)} />
        <Tile label="Total gross profit" value={money(data.totals.gross_profit)} negative={data.totals.gross_profit < 0} />
        <p className="text-sm text-slate-600 pb-1">
          <span className="font-semibold tabular-nums text-slate-900">{fmtNum(data.read)}</span> of{" "}
          <span className="font-semibold tabular-nums text-slate-900">{fmtNum(data.tracked)}</span> tracked shipments read
        </p>
      </div>

      {total === 0 ? (
        <p className="text-sm text-slate-600">No shipment details are stored yet. Start a read to fill this table.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-80">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                aria-label="Search shipments"
                placeholder="Search shipment, customer or carrier"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-lg bg-white ring-1 ring-slate-200 pl-8 pr-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
            {q ? (
              <p role="status" className="text-xs text-slate-600 tabular-nums">
                Showing {fmtNum(visible.length)} of {fmtNum(total)}
              </p>
            ) : null}
          </div>

          {visible.length === 0 ? (
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span>No shipments match.</span>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-xs px-2 py-0.5 rounded-md bg-white ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50"
              >
                Clear search
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => {
                      const active = sort.key === c.key;
                      const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
                      return (
                        <th
                          key={c.key}
                          scope="col"
                          aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                          className={`py-2 px-2 whitespace-nowrap ${c.numeric ? "text-right" : "text-left"}`}
                        >
                          <button
                            type="button"
                            onClick={() => pickSort(c.key, c.firstDir)}
                            className={`inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-semibold hover:text-slate-900 ${active ? "text-slate-900" : "text-slate-500"}`}
                          >
                            {c.label}
                            {active ? <Arrow aria-hidden="true" className="h-3 w-3" /> : null}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const margin = marginOf(r);
                    return (
                      <tr key={r.shipment_id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="py-1.5 px-2 whitespace-nowrap">
                          <Link to={`/tracking/${encodeURIComponent(r.shipment_id)}`} className="text-sky-700 hover:underline">
                            {r.shipment_id}
                          </Link>
                        </td>
                        <td className="py-1.5 px-2 text-slate-800 truncate max-w-[240px]">{text(r.customer) ?? PLACEHOLDER}</td>
                        <td className="py-1.5 px-2 text-slate-800 truncate max-w-[200px]">{text(r.carrier) ?? PLACEHOLDER}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-slate-800">{money(r.sale)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-slate-800">{money(r.cost)}</td>
                        <td className={`py-1.5 px-2 text-right tabular-nums ${typeof r.gross_profit === "number" && r.gross_profit < 0 ? "text-rose-700" : "text-slate-800"}`}>
                          {money(r.gross_profit)}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-slate-800">{margin == null ? PLACEHOLDER : `${margin.toFixed(1)}%`}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-slate-800">{money(r.quote_total)}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">{r.captured_at ? fmtDateTime(r.captured_at) : PLACEHOLDER}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 min-w-[150px]">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${negative ? "text-rose-700" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}
