import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { sb } from "./supabase";
import type { Session } from "@supabase/supabase-js";
import { getImpersonate, setImpersonate, subscribeImpersonate, type ImpersonateState } from "./impersonate";
import { api, type ClientConfig } from "./api";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [impersonate, setImpersonateState] = useState<ImpersonateState | null>(() => getImpersonate());
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);

  useEffect(() => subscribeImpersonate(setImpersonateState), []);

  async function loadProfile(sess: Session | null) {
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
  }

  // Boot path is the cause of the long-standing "click refresh twice" bug.
  // sb.auth.getSession() returns whatever's cached in localStorage, which is
  // sometimes a session whose access_token has already expired but whose
  // refresh_token is still good. The first profile lookup (and every API
  // call after) goes out with the stale token and 401s. The user reloads;
  // by then the SDK's autoRefresh has rotated → second load works.
  //
  // Fix: if the cached token is within 60s of expiry (or already past),
  // call refreshSession() before doing anything that depends on it.
  // Keeps the boot path single-loop without a 401 detour.
  async function bootSession(): Promise<{ session: Session | null }> {
    const REFRESH_SKEW_S = 60;
    const { data } = await sb.auth.getSession();
    const sess = data.session;
    if (!sess) return { session: null };
    const exp = sess.expires_at;
    const stale = exp ? Date.now() / 1000 > exp - REFRESH_SKEW_S : false;
    if (!stale || !sess.refresh_token) return { session: sess };
    try {
      const { data: refreshed, error } = await sb.auth.refreshSession();
      if (!error && refreshed.session) return { session: refreshed.session };
    } catch { /* fall through with the stale session */ }
    return { session: sess };
  }

  useEffect(() => {
    let mounted = true;
    bootSession().then(async (data) => {
      if (!mounted) return;
      setSession(data.session);
      try { await loadProfile(data.session); } catch (e) { setError((e as Error).message); }
      finally { if (mounted) setLoading(false); }
    });
    const { data: sub } = sb.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      try { await loadProfile(s); } catch (e) { setError((e as Error).message); }
      finally { setLoading(false); }
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  async function signInWithMicrosoft() {
    setError(null);
    const { error } = await sb.auth.signInWithOAuth({
      provider: "azure",
      options: {
        scopes: "openid email profile",
        redirectTo: window.location.origin,
      },
    });
    if (error) setError(error.message);
  }

  async function signOut() {
    setImpersonate(null);
    await sb.auth.signOut();
    setSession(null);
    setProfile(null);
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
    loading,
    error,
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
