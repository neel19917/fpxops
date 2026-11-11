// LTL / FTL / Parcel picker for limiting a Refresh All (and schedules) to
// some FreightPOP modes. Values are FreightPOP's own names ("Truckload" is
// shown as FTL). At least one stays selected.

export const SCRAPE_MODES = [
  { value: "LTL", label: "LTL" },
  { value: "Truckload", label: "FTL" },
  { value: "Parcel", label: "Parcel" },
] as const;
export const ALL_MODES = SCRAPE_MODES.map((m) => m.value) as string[];

export const modeLabel = (v: string) => SCRAPE_MODES.find((m) => m.value === v)?.label || v;
export const modesText = (modes?: string[] | null) =>
  !modes || !modes.length || modes.length === ALL_MODES.length ? "All modes" : modes.map(modeLabel).join(" + ");

export function ModePicker({ value, onChange, disabled, size = "md" }: {
  value: string[]; onChange: (v: string[]) => void; disabled?: boolean; size?: "sm" | "md";
}) {
  const toggle = (m: string) => {
    const next = value.includes(m) ? value.filter((x) => x !== m) : [...value, m];
    if (next.length) onChange(ALL_MODES.filter((x) => next.includes(x)));
  };
  return (
    <div className="inline-flex rounded-lg ring-1 ring-slate-200 bg-white overflow-hidden" role="group" aria-label="Shipment modes">
      {SCRAPE_MODES.map((m) => {
        const on = value.includes(m.value);
        return (
          <button key={m.value} type="button" disabled={disabled} onClick={() => toggle(m.value)} aria-pressed={on}
            title={on && value.length === 1 ? "At least one mode stays selected" : undefined}
            className={(size === "sm" ? "text-xs px-2.5 py-1 " : "text-sm px-3 py-1.5 ") + "font-medium transition border-r last:border-r-0 border-slate-200 disabled:opacity-50 " +
              (on ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-50")}>
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
