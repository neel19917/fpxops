import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Settings as SettingsIcon, Save, RotateCcw, Sliders, Sparkles, Mail, Cpu, Search, FileText, ReceiptText, Box, Send, X, ChevronDown, ChevronRight as ChevronRightIcon, AlertTriangle, Power } from "lucide-react";
import { api, type SettingRow } from "../lib/api";
import { fmtRelative } from "../lib/format";

// Setting groups. Order matters — first match wins. Each entry's `id`
// doubles as the URL slug for /admin/settings/<id>.
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
    id: "tracking_ui",
    label: "Tracking page UI",
    description: "Operator-facing toggles for the Tracking table — what gets surfaced inline on rows, time windows for indicators, etc.",
    Icon: Sliders,
    match: (k) => k.startsWith("ui.tracking."),
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
  "ui.tracking.recent_change_window_hours": "Tracking row \"Changed Xh ago\" pill window (hours)",
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
  "prompt.email_draft.carrier_group.model": MODEL_OPTIONS,
  "prompt.email_draft.customer_group.model": MODEL_OPTIONS,
};

function valueShape(v: unknown): "string" | "number" | "boolean" | "json" {
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "json";
}

// State filter chip values. Composes with the free-text search.
type StateFilter = "all" | "customized" | "default" | "unsaved";

