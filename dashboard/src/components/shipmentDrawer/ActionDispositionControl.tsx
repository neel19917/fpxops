import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Shipment } from "../../lib/types";
import { ActionBadge } from "../Badge";

// Clickable ActionBadge + popover: one click on the badge opens a small menu
// of disposition options (Action needed / On track / Resolved). The full
// Override modal (reason + followup creation) is reachable via "More options…".
export interface ActionDispositionControlProps {
  shipment: Shipment;
  actionEditBusy: boolean;
  onSetAction: (v: "YES" | "NO" | "RESOLVED") => void | Promise<void>;
  onRevertToAi: () => void | Promise<void>;
  onOverrideClick: () => void;
}

export function ActionDispositionControl({ shipment, actionEditBusy, onSetAction, onRevertToAi, onOverrideClick }: ActionDispositionControlProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape. Escape is captured so it closes the
  // menu without also closing the drawer underneath.
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const isManual = shipment.action_source === "manual";

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-1.5 flex-wrap">
        <ActionBadge
          action={shipment.action_required}
          onClick={() => setOpen((v) => !v)}
          title="Click to disposition this shipment"
        />
        {isManual ? (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800 ring-1 ring-amber-200"
            title={`Overridden by ${shipment.action_overridden_by || "?"}${shipment.action_override_reason ? ` — ${shipment.action_override_reason}` : ""}`}
          >Manual</span>
        ) : (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-600" title="Set by AI">From AI</span>
        )}
      </div>

      {open ? (
        <div
          role="menu"
          className="absolute z-40 mt-1.5 left-0 min-w-[220px] rounded-lg ring-1 ring-slate-200 bg-white shadow-lg p-1.5"
        >
          <div className="px-2 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Set disposition
          </div>
          {(["YES", "NO", "RESOLVED"] as const).map((v) => {
            const active = shipment.action_required === v;
            const tone =
              v === "YES" ? "text-rose-700 hover:bg-rose-50"
              : v === "NO" ? "text-emerald-700 hover:bg-emerald-50"
              : "text-violet-700 hover:bg-violet-50";
            const label = v === "YES" ? "Action needed" : v === "NO" ? "On track" : "Manually resolved";
            return (
              <button
                key={v}
                role="menuitem"
                disabled={actionEditBusy || active}
                onClick={async () => {
                  await onSetAction(v);
                  setOpen(false);
                }}
                className={`w-full text-left text-sm rounded-md px-2 py-1.5 inline-flex items-center justify-between gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
                title={active ? "Already set" : `Set action to ${label}`}
              >
                <span className="font-medium">{label}</span>
                {active ? <Check className="h-3.5 w-3.5 text-slate-400" /> : null}
              </button>
            );
          })}
          <div className="my-1 border-t border-slate-100" />
          <button
            role="menuitem"
            disabled={actionEditBusy || !isManual}
            onClick={async () => {
              await onRevertToAi();
              setOpen(false);
            }}
            className="w-full text-left text-xs rounded-md px-2 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            title={isManual ? "Clear override and let the AI value stand" : "Already on the AI value"}
          >
            Revert to AI
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onOverrideClick(); }}
            className="w-full text-left text-xs rounded-md px-2 py-1.5 text-sky-700 hover:bg-sky-50"
            title="Open the full override dialog (add a reason, create followups, draft an email)"
          >
            More options…
          </button>
        </div>
      ) : null}
    </div>
  );
}
