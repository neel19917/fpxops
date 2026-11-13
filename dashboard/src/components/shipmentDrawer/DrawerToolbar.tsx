import type { ReactNode } from "react";
import { ExternalLink, Keyboard, PanelRightClose, PanelRightOpen } from "lucide-react";

export interface DrawerToolbarProps {
  // FreightPOP embed is configured for this account. The FreightPOP
  // buttons and the side-panel toggle only make sense when it is.
  embedEnabled: boolean;
  trackingNumber?: string | null;
  // Whether the embedded FreightPOP side panel is showing.
  splitView: boolean;
  onToggleSplitView: () => void;
  onLoadInFreightPop: () => void;
  onOpenTracking: () => void;
  onShowShortcuts: () => void;
  // Trailing slot (the Share button). Passed in rather than imported so
  // this stays a layout-only component.
  children?: ReactNode;
}

// Toolbar pinned in the drawer header between the key facts and the tab
// bar. Must stay on ONE row at the 720px drawer width: only the two
// FreightPOP actions carry labels; the panel toggle and the shortcuts
// help are icon-only with tooltips. (The old "Find similar" button was
// dropped — it only switched to the Intel tab, which is one click or
// the 5 key away.)
export function DrawerToolbar({ embedEnabled, trackingNumber, splitView, onToggleSplitView, onLoadInFreightPop, onOpenTracking, onShowShortcuts, children }: DrawerToolbarProps) {
  const iconBtn = "h-8 w-8 shrink-0 rounded-md ring-1 inline-flex items-center justify-center ";
  const panelLabel = splitView ? "Hide FreightPOP side panel" : "Show FreightPOP side panel";
  return (
    <div className="flex items-center gap-2 pb-2">
      {embedEnabled && trackingNumber ? (
        <button
          type="button"
          onClick={onLoadInFreightPop}
          className="text-xs px-2.5 py-1.5 rounded-md ring-1 ring-violet-600 bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-1.5 whitespace-nowrap"
          title={`Load shipment ${trackingNumber} in FreightPOP and filter the grid`}
        >
          <ExternalLink className="h-3.5 w-3.5" /> Load in FreightPOP
        </button>
      ) : null}
      {/* Sibling option to "Load in FreightPOP": triggers FP's
          native tracking modal *inside* the embedded iframe.
          The overlay forwards a postMessage to the FPXpress
          extension which filters by tracking number then
          simulates a click on the row's tracking link — same
          UI path a rep takes manually, just one click. */}
      {embedEnabled && trackingNumber ? (
        <button
          type="button"
          onClick={onOpenTracking}
          className="text-xs px-2.5 py-1.5 rounded-md ring-1 ring-slate-300 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap"
          title={`Open the FreightPOP tracking modal for ${trackingNumber} in the embedded panel`}
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open tracking #
        </button>
      ) : null}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {embedEnabled ? (
          <button
            type="button"
            onClick={onToggleSplitView}
            className={iconBtn + (splitView
              ? "bg-violet-50 text-violet-700 ring-violet-200 hover:bg-violet-100"
              : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}
            title={panelLabel}
            aria-label={panelLabel}
            aria-pressed={splitView}
          >
            {splitView ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onShowShortcuts}
          className={iconBtn + "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>
  );
}
