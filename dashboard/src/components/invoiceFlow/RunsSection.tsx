import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, FileSpreadsheet, Loader2 } from "lucide-react";
import { ErrorBlock } from "../ErrorBlock";
import { LoadingState } from "../LoadingState";
import { fmtDate, fmtDateTime, fmtNum } from "../../lib/format";
import {
  downloadRunDocumentsZip, getRun, listRuns, monthsLabel, shipmentTypeLabel,
  type Run, type RunFiles,
} from "../../lib/invoiceFlow";
import { EmailResult, RunProgress } from "./PullSection";

// Step 2: every pull is a numbered run. Each run checks approvals, saves
// invoice documents and emails the report on its own; this table shows how far
// each got. Expand a run for its files.

const PAGE = 20;
const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";

function approvalsText(s: string | null): string {
  switch (s) {
    case "queued": return "Waiting";
    case "running": return "Checking";
    case "done": return "Checked";
    case "error": return "Failed";
    default: return "—";
  }
}

function windowText(r: Run): string {
  if (r.date_from && r.date_to) return `${fmtDate(r.date_from)} – ${fmtDate(r.date_to)}`;
  return monthsLabel(r.months);
}

function RunDetail({ run }: { run: Run }) {
  const [data, setData] = useState<RunFiles | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipErr, setZipErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getRun(run.audit_id).then((d) => { if (alive) setData(d); }, (e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [run.audit_id]);

  const zip = async () => {
    setZipBusy(true);
    setZipErr(null);
    try { await downloadRunDocumentsZip(run.audit_id, run.run_number); }
    catch (e) { setZipErr(e instanceof Error ? e.message : String(e)); }
    finally { setZipBusy(false); }
  };

  const docs = data?.docs ?? data?.docs_count ?? run.docs_done;
  return (
    <div className="space-y-3 px-4 py-3 bg-slate-50/70">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
        <span>Shipments: {shipmentTypeLabel(run.shipment_type)}</span>
        <span>Started {fmtDateTime(run.started_at)}</span>
        {run.finished_at ? <span>Finished {fmtDateTime(run.finished_at)}</span> : null}
        {run.requested_by ? <span>By {run.requested_by}</span> : null}
        {run.docs_failed > 0 ? <span className="text-amber-700">{fmtNum(run.docs_failed)} documents could not be saved</span> : null}
      </div>
      <RunProgress run={run} />
      {err ? <ErrorBlock compact>{err}</ErrorBlock> : !data ? <LoadingState variant="inline" label="Loading files…" /> : (
        <div className="flex flex-wrap gap-2">
          {data.files.map((f) => (
            <a
              key={f.name}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className={"inline-flex items-center gap-1.5 rounded-lg bg-white ring-1 ring-slate-300 px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-100 " + FOCUS}
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600" aria-hidden="true" /> {f.label || f.name}
            </a>
          ))}
          <button
            type="button"
            onClick={zip}
            disabled={zipBusy || !docs}
            title={!docs ? "No documents saved for this run yet" : undefined}
            className={"inline-flex items-center gap-1.5 rounded-lg bg-white ring-1 ring-slate-300 px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-50 " + FOCUS}
          >
            {zipBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            Download documents (ZIP){docs ? ` · ${fmtNum(docs)}` : ""}
          </button>
          {!data.files.length ? <span className="self-center text-xs text-slate-500">No Excel files saved for this run.</span> : null}
        </div>
      )}
      {zipErr ? <ErrorBlock compact>{zipErr}</ErrorBlock> : null}
    </div>
  );
}

/** `version` changes whenever the page's summary does, so the table follows the live run. */
export default function RunsSection({ version = 0 }: { version?: number }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await listRuns(PAGE, offset);
      if (!mounted.current) return;
      setRuns(r.runs);
      setTotal(r.total);
      setErr(null);
    } catch (e) {
      if (mounted.current) setErr(e instanceof Error ? e.message : String(e));
    }
  }, [offset]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => { void load(); }, [load, version]);

  if (err && !runs) return <ErrorBlock>{err}</ErrorBlock>;
  if (!runs) return <LoadingState label="Loading runs…" />;
  if (!runs.length) return <p className="text-sm text-slate-500">No runs yet. Pull from FreightPOP to start the first one.</p>;

  const th = "px-3 py-2 text-left text-xs font-medium text-slate-500 whitespace-nowrap";
  const td = "px-3 py-2 whitespace-nowrap";
  return (
    <div className="space-y-2">
      {err ? <ErrorBlock compact tone="warning">{err}</ErrorBlock> : null}
      <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className={th} aria-label="Expand" />
              <th className={th}>Run #</th>
              <th className={th}>When</th>
              <th className={th}>Window</th>
              <th className={th + " text-right"}>Report rows</th>
              <th className={th + " text-right"}>Not exported</th>
              <th className={th}>Approvals</th>
              <th className={th}>Documents saved</th>
              <th className={th}>Emailed</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((r) => {
              const isOpen = open === r.audit_id;
              return (
                <Fragment key={r.audit_id}>
                  <tr className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(isOpen ? null : r.audit_id)}>
                    <td className={td}>
                      <button type="button" aria-expanded={isOpen} aria-label={`Show files of run ${r.run_number}`} className={"text-slate-400 " + FOCUS}
                        onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : r.audit_id); }}>
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className={td + " font-medium text-slate-900 tabular-nums"}>#{r.run_number}</td>
                    <td className={td + " text-slate-600"} title={new Date(r.started_at).toLocaleString()}>{fmtDateTime(r.started_at)}</td>
                    <td className={td + " text-slate-600"}>{windowText(r)}</td>
                    <td className={td + " text-right tabular-nums"}>{fmtNum(r.report_rows)}</td>
                    <td className={td + " text-right tabular-nums"}>{fmtNum(r.not_exported)}</td>
                    <td className={td + (r.approval_status === "error" ? " text-amber-700" : " text-slate-600")}>{approvalsText(r.approval_status)}</td>
                    <td className={td + " tabular-nums text-slate-600"}>
                      {r.docs_total > 0 ? `${fmtNum(r.docs_done)} / ${fmtNum(r.docs_total)}` : r.stage === "done" ? "None needed" : "—"}
                    </td>
                    <td className={td + " text-xs max-w-[16rem] truncate"}><EmailResult run={r} /></td>
                    <td className={td + " text-xs max-w-[18rem] truncate"} title={r.error ?? undefined}>
                      <span className={r.stage === "failed" ? "text-rose-700" : r.stage === "done" ? "text-emerald-700" : "text-violet-700"}>
                        {r.stage === "failed" ? "Failed" : r.stage === "done" ? "Done" : "In progress"}
                      </span>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={10} className="p-0"><RunDetail run={r} /></td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > PAGE ? (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{fmtNum(offset + 1)}–{fmtNum(Math.min(offset + PAGE, total))} of {fmtNum(total)} runs</span>
          <span className="flex gap-2">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}
              className={"rounded-md ring-1 ring-slate-300 px-2.5 py-1 hover:bg-slate-100 disabled:opacity-40 " + FOCUS}>Newer</button>
            <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}
              className={"rounded-md ring-1 ring-slate-300 px-2.5 py-1 hover:bg-slate-100 disabled:opacity-40 " + FOCUS}>Older</button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
