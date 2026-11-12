// Dismiss-with-reason modal (cancels tasks; nothing is deleted).
import { Ban, Loader2, X } from "lucide-react";

export function DismissModal({ count, disposition, reason, onChange, onCancel, onConfirm, busy }: {
  count: number; disposition: string; reason: string;
  onChange: (patch: { disposition?: string; reason?: string }) => void;
  onCancel: () => void; onConfirm: () => void; busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-900 inline-flex items-center gap-2"><Ban className="h-4 w-4 text-slate-500" /> Dismiss {count} task{count === 1 ? "" : "s"}</h2>
          <button onClick={onCancel} className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-sm text-slate-600 mb-3">
          Marks the task cancelled and stamps the reason on it. It stays on record, so the auto-task builder won't create the same task again on the next scrape. Nothing is deleted.
        </p>
        <label className="block text-xs font-medium text-slate-600 mb-1">Reason category</label>
        <select value={disposition} onChange={(e) => onChange({ disposition: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white mb-3">
          <option value="dismissed">Dismissed</option>
          <option value="resolved">Resolved upstream (delivered / no longer an issue)</option>
          <option value="stale">Stale data (shipment no longer tracked)</option>
          <option value="duplicate">Duplicate of another task</option>
          <option value="superseded">Superseded by a newer task</option>
          <option value="not_actionable">Not actionable</option>
        </select>
        <label className="block text-xs font-medium text-slate-600 mb-1">Note (optional)</label>
        <textarea value={reason} onChange={(e) => onChange({ reason: e.target.value })} rows={3} placeholder="e.g. Delivered 6/16 per carrier; confirmed with Victor" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none" />
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className="rounded-lg px-3 py-2 text-sm bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
