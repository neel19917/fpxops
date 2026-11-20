import { useState } from "react";
import { CheckCircle2, Download, Loader2, XCircle } from "lucide-react";
import { ErrorBlock } from "../ErrorBlock";
import { fmtNum, fmtRelative } from "../../lib/format";
import {
  isRunActive, runStageText, startPull,
  type FlowSummary, type PullMonths, type PullShipmentType, type Run,
} from "../../lib/invoiceFlow";

// Step 1: one button that pulls FreightPOP's Transactions History Report.
// Everything after it (approvals, documents, the email to Isaac) runs on its own.

const MONTHS: PullMonths[] = [1, 3, 6, 12];
const TYPES: { key: PullShipmentType; label: string }[] = [
  { key: "non-parcel", label: "Non-parcel" },
  { key: "parcel", label: "Parcel" },
  { key: "both", label: "Both" },
];

const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";

export function RunProgress({ run }: { run: Run }) {
  const active = isRunActive(run);
  const failed = run.stage === "failed";
  const pct = run.stage === "documents" && run.docs_total > 0 ? Math.min(100, Math.round((run.docs_done / run.docs_total) * 100)) : null;
  return (
    <div className="space-y-1.5">
      <div className={"flex items-center gap-2 text-sm font-medium " + (failed ? "text-rose-700" : active ? "text-slate-900" : "text-emerald-700")}>
        {active ? <Loader2 className="h-4 w-4 animate-spin text-violet-600" aria-hidden="true" />
          : failed ? <XCircle className="h-4 w-4" aria-hidden="true" />
          : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
        <span>{runStageText(run)}</span>
      </div>
      {pct != null ? (
        <div className="h-1.5 w-full max-w-sm rounded-full bg-slate-100 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function EmailResult({ run }: { run: Pick<Run, "report_emailed_at" | "report_email_error" | "stage"> }) {
  if (run.report_emailed_at) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700" title={new Date(run.report_emailed_at).toLocaleString()}>
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Sent
      </span>
    );
  }
  if (run.report_email_error) {
    return <span className="text-amber-700" title={run.report_email_error}>Not sent — {run.report_email_error}</span>;
  }
  return <span className="text-slate-400">{run.stage === "failed" ? "Not sent" : "Not yet"}</span>;
}

export default function PullSection({ summary, onStarted }: { summary?: FlowSummary | null; onStarted?: () => void }) {
  const [months, setMonths] = useState<PullMonths>(1);
  const [type, setType] = useState<PullShipmentType>("non-parcel");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const latest = summary?.latest_run ?? null;
  const active = summary?.active ?? null;
  const running = !!active || isRunActive(latest);

  const pull = async () => {
    setBusy(true);
    setErr(null);
    try {
      await startPull(months, type);
      onStarted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const select = "rounded-lg border-0 ring-1 ring-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 " + FOCUS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs font-medium text-slate-500 mb-1">Window</span>
          <select className={select} value={months} onChange={(e) => setMonths(Number(e.target.value) as PullMonths)} disabled={busy || running}>
            {MONTHS.map((m) => <option key={m} value={m}>Last {m === 1 ? "month" : `${m} months`}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs font-medium text-slate-500 mb-1">Shipments</span>
          <select className={select} value={type} onChange={(e) => setType(e.target.value as PullShipmentType)} disabled={busy || running}>
            {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={pull}
          disabled={busy || running}
          className={"inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed " + FOCUS}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
          Pull from FreightPOP
        </button>
        {running ? <span className="text-xs text-slate-500 self-center">A pull is in progress. The next one can start when it finishes.</span> : null}
      </div>

      {err ? <ErrorBlock compact>{err}</ErrorBlock> : null}

      {active ? (
        <div className="rounded-lg bg-violet-50/60 ring-1 ring-violet-200 px-4 py-3 text-sm">
          {latest && isRunActive(latest) && (active.run_number == null || active.run_number === latest.run_number) ? (
            <>
              <div className="text-xs text-slate-500 mb-1">Run #{latest.run_number}, started {fmtRelative(latest.started_at)}</div>
              <RunProgress run={latest} />
            </>
          ) : (
            <div className="flex items-center gap-2 font-medium text-slate-900">
              <Loader2 className="h-4 w-4 animate-spin text-violet-600" aria-hidden="true" />
              {active.run_number ? `Run #${active.run_number}: ` : ""}{active.message || runStageText({ stage: active.stage, docs_done: 0, docs_total: 0, error: null })}
            </div>
          )}
          <p className="mt-1 text-xs text-slate-500">After the report is saved, FPX checks approvals, saves invoice documents and emails the report. This page updates every 10 seconds.</p>
        </div>
      ) : latest ? (
        <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-4 py-3 text-sm space-y-2">
          <div className="text-xs text-slate-500">
            Last pull: Run #{latest.run_number}, {fmtRelative(latest.started_at)}
            {latest.report_rows != null ? ` · ${fmtNum(latest.report_rows)} report rows` : ""}
            {latest.not_exported != null ? ` · ${fmtNum(latest.not_exported)} not exported` : ""}
          </div>
          <RunProgress run={latest} />
          <div className="text-xs text-slate-600">Report emailed: <EmailResult run={latest} /></div>
        </div>
      ) : summary ? (
        <p className="text-sm text-slate-500">Nothing has been pulled yet.</p>
      ) : null}
    </div>
  );
}
