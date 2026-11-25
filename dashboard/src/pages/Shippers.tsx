import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, Building2, ChevronRight, Mail, RefreshCw, Search, X } from "lucide-react";
import { useCached } from "../lib/useCached";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import { listShippers, shipperHref, type ShipperRow } from "../lib/shippersApi";

// All scraped shippers (fpx_shipments.customer_name) on one page: tracking,
// tasks and Support Mailbox counts per shipper. A row opens the shipper's
// dashboard at /shippers/:key.

const SORTS: { id: string; label: string }[] = [
  { id: "shipments", label: "Most shipments" },
  { id: "name", label: "Name (A–Z)" },
  { id: "open_tasks", label: "Most open tasks" },
  { id: "exceptions", label: "Most exceptions" },
  { id: "awaiting_reply", label: "Most awaiting reply" },
  { id: "last_email", label: "Latest email" },
];
const SORT_IDS = new Set(SORTS.map((s) => s.id));

function CountCell({ n, tone }: { n: number | null | undefined; tone?: "amber" | "red" }) {
  if (n == null) return <span className="text-slate-300">—</span>;
  if (n > 0 && tone === "red") return <span className="font-semibold text-red-600">{fmtNum(n)}</span>;
  if (n > 0 && tone === "amber") return <span className="font-semibold text-amber-600">{fmtNum(n)}</span>;
  return <span className={n > 0 ? "text-slate-800" : "text-slate-400"}>{fmtNum(n)}</span>;
}

function Rel({ at }: { at: string | null }) {
  if (!at) return <span className="text-slate-300">—</span>;
  return <span title={fmtDateTime(at)} className="text-slate-600 whitespace-nowrap">{fmtRelative(at)}</span>;
}

function TasksCell({ s }: { s: ShipperRow }) {
  return (
    <span className="whitespace-nowrap">
      <CountCell n={s.open_tasks} />
      {s.overdue_tasks > 0 ? <span className="ml-1.5 text-xs font-semibold text-red-600">{fmtNum(s.overdue_tasks)} overdue</span> : null}
    </span>
  );
}

function EmailCell({ s }: { s: ShipperRow }) {
  if (s.email_threads == null) return <span className="text-slate-300">—</span>;
  return (
    <span className="whitespace-nowrap">
      <CountCell n={s.awaiting_reply} tone="amber" />
      <span className="text-slate-400"> / {fmtNum(s.email_threads)}</span>
    </span>
  );
}

function Skeleton() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-slate-100 last:border-0">
          <div className="h-4 w-48 rounded bg-slate-200" />
          <div className="h-4 w-12 rounded bg-slate-100 ml-auto" />
          <div className="h-4 w-12 rounded bg-slate-100" />
          <div className="h-4 w-12 rounded bg-slate-100 hidden md:block" />
          <div className="h-4 w-16 rounded bg-slate-100 hidden md:block" />
        </div>
      ))}
    </div>
  );
}

