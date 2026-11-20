import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ErrorBlock } from "../components/ErrorBlock";
import PullSection from "../components/invoiceFlow/PullSection";
import RunsSection from "../components/invoiceFlow/RunsSection";
import NotExportedSection from "../components/invoiceFlow/NotExportedSection";
import ReportSection from "../components/invoiceFlow/ReportSection";
import PushToErpSection from "../components/invoiceFlow/PushToErpSection";
import { fmtNum, fmtRelative } from "../lib/format";
import { getFlowSummary, isRunActive, runStageText, type FlowSummary } from "../lib/invoiceFlow";

// Invoices: one workflow on one page.
//   1 Pull → 2 Runs → 3 Not exported → 4 Report for Isaac → 5 Push to ERP
// The stepper at the top shows where each step stands and jumps to its section.

const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 60_000;
const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";

type StepKey = "pull" | "runs" | "not-exported" | "report" | "push";

interface StepView {
  key: StepKey;
  title: string;
  status: string;
  tone?: "busy" | "muted" | "warn";
}

function steps(s: FlowSummary | null): StepView[] {
  const active = s?.active ?? null;
  const latest = s?.latest_run ?? null;
  const running = !!active || isRunActive(latest);
  return [
    {
      key: "pull",
      title: "Pull",
      status: !s ? "…" : running ? "Pulling…" : s.last_pull_at ? `Last ${fmtRelative(s.last_pull_at)}` : "Not pulled yet",
      tone: running ? "busy" : undefined,
    },
    {
      key: "runs",
      title: "Runs",
      status: !s ? "…" : latest ? `#${latest.run_number} · ${runStageText(latest)}` : "No runs yet",
      tone: latest?.stage === "failed" ? "warn" : isRunActive(latest) ? "busy" : undefined,
    },
    {
      key: "not-exported",
      title: "Not exported",
      status: !s ? "…" : `${fmtNum(s.not_exported.total)} shipments`,
    },
    {
      key: "report",
      title: "Report for Isaac",
      status: !s ? "…" : s.report.last_emailed_at ? `Emailed ${fmtRelative(s.report.last_emailed_at)}` : "Not emailed yet",
    },
    { key: "push", title: "Push to ERP", status: "Coming next", tone: "muted" },
  ];
}

function Stepper({ items, onJump }: { items: StepView[]; onJump: (k: StepKey) => void }) {
  return (
    <nav aria-label="Invoice steps">
      <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 list-none p-0 m-0">
        {items.map((st, i) => (
          <li key={st.key} className="flex min-w-0">
            <button
              type="button"
              onClick={() => onJump(st.key)}
              className={"w-full rounded-xl px-3 py-2.5 text-left ring-1 transition-colors " + FOCUS + " "
                + (st.tone === "muted" ? "bg-slate-50 ring-slate-200 hover:bg-white" : "bg-white ring-slate-200 shadow-sm hover:ring-slate-300")}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden="true"
                  className={"h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold "
                    + (st.tone === "muted" ? "bg-slate-200 text-slate-500" : st.tone === "busy" ? "bg-violet-600 text-white" : "bg-slate-900 text-white")}>
                  {i + 1}
                </span>
                <span className={"text-sm font-medium truncate " + (st.tone === "muted" ? "text-slate-500" : "text-slate-900")}>{st.title}</span>
              </span>
              <span className={"mt-1 block text-xs truncate "
                + (st.tone === "busy" ? "text-violet-700" : st.tone === "warn" ? "text-rose-700" : "text-slate-500")}
                title={st.status}>
                {st.status}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Section({ id, n, title, hint, children }: { id: StepKey; n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={`invoices-${id}`} aria-labelledby={`invoices-${id}-title`} className="scroll-mt-20 space-y-3">
      <div>
        <h2 id={`invoices-${id}-title`} className="text-base font-semibold text-slate-900">
          <span className="text-slate-400 mr-1.5 tabular-nums">{n}.</span>{title}
        </h2>
        {hint ? <p className="text-sm text-slate-500 mt-0.5">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function InvoicesFlowPage() {
  const [summary, setSummary] = useState<FlowSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const mounted = useRef(false);
  const lastJson = useRef("");

  const refresh = useCallback(async () => {
    try {
      const s = await getFlowSummary();
      if (!mounted.current) return;
      setErr(null);
      const json = JSON.stringify(s);
      if (json !== lastJson.current) {
        lastJson.current = json;
        setSummary(s);
        setVersion((v) => v + 1); // the runs table follows the summary
      }
    } catch (e) {
      if (mounted.current) setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Set on every mount so React's dev double-mount doesn't leave it false.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const running = !!summary?.active || isRunActive(summary?.latest_run);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, running ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [refresh, running]);

  const jump = (k: StepKey) => {
    document.getElementById(`invoices-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Invoices</h1>
          <p className="text-sm text-slate-600 mt-1">Pull from FreightPOP, see what isn't exported to the ERP, send Isaac the report.</p>
        </div>
        <Stepper items={steps(summary)} onJump={jump} />
        {err ? <ErrorBlock compact tone={summary ? "warning" : "error"}>{err}</ErrorBlock> : null}
      </header>

      <Section id="pull" n={1} title="Pull" hint="Saves FreightPOP's Transactions History Report in FPX. Approvals, documents and the email follow on their own.">
        <PullSection summary={summary} onStarted={() => { void refresh(); }} />
      </Section>

      <Section id="runs" n={2} title="Runs" hint="Every pull is a numbered run. Open one for its Excel files and saved documents.">
        <RunsSection version={version} />
      </Section>

      <Section id="not-exported" n={3} title="Not exported to ERP" hint="Every shipment FreightPOP has not exported to the ERP, across all runs.">
        <NotExportedSection summary={summary ?? undefined} onChanged={() => { void refresh(); }} />
      </Section>

      <Section id="report" n={4} title="Report for Isaac">
        <ReportSection summary={summary ?? undefined} />
      </Section>

      <Section id="push" n={5} title="Push to ERP">
        <PushToErpSection />
      </Section>

      <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
        <span className="font-medium text-slate-400">Advanced</span>
        <Link to="/invoices/reading" className="hover:text-slate-800 underline-offset-2 hover:underline">Reading invoices</Link>
        <Link to="/invoicing/pushed" className="hover:text-slate-800 underline-offset-2 hover:underline">Exported to ERP list</Link>
      </footer>
    </div>
  );
}

export default InvoicesFlowPage;
