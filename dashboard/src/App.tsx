import { useEffect, useMemo, useState } from "react";
import { Layout, type TabId } from "./components/Layout";
import { AuthProvider, useAuth } from "./lib/auth";
import { NavCtx, type NavApi } from "./lib/nav";
import { SignInPage } from "./pages/SignIn";
import { PendingApprovalPage } from "./pages/PendingApproval";
import { ShipmentsPage } from "./pages/Shipments";
import { AnalysesPage } from "./pages/Analyses";
import { GpAuditsPage, InvoiceAuditsPage } from "./pages/Audits";
import { ApiKeysPage } from "./pages/ApiKeys";
import { UsersPage } from "./pages/Users";
import { ShareLinksPage } from "./pages/ShareLinks";
import { SharedViewPage } from "./pages/SharedView";
import { TasksPage } from "./pages/Tasks";
import { FeedbackPage } from "./pages/Feedback";
import { AuditLogPage } from "./pages/AuditLog";

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
  const [tab, setTab] = useState<TabId>("tracking");
  // When a non-tracking page asks to open a shipment drawer, stash the id here.
  // ShipmentsPage consumes it on next mount/render and clears it back.
  const [pendingShipmentId, setPendingShipmentId] = useState<string | null>(null);
  const nav: NavApi = useMemo(() => ({
    setTab: (t) => setTab(t as TabId),
    openShipment: (id: string) => { setPendingShipmentId(id); setTab("tracking"); },
  }), []);

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
  const adminOnlyTabs: TabId[] = ["users", "keys", "audit"];
  const safeTab: TabId = (adminOnlyTabs.includes(tab) && !isAdmin) ? "tracking" : tab;

  return (
    <NavCtx.Provider value={nav}>
      <Layout tab={safeTab} onTab={setTab}>
        {safeTab === "tracking" && (
          <ShipmentsPage
            initialShipmentId={pendingShipmentId}
            onShipmentConsumed={() => setPendingShipmentId(null)}
          />
        )}
        {safeTab === "tasks"    && <TasksPage />}
        {safeTab === "analyses" && <AnalysesPage />}
        {safeTab === "gp"       && <GpAuditsPage />}
        {safeTab === "invoice"  && <InvoiceAuditsPage />}
        {safeTab === "shares"   && <ShareLinksPage />}
        {safeTab === "feedback" && <FeedbackPage />}
        {safeTab === "users"    && isAdmin && <UsersPage />}
        {safeTab === "keys"     && isAdmin && <ApiKeysPage />}
        {safeTab === "audit"    && isAdmin && <AuditLogPage />}
      </Layout>
    </NavCtx.Provider>
  );
}
