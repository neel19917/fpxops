import { useState } from "react";
import { KeyRound, Server } from "lucide-react";
import { loadAuth, saveAuth } from "../lib/api";

interface Props {
  onDone: () => void;
}

export function SetupDialog({ onDone }: Props) {
  const existing = loadAuth();
  const [url, setUrl] = useState(existing.url);
  const [key, setKey] = useState(existing.key);
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setErr(null); setBusy(true);
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (!r.ok) throw new Error(`Health check failed: ${r.status}`);
      const data = await r.json();
      if (!data?.ok) throw new Error("Server responded but health is not ok");
    } catch (e) {
      setErr((e as Error).message); setBusy(false); return;
    }
    saveAuth({ url: url.replace(/\/$/, ""), key: key.trim() });
    setBusy(false); onDone();
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="h-10 w-10 rounded-xl bg-sky-100 text-sky-600 flex items-center justify-center">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Connect to FPX API</h1>
            <p className="text-sm text-slate-500">Enter the Railway URL and an API key issued by the server.</p>
          </div>
        </div>

        <label className="block">
          <span className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1.5">
            <Server className="h-4 w-4" /> API URL
          </span>
          <input
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
            placeholder="https://your-app.up.railway.app"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        <label className="block mt-4">
          <span className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1.5">
            <KeyRound className="h-4 w-4" /> API Key
          </span>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-sky-400 focus:border-sky-400"
              placeholder="fpx_live_..."
              type={show ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              className="px-3 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
              onClick={() => setShow(!show)}
              type="button"
            >
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        {err ? <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{err}</div> : null}

        <div className="mt-6 flex gap-2 justify-end">
          <button
            className="px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
            disabled={busy || !url || !key}
            onClick={test}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-4">
          Keys are stored in this browser only. Revoke any time from the API Keys tab.
        </p>
      </div>
    </div>
  );
}
