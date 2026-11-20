import { Download, Loader2, Mail, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorBlock } from "../ErrorBlock";
import { useAuth } from "../../lib/auth";
import { downloadNotExportedXlsx, emailReportNow, setReportRecipients, type FlowSummary } from "../../lib/invoiceFlow";
import { errorText, fmtWhen } from "./notExported/format";

// The not-exported Excel for Isaac: download it, email it now, and (admins)
// choose who receives it. It is also emailed after every pull.

const PRIMARY = "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const QUIET = "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";

type EmailResult = { ok: boolean; text: string };

function parseRecipients(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)));
}

export default function ReportSection({ summary }: { summary?: FlowSummary }) {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const [recipients, setRecipients] = useState<string[]>(summary?.report?.recipients ?? []);
  const [lastEmailed, setLastEmailed] = useState<string | null>(summary?.report?.last_emailed_at ?? null);
  useEffect(() => { if (summary?.report?.recipients) setRecipients(summary.report.recipients); }, [summary?.report?.recipients]);
  useEffect(() => { setLastEmailed(summary?.report?.last_emailed_at ?? null); }, [summary?.report?.last_emailed_at]);

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [emailResult, setEmailResult] = useState<EmailResult | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function onDownload() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadNotExportedXlsx();
    } catch (e) {
      setDownloadError(errorText(e, "The Excel could not be downloaded. Try again in a moment."));
    } finally {
      setDownloading(false);
    }
  }

  async function onEmail() {
    setSending(true);
    setEmailResult(null);
    try {
      const res = await emailReportNow();
      const to = (res.recipients ?? []).join(", ") || "no one";
      if (res.sent) {
        setEmailResult({ ok: true, text: `Sent to ${to}.` });
        setLastEmailed(new Date().toISOString());
      } else {
        setEmailResult({ ok: false, text: `Not sent: ${res.error || "unknown reason"}.` });
      }
    } catch (e) {
      setEmailResult({ ok: false, text: `Not sent: ${errorText(e, "the request failed")}.` });
    } finally {
      setSending(false);
    }
  }

  function startEdit() {
    setDraft(recipients.join(", "));
    setSaveError(null);
    setEditing(true);
  }

  async function onSave() {
    const list = parseRecipients(draft);
    if (list.length === 0) { setSaveError("Add at least one email address."); return; }
    const bad = list.filter((e) => !/^[^@\s]+@freightpop\.com$/.test(e));
    if (bad.length) { setSaveError(`Only @freightpop.com addresses: ${bad.join(", ")}`); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await setReportRecipients(list);
      setRecipients(res.recipients ?? list);
      setEditing(false);
    } catch (e) {
      setSaveError(errorText(e, "The recipients could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl ring-1 ring-slate-200 bg-white p-5 space-y-5">
      <div>
        <div className="text-sm text-slate-700">
          An Excel of every shipment not exported to the ERP, biggest charge first, with its FPX status, approver and whether documents are saved.
        </div>
        <div className="text-sm text-slate-500 mt-1">Sent automatically after every pull.</div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={PRIMARY} onClick={onDownload} disabled={downloading}>
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {downloading ? "Preparing…" : "Download Excel"}
        </button>
        <button type="button" className={QUIET} onClick={onEmail} disabled={sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
          {sending ? "Sending…" : "Email Isaac now"}
        </button>
      </div>

      {downloadError ? <ErrorBlock compact>{downloadError}</ErrorBlock> : null}
      {emailResult ? (
        emailResult.ok
          ? <div className="rounded-lg ring-1 ring-emerald-200 bg-emerald-50 text-emerald-800 px-3 py-2 text-sm">{emailResult.text}</div>
          : <ErrorBlock compact tone="warning">{emailResult.text}</ErrorBlock>
      ) : null}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm border-t border-slate-100 pt-4">
        <div className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-slate-500 font-medium flex items-center gap-2">
            Recipients
            {isAdmin && !editing ? (
              <button type="button" onClick={startEdit} className="inline-flex items-center gap-1 normal-case tracking-normal text-sky-700 hover:underline">
                <Pencil className="h-3 w-3" /> Edit
              </button>
            ) : null}
          </dt>
          <dd className="mt-1 text-slate-900">
            {editing ? (
              <div className="space-y-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder="isaacs@freightpop.com, someone@freightpop.com"
                  className="w-full rounded-lg ring-1 ring-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
                {saveError ? <ErrorBlock compact>{saveError}</ErrorBlock> : null}
                <div className="flex items-center gap-2">
                  <button type="button" className={PRIMARY} onClick={onSave} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Save
                  </button>
                  <button type="button" className={QUIET} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                </div>
              </div>
            ) : recipients.length ? (
              <ul className="space-y-0.5">
                {recipients.map((r) => <li key={r} className="break-all">{r}</li>)}
              </ul>
            ) : (
              <span className="text-slate-500">{summary ? "None set" : "—"}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">Last emailed</dt>
          <dd className="mt-1 text-slate-900">{lastEmailed ? fmtWhen(lastEmailed) : "Not emailed yet"}</dd>
        </div>
      </dl>
    </div>
  );
}
