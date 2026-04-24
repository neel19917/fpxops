import { useEffect, useState } from "react";
import { Layout, type TabId } from "./components/Layout";
import { SetupDialog } from "./components/SetupDialog";
import { ShipmentsPage } from "./pages/Shipments";
import { AnalysesPage } from "./pages/Analyses";
import { GpAuditsPage, InvoiceAuditsPage } from "./pages/Audits";
import { ApiKeysPage } from "./pages/ApiKeys";
import { api, clearAuth, loadAuth } from "./lib/api";

export default function App() {
  const [authed, setAuthed] = useState(() => {
    const a = loadAuth();
    return Boolean(a.url && a.key);
  });
  const [tab, setTab] = useState<TabId>("shipments");
  const [server, setServer] = useState<{ online: boolean; uptime?: number } | null>(null);

  useEffect(() => {
    if (!authed) return;
    api.health()
      .then((d) => setServer({ online: true, uptime: d.uptime }))
      .catch(() => setServer({ online: false }));
  }, [authed, tab]);

  if (!authed) return <SetupDialog onDone={() => setAuthed(true)} />;

  return (
    <Layout
      tab={tab}
      onTab={setTab}
      serverStatus={server}
      onDisconnect={() => { clearAuth(); setAuthed(false); }}
    >
      {tab === "shipments" && <ShipmentsPage />}
      {tab === "analyses" && <AnalysesPage />}
      {tab === "gp" && <GpAuditsPage />}
      {tab === "invoice" && <InvoiceAuditsPage />}
      {tab === "keys" && <ApiKeysPage />}
    </Layout>
  );
}
