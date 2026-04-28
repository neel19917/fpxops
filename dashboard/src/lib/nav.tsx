import { createContext, useContext } from "react";

// Cross-page navigation primitives. Pages call these to switch tabs or pop
// open the shipment drawer from elsewhere (e.g. clicking a row on the AI
// Analyses page to inspect the shipment it was about).
export interface NavApi {
  setTab: (t: string) => void;
  openShipment: (shipmentId: string) => void;
  // Task-walk entry: opens the drawer in task-walk mode at /tasks/:taskId.
  // The drawer's prev/next chevrons step through the task list (resolved
  // server-side via /api/tasks/:id?walk=active).
  openTask: (taskId: string) => void;
}

export const NavCtx = createContext<NavApi | null>(null);

export function useNav(): NavApi {
  const ctx = useContext(NavCtx);
  if (!ctx) throw new Error("useNav must be used inside NavCtx.Provider");
  return ctx;
}
