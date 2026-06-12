import { useAuth } from "../lib/auth";

export function SignInPage() {
  const { signInWithMicrosoft, error } = useAuth();
  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-white">
      {/* Brand panel */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 text-white overflow-hidden bg-[#0E1A2B]">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.18] pointer-events-none"
          style={{
            background:
              "radial-gradient(800px 500px at 80% -10%, #2BA3E8 0%, transparent 60%), radial-gradient(700px 500px at -10% 110%, #1B6FB0 0%, transparent 60%)",
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-3">
            <img
              src="/brand/freightpop-diamond.png"
              alt="FreightPOP"
              className="h-11 w-11 drop-shadow"
            />
            <div className="text-2xl font-semibold tracking-tight">
              Freight<span className="text-[#2BA3E8]">POP</span>
            </div>
          </div>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Shipment intelligence,
            <br />
            <span className="text-[#2BA3E8]">at the speed of freight.</span>
          </h2>
          <p className="mt-4 text-slate-300/90 text-[15px] leading-relaxed">
            FPX Control Station is the FreightPOP internal hub for refresh runs,
            audits, and shipment analytics — built for the team, by the team.
          </p>
        </div>

        <div className="relative text-xs text-slate-400">
          © {new Date().getFullYear()} FreightPOP, Inc. · Internal use only
        </div>
      </div>

      {/* Sign-in panel */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          {/* Mobile-only logo */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <img
              src="/brand/freightpop-diamond.png"
              alt="FreightPOP"
              className="h-10 w-10"
            />
            <div className="text-xl font-semibold tracking-tight text-slate-900">
              Freight<span className="text-[#2289C9]">POP</span>
            </div>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Sign in to FPX Control Station
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Use your FreightPOP Microsoft account. Access is granted by an admin.
          </p>

          <button
            onClick={signInWithMicrosoft}
            className="mt-8 w-full inline-flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-[#0E1A2B] hover:bg-[#16263d] text-white font-medium shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2289C9] focus:ring-offset-2"
          >
            <MicrosoftLogo />
            Continue with Microsoft
          </button>

          {error ? (
            <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">
              {error}
            </div>
          ) : null}

          <div className="mt-10 pt-6 border-t border-slate-200">
            <p className="text-xs text-slate-400 leading-relaxed">
              Not on the team? Access is limited to authorized FreightPOP
              employees. Questions? Reach out to your admin.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 23 23"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}
