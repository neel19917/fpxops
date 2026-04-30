import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  // Hide the dimmed backdrop + click-outside-to-close. Used when something
  // else (e.g. the singleton FreightPOP overlay mounted at App scope) is
  // already filling the area to the left of the drawer; rendering a backdrop
  // on top of it would dim the iframe.
  suppressBackdrop?: boolean;
}

export function Drawer({ open, onClose, title, subtitle, children, suppressBackdrop }: Props) {
  // Esc closes the drawer — matches every other modal/dialog in the
  // dashboard. Listener is only attached while open so background drawers
  // don't intercept esc when something else has focus.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <>
      {suppressBackdrop ? null : (
        <div
          onClick={onClose}
          className={`fixed inset-0 z-20 bg-slate-900/30 backdrop-blur-sm transition-opacity ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        />
      )}
      <aside
        // Flex column so the body's flex-1 fills whatever the header
        // didn't take. Replaces the previous h-[calc(100vh-85px)] which
        // assumed an exact 85px header — broke whenever the subtitle
        // wrapped or the title got long enough to push to a second line.
        className={`fixed top-0 right-0 z-30 h-full w-full sm:w-[720px] bg-white shadow-2xl ring-1 ring-slate-200 flex flex-col transform transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="shrink-0 flex items-start justify-between px-6 pt-5 pb-4 border-b border-slate-200">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">Details</div>
            <h2 className="text-lg font-semibold truncate">{title}</h2>
            {subtitle ? <div className="text-sm text-slate-500 truncate">{subtitle}</div> : null}
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 shrink-0"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </aside>
    </>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-sm text-slate-900 break-words">{children ?? "—"}</div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">{title}</h3>
      {children}
    </section>
  );
}
