import { useEffect, useMemo } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useParams, Outlet } from "react-router-dom";
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
import { SettingsPage } from "./pages/Settings";

// Map a tab id to its route. Drawer sub-routes live under /tracking/:id/:section.
const TAB_PATH: Record<TabId, string> = {
  tracking: "/tracking",
  tasks: "/tasks",
  analyses: "/analyses",
  gp: "/audits/gp",
  invoice: "/audits/invoice",
  shares: "/shares",
  feedback: "/feedback",
  users: "/admin/users",
  keys: "/admin/keys",
  audit: "/admin/audit",
  settings: "/admin/settings",
};

const ADMIN_TABS = new Set<TabId>(["users", "keys", "audit", "settings"]);

// Resolve the active tab from the current pathname. Order matters: longer
// prefixes win so /audits/gp doesn't get matched by a stray /audits handler.
function pathToTab(pathname: string): TabId {
  if (pathname.startsWith("/admin/users")) return "users";
  if (pathname.startsWith("/admin/keys")) return "keys";
  if (pathname.startsWith("/admin/audit")) return "audit";
  if (pathname.startsWith("/admin/settings")) return "settings";
  if (pathname.startsWith("/audits/gp")) return "gp";
  if (pathname.startsWith("/audits/invoice")) return "invoice";
  if (pathname.startsWith("/tasks")) return "tasks";
  if (pathname.startsWith("/analyses")) return "analyses";
  if (pathname.startsWith("/shares")) return "shares";
  if (pathname.startsWith("/feedback")) return "feedback";
  return "tracking";
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public share viewer bypasses all auth. */}
          <Route path="/share/:token" element={<SharedViewRoute />} />
          <Route path="/*" element={<AuthedApp />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function SharedViewRoute() {
  const { token = "" } = useParams<{ token: string }>();
  return <SharedViewPage token={token} />;
}

function AuthedApp() {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Clear Supabase's OAuth hash fragment once we're signed in.
  useEffect(() => {
    if (session && window.location.hash.startsWith("#access_token")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [session]);

  const nav: NavApi = useMemo(() => ({
    setTab: (t) => {
      const path = TAB_PATH[t as TabId];
      if (path) navigate(path);
    },
    openShipment: (id: string) => navigate(`/tracking/${id}`),
  }), [navigate]);

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
  const tab = pathToTab(location.pathname);

  // Defense against URL-bar admin probes.
  if (ADMIN_TABS.has(tab) && !isAdmin) {
    return <Navigate to="/tracking" replace />;
  }

  return (
    <NavCtx.Provider value={nav}>
      <Layout
        tab={tab}
        onTab={(t) => navigate(TAB_PATH[t])}
      >
        <Routes>
          <Route path="/" element={<Navigate to="/tracking" replace />} />
          <Route path="/tracking" element={<ShipmentsRoute />} />
          <Route path="/tracking/:id" element={<ShipmentsRoute />} />
          <Route path="/tracking/:id/:section" element={<ShipmentsRoute />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/analyses" element={<AnalysesPage />} />
          <Route path="/audits/gp" element={<GpAuditsPage />} />
          <Route path="/audits/invoice" element={<InvoiceAuditsPage />} />
          <Route path="/shares" element={<ShareLinksPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          {isAdmin ? (
            <>
              <Route path="/admin/users" element={<UsersPage />} />
              <Route path="/admin/keys" element={<ApiKeysPage />} />
              <Route path="/admin/audit" element={<AuditLogPage />} />
              <Route path="/admin/settings" element={<SettingsPage />} />
            </>
          ) : null}
          <Route path="*" element={<Navigate to="/tracking" replace />} />
        </Routes>
      </Layout>
    </NavCtx.Provider>
  );
}

// ShipmentsPage already accepts initialShipmentId + onShipmentConsumed for
// cross-page drawer opening. Adapt the route params to that interface and let
// the page push URL changes via the nav helpers it gets through props.
function ShipmentsRoute() {
  const { id, section } = useParams<{ id?: string; section?: string }>();
  const navigate = useNavigate();
  return (
    <ShipmentsPage
      initialShipmentId={id || null}
      drawerSection={section || null}
      onShipmentConsumed={() => { /* route already reflects the open drawer */ }}
      onDrawerChange={(nextId, nextSection) => {
        if (!nextId) {
          navigate("/tracking");
        } else if (nextSection) {
          navigate(`/tracking/${nextId}/${nextSection}`);
        } else {
          navigate(`/tracking/${nextId}`);
        }
      }}
    />
  );
}

// Re-export Outlet to keep TS happy if other modules pull it in later.
export { Outlet };