export default function ShippersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const sortParam = params.get("sort") || "shipments";
  const sort = SORT_IDS.has(sortParam) ? sortParam : "shipments";

  // The box updates the URL after a short pause so typing doesn't refetch per key.
  const [draft, setDraft] = useState(q);
  useEffect(() => { setDraft(q); }, [q]);
  const setParam = useCallback((name: string, value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(name, value); else next.delete(name);
      return next;
    }, { replace: true });
  }, [setParams]);
  useEffect(() => {
    const t = draft.trim();
    if (t === q) return;
    const id = window.setTimeout(() => setParam("q", t), 300);
    return () => window.clearTimeout(id);
  }, [draft, q, setParam]);

  const fetcher = useCallback((signal: AbortSignal) => listShippers({ q, sort }, signal), [q, sort]);
  const { data, error, refreshing, refresh } = useCached(`shippers:list:${sort}:${q}`, fetcher);
  const shippers = data?.shippers ?? [];
  const totals = data?.totals ?? null;

  const tiles = totals ? ([
    { label: "Shippers", value: totals.shippers, tone: "bg-slate-50 text-slate-800 ring-slate-200" },
    { label: "Active shipments", value: totals.active, tone: "bg-sky-50 text-sky-800 ring-sky-200" },
    { label: "Open tasks", value: totals.open_tasks, tone: "bg-violet-50 text-violet-800 ring-violet-200" },
    { label: "Exceptions", value: totals.exceptions, tone: totals.exceptions > 0 ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-slate-50 text-slate-700 ring-slate-200" },
    ...(totals.awaiting_reply != null
      ? [{ label: "Awaiting reply", value: totals.awaiting_reply, tone: totals.awaiting_reply > 0 ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-slate-50 text-slate-700 ring-slate-200" }]
      : []),
  ]) : [];
  const showEmail = shippers.some((s) => s.email_threads != null) || (totals?.awaiting_reply != null);
  const open = (s: ShipperRow) => navigate(shipperHref(s.key));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Building2 className="h-6 w-6 text-slate-700" /> Shippers</h1>
          <p className="text-sm text-slate-500 mt-0.5">Every scraped shipper with its tracking, tasks and emails. Pick one to open its dashboard.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search shippers…"
              aria-label="Search shippers"
              className="rounded-lg border border-slate-200 pl-8 pr-8 py-2 text-sm bg-white w-full sm:w-64 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none"
            />
            {draft ? (
              <button
                onClick={() => { setDraft(""); setParam("q", ""); }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <select
            value={sort}
            onChange={(e) => setParam("sort", e.target.value === "shipments" ? "" : e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
            aria-label="Sort shippers"
          >
            {SORTS.filter((s) => showEmail || (s.id !== "awaiting_reply" && s.id !== "last_email")).map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <button
            onClick={refresh}
            className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 flex items-center gap-1.5 hover:bg-slate-800"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing && data ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {tiles.length ? (
        <div className={`grid grid-cols-2 gap-2 mb-4 ${tiles.length === 5 ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
          {tiles.map((t) => (
            <div key={t.label} className={`rounded-xl ring-1 px-3 py-2 ${t.tone}`}>
              <div className="text-[11px] uppercase tracking-wide opacity-80">{t.label}</div>
              <div className="text-xl font-semibold">{fmtNum(t.value)}</div>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-lg bg-red-50 text-red-700 px-4 py-2 text-sm flex items-center gap-3">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{data ? "Could not refresh: " : "Could not load shippers: "}{error}</span>
          <button onClick={refresh} className="rounded-md bg-white ring-1 ring-red-200 px-2.5 py-1 text-xs font-medium hover:bg-red-100">Retry</button>
        </div>
      ) : null}

      {!data && !error ? (
        <Skeleton />
      ) : !data ? null : shippers.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl text-center py-12 px-4">
          <Building2 className="h-8 w-8 text-slate-300 mx-auto mb-2" />
          <div className="text-sm font-medium text-slate-700">{q ? `No shippers match "${q}".` : "No shippers yet."}</div>
          <div className="text-xs text-slate-500 mt-1">{q ? "Try a shorter search." : "Shippers appear here once shipments are scraped."}</div>
          {q ? (
            <button onClick={() => { setDraft(""); setParam("q", ""); }} className="mt-3 text-sm text-sky-700 hover:underline">Clear search</button>
          ) : null}
        </div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left">Shipper</th>
                  <th className="px-3 py-3 text-right">Active</th>
                  <th className="px-3 py-3 text-right">In transit</th>
                  <th className="px-3 py-3 text-right">Exceptions</th>
                  <th className="px-3 py-3 text-right">Open tasks</th>
                  {showEmail ? <th className="px-3 py-3 text-right" title="Threads awaiting reply / all linked threads">Emails</th> : null}
                  {showEmail ? <th className="px-3 py-3 text-left">Last email</th> : null}
                  <th className="px-3 py-3 text-left">Last scraped</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shippers.map((s) => (
                  <tr key={s.key} onClick={() => open(s)} className="cursor-pointer hover:bg-slate-50 group">
                    <td className="px-4 py-2.5">
                      <Link
                        to={shipperHref(s.key)}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-slate-900 hover:text-sky-700 hover:underline"
                      >
                        {s.customer_name}
                      </Link>
                      <div className="text-xs text-slate-400">{fmtNum(s.shipments)} shipments</div>
                    </td>
                    <td className="px-3 py-2.5 text-right"><CountCell n={s.active} /></td>
                    <td className="px-3 py-2.5 text-right"><CountCell n={s.in_transit} /></td>
                    <td className="px-3 py-2.5 text-right"><CountCell n={s.exceptions} tone="amber" /></td>
                    <td className="px-3 py-2.5 text-right"><TasksCell s={s} /></td>
                    {showEmail ? <td className="px-3 py-2.5 text-right"><EmailCell s={s} /></td> : null}
                    {showEmail ? <td className="px-3 py-2.5"><Rel at={s.last_email_at} /></td> : null}
                    <td className="px-3 py-2.5"><Rel at={s.last_scraped_at} /></td>
                    <td className="pr-3 text-slate-300 group-hover:text-slate-500"><ChevronRight className="h-4 w-4" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: cards */}
          <div className="md:hidden space-y-2">
            {shippers.map((s) => (
              <Link
                key={s.key}
                to={shipperHref(s.key)}
                className="block bg-white border border-slate-200 rounded-xl px-4 py-3 hover:bg-slate-50"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900 truncate flex-1">{s.customer_name}</span>
                  <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                </div>
                <div className="text-xs text-slate-400 mb-2">{fmtNum(s.shipments)} shipments · scraped <Rel at={s.last_scraped_at} /></div>
                <div className="grid grid-cols-4 gap-2 text-center text-sm">
                  <div><div className="text-[10px] uppercase text-slate-400">Active</div><CountCell n={s.active} /></div>
                  <div><div className="text-[10px] uppercase text-slate-400">Transit</div><CountCell n={s.in_transit} /></div>
                  <div><div className="text-[10px] uppercase text-slate-400">Except.</div><CountCell n={s.exceptions} tone="amber" /></div>
                  <div>
                    <div className="text-[10px] uppercase text-slate-400">Tasks</div>
                    <CountCell n={s.open_tasks} />
                    {s.overdue_tasks > 0 ? <div className="text-[10px] font-semibold text-red-600">{fmtNum(s.overdue_tasks)} overdue</div> : null}
                  </div>
                </div>
                {s.email_threads != null ? (
                  <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-xs text-slate-500">
                    <Mail className="h-3.5 w-3.5" />
                    <EmailCell s={s} />
                    <span>awaiting reply</span>
                    <span className="ml-auto"><Rel at={s.last_email_at} /></span>
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
