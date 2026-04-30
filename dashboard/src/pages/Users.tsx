import { useEffect, useState } from "react";
import { KeyRound, Pencil, Shield, ShieldAlert, UserCheck, UserX, Users as UsersIcon } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime, fmtRelative } from "../lib/format";
import type { UserProfileRow } from "../lib/types";
import { useAuth } from "../lib/auth";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";

interface InlineNameProps {
  value: string | null;
  fallback: string;
  onSave: (next: string | null) => Promise<void>;
}
function InlineName({ value, fallback, onSave }: InlineNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const [busy, setBusy] = useState(false);
  async function commit() {
    const next = draft.trim();
    if (next === (value || "").trim()) { setEditing(false); return; }
    setBusy(true);
    try {
      await onSave(next === "" ? null : next);
      setEditing(false);
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(value || ""); setEditing(true); }}
        className="group inline-flex items-center gap-1.5 text-left font-medium hover:text-sky-700"
        title="Edit name"
      >
        <span>{value || fallback}</span>
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value || ""); setEditing(false); }
      }}
      disabled={busy}
      maxLength={200}
      className="text-sm font-medium px-2 py-1 rounded-md border border-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-300 min-w-[180px]"
    />
  );
}

export function UsersPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<UserProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [issueErr, setIssueErr] = useState<string | null>(null);
  const [issueResult, setIssueResult] = useState<null | { email: string; plaintext: string; keyName: string; revokedCount: number }>(null);

  async function load() {
    setLoading(true); setErr(null);
    try { setRows((await api.users.list()).data); }
    catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleEnabled(u: UserProfileRow) {
    try { await api.users.update(u.id, { enabled: !u.enabled }); load(); }
    catch (e) { alert((e as Error).message); }
  }
  async function setRole(u: UserProfileRow, role: string) {
    try { await api.users.update(u.id, { role }); load(); }
    catch (e) { alert((e as Error).message); }
  }
  async function setName(u: UserProfileRow, full_name: string | null) {
    const r = await api.users.update(u.id, { full_name });
    setRows((prev) => prev.map((p) => p.id === r.user.id ? r.user : p));
  }
  async function issueKey(u: UserProfileRow) {
    const confirmMsg = `Approve API access for ${u.email} and auto-issue a new API key?` +
      `\n\nAny existing key for this user will be revoked.` +
      `\nThe plaintext will be sent to their extension on the next sign-in / Recheck.`;
    if (!confirm(confirmMsg)) return;
    setIssuingId(u.id);
    setIssueErr(null);
    setIssueResult(null);
    try {
      const r = await api.users.issueKey(u.id);
      setIssueResult({
        email: u.email,
        plaintext: r.plaintext,
        keyName: r.key.name,
        revokedCount: r.revoked_count,
      });
      // The user is now enabled server-side too — refresh.
      load();
    } catch (e) {
      setIssueErr((e as Error).message);
    } finally {
      setIssuingId(null);
    }
  }

  return (
    <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
      <div className="p-5 border-b border-slate-100">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <UsersIcon className="h-5 w-5 text-sky-600" /> Users
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Everyone who's signed in with Microsoft is here. Flip <b>Enabled</b> to grant access.
        </p>
      </div>
      {err ? <div className="mx-5 mt-4"><ErrorBlock compact>{err}</ErrorBlock></div> : null}
      {issueErr ? <div className="mx-5 mt-4"><ErrorBlock compact>Issue failed: {issueErr}</ErrorBlock></div> : null}
      {issueResult ? (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-sky-600" /> API key issued
            </h3>
            <p className="text-sm text-slate-600 mt-2">
              <b>{issueResult.email}</b> is enabled and a fresh API key (<code className="font-mono text-xs bg-slate-100 px-1 rounded">{issueResult.keyName}</code>) was generated.
              {issueResult.revokedCount > 0 ? <> The previous {issueResult.revokedCount} active key(s) were revoked.</> : null}
            </p>
            <p className="text-sm text-slate-600 mt-2">
              The plaintext is stashed for the rep's extension — they'll pick it up automatically on their next <b>Recheck approval</b> click or the next time they reopen the popup. No need to copy this anywhere.
            </p>
            <details className="mt-4">
              <summary className="text-xs text-slate-500 cursor-pointer">Need to send manually instead?</summary>
              <div className="mt-2 flex gap-2">
                <code className="flex-1 bg-slate-900 text-slate-100 font-mono text-xs p-3 rounded-lg break-all">{issueResult.plaintext}</code>
                <button
                  onClick={() => navigator.clipboard.writeText(issueResult.plaintext)}
                  className="px-3 py-3 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs"
                >Copy</button>
              </div>
              <p className="text-[11px] text-slate-500 mt-1">Treat this like a password.</p>
            </details>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setIssueResult(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
              >Done</button>
            </div>
          </div>
        </div>
      ) : null}
      <table className="w-full text-sm">
        <thead className="bg-slate-50">
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="px-5 py-2.5 font-medium">User</th>
            <th className="px-5 py-2.5 font-medium">Email</th>
            <th className="px-5 py-2.5 font-medium">Role</th>
            <th className="px-5 py-2.5 font-medium">Last login</th>
            <th className="px-5 py-2.5 font-medium">Joined</th>
            <th className="px-5 py-2.5 font-medium text-right">Access</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading ? <LoadingState variant="row" colSpan={6} />
          : rows.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-slate-500">No users yet.</td></tr>
          : rows.map((u) => {
            const isMe = profile?.id === u.id;
            return (
              <tr key={u.id}>
                <td className="px-5 py-3 flex items-center gap-3 min-w-[240px]">
                  {u.avatar_url ? (
                    <img src={u.avatar_url} alt="" className="h-8 w-8 rounded-full" />
                  ) : (
                    <div className="h-8 w-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600">
                      {(u.full_name || u.email).slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <InlineName
                    value={u.full_name}
                    fallback={u.email.split("@")[0]}
                    onSave={(next) => setName(u, next)}
                  />
                  {isMe ? <span className="text-xs text-slate-400">(you)</span> : null}
                </td>
                <td className="px-5 py-3 text-slate-600">{u.email}</td>
                <td className="px-5 py-3">
                  <select
                    value={u.role}
                    disabled={isMe}
                    onChange={(e) => setRole(u, e.target.value)}
                    className="text-sm px-2 py-1 rounded-md border border-slate-300 disabled:opacity-60"
                  >
                    <option value="viewer">viewer</option>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  {u.role === "admin" ? <ShieldAlert className="inline-block ml-2 h-4 w-4 text-amber-500" />
                    : <Shield className="inline-block ml-2 h-4 w-4 text-slate-400" />}
                </td>
                <td className="px-5 py-3 text-slate-500">{fmtRelative(u.last_login_at)}</td>
                <td className="px-5 py-3 text-slate-500">{fmtDateTime(u.created_at)}</td>
                <td className="px-5 py-3 text-right whitespace-nowrap">
                  <button
                    onClick={() => issueKey(u)}
                    disabled={isMe || issuingId === u.id}
                    title="Approve API access — generates a key and pushes it to their extension"
                    className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-sky-50 text-sky-700 hover:bg-sky-100 disabled:opacity-50 mr-2"
                  >
                    <KeyRound className="h-4 w-4" />
                    {issuingId === u.id ? "Issuing…" : "Issue API key"}
                  </button>
                  <button
                    onClick={() => toggleEnabled(u)}
                    disabled={isMe}
                    className={
                      "inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium disabled:opacity-50 " +
                      (u.enabled
                        ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200")
                    }
                  >
                    {u.enabled ? <><UserCheck className="h-4 w-4" /> Enabled</> : <><UserX className="h-4 w-4" /> Disabled</>}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
