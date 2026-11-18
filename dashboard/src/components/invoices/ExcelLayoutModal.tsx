import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Loader2, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import {
  EXPORT_STATUSES, defaultLayout, fetchExportColumns,
  type ExportColumn, type ExportLayout,
} from "../../lib/getInvoiceRuns";

// Customize the Get Invoice Excel: tick the columns to keep, put them in
// order, rename any header, choose the sort and which rows go in. Saved in
// this browser and used by every Excel and ZIP download on the page.

type Props = {
  layout: ExportLayout | null; // null = the default sheet
  onSave: (layout: ExportLayout | null) => void;
  onClose: () => void;
};

type Item = { key: string; label: string; on: boolean };

export function ExcelLayoutModal({ layout, onSave, onClose }: Props) {
  const [cols, setCols] = useState<ExportColumn[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [sort, setSort] = useState("");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [latest, setLatest] = useState(false);

  // The chosen columns first, in their order, then the rest unticked.
  const fill = (all: ExportColumn[], l: ExportLayout) => {
    const known = new Map(all.map((c) => [c.key, c]));
    const chosen = l.columns.filter((c) => known.has(c.key)).map((c) => ({ key: c.key, label: c.label, on: true }));
    const rest = all.filter((c) => !chosen.some((x) => x.key === c.key)).map((c) => ({ key: c.key, label: "", on: false }));
    setItems([...chosen, ...rest]);
    setSort(known.has(l.sort) ? l.sort : "");
    setDir(l.dir === "desc" ? "desc" : "asc");
    setStatuses(l.statuses.filter((s) => EXPORT_STATUSES.some((x) => x.key === s)));
    setLatest(!!l.latest);
  };

  useEffect(() => {
    let gone = false;
    fetchExportColumns().then(
      (all) => { if (gone) return; setCols(all); fill(all, layout ?? defaultLayout(all)); },
      (e: unknown) => { if (!gone) setErr((e as Error)?.message || "The columns could not be loaded."); },
    );
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const byKey = useMemo(() => new Map((cols ?? []).map((c) => [c.key, c])), [cols]);
  const onCount = items.filter((i) => i.on).length;

  const move = (idx: number, by: -1 | 1) => setItems((list) => {
    const j = idx + by;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });
  const patch = (idx: number, p: Partial<Item>) => setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...p } : it)));
  const setAll = (on: boolean) => setItems((list) => list.map((it) => ({ ...it, on })));

  function save() {
    if (!cols) return;
    const next: ExportLayout = {
      columns: items.filter((i) => i.on).map((i) => ({ key: i.key, label: i.label.trim() })),
      sort, dir, statuses, latest,
    };
    const def = defaultLayout(cols);
    onSave(JSON.stringify(next) === JSON.stringify(def) ? null : next);
    onClose();
  }

  // The headers as the sheet will have them, for the preview line.
  const preview = items.filter((i) => i.on).map((i) => i.label.trim() || byKey.get(i.key)?.label || i.key);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="excel-layout-title" className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200">
          <div className="min-w-0">
            <h2 id="excel-layout-title" className="text-lg font-semibold flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5 text-violet-600 shrink-0" /> Customize the Excel
            </h2>
            <p className="text-sm text-slate-600 mt-1">Pick the columns, put them in order and rename any header to match your spreadsheet. Used by every Excel and ZIP download on this page, in this browser.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
          {err ? (
            <div role="alert" className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 text-sm px-3 py-2">{err}</div>
          ) : !cols ? (
            <div role="status" className="py-10 text-center text-sm text-slate-500 inline-flex w-full items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the columns…
            </div>
          ) : (
            <>
              <section>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-slate-900">Columns <span className="font-normal text-slate-500">({onCount} of {items.length})</span></h3>
                  <div className="flex gap-2 text-xs">
                    <button type="button" className="text-violet-700 hover:underline" onClick={() => setAll(true)}>Tick all</button>
                    <button type="button" className="text-violet-700 hover:underline" onClick={() => setAll(false)}>Untick all</button>
                  </div>
                </div>
                <ol className="rounded-xl ring-1 ring-slate-200 divide-y divide-slate-100">
                  {items.map((it, idx) => {
                    const col = byKey.get(it.key);
                    return (
                      <li key={it.key} className={"flex items-center gap-2 px-3 py-1.5 " + (it.on ? "" : "bg-slate-50/60")}>
                        <input
                          type="checkbox" checked={it.on} onChange={(e) => patch(idx, { on: e.target.checked })}
                          aria-label={`Include ${col?.label ?? it.key}`} className="h-4 w-4 accent-violet-600 shrink-0"
                        />
                        <span className={"w-48 shrink-0 truncate text-sm " + (it.on ? "text-slate-900" : "text-slate-400")} title={col?.label}>{col?.label ?? it.key}</span>
                        <input
                          type="text" value={it.label} disabled={!it.on} maxLength={80}
                          onChange={(e) => patch(idx, { label: e.target.value })}
                          placeholder="Header in the sheet (optional)" aria-label={`Header for ${col?.label ?? it.key}`}
                          className="min-w-0 flex-1 rounded-md ring-1 ring-slate-300 px-2 py-1 text-sm disabled:bg-transparent disabled:ring-slate-200 disabled:text-slate-400"
                        />
                        <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label={`Move ${col?.label ?? it.key} up`}
                          className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                        <button type="button" onClick={() => move(idx, 1)} disabled={idx === items.length - 1} aria-label={`Move ${col?.label ?? it.key} down`}
                          className="p-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                      </li>
                    );
                  })}
                </ol>
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 mb-2">Sort rows by</h3>
                  <div className="flex gap-2">
                    <select value={sort} onChange={(e) => setSort(e.target.value)} className="min-w-0 flex-1 rounded-md ring-1 ring-slate-300 px-2 py-1.5 text-sm bg-white">
                      <option value="">The run's own order</option>
                      {cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                    <select value={dir} onChange={(e) => setDir(e.target.value === "desc" ? "desc" : "asc")} disabled={!sort} className="rounded-md ring-1 ring-slate-300 px-2 py-1.5 text-sm bg-white disabled:opacity-40">
                      <option value="asc">Low to high / A to Z</option>
                      <option value="desc">High to low / Z to A</option>
                    </select>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 mb-2">Which rows</h3>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {EXPORT_STATUSES.map((s) => (
                      <label key={s.key} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                        <input type="checkbox" className="h-4 w-4 accent-violet-600"
                          checked={statuses.length === 0 || statuses.includes(s.key)}
                          onChange={(e) => {
                            const all = EXPORT_STATUSES.map((x) => x.key);
                            const cur = statuses.length ? statuses : all;
                            const next = e.target.checked ? [...new Set([...cur, s.key])] : cur.filter((k) => k !== s.key);
                            setStatuses(next.length === all.length ? [] : next);
                          }} />
                        {s.label}
                      </label>
                    ))}
                  </div>
                  <label className="mt-2 inline-flex items-center gap-1.5 text-sm text-slate-700">
                    <input type="checkbox" className="h-4 w-4 accent-violet-600" checked={latest} onChange={(e) => setLatest(e.target.checked)} />
                    One row per shipment (its newest run only)
                  </label>
                </div>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-slate-900 mb-1">The sheet's header row</h3>
                <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2 text-xs text-slate-700 overflow-x-auto whitespace-nowrap">
                  {preview.length ? preview.join("  |  ") : <span className="text-rose-700">Tick at least one column.</span>}
                </div>
              </section>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 p-4 border-t border-slate-200">
          <button type="button" disabled={!cols} onClick={() => cols && fill(cols, defaultLayout(cols))}
            className="px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100 inline-flex items-center gap-2 disabled:opacity-40">
            <RotateCcw className="h-4 w-4" /> Back to the standard layout
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 text-sm font-medium">Cancel</button>
            <button type="button" onClick={save} disabled={!cols || onCount === 0}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed">Save layout</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
