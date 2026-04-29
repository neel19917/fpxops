import { useEffect, useMemo, useState } from "react";
import { Settings as SettingsIcon, Save, RotateCcw, Sliders, Sparkles, Mail, Cpu, Search, FileText, ReceiptText, Box, Send } from "lucide-react";
import { api, type SettingRow } from "../lib/api";
import { fmtRelative } from "../lib/format";

// Setting groups. Order matters — first match wins. Added more granular
// categories (single vs bulk email, separate Per-shipment / GP / Invoice
// prompt groups) so the page reads top-down by workflow rather than as
// one flat dump.
const GROUPS: {
  id: string;
  label: string;
  description: string;
  Icon: typeof SettingsIcon;
  match: (k: string) => boolean;
}[] = [
  {
    id: "action",
    label: "Action detection",
    description: "Confidence threshold the AI uses to flag a shipment as needing action, plus the auto-draft toggle.",
    Icon: Sliders,
    match: (k) => k.startsWith("action."),
  },
  {
    id: "email_bulk",
    label: "Email drafts — bulk groups",
    description: "Carrier / Customer group emails (one consolidated email per carrier or customer). Routed through the larger model by default.",
    Icon: Send,
    match: (k) => k.startsWith("prompt.email_draft.carrier_group") || k.startsWith("prompt.email_draft.customer_group"),
  },
  {
    id: "email_single",
    label: "Email drafts — per shipment",
    description: "System base + audience copy for the single-shipment email-draft modal in the drawer.",
    Icon: Mail,
    match: (k) => k.startsWith("prompt.email_draft"),
  },
  {
    id: "shipment_prompts",
    label: "Per-shipment analysis prompts",
    description: "Drives the AI's per-shipment classification + recommendation that surfaces in the dashboard's action column.",
    Icon: Sparkles,
    match: (k) => k.startsWith("prompt.system") || k.startsWith("prompt.per_shipment") || k.startsWith("prompt.priority") || k.startsWith("prompt.summary"),
  },
  {
    id: "gp_prompts",
    label: "GP Audit prompts",
    description: "Prompts the GP Audit page uses to review margin outliers and produce the executive summary.",
    Icon: FileText,
    match: (k) => k.startsWith("prompt.gp_"),
  },
  {
    id: "invoice_prompts",
    label: "Invoice Audit prompts",
    description: "Prompts the Invoice Audit page uses to review bill/cost discrepancies and produce the executive summary.",
    Icon: ReceiptText,
    match: (k) => k.startsWith("prompt.invoice_"),
  },
  {
    id: "model",
    label: "Models",
    description: "Anthropic model selection. Default = short prompts. Large = long prompts (≥ 12k chars) and bulk email synthesis.",
    Icon: Cpu,
    match: (k) => k.startsWith("model."),
  },
  {
    id: "embed",
    label: "FreightPOP embed",
    description: "Toggle and URL template for the in-dashboard FreightPOP iframe (drawer split view + share page).",
    Icon: Box,
    match: (k) => k.startsWith("embed."),
  },
  {
    id: "other",
    label: "Other",
    description: "Settings that haven't been categorized yet.",
    Icon: SettingsIcon,
    match: () => true,
  },
];

