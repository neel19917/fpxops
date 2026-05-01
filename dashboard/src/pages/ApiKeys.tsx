import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Copy, Download, Shield, ShieldAlert } from "lucide-react";
import { api, apiUrl } from "../lib/api";
import { fmtDateTime, fmtRelative } from "../lib/format";
import type { ApiKey } from "../lib/types";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";

// Build a config.js the teammate can drop straight into extension/config.js,
// matching the shape extension/config.example.js expects.
function buildExtensionConfig(name: string, plaintext: string): string {
  const generated = new Date().toISOString();
  return [
    "// FPXpress extension config — drop this file into extension/config.js",
    `// Generated ${generated} for "${name}"`,
    "// Treat this file like a password — it grants API access.",
    "",
    `const FPX_API_URL = ${JSON.stringify(apiUrl)};`,
    `const FPX_API_KEY = ${JSON.stringify(plaintext)};`,
    "",
  ].join("\n");
}

function downloadFile(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function safeFilename(name: string, ext: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "fpxpress";
  return `${base}.${ext}`;
}

export function ApiKeysPage() {
  const [rows, setRows] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>(["read", "write"]);
  const [justCreated, setJustCreated] = useState<{ plaintext: string; name: string } | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.apiKeys.list();
      setRows(r.data);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!newName.trim()) return;
    try {
      const r = await api.apiKeys.create(newName.trim(), newScopes);
      setJustCreated({ plaintext: r.plaintext, name: r.key.name });
      setCreating(false); setNewName("");
      load();
    } catch (e) { alert((e as Error).message); }
  }

  async function revoke(id: string, name: string) {
    if (!confirm(`Revoke key "${name}"? This cannot be undone — anything using it will stop working immediately.`)) return;
    try {
      await api.apiKeys.revoke(id);
      load();
    } catch (e) { alert((e as Error).message); }
  }

  const active = rows.filter((r) => !r.revoked_at);
  const revoked = rows.filter((r) => r.revoked_at);

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2"><KeyRound className="h-5 w-5 text-sky-600" /> API keys</h2>
            <p className="text-sm text-slate-500 mt-0.5">Issue keys for the Chrome extension and dashboard. Revoke anytime.</p>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="px-3 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" /> New key
          </button>
        </div>

        {err ? <div className="mx-5 mt-4"><ErrorBlock compact>{err} — only admin-scoped keys can list other keys.</ErrorBlock></div> : null}

        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Prefix</th>
                <th className="px-5 py-2.5 font-medium">Scopes</th>
                <th className="px-5 py-2.5 font-medium">Last used</th>
                <th className="px-5 py-2.5 font-medium">Created</th>
                <th className="px-5 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? <LoadingState variant="row" colSpan={6} />
                : active.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-slate-500">No active keys yet.</td></tr>
                  : active.map((k) => (
                    <tr key={k.id}>
                      <td className="px-5 py-3 font-medium">{k.name}</td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-500">{k.key_prefix}…</td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <span key={s} className={
                              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 " +
                              (s === "admin" ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-slate-100 text-slate-700 ring-slate-200")
                            }>
                              {s === "admin" ? <ShieldAlert className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-slate-500">{fmtRelative(k.last_used_at)}</td>
                      <td className="px-5 py-3 text-slate-500">{fmtDateTime(k.created_at)}</td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => revoke(k.id, k.name)}
                          className="inline-flex items-center gap-1 text-sm text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg px-2 py-1"
                        >
                          <Trash2 className="h-4 w-4" /> Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>

      {revoked.length > 0 && (
        <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm">
          <div className="p-5 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700">Revoked ({revoked.length})</h3>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {revoked.map((k) => (
                <tr key={k.id} className="text-slate-500">
                  <td className="px-5 py-2.5">{k.name}</td>
                  <td className="px-5 py-2.5 font-mono text-xs">{k.key_prefix}…</td>
                  <td className="px-5 py-2.5">revoked {fmtRelative(k.revoked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <h2 className="text-lg font-semibold mb-4">Create API key</h2>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Name</span>
              <input
                autoFocus
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                placeholder="e.g. Chrome extension · Neel"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <div className="mt-4">
              <span className="text-sm font-medium text-slate-700">Scopes</span>
              <div className="flex gap-2 mt-2">
                {["read", "write", "admin"].map((s) => {
                  const on = newScopes.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setNewScopes(on ? newScopes.filter((x) => x !== s) : [...newScopes, s])}
                      className={
                        "px-3 py-1.5 rounded-full text-sm font-medium ring-1 " +
                        (on ? "bg-sky-50 text-sky-700 ring-sky-200" : "bg-white text-slate-500 ring-slate-200")
                      }
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                <b>read</b> = dashboard viewing · <b>write</b> = extension uploads · <b>admin</b> = manage keys
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="px-4 py-2 text-sm font-medium rounded-lg text-slate-600 hover:bg-slate-100">Cancel</button>
              <button
                onClick={create}
                disabled={!newName.trim() || newScopes.length === 0}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {justCreated && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6">
            <h2 className="text-lg font-semibold">Save this key now</h2>
            <p className="text-sm text-slate-500 mt-1">
              This is the only time <b>{justCreated.name}</b>'s plaintext key will be shown.
              Download a config file for the teammate's extension, or copy and paste it manually.
            </p>
            <div className="mt-4 flex gap-2">
              <code className="flex-1 bg-slate-900 text-slate-100 font-mono text-sm p-3 rounded-lg break-all">{justCreated.plaintext}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(justCreated.plaintext); }}
                className="px-3 py-3 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700"
                title="Copy to clipboard"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 rounded-xl bg-sky-50 ring-1 ring-sky-200 p-4">
              <div className="flex items-start gap-3">
                <Download className="h-5 w-5 text-sky-700 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-sky-900">Download credentials file</div>
                  <p className="text-xs text-sky-800 mt-0.5">
                    Drops straight into <code className="font-mono bg-white/60 px-1 rounded">extension/config.js</code> — the teammate just replaces the file and reloads the extension.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => downloadFile(
                        safeFilename(justCreated.name, "config.js"),
                        buildExtensionConfig(justCreated.name, justCreated.plaintext),
                        "application/javascript",
                      )}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-sky-600 text-white hover:bg-sky-700"
                    >
                      <Download className="h-3.5 w-3.5" /> config.js
                    </button>
                    <button
                      onClick={() => downloadFile(
                        safeFilename(justCreated.name, "credentials.txt"),
                        [
                          "FPXpress API credentials",
                          `Generated ${new Date().toISOString()} for "${justCreated.name}"`,
                          "Treat this file like a password.",
                          "",
                          `API URL:  ${apiUrl}`,
                          `API Key:  ${justCreated.plaintext}`,
                          "",
                          "To use: open the FPXpress extension popup → Settings → paste both values.",
                        ].join("\n"),
                      )}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-white ring-1 ring-sky-200 text-sky-700 hover:bg-sky-100"
                    >
                      <Download className="h-3.5 w-3.5" /> credentials.txt
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setJustCreated(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800"
              >
                I saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
