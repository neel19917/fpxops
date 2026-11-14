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

type HostedTab = { id: string; title: string; url: string; main?: boolean };

type Status = "connecting" | "live" | "reconnecting" | "denied" | "ended";

// CDP modifier bitmask.
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
const BUTTONS = ["left", "middle", "right"] as const;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

export const HostedFreightPop = forwardRef<HostedFreightPopHandle, {
  onBridgeReady?: (ready: boolean) => void;
  onUrl?: (url: string) => void;
  /** Server's check: does this browser hold a FreightPOP login? */
  onSignedIn?: (signedIn: boolean) => void;
  /** "scrape" / "invoicing": read-only view of the user's running scrape window, or of their invoicing session's window. */
  target?: "tab" | "scrape" | "invoicing";
  onEnded?: (reason: string) => void;
  /** True while the pane is hidden: the service stops encoding frames. */
  paused?: boolean;
  /** The connection dropped: whatever was loaded in the view can no longer be assumed. */
  onDisconnected?: () => void;
}>(function HostedFreightPop({ onBridgeReady, onUrl, onSignedIn, target = "tab", onEnded, paused = false, onDisconnected }, ref) {
  const watchOnly = target !== "tab";
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
  const cutIdsRef = useRef(new Set<number>());
  // The service reports what is selected in FreightPOP ("selection"), so
  // Cmd/Ctrl+C can fill the clipboard inside the browser's own copy event.
  // Older service versions don't report it: then we ask and write afterwards.
  const selTextRef = useRef("");
  const selKnownRef = useRef(false);
  const [status, setStatus] = useState<Status>("connecting");
  // Bumped by the Reconnect button to re-run the connection effect.
  const [reconnectKey, setReconnectKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Keep latest callbacks without re-running the connection effect.
  // Effective pause = caller says hidden OR the browser tab is in the background.
  const pausedRef = useRef(paused);
  const syncPause = useRef<() => void>(() => {});
  const lastPauseSent = useRef<boolean | null>(null); // per connection
  const cbRef = useRef({ onBridgeReady, onUrl, onSignedIn, onEnded, onDisconnected });
  cbRef.current = { onBridgeReady, onUrl, onSignedIn, onEnded, onDisconnected };
  // Set when the service closed this view to make room for a newer tab while
  // this one was in the background; it reconnects when the tab is shown again.
  const evictedRef = useRef(false);

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
      // The token wait can outlast this effect (unmount, StrictMode re-run)
      // or the tab being looked at (flipping past it): don't open a socket
      // nobody will close, or take a view for a tab that is hidden again.
      if (disposed) return;
      if (!watchOnly && document.visibilityState === "hidden") { connectWhenVisible(); return; }
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
        let m: { type?: string; ready?: boolean; url?: string; id?: number; ack?: BridgeAck; error?: string; reason?: string; value?: boolean; text?: string; at?: boolean; active?: string; tabs?: HostedTab[] };
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "ready") { liveThisConn = true; attempt = 0; setStatus("live"); setError(null); lastPauseSent.current = null; syncPause.current(); }
        else if (m.type === "ended") {
          if (watchOnly && !liveThisConn) return; // not open yet — the close handler retries
          setStatus("ended"); setError(m.reason || "Ended"); cbRef.current.onEnded?.(m.reason || "Ended");
        }
        else if (m.type === "bridgeReady") cbRef.current.onBridgeReady?.(!!m.ready);
        else if (m.type === "url" && m.url) cbRef.current.onUrl?.(m.url);
        else if (m.type === "signedIn") cbRef.current.onSignedIn?.(!!m.value);
        else if (m.type === "selection") { selTextRef.current = m.text || ""; selKnownRef.current = true; }
        else if (m.type === "copyResult") {
          copyToClipboard(m.text || "", !!m.at);
          // Cmd/Ctrl+X: the text is on the clipboard — now delete the selection there.
          if (typeof m.id === "number" && cutIdsRef.current.delete(m.id) && m.text) {
            for (const event of ["keyDown", "keyUp"]) ws.send(JSON.stringify({ type: "key", event, key: "Delete", code: "Delete", keyCode: 46, modifiers: 0 }));
          }
        }
        else if (m.type === "tabs") { setTabs(Array.isArray(m.tabs) ? m.tabs : []); setActiveTab(m.active || "main"); }
        else if (m.type === "bridgeAck" && typeof m.id === "number") {
          const r = pendingRef.current.get(m.id);
          if (r) { pendingRef.current.delete(m.id); r(m.ack || { ok: false }); }
        } else if (m.type === "error" && m.error) setError(m.error);
      };
      ws.onclose = (ev) => {
        const mine = wsRef.current === ws;
        if (mine) wsRef.current = null;
        // A socket that is no longer this view's (a newer one replaced it)
        // must not report the live view as disconnected.
        if (!mine && disposed) return;
        setTabs([]); setActiveTab("main");
        selKnownRef.current = false; selTextRef.current = "";
        cbRef.current.onBridgeReady?.(false);
        cbRef.current.onDisconnected?.();
        for (const r of pendingRef.current.values()) r({ ok: false, reason: "disconnected", error: "Hosted browser disconnected" });
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
          // Don't reconnect while hidden, or tabs would keep evicting each
          // other. A background tab reconnects when the user comes back to it.
          setStatus("ended");
          if (document.visibilityState === "hidden") {
            evictedRef.current = true;
            setError("FreightPOP moved to the tab you opened after this one. It reconnects when you come back here.");
          } else {
            setError("FreightPOP is open in a newer tab. Press Reconnect to use it here.");
          }
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

    // A person gets only a few hosted views at a time, and each new one closes
    // their oldest. So a tab that loads in the background (e.g. "Open all in
    // tabs") waits until it is actually looked at before taking a view;
    // otherwise eight tabs opening at once knock each other out.
    let onShown: (() => void) | null = null;
    function stopWaiting() {
      if (!onShown) return;
      document.removeEventListener("visibilitychange", onShown);
      window.removeEventListener("pageshow", onShown);
      window.removeEventListener("focus", onShown);
      onShown = null;
    }
    function connectWhenVisible() {
      if (disposed) return;
      if (watchOnly || document.visibilityState !== "hidden") { connect(); return; }
      if (onShown) return;
      onShown = () => {
        if (document.visibilityState === "hidden" || !onShown) return;
        stopWaiting();
        connect();
      };
      // pageshow / focus cover a restore from the back-forward cache, where
      // visibilitychange isn't guaranteed to fire.
      document.addEventListener("visibilitychange", onShown);
      window.addEventListener("pageshow", onShown);
      window.addEventListener("focus", onShown);
    }

    function schedule() {
      if (disposed) return;
      const delay = Math.min(15_000, 1000 * 2 ** attempt++);
      retryTimer = setTimeout(connectWhenVisible, delay);
    }

    connectWhenVisible();

    // Keep the remote viewport matched to our box.
    const ro = new ResizeObserver(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "viewport", ...viewport() }));
    });
    if (wrapRef.current) ro.observe(wrapRef.current);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopWaiting();
      ro.disconnect();
      wsRef.current?.close();
    };
  }, [target, reconnectKey]);

  // Back on a tab whose view was given to a newer tab → take a view again.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden" || !evictedRef.current) return;
      evictedRef.current = false;
      setStatus("connecting"); setError(null);
      setReconnectKey((k) => k + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

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

  // Tabs in the hosted browser: the FreightPOP tab, windows FreightPOP opened
  // from it (labels, documents, carrier links) and tabs added with "+".
  const [tabs, setTabs] = useState<HostedTab[]>([]);
  const [activeTab, setActiveTab] = useState("main");
  function tabAction(action: "select" | "close" | "new", id?: string) {
    send({ type: "tab", action, id });
    keyTargetRef.current?.focus({ preventScroll: true });
  }
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copyNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showCopyNote(text: string) {
    setCopyNote(text);
    if (copyNoteTimer.current) clearTimeout(copyNoteTimer.current);
    copyNoteTimer.current = setTimeout(() => setCopyNote(null), 1800);
  }
  async function copyToClipboard(text: string, atPointer = false) {
    if (!text.trim()) {
      showCopyNote(atPointer ? "Nothing to copy there — right-click a number or word, or drag over text first"
        : "Nothing selected — right-click a number, or drag over text first");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers that refuse async clipboard writes.
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      keyTargetRef.current?.focus();
      if (!ok) { showCopyNote("Couldn't copy — your browser blocked the clipboard"); return; }
    }
    const one = text.replace(/\s+/g, " ").trim();
    showCopyNote(`Copied “${one.length > 40 ? one.slice(0, 40) + "…" : one}”`);
  }

  // The browser's own copy/cut (Cmd/Ctrl+C/X, or its Edit menu) while the
  // hosted view has focus: hand it the text selected in FreightPOP.
  function onCopy(e: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean) {
    e.preventDefault();
    e.stopPropagation();
    const text = selTextRef.current;
    if (selKnownRef.current && text.trim()) {
      e.clipboardData.setData("text/plain", text);
      const one = text.replace(/\s+/g, " ").trim();
      showCopyNote(`${cut ? "Cut" : "Copied"} “${one.length > 40 ? one.slice(0, 40) + "…" : one}”`);
      if (cut) {
        for (const event of ["keyDown", "keyUp"]) send({ type: "key", event, key: "Delete", code: "Delete", keyCode: 46, modifiers: 0 });
        selTextRef.current = "";
      }
      return;
    }
    const id = Date.now();
    if (cut) cutIdsRef.current.add(id);
    send({ type: "copy", id });
  }

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
      // A move with the left button held is a drag (selects text).
      button: event === "mouseMoved" ? (e.buttons & 1 ? "left" : "none") : BUTTONS[e.button] || "left",
      buttons: e.buttons, clickCount, modifiers: modifiers(e),
    });
  }

  function key(e: React.KeyboardEvent<HTMLTextAreaElement>, event: "keyDown" | "keyUp") {
    // Keys typed into the hosted page belong to FreightPOP only. Without this
    // they bubble to the dashboard's window/document shortcut handlers (which
    // only ignore real <input>s), so typing "o" in the FreightPOP login opened
    // "Override action", Esc closed the drawer, j/k walked tasks, etc.
    e.stopPropagation();
    // AltGr (how many non-US keyboards type @ # € [ ] { } \ |) arrives on
    // Windows as Ctrl+Alt. That's a character, not a shortcut: send the
    // character with no modifiers, or Chrome treats it as Ctrl+Alt+2 and
    // types nothing.
    const altGr = e.getModifierState?.("AltGraph") || (e.ctrlKey && e.altKey && !e.metaKey && e.key.length === 1);
    const mod = !altGr && (e.metaKey || e.ctrlKey);
    // Leave Cmd/Ctrl+V to the native paste event on the key target (onPaste).
    if (mod && (e.key === "v" || e.key === "V")) return;
    const k = e.key.toLowerCase();
    // Cmd/Ctrl+C and +X: FreightPOP's selected text goes to the user's own
    // clipboard (the remote browser's clipboard is useless to them); X also
    // removes it there.
    if (mod && !e.shiftKey && !e.altKey && (k === "c" || k === "x")) {
      // Selection known → don't cancel the key: the browser then fires its
      // copy/cut event on the key target, and onCopy fills the clipboard.
      if (selKnownRef.current && selTextRef.current.trim()) return;
      e.preventDefault();
      if (event === "keyDown") {
        const id = Date.now();
        if (k === "x") cutIdsRef.current.add(id);
        send({ type: "copy", id });
      }
      return;
    }
    e.preventDefault();
    // The hosted browser runs on Linux, where shortcuts use Ctrl. Translate
    // the Mac ones so they do the same thing there:
    //   Cmd+key → Ctrl+key · Cmd+←/→ → Home/End · Cmd+↑/↓ → Ctrl+Home/End
    //   Option+←/→/Backspace/Delete → Ctrl+same (move / delete by word)
    let key = e.key, code = e.code, keyCode = e.keyCode;
    let mods = altGr ? (e.shiftKey ? 8 : 0) : modifiers(e);
    if (IS_MAC && !altGr) {
      const shift = e.shiftKey ? 8 : 0;
      if (key === "Meta") { key = "Control"; code = "ControlLeft"; keyCode = 17; mods = shift | (event === "keyDown" ? 2 : 0); }
      else if (e.metaKey && (key === "ArrowLeft" || key === "ArrowRight")) {
        const home = key === "ArrowLeft";
        key = code = home ? "Home" : "End"; keyCode = home ? 36 : 35; mods = shift;
      } else if (e.metaKey && (key === "ArrowUp" || key === "ArrowDown")) {
        const home = key === "ArrowUp";
        key = code = home ? "Home" : "End"; keyCode = home ? 36 : 35; mods = shift | 2;
      } else if (e.metaKey) mods = shift | 2 | (e.altKey ? 1 : 0);
      else if (e.altKey && !e.ctrlKey && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(key)) mods = shift | 2;
    }
    // Editing shortcuts need naming: a forwarded key press doesn't run them.
    let commands: string[] | undefined;
    if (mod && !e.altKey) {
      if (k === "a" && !e.shiftKey) commands = ["selectAll"];
      else if (k === "z") commands = [e.shiftKey ? "redo" : "undo"];
      else if (k === "y" && !e.shiftKey) commands = ["redo"];
    }
    send({
      type: "key", event,
      key, code, keyCode,
      text: event === "keyDown" && e.key.length === 1 && !mod ? e.key : (e.key === "Enter" && event === "keyDown" ? "\r" : undefined),
      modifiers: mods,
      commands,
    });
  }

  const shownTab = tabs.find((t) => t.id === activeTab);
  return (
    <div className="flex flex-col w-full h-full bg-white">
      {!watchOnly && tabs.length ? (
        <div className="shrink-0 flex items-end gap-0.5 px-1.5 pt-1 bg-slate-100 border-b border-slate-200 overflow-x-auto" role="tablist" aria-label="Hosted browser tabs">
          {tabs.map((t) => {
            const on = t.id === activeTab;
            return (
              <div key={t.id} role="tab" aria-selected={on} title={t.url || t.title}
                onClick={() => { if (!on) tabAction("select", t.id); }}
                className={"group flex items-center gap-1.5 min-w-0 max-w-[200px] rounded-t-md pl-2.5 pr-1.5 py-1 text-xs cursor-pointer select-none " +
                  (on ? "bg-white text-slate-900 font-medium border border-b-0 border-slate-200 -mb-px" : "text-slate-600 hover:bg-slate-200")}>
                <span className="truncate">{t.title || "New window"}</span>
                {t.main ? null : (
                  <button type="button" aria-label={`Close ${t.title || "tab"}`}
                    onClick={(e) => { e.stopPropagation(); tabAction("close", t.id); }}
                    className="shrink-0 rounded px-1 leading-none text-slate-400 hover:text-slate-900 hover:bg-slate-300">×</button>
                )}
              </div>
            );
          })}
          {tabs.length < 9 ? (
            <button type="button" onClick={() => tabAction("new")} title="New FreightPOP tab" aria-label="New FreightPOP tab"
              className="shrink-0 mb-0.5 ml-0.5 rounded px-2 py-0.5 text-sm leading-none text-slate-500 hover:text-slate-900 hover:bg-slate-200">+</button>
          ) : null}
          {shownTab && !shownTab.main && /^https?:/i.test(shownTab.url) ? (
            <a href={shownTab.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 mb-1 px-1.5 text-[11px] text-sky-700 hover:underline whitespace-nowrap">Open in my browser</a>
          ) : null}
        </div>
      ) : null}
    <div ref={wrapRef} className="relative flex-1 min-h-0 w-full overflow-hidden bg-white">
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
        onCopy={(e) => onCopy(e, false)}
        onCut={(e) => onCopy(e, true)}
        // Nothing should ever accumulate here (keys are preventDefault'ed),
        // but clear defensively so IME/dead keys can't leave text behind.
        onInput={(e) => { e.currentTarget.value = ""; }}
      />
      {copyNote ? (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 z-20 rounded-lg bg-slate-900/90 text-white text-xs px-3 py-1.5 shadow">
          {copyNote}
        </div>
      ) : null}
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
          // Right-click = copy: the selected text, or the number/word under
          // the pointer. Not forwarded — the remote browser's own right-click
          // menu can't be seen or used from here.
          if (e.button === 2) {
            send({ type: "copyAt", id: Date.now(), x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });
            return;
          }
          mouse(e, "mousePressed", e.detail || 1);
        }}
        onMouseUp={(e) => { if (e.button !== 2) mouse(e, "mouseReleased", e.detail || 1); }}
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
            {status === "connecting" ? (target === "invoicing" ? "Connecting to the invoicing session…" : watchOnly ? "Connecting to the scrape…" : "Connecting to hosted FreightPOP…")
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
    </div>
  );
});
