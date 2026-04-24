import { Hourglass, LogOut, RefreshCw } from "lucide-react";
import { useAuth } from "../lib/auth";

export function PendingApprovalPage() {
  const { profile, signOut, refreshProfile } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-50 to-amber-50">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl ring-1 ring-slate-200 p-8 text-center">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center mb-5">
          <Hourglass className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold mb-2">Waiting on approval</h1>
        <p className="text-sm text-slate-600 mb-1">
          You're signed in as <b>{profile?.email}</b>.
        </p>
        <p className="text-sm text-slate-500 mb-6">
          An admin needs to enable your account before you can access the dashboard.
        </p>
        <div className="flex gap-2 justify-center">
          <button
            onClick={refreshProfile}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1.5"
          >
            <RefreshCw className="h-4 w-4" /> Check again
          </button>
          <button
            onClick={signOut}
            className="px-4 py-2 text-sm font-medium rounded-lg ring-1 ring-slate-300 hover:bg-slate-100 text-slate-700 flex items-center gap-1.5"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
