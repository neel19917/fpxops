import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getAccessTokenOrWait } from "../lib/api";

// Live view of a FreightPOP tab running in the hosted browser service
// (browser-service/). Replaces the iframe + local Chrome extension: the
// extension runs inside the hosted Chromium, the service streams this user's
// tab as JPEG frames, and we forward mouse/keyboard/paste back.
//
// Protocol: see browser-service/src/session.js.

export const HOSTED_BROWSER_URL: string = (import.meta.env.VITE_FPX_BROWSER_URL as string | undefined)?.replace(/\/$/, "") || "";

export type BridgeAck = {
  type?: string;
  ok?: boolean;
  reason?: string;
  error?: string | null;
  strategy?: string;
  injectDetail?: string;
  opened?: boolean;
  column?: string;
  value?: string;
};

export type BridgePayload =
  | { type: "fpxFilter"; column: string; value: string }
  | { type: "fpxOpenTracking"; trackingNumber: string }
  // Hosted mode: find by Shipment Id first, then tracking #, then FreightPOP's
  // own search; `open` also opens FreightPOP's details modal for it.
  | { type: "fpxFindShipment"; shipmentId: string | null; trackingNumber: string | null; open?: boolean };

export interface HostedFreightPopHandle {
  bridge(payload: BridgePayload): Promise<BridgeAck>;
  navigate(url: string): void;
  /** Type text into whatever field is focused in the hosted page. */
  typeText(text: string): boolean;
  /** Browser history / reload inside the hosted FreightPOP tab. */
  nav(action: "back" | "forward" | "reload"): void;
}

type Status = "connecting" | "live" | "reconnecting" | "denied" | "ended";

// CDP modifier bitmask.
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
const BUTTONS = ["left", "middle", "right"] as const;