export function SettingsPage() {
  // The active sub-tab is now route-driven: /admin/settings/<id>. The
  // legacy "all groups stacked" rendering was a wall of textareas; one
  // group at a time keeps each tab focused and lets admins deep-link
  // to a specific section.
  const { section: routeSection } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  // Default to the first group when the URL is /admin/settings (no
  // section). Falling back via redirect rather than rendering "All"
  // because the wall-of-textareas behavior is exactly what we just
  // moved away from.
  const activeGroup = useMemo(() => {
    if (routeSection && GROUPS.some((g) => g.id === routeSection)) return routeSection;
    return GROUPS[0].id;
  }, [routeSection]);
  // Redirect /admin/settings (no slug) and unknown slugs to the first
  // group's URL so deep-link sharing works and the rail's active state
  // matches the URL.
  useEffect(() => {
    if (!routeSection) navigate(`/admin/settings/${GROUPS[0].id}`, { replace: true });
    else if (!GROUPS.some((g) => g.id === routeSection)) navigate(`/admin/settings/${GROUPS[0].id}`, { replace: true });
  }, [routeSection, navigate]);

  const [rows, setRows] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Tracks which prompt rows are expanded into their full editor.
  // Defaults to empty so the page lands compact; rows the operator
  // is actively editing auto-expand via the dirty-check below.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  // Modal state for the Reset confirm + Discard confirm flows. Replaces
  // window.confirm() with the same in-page modal pattern other admin
  // surfaces use (z-50, backdrop, esc-to-close).
  const [confirmModal, setConfirmModal] = useState<null | {
    title: string;
    body: string;
    confirmLabel: string;
    tone: "danger" | "neutral";
    onConfirm: () => void | Promise<void>;
  }>(null);
  // Save-all error surface — populated when "Save all" finishes with
  // per-row errors so the operator can see exactly what didn't land.
  const [saveAllErrors, setSaveAllErrors] = useState<{ key: string; error: string }[]>([]);
  const [savingAll, setSavingAll] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.settings.list();
      setRows(r.data);
      setEdits({});
      setSaveAllErrors([]);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  function setEdit(key: string, value: unknown) {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  function toggleExpanded(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function save(row: SettingRow) {
    setSavingKey(row.key);
    try {
      const v = row.key in edits ? edits[row.key] : row.value;
      await api.settings.update(row.key, v);
      await load();
    } catch (e) {
      setSaveAllErrors([{ key: row.key, error: (e as Error).message }]);
    }
    setSavingKey(null);
  }

  async function saveAll() {
    const keys = Object.keys(edits);
    if (!keys.length) return;
    setSavingAll(true);
    setSaveAllErrors([]);
    const errors: { key: string; error: string }[] = [];
    for (const k of keys) {
      try { await api.settings.update(k, edits[k]); }
      catch (e) { errors.push({ key: k, error: (e as Error).message }); }
    }
    setSavingAll(false);
    setSaveAllErrors(errors);
    await load();
  }

  function resetToDefault(row: SettingRow) {
    if (row.default === null || row.default === undefined) return;
    setConfirmModal({
      title: "Reset to default?",
      body: `"${FRIENDLY_LABEL[row.key] || row.key}" will revert to its hard-coded default. This is reversible — you can edit it again afterward.`,
      confirmLabel: "Reset",
      tone: "neutral",
      onConfirm: async () => {
        setConfirmModal(null);
        setSavingKey(row.key);
        try {
          await api.settings.update(row.key, row.default);
          await load();
        } catch (e) { setSaveAllErrors([{ key: row.key, error: (e as Error).message }]); }
        setSavingKey(null);
      },
    });
  }

  function discardEdits() {
    if (!Object.keys(edits).length) return;
    setConfirmModal({
      title: "Discard unsaved changes?",
      body: `${Object.keys(edits).length} edit${Object.keys(edits).length === 1 ? "" : "s"} will be cleared. This can't be undone.`,
      confirmLabel: "Discard",
      tone: "danger",
      onConfirm: () => {
        setConfirmModal(null);
        setEdits({});
      },
    });
  }

  // grouped = all rows bucketed by group, BEFORE state/text filters.
  // Used for rail counts (so the rail reflects every group's true
  // size, not the filtered slice).
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

  // The single active group's filtered rows. State + text filters apply
  // here — outside this list there's nothing else on the page so the
  // operator never wonders "is this the full list?".
  const activeRows = useMemo(() => {
    const list = grouped[activeGroup] || [];
    const q = filter.trim().toLowerCase();
    return list.filter((r) => {
      if (q) {
        const friendly = (FRIENDLY_LABEL[r.key] || "").toLowerCase();
        const desc = (r.description || "").toLowerCase();
        const valStr = typeof r.value === "string" ? r.value.toLowerCase() : "";
        const ok = r.key.toLowerCase().includes(q) || friendly.includes(q) || desc.includes(q) || valStr.includes(q);
        if (!ok) return false;
      }
      if (stateFilter === "customized") return !r.isDefault;
      if (stateFilter === "default") return r.isDefault;
      if (stateFilter === "unsaved") return r.key in edits;
      return true;
    });
  }, [grouped, activeGroup, filter, stateFilter, edits]);

  // esc-to-close the confirm modal — same pattern as drawers elsewhere.
  useEffect(() => {
    if (!confirmModal) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setConfirmModal(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmModal]);

  const totalKeys = rows.length;
  const editedKeys = rows.filter((r) => !r.isDefault).length;
  const dirtyCount = Object.keys(edits).length;

  // Per-group dirty counts so the rail can show "this group has unsaved
  // edits" indicators — surfaces a small amber dot next to the count.
  const groupDirtyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of Object.keys(edits)) {
      const g = GROUPS.find((g) => g.match(k));
      const id = g ? g.id : "other";
      counts[id] = (counts[id] || 0) + 1;
    }
    return counts;
  }, [edits]);

  const activeGroupCfg = GROUPS.find((g) => g.id === activeGroup) || GROUPS[0];

  return (
    <div className="space-y-5">
      {/* Sticky save-all bar — only renders when something's dirty. */}
      {dirtyCount > 0 ? (
        <div className="sticky top-0 z-30 -mx-4 sm:mx-0 sm:rounded-2xl bg-amber-50 ring-1 ring-amber-200 shadow-sm px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <span className="text-sm font-semibold text-amber-900">
              {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}
            </span>
            <span className="text-xs text-amber-800 truncate">
              {Object.keys(edits).slice(0, 3).map((k) => FRIENDLY_LABEL[k] || k).join(", ")}
              {dirtyCount > 3 ? ` and ${dirtyCount - 3} more` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={discardEdits}
              disabled={savingAll}
              className="text-xs font-medium px-3 py-1.5 rounded-lg text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={saveAll}
              disabled={savingAll}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Save className="h-3.5 w-3.5" />
              {savingAll ? "Saving…" : `Save all ${dirtyCount}`}
            </button>
          </div>
        </div>
      ) : null}

      {saveAllErrors.length > 0 ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 px-4 py-3 text-sm text-rose-800">
          <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> {saveAllErrors.length} setting{saveAllErrors.length === 1 ? "" : "s"} failed to save</div>
          <ul className="mt-2 space-y-1 text-xs">
            {saveAllErrors.map((e) => (
              <li key={e.key}>
                <span className="font-mono">{e.key}</span> — {e.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Header card */}
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
                className="rounded-lg border border-slate-200 pl-8 pr-3 py-2 text-sm bg-white w-56 lg:w-72 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 focus:outline-none"
                aria-label="Filter settings"
              />
            </div>
            <button
              onClick={() => api.settings.refresh().then(load).catch((e) => setSaveAllErrors([{ key: "(refresh)", error: (e as Error).message }]))}
              className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5"
              title="Force the server cache to drop and reload from Supabase"
            >
              <RotateCcw className="h-4 w-4" /> Refresh
            </button>
          </div>
        </div>

        {/* State filter chip row */}
        <div className="px-5 py-2.5 border-b border-slate-100 flex items-center gap-2 flex-wrap text-xs">
          <span className="text-slate-500 font-medium">Show:</span>
          {([
            { id: "all" as const,         label: "All", count: totalKeys },
            { id: "customized" as const,  label: "Customized", count: editedKeys },
            { id: "default" as const,     label: "On default", count: totalKeys - editedKeys },
            { id: "unsaved" as const,     label: "Unsaved", count: dirtyCount },
          ]).map((c) => {
            const active = stateFilter === c.id;
            const tone = c.id === "customized" ? (active ? "bg-emerald-600 text-white ring-emerald-700" : "text-emerald-700 ring-emerald-200 hover:bg-emerald-50")
              : c.id === "unsaved"            ? (active ? "bg-amber-600 text-white ring-amber-700"     : "text-amber-700 ring-amber-200 hover:bg-amber-50")
              : c.id === "default"            ? (active ? "bg-slate-700 text-white ring-slate-800"    : "text-slate-700 ring-slate-200 hover:bg-slate-50")
                                              : (active ? "bg-sky-600 text-white ring-sky-700"        : "text-sky-700 ring-sky-200 hover:bg-sky-50");
            return (
              <button
                key={c.id}
                onClick={() => setStateFilter(c.id)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full font-semibold ring-1 transition ${tone} disabled:opacity-50`}
                disabled={c.id === "unsaved" && c.count === 0}
              >
                {c.label} <span className={"text-[10px] " + (active ? "opacity-90" : "opacity-70")}>{c.count}</span>
              </button>
            );
          })}
        </div>

        {err ? <div className="mx-5 mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{err}</div> : null}
        {loading ? <div className="p-8 text-center text-slate-500">Loading…</div> : null}
      </div>

      {/* Two-column layout: route-driven rail (lg+) + active section's
          rows. Rail collapses to a horizontal pill nav on smaller
          widths so the operator still has navigation. */}
      {!loading ? (
        <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-5">
          <aside className="lg:sticky lg:top-4 lg:self-start mb-3 lg:mb-0">
            <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm p-2 lg:p-3 overflow-x-auto lg:overflow-visible">
              <ul className="flex lg:flex-col gap-1 min-w-max lg:min-w-0">
                {GROUPS.map(({ id, label, Icon }) => {
                  const count = (grouped[id] || []).length;
                  if (count === 0) return null;
                  const active = activeGroup === id;
                  const dirtyHere = groupDirtyCounts[id] || 0;
                  return (
                    <li key={id} className="shrink-0 lg:shrink">
                      <button
                        onClick={() => navigate(`/admin/settings/${id}`)}
                        className={
                          "w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition inline-flex items-center gap-2 whitespace-nowrap " +
                          (active
                            ? "bg-sky-50 text-sky-700 ring-1 ring-sky-200"
                            : "text-slate-600 hover:text-slate-900 hover:bg-slate-50")
                        }
                        aria-current={active ? "page" : undefined}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                        {dirtyHere > 0 ? (
                          <span
                            className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0"
                            title={`${dirtyHere} unsaved change${dirtyHere === 1 ? "" : "s"} in this group`}
                          />
                        ) : null}
                        <span className={"ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full " + (active ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600")}>
                          {count}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </aside>

          <div className="space-y-5">
            {/* Embed tab gets a hero on/off panel above the row list — the
                enabled toggle is the most consequential setting on the
                page (gates the whole iframe surface) and deserves more
                visual weight than a regular row. */}
            {activeGroup === "embed" ? (
              <EmbedHero
                row={rows.find((r) => r.key === "embed.freightpop.enabled") || null}
                edits={edits}
                savingKey={savingKey}
                onEdit={setEdit}
                onSave={save}
              />
            ) : null}

            <section className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
              <div className="p-5 border-b border-slate-100">
                <h3 className="text-base font-semibold flex items-center gap-2 text-slate-900">
                  <activeGroupCfg.Icon className="h-5 w-5 text-sky-600" /> {activeGroupCfg.label}
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 ml-1">
                    {activeRows.length}{activeRows.length !== (grouped[activeGroup]?.length || 0) ? ` / ${(grouped[activeGroup] || []).length}` : ""}
                  </span>
                </h3>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">{activeGroupCfg.description}</p>
              </div>
              {activeRows.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-slate-500">
                  {filter.trim() || stateFilter !== "all"
                    ? "No settings match your current filter."
                    : "No settings in this group yet."}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {activeRows.map((row) => (
                    <SettingRowItem
                      key={row.key}
                      row={row}
                      edits={edits}
                      savingKey={savingKey}
                      expandedKeys={expandedKeys}
                      onEdit={setEdit}
                      onToggleExpanded={toggleExpanded}
                      onSave={save}
                      onReset={resetToDefault}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      ) : null}

      {confirmModal ? (
        <ConfirmModal
          title={confirmModal.title}
          body={confirmModal.body}
          confirmLabel={confirmModal.confirmLabel}
          tone={confirmModal.tone}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      ) : null}
    </div>
  );
}

// Hero on/off panel for the embed sub-tab. The
// embed.freightpop.enabled key gates whether the FreightPOP iframe
// renders anywhere in the dashboard (drawer split-view + share page),
// so it deserves more visual weight than a regular row buried in a
// list. Operators can toggle it at-a-glance and immediately see what
// the current state is and what each state means.
function EmbedHero({ row, edits, savingKey, onEdit, onSave }: {
  row: SettingRow | null;
  edits: Record<string, unknown>;
  savingKey: string | null;
  onEdit: (key: string, value: unknown) => void;
  onSave: (row: SettingRow) => void;
}) {
  if (!row) return null;
  const dirty = row.key in edits;
  const current = dirty ? Boolean(edits[row.key]) : Boolean(row.value);
  return (
    <section className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm overflow-hidden">
      <div className={"px-5 py-4 flex items-start justify-between gap-4 flex-wrap " + (current ? "bg-emerald-50/40" : "bg-slate-50/60")}>
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className={"shrink-0 h-10 w-10 rounded-xl flex items-center justify-center " + (current ? "bg-emerald-600 text-white" : "bg-slate-300 text-white")}>
            <Power className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-slate-900">FreightPOP embed</h3>
              <span className={"text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ring-1 " + (current ? "bg-emerald-100 text-emerald-800 ring-emerald-200" : "bg-slate-200 text-slate-700 ring-slate-300")}>
                {current ? "On" : "Off"}
              </span>
              {dirty ? (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                  Unsaved
                </span>
              ) : null}
            </div>
            <p className="text-xs text-slate-600 mt-1 max-w-xl leading-relaxed">
              {current
                ? <>The FreightPOP iframe is <strong>active</strong> — the drawer split-view and share page render the embedded app. Reps can act on shipments without leaving the dashboard.</>
                : <>The FreightPOP iframe is <strong>disabled</strong> — drawer split-view and share page won't render it. Use this to suppress the embed during a FreightPOP outage or when reps should work directly in app.freightpop.com.</>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={current}
            onClick={() => onEdit(row.key, !current)}
            className={
              "relative h-7 w-12 rounded-full transition focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-emerald-500 " +
              (current ? "bg-emerald-600" : "bg-slate-300")
            }
            aria-label={current ? "Disable FreightPOP embed" : "Enable FreightPOP embed"}
          >
            <span
              className={
                "absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform " +
                (current ? "translate-x-5" : "translate-x-0")
              }
            />
          </button>
          <button
            onClick={() => onSave(row)}
            disabled={!dirty || savingKey === row.key}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 inline-flex items-center gap-1.5 disabled:bg-slate-200 disabled:text-slate-400"
          >
            <Save className="h-3.5 w-3.5" /> {savingKey === row.key ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}

function SettingRowItem({ row, edits, savingKey, expandedKeys, onEdit, onToggleExpanded, onSave, onReset }: {
  row: SettingRow;
  edits: Record<string, unknown>;
  savingKey: string | null;
  expandedKeys: Set<string>;
  onEdit: (key: string, value: unknown) => void;
  onToggleExpanded: (key: string) => void;
  onSave: (row: SettingRow) => void;
  onReset: (row: SettingRow) => void;
}) {
  const dirty = row.key in edits;
  const current = dirty ? edits[row.key] : row.value;
  const shape = valueShape(row.value);
  const friendly = FRIENDLY_LABEL[row.key] || row.key;
  // A row's editor is expanded when (a) the operator clicked Expand
  // OR (b) they've already started editing — we open implicitly so
  // they don't have to click twice when they tab into the value.
  const expanded = expandedKeys.has(row.key) || dirty;
  const dirtyOrDefault = dirty || row.isDefault;

  return (
    <li className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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
            {dirty ? (
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
              onClick={() => onReset(row)}
              disabled={savingKey === row.key}
              className="px-3 py-1.5 text-xs font-medium rounded-lg ring-1 ring-slate-200 text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
              title="Restore the hard-coded default value"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
          ) : null}
          <button
            onClick={() => onSave(row)}
            disabled={!dirtyOrDefault || savingKey === row.key}
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
            onChange={(s) => onEdit(row.key, s)}
          />
        ) : shape === "boolean" ? (
          <ToggleEditor
            value={Boolean(current)}
            onChange={(b) => onEdit(row.key, b)}
          />
        ) : shape === "number" ? (
          <NumberEditor value={Number(current)} onChange={(n) => onEdit(row.key, n)} />
        ) : shape === "string" ? (
          <StringEditor
            value={String(current ?? "")}
            expanded={expanded}
            onToggle={() => onToggleExpanded(row.key)}
            onChange={(s) => onEdit(row.key, s)}
          />
        ) : (
          <JsonEditor value={current} onChange={(v) => onEdit(row.key, v)} />
        )}
      </div>
    </li>
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

// Replaces the old raw checkbox + "true"/"false" label. Renders as a
// proper toggle switch with Enabled/Disabled wording so admins know
// at a glance which state the row is in.
function ToggleEditor({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="inline-flex items-center gap-2 select-none">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={
          "relative h-6 w-11 rounded-full transition focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-emerald-500 " +
          (value ? "bg-emerald-600" : "bg-slate-300")
        }
      >
        <span
          className={
            "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform " +
            (value ? "translate-x-5" : "translate-x-0")
          }
        />
      </button>
      <span
        className={
          "text-xs font-semibold transition " +
          (value ? "text-emerald-700" : "text-slate-500")
        }
      >
        {value ? "Enabled" : "Disabled"}
      </span>
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

// Default-collapsed string editor. Renders a compact preview row by
// default and only opens the full textarea when the operator hits
// Expand or starts editing. Major page-density improvement vs the
// old behavior of auto-opening every prompt over 80 chars.
function StringEditor({ value, expanded, onToggle, onChange }: {
  value: string;
  expanded: boolean;
  onToggle: () => void;
  onChange: (s: string) => void;
}) {
  const lineCount = (value.match(/\n/g)?.length || 0) + 1;
  const isShort = value.length <= 80 && !value.includes("\n");
  const preview = value.length > 80 ? value.slice(0, 80).replace(/\s+/g, " ").trim() + "…" : (value.replace(/\n/g, " ").trim() || "(empty)");

  // Short single-line strings render as a plain input without the
  // expand/collapse dance — the textarea would just be visual noise.
  if (isShort && !expanded) {
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

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left rounded-lg ring-1 ring-slate-200 bg-slate-50 hover:bg-slate-100 hover:ring-slate-300 px-3 py-2.5 transition group"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-slate-700 font-mono truncate flex-1">{preview}</div>
          <span className="shrink-0 text-[11px] text-slate-500 inline-flex items-center gap-1 group-hover:text-slate-900">
            <ChevronRightIcon className="h-3.5 w-3.5" /> Expand
          </span>
        </div>
        <div className="text-[10px] text-slate-400 mt-1">
          {value.length.toLocaleString()} chars · {lineCount} line{lineCount === 1 ? "" : "s"}
        </div>
      </button>
    );
  }

  // Expanded textarea. Sized to fit the content (8 row min, 24 max)
  // so multi-page prompts stay scannable but don't take over the
  // whole viewport.
  const charBasedRows = Math.ceil(value.length / 90);
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
        <button type="button" onClick={onToggle} className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
          <ChevronDown className="h-3.5 w-3.5" /> Collapse
        </button>
      </div>
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

// Replaces window.confirm() — same in-page modal pattern other admin
// surfaces use (z-50, backdrop, esc-to-close in the parent).
function ConfirmModal({ title, body, confirmLabel, tone, onConfirm, onCancel }: {
  title: string;
  body: string;
  confirmLabel: string;
  tone: "danger" | "neutral";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">{body}</p>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={
              "px-3 py-1.5 text-sm font-semibold rounded-lg text-white inline-flex items-center gap-1.5 " +
              (tone === "danger" ? "bg-rose-600 hover:bg-rose-700" : "bg-sky-600 hover:bg-sky-700")
            }
          >
            <X className="h-3.5 w-3.5" /> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
