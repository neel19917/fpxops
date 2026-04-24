import { useState } from "react";
import { Link2, Copy, Check } from "lucide-react";
import { api } from "../lib/api";
import type { ShareLink } from "../lib/types";

interface Props {
  resourceType: ShareLink["resource_type"];
  resourceId: string;
  defaultLabel?: string;
}

export function ShareButton({ resourceType, resourceId, defaultLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(defaultLabel || "");
  const [expires, setExpires] = useState<number | "">(30);
  const [password, setPassword] = useState("");
  const [link, setLink] = useState<ShareLink | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true); setErr(null);
    try {
      const { link } = await api.shareLinks.create({
        resource_type: resourceType,
        resource_id: resourceId,
        label: label || undefined,
        expires_in_days: typeof expires === "number" ? expires : undefined,
        password: password || undefined,
      });
      setLink(link);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  function reset() {
    setOpen(false); setLink(null); setCopied(false); setErr(null); setPassword("");
  }

  const url = link ? `${window.location.origin}/share/${link.token}` : "";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
      >
        <Link2 className="h-4 w-4" /> Share
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur flex items-center justify-center p-4" onClick={reset}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            {!link ? (
              <>
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><Link2 className="h-5 w-5 text-sky-600" /> Share</h2>
                <label className="block text-sm font-medium text-slate-700">Label (optional)</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder={`${resourceType} — for customer Acme`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <label className="block text-sm font-medium text-slate-700 mt-4">Expires in (days)</label>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value === "" ? "" : Number(e.target.value))}
                >
                  <option value={1}>1 day</option>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value="">Never</option>
                </select>
                <label className="block text-sm font-medium text-slate-700 mt-4">Password (optional)</label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Leave blank for no password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {err ? <div className="mt-3 text-sm text-rose-600">{err}</div> : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button onClick={reset} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
                  <button
                    onClick={create}
                    disabled={busy}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    {busy ? "Creating…" : "Create link"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold mb-1">Link ready</h2>
                <p className="text-sm text-slate-500 mb-4">Copy and send. Every view is logged.</p>
                <div className="flex gap-2">
                  <code className="flex-1 bg-slate-50 ring-1 ring-slate-200 text-xs p-3 rounded-lg break-all">{url}</code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                    className="p-3 rounded-lg bg-slate-900 text-white hover:bg-slate-800"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
                <div className="mt-5 flex justify-end">
                  <button onClick={reset} className="px-4 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800">Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
