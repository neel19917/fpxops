import { useAuth } from "../lib/auth";
import { Package } from "lucide-react";

export function SignInPage() {
  const { signInWithMicrosoft, error } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-slate-50 to-sky-50">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl ring-1 ring-slate-200 p-8">
        <div className="flex items-center gap-3 mb-5">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center shadow">
            <Package className="h-6 w-6 text-white" />
          </div>
          <div>
            <div className="text-lg font-semibold leading-tight">FPXpress</div>
            <div className="text-xs text-slate-500 leading-tight">Shipment intelligence dashboard</div>
          </div>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">Sign in</h1>
        <p className="text-sm text-slate-500 mb-6">
          Use your company Microsoft account. Access is granted by an admin.
        </p>
        <button
          onClick={signInWithMicrosoft}
          className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-xl bg-white ring-1 ring-slate-300 hover:bg-slate-50 text-slate-900 font-medium shadow-sm"
        >
          <MicrosoftLogo />
          Continue with Microsoft
        </button>
        {error ? (
          <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{error}</div>
        ) : null}
        <p className="text-xs text-slate-400 mt-8">
          Not on the team? Access is limited to authorized FreightPOP employees.
        </p>
      </div>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23 23" width="18" height="18" aria-hidden="true">
      <rect x="1"  y="1"  width="10" height="10" fill="#F25022" />
      <rect x="12" y="1"  width="10" height="10" fill="#7FBA00" />
      <rect x="1"  y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}
