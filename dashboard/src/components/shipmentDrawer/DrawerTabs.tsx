import type { LucideIcon } from "lucide-react";

export interface DrawerTabDef<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  count?: number | null;
  // Number key that jumps to this tab (shown in the tooltip).
  hotkey?: string;
}

// Tab bar pinned at the bottom of the drawer header. Sits flush on the
// header's bottom border so the active underline reads as part of it.
export function DrawerTabs<T extends string>({ tabs, active, onChange }: {
  tabs: DrawerTabDef<T>[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" aria-label="Shipment sections" className="flex gap-0.5 -mb-px overflow-x-auto">
      {tabs.map((t) => {
        const on = active === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            title={t.hotkey ? `${t.label} (${t.hotkey})` : t.label}
            className={
              "px-2.5 py-2 text-sm font-medium whitespace-nowrap border-b-2 inline-flex items-center gap-1.5 transition " +
              (on
                ? "border-sky-500 text-sky-700"
                : "border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300")
            }
          >
            <Icon className="h-3.5 w-3.5" />
            {t.label}
            {t.count != null && t.count > 0 ? (
              <span className={"inline-flex items-center justify-center text-[10px] font-semibold rounded-full px-1.5 py-0.5 min-w-[18px] " + (on ? "bg-sky-100 text-sky-800" : "bg-slate-200 text-slate-700")}>{t.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
