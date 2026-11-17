import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, Download, Loader2, Search } from "lucide-react";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import {
  MATCHED_ON_LABEL, MATCH_MAX, PUSHED_SOURCE_HINT, PUSHED_SOURCE_LABEL,
  downloadPushedExcel, fetchPushed, matchCsv, matchPushed, saveBlob, splitPasted,
  type MatchResponse, type MatchResult, type PushedFilters, type PushedList, type PushedRow,
} from "../lib/erpPushed";

// Pushed to ERP: the invoices FreightPOP has already exported to the ERP
// (NetSuite), to match against NetSuite. Read only.

const PAGE = 200;
const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1";
const PRIMARY_BTN = "px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed " + FOCUS;
const SECONDARY_BTN = "px-3 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed " + FOCUS;
const SMALL_BTN = "px-2.5 py-1.5 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed " + FOCUS;
const INPUT = "px-3 py-2 rounded-lg ring-1 ring-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500";
const TH = "px-4 py-3 font-medium whitespace-nowrap";
const TD = "px-4 py-3 align-top";
const MONEY = TD + " text-right tabular-nums whitespace-nowrap text-slate-900";

const RANGES = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"]] as const;

/** A local calendar day as YYYY-MM-DD. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}
/** "Nov 17, 2026" from a date-only string, without the time-zone shift of new Date("2026-11-17"). */
function fmtDay(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(`${s.slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function money(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}
const dash = <span className="text-slate-300">—</span>;

function Alert({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 text-sm px-3 py-2">{children}</div>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3" title={hint}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

/** GL code, vendor id, PO, SO and batch number, when FreightPOP has them. */
function references(r: PushedRow): [string, string][] {
  const pairs: [string, string | null][] = [
    ["GL", r.gl_code], ["Vendor ID", r.internal_vendor_id], ["PO", r.po_number], ["SO", r.so_number], ["Batch", r.batch_number],
  ];
  return pairs.filter((p): p is [string, string] => !!p[1]);
}

function PushedCell({ r }: { r: PushedRow }) {
  if (!r.pushed_date) {
    return <span className="text-slate-500" title={PUSHED_SOURCE_HINT.unknown}>Date not known</span>;
  }
  return (
    <span title={PUSHED_SOURCE_HINT[r.pushed_date_source]}>
      <span className="text-slate-900">{fmtDay(r.pushed_date)}</span>
      <span className="block text-xs text-slate-500">{PUSHED_SOURCE_LABEL[r.pushed_date_source]}</span>
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!done && !failed) return;
    const id = setTimeout(() => { setDone(false); setFailed(false); }, 2000);
    return () => clearTimeout(id);
  }, [done, failed]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      setFailed(true);
    }
  }
  return (
    <button type="button" onClick={copy} disabled={!text} className={SMALL_BTN}>
      {done ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      <span aria-live="polite">{done ? "Copied" : failed ? "Could not copy" : label}</span>
    </button>
  );
}

// ── Match against NetSuite ──

type GroupKey = "pushed" | "not_pushed" | "not_found";
const GROUPS: { key: GroupKey; title: string; hint: string; dot: string; file: string }[] = [
  { key: "pushed", title: "Pushed to ERP", hint: "FreightPOP has these as exported to the ERP.", dot: "bg-emerald-500", file: "pushed" },
  { key: "not_pushed", title: "In FreightPOP, not pushed", hint: "Found in FreightPOP, but not marked as exported to the ERP.", dot: "bg-amber-500", file: "not-pushed" },
  { key: "not_found", title: "Not found", hint: "No shipment or invoice in FreightPOP has this number.", dot: "bg-rose-500", file: "not-found" },
];
const groupOf = (m: MatchResult): GroupKey => (m.pushed ? "pushed" : m.found ? "not_pushed" : "not_found");

function MatchGroup({ group, results }: { group: (typeof GROUPS)[number]; results: MatchResult[] }) {
  const found = group.key !== "not_found";
  return (
    <section className="rounded-xl ring-1 ring-slate-200 bg-white min-w-0 flex flex-col">
      <header className="px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <span className={"h-2 w-2 rounded-full " + group.dot} aria-hidden="true" />
            {group.title} <span className="tabular-nums text-slate-500 font-normal">{fmtNum(results.length)}</span>
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">{group.hint}</p>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton text={results.map((m) => m.input).join("\n")} label="Copy numbers" />
          <button type="button" disabled={!results.length} onClick={() => saveBlob(matchCsv(results), `netsuite-match-${group.file}.csv`)} className={SMALL_BTN}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
          </button>
        </div>
      </header>
      {results.length ? (
        <div className="max-h-80 overflow-auto border-t border-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white shadow-[inset_0_-1px_0_var(--color-slate-200)]">
              <tr className="text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">Pasted</th>
                {found ? <><th className="px-4 py-2 font-medium">Shipment</th><th className="px-4 py-2 font-medium">Matched on</th><th className="px-4 py-2 font-medium text-right">Charge</th></> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {results.map((m) => (
                <tr key={m.input}>
                  <td className="px-4 py-2 font-mono text-xs text-slate-900 break-all">{m.input}</td>
                  {found ? (
                    <>
                      <td className="px-4 py-2 text-slate-700">
                        {m.row?.shipment_id ?? <span className="text-slate-500">No shipment row</span>}
                        <span className="block text-xs text-slate-500">
                          {[m.row?.customer_name, m.pushed ? (m.row?.pushed_date ? `pushed ${fmtDay(m.row.pushed_date)}` : "push date not known") : null].filter(Boolean).join(" · ")}
                        </span>
                        {m.others > 0 ? <span className="block text-xs text-amber-700">Also matches {fmtNum(m.others)} other {m.others === 1 ? "shipment" : "shipments"}</span> : null}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">{m.matched_on ? MATCHED_ON_LABEL[m.matched_on] : ""}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-slate-900">{money(m.row?.charge)}</td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-6 text-sm text-slate-400 border-t border-slate-200">None.</p>
      )}
    </section>
  );
}

function MatchBox() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MatchResponse | null>(null);
  const values = useMemo(() => splitPasted(text), [text]);
  const tooMany = values.length > MATCH_MAX;

  async function run() {
    if (!values.length || tooMany || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await matchPushed(values));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const by: Record<GroupKey, MatchResult[]> = { pushed: [], not_pushed: [], not_found: [] };
    for (const m of result?.results ?? []) by[groupOf(m)].push(m);
    return by;
  }, [result]);

  return (
    <section className="rounded-xl bg-white ring-1 ring-slate-200 p-4 space-y-3" aria-labelledby="match-title">
      <div>
        <h2 id="match-title" className="text-base font-semibold text-slate-900">Match against NetSuite</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Paste invoice numbers or shipment IDs from NetSuite, one per line or separated by commas. Each one is looked up in everything FPX has read from FreightPOP, whatever the dates above.
        </p>
      </div>
      <label htmlFor="match-paste" className="sr-only">Invoice numbers or shipment IDs</label>
      <textarea
        id="match-paste"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={"15725111\n15717915\nINV-40021"}
        className={INPUT + " w-full font-mono resize-y"}
      />
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={run} disabled={!values.length || tooMany || busy} className={PRIMARY_BTN}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />}
          {busy ? "Matching" : "Match"}
        </button>
        {text || result ? (
          <button type="button" onClick={() => { setText(""); setResult(null); setError(null); }} disabled={busy} className={SECONDARY_BTN}>Clear</button>
        ) : null}
        <span className={"text-sm tabular-nums " + (tooMany ? "text-rose-700" : "text-slate-500")}>
          {tooMany ? `${fmtNum(values.length)} numbers: at most ${fmtNum(MATCH_MAX)} at a time` : values.length ? `${fmtNum(values.length)} ${values.length === 1 ? "number" : "numbers"}` : ""}
        </span>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {result ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-slate-700 tabular-nums">
            {fmtNum(result.summary.total)} checked: {fmtNum(result.summary.pushed)} pushed, {fmtNum(result.summary.not_pushed)} in FreightPOP but not pushed, {fmtNum(result.summary.not_found)} not found.
          </p>
          <div className="grid gap-3 xl:grid-cols-3">
            {GROUPS.map((g) => <MatchGroup key={g.key} group={g} results={grouped[g.key]} />)}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Page ──

export function InvoicesPushedPage() {
  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [includeUndated, setIncludeUndated] = useState(false);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<PushedList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The search box applies a moment after typing stops.
  useEffect(() => {
    const id = setTimeout(() => { setQ(search.trim()); setOffset(0); }, 350);
    return () => clearTimeout(id);
  }, [search]);

  const rangeBad = !!from && !!to && from > to;
  const filters: PushedFilters = useMemo(
    () => ({ from: from || undefined, to: to || undefined, datedOnly: !includeUndated, q }),
    [from, to, includeUndated, q],
  );

  const load = useCallback((signal: AbortSignal) => {
    if (rangeBad) return;
    setLoading(true);
    setError(null);
    fetchPushed({ ...filters, limit: PAGE, offset }, signal)
      .then((got) => { if (!signal.aborted) { setList(got); scroller.current?.scrollTo({ top: 0 }); } })
      .catch((e) => { if (!signal.aborted) setError(errText(e)); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
  }, [filters, offset, rangeBad]);

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  function pickRange(days: number | null) {
    setFrom(days == null ? "" : daysAgo(days));
    setTo(days == null ? "" : isoDay(new Date()));
    setOffset(0);
  }
  const activeRange = !from && !to ? "all" : to === isoDay(new Date()) ? RANGES.find(([d]) => from === daysAgo(d))?.[0] ?? null : null;

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadPushedExcel(filters);
    } catch (e) {
      setDownloadError(errText(e));
    } finally {
      setDownloading(false);
    }
  }

  const totals = list?.totals ?? null;
  const rows = list?.data ?? [];
  const count = totals?.count ?? 0;
  const first = count ? (list?.offset ?? 0) + 1 : 0;
  const last = (list?.offset ?? 0) + rows.length;
  const rangeChip = (on: boolean) => "px-3 py-1.5 rounded-md text-sm whitespace-nowrap " + FOCUS + " " + (on ? "bg-white text-slate-900 font-medium shadow-sm" : "text-slate-600 hover:text-slate-900");

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Link to="/invoicing" className={"inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 rounded " + FOCUS}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Invoicing
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Pushed to ERP</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-3xl">
            Invoices FreightPOP has already exported to the ERP, to match against NetSuite. Read only: nothing is changed in FreightPOP.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button type="button" onClick={download} disabled={downloading || rangeBad || !count} className={PRIMARY_BTN}>
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            {downloading ? "Building the file" : "Download Excel"}
          </button>
          <span className="text-xs text-slate-500 tabular-nums">{count ? `All ${fmtNum(count)} matching invoices` : ""}</span>
        </div>
      </header>

      {downloadError ? <Alert>The Excel file could not be downloaded: {downloadError}</Alert> : null}

      <section className="rounded-xl bg-white ring-1 ring-slate-200 p-4 space-y-3" aria-label="Filters">
        <div className="flex items-end gap-x-4 gap-y-3 flex-wrap">
          <div>
            <label htmlFor="pushed-from" className="block text-xs text-slate-500 mb-1">Pushed from</label>
            <input id="pushed-from" type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} className={INPUT} />
          </div>
          <div>
            <label htmlFor="pushed-to" className="block text-xs text-slate-500 mb-1">Pushed to</label>
            <input id="pushed-to" type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setOffset(0); }} className={INPUT} />
          </div>
          <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5" role="group" aria-label="Quick date ranges">
            {RANGES.map(([days, label]) => (
              <button key={days} type="button" onClick={() => pickRange(days)} aria-pressed={activeRange === days} className={rangeChip(activeRange === days)}>{label}</button>
            ))}
            <button type="button" onClick={() => pickRange(null)} aria-pressed={activeRange === "all"} className={rangeChip(activeRange === "all")}>All dates</button>
          </div>
          <div className="relative ml-auto">
            <label htmlFor="pushed-search" className="sr-only">Search pushed invoices</label>
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            <input
              id="pushed-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Shipment, invoice, tracking, customer, carrier"
              className={INPUT + " pl-9 w-96 max-w-full"}
            />
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700 w-fit cursor-pointer">
          <input
            type="checkbox"
            checked={includeUndated}
            onChange={(e) => { setIncludeUndated(e.target.checked); setOffset(0); }}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
          />
          <span>
            Include invoices with no known push date
            <span className="block text-xs text-slate-500">
              Many older invoices were already exported when FPX first read them, and FreightPOP gave no export date. They are listed after the dated ones.
            </span>
          </span>
        </label>
        {rangeBad ? <Alert>The first date is after the second.</Alert> : null}
      </section>

      {error ? (
        <Alert>
          The list could not be loaded: {error}{" "}
          <button type="button" onClick={() => load(new AbortController().signal)} className="underline font-medium">Try again</button>
        </Alert>
      ) : null}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5" aria-busy={loading}>
        <Stat label="Invoices pushed" value={totals ? fmtNum(totals.count) : "—"} hint="One per shipment FreightPOP has as exported to ERP" />
        <Stat label="Charge" value={totals ? money(totals.charge) : "—"} hint="What the customers were charged" />
        <Stat label="Cost" value={totals ? money(totals.cost) : "—"} hint="The carrier rate, without mark-up" />
        <Stat label="Approved invoice amount" value={totals ? money(totals.approved_invoice_amount) : "—"} hint="The approved carrier invoice amounts" />
        <Stat
          label="No known push date"
          value={totals ? (includeUndated ? fmtNum(totals.undated) : "Not included") : "—"}
          hint="Already exported the first time FPX read them, with no export date from FreightPOP"
        />
      </div>

      <section className="rounded-xl bg-white ring-1 ring-slate-200 overflow-hidden" aria-label="Pushed invoices">
        <div ref={scroller} className="max-h-[70vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-[1] bg-white shadow-[inset_0_-1px_0_var(--color-slate-200)]">
              <tr className="text-left text-xs text-slate-500">
                <th className={TH + " pl-6"}>Shipment</th>
                <th className={TH}>Customer invoice</th>
                <th className={TH}>Carrier invoice</th>
                <th className={TH}>Customer</th>
                <th className={TH}>Carrier</th>
                <th className={TH}>Shipped</th>
                <th className={TH}>Pushed</th>
                <th className={TH + " text-right"}>Charge</th>
                <th className={TH + " text-right"}>Cost</th>
                <th className={TH + " text-right"}>Approved amount</th>
                <th className={TH}>Approved</th>
                <th className={TH}>References</th>
                <th className={TH + " pr-6"}>Last read from FreightPOP</th>
              </tr>
            </thead>
            <tbody className={"divide-y divide-slate-100 " + (loading && list ? "opacity-60" : "")}>
              {!list && loading ? (
                <tr><td colSpan={13} className="px-6 py-16 text-center text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" aria-hidden="true" />Loading. The first read can take up to a minute.
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={13} className="px-6 py-16 text-center text-sm text-slate-500">
                  {error ? "Nothing to show." : includeUndated ? "No pushed invoices match." : "No pushed invoices with a known push date match. Tick the box above to include the ones with no known date."}
                </td></tr>
              ) : rows.map((r) => {
                const refs = references(r);
                const more = r.invoice_numbers.length - (r.invoice_number ? 1 : 0);
                return (
                  <tr key={r.shipment_id ?? `${r.tracking_number}|${r.invoice_number}`} className="hover:bg-slate-50/60">
                    <td className={TD + " pl-6 whitespace-nowrap"}>
                      <span className="font-medium text-slate-900">{r.shipment_id ?? dash}</span>
                      <span className="block text-xs text-slate-500">{r.tracking_number ?? ""}</span>
                    </td>
                    <td className={TD + " whitespace-nowrap text-slate-700"}>{r.billing_invoice_number ?? dash}</td>
                    <td className={TD + " whitespace-nowrap text-slate-700"}>
                      {r.invoice_number ?? dash}
                      {more > 0 ? <span className="block text-xs text-slate-500" title={r.invoice_numbers.join(", ")}>and {more} more</span> : null}
                    </td>
                    <td className={TD + " text-slate-700 max-w-[16rem]"}>{r.customer_name ?? dash}</td>
                    <td className={TD + " text-slate-500 max-w-[14rem]"}>{r.carrier ?? dash}</td>
                    <td className={TD + " whitespace-nowrap text-slate-500"}>{r.shipped_date ? fmtDay(r.shipped_date) : dash}</td>
                    <td className={TD + " whitespace-nowrap"}><PushedCell r={r} /></td>
                    <td className={MONEY}>{r.charge == null ? dash : money(r.charge)}</td>
                    <td className={MONEY}>{r.cost == null ? dash : money(r.cost)}</td>
                    <td className={MONEY}>{r.approved_invoice_amount == null ? dash : money(r.approved_invoice_amount)}</td>
                    <td className={TD + " whitespace-nowrap text-slate-700"}>
                      {r.approved_date ? fmtDay(r.approved_date) : dash}
                      {r.approved_by ? <span className="block text-xs text-slate-500">{r.approved_by}</span> : null}
                    </td>
                    <td className={TD + " text-xs text-slate-600 whitespace-nowrap"}>
                      {refs.length ? refs.map(([k, v]) => <span key={k} className="block"><span className="text-slate-400">{k}</span> {v}</span>) : dash}
                    </td>
                    <td className={TD + " pr-6 whitespace-nowrap text-slate-500"} title={r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : undefined}>
                      {r.last_seen_at ? <>{fmtDateTime(r.last_seen_at)}<span className="block text-xs text-slate-400">{fmtRelative(r.last_seen_at)}</span></> : dash}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-t border-slate-200 text-sm text-slate-600">
          <span className="tabular-nums" role="status">
            {count ? `${fmtNum(first)} to ${fmtNum(last)} of ${fmtNum(count)}` : loading ? "Loading" : "0 invoices"}
            {loading && list ? <Loader2 className="h-3.5 w-3.5 animate-spin inline ml-2" aria-label="Loading" /> : null}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={loading || offset === 0} className={SECONDARY_BTN}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
            </button>
            <button type="button" onClick={() => setOffset(offset + PAGE)} disabled={loading || last >= count} className={SECONDARY_BTN}>
              Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </footer>
      </section>

      <MatchBox />
    </div>
  );
}
