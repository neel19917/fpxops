import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { sb } from "./supabase";
import type { Session } from "@supabase/supabase-js";
import { getImpersonate, setImpersonate, subscribeImpersonate, type ImpersonateState } from "./impersonate";
import { api, type ClientConfig } from "./api";
import { swrClear } from "./swrCache";
import { logAuth } from "./authLog";

// Set for the duration of a user-initiated sign-out. supabase-js emits the
// same SIGNED_OUT event whether the user clicked Sign out or whether a refresh
// failed and GoTrue dropped the session itself — and those two deserve very
// different treatment. Module-scoped rather than state because the SDK event
// can arrive before React re-renders.
let deliberateSignOut = false;

export interface UserProfile {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: "viewer" | "member" | "admin";
  enabled: boolean;
}

interface AuthState {
  session: Session | null;
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
  // Real (non-impersonated) admin profile. Equal to `profile` when not
  // impersonating; lets the layout decide whether to show the View-as control.
  realProfile: UserProfile | null;
  impersonate: ImpersonateState | null;
  // Server-supplied feature flags / config (e.g. FreightPOP iframe embed).
  // Loaded from /api/me alongside the profile; null until the first fetch
  // resolves.
  clientConfig: ClientConfig | null;
  // True while an OAuth redirect is being initiated. Lets the sign-in button
  // disable itself — see signInWithMicrosoft.
  signingIn: boolean;
  // True when the session ended on its own rather than by the user's action.
  unexpectedSignOut: boolean;
  startImpersonate: (s: ImpersonateState) => void;
  stopImpersonate: () => void;
  signInWithMicrosoft: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  // Two separate gates. `authLoading` is "do we know yet whether there's a
  // session"; `profileLoading` is "are we still fetching the profile for the
  // session we have". They used to be one flag because the profile fetch lived
  // inside the onAuthStateChange callback — see the effect below for why that
  // had to change.
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impersonate, setImpersonateState] = useState<ImpersonateState | null>(() => getImpersonate());
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // True when the session ended without the user asking. Drives the banner on
  // the sign-in screen so an unexplained bounce reads as "something broke",
  // not "you must have logged out".
  const [unexpectedSignOut, setUnexpectedSignOut] = useState(false);

  useEffect(() => subscribeImpersonate(setImpersonateState), []);

  const loadProfile = useCallback(async (sess: Session | null) => {
    if (!sess?.user) { setProfile(null); return; }
    const { data, error } = await sb
      .from("fpx_user_profiles")
      .select("id, email, full_name, avatar_url, role, enabled")
      .eq("id", sess.user.id)
      .maybeSingle();
    if (error) {
      setError(error.message);
      setProfile(null);
      return;
    }
    if (!data) {
      // The trigger usually auto-creates on first login. In case it hasn't run yet,
      // show "pending approval" state rather than an error.
      setProfile({
        id: sess.user.id,
        email: sess.user.email || "",
        fullName: (sess.user.user_metadata as { full_name?: string; name?: string })?.full_name
          || (sess.user.user_metadata as { full_name?: string; name?: string })?.name
          || null,
        avatarUrl: (sess.user.user_metadata as { avatar_url?: string })?.avatar_url || null,
        role: "viewer",
        enabled: false,
      });
      return;
    }
    setError(null);
    setProfile({
      id: data.id,
      email: data.email,
      fullName: data.full_name,
      avatarUrl: data.avatar_url,
      role: data.role as UserProfile["role"],
      enabled: data.enabled,
    });
    // Fetch server-supplied feature flags (FreightPOP embed, etc.) once
    // we know the user is enabled. Failure here is non-fatal — the rest
    // of the app stays usable; embed-dependent UI just stays hidden.
    if (data.enabled) {
      api.me.get()
        .then((r) => { if (r.client_config) setClientConfig(r.client_config); })
        .catch(() => {});
    }
  }, []);

  // Session bootstrap. getSession() returns whatever's in localStorage, and
  // the SDK's autoRefreshToken refreshes it when it needs refreshing — this
  // used to run its own expiry-skew check and call refreshSession() itself,
  // making it one of three competing refresh drivers (see api.ts). It no
  // longer refreshes anything; it just reads.
  //
  // The timeout stays: if getSession() wedges (auth lock contention, a
  // service worker eating the call) we must still drop the "Loading…" gate
  // rather than pin the app on a blank screen.
  useEffect(() => {
    let mounted = true;
    const BOOT_TIMEOUT_MS = 6000;

    Promise.race([
      sb.auth.getSession(),
      new Promise<null>((r) => setTimeout(() => r(null), BOOT_TIMEOUT_MS)),
    ]).then((got) => {
      if (!mounted) return;
      const s = got?.data.session ?? null;
      // Records the token's real remaining TTL at boot — the single most
      // useful number when someone reports being logged out "after a minute".
      logAuth("BOOT", s, got ? undefined : `getSession() timed out after ${BOOT_TIMEOUT_MS}ms`);
      setSession(s);
    }).finally(() => {
      if (mounted) setAuthLoading(false);
    });

    // Session state is set SYNCHRONOUSLY here, and the profile fetch happens
    // in the effect below. supabase-js invokes this callback while holding the
    // auth lock, so awaiting a PostgREST round-trip inside it deadlocks any
    // concurrent token refresh — that was the real cause of the long-standing
    // "stuck on Loading…" symptom that a no-op lock was once used to paper
    // over.
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      // A mid-session SIGNED_OUT is the whole reason this file was rewritten:
      // it flips the UI straight to the sign-in screen. Distinguish the two
      // causes, because only one of them is a bug.
      if (event === "SIGNED_OUT" && !deliberateSignOut) {
        logAuth(event, s, "UNEXPECTED — not user-initiated; GoTrue dropped the session (refresh failed)");
        setUnexpectedSignOut(true);
      } else {
        logAuth(event, s, event === "SIGNED_OUT" ? "user-initiated" : undefined);
      }
      setSession(s);
      setAuthLoading(false);
    });

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  // Profile fetch, keyed on the user id rather than the session object. A
  // TOKEN_REFRESHED event hands us a brand-new session object for the same
  // user every hour; refetching the profile (plus /api/me) on each one was
  // pure waste.
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId) { setProfile(null); setProfileLoading(false); return; }
    let cancelled = false;
    setProfileLoading(true);
    // Read the session off state at call time — loadProfile only needs the
    // user id and metadata, both stable for a given userId.
    loadProfile(session)
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setProfileLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loadProfile]);

  // Guard against a double-click minting two sessions. Supabase auth logs
  // showed exactly that: two /authorize → two /callback → two sessions 346ms
  // apart for one user. signInWithOAuth navigates the top-level document, so
  // the second call races the first navigation instead of being cancelled by
  // it. A ref (not state) because the guard has to hold within a single tick.
  const signInFlight = useRef(false);
  async function signInWithMicrosoft() {
    if (signInFlight.current) return;
    signInFlight.current = true;
    setSigningIn(true);
    setError(null);
    const { error } = await sb.auth.signInWithOAuth({
      provider: "azure",
      options: {
        scopes: "openid email profile",
        redirectTo: window.location.origin,
      },
    });
    if (error) {
      // Only release the guard on failure — on success the browser is already
      // navigating away and re-enabling the button would just invite a second
      // session.
      signInFlight.current = false;
      setSigningIn(false);
      setError(error.message);
    }
  }

  // scope: 'local' clears THIS browser's session without revoking the user's
  // refresh tokens server-side. The default ('global') revoked every session
  // for the user — so signing out in one tab, or clicking the "Sign out"
  // recovery button on a boot stall, silently killed every other tab, every
  // other device, and the session relayed to the Chrome extension.
  async function signOut() {
    setImpersonate(null);
    deliberateSignOut = true;
    setUnexpectedSignOut(false);
    try {
      await sb.auth.signOut({ scope: "local" });
    } finally {
      // Released on a later tick so the SDK's SIGNED_OUT event — which may
      // arrive after this promise settles — is still attributed correctly.
      setTimeout(() => { deliberateSignOut = false; }, 2000);
      // Local React state and the SWR cache get cleared even if the network
      // call failed — otherwise a signed-out user keeps seeing their data, and
      // the next person on a shared machine sees it too.
      swrClear();
      setSession(null);
      setProfile(null);
    }
  }

  async function refreshProfile() {
    await loadProfile(session);
  }

  // The "effective" profile for the rest of the app — when impersonating,
  // role / enabled reflect the target so admin-only nav hides as you'd expect.
  const effectiveProfile: UserProfile | null = impersonate && profile ? {
    id: impersonate.target.id,
    email: impersonate.target.email,
    fullName: impersonate.target.full_name,
    avatarUrl: impersonate.target.avatar_url,
    role: impersonate.target.role,
    enabled: impersonate.target.enabled,
  } : profile;

  function startImpersonate(s: ImpersonateState) { setImpersonate(s); }
  function stopImpersonate() { setImpersonate(null); }

  const value: AuthState = {
    session,
    profile: effectiveProfile,
    realProfile: profile,
    impersonate,
    clientConfig,
    startImpersonate,
    stopImpersonate,
    // Hold the gate until we know about the session AND (if there is one) its
    // profile has resolved — otherwise the app would flash PendingApproval in
    // the window between the two.
    loading: authLoading || (!!session && profileLoading && !profile),
    error,
    signingIn,
    unexpectedSignOut,
    signInWithMicrosoft,
    signOut,
    refreshProfile,
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
