import { useEffect, useState } from "react";
import { Download, Puzzle, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

// Served from public/downloads/, generated at build time by
// scripts/package-extension.mjs from ../extension — so the download always
// matches the deployed commit.
const ZIP_URL = "/downloads/FPXpress-extension.zip";
const META_URL = "/downloads/extension.json";

interface ExtensionMeta {
  version: string;
  name: string;
  builtAt: string;
  bytes: number;
  sha256: string;
  files: number;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4 border-t first:border-t-0 border-slate-100 px-5 py-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white text-sm font-semibold">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-900">{title}</div>
        <div className="mt-1 text-sm text-slate-600 space-y-1.5">{children}</div>
      </div>
    </li>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[13px] text-slate-800">{children}</code>;
}

export function InstallPage() {
  const [meta, setMeta] = useState<ExtensionMeta | null>(null);
  const [metaError, setMetaError] = useState(false);

  useEffect(() => {
    // no-store: after a deploy the version badge should reflect the new build,
    // not a cached extension.json from the last one.
    fetch(META_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: ExtensionMeta) => setMeta(m))
      .catch(() => setMetaError(true));
  }, []);

  const built = meta ? new Date(meta.builtAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Puzzle className="h-6 w-6 text-slate-700" /> Install the extension</h1>
        <p className="text-sm text-slate-500 mt-0.5">The FPXpress Chrome extension runs refreshes and audits inside app.freightpop.com. Setup takes about 2 minutes.</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-medium text-slate-900">{meta?.name || "FPXpress Tracking Refresh"}</div>
          <div className="text-sm text-slate-500">
            {meta ? <>Version {meta.version} · built {built} · {(meta.bytes / 1024).toFixed(0)} KB</> : metaError ? "Version info unavailable" : "Loading version…"}
          </div>
        </div>
        <a
          href={ZIP_URL}
          download={meta ? `FPXpress-extension-${meta.version}.zip` : "FPXpress-extension.zip"}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2.5 flex items-center gap-2 hover:bg-slate-800"
        >
          <Download className="h-4 w-4" /> Download extension
        </a>
      </div>

      <h2 className="text-lg font-semibold mb-3">First-time setup</h2>
      <ol className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-6">
        <Step n={1} title="Unzip to a permanent folder">
          <p>Unzip the download. You'll get a folder named <Kbd>FPXpress</Kbd>. Move it somewhere it won't be deleted, such as <Kbd>Documents/FPXpress</Kbd>.</p>
          <p className="text-amber-700">Chrome loads the extension from this folder every time it starts. If you delete or move the folder, the extension stops working.</p>
        </Step>
        <Step n={2} title="Open Chrome's extensions page">
          <p>Type <Kbd>chrome://extensions</Kbd> in the address bar and press Enter.</p>
        </Step>
        <Step n={3} title="Turn on Developer mode">
          <p>Use the <strong>Developer mode</strong> toggle in the top-right corner of that page.</p>
        </Step>
        <Step n={4} title="Load unpacked">
          <p>Click <strong>Load unpacked</strong> and select the <Kbd>FPXpress</Kbd> folder. Select the folder itself, not a file inside it.</p>
          <p>"FPXpress Tracking Refresh" now appears in the list.</p>
        </Step>
        <Step n={5} title="Pin it to your toolbar">
          <p>Click the puzzle-piece icon next to the address bar, then the pin beside <strong>FPXpress</strong>.</p>
        </Step>
        <Step n={6} title="Sign in with Microsoft">
          <p>Click the FPXpress icon, then <strong>Sign in with Microsoft</strong>. Use your @freightpop.com account.</p>
          <p>If the popup sign-in fails, click <strong>Sign in via the dashboard instead</strong> in the same popup. A dashboard tab opens and passes your sign-in back to the extension.</p>
        </Step>
        <Step n={7} title="Check it's connected">
          <p>The popup should show a green status for the API. If it says <strong>Awaiting admin approval</strong>, ask an admin to enable your account under Admin → Users.</p>
        </Step>
      </ol>

      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><RefreshCw className="h-5 w-5 text-slate-600" /> Updating to a new version</h2>
      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6 text-sm text-slate-600 space-y-1.5">
        <p>1. Download the latest zip from this page.</p>
        <p>2. Unzip it and <strong>replace the contents</strong> of your existing <Kbd>FPXpress</Kbd> folder. Keep the same folder location.</p>
        <p>3. Go to <Kbd>chrome://extensions</Kbd> and click the reload icon (↻) on FPXpress.</p>
        <p>Your sign-in and settings are kept, because Chrome ties them to the folder location.</p>
      </div>

      <h2 className="text-lg font-semibold mb-3">Daily use</h2>
      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6 text-sm text-slate-600 flex gap-3">
        <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
        <p>Open <a className="text-sky-700 underline" href="https://app.freightpop.com" target="_blank" rel="noreferrer">app.freightpop.com</a>, open the FPXpress side panel, and run a refresh or audit. Results appear on this dashboard within seconds.</p>
      </div>

      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-600" /> Troubleshooting</h2>
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden text-sm">
        <table className="w-full">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr><th className="px-5 py-2 font-medium">Problem</th><th className="px-5 py-2 font-medium">Fix</th></tr>
          </thead>
          <tbody className="text-slate-700">
            <tr className="border-t border-slate-100"><td className="px-5 py-3 align-top">"Manifest file is missing or unreadable"</td><td className="px-5 py-3">You selected the wrong folder. Pick the <Kbd>FPXpress</Kbd> folder that contains <Kbd>manifest.json</Kbd>.</td></tr>
            <tr className="border-t border-slate-100"><td className="px-5 py-3 align-top">Popup sign-in closes or errors</td><td className="px-5 py-3">Use <strong>Sign in via the dashboard instead</strong> in the popup.</td></tr>
            <tr className="border-t border-slate-100"><td className="px-5 py-3 align-top">Awaiting admin approval</td><td className="px-5 py-3">An admin has to enable your account under Admin → Users.</td></tr>
            <tr className="border-t border-slate-100"><td className="px-5 py-3 align-top">API shows offline</td><td className="px-5 py-3">The server may be restarting. Wait a minute, then reopen the popup. If it stays offline, post in Feedback.</td></tr>
            <tr className="border-t border-slate-100"><td className="px-5 py-3 align-top">Chrome warns about developer-mode extensions</td><td className="px-5 py-3">This is expected for internal extensions. Click <strong>Keep</strong> or dismiss the warning.</td></tr>
            <tr className="border-t border-slate-100"><td className="px-5 py-3 align-top">Extension vanished after restart</td><td className="px-5 py-3">The folder was moved or deleted. Unzip again to a permanent spot and repeat Load unpacked.</td></tr>
          </tbody>
        </table>
      </div>

      {meta ? <p className="mt-4 text-xs text-slate-400 break-all">SHA-256 {meta.sha256}</p> : null}
    </div>
  );
}
