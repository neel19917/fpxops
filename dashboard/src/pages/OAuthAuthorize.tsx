import { useEffect, useMemo, useState } from "react";
import { Sparkles, ShieldCheck, Lock, AlertTriangle, Loader2, Check, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

// Sign-in + "Allow Claude?" screen for the FPX Claude connector (OAuth 2.1).
// Claude opens https://fpxpress.netlify.app/oauth/authorize?client_id=…&
// redirect_uri=…&code_challenge=…&state=…; the rep signs in with their FPX
// (Microsoft) account, sees what Claude gets — read-only — and clicks Allow.
// The API issues a one-time code and we send the browser back to Claude.
//
// Microsoft sign-in always returns to the site root, so the full request URL
// is remembered (10 min) and OAuthReturn below brings the rep back here.

const RETURN_KEY = "fpx.oauth.return";

export function OAuthReturn() {
  const { session } = useAuth();
  useEffect(() => {
    if (!session) return;
    try {
      const raw = localStorage.getItem(RETURN_KEY);
      if (!raw) return;
      localStorage.removeItem(RETURN_KEY);
      const { url, at } = JSON.parse(raw);
      if (Date.now() - at < 10 * 60_000 && typeof url === "string" && url.startsWith(`${window.location.origin}/oauth/authorize?`)
        && window.location.pathname !== "/oauth/authorize") {
        window.location.replace(url);
      }
    } catch { /* ignore */ }
  }, [session]);
  return null;
}

const CAN = [
  "Search shipments and read their status, ETA, issues and notes",
  "See what to focus on and the Tasks board",
  "See FreightPOP dashboard totals and run trends",
];

export function OAuthAuthorizePage() {
  const { session, profile, loading, signInWithMicrosoft, signingIn } = useAuth();
  const q = useMemo(() => new URLSearchParams(window.location.search), []);
  const params = {
    client_id: q.get("client_id") || "",
    redirect_uri: q.get("redirect_uri") || "",
    code_challenge: q.get("code_challenge") || "",
    code_challenge_method: q.get("code_challenge_method") || "",
    state: q.get("state") || "",
    resource: q.get("resource") || "",
    response_type: q.get("response_type") || "",
  };
  const [client, setClient] = useState<{ client_name: string; redirect_host: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);

  const badRequest = !params.client_id || !params.redirect_uri || params.response_type !== "code" || !params.code_challenge;

  useEffect(() => {
    if (!session || !profile?.enabled || badRequest) return;
    api.oauth.client(params.client_id, params.redirect_uri).then(setClient).catch((e) => setErr((e as Error).message));
  }, [session, profile?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  function signIn() {
    try { localStorage.setItem(RETURN_KEY, JSON.stringify({ url: window.location.href, at: Date.now() })); } catch { /* ignore */ }
    signInWithMicrosoft();
  }

  async function decide(decision: "allow" | "deny") {
    setBusy(decision); setErr(null);
    try {
      const r = await api.oauth.approve({ ...params, decision });
      window.location.href = r.redirect;
    } catch (e) { setErr((e as Error).message); setBusy(null); }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white ring-1 ring-slate-200 shadow-xl overflow-hidden">
        <div className="px-6 py-5 bg-gradient-to-r from-violet-600 to-violet-500 text-white">
          <div className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="h-5 w-5" /> Connect Claude to FPX</div>
          <div className="text-sm text-violet-100 mt-0.5">Sign in with your FPX account</div>
        </div>
        <div className="p-6 space-y-4">
          {badRequest ? (
            <Notice tone="err" text="This sign-in link is incomplete. Start the connection again from Claude (Settings → Connectors)." />
          ) : loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Checking your sign-in…</div>
          ) : !session ? (
            <>
              <p className="text-sm text-slate-700">Claude wants read-only access to FPX. Sign in with the Microsoft account you use for FPX to continue.</p>
              <button onClick={signIn} disabled={signingIn}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#0E1A2B] text-white text-sm font-medium px-4 py-2.5 hover:bg-slate-800 disabled:opacity-60">
                {signingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Sign in with Microsoft
              </button>
            </>
          ) : !profile?.enabled ? (
            <Notice tone="err" text="Your FPX account isn't enabled yet — ask an FPX admin to approve it, then try again." />
          ) : err ? (
            <Notice tone="err" text={err} />
          ) : !client ? (
            <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : (
            <>
              <p className="text-sm text-slate-700">
                <b>{client.client_name}</b> wants to connect to FPX as <b>{profile.email}</b>.
              </p>
              <div className="rounded-xl bg-emerald-50 ring-1 ring-emerald-200 p-3">
                <div className="text-sm font-medium text-emerald-900 flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" /> Read-only — it can:</div>
                <ul className="mt-1.5 space-y-1">
                  {CAN.map((c) => <li key={c} className="text-sm text-emerald-900 flex gap-1.5"><Check className="h-4 w-4 shrink-0 mt-0.5" /> {c}</li>)}
                </ul>
                <div className="text-xs text-emerald-800 mt-2">It can't change shipments, tasks or settings. Every lookup is logged under your name.</div>
              </div>
              <div className="text-xs text-slate-500">You'll go back to <b>{client.redirect_host}</b>. Disconnect any time from FPX → More → Connect Claude.</div>
              <div className="flex gap-2">
                <button onClick={() => decide("deny")} disabled={!!busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl ring-1 ring-slate-200 text-slate-700 text-sm px-4 py-2.5 hover:bg-slate-50 disabled:opacity-50">
                  {busy === "deny" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Deny
                </button>
                <button onClick={() => decide("allow")} disabled={!!busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-violet-600 text-white text-sm font-medium px-4 py-2.5 hover:bg-violet-700 disabled:opacity-50">
                  {busy === "allow" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Allow
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Notice({ tone, text }: { tone: "err"; text: string }) {
  return (
    <div className={"rounded-xl p-3 text-sm ring-1 flex gap-2 " + (tone === "err" ? "bg-rose-50 ring-rose-200 text-rose-800" : "")}>
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> {text}
    </div>
  );
}
