import { useEffect, useRef, useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { useFrameState } from "../lib/freightpopFrame";
import { useAuth } from "../lib/auth";

// Permissions-policy bundle for the FreightPOP iframe. Each entry corresponds
// to a feature browsers default-deny for cross-origin frames; allowing them
// here lets FreightPOP's login/session work the way it does in a normal tab:
//   storage-access                        — Storage Access API (third-party
//                                            cookies after user grants)
//   publickey-credentials-{get,create}    — WebAuthn (passkeys, security keys)
//   clipboard-read / clipboard-write      — paste + copy inside FreightPOP
//   forms / autoplay / fullscreen         — generic UX features the app uses
const EMBED_ALLOW = [
  "storage-access *",
  "publickey-credentials-get *",
  "publickey-credentials-create *",
  "clipboard-read *",
  "clipboard-write *",
  "forms *",
  "autoplay *",
  "fullscreen *",
].join("; ");

// localStorage key for the user's saved FreightPOP credentials. They never
// leave the browser — the dashboard server doesn't see or store them. Used
// only to populate the "Copy email / Copy password" buttons next to the
// embed so first-time login is one paste, not retyping.
const FPX_CREDS_KEY = "fpx.freightpop.creds.v1";

interface SavedCreds { email: string; password: string }

function loadCreds(): SavedCreds {
  try {
    const raw = localStorage.getItem(FPX_CREDS_KEY);
    if (!raw) return { email: "", password: "" };
    const parsed = JSON.parse(raw);
    return { email: String(parsed.email || ""), password: String(parsed.password || "") };
  } catch { return { email: "", password: "" }; }
}

function saveCreds(c: SavedCreds) {
  try { localStorage.setItem(FPX_CREDS_KEY, JSON.stringify(c)); } catch {}
}

// Singleton FreightPOP iframe overlay. Mounted once inside <AuthedApp>; it
// reads its visibility + current-shipment context from the freightpopFrame
// pub/sub store, so pages can drive it without remounting the iframe.
//
// CRITICAL INVARIANT: this iframe must NOT remount when the React route
// changes. The iframe element lives in this single component's tree and
// only its `src` changes when the resolved URL genuinely differs (rare —
// the default template has no per-shipment placeholders). Visibility is
// CSS-only (display: block | none) so the FreightPOP session inside the
// iframe survives every prev/next walk.
export function FreightPopOverlay() {
  const { clientConfig } = useAuth();
  const cfg = clientConfig?.embed_freightpop;
  const frame = useFrameState();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [copied, setCopied] = useState<"email" | "password" | null>(null);
  const [credsOpen, setCredsOpen] = useState(false);
  const [creds, setCreds] = useState<SavedCreds>(() => loadCreds());

  // Persist creds whenever the user edits them in the popover.
  useEffect(() => { saveCreds(creds); }, [creds]);

  // If the embed is disabled OR the iframe has never been asked to load,
  // render nothing. Once it's loaded once we keep it in the DOM (just
  // hide it via display:none) so the FreightPOP session survives.
  if (!cfg?.enabled) return null;
  if (!frame.url) return null;

  async function copyOne(kind: "email" | "password") {
    const v = kind === "email" ? creds.email : creds.password;
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {/* clipboard blocked — ignore */}
  }

  return (
    <div
      // Position: fills the viewport area to the LEFT of the 560px drawer
      // when the drawer is open, otherwise off-screen via display:none.
      // We never unmount.
      className="fixed top-0 left-0 right-0 sm:right-[560px] bottom-0 z-20 bg-slate-100 flex flex-col"
      style={{ display: frame.visible ? "flex" : "none" }}
    >
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 shrink-0">FreightPOP · Tracking #</span>
          <span className="font-mono text-sm text-slate-900 truncate">{frame.trackingNumber || "—"}</span>
          {frame.trackingNumber ? (
            <button
              onClick={() => {
                navigator.clipboard.writeText(frame.trackingNumber || "").then(() => {
                  setCopied("email"); // reuse the flash; keeps state simple
                  setTimeout(() => setCopied(null), 1500);
                }).catch(() => {});
              }}
              className="inline-flex items-center gap-1 text-[11px] text-sky-700 hover:text-sky-900 px-1.5 py-0.5 rounded hover:bg-sky-50"
              title="Copy tracking number"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setCredsOpen((v) => !v)}
            className="text-xs px-2 py-1 rounded ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
            title="Saved login (stored only in this browser)"
            aria-pressed={credsOpen}
          >
            Login helper
          </button>
          <a
            href={frame.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-700 hover:text-sky-900 underline inline-flex items-center gap-1"
          >
            <ExternalLink className="h-3.5 w-3.5" /> New tab
          </a>
        </div>
      </div>

      {credsOpen ? (
        <div className="px-3 py-3 bg-sky-50 ring-1 ring-sky-200 mx-3 mt-2 rounded-lg space-y-2">
          <div className="text-[11px] text-slate-700 leading-snug">
            Saved <strong>only in this browser</strong> (localStorage). The dashboard server
            never sees these. Use the Copy buttons to one-click-paste into FreightPOP's login,
            or let your browser's password manager autofill — both work because the iframe
            has no sandbox restrictions.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase font-semibold text-slate-500">FreightPOP email</label>
              <div className="flex items-center gap-1">
                <input
                  type="email"
                  value={creds.email}
                  onChange={(e) => setCreds((c) => ({ ...c, email: e.target.value }))}
                  placeholder="you@company.com"
                  className="flex-1 text-sm px-2 py-1.5 rounded border border-slate-200 bg-white"
                  autoComplete="username"
                />
                <button
                  onClick={() => copyOne("email")}
                  disabled={!creds.email}
                  className="px-2 py-1.5 text-[11px] rounded ring-1 ring-slate-200 bg-white hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-40"
                >
                  {copied === "email" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  Copy
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase font-semibold text-slate-500">FreightPOP password</label>
              <div className="flex items-center gap-1">
                <input
                  type="password"
                  value={creds.password}
                  onChange={(e) => setCreds((c) => ({ ...c, password: e.target.value }))}
                  placeholder="•••••••"
                  className="flex-1 text-sm px-2 py-1.5 rounded border border-slate-200 bg-white"
                  autoComplete="current-password"
                />
                <button
                  onClick={() => copyOne("password")}
                  disabled={!creds.password}
                  className="px-2 py-1.5 text-[11px] rounded ring-1 ring-slate-200 bg-white hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-40"
                >
                  {copied === "password" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  Copy
                </button>
              </div>
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            After your first manual login, your browser's password manager can autofill on
            subsequent visits. Once you're signed in, the FreightPOP session survives every
            prev/next walk in this tab — the iframe no longer reloads on each shipment.
          </div>
        </div>
      ) : null}

      <div className="flex-1 bg-white">
        <iframe
          ref={iframeRef}
          src={frame.url}
          className="w-full h-full block"
          title="FreightPOP"
          allow={EMBED_ALLOW}
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
    </div>
  );
}
