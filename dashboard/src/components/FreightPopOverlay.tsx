import { useEffect, useRef, useState } from "react";
import { Copy, Check, ExternalLink, Filter, X as XIcon } from "lucide-react";
import { useFrameState } from "../lib/freightpopFrame";
import { useAuth } from "../lib/auth";
import { ErrorBlock } from "./ErrorBlock";

// postMessage bridge to the FPXpress Chrome extension. The extension's
// content script runs inside the FreightPOP iframe (its host permissions
// cover app.freightpop.com regardless of frame depth) and listens for
// these messages to drive the live Kendo grid's column filters.
//
// Protocol mirrors extension/content.js:
//   { source: "fpxpress", type: "fpxFilter", column, value }
// The extension responds with { source: "fpx-extension", type: "fpxFilterAck"|"fpxPong"|"fpxHello", ... }.
type FpxFilterColumn = "Tracking Number" | "Shipment status" | "Mode" | "Carrier Name" | "Company Name";
function postFpxFilter(iframe: HTMLIFrameElement | null, column: FpxFilterColumn, value: string) {
  if (!iframe || !iframe.contentWindow) return;
  // We don't know the iframe's origin until it answers fpxPong, but the
  // payload is non-sensitive and the extension validates *our* origin
  // before acting, so '*' is fine here.
  iframe.contentWindow.postMessage({ source: "fpxpress", type: "fpxFilter", column, value }, "*");
}

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
  // Separate copy-state per source so the tracking-number copy doesn't
  // share a flash variable with the email-copy button (the previous
  // setCopied("email") reuse made the two affordances visually identical
  // on click, which was confusing to debug).
  const [copied, setCopied] = useState<"email" | "password" | null>(null);
  const [trackingCopied, setTrackingCopied] = useState(false);
  // Last filter ack the operator dismissed — once the user closes the
  // warning it stays dismissed for that ack identity so a stuck failure
  // doesn't bury the iframe forever.
  const [ackDismissed, setAckDismissed] = useState(false);
  const [credsOpen, setCredsOpen] = useState(false);
  const [creds, setCreds] = useState<SavedCreds>(() => loadCreds());
  // Tracks whether the FPXpress Chrome extension has greeted us from
  // inside the iframe (window.parent.postMessage("fpxHello")). When true,
  // the "Filter to this shipment" button can drive the Kendo grid; when
  // false, we tell the user to install/enable the extension.
  const [bridgeReady, setBridgeReady] = useState(false);
  // Last column we asked the extension to filter on — used to flip the
  // button's icon between "apply" and "filtered".
  const [lastFilter, setLastFilter] = useState<{ column: string; value: string } | null>(null);
  // Last filter ack detail. Populated whenever the extension reports
  // back, success or failure. We surface failures in a small expandable
  // panel under the header so debugging doesn't require DevTools frame
  // switching.
  const [lastAck, setLastAck] = useState<{ ok: boolean; strategy?: string; error?: string; injectDetail?: string } | null>(null);

  // Persist creds whenever the user edits them in the popover.
  useEffect(() => { saveCreds(creds); }, [creds]);

  // Listen for messages from the extension's content script inside the
  // iframe. We only act on the magic source tag and ignore everything else
  // (FreightPOP's own postMessages, third-party widgets, etc.).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.source !== "fpx-extension") return;
      if (d.type === "fpxHello" || d.type === "fpxPong") {
        setBridgeReady(true);
      } else if (d.type === "fpxFilterAck") {
        if (d.ok) setLastFilter({ column: String(d.column || ""), value: String(d.value || "") });
        setLastAck({
          ok: !!d.ok,
          strategy: typeof d.strategy === "string" ? d.strategy : undefined,
          error: typeof d.error === "string" ? d.error : undefined,
          injectDetail: typeof d.injectDetail === "string" ? d.injectDetail : undefined,
        });
        // New ack — re-show the warning so a fresh failure isn't
        // hidden by an earlier dismissal.
        setAckDismissed(false);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Periodically ping in case the iframe loaded before our listener was
  // attached (race on first render). Stops once the bridge answers.
  useEffect(() => {
    if (bridgeReady) return;
    const id = setInterval(() => {
      iframeRef.current?.contentWindow?.postMessage({ source: "fpxpress", type: "fpxPing" }, "*");
    }, 1500);
    return () => clearInterval(id);
  }, [bridgeReady]);

  // Auto-filter on demand. Keys on (trackingNumber + autoFilterTick): a
  // new tracking number arriving via showFrame fires once; a tick bump
  // (Tasks "Load shipment" / drawer "Load in FreightPOP") forces a
  // re-fire even when the tracking number hasn't changed. The keying
  // also makes the pipeline race-free vs the order in which
  // requestAutoFilter and showFrame land on the store — both
  // permutations produce exactly one fire per (tracking, tick) pair.
  const lastAutoFilteredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bridgeReady) return;
    if (!frame.trackingNumber) return;
    const key = `${frame.trackingNumber}#${frame.autoFilterTick}`;
    if (lastAutoFilteredKeyRef.current === key) return;
    lastAutoFilteredKeyRef.current = key;
    postFpxFilter(iframeRef.current, "Tracking Number", frame.trackingNumber);
  }, [bridgeReady, frame.trackingNumber, frame.autoFilterTick]);

  // If the embed is disabled OR the iframe has never been asked to load,
  // render nothing. Once it's loaded once we keep it in the DOM (just
  // hide it via display:none) so the FreightPOP session survives.
  if (!cfg?.enabled) return null;
  if (!frame.url) return null;

  function applyFilterNow() {
    if (!frame.trackingNumber) return;
    postFpxFilter(iframeRef.current, "Tracking Number", frame.trackingNumber);
  }
  const isFilteredToCurrent = !!(lastFilter && frame.trackingNumber && lastFilter.column === "Tracking Number" && lastFilter.value === frame.trackingNumber);

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
      // Position: fills the viewport area to the LEFT of the 720px drawer
      // when the drawer is open, otherwise off-screen via display:none.
      // We never unmount.
      className="fixed top-0 left-0 right-0 sm:right-[720px] bottom-0 z-20 bg-slate-100 flex flex-col"
      style={{ display: frame.visible ? "flex" : "none" }}
    >
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 min-w-0">
          {/* Lead with the FreightPOP shipment id — that's the unique
              identifier in the operator's mental map. Tracking number is
              secondary (mono, smaller) and customer name caps the line. */}
          <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 shrink-0">FreightPOP · Shipment</span>
          <span className="text-sm font-semibold text-slate-900 truncate">{frame.shipmentLabel || "—"}</span>
          {/* Bridge presence pill: green when the extension's content script
              has greeted us (auto-filter works), amber when still pinging
              (extension may not be installed/reloaded). The visible "Ext"
              label means operators don't need a hover to know what the
              dot represents. */}
          <span
            className={
              "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 shrink-0 " +
              (bridgeReady
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-amber-50 text-amber-800 ring-amber-200")
            }
            title={bridgeReady
              ? "Chrome extension bridge connected — auto-filter works"
              : "Chrome extension bridge not detected — install/reload the FPXpress extension and refresh"}
          >
            <span className={"h-1.5 w-1.5 rounded-full " + (bridgeReady ? "bg-emerald-500" : "bg-amber-500")} />
            Ext {bridgeReady ? "ok" : "off"}
          </span>
          {frame.trackingNumber ? (
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-slate-500 shrink-0 min-w-0">
              <span className="uppercase tracking-wider font-semibold">Tracking</span>
              <span className="font-mono text-slate-700 truncate max-w-[180px]">{frame.trackingNumber}</span>
            </span>
          ) : null}
          {frame.customerName ? (
            <span className="hidden md:inline text-[11px] text-slate-500 truncate max-w-[220px]" title={frame.customerName}>
              · {frame.customerName}
            </span>
          ) : null}
          {frame.trackingNumber ? (
            <button
              onClick={() => {
                navigator.clipboard.writeText(frame.trackingNumber || "").then(() => {
                  setTrackingCopied(true);
                  setTimeout(() => setTrackingCopied(false), 1500);
                }).catch(() => {});
              }}
              className="inline-flex items-center gap-1 text-[11px] text-sky-700 hover:text-sky-900 px-1.5 py-0.5 rounded hover:bg-sky-50 shrink-0"
              title="Copy tracking number"
            >
              {trackingCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {trackingCopied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {frame.trackingNumber ? (
            <button
              onClick={applyFilterNow}
              disabled={!bridgeReady}
              className={"text-xs px-2 py-1 rounded ring-1 inline-flex items-center gap-1 " + (isFilteredToCurrent
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : bridgeReady
                  ? "bg-violet-600 text-white ring-violet-600 hover:bg-violet-700"
                  : "bg-slate-50 text-slate-400 ring-slate-200 cursor-not-allowed")}
              title={bridgeReady
                ? (isFilteredToCurrent
                    ? `Filtered to ${frame.trackingNumber}`
                    : `Apply Kendo filter: Tracking Number = ${frame.trackingNumber}`)
                : "Install/enable the FPXpress Chrome extension to filter the embedded grid"}
            >
              {isFilteredToCurrent ? <Check className="h-3.5 w-3.5" /> : <Filter className="h-3.5 w-3.5" />}
              {isFilteredToCurrent ? "Filtered" : "Filter shipment"}
            </button>
          ) : null}
          <button
            onClick={() => setCredsOpen((v) => !v)}
            className={
              "text-xs px-2 py-1 rounded ring-1 inline-flex items-center gap-1 transition " +
              (credsOpen
                ? "bg-sky-50 text-sky-700 ring-sky-200"
                : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")
            }
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

      {lastAck && !lastAck.ok && !ackDismissed ? (
        <div className="mx-3 mt-2">
          <ErrorBlock tone="warning" compact>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Filter didn't apply</div>
                {lastAck.error ? <div className="mt-0.5 text-[11px]">{lastAck.error}</div> : null}
                {lastAck.injectDetail ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-amber-800 hover:text-amber-900 text-[11px]">Details (Kendo inject)</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-amber-900">{lastAck.injectDetail}</pre>
                  </details>
                ) : null}
              </div>
              <button
                onClick={() => setAckDismissed(true)}
                className="shrink-0 p-0.5 rounded text-amber-700 hover:text-amber-900 hover:bg-amber-100"
                aria-label="Dismiss filter warning"
                title="Dismiss"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </ErrorBlock>
        </div>
      ) : null}

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
