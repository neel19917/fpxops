import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { sb } from "./supabase";
import type { Session } from "@supabase/supabase-js";
import { getImpersonate, setImpersonate, subscribeImpersonate, type ImpersonateState } from "./impersonate";

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
  }

  useEffect(() => {
    let mounted = true;
    sb.auth.getSession().then(async ({ data }) => {
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
