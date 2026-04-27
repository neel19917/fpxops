import { useEffect, useMemo, useState } from "react";
import { Settings as SettingsIcon, Save, RotateCcw, Sliders, Sparkles, Mail, Cpu } from "lucide-react";
import { api, type SettingRow } from "../lib/api";
import { fmtRelative } from "../lib/format";

// Group settings by their key prefix so the page reads as related sections
// rather than one flat list. Order matters — first match wins.
const GROUPS: { id: string; label: string; Icon: typeof SettingsIcon; match: (k: string) => boolean }[] = [
  { id: "action", label: "Action detection", Icon: Sliders, match: (k) => k.startsWith("action.") },
  { id: "email", label: "Email drafting", Icon: Mail, match: (k) => k.startsWith("prompt.email_draft") },
  { id: "prompts", label: "Analysis prompts", Icon: Sparkles, match: (k) => k.startsWith("prompt.") },
  { id: "model", label: "Models", Icon: Cpu, match: (k) => k.startsWith("model.") },
  { id: "other", label: "Other", Icon: SettingsIcon, match: () => true },
];

const FRIENDLY_LABEL: Record<string, string> = {
  "action.threshold": "Action confidence threshold (0.0–1.0)",
  "action.auto_draft_enabled": "Auto-draft email when action threshold is crossed",
  "prompt.system": "System persona prompt",
  "prompt.per_shipment": "Per-shipment analysis prompt",
  "prompt.priority": "Priority/escalation analysis prompt",
  "prompt.summary": "Cross-shipment summary prompt",
  "prompt.email_draft.system_base": "Email draft — system base (uses {{audienceCopy}})",
  "prompt.email_draft.audience_carrier": "Email draft — audience: carrier",
  "prompt.email_draft.audience_customer": "Email draft — audience: customer",
  "model.default": "Default model (short prompts)",
  "model.large": "Large model (long prompts ≥ ~12k chars)",
};

// Per-setting enum options. Keys without an entry render as free-text/JSON.
// Model list mirrors MODEL_PRICING in server/lib/anthropic.js — keep in sync,
// otherwise selecting an unpriced model logs analyses with the wrong cost.
const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fast, cheap — $0.80 / $4.00 per 1M)" },
  { value: "claude-sonnet-4-6",          label: "Sonnet 4.6 (balanced — $3.00 / $15.00 per 1M)" },
  { value: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5 (legacy — $3.00 / $15.00 per 1M)" },
  { value: "claude-opus-4-7",            label: "Opus 4.7 (most capable — $15.00 / $75.00 per 1M)" },
];
const ENUM_OPTIONS: Record<string, { value: string; label: string }[]> = {
  "model.default": MODEL_OPTIONS,
  "model.large": MODEL_OPTIONS,
};

function valueShape(v: unknown): "string" | "number" | "boolean" | "json" {
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "json";
}

