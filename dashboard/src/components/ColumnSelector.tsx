import { useEffect, useRef, useState } from "react";
import { Columns3, GripVertical, RotateCcw, X } from "lucide-react";
import { SHIPMENT_COLUMNS, type ColumnPrefs, defaultColumnPrefs } from "../lib/shipmentColumns";

interface Props {
  prefs: ColumnPrefs;
  onChange: (next: ColumnPrefs) => void;
}

// Toolbar button + popover for toggling column visibility and reordering them
// via native HTML5 drag-and-drop. Caller owns the prefs state (and persistence).
export function ColumnSelector({ prefs, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const visible = new Set(prefs.visibleIds);
  const ordered = prefs.orderIds
    .map((id) => SHIPMENT_COLUMNS.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  function toggle(id: string) {
    const next = new Set(visible);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange({ ...prefs, visibleIds: Array.from(next) });
  }

  function reorder(fromId: string, toId: string) {
    if (fromId === toId) return;
    const ids = [...prefs.orderIds];
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, fromId);
    onChange({ ...prefs, orderIds: ids });
  }

  function reset() {
    onChange(defaultColumnPrefs());
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:bg-slate-50 inline-flex items-center gap-1.5"
        title="Show / hide / reorder columns"
      >
        <Columns3 className="h-4 w-4" />
        Columns
        <span className="text-xs text-slate-500 tabular-nums">({prefs.visibleIds.length})</span>
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1.5 z-30 w-72 max-h-[60vh] overflow-auto rounded-xl bg-white shadow-xl ring-1 ring-slate-200"
        >
          <div className="sticky top-0 bg-white border-b border-slate-100 px-3 py-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Columns</div>
            <div className="flex items-center gap-2">
              <button
                onClick={reset}
                title="Reset to defaults"
                className="text-xs text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Reset
              </button>
              <button onClick={() => setOpen(false)} title="Close" className="text-slate-400 hover:text-slate-700">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <ul className="py-1">
            {ordered.map((col) => {
              const checked = visible.has(col.id);
              const isDragOver = dragOverId === col.id && dragId !== col.id;
              return (
                <li
                  key={col.id}
                  draggable
                  onDragStart={(e) => {
                    setDragId(col.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", col.id);
                  }}
                  onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverId !== col.id) setDragOverId(col.id);
                  }}
                  onDragLeave={() => { if (dragOverId === col.id) setDragOverId(null); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const fromId = e.dataTransfer.getData("text/plain") || dragId;
                    if (fromId) reorder(fromId, col.id);
                    setDragId(null); setDragOverId(null);
                  }}
                  className={
                    "flex items-center gap-2 px-3 py-1.5 text-sm select-none " +
                    (isDragOver ? "bg-sky-50 border-y border-sky-300 " : "hover:bg-slate-50 ") +
                    (dragId === col.id ? "opacity-50" : "")
                  }
                >
                  <GripVertical className="h-4 w-4 text-slate-300 cursor-grab active:cursor-grabbing" />
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(col.id)}
                    className="cursor-pointer"
                    aria-label={`Toggle ${col.label}`}
                  />
                  <span className={checked ? "text-slate-900" : "text-slate-500"}>{col.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
