import { useAuth } from "../lib/auth";

export function SignInPage() {
  const { signInWithMicrosoft, signingIn, unexpectedSignOut, error } = useAuth();
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

          {/* Landing here without having clicked Sign out means the session
              ended on its own. Say so — an unexplained bounce to this screen
              is exactly what made this bug so hard to pin down, because
              everyone assumed they'd simply been idle. */}
          {unexpectedSignOut ? (
            <div className="mt-4 rounded-lg bg-amber-50 ring-1 ring-amber-200 px-3 py-2.5 text-xs text-amber-900 leading-relaxed">
              <div className="font-semibold">Your session ended unexpectedly.</div>
              <div className="mt-0.5 text-amber-800">
                You didn't sign out — the session was dropped. Signing back in will work.
                If this keeps happening, open the browser console and run{" "}
                <code className="font-mono bg-amber-100 px-1 rounded">fpxAuthLog()</code>, then
                send the output to whoever's looking at this.
              </div>
            </div>
          ) : null}

          {/* disabled while redirecting: a double-click here used to mint two
              independent Supabase sessions (two /authorize → two /callback),
              because signInWithOAuth navigates the top-level document and the
              second click races the first navigation rather than being
              cancelled by it. */}
          <button
            type="button"
            onClick={signInWithMicrosoft}
            disabled={signingIn}
            className="mt-8 w-full inline-flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-[#0E1A2B] hover:bg-[#16263d] text-white font-medium shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2289C9] focus:ring-offset-2 disabled:opacity-60 disabled:pointer-events-none"
          >
            {signingIn ? (
              <>
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Redirecting to Microsoft…
              </>
            ) : (
              <>
                <MicrosoftLogo />
                Continue with Microsoft
              </>
            )}
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
