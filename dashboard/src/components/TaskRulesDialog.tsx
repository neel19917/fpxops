import { useEffect, useState } from "react";
import { SlidersHorizontal, X, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { ModePicker, ALL_MODES, modesText } from "./ModePicker";

// Task rules: which shipments the AI may auto-create tasks for. Applies to
// new auto-tasks on every scrape; existing tasks are left alone.
//   tasks.generate.modes           — modes that get tasks (unset = legacy rule)
//   tasks.generate.skip_carriers   — carriers that never get auto-tasks
//   tasks.generate.skip_customers  — customers that never get auto-tasks

const toList = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const fromText = (t: string) => [...new Set(t.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 200);

export function TaskRulesButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Choose which shipments get auto-created tasks"
        className="rounded-lg ring-1 ring-slate-200 bg-white text-slate-700 text-sm px-3 py-2 inline-flex items-center gap-1.5 hover:bg-slate-50">
        <SlidersHorizontal className="h-4 w-4" /> Task rules
      </button>
      {open ? <TaskRulesDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function TaskRulesDialog({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [modes, setModes] = useState<string[]>(ALL_MODES);
  const [legacy, setLegacy] = useState(true);
  const [carriers, setCarriers] = useState("");
  const [customers, setCustomers] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settings.list().then((r) => {
      const get = (k: string) => r.data.find((x) => x.key === k)?.value;
      const m = toList(get("tasks.generate.modes"));
      if (m.length) { setModes(ALL_MODES.filter((x) => m.includes(x))); setLegacy(false); }
      else { setModes(get("ui.tracking.show_parcels") === true ? ALL_MODES : ["LTL", "Truckload"]); setLegacy(true); }
      setCarriers(toList(get("tasks.generate.skip_carriers")).join("\n"));
      setCustomers(toList(get("tasks.generate.skip_customers")).join("\n"));
      setLoaded(true);
    }).catch((e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  async function save() {
    setSaving(true); setErr(null); setSaved(false);
    try {
      await api.settings.update("tasks.generate.modes", modes);
      await api.settings.update("tasks.generate.skip_carriers", fromText(carriers));
      await api.settings.update("tasks.generate.skip_customers", fromText(customers));
      setLegacy(false); setSaved(true);
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl ring-1 ring-slate-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <div className="font-semibold text-slate-900 flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-violet-600" /> Task rules</div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        {!loaded && !err ? (
          <div className="p-5 text-sm text-slate-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <div className="p-5 space-y-4">
            <p className="text-sm text-slate-600">Which shipments the AI creates tasks for when they need action. Applies to new tasks from the next scrape on — existing tasks stay.</p>
            <div>
              <div className="text-[11px] uppercase font-semibold text-slate-500">Modes that get tasks</div>
              <div className="mt-1 flex items-center gap-2">
                <ModePicker value={modes} onChange={setModes} />
                <span className="text-xs text-slate-500">{modesText(modes)}</span>
              </div>
              {legacy ? <div className="text-xs text-slate-400 mt-1">Currently the default rule (Parcel follows the Tracking page's parcel switch). Saving pins it to the modes above.</div> : null}
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block">
                <div className="text-[11px] uppercase font-semibold text-slate-500">Never for these carriers</div>
                <textarea value={carriers} onChange={(e) => setCarriers(e.target.value)} rows={5} placeholder={"One per line, e.g.\nBIG O TRANS"}
                  className="mt-1 w-full text-sm rounded-lg ring-1 ring-slate-200 p-2 outline-none focus:ring-2 focus:ring-violet-400" />
              </label>
              <label className="block">
                <div className="text-[11px] uppercase font-semibold text-slate-500">Never for these customers</div>
                <textarea value={customers} onChange={(e) => setCustomers(e.target.value)} rows={5} placeholder={"One per line, e.g.\nSticker Mule"}
                  className="mt-1 w-full text-sm rounded-lg ring-1 ring-slate-200 p-2 outline-none focus:ring-2 focus:ring-violet-400" />
              </label>
            </div>
            <div className="text-xs text-slate-500">Names match partially and ignore case ("big o" matches "BIG O TRANS INC"). Changes are recorded in AI Governance.</div>
            {err ? <div className="text-sm text-rose-700">{err}</div> : null}
            <div className="flex items-center justify-end gap-2">
              {saved ? <span className="text-sm text-emerald-700 mr-auto">Saved — applies from the next scrape.</span> : null}
              <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100">Close</button>
              <button onClick={save} disabled={saving || !loaded} className="text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
                {saving ? "Saving…" : "Save rules"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// Inline "Create tasks" mode picker (Scraping page, next to the Refresh modes).
// Same setting as the Task rules dialog: tasks.generate.modes. Admin only —
// the settings API is admin-only. Saves on every toggle.
export function TaskModesInline() {
  const [modes, setModes] = useState<string[] | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.settings.list().then((r) => {
      const get = (k: string) => r.data.find((x) => x.key === k)?.value;
      const m = toList(get("tasks.generate.modes"));
      setModes(m.length ? ALL_MODES.filter((x) => m.includes(x))
        : get("ui.tracking.show_parcels") === true ? ALL_MODES : ["LTL", "Truckload"]);
    }).catch((e) => { setErr((e as Error).message); setState("error"); });
  }, []);

  async function change(next: string[]) {
    const prev = modes;
    setModes(next); setState("saving"); setErr(null);
    try { await api.settings.update("tasks.generate.modes", next); setState("saved"); }
    catch (e) { setModes(prev); setErr((e as Error).message); setState("error"); }
  }

  if (!modes) return err ? <span className="col-span-2 text-xs text-rose-700" title={err}>Task modes unavailable</span> : <span className="col-span-2" />;
  return (
    <>
      <ModePicker value={modes} onChange={change} disabled={state === "saving"} />
      <span className="text-xs min-w-14 text-left"
        title="Which modes the AI auto-creates tasks for, from the next scrape on. Same as Tasks → Task rules.">
        {state === "saving" ? <span className="text-slate-500">Saving…</span>
          : state === "saved" ? <span className="text-emerald-700">Saved</span>
          : state === "error" ? <span className="text-rose-700" title={err || undefined}>Not saved</span>
          : null}
      </span>
    </>
  );
}