const FRIENDLY_LABEL: Record<string, string> = {
  "action.threshold": "Action confidence threshold (0.0–1.0)",
  "action.auto_draft_enabled": "Auto-draft email when action threshold is crossed",
  "prompt.system": "System persona prompt",
  "prompt.per_shipment": "Per-shipment analysis prompt",
  "prompt.per_shipment_logic": "Per-shipment classification logic",
  "prompt.priority": "Priority / escalation analysis prompt",
  "prompt.summary": "Cross-shipment summary prompt",
  "prompt.email_draft.system_base": "Per-shipment email — system base (uses {{audienceCopy}})",
  "prompt.email_draft.audience_carrier": "Per-shipment email — audience: carrier",
  "prompt.email_draft.audience_customer": "Per-shipment email — audience: customer",
  "prompt.email_draft.carrier_group.system_base": "Bulk carrier email — system base (uses {{audienceCopy}})",
  "prompt.email_draft.carrier_group.audience": "Bulk carrier email — audience copy",
  "prompt.email_draft.carrier_group.model": "Bulk carrier email — model",
  "prompt.email_draft.customer_group.system_base": "Bulk customer email — system base (uses {{audienceCopy}})",
  "prompt.email_draft.customer_group.audience": "Bulk customer email — audience copy",
  "prompt.email_draft.customer_group.model": "Bulk customer email — model",
  "prompt.gp_system": "GP Audit — system persona prompt",
  "prompt.gp_exec_summary": "GP Audit — executive summary prompt",
  "prompt.gp_row_review": "GP Audit — per-row review prompt",
  "prompt.invoice_system": "Invoice Audit — system persona prompt",
  "prompt.invoice_exec_summary": "Invoice Audit — executive summary prompt",
  "prompt.invoice_row_review": "Invoice Audit — per-row review prompt",
  "model.default": "Default model (short prompts)",
  "model.large": "Large model (long prompts ≥ ~12k chars)",
  "embed.freightpop.enabled": "FreightPOP embed — enabled",
  "embed.freightpop.url_template": "FreightPOP embed — URL template",
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
  // The bulk-email model selectors share the same pricing list.
  "prompt.email_draft.carrier_group.model": MODEL_OPTIONS,
  "prompt.email_draft.customer_group.model": MODEL_OPTIONS,
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
  // Free-text filter — matches against the friendly label, key, and any
  // description / current value. Useful when we have ~25 prompts to
  // hunt through.
  const [filter, setFilter] = useState("");

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
    setSavingKey(row.key);
    try {
      // Prefer the in-flight edit if the user typed; otherwise persist the
      // currently-displayed value (the resolved fallback for default rows).
      // This lets admins promote a default to a real DB row in one click
      // without having to type-and-retype the same value.
      const v = row.key in edits ? edits[row.key] : row.value;
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
    const q = filter.trim().toLowerCase();
    const matchesFilter = (r: SettingRow) => {
      if (!q) return true;
      const friendly = (FRIENDLY_LABEL[r.key] || "").toLowerCase();
      const desc = (r.description || "").toLowerCase();
      const valStr = typeof r.value === "string" ? r.value.toLowerCase() : "";
      return r.key.toLowerCase().includes(q)
        || friendly.includes(q)
        || desc.includes(q)
        || valStr.includes(q);
    };
    const out: Record<string, SettingRow[]> = {};
    for (const r of rows) {
      if (!matchesFilter(r)) continue;
      const g = GROUPS.find((g) => g.match(r.key));
      const id = g ? g.id : "other";
      (out[id] = out[id] || []).push(r);
    }
    for (const arr of Object.values(out)) arr.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }, [rows, filter]);

  // Stat for the header chip.
  const totalKeys = rows.length;
  const editedKeys = rows.filter((r) => !r.isDefault).length;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold flex items-center gap-2"><SettingsIcon className="h-5 w-5 text-sky-600" /> Settings</h2>
            <p className="text-sm text-slate-500 mt-0.5 max-w-2xl">
              Edit AI prompts, action-detection thresholds, model selection, embed behavior, and auto-draft toggles.
              {totalKeys ? (
                <> {editedKeys} of {totalKeys} keys customized · {totalKeys - editedKeys} on default. </>
              ) : null}
              Changes apply within 30 seconds (server cache TTL).
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter prompts…"
                className="rounded-lg border border-slate-200 pl-8 pr-3 py-2 text-sm bg-white w-56 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none"
                aria-label="Filter settings"
              />
            </div>
            <button
              onClick={() => api.settings.refresh().then(load).catch((e) => alert((e as Error).message))}
              className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5"
              title="Force the server cache to drop and reload from Supabase"
            >
              <RotateCcw className="h-4 w-4" /> Refresh
            </button>
          </div>
        </div>

        {err ? <div className="mx-5 mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{err}</div> : null}
        {loading ? <div className="p-8 text-center text-slate-500">Loading…</div> : null}
      </div>

      {!loading && GROUPS.map(({ id, label, description, Icon }) => {
        const list = grouped[id];
        if (!list?.length) return null;
        return (
          <div key={id} className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-base font-semibold flex items-center gap-2 text-slate-900">
                <Icon className="h-5 w-5 text-sky-600" /> {label}
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 ml-1">
                  {list.length}
                </span>
              </h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">{description}</p>
            </div>
            <ul className="divide-y divide-slate-100">
              {list.map((row) => {
                const current = row.key in edits ? edits[row.key] : row.value;
                // Save is enabled if either (a) the user actually edited the
                // field, OR (b) the row is still using the hard-coded default
                // (no DB row yet) — saving in that case promotes the default
                // to a persisted value so the admin can verify / lock it in.
                // Without (b) the Save button is permanently grayed out for
                // any setting an admin has never touched, which made the
                // page feel broken.
                const dirty = row.key in edits || row.isDefault;
                const shape = valueShape(row.value);
                const open = openKey === row.key;
                const friendly = FRIENDLY_LABEL[row.key] || row.key;
                return (
                  <li key={row.key} className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="text-sm font-semibold text-slate-900">{friendly}</div>
                          {row.isDefault ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                              Default
                            </span>
                          ) : (
                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                              Customized
                            </span>
                          )}
                          {row.key in edits ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                              Unsaved
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">{row.key}</div>
                        {row.description ? <div className="text-xs text-slate-500 mt-1">{row.description}</div> : null}
                        <div className="text-[11px] text-slate-400 mt-1">
                          {row.isDefault
                            ? <>Using default value — Save promotes it to a stored row</>
                            : <>Last edited{row.updated_by ? <> by <span className="text-slate-600">{row.updated_by}</span></> : null}{row.updated_at ? <> · {fmtRelative(row.updated_at)}</> : null}</>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {!row.isDefault && row.default !== null && row.default !== undefined ? (
                          <button
                            onClick={() => resetToDefault(row)}
                            disabled={savingKey === row.key}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg ring-1 ring-slate-200 text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
                            title="Restore the hard-coded default value"
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Reset
                          </button>
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
    // Default to 8 rows minimum so prompts have room to breathe; expand
    // up to 24 with content. Prompts are paragraph-shaped, the
    // previous min of 4 felt cramped.
    const lineCount = value.split("\n").length;
    const charBasedRows = Math.ceil(value.length / 90); // wrap-friendly
    const rows = Math.min(24, Math.max(8, Math.max(lineCount, charBasedRows)));
    return (
      <div className="space-y-1.5">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          spellCheck={false}
          className="w-full px-3 py-2.5 text-sm font-mono leading-relaxed border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
        />
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>{value.length.toLocaleString()} chars · {lineCount} line{lineCount === 1 ? "" : "s"}</span>
          {long ? (
            <button type="button" onClick={onToggle} className="text-slate-500 hover:text-slate-900">Collapse</button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
      />
      <button type="button" onClick={onToggle} className="text-xs text-slate-500 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-100">Expand</button>
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
