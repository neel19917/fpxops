import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { sb } from "./supabase";
import type { Session } from "@supabase/supabase-js";

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
      await loadProfile(data.session);
      setLoading(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      await loadProfile(s);
      setLoading(false);
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
    await sb.auth.signOut();
    setSession(null);
    setProfile(null);
  }

  async function refreshProfile() {
    await loadProfile(session);
  }

  const value: AuthState = { session, profile, loading, error, signInWithMicrosoft, signOut, refreshProfile };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