export function SettingsPage() {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Local edits keyed by setting key. Only modified rows show a Save button.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.settings.list();
      setRows(r.data);
      setEdits({});
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  function setEdit(key: string, value: unknown) {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  async function save(row: SettingRow) {
    if (!(row.key in edits)) return;
    setSavingKey(row.key);
    try {
      const v = edits[row.key];
      await api.settings.update(row.key, v);
      await load();
    } catch (e) {
      alert((e as Error).message);
    }
    setSavingKey(null);
  }

  async function resetToDefault(row: SettingRow) {
    if (row.default === null || row.default === undefined) return;
    if (!confirm(`Reset "${row.key}" to its default value?`)) return;
    setSavingKey(row.key);
    try {
      await api.settings.update(row.key, row.default);
      await load();
    } catch (e) { alert((e as Error).message); }
    setSavingKey(null);
  }

  const grouped = useMemo(() => {
    const out: Record<string, SettingRow[]> = {};
    for (const r of rows) {
      const g = GROUPS.find((g) => g.match(r.key));
      const id = g ? g.id : "other";
      (out[id] = out[id] || []).push(r);
    }
    for (const arr of Object.values(out)) arr.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }, [rows]);

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2"><SettingsIcon className="h-5 w-5 text-sky-600" /> Settings</h2>
            <p className="text-sm text-slate-500 mt-0.5">Edit AI prompts, action-detection thresholds, model selection, and auto-draft behavior. Changes apply within 30 seconds.</p>
          </div>
          <button
            onClick={() => api.settings.refresh().then(load).catch((e) => alert((e as Error).message))}
            className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5"
            title="Force the server cache to drop and reload from Supabase"
          >
            <RotateCcw className="h-4 w-4" /> Refresh server cache
          </button>
        </div>

        {err ? <div className="mx-5 mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{err}</div> : null}
        {loading ? <div className="p-8 text-center text-slate-500">Loading…</div> : null}
      </div>

      {!loading && GROUPS.map(({ id, label, Icon }) => {
        const list = grouped[id];
        if (!list?.length) return null;
        return (
          <div key={id} className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-slate-800">
                <Icon className="h-4 w-4 text-slate-500" /> {label}
              </h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {list.map((row) => {
                const current = row.key in edits ? edits[row.key] : row.value;
                const dirty = row.key in edits;
                const shape = valueShape(row.value);
                const open = openKey === row.key;
                const friendly = FRIENDLY_LABEL[row.key] || row.key;
                return (
                  <li key={row.key} className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900">{friendly}</div>
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">{row.key}</div>
                        {row.description ? <div className="text-xs text-slate-500 mt-1">{row.description}</div> : null}
                        <div className="text-[11px] text-slate-400 mt-1">
                          {row.isDefault
                            ? <>Using default value</>
                            : <>Last edited{row.updated_by ? <> by <span className="text-slate-600">{row.updated_by}</span></> : null}{row.updated_at ? <> · {fmtRelative(row.updated_at)}</> : null}</>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {!row.isDefault && row.default !== null && row.default !== undefined ? (
                          <button
                            onClick={() => resetToDefault(row)}
                            disabled={savingKey === row.key}
                            className="text-xs text-slate-500 hover:text-slate-900"
                          >Reset</button>
                        ) : null}
                        <button
                          onClick={() => save(row)}
                          disabled={!dirty || savingKey === row.key}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 flex items-center gap-1.5 disabled:bg-slate-200 disabled:text-slate-400"
                        >
                          <Save className="h-3.5 w-3.5" /> {savingKey === row.key ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                    <div className="mt-3">
                      {ENUM_OPTIONS[row.key] ? (
                        <SelectEditor
                          value={String(current ?? "")}
                          options={ENUM_OPTIONS[row.key]}
                          onChange={(s) => setEdit(row.key, s)}
                        />
                      ) : shape === "boolean" ? (
                        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                          <input
                            type="checkbox"
                            checked={Boolean(current)}
                            onChange={(e) => setEdit(row.key, e.target.checked)}
                            className="h-4 w-4"
                          />
                          {String(current)}
                        </label>
                      ) : shape === "number" ? (
                        <NumberEditor value={Number(current)} onChange={(n) => setEdit(row.key, n)} />
                      ) : shape === "string" ? (
                        <StringEditor
                          value={String(current ?? "")}
                          long={String(current ?? "").length > 80 || String(row.value ?? "").includes("\n")}
                          open={open}
                          onToggle={() => setOpenKey(open ? null : row.key)}
                          onChange={(s) => setEdit(row.key, s)}
                        />
                      ) : (
                        <JsonEditor value={current} onChange={(v) => setEdit(row.key, v)} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function SelectEditor({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const known = options.some((o) => o.value === value);
  return (
    <div className="space-y-1.5">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full md:w-auto md:min-w-[28rem] px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
      >
        {!known && value ? <option value={value}>{value} (unrecognized)</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {!known && value ? (
        <div className="text-xs text-amber-600">Current value isn't in the known options list — make sure pricing/cost logging is set up for it server-side.</div>
      ) : null}
    </div>
  );
}

function NumberEditor({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  // Threshold is the hot path so render a slider when 0–1.
  const isThreshold = value >= 0 && value <= 1;
  return (
    <div className="flex items-center gap-3">
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={isThreshold ? 0.05 : 1}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
      />
      {isThreshold ? (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 max-w-md"
        />
      ) : null}
    </div>
  );
}

function StringEditor({ value, long, open, onToggle, onChange }: { value: string; long: boolean; open: boolean; onToggle: () => void; onChange: (s: string) => void }) {
  if (long || open) {
    return (
      <div className="space-y-1.5">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={Math.min(20, Math.max(4, value.split("\n").length + 1))}
          className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
        />
        {long ? <button type="button" onClick={onToggle} className="text-xs text-slate-500 hover:text-slate-900">Collapse</button> : null}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
      />
      <button type="button" onClick={onToggle} className="text-xs text-slate-500 hover:text-slate-900">Expand</button>
    </div>
  );
}

function JsonEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            setError(null);
            onChange(parsed);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        rows={6}
        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
      />
      {error ? <div className="text-xs text-rose-600">{error}</div> : null}
    </div>
  );
}
