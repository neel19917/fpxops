// "AI prompts" for the Tasks board.
//  - Everyone: extra instructions sent with the next AI triage / daily summary
//    run (the API's `notes` field). Remembered in this browser until cleared.
//  - Admins: view and edit the saved system prompts behind both features
//    (same settings as Admin → Settings → Tasks; changes land in AI Governance).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, MessageSquareText, X } from "lucide-react";
import { api } from "../../lib/api";

const NOTES_KEY = "fpx.tasks.v2.aiNotes";

export interface AiNotes { triage: string; daily: string }

export function loadAiNotes(): AiNotes {
  try {
    const v = JSON.parse(localStorage.getItem(NOTES_KEY) || "null");
    return { triage: String(v?.triage || ""), daily: String(v?.daily || "") };
  } catch { return { triage: "", daily: "" }; }
}
export function saveAiNotes(n: AiNotes) {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(n)); } catch { /* ignore */ }
}

const SAVED = [
  { key: "prompt.task_triage.system", modelKey: "prompt.task_triage.model", label: "AI triage" },
  { key: "prompt.daily_summary.system", modelKey: "prompt.daily_summary.model", label: "Daily summary" },
] as const;

export function PromptsDialog({ notes, onNotes, isAdmin, onClose }: {
  notes: AiNotes; onNotes: (n: AiNotes) => void; isAdmin: boolean; onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl ring-1 ring-slate-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 sticky top-0 bg-white">
          <div className="font-semibold text-slate-900 flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-violet-600" /> AI prompts</div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-5 space-y-5">
          <section>
            <h3 className="text-sm font-semibold text-slate-900">Your instructions for the next run</h3>
            <p className="text-xs text-slate-500 mt-0.5">Added on top of the saved prompt each time you run it. Only you see these; they stay until you clear them.</p>
            <div className="grid sm:grid-cols-2 gap-3 mt-2">
              <NotesBox label="AI triage" value={notes.triage} onChange={(v) => onNotes({ ...notes, triage: v })}
                placeholder={'e.g. "Put anything for Sticker Mule first" or "Ignore tasks older than 30 days"'} />
              <NotesBox label="Daily summary" value={notes.daily} onChange={(v) => onNotes({ ...notes, daily: v })}
                placeholder={'e.g. "Keep it under 400 words" or "Call out ABF delays"'} />
            </div>
          </section>
          {isAdmin ? <SavedPrompts /> : (
            <p className="text-xs text-slate-500">The saved prompts behind AI triage and the daily summary can be changed by an admin.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function NotesBox({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase font-semibold text-slate-500">{label}</span>
        {value ? <button type="button" onClick={() => onChange("")} className="text-[11px] text-sky-700 hover:underline">Clear</button> : null}
      </div>
      <textarea value={value} onChange={(e) => onChange(e.target.value.slice(0, 2000))} rows={4} placeholder={placeholder}
        className="mt-1 w-full text-sm rounded-lg ring-1 ring-slate-200 p-2 outline-none focus:ring-2 focus:ring-violet-400" />
    </label>
  );
}

// Admin: the saved system prompts. Loaded on open; each saves on its own.
function SavedPrompts() {
  const [rows, setRows] = useState<Record<string, { value: string; isDefault: boolean }> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.settings.list().then((r) => {
      const m: Record<string, { value: string; isDefault: boolean }> = {};
      for (const x of r.data) m[x.key] = { value: typeof x.value === "string" ? x.value : x.value == null ? "" : JSON.stringify(x.value), isDefault: x.isDefault };
      setRows(m);
    }).catch((e) => setErr((e as Error).message));
  }, []);

  async function save(key: string) {
    const value = draft[key];
    if (value == null || !value.trim()) return;
    setBusy(key); setErr(null); setSavedKey(null);
    try {
      await api.settings.update(key, value);
      setRows((p) => (p ? { ...p, [key]: { value, isDefault: false } } : p));
      setDraft((d) => { const n = { ...d }; delete n[key]; return n; });
      setSavedKey(key);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Saved prompts <span className="text-xs font-normal text-slate-500">· admin · applies to everyone</span></h3>
        <Link to="/admin/settings/task_triage" className="text-xs text-violet-700 hover:underline">Models and more in Settings →</Link>
      </div>
      {err ? <div className="text-sm text-rose-700 mt-2">{err}</div> : null}
      {!rows && !err ? <div className="text-sm text-slate-500 mt-2 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div> : null}
      {rows ? SAVED.map((s) => {
        const cur = rows[s.key]?.value ?? "";
        const val = draft[s.key] ?? cur;
        const dirty = draft[s.key] != null && draft[s.key] !== cur;
        return (
          <div key={s.key} className="mt-3">
            <div className="flex items-center gap-2 text-[11px] uppercase font-semibold text-slate-500">
              <span>{s.label}</span>
              <span className="normal-case font-normal text-slate-400">{rows[s.modelKey]?.value || "default model"}{rows[s.key]?.isDefault ? " · built-in prompt" : " · customised"}</span>
            </div>
            <textarea value={val} onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} rows={8} spellCheck={false}
              className="mt-1 w-full text-xs font-mono leading-relaxed rounded-lg ring-1 ring-slate-200 p-2 outline-none focus:ring-2 focus:ring-violet-400" />
            <div className="flex items-center justify-end gap-2 mt-1">
              {savedKey === s.key ? <span className="text-xs text-emerald-700 mr-auto">Saved. Used from the next run; recorded in AI Governance.</span> : null}
              {dirty ? <button onClick={() => setDraft((d) => { const n = { ...d }; delete n[s.key]; return n; })} className="text-xs px-2.5 py-1 rounded-lg text-slate-600 hover:bg-slate-100">Undo edits</button> : null}
              <button onClick={() => save(s.key)} disabled={!dirty || !val.trim() || busy === s.key}
                className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
                {busy === s.key ? "Saving…" : "Save prompt"}
              </button>
            </div>
          </div>
        );
      }) : null}
    </section>
  );
}
