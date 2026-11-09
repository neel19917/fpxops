import { useEffect, useRef, useState } from "react";
import { Copy, Check, ExternalLink, Filter, X as XIcon, ArrowLeft, ArrowRight, RotateCw, Maximize2, Minimize2 } from "lucide-react";
import { useFrameState, hideFrame } from "../lib/freightpopFrame";
import { useAuth } from "../lib/auth";
import { ErrorBlock } from "./ErrorBlock";
import { HostedFreightPop, HOSTED_BROWSER_URL, type BridgeAck, type BridgePayload, type HostedFreightPopHandle } from "./HostedFreightPop";

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

// Sibling to postFpxFilter — asks the extension to click the tracking
// number link in the (already filtered) FP grid so FP's native modal
// pops up inside the iframe. Extension waits ~400ms for the filter to
// settle before clicking, so callers don't need to coordinate timing.
function postFpxOpenTracking(iframe: HTMLIFrameElement | null, trackingNumber: string) {
  if (!iframe || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage({ source: "fpxpress", type: "fpxOpenTracking", trackingNumber }, "*");
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

// The user's saved FreightPOP credentials, used only to populate the
// "Copy email / Copy password" buttons next to the embed so login is one paste
// rather than retyping. They never leave the browser — the dashboard server
// doesn't see or store them.
//
// Email persists in localStorage. The PASSWORD deliberately does not: it used
// to be written to localStorage in plaintext under a single combined key, where
// it survived indefinitely on any shared, backed-up, or profile-synced machine
// and was readable by any script running on this origin. sessionStorage keeps
// the one-paste convenience for as long as the tab is open and discards it when
// the tab closes.
const FPX_EMAIL_KEY = "fpx.freightpop.email.v1";
const FPX_PASSWORD_KEY = "fpx.freightpop.password.v1";
// Superseded by the two keys above. Read once to carry the email forward, then
// deleted so old plaintext passwords don't linger in anyone's localStorage.
const LEGACY_CREDS_KEY = "fpx.freightpop.creds.v1";

interface SavedCreds { email: string; password: string }

function loadCreds(): SavedCreds {
  let email = "";
  let password = "";
  try {
    const legacy = localStorage.getItem(LEGACY_CREDS_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      email = String(parsed?.email || "");
      localStorage.removeItem(LEGACY_CREDS_KEY);
      if (email) localStorage.setItem(FPX_EMAIL_KEY, email);
    }
    email = localStorage.getItem(FPX_EMAIL_KEY) || email;
    password = sessionStorage.getItem(FPX_PASSWORD_KEY) || "";
  } catch { /* storage unavailable — start empty */ }
  return { email, password };
}

function saveCreds(c: SavedCreds) {
  try {
    if (c.email) localStorage.setItem(FPX_EMAIL_KEY, c.email);
    else localStorage.removeItem(FPX_EMAIL_KEY);
    if (c.password) sessionStorage.setItem(FPX_PASSWORD_KEY, c.password);
    else sessionStorage.removeItem(FPX_PASSWORD_KEY);
  } catch { /* storage unavailable — copy buttons still work this session */ }
}

function forgetCreds() {
  try {
    localStorage.removeItem(FPX_EMAIL_KEY);
    localStorage.removeItem(LEGACY_CREDS_KEY);
    sessionStorage.removeItem(FPX_PASSWORD_KEY);
  } catch { /* nothing to clear */ }
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
  // Hosted mode (VITE_FPX_BROWSER_URL set): FreightPOP runs in the hosted
  // browser service with the extension preloaded, so nobody needs the
  // extension installed. Bridge commands go over its WebSocket instead of
  // iframe postMessage; acks come back through the same handler.
  const hosted = !!HOSTED_BROWSER_URL;
  const hostedRef = useRef<HostedFreightPopHandle | null>(null);
  // Separate copy-state per source so the tracking-number copy doesn't
  // share a flash variable with the email-copy button (the previous
  // setCopied("email") reuse made the two affordances visually identical
  // on click, which was confusing to debug).
  const [copied, setCopied] = useState<"email" | "password" | null>(null);
  const [trackingCopied, setTrackingCopied] = useState(false);
  const [typed, setTyped] = useState<"email" | "password" | null>(null);
  // Full screen: cover the shipment drawer too. Esc exits.
  const [paneFull, setPaneFull] = useState(false);
  useEffect(() => {
    if (!paneFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // While typing into the hosted page, Esc belongs to FreightPOP (closing
      // its modals); use the Exit full screen button instead.
      const el = document.activeElement as HTMLElement | null;
      if (el?.getAttribute("aria-label") === "Hosted FreightPOP keyboard input") return;
      e.stopPropagation();
      setPaneFull(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paneFull]);
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
  // Third-party-cookie status, reported by the extension's content script from
  // INSIDE the iframe (the only place it can be measured). null = we haven't
  // heard, which is different from "blocked" and must not render as a warning.
  const [storageAccess, setStorageAccess] = useState<{
    supported: boolean;
    hasAccess: boolean | null;
    granted: boolean | null;
    error: string | null;
  } | null>(null);
  const cookiesBlocked = storageAccess?.supported === true && storageAccess.hasAccess === false;
  // A filter the extension deferred because the FreightPOP frame had no
  // grid yet (login page / still rendering). Re-sent once the extension
  // announces fpxGridReady. A ref, not state: it is only read inside the
  // message handler and must not re-render or re-fire the auto-filter.
  const pendingFilterRef = useRef<{ column: FpxFilterColumn; value: string } | null>(null);

  // Shared by both transports (iframe postMessage + hosted WebSocket).
  // Lives in a ref so the once-registered message listener sees it.
  const handleFilterAckRef = useRef((d: BridgeAck) => {
    if (d.ok) setLastFilter({ column: String(d.column || ""), value: String(d.value || "") });
    if (!d.ok && d.reason === "grid-not-ready" && typeof d.column === "string" && typeof d.value === "string") {
      pendingFilterRef.current = { column: d.column as FpxFilterColumn, value: d.value };
    } else if (d.ok) {
      pendingFilterRef.current = null;
    }
    setLastAck({
      ok: !!d.ok,
      strategy: typeof d.strategy === "string" ? d.strategy : undefined,
      error: typeof d.error === "string" ? d.error : undefined,
      injectDetail: typeof d.injectDetail === "string" ? d.injectDetail : undefined,
    });
    // New ack — re-show the warning so a fresh failure isn't
    // hidden by an earlier dismissal.
    setAckDismissed(false);
  });

  // Route a bridge command to whichever transport is active.
  function sendBridge(payload: BridgePayload) {
    if (hosted) {
      // The hosted browser gets one robust "find this shipment" command
      // instead of a raw column filter (the In Transit grid has no Tracking
      // Number column, and filtering the wrong one emptied the grid).
      let p: BridgePayload = payload;
      if (payload.type === "fpxFilter" || payload.type === "fpxOpenTracking") {
        const tn = payload.type === "fpxFilter" ? payload.value : payload.trackingNumber;
        const sid = /^\d{5,}$/.test(String(frameRef.current.shipmentLabel || "").trim()) ? String(frameRef.current.shipmentLabel).trim() : null;
        p = { type: "fpxFindShipment", shipmentId: sid, trackingNumber: tn || null, open: payload.type === "fpxOpenTracking" };
      }
      const tnForAck = p.type === "fpxFindShipment" ? p.trackingNumber || "" : "";
      hostedRef.current?.bridge(p).then((ack) => {
        handleFilterAckRef.current({ ...ack, column: "Tracking Number", value: tnForAck });
      });
      return;
    }
    if (payload.type === "fpxFilter") {
      postFpxFilter(iframeRef.current, payload.column as FpxFilterColumn, payload.value);
    } else if (payload.type === "fpxOpenTracking") {
      postFpxOpenTracking(iframeRef.current, payload.trackingNumber);
    } else if (payload.trackingNumber) {
      // Extension (iframe) path has no find command; use the tracking filter.
      postFpxFilter(iframeRef.current, "Tracking Number", payload.trackingNumber);
    }
  }
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const sendBridgeRef = useRef(sendBridge);
  sendBridgeRef.current = sendBridge;

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
      } else if (d.type === "fpxStorageAccess") {
        // Only the content script can measure this — document.hasStorageAccess()
        // has to be called inside the embedded frame.
        setStorageAccess({
          supported: !!d.supported,
          hasAccess: typeof d.hasAccess === "boolean" ? d.hasAccess : null,
          granted: typeof d.granted === "boolean" ? d.granted : null,
          error: typeof d.error === "string" ? d.error : null,
        });
        // It reached us, so the bridge is demonstrably alive.
        setBridgeReady(true);
      } else if (d.type === "fpxGridReady") {
        // The frame's Kendo grid just rendered (operator logged in, or FP
        // finished loading). Replay the filter that was deferred, if any.
        setBridgeReady(true);
        const pending = pendingFilterRef.current;
        if (pending) {
          pendingFilterRef.current = null;
          postFpxFilter(iframeRef.current, pending.column, pending.value);
        }
      } else if (d.type === "fpxFilterAck") {
        handleFilterAckRef.current(d);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Periodically ping in case the iframe loaded before our listener was
  // attached (race on first render). Stops once the bridge answers.
  useEffect(() => {
    if (bridgeReady || hosted) return;
    const id = setInterval(() => {
      iframeRef.current?.contentWindow?.postMessage({ source: "fpxpress", type: "fpxPing" }, "*");
    }, 1500);
    return () => clearInterval(id);
  }, [bridgeReady, hosted]);

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
    // Hosted pane: find the shipment AND open FreightPOP's tracking popup, so
    // clicking a task lands straight on its details. (Extension iframe path
    // keeps the plain grid filter.)
    sendBridgeRef.current(hosted
      ? { type: "fpxOpenTracking", trackingNumber: frame.trackingNumber }
      : { type: "fpxFilter", column: "Tracking Number", value: frame.trackingNumber });
  }, [bridgeReady, frame.trackingNumber, frame.autoFilterTick]);

  // Open-tracking-modal trigger. Same keying pattern as auto-filter so a
  // tick bump fires exactly once. The "Open tracking #" button bumps
  // openTrackingTick; we forward to the extension which filters first
  // (so the row is on-screen) then clicks the tracking link.
  const lastOpenTrackingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bridgeReady) return;
    if (!frame.trackingNumber) return;
    if (frame.openTrackingTick === 0) return; // skip on initial mount
    const key = `${frame.trackingNumber}#${frame.openTrackingTick}`;
    if (lastOpenTrackingKeyRef.current === key) return;
    lastOpenTrackingKeyRef.current = key;
    sendBridgeRef.current({ type: "fpxOpenTracking", trackingNumber: frame.trackingNumber });
  }, [bridgeReady, frame.trackingNumber, frame.openTrackingTick]);

  // If the embed is disabled OR the iframe has never been asked to load,
  // render nothing. Once it's loaded once we keep it in the DOM (just
  // hide it via display:none) so the FreightPOP session survives.
  if (!cfg?.enabled) return null;
  if (!frame.url) return null;

  function applyFilterNow() {
    if (!frame.trackingNumber) return;
    sendBridge({ type: "fpxFilter", column: "Tracking Number", value: frame.trackingNumber });
  }
  const isFilteredToCurrent = !!(lastFilter && frame.trackingNumber && lastFilter.column === "Tracking Number" && lastFilter.value === frame.trackingNumber);

  // Hosted mode: type a saved credential straight into the focused field of
  // the hosted FreightPOP page — no clipboard round-trip needed.
  function typeOne(kind: "email" | "password") {
    const v = kind === "email" ? creds.email : creds.password;
    if (!v || !hostedRef.current?.typeText(v)) return;
    setTyped(kind);
    setTimeout(() => setTyped(null), 1500);
  }

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
      className={"fixed top-0 left-0 right-0 bottom-0 bg-slate-100 flex flex-col " + (paneFull ? "z-40" : "sm:right-[720px] z-20")}
      style={{ display: frame.visible ? "flex" : "none" }}
    >
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-slate-200 shadow-sm">
        {/* Back to the dashboard page underneath (closes the pane; the
            FreightPOP session stays alive and reopens where it was). */}
        <button
          onClick={() => { setPaneFull(false); hideFrame(); }}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          title="Close FreightPOP and go back to the dashboard"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to dashboard
        </button>
        {hosted ? (
          // Browser controls for the hosted tab (there's no address bar).
          <div className="shrink-0 inline-flex items-center rounded ring-1 ring-slate-200 bg-white">
            <button onClick={() => hostedRef.current?.nav("back")} className="p-1 text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-l" title="FreightPOP: back">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button onClick={() => hostedRef.current?.nav("forward")} className="p-1 text-slate-600 hover:text-slate-900 hover:bg-slate-50 border-l border-slate-200" title="FreightPOP: forward">
              <ArrowRight className="h-4 w-4" />
            </button>
            <button onClick={() => hostedRef.current?.nav("reload")} className="p-1 text-slate-600 hover:text-slate-900 hover:bg-slate-50 border-l border-slate-200 rounded-r" title="FreightPOP: reload">
              <RotateCw className="h-4 w-4" />
            </button>
          </div>
        ) : null}
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
            title={hosted
              ? (bridgeReady
                  ? "Hosted FreightPOP connected — the extension runs server-side, nothing to install"
                  : "Connecting to the hosted FreightPOP browser…")
              : bridgeReady
                ? "Chrome extension bridge connected — auto-filter works"
                : "Chrome extension bridge not detected — install/reload the FPXpress extension and refresh"}
          >
            <span className={"h-1.5 w-1.5 rounded-full " + (bridgeReady ? "bg-emerald-500" : "bg-amber-500")} />
            {hosted ? "Hosted" : "Ext"} {bridgeReady ? "ok" : "off"}
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
                : hosted
                  ? "Waiting for the hosted FreightPOP page to load"
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
          <button
            onClick={() => setPaneFull((v) => !v)}
            className="text-xs px-2 py-1 rounded ring-1 ring-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
            title={paneFull ? "Exit full screen (Esc)" : "Full screen"}
          >
            {paneFull ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {paneFull ? "Exit full screen" : "Full screen"}
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

      {/* Fact-based, not a guess: this only renders once the content script has
          measured document.hasStorageAccess() inside the frame and told us it's
          false. The "Allow cookies" affordance deliberately lives INSIDE the
          iframe (rendered by the content script) — requestStorageAccess needs
          transient activation in that frame, and a click out here wouldn't
          confer it. */}
      {cookiesBlocked ? (
        <div className="mx-3 mt-2">
          <ErrorBlock tone="warning" compact>
            <div className="font-semibold">FreightPOP can't hold its session in this embed</div>
            <div className="mt-0.5 text-[11px]">
              Your browser blocks FreightPOP's cookies here because this dashboard is on a
              different site (<code className="font-mono">netlify.app</code>) from{" "}
              <code className="font-mono">freightpop.com</code>. Use the{" "}
              <strong>Allow cookies</strong> button at the top of the FreightPOP panel below, or
              open it in a <strong>New tab</strong> — that's never affected.
              {storageAccess?.granted === false && storageAccess.error ? (
                <span className="block mt-1 text-amber-800">
                  Last attempt was denied by the browser: {storageAccess.error}
                </span>
              ) : null}
            </div>
          </ErrorBlock>
        </div>
      ) : null}

      {lastAck && !lastAck.ok && !ackDismissed ? (
        <div className="mx-3 mt-2">
          <ErrorBlock tone="warning" compact>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{hosted ? "Couldn't find this shipment in FreightPOP" : "Filter didn't apply"}</div>
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
            Saved <strong>only in this browser</strong> — the dashboard server never sees these.
            Your email is remembered; the <strong>password is kept only until you close this
            tab</strong>. Use the Copy buttons to one-click-paste into FreightPOP's login, or let
            your browser's password manager autofill — both work because the iframe has no
            sandbox restrictions.
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
                {hosted ? (
                  <button
                    onClick={() => typeOne("email")}
                    disabled={!creds.email}
                    className="px-2 py-1.5 text-[11px] rounded ring-1 ring-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100 inline-flex items-center gap-1 disabled:opacity-40"
                    title="Click the email field in FreightPOP first, then press this to type it in"
                  >
                    {typed === "email" ? <Check className="h-3.5 w-3.5" /> : null}
                    Type in
                  </button>
                ) : null}
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
                {hosted ? (
                  <button
                    onClick={() => typeOne("password")}
                    disabled={!creds.password}
                    className="px-2 py-1.5 text-[11px] rounded ring-1 ring-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100 inline-flex items-center gap-1 disabled:opacity-40"
                    title="Click the password field in FreightPOP first, then press this to type it in"
                  >
                    {typed === "password" ? <Check className="h-3.5 w-3.5" /> : null}
                    Type in
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            After your first manual login, your browser's password manager can autofill on
            subsequent visits. Once you're signed in, the FreightPOP session survives every
            prev/next walk in this tab — the iframe no longer reloads on each shipment.
          </div>
          {/* Explains the repeated logins. Only shown when we haven't positively
              measured cookie access — when we have, the header banner above says
              it definitively and this would just be duplicate noise. */}
          {!cookiesBlocked && storageAccess?.hasAccess !== true ? (
            <div className="text-[11px] text-slate-600 bg-white ring-1 ring-slate-200 rounded px-2 py-1.5 leading-snug">
              <strong>FreightPOP keeps asking you to sign in here?</strong> That's usually your
              browser blocking third-party cookies — this dashboard is on{" "}
              <code className="font-mono">netlify.app</code>, a different site from{" "}
              <code className="font-mono">freightpop.com</code>. Install/reload the FPXpress
              extension and it will offer a one-click fix inside the panel; otherwise use{" "}
              <strong>New tab</strong> above, which isn't affected.
            </div>
          ) : null}
          <div className="flex justify-end">
            <button
              onClick={() => { forgetCreds(); setCreds({ email: "", password: "" }); }}
              disabled={!creds.email && !creds.password}
              className="text-[11px] px-2 py-1 rounded ring-1 ring-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
            >
              Forget saved login
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex-1 bg-white min-h-0">
        {hosted ? (
          <HostedFreightPop ref={hostedRef} onBridgeReady={setBridgeReady} paused={!frame.visible} />
        ) : (
          <iframe
            ref={iframeRef}
            src={frame.url}
            className="w-full h-full block"
            title="FreightPOP"
            allow={EMBED_ALLOW}
            referrerPolicy="no-referrer-when-downgrade"
          />
        )}
      </div>
    </div>
  );
}
