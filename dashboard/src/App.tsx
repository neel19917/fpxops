import { useEffect, useMemo, useState } from "react";
import { api } from "./lib/api";
import type { ShipmentTask } from "./lib/types";
import { FreightPopOverlay } from "./components/FreightPopOverlay";
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
    openTask: (taskId: string) => navigate(`/tasks/${taskId}`),
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
      {/* Singleton FreightPOP iframe — mounted ONCE here so the user's
          login session survives every route change. Pages drive its
          visibility/context via the freightpopFrame pub/sub store. */}
      <FreightPopOverlay />
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
          <Route path="/tasks/:taskId" element={<TaskWalkRoute />} />
          <Route path="/tasks/:taskId/:section" element={<TaskWalkRoute />} />
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

// /tasks/:taskId — task-walk-through entry point. Hits the database route
// lookup (GET /api/tasks/:id?walk=active) to resolve the focused task to a
// shipment and to get its prev/next sibling task ids for the drawer's
// chevrons. While the lookup is in flight we render a small placeholder.
// On not-found / no-shipment we fall back to /tasks so the URL doesn't dead-end.
function TaskWalkRoute() {
  const { taskId, section } = useParams<{ taskId: string; section?: string }>();
  const navigate = useNavigate();
  const [resolved, setResolved] = useState<{
    task: ShipmentTask;
    shipmentId: string;
    prevTaskId: string | null;
    nextTaskId: string | null;
    index: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the drawer reports a task status change so we refetch the
  // sibling lookup (an in_progress→done transition can pop the task out of
  // the active scope and shift the prev/next pointers).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setResolved(null); setError(null);
    api.tasks.get(taskId, { walk: "active" })
      .then((r) => {
        if (cancelled) return;
        if (!r.task.shipment_id) {
          setError("This task isn't linked to a shipment.");
          return;
        }
        setResolved({
          task: r.task,
          shipmentId: r.task.shipment_id,
          prevTaskId: r.walk?.prev_id || null,
          nextTaskId: r.walk?.next_id || null,
          index: r.walk?.index ?? 0,
          total: r.walk?.total ?? 1,
        });
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [taskId, reloadKey]);

  if (error) {
    return (
      <div className="p-6 max-w-md mx-auto text-sm text-slate-600">
        <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-4 py-3 text-rose-800">{error}</div>
        <button
          onClick={() => navigate("/tasks")}
          className="mt-3 text-sky-700 hover:text-sky-900 hover:underline"
        >← Back to Tasks</button>
      </div>
    );
  }
  if (!resolved || !taskId) {
    return <div className="p-6 text-sm text-slate-400">Loading task…</div>;
  }

  return (
    <ShipmentsPage
      initialShipmentId={resolved.shipmentId}
      drawerSection={section || null}
      onShipmentConsumed={() => { /* URL already has the task id */ }}
      onDrawerChange={(nextId, nextSection) => {
        // Closing the drawer in task-walk mode pops back to the Tasks page.
        if (!nextId) { navigate("/tasks"); return; }
        // Drawer changing the *shipment* id while in task-walk mode would
        // sever the task↔shipment link, so push to /tracking instead.
        if (nextId !== resolved.shipmentId) {
          navigate(nextSection ? `/tracking/${nextId}/${nextSection}` : `/tracking/${nextId}`);
          return;
        }
        // Same shipment — only the section changed.
        if (nextSection) navigate(`/tasks/${taskId}/${nextSection}`);
        else navigate(`/tasks/${taskId}`);
      }}
      taskWalk={{
        taskId,
        task: resolved.task,
        prevTaskId: resolved.prevTaskId,
        nextTaskId: resolved.nextTaskId,
        index: resolved.index,
        total: resolved.total,
        onWalk: (nextTaskId) => navigate(section ? `/tasks/${nextTaskId}/${section}` : `/tasks/${nextTaskId}`),
        onTaskStatusChanged: () => setReloadKey((k) => k + 1),
      }}
    />
  );
}

// Re-export Outlet to keep TS happy if other modules pull it in later.
export { Outlet };
