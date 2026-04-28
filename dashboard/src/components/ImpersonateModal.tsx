import { useEffect, useMemo, useState } from "react";
import { X, Search, ShieldAlert } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { UserProfileRow } from "../lib/types";

interface Props {
  onClose: () => void;
}

export function ImpersonateModal({ onClose }: Props) {
  const { realProfile, startImpersonate } = useAuth();
  const [users, setUsers] = useState<UserProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<UserProfileRow | null>(null);

  useEffect(() => {
    let alive = true;
    api.users.list()
      .then((r) => { if (alive) setUsers(r.data); })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return users
      .filter((u) => u.id !== realProfile?.id) // can't impersonate self
      .filter((u) => !s || u.email.toLowerCase().includes(s) || (u.full_name || "").toLowerCase().includes(s))
      .sort((a, b) => a.email.localeCompare(b.email));
  }, [users, q, realProfile?.id]);

  async function pick(target: UserProfileRow) {
    // Stage 1: read-only impersonation. Stage 2 (writes) is opted in from the
    // banner via a confirmation modal.
    try {
      await api.impersonate.start(target.id, false);
    } catch (e) {
      // Don't block the user if audit logging fails — surface the error but
      // let them proceed; the server-side console.log line still captures it.
      console.warn("[FPX] impersonate-start audit log failed:", (e as Error).message);
    }
    startImpersonate({ target, writes: false });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-600" />
              View as another user
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Read-only by default. You'll opt in to writes from the banner.
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 border-b border-slate-100">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by email or name…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {error ? <div className="m-4 rounded-lg bg-red-50 text-red-700 px-3 py-2 text-sm">{error}</div> : null}
          {loading ? (
            <div className="text-center text-slate-400 py-8 text-sm">Loading users…</div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-slate-400 py-8 text-sm">No matches.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {filtered.map((u) => (
                <li key={u.id}>
                  <button
                    onClick={() => setPending(u)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 flex items-center gap-3"
                  >
                    {u.avatar_url ? (
                      <img src={u.avatar_url} alt="" className="h-8 w-8 rounded-full" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600">
                        {(u.full_name || u.email).slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{u.full_name || u.email}</div>
                      <div className="text-xs text-slate-500 truncate">{u.email}</div>
                    </div>
                    <RoleChip role={u.role} />
                    {!u.enabled ? <span className="text-[10px] uppercase tracking-wide text-rose-600 ml-2">disabled</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pending ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm"
          onClick={(e) => { e.stopPropagation(); setPending(null); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-600" />
              View as {pending.email}?
            </h3>
            <p className="text-sm text-slate-600 mt-2">
              You'll see what a <strong>{pending.role}</strong> sees. <strong>Reads only</strong> —
              every API request will be tagged with both your email and theirs in the audit log.
              You can enable writes afterward from the banner.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPending(null)} className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100">Cancel</button>
              <button
                onClick={() => pick(pending)}
                className="px-4 py-2 text-sm rounded-lg bg-amber-600 text-white hover:bg-amber-700"
              >
                Start (read-only)
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RoleChip({ role }: { role: string }) {
  const cls =
    role === "admin"  ? "bg-violet-100 text-violet-700 ring-violet-200"
    : role === "member" ? "bg-sky-100 text-sky-700 ring-sky-200"
    : "bg-slate-100 text-slate-600 ring-slate-200";
  return <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ring-1 font-semibold ${cls}`}>{role}</span>;
}
