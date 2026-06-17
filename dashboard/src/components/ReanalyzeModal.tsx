import { useState } from "react";
import { X, Sparkles, RefreshCw, ArrowRight, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { fmtUsd } from "../lib/format";
import type { ReanalyzePreview, Shipment } from "../lib/types";

// Models an operator can escalate to. Haiku is the cheap default the
// auto-analyzer uses; Sonnet/Opus are for ambiguous shipments where the extra
// reasoning is worth the cost. Keep the ids in sync with the backend
// REANALYZE_MODELS allow-list (server/routes/shipments.js).
const MODELS: { id: string; label: string; hint: string }[] = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fast · cheapest" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "~3× cost" },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "deepest · ~7× cost" },
];

interface Props {
  shipmentId: string;
  current: {
    ai_issue: string | null;
    ai_recommendation: string | null;
    action_required: string | null;
    action_confidence: number | null;
    action_source: string | null;
  };
  // Model that produced the currently-stored verdict (latest per-shipment
  // analysis), if known — shown as a chip on the "Current" column.
  currentModel?: string | null;
  onClose: () => void;
  onReplaced: (shipment: Shipment) => void;
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

function shortModel(m: string | null | undefined): string {
  if (!m) return "—";
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function ReanalyzeModal({ shipmentId, current, currentModel, onClose, onReplaced }: Props) {
  const [model, setModel] = useState<string>("claude-sonnet-4-6");
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<ReanalyzePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const r = await api.shipments.reanalyzePreview(shipmentId, model);
      setPreview(r.preview);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function apply() {
    if (!preview || applying) return;
    setApplying(true);
    setError(null);
    try {
      const r = await api.shipments.applyReanalysis(shipmentId, preview.analysis_id);
      onReplaced(r.shipment);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setApplying(false);
    }
  }

  const manualLocked = current.action_source === "manual";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-600" />
              Re-analyze shipment
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Pick a model, preview the verdict, then choose whether to replace the stored analysis.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Model picker */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Model</div>
            <div className="grid grid-cols-3 gap-2">
              {MODELS.map((m) => {
                const active = m.id === model;
                return (
                  <button
                    key={m.id}
                    onClick={() => setModel(m.id)}
                    className={
                      "rounded-lg border px-3 py-2 text-left transition " +
                      (active
                        ? "border-violet-400 bg-violet-50 ring-2 ring-violet-200"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50")
                    }
                  >
                    <div className="text-sm font-medium text-slate-900">{m.label}</div>
                    <div className="text-[11px] text-slate-500">{m.hint}</div>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                onClick={run}
                disabled={running}
                className="text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <RefreshCw className={"h-4 w-4" + (running ? " animate-spin" : "")} />
                {running ? "Analyzing…" : preview ? "Re-run" : "Run analysis"}
              </button>
            </div>
          </div>

          {error ? (
            <div className="rounded-lg bg-red-50 text-red-700 px-3 py-2 text-sm">{error}</div>
          ) : null}

          {/* Comparison */}
          {preview ? (
            <div className="grid grid-cols-2 gap-3">
              <VerdictCard
                title="Current"
                modelLabel={shortModel(currentModel)}
                tone="slate"
                issue={current.ai_issue}
                recommendation={current.ai_recommendation}
                actionRequired={current.action_required}
                actionConfidence={current.action_confidence}
              />
              <VerdictCard
                title="Proposed"
                modelLabel={shortModel(preview.model)}
                tone="violet"
                issue={preview.issue}
                recommendation={preview.recommendation}
                actionRequired={preview.action_required}
                actionConfidence={preview.action_confidence}
                footer={
                  <span>
                    {preview.input_tokens ?? 0} in / {preview.output_tokens ?? 0} out · {fmtUsd(preview.cost_usd)}
                  </span>
                }
              />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 text-slate-400 text-sm text-center py-8">
              Run the analysis to compare a fresh verdict against the stored one.
            </div>
          )}

          {preview && manualLocked ? (
            <div className="rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                This shipment has a <strong>manual action override</strong>. Replacing updates the
                issue &amp; recommendation text but keeps the manual action decision.
              </span>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={!preview || applying}
            className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {applying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {applying ? "Replacing…" : "Replace stored analysis"}
          </button>
        </div>
      </div>
    </div>
  );
}

function VerdictCard({
  title,
  modelLabel,
  tone,
  issue,
  recommendation,
  actionRequired,
  actionConfidence,
  footer,
}: {
  title: string;
  modelLabel: string;
  tone: "slate" | "violet";
  issue: string | null;
  recommendation: string | null;
  actionRequired: string | null;
  actionConfidence: number | null;
  footer?: React.ReactNode;
}) {
  const chip =
    tone === "violet"
      ? "bg-violet-100 text-violet-700"
      : "bg-slate-100 text-slate-600";
  return (
    <div className="rounded-lg border border-slate-200 p-3 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{title}</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${chip}`}>{modelLabel}</span>
      </div>
      <div className="text-[11px] text-slate-500 mb-0.5">Action</div>
      <div className="text-sm text-slate-800 mb-2">
        {actionRequired ? String(actionRequired).toUpperCase() : "—"}
        <span className="text-slate-400"> · {pct(actionConfidence)} confidence</span>
      </div>
      <div className="text-[11px] text-slate-500 mb-0.5">Issue</div>
      <div className="text-sm text-slate-800 mb-2">{issue || "—"}</div>
      <div className="text-[11px] text-slate-500 mb-0.5">Recommendation</div>
      <div className="text-sm text-slate-800">{recommendation || "—"}</div>
      {footer ? <div className="text-[11px] text-slate-400 mt-2 pt-2 border-t border-slate-100">{footer}</div> : null}
    </div>
  );
}
