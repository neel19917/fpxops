import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, Home, LogIn, LogOut, RotateCw, AlertTriangle } from "lucide-react";
import { HostedFreightPop, type HostedFreightPopHandle } from "../components/HostedFreightPop";
import { hostedBrowser, type HostedBrowserStatus } from "../lib/hostedBrowser";
import { fmtRelative } from "../lib/format";

// "FreightPOP login": a full-size view of the user's own hosted FreightPOP
// browser, so they can sign in (or fix a stuck page) without opening a
// shipment first. Each person has their own browser and login.

const DASHBOARD_URL = "https://app.freightpop.com/Broker/Broker.html#!/Dashboard";

export function FreightPopLoginPage() {
  const viewer = useRef<HostedFreightPopHandle | null>(null);
  const [status, setStatus] = useState<HostedBrowserStatus | null>(null);
  const [url, setUrl] = useState("");
  const [viewerKey, setViewerKey] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const refresh = useCallback(() => {
    hostedBrowser.me().then((r) => setStatus(r.browser)).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function resetLogin() {
    if (!confirm("Sign out of FreightPOP in your hosted browser and start over?\n\nYour saved FreightPOP login is deleted and the view reloads on the sign-in page.")) return;
    setResetting(true); setMsg(null);
    try {
      await hostedBrowser.resetLogin();
      setMsg({ tone: "ok", text: "Signed out. Sign in to FreightPOP below." });
      setViewerKey((k) => k + 1);
      refresh();
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setResetting(false); }
  }

  if (!hostedBrowser.enabled) {
    return <div className="text-sm text-slate-500">This dashboard isn't connected to a hosted browser (VITE_FPX_BROWSER_URL).</div>;
  }

  // Signed in = cookies saved AND the last FreightPOP page wasn't a login page.
  // The live URL wins over the saved state while the view is open.
  const onLoginPage = /#\/login|\/login\b|\/Account\/Login/i.test(url);
  const signedIn = url ? (!onLoginPage && /freightpop\.com/i.test(url)) : !!(status?.hasProfile && status?.freightpop?.loggedIn);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <LogIn className="h-5 w-5 text-violet-600" /> FreightPOP login
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Your own FreightPOP browser inside FPX. Sign in here once; shipment lookups, “Load in FreightPOP” and Refresh All use this login.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {signedIn ? (
            <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
              <CheckCircle2 className="h-4 w-4" /> Signed in
              {status?.freightpop?.at ? <span className="text-xs text-emerald-600/80">· {fmtRelative(status.freightpop.at)}</span> : null}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full bg-amber-50 text-amber-800 ring-1 ring-amber-200">
              <AlertTriangle className="h-4 w-4" /> Not signed in
            </span>
          )}
          <button onClick={resetLogin} disabled={resetting || !!status?.busy}
            title={status?.busy ? "A scrape is running in your browser" : "Sign out and delete your saved FreightPOP login"}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-rose-200 text-rose-700 bg-white hover:bg-rose-50 disabled:opacity-50">
            <LogOut className="h-4 w-4" /> {resetting ? "Resetting…" : "Reset my login"}
          </button>
        </div>
      </div>

      {msg ? (
        <div className={"rounded-xl p-3 text-sm ring-1 " + (msg.tone === "ok" ? "bg-emerald-50 ring-emerald-200 text-emerald-800" : "bg-rose-50 ring-rose-200 text-rose-800")}>{msg.text}</div>
      ) : null}

      {!signedIn ? (
        <ol className="rounded-xl bg-violet-50 ring-1 ring-violet-200 p-3 text-sm text-violet-900 list-decimal list-inside space-y-0.5">
          <li>No sign-in form below? Click <b>Go to FreightPOP dashboard</b> — if you're signed out, FreightPOP shows its sign-in form.</li>
          <li>Click into the FreightPOP email field and type (or paste with Ctrl/⌘+V) your FreightPOP email and password.</li>
          <li>Sign in. You should land on the FreightPOP dashboard with the shipment grid.</li>
          <li>Blank, “Loading…” or “404” page? Click <b>Go to FreightPOP dashboard</b>. Still stuck? <b>Reset my login</b> and sign in again.</li>
        </ol>
      ) : null}

      <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm overflow-hidden flex flex-col" style={{ height: "max(520px, calc(100vh - 290px))" }}>
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-200 bg-slate-50">
          <NavBtn title="Back" onClick={() => viewer.current?.nav("back")}><ArrowLeft className="h-4 w-4" /></NavBtn>
          <NavBtn title="Forward" onClick={() => viewer.current?.nav("forward")}><ArrowRight className="h-4 w-4" /></NavBtn>
          <NavBtn title="Reload" onClick={() => viewer.current?.nav("reload")}><RotateCw className="h-4 w-4" /></NavBtn>
          <button onClick={() => viewer.current?.navigate(DASHBOARD_URL)}
            className="ml-1 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ring-1 ring-slate-200 bg-white hover:bg-slate-100">
            <Home className="h-3.5 w-3.5" /> Go to FreightPOP dashboard
          </button>
          <div className="ml-2 flex-1 min-w-0 truncate text-xs text-slate-500 font-mono" title={url}>{url || "…"}</div>
          <a href={DASHBOARD_URL} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 px-2">
            <ExternalLink className="h-3.5 w-3.5" /> Open in a normal tab
          </a>
        </div>
        <div className="flex-1 min-h-0">
          <HostedFreightPop key={viewerKey} ref={viewer} onUrl={setUrl} />
        </div>
      </div>
    </div>
  );
}

function NavBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="p-1.5 rounded-md text-slate-600 hover:bg-slate-200">{children}</button>
  );
}
