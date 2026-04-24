import { useEffect, useState } from "react";
import { Layout, type TabId } from "./components/Layout";
import { AuthProvider, useAuth } from "./lib/auth";
import { SignInPage } from "./pages/SignIn";
import { PendingApprovalPage } from "./pages/PendingApproval";
import { ShipmentsPage } from "./pages/Shipments";
import { AnalysesPage } from "./pages/Analyses";
import { GpAuditsPage, InvoiceAuditsPage } from "./pages/Audits";
import { ApiKeysPage } from "./pages/ApiKeys";
import { UsersPage } from "./pages/Users";
import { ShareLinksPage } from "./pages/ShareLinks";
import { SharedViewPage } from "./pages/SharedView";

export default function App() {
  // Public share viewer bypasses all auth. Path-based match so the same Netlify
  // SPA redirect handles everything.
  const shareMatch = typeof window !== "undefined"
    ? window.location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)\/?$/)
    : null;
  if (shareMatch) return <SharedViewPage token={shareMatch[1]} />;

  return (
    <AuthProvider>
      <AuthedApp />
    </AuthProvider>
  );
}

function AuthedApp() {
  const { session, profile, loading } = useAuth();
  const [tab, setTab] = useState<TabId>("shipments");

  // On successful OAuth callback Supabase puts a hash fragment in the URL;
  // clear it once the session is ready so refreshes don't re-process it.
  useEffect(() => {
    if (session && window.location.hash.startsWith("#access_token")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [session]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm">
        Loading…
      </div>
    );
  }
  if (!session) return <SignInPage />;
  if (!profile?.enabled) return <PendingApprovalPage />;

  const isAdmin = profile.role === "admin";
  const safeTab: TabId = ((tab === "users" || tab === "keys") && !isAdmin) ? "shipments" : tab;

  return (
    <Layout tab={safeTab} onTab={setTab}>
      {safeTab === "shipments" && <ShipmentsPage />}
      {safeTab === "analyses" && <AnalysesPage />}
      {safeTab === "gp"       && <GpAuditsPage />}
      {safeTab === "invoice"  && <InvoiceAuditsPage />}
      {safeTab === "shares"   && <ShareLinksPage />}
      {safeTab === "users"    && isAdmin && <UsersPage />}
      {safeTab === "keys"     && isAdmin && <ApiKeysPage />}
    </Layout>
  );
}
