import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Inbox, Mail, Plug, PlugZap, RefreshCw, Send, ShieldCheck, Terminal, Unplug } from "lucide-react";
import {
  connectMailbox,
  DEFAULT_MAILBOX,
  disconnectMailbox,
  getMailboxConnection,
  getMailboxStatus,
  syncMailboxNow,
  testMailboxConnection,
  type Connection,
  type Status,
} from "../lib/mailboxApi";
import { KPI } from "../components/KPI";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

// Admin: connect the shared support mailbox (freightsupport@freightpop.com)
// to FPX through its own Azure app. The app can reach only that one mailbox
// (Exchange RBAC for Applications). FPX reads mail and creates reply drafts;
// it never sends and never deletes anything.

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TestResult = { ok: boolean; inbox_total?: number; sent_total?: number; error?: string };
type Msg = { tone: "ok" | "err"; text: string };

export function SupportMailboxAdminPage() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<null | "test" | "sync" | "disconnect">(null);
  const [showReconnect, setShowReconnect] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [c, s] = await Promise.all([getMailboxConnection(), getMailboxStatus()]);
      if (!mounted.current) return;
      setConn(c.connection ?? null);
      setStatus(s);
      setLoadErr(null);
    } catch (e) {
      if (mounted.current && !quiet) setLoadErr((e as Error).message);
    } finally {
      if (mounted.current && !quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [load]);

  // Poll every 10s while the first full-history sync is still running.
  const backfilling = !!conn && conn.status !== "disconnected" && !conn.backfill_done;
  useEffect(() => {
    if (!backfilling) return;
    const id = setInterval(() => { load(true); }, 10_000);
    return () => clearInterval(id);
  }, [backfilling, load]);

  async function runTest() {
    setBusy("test"); setMsg(null); setTest(null);
    try {
      const r = await testMailboxConnection();
      setTest(r.test);
      await load(true);
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(null); }
  }

  async function runSync() {
    setBusy("sync"); setMsg(null);
    try {
      await syncMailboxNow();
      setMsg({ tone: "ok", text: "Sync started. New and changed emails will appear within a minute or two." });
      setTimeout(() => { load(true); }, 3000);
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(null); }
  }

  async function runDisconnect() {
    setBusy("disconnect"); setMsg(null);
    try {
      const r = await disconnectMailbox();
      setConn(r.connection ?? null);
      setConfirmDisconnect(false);
      setMsg({ tone: "ok", text: "Disconnected. All synced emails are kept; nothing in Outlook was changed." });
      await load(true);
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(null); }
  }

  function onConnected(c: Connection, t: TestResult) {
    setConn(c);
    setTest(t);
    setShowReconnect(false);
    setMsg({ tone: "ok", text: "Connected. The first sync has started and will pull the mailbox's full history." });
    load(true);
  }

  const connected = !!conn && conn.status !== "disconnected";

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Inbox className="h-5 w-5 text-sky-600" /> Support Mailbox
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Connect {DEFAULT_MAILBOX} so the team can see threads awaiting a reply and create reply drafts in Outlook. FPX never sends or deletes email.
          </p>
        </div>
        <button onClick={() => load()} disabled={loading}
          className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} /> Refresh
        </button>
      </div>

      {msg ? (
        msg.tone === "err" ? <ErrorBlock>{msg.text}</ErrorBlock> : (
          <div className="rounded-lg p-3 text-sm flex items-center gap-2 ring-1 bg-emerald-50 ring-emerald-200 text-emerald-800">
            <CheckCircle2 className="h-4 w-4" /> {msg.text}
          </div>
        )
      ) : null}

      {loadErr ? <ErrorBlock>{loadErr}</ErrorBlock> : null}

      {loading && !conn ? <LoadingState /> : (
        <>
          <StatusCard conn={conn} status={status} />

          {connected ? (
            <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-3">
              <h2 className="text-sm font-semibold text-slate-900">Actions</h2>
              <div className="flex flex-wrap gap-2">
                <button onClick={runTest} disabled={!!busy}
                  className="text-sm px-3 py-2 rounded-lg bg-white ring-1 ring-slate-200 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50">
                  <PlugZap className="h-4 w-4" /> {busy === "test" ? "Testing…" : "Test connection"}
                </button>
                <button onClick={runSync} disabled={!!busy}
                  className="text-sm px-3 py-2 rounded-lg bg-white ring-1 ring-slate-200 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50">
                  <RefreshCw className={"h-4 w-4 " + (busy === "sync" ? "animate-spin" : "")} /> Sync now
                </button>
                <button onClick={() => setShowReconnect((v) => !v)} disabled={!!busy}
                  className="text-sm px-3 py-2 rounded-lg bg-white ring-1 ring-slate-200 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50">
                  <Plug className="h-4 w-4" /> {showReconnect ? "Hide re-connect" : "Re-connect / rotate secret"}
                </button>
                <button onClick={() => setConfirmDisconnect(true)} disabled={!!busy}
                  className="text-sm px-3 py-2 rounded-lg bg-white ring-1 ring-rose-200 text-rose-700 hover:bg-rose-50 inline-flex items-center gap-1.5 disabled:opacity-50 ml-auto">
                  <Unplug className="h-4 w-4" /> Disconnect
                </button>
              </div>
              {test ? <TestResultView test={test} /> : null}
            </section>
          ) : null}

          {!connected ? <SetupSteps /> : null}

          {!connected || showReconnect ? (
            <ConnectForm
              reconnect={connected}
              initial={conn}
              onConnected={onConnected}
            />
          ) : null}

          {connected ? <details className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5">
            <summary className="text-sm font-semibold text-slate-900 cursor-pointer">How the Azure app was set up</summary>
            <div className="mt-3"><SetupSteps embedded /></div>
          </details> : null}
        </>
      )}

      {confirmDisconnect ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm" onClick={() => setConfirmDisconnect(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold flex items-center gap-2 text-rose-700">
              <Unplug className="h-5 w-5" /> Disconnect the support mailbox?
            </h3>
            <ul className="text-sm text-slate-700 mt-3 space-y-1.5 list-disc pl-5">
              <li>FPX stops syncing new email from {conn?.mailbox || DEFAULT_MAILBOX}.</li>
              <li>Every email already synced stays in FPX, and past reply drafts stay listed.</li>
              <li>Nothing in Outlook is touched: no emails, folders or drafts are changed or deleted.</li>
              <li>You can re-connect at any time with the same or a new client secret.</li>
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDisconnect(false)} className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100">Cancel</button>
              <button onClick={runDisconnect} disabled={busy === "disconnect"} className="px-4 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: string | null | undefined }) {
  const s = status || "disconnected";
  const map: Record<string, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    connected: { label: "Connected", cls: "bg-emerald-100 text-emerald-700 ring-emerald-200", Icon: CheckCircle2 },
    error: { label: "Error", cls: "bg-rose-100 text-rose-700 ring-rose-200", Icon: AlertTriangle },
    disconnected: { label: "Not connected", cls: "bg-slate-100 text-slate-600 ring-slate-200", Icon: Unplug },
  };
  const m = map[s] || map.disconnected;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${m.cls}`}>
      <m.Icon className="h-3 w-3" /> {m.label}
    </span>
  );
}

function StatusCard({ conn, status }: { conn: Connection | null; status: Status | null }) {
  const st = conn?.status || "disconnected";
  const messageCount = status?.message_count ?? null;
  const backfillDone = conn?.backfill_done ?? status?.backfill_done ?? false;
  const lastSync = conn?.last_sync_at ?? status?.last_sync_at ?? null;
  const lastError = conn?.last_error ?? status?.last_error ?? null;
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KPI label="Status" value={st === "connected" ? "Connected" : st === "error" ? "Error" : "Not connected"} icon={Mail}
          tone={st === "connected" ? "success" : st === "error" ? "danger" : "default"} hint={conn?.mailbox || DEFAULT_MAILBOX} />
        <KPI label="Emails synced" value={messageCount != null ? fmtNum(messageCount) : "—"} icon={Inbox}
          tone={conn && !backfillDone && st !== "disconnected" ? "brand" : "default"}
          hint={!conn ? "" : backfillDone ? "Full history synced" : st === "disconnected" ? "Sync stopped" : "Pulling full history…"} />
        <KPI label="Last sync" value={lastSync ? fmtRelative(lastSync) : "—"} icon={RefreshCw}
          hint={lastSync ? fmtDateTime(lastSync) : "Not synced yet"} />
      </div>

      {conn ? (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-slate-900">Connection</h2>
            <StatusPill status={st} />
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Field label="Mailbox" value={conn.mailbox} />
            <Field label="Tenant ID" value={conn.tenant_id} mono />
            <Field label="Client ID" value={conn.client_id} mono />
            <Field label="Client secret" value={conn.secret_hint ? `••••${conn.secret_hint}` : "••••"} mono />
            <Field label="Connected by" value={conn.connected_by || "—"} />
            <Field label="Connected" value={conn.connected_at ? `${fmtDateTime(conn.connected_at)} (${fmtRelative(conn.connected_at)})` : "—"} />
            <Field label="Last sync" value={lastSync ? `${fmtDateTime(lastSync)} (${fmtRelative(lastSync)})` : "Not synced yet"} />
            <Field label="Full history" value={backfillDone ? "Done" : st === "disconnected" ? "Stopped" : "In progress (this page refreshes every 10 seconds)"} />
          </dl>
          {!backfillDone && st !== "disconnected" ? (
            <div className="h-1.5 rounded-full bg-sky-100 overflow-hidden">
              <div className="h-full w-1/3 bg-sky-500 rounded-full animate-pulse" />
            </div>
          ) : null}
          {lastError ? <ErrorBlock tone={st === "error" ? "error" : "warning"} compact><strong>Last error:</strong> {lastError}</ErrorBlock> : null}
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={"text-slate-900 truncate " + (mono ? "font-mono text-[13px]" : "")} title={value}>{value}</dd>
    </div>
  );
}

function TestResultView({ test }: { test: TestResult }) {
  if (!test.ok) return <ErrorBlock>{test.error || "The connection test failed."}</ErrorBlock>;
  return (
    <div className="rounded-lg p-3 text-sm flex items-center gap-2 ring-1 bg-emerald-50 ring-emerald-200 text-emerald-800">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      <span>
        Connection works. Inbox: <strong>{fmtNum(test.inbox_total ?? 0)}</strong> emails, Sent: <strong>{fmtNum(test.sent_total ?? 0)}</strong> emails.
      </span>
    </div>
  );
}

function SetupSteps({ embedded = false }: { embedded?: boolean }) {
  const body = (
    <ol className="space-y-3 text-sm text-slate-700">
      <Step n={1} title="Run the setup script (a Microsoft 365 admin, once)">
        <p>On a machine with PowerShell 7, from the FPX repo, run:</p>
        <pre className="mt-1.5 rounded-lg bg-slate-900 text-slate-100 text-xs px-3 py-2 overflow-x-auto"><code>pwsh scripts/azure/setup-support-mailbox.ps1</code></pre>
        <p className="mt-1.5 text-xs text-slate-500">Full walkthrough: <code className="font-mono">docs/support-mailbox-setup.md</code></p>
      </Step>
      <Step n={2} title="What the script does">
        <ul className="list-disc pl-5 space-y-1">
          <li>Creates an Azure app named "FPX Support Mailbox" with a client secret.</li>
          <li>Grants it <strong>no</strong> tenant-wide Microsoft Graph mail permissions.</li>
          <li>Uses Exchange Online RBAC for Applications to limit the app to <strong>{DEFAULT_MAILBOX} only</strong>. It cannot open any other mailbox.</li>
          <li>Gives it read and write on that one mailbox, which FPX needs to create reply drafts. FPX never sends or deletes mail.</li>
        </ul>
      </Step>
      <Step n={3} title="Copy the values it prints">
        <p>The script ends by printing the Tenant ID, Client ID and Client secret. Paste them into the form below and click <strong>Test & connect</strong>.</p>
      </Step>
      <Step n={4} title="If the test says access is denied">
        <p>Exchange can take up to 2 hours to apply the new role assignment. Wait, then try again. Nothing is saved until the test passes.</p>
      </Step>
    </ol>
  );
  if (embedded) return body;
  return (
    <section className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><Terminal className="h-4 w-4 text-slate-500" /> Set up the Azure app</h2>
        <p className="text-xs text-slate-500 mt-0.5">Do this once. The app can reach only the support mailbox.</p>
      </div>
      {body}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="h-6 w-6 shrink-0 rounded-full bg-sky-100 text-sky-700 text-xs font-semibold flex items-center justify-center">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-900">{title}</div>
        <div className="mt-1 text-slate-600">{children}</div>
      </div>
    </li>
  );
}

function ConnectForm({ reconnect, initial, onConnected }: {
  reconnect: boolean;
  initial: Connection | null;
  onConnected: (c: Connection, t: TestResult) => void;
}) {
  const [tenantId, setTenantId] = useState(initial?.tenant_id || "");
  const [clientId, setClientId] = useState(initial?.client_id || "");
  const [secret, setSecret] = useState("");
  const [mailbox, setMailbox] = useState(initial?.mailbox || DEFAULT_MAILBOX);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const tenantErr = tenantId.trim() && !GUID_RE.test(tenantId.trim()) ? "Tenant ID must be a GUID like 00000000-0000-0000-0000-000000000000." : null;
  const clientErr = clientId.trim() && !GUID_RE.test(clientId.trim()) ? "Client ID must be a GUID like 00000000-0000-0000-0000-000000000000." : null;
  const mailboxErr = mailbox.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox.trim()) ? "Enter a valid email address." : null;
  const complete = tenantId.trim() && clientId.trim() && secret && mailbox.trim();
  const valid = complete && !tenantErr && !clientErr && !mailboxErr;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setSubmitting(true); setError(null);
    try {
      const r = await connectMailbox({
        tenant_id: tenantId.trim(),
        client_id: clientId.trim(),
        client_secret: secret,
        mailbox: mailbox.trim(),
      });
      setSecret("");
      onConnected(r.connection, r.test);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-5 space-y-4" autoComplete="off">
      <div>
        <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-slate-500" /> {reconnect ? "Re-connect or rotate the client secret" : "Connect the mailbox"}
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {reconnect
            ? "Enter a new client secret (and IDs if they changed). FPX tests it first; the current connection keeps working if the test fails. Synced emails are kept."
            : "FPX tests the connection before saving anything. The secret is stored encrypted and is never shown again."}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextField id="mb-tenant" label="Tenant ID" value={tenantId} onChange={setTenantId} placeholder="00000000-0000-0000-0000-000000000000" mono error={tenantErr} />
        <TextField id="mb-client" label="Client ID (Application ID)" value={clientId} onChange={setClientId} placeholder="00000000-0000-0000-0000-000000000000" mono error={clientErr} />
        <TextField id="mb-secret" label="Client secret" value={secret} onChange={setSecret} type="password"
          placeholder={reconnect && initial?.secret_hint ? `Current secret ends in ${initial.secret_hint}` : "Paste the secret value"}
          error={touched && !secret ? "Enter the client secret." : null} />
        <TextField id="mb-mailbox" label="Mailbox" value={mailbox} onChange={setMailbox} placeholder={DEFAULT_MAILBOX} error={mailboxErr} />
      </div>
      {error ? <ErrorBlock>{error}</ErrorBlock> : null}
      <div className="flex justify-end">
        <button type="submit" disabled={submitting || !valid}
          className="text-sm px-4 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 shadow inline-flex items-center gap-1.5">
          <Send className="h-4 w-4" /> {submitting ? "Testing…" : "Test & connect"}
        </button>
      </div>
    </form>
  );
}

function TextField({ id, label, value, onChange, placeholder, type = "text", mono, error }: {
  id: string; label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; mono?: boolean; error?: string | null;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">{label}</label>
      <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        autoComplete={type === "password" ? "new-password" : "off"} spellCheck={false}
        className={"w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-sky-200 " +
          (mono ? "font-mono " : "") + (error ? "border-rose-300 bg-rose-50" : "border-slate-200")} />
      {error ? <p className="text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}
