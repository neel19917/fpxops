import { useEffect, useRef, useState } from "react";
import { Box, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { sb } from "../lib/supabase";

// Dashboard-side relay for the Chrome extension's OAuth flow.
//
// Why this exists:
// - The extension's redirect URL is https://<extension-id>.chromiumapp.org/
//   and the unpacked-extension ID changes per install. Adding it to
//   Supabase Auth → Redirect URLs by hand for every rep is operational
//   pain we shouldn't ask users to bear.
// - The dashboard origin (https://fpxpress.netlify.app) is registered
//   with Supabase already and produces a stable redirect URL.
// - This page runs the standard dashboard OAuth flow, then once a
//   session is in hand uses chrome.runtime.sendMessage(EXT_ID, …)
//   (via manifest.externally_connectable) to deliver the session into
//   the extension. The extension's onMessageExternal listener stores
//   it under the same key the chrome.identity flow writes to, so the
//   rest of the extension is none the wiser.
//
// URL contract: ?extId=<extension-id> identifies which extension to
// relay to. The extension popup builds this URL when it opens the
// dashboard tab, so the rep never types it.

declare global {
  interface Window {
    chrome?: {
      runtime?: {
        sendMessage: (
          extensionId: string,
          message: unknown,
          callback?: (response: unknown) => void,
        ) => void;
      };
    };
  }
}

type Phase =
  | "loading"             // checking session / extension id
  | "needs_signin"        // user is not signed in yet — show the sign-in CTA
  | "needs_ext_id"        // missing ?extId — render help
  | "relaying"            // session in hand, posting to extension
  | "done"                // extension acknowledged
  | "error";              // extension rejected or chrome.runtime missing

export function ExtLoginPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [extId, setExtId] = useState<string>("");
  const [errMsg, setErrMsg] = useState<string>("");
  const [extInfo, setExtInfo] = useState<{ version: string | null; email: string | null; role: string | null; approved: boolean | null }>({
    version: null, email: null, role: null, approved: null,
  });

  // Pull ?extId out of the URL on mount. Without it we have no
  // destination for the session relay; render the help phase.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("extId") || "";
    if (!id) { setPhase("needs_ext_id"); return; }
    setExtId(id);
  }, []);

  // Guards against relaying the same session more than once. The listener
  // below used to fire on EVERY event carrying a session — including
  // INITIAL_SESSION and the hourly TOKEN_REFRESHED — and could also race the
  // getSession() call above, so a single visit could relay two or three times.
  const relayed = useRef(false);
  const signInFlight = useRef(false);

  // Once we know the ext id, check whether there's a Supabase session
  // already. If yes, jump to relay. If no, show the sign-in CTA.
  useEffect(() => {
    if (!extId) return;
    let cancelled = false;
    (async () => {
      const { data } = await sb.auth.getSession();
      if (cancelled || relayed.current) return;
      if (data.session?.access_token) {
        relayed.current = true;
        relaySession(data.session, extId);
      } else {
        setPhase("needs_signin");
      }
    })();
    // Watch for sign-in completion (the Microsoft popup closes and
    // emits SIGNED_IN). When it lands, relay the session.
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      if (event !== "SIGNED_IN" && event !== "INITIAL_SESSION") return;
      if (relayed.current || !s?.access_token) return;
      relayed.current = true;
      relaySession(s, extId);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extId]);

  function relaySession(session: { access_token: string; refresh_token: string | null; expires_at?: number; expires_in?: number; user?: { email?: string | null } }, extensionId: string) {
    setPhase("relaying");
    if (!window.chrome?.runtime?.sendMessage) {
      setErrMsg("This page must be opened from the FPXpress Chrome extension. (chrome.runtime not available — are you in a regular browser tab?)");
      setPhase("error");
      return;
    }
    // Deliberately NOT relaying refresh_token.
    //
    // A refresh token is single-use: Supabase rotates it on every use. Handing
    // a copy to the extension put one rotating credential in two independent
    // stores (localStorage here, chrome.storage.local there) that both believed
    // they owned it — so whichever side refreshed first invalidated the other,
    // and the loser's next refresh failed with "Already Used", which hard-kills
    // the session.
    //
    // The extension doesn't need it: the /api/me call it makes right after this
    // relay returns a `pending_api_key`, which it stores as fpxApiKey (see
    // fetchProfileWithSession in extension/background.js). That key is
    // long-lived and is the right credential shape for a background worker.
    // The access_token below just gets it through that one bootstrap call.
    const payload = {
      type: "fpxOauthSession",
      session: {
        access_token: session.access_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
        email: session.user?.email || null,
        provider: "azure",
      },
    };
    try {
      window.chrome.runtime.sendMessage(extensionId, payload, (response) => {
        const r = response as { ok?: boolean; error?: string; email?: string | null; role?: string | null; approved?: boolean; version?: string } | undefined;
        if (!r || !r.ok) {
          setErrMsg((r && r.error) || "The extension did not acknowledge the session.");
          setPhase("error");
          return;
        }
        setExtInfo({
          version: r.version || null,
          email: r.email || null,
          role: r.role || null,
          approved: r.approved ?? null,
        });
        setPhase("done");
      });
    } catch (e) {
      setErrMsg((e as Error).message);
      setPhase("error");
    }
  }

  async function startSignIn() {
    // Same double-click guard as SignIn.tsx — two clicks here mint two
    // Supabase sessions, because signInWithOAuth navigates the top-level
    // document rather than cancelling the prior navigation.
    if (signInFlight.current) return;
    signInFlight.current = true;
    setErrMsg("");
    // Stay on this page after auth — Supabase will redirect back here
    // with the same ?extId so the relay fires automatically.
    const target = `${window.location.origin}/ext-login?extId=${encodeURIComponent(extId)}`;
    const { error } = await sb.auth.signInWithOAuth({
      provider: "azure",
      options: {
        scopes: "openid email profile",
        redirectTo: target,
      },
    });
    if (error) {
      // Release only on failure; on success we're already navigating away.
      signInFlight.current = false;
      setErrMsg(error.message);
      setPhase("error");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="bg-white rounded-2xl shadow-xl ring-1 ring-slate-200 p-8 max-w-md w-full">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center text-white">
            <Box className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">FPXpress extension login</h1>
            <p className="text-xs text-slate-500">Signs you into the Chrome extension via the dashboard.</p>
          </div>
        </div>

        {phase === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <RefreshCw className="h-4 w-4 animate-spin" /> Checking your session…
          </div>
        ) : null}

        {phase === "needs_ext_id" ? (
          <div className="rounded-lg bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-900">
            <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Missing extension id</div>
            <div className="text-xs mt-1 leading-relaxed">
              Open this page from the <strong>Sign in via dashboard</strong> button inside the FPXpress
              extension popup. The extension provides its id as a query parameter so this relay knows
              where to send your session.
            </div>
          </div>
        ) : null}

        {phase === "needs_signin" ? (
          <>
            <p className="text-sm text-slate-600 mb-4 leading-relaxed">
              Sign in with your Microsoft account. The dashboard handles the OAuth dance,
              then hands the session to the extension automatically. You won't need to add
              your extension's redirect URL to Supabase.
            </p>
            <button
              type="button"
              onClick={startSignIn}
              className="w-full px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 disabled:pointer-events-none"
            >
              Sign in with Microsoft
            </button>
          </>
        ) : null}

        {phase === "relaying" ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <RefreshCw className="h-4 w-4 animate-spin" /> Sending your session to the extension…
          </div>
        ) : null}

        {phase === "done" ? (
          <div className="rounded-lg bg-emerald-50 ring-1 ring-emerald-200 px-4 py-3 text-sm text-emerald-900">
            <div className="font-semibold flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> Signed in</div>
            <div className="text-xs mt-1 leading-relaxed">
              {extInfo.email ? <>Welcome, <strong>{extInfo.email}</strong>. </> : null}
              {extInfo.approved === false ? (
                <>Your account is awaiting admin approval — the extension will work once an admin enables you.</>
              ) : extInfo.role ? (
                <>You're signed in as <strong>{extInfo.role}</strong>. You can close this tab and return to the FPXpress extension.</>
              ) : (
                <>You can close this tab and return to the FPXpress extension.</>
              )}
              {extInfo.version ? <div className="text-[11px] text-emerald-700/80 mt-2">Extension v{extInfo.version}</div> : null}
            </div>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-4 py-3 text-sm text-rose-800">
            <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Couldn't sign in</div>
            <div className="text-xs mt-1 leading-relaxed">{errMsg || "Unknown error."}</div>
            <button
              onClick={() => { setErrMsg(""); setPhase(extId ? "needs_signin" : "needs_ext_id"); }}
              className="mt-3 text-xs font-semibold text-rose-700 hover:text-rose-900 underline"
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