export const HostedFreightPop = forwardRef<HostedFreightPopHandle, {
  onBridgeReady?: (ready: boolean) => void;
  onUrl?: (url: string) => void;
  /** "scrape": read-only view of the user's running scrape window. */
  target?: "tab" | "scrape";
  onEnded?: (reason: string) => void;
  /** True while the pane is hidden: the service stops encoding frames. */
  paused?: boolean;
}>(function HostedFreightPop({ onBridgeReady, onUrl, target = "tab", onEnded, paused = false }, ref) {
  const watchOnly = target === "scrape";
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Keyboard focus target. A canvas can't reliably receive `paste` events in
  // Chrome, so focus sits on this invisible textarea instead: keys are
  // forwarded from it, and Cmd/Ctrl+V fires a real paste event here whose
  // clipboard text we send as Input.insertText (works for password fields).
  const keyTargetRef = useRef<HTMLTextAreaElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<number, (ack: BridgeAck) => void>());
  const nextIdRef = useRef(1);
  const [status, setStatus] = useState<Status>("connecting");
  // Bumped by the Reconnect button to re-run the connection effect.
  const [reconnectKey, setReconnectKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Keep latest callbacks without re-running the connection effect.
  // Effective pause = caller says hidden OR the browser tab is in the background.
  const pausedRef = useRef(paused);
  const syncPause = useRef<() => void>(() => {});
  const lastPauseSent = useRef<boolean | null>(null); // per connection
  const cbRef = useRef({ onBridgeReady, onUrl, onEnded });
  cbRef.current = { onBridgeReady, onUrl, onEnded };

  function send(obj: unknown) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  useImperativeHandle(ref, () => ({
    bridge(payload) {
      return new Promise<BridgeAck>((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: "Hosted browser not connected" });
          return;
        }
        const id = nextIdRef.current++;
        pendingRef.current.set(id, resolve);
        send({ type: "bridge", id, payload });
        // Service retries grid-not-ready for 60s; give it a little headroom.
        setTimeout(() => {
          if (pendingRef.current.delete(id)) resolve({ ok: false, error: "Hosted browser didn't answer in time" });
        }, 75_000);
      });
    },
    navigate(url) { send({ type: "nav", action: "goto", url }); },
    nav(action) { send({ type: "nav", action }); },
    typeText(text) {
      const ws = wsRef.current;
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return false;
      send({ type: "insertText", text });
      return true;
    },
  }), []);

  // Connection lifecycle with reconnect + backoff.
  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchRetries = 0;
    // Frames can arrive faster than we decode them; only draw the latest.
    let decoding = false;
    let queued: Blob | null = null;

    async function draw(blob: Blob) {
      if (decoding) { queued = blob; return; }
      decoding = true;
      try {
        const bmp = await createImageBitmap(blob);
        const c = canvasRef.current;
        if (c) {
          if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
          c.getContext("2d")?.drawImage(bmp, 0, 0);
        }
        bmp.close();
      } catch { /* corrupt frame — skip */ }
      decoding = false;
      if (queued) { const q = queued; queued = null; draw(q); }
    }

    function viewport() {
      const el = wrapRef.current;
      return {
        width: Math.max(320, Math.round(el?.clientWidth || 1280)),
        height: Math.max(240, Math.round(el?.clientHeight || 800)),
        dpr: Math.min(2, window.devicePixelRatio || 1),
      };
    }

    async function connect() {
      if (disposed) return;
      let token: string;
      try { token = await getAccessTokenOrWait(); } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        schedule();
        return;
      }
      const wsUrl = HOSTED_BROWSER_URL.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "blob";
      // Did THIS connection get going? A scrape watch that's refused before
      // it ever went live usually means the scrape's window is still opening
      // (the page shows "Running" the moment the job is claimed) → retry.
      let liveThisConn = false;
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token, viewport: viewport(), target }));
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") { draw(ev.data as Blob); return; }
        let m: { type?: string; ready?: boolean; url?: string; id?: number; ack?: BridgeAck; error?: string; reason?: string };
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "ready") { liveThisConn = true; attempt = 0; setStatus("live"); setError(null); lastPauseSent.current = null; syncPause.current(); }
        else if (m.type === "ended") {
          if (watchOnly && !liveThisConn) return; // not open yet — the close handler retries
          setStatus("ended"); setError(m.reason || "Ended"); cbRef.current.onEnded?.(m.reason || "Ended");
        }
        else if (m.type === "bridgeReady") cbRef.current.onBridgeReady?.(!!m.ready);
        else if (m.type === "url" && m.url) cbRef.current.onUrl?.(m.url);
        else if (m.type === "bridgeAck" && typeof m.id === "number") {
          const r = pendingRef.current.get(m.id);
          if (r) { pendingRef.current.delete(m.id); r(m.ack || { ok: false }); }
        } else if (m.type === "error" && m.error) setError(m.error);
      };
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        cbRef.current.onBridgeReady?.(false);
        for (const r of pendingRef.current.values()) r({ ok: false, error: "Hosted browser disconnected" });
        pendingRef.current.clear();
        if (disposed) return;
        if (ev.code === 4004) {
          // Scrape window not open yet → keep trying for about a minute.
          if (watchOnly && !liveThisConn && watchRetries < 30) {
            watchRetries++;
            setStatus("connecting");
            setError("Waiting for the scrape window to open…");
            retryTimer = setTimeout(connect, 2000);
            return;
          }
          setStatus("ended");
          return;
        }
        if (ev.code === 4010) {
          // Closed by the admin "close a view after inactivity" setting.
          setStatus("ended");
          setError(ev.reason === "idle" ? "This FreightPOP view was closed after inactivity." : "This FreightPOP view was closed.");
          return;
        }
        if (ev.code === 4009) {
          // Too many of this user's tabs were open; this (older) one was closed.
          // Don't auto-reconnect, or two tabs would keep evicting each other.
          setStatus("ended");
          setError("FreightPOP is open in a newer tab. Reload this page to use it here.");
          return;
        }
        if (ev.code === 4001 || ev.code === 4003) {
          setStatus("denied");
          setError(ev.code === 4003 ? "This dashboard origin isn't allowed by the hosted browser (ALLOWED_ORIGINS)." : "Hosted browser rejected your session.");
          return;
        }
        if (ev.code === 4029) setError("Hosted browser is at its session limit — retrying.");
        setStatus("reconnecting");
        schedule();
      };
    }

    function schedule() {
      if (disposed) return;
      const delay = Math.min(15_000, 1000 * 2 ** attempt++);
      retryTimer = setTimeout(connect, delay);
    }

    connect();

    // Keep the remote viewport matched to our box.
    const ro = new ResizeObserver(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "viewport", ...viewport() }));
    });
    if (wrapRef.current) ro.observe(wrapRef.current);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ro.disconnect();
      wsRef.current?.close();
    };
  }, [target, reconnectKey]);

  // Tell the service to stop/start streaming. Re-sent after every reconnect.
  useEffect(() => {
    syncPause.current = () => {
      const want = pausedRef.current || document.visibilityState === "hidden";
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (want === lastPauseSent.current) return;
      lastPauseSent.current = want;
      ws.send(JSON.stringify({ type: want ? "pause" : "resume" }));
    };
    const onVis = () => syncPause.current();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => { pausedRef.current = paused; syncPause.current(); }, [paused]);

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData("text/plain");
    if (text) send({ type: "insertText", text });
  }

  // Canvas pixels are device pixels; the remote page is laid out in CSS px
  // equal to our box size, so offsetX/offsetY map 1:1.
  const lastMoveRef = useRef(0);
  function mouse(e: React.MouseEvent<HTMLCanvasElement>, event: string, clickCount = 0) {
    send({
      type: "mouse", event,
      x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY,
      button: event === "mouseMoved" ? "none" : BUTTONS[e.button] || "left",
      buttons: e.buttons, clickCount, modifiers: modifiers(e),
    });
  }

  function key(e: React.KeyboardEvent<HTMLTextAreaElement>, event: "keyDown" | "keyUp") {
    // Keys typed into the hosted page belong to FreightPOP only. Without this
    // they bubble to the dashboard's window/document shortcut handlers (which
    // only ignore real <input>s), so typing "o" in the FreightPOP login opened
    // "Override action", Esc closed the drawer, j/k walked tasks, etc.
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    // Leave Cmd/Ctrl+V to the native paste event on the key target (onPaste).
    if (mod && (e.key === "v" || e.key === "V")) return;
    e.preventDefault();
    send({
      type: "key", event,
      key: e.key, code: e.code, keyCode: e.keyCode,
      text: event === "keyDown" && e.key.length === 1 && !mod ? e.key : (e.key === "Enter" && event === "keyDown" ? "\r" : undefined),
      modifiers: modifiers(e),
    });
  }

  return (
    <div ref={wrapRef} className="relative w-full h-full overflow-hidden bg-white">
      <textarea
        ref={keyTargetRef}
        aria-label="Hosted FreightPOP keyboard input"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="absolute left-0 top-0 w-px h-px opacity-0 pointer-events-none resize-none"
        onKeyDown={(e) => key(e, "keyDown")}
        onKeyUp={(e) => key(e, "keyUp")}
        onKeyPress={(e) => e.stopPropagation()}
        onPaste={onPaste}
        // Nothing should ever accumulate here (keys are preventDefault'ed),
        // but clear defensively so IME/dead keys can't leave text behind.
        onInput={(e) => { e.currentTarget.value = ""; }}
      />
      {watchOnly ? (
        // Read-only: the scrape window keeps its own size, so letterbox it.
        <canvas ref={canvasRef} className="block w-full h-full bg-slate-900" style={{ objectFit: "contain" }} />
      ) : <canvas
        ref={canvasRef}
        className="block w-full h-full outline-none cursor-default"
        style={{ imageRendering: "auto" }}
        onMouseDown={(e) => {
          // preventDefault keeps the browser from moving focus to the canvas.
          e.preventDefault();
          keyTargetRef.current?.focus({ preventScroll: true });
          mouse(e, "mousePressed", e.detail || 1);
        }}
        onMouseUp={(e) => mouse(e, "mouseReleased", e.detail || 1)}
        onMouseMove={(e) => {
          const now = performance.now();
          if (now - lastMoveRef.current < 16 && e.buttons === 0) return;
          lastMoveRef.current = now;
          mouse(e, "mouseMoved");
        }}
        onWheel={(e) => send({
          type: "mouse", event: "mouseWheel",
          x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY,
          deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e),
        })}
        onContextMenu={(e) => e.preventDefault()}
      />}
      {status !== "live" || error ? (
        <div className="absolute inset-x-0 top-0 flex justify-center pointer-events-none">
          <div className={
            "mt-3 text-xs px-3 py-1.5 rounded-full shadow ring-1 pointer-events-auto " +
            (status === "denied" ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-white text-slate-700 ring-slate-200")
          }>
            {status === "connecting" ? (watchOnly ? "Connecting to the scrape…" : "Connecting to hosted FreightPOP…")
              : status === "reconnecting" ? "Reconnecting to hosted FreightPOP…"
              : null}
            {error ? <span className={status === "live" ? "" : "ml-1"}>{error}</span> : null}
            {status === "ended" && !watchOnly ? (
              <button
                onClick={() => { setError(null); setStatus("connecting"); setReconnectKey((k) => k + 1); }}
                className="ml-2 font-semibold text-violet-700 hover:text-violet-900 underline"
              >
                Reconnect
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});
