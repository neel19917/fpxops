import type { RunFlag } from "../../lib/getInvoiceRuns";

// Small pieces shared by the Get Invoice runs page and its shipment table.

export const PRIMARY_BTN = "px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
export const SECONDARY_BTN = "px-4 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";
export const SMALL_BTN = "px-2.5 py-1 rounded-md bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";
export const TH = "py-2 pr-3 font-medium whitespace-nowrap";

export function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

export const money = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

export function Alert({ children }: { children: string }) {
  return <div role="alert" className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 text-sm px-3 py-2">{children}</div>;
}

export function Chip({ label, cls, dot, title }: { label: string; cls: string; dot?: string; title?: string }) {
  return (
    <span title={title} className={"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 whitespace-nowrap " + cls}>
      {dot ? <span className={"h-1.5 w-1.5 rounded-full " + dot} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

const FLAG_CLS: Record<RunFlag["level"], string> = {
  error: "bg-rose-50 text-rose-800 ring-rose-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-slate-100 text-slate-600 ring-slate-200",
};
const FLAG_WORD: Record<RunFlag["level"], string> = { error: "Error", warn: "Check", info: "Note" };
const RANK: Record<RunFlag["level"], number> = { error: 0, warn: 1, info: 2 };

/** A shipment's flags as colored chips, worst first. */
export function FlagChips({ flags }: { flags: RunFlag[] | undefined }) {
  const list = [...(flags ?? [])].sort((a, b) => RANK[a.level] - RANK[b.level]);
  if (!list.length) return <span className="text-slate-400">—</span>;
  return (
    <ul className="flex flex-col gap-0.5 max-w-[22rem]">
      {list.map((f, i) => (
        <li key={f.code + i}>
          <span className={"inline-block rounded-md px-1.5 py-0.5 text-[11px] leading-snug ring-1 break-words " + FLAG_CLS[f.level]}>
            <span className="sr-only">{FLAG_WORD[f.level]}: </span>{f.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
