import { useEffect, useState } from "react";
import { Shield, ShieldAlert, UserCheck, UserX, Users as UsersIcon } from "lucide-react";
import { api } from "../lib/api";
import { fmtDateTime, fmtRelative } from "../lib/format";
import type { UserProfileRow } from "../lib/types";
import { useAuth } from "../lib/auth";

export function UsersPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<UserProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

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
      {err ? <div className="mx-5 mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{err}</div> : null}
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
          {loading ? <tr><td colSpan={6} className="p-8 text-center text-slate-500">Loading…</td></tr>
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
                  <span className="font-medium">{u.full_name || u.email.split("@")[0]}</span>
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
                <td className="px-5 py-3 text-right">
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
