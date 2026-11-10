import { acquireUserBrowser, openWindowPage, ExtensionContexts, noteUrl, dashboardUrlFor } from "./browser.js";
import { recordSession } from "./usage.js";
import { scrapePageFor } from "./worker.js";
import { get as setting, onChange as onSettingsChange } from "./settings.js";

// Live-view data sent, in 1-minute buckets for the last hour (admin cost view).
const egress = new Map(); // minute -> bytes
export function egressStats() {
  const now = Math.floor(Date.now() / 60_000);
  let lastHour = 0, last5 = 0;
  for (const [m, b] of egress) {
    if (m < now - 60) { egress.delete(m); continue; }
    lastHour += b;
    if (m >= now - 5) last5 += b;
  }
  return { mbLastHour: +(lastHour / 1e6).toFixed(1), mbLast5Min: +(last5 / 1e6).toFixed(1) };
}
function countEgress(bytes) {
  const m = Math.floor(Date.now() / 60_000);
  egress.set(m, (egress.get(m) || 0) + bytes);
}
import { config } from "./config.js";

const FP_HOST = /^https:\/\/([a-z0-9-]+\.)*freightpop\.com(\/|$)/i;

// When a viewer disconnects (reload, flaky network, tab replaced), its window
// is kept — still logged in, same page, same grid filter — and handed to that
// user's next connection. Without this every reconnect opened a fresh window
// on the start page and the Tracking pane appeared to "reset".
const PARK_MS = 10 * 60_000;
const MAX_PARKED_PER_USER = 2;
const parked = new Map(); // email -> [{ page, lease, timer }]

function park(email, page, lease) {
  const list = parked.get(email) || [];
  const entry = { page, lease };
  entry.timer = setTimeout(() => dropParked(email, entry), PARK_MS);
  list.push(entry);
  parked.set(email, list);
  while (list.length > MAX_PARKED_PER_USER) dropParked(email, list[0]);
}

function dropParked(email, entry) {
  const list = parked.get(email) || [];
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  clearTimeout(entry.timer);
  entry.page.close().catch(() => {});
  entry.lease.release();
}

// Close every parked window of this user (login reset).
export function dropAllParked(email) {
  for (const entry of [...(parked.get(email) || [])]) dropParked(email, entry);
  parked.delete(email);
}

// Newest parked window that's still alive, or null.
function takeParked(email) {
  const list = parked.get(email) || [];
  while (list.length) {
    const entry = list.pop();
    clearTimeout(entry.timer);
    if (!entry.page.isClosed() && entry.lease.browser.connected) return entry;
    entry.lease.release();
  }
  return null;
}

// One dashboard viewer ↔ one window in THAT USER'S own Chromium (their own
// profile + FreightPOP login; see browser.js).
//
// Client → server (JSON text frames):
//   { type: "viewport", width, height, dpr }
//   { type: "mouse", event: "mousePressed"|"mouseReleased"|"mouseMoved"|"mouseWheel",
//     x, y, button, clickCount, deltaX, deltaY, modifiers }
//   { type: "key", event: "keyDown"|"keyUp", key, code, keyCode, text, modifiers }
//   { type: "insertText", text }                 // paste
//   { type: "nav", action: "back"|"forward"|"reload"|"goto", url }
//   { type: "bridge", id, payload: { type: "fpxFilter", column, value } | { type: "fpxOpenTracking", trackingNumber } }
//
// Server → client:
//   binary frames: JPEG screencast frames
//   { type: "ready" } | { type: "url", url } | { type: "bridgeReady", ready }
//   { type: "bridgeAck", id, ack } | { type: "error", error }
export class ViewerSession {
  // target "scrape": attach read-only to the user's running scrape window
  // instead of opening a new one. Input and viewport changes are ignored so a
  // viewer can't disturb the grid the extension is scraping.
  constructor(ws, who, { target = "tab" } = {}) {
    this.ws = ws;
    this.who = who;
    this.watchOnly = target === "scrape";
    this.ownsPage = !this.watchOnly;
    this.page = null;
    this.cdp = null;
    this.ext = null;
    this.closed = false;
    this.viewport = { width: 1280, height: 800, dpr: 1 };
    this.bridgeReadyLast = null;
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async start() {
    this.startedAt = Date.now();
    if (this.watchOnly) {
      this.page = scrapePageFor(this.who.email);
      if (!this.page) { this.send({ type: "ended", reason: "No scrape is running in your browser" }); this.ws.close(4004, "no scrape"); return; }
      this.page.once("close", () => { this.send({ type: "ended", reason: "Scrape finished" }); try { this.ws.close(4004, "scrape ended"); } catch {} });
    } else {
      const resumed = takeParked(this.who.email);
      if (resumed) {
        this.lease = resumed.lease;
        this.page = resumed.page;
        this.resumed = true;
      } else {
        this.lease = await acquireUserBrowser(this.who.email);
        if (this.closed) { this.lease.release(); return; }
        this.page = await openWindowPage(this.lease.browser, null);
      }
    }
    this.cdp = await this.page.createCDPSession();
    this.ext = new ExtensionContexts(this.cdp);
    await this.ext.init();

    this.cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      // Ack first so Chrome keeps producing frames; drop frames if the socket
      // is backed up (slow client) instead of queueing unboundedly.
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (this.ws.readyState === 1 && this.ws.bufferedAmount < 2_000_000) {
        const buf = Buffer.from(data, "base64");
        countEgress(buf.length);
        this.ws.send(buf, { binary: true });
      }
    });
    // Page-level listeners only on pages we own — a watcher must not change
    // the scrape window's behaviour (or leak listeners onto it).
    // Kept as fields so close() can remove them before the page is parked.
    if (!this.watchOnly) {
      this.onNav = (f) => {
        if (f === this.page.mainFrame()) {
          this.send({ type: "url", url: f.url() });
          this.checkSignedIn(f.url()).catch(() => {});
        }
      };
      // Popups (FreightPOP opens some docs in new windows) — pull them into
      // this tab rather than spawning windows nobody can see.
      this.onPopup = async (p) => {
        try { const u = p.url(); await p.close(); if (u && u !== "about:blank") await this.page.goto(u); } catch {}
      };
      this.page.on("framenavigated", this.onNav);
      this.page.on("popup", this.onPopup);
      // Poll for the content script so the dashboard's "Ext" pill is accurate.
      this.readyTimer = setInterval(() => this.reportBridgeReady(), 1000);
    }

    if (!this.watchOnly) await this.applyViewport();
    await this.startCast();
    // Admin changed picture quality / frame skipping → re-apply live.
    this.offSettings = onSettingsChange(() => { if (!this.paused && !this.closed) this.startCast().catch(() => {}); });
    // Close the view after N minutes without clicks/keys (admin setting; 0 = off).
    this.lastInputAt = Date.now();
    if (!this.watchOnly) {
      this.idleTimer = setInterval(() => {
        const min = setting("browser.view_idle_min");
        if (!min || this.closed) return;
        if (Date.now() - this.lastInputAt > min * 60_000) {
          this.send({ type: "ended", reason: `Closed after ${min} min without activity` });
          try { this.ws.close(4010, "idle"); } catch {}
        }
      }, 30_000);
    }
    this.send({ type: "ready", watchOnly: this.watchOnly });
    if (this.watchOnly || this.resumed) { this.send({ type: "url", url: this.page.url() }); return; }
    // Open on the user's dashboard so the shipment grid is there for
    // Filter / Open tracking (the bare site root lands elsewhere).
    // Signed out → FreightPOP's sign-in page. (The Broker dashboard draws its
    // menu bar when signed out, then crashes with a blank body.)
    const start = config.startUrl !== "https://app.freightpop.com/" ? config.startUrl
      : (await this.signedIn()) ? dashboardUrlFor(this.who.email) : SIGN_IN_URL;
    await this.page.goto(start, { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch((e) => this.send({ type: "error", error: `Navigation failed: ${e.message}` }));
  }

  // Frames are sent at CSS-pixel size (1x) with moderate JPEG quality: the
  // encode cost scales with pixels, and 2x Retina frames were ~4x the work.
  // Serialized + idempotent: a viewport change can land while start() is
  // still starting the cast, which used to surface "Screencast is already
  // active" to the user. Restart = stop, then start, one at a time.
  async startCast() {
    const run = async () => {
      await this.cdp.send("Page.stopScreencast").catch(() => {});
      await this.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: setting("browser.stream_quality"),
        everyNthFrame: setting("browser.stream_every_nth_frame"),
        maxWidth: this.viewport.width, maxHeight: this.viewport.height,
      }).catch((e) => { if (!/already active/i.test(e.message)) throw e; });
    };
    this.castChain = (this.castChain || Promise.resolve()).then(run, run);
    return this.castChain;
  }

  reportBridgeReady() {
    const ready = this.ext?.ready || false;
    if (ready !== this.bridgeReadyLast) {
      this.bridgeReadyLast = ready;
      this.send({ type: "bridgeReady", ready });
    }
  }

  async applyViewport() {
    const { width, height, dpr } = this.viewport;
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: dpr, mobile: false,
    });
  }

  async handle(msg) {
    // Input can arrive while the window is still opening (or after close);
    // drop it rather than throwing — except the viewport, which start() reads.
    if (this.closed) return;
    // Pause/resume apply to watchers too (closing the live view panel).
    if (this.cdp && msg.type === "pause") {
      if (!this.paused) { this.paused = true; await this.cdp.send("Page.stopScreencast").catch(() => {}); }
      return;
    }
    if (this.cdp && msg.type === "resume") {
      if (this.paused) { this.paused = false; await this.startCast(); }
      return;
    }
    if (this.watchOnly) return; // read-only: no input, no resizing, no bridge
    if (["mouse", "key", "insertText", "nav", "bridge"].includes(msg.type)) this.lastInputAt = Date.now();
    if (!this.cdp) {
      if (msg.type === "viewport") {
        this.viewport = {
          width: clamp(Math.round(msg.width), 320, 2560),
          height: clamp(Math.round(msg.height), 240, 1600),
          dpr: 1,
        };
      }
      return;
    }
    switch (msg.type) {
      case "viewport": {
        const width = clamp(Math.round(msg.width), 320, 2560);
        const height = clamp(Math.round(msg.height), 240, 1600);
        const dpr = 1; // render + stream at 1x (see startCast)
        this.viewport = { width, height, dpr };
        await this.applyViewport();
        if (!this.paused) await this.startCast();
        return;
      }
      case "mouse":
        return this.input("Input.dispatchMouseEvent", {
          type: msg.event,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          button: msg.button || "none",
          buttons: Number(msg.buttons) || 0,
          clickCount: Number(msg.clickCount) || 0,
          deltaX: Number(msg.deltaX) || 0,
          deltaY: Number(msg.deltaY) || 0,
          modifiers: Number(msg.modifiers) || 0,
        });
      case "key": {
        const printable = typeof msg.text === "string" && msg.text.length > 0;
        return this.input("Input.dispatchKeyEvent", {
          type: msg.event === "keyUp" ? "keyUp" : (printable ? "keyDown" : "rawKeyDown"),
          key: msg.key,
          code: msg.code,
          windowsVirtualKeyCode: Number(msg.keyCode) || 0,
          nativeVirtualKeyCode: Number(msg.keyCode) || 0,
          text: msg.event === "keyUp" ? undefined : (printable ? msg.text : undefined),
          unmodifiedText: msg.event === "keyUp" ? undefined : (printable ? msg.text : undefined),
          modifiers: Number(msg.modifiers) || 0,
        });
      }
      case "insertText":
        if (typeof msg.text === "string" && msg.text.length <= 10_000) {
          return this.cdp.send("Input.insertText", { text: msg.text });
        }
        return;
      case "nav":
        if (msg.action === "back") return this.page.goBack().catch(() => {});
        if (msg.action === "forward") return this.page.goForward().catch(() => {});
        if (msg.action === "reload") return this.page.reload().catch(() => {});
        if (msg.action === "goto" && typeof msg.url === "string" && FP_HOST.test(msg.url)) {
          return this.page.goto(msg.url, { waitUntil: "domcontentloaded" }).catch(() => {});
        }
        return;
      case "bridge": {
        const ack = await this.bridgeOnce(msg.payload || {});
        // Diagnostics for FreightPOP lookups (which strategy, which field and
        // value, how many rows) — this is how grid-field mismatches get found.
        const p = msg.payload || {};
        if (p.type !== "fpxPing") {
          console.log(`[bridge] ${this.who.email} ${p.type} sid=${p.shipmentId || "-"} tn=${p.trackingNumber || p.value || "-"} → ok=${!!ack?.ok} strategy=${ack?.strategy || "-"} opened=${ack?.opened ?? "-"} err=${(ack?.error || "").slice(0, 160)} | ${(ack?.injectDetail || "").slice(0, 900)}`);
        }
        this.send({ type: "bridgeAck", id: msg.id, ack });
        return;
      }
      default:
        return;
    }
  }

  // Signed OUT of FreightPOP = no app.freightpop.com cookies AND nothing in
  // its localStorage. (A working, signed-in profile on Railway had no app
  // cookies — FreightPOP keeps its login in storage — so cookies alone would
  // wrongly flag it. A reset profile has neither; the Broker page then draws
  // only its menu and the Angular app throws on a null user.) Errs toward
  // "signed in": anything unknown never blocks a lookup.
  async signedIn() {
    try {
      const { cookies } = await this.cdp.send("Network.getCookies", { urls: FP_COOKIE_URLS });
      if (cookies.length) return true;
      const { entries } = await this.cdp.send("DOMStorage.getDOMStorageItems", { storageId: { storageKey: "https://app.freightpop.com/", isLocalStorage: true } });
      return entries.length > 0;
    } catch { return true; }
  }

  // After each main-frame navigation: remember the URL + signed-in state,
  // tell the dashboard, and send a signed-out user from an app page (which
  // would just render blank) to the sign-in page.
  async checkSignedIn(url) {
    if (!/freightpop\.com/i.test(url || "")) return;
    const ok = await this.signedIn();
    noteUrl(this.who.email, url, ok);
    if (ok !== this.signedInLast) {
      this.signedInLast = ok;
      this.send({ type: "signedIn", value: ok });
    }
    if (!ok && /\/Broker\/|\.html/i.test(url) && Date.now() - (this.lastSignInRedirect || 0) > 15_000) {
      this.lastSignInRedirect = Date.now();
      console.log(`[ws] ${this.who.email} signed out of FreightPOP on ${url} → sign-in page`);
      this.page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    }
  }

  // Mouse/keyboard into the page. Chrome answers "Internal error" while the
  // page has no live renderer (stuck on "Loading…", mid-crash). Mouse moves
  // fire constantly, so don't toast every failure: after a few in a row,
  // reload the page once (per 30s) and tell the user.
  async input(method, params) {
    try {
      const r = await this.cdp.send(method, params);
      this.inputErrors = 0;
      return r;
    } catch (e) {
      if (!/Internal error/i.test(e.message)) throw e;
      this.inputErrors = (this.inputErrors || 0) + 1;
      const now = Date.now();
      if (this.inputErrors >= 5 && !this.watchOnly && this.page && now - (this.lastAutoReload || 0) > 30_000) {
        this.lastAutoReload = now;
        this.inputErrors = 0;
        console.warn(`[ws] ${this.who.email}: page not taking input (${this.page.url()}) → reloading`);
        this.send({ type: "error", error: "FreightPOP stopped responding — reloading the page…" });
        const url = this.page.url();
        const to = /freightpop\.com\/app\//i.test(url) || !/freightpop\.com/i.test(url) ? dashboardUrlFor(this.who.email) : null;
        (to ? this.page.goto(to, { waitUntil: "domcontentloaded", timeout: 60_000 }) : this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })).catch(() => {});
      }
    }
  }

  // The iframe path re-sent deferred filters on fpxGridReady. Here we just
  // retry for up to a minute while the grid renders (or the user logs in).
  // One FreightPOP lookup at a time per view, and no duplicates. The
  // dashboard can fire the same lookup twice (auto-filter + auto-open); run
  // concurrently, each one's "clear filters" step wrecked the other's result
  // (once a "found" lookup left all 1,262 rows showing), and the second one's
  // "open popup" failed because the first had already opened it.
  bridgeOnce(payload) {
    if (payload.type !== "fpxFindShipment") return this.bridgeWithRetry(payload);
    const key = `${payload.shipmentId || ""}|${payload.trackingNumber || ""}`;
    const last = this.lastFind;
    const wantsOpen = !!payload.open;
    // Same shipment, in flight or just finished (8s), and it covered this
    // request (opened if asked to) → reuse its answer.
    if (last && last.key === key && (last.open || !wantsOpen) && (!last.done || Date.now() - last.done < 8000)) {
      return last.promise;
    }
    // Latest wins: clicking through tasks quickly used to queue every
    // lookup, so the grid kept flipping through old shipments for a minute.
    // A lookup still waiting when a newer one arrives is skipped.
    const gen = (this.findGen = (this.findGen || 0) + 1);
    const entry = { key, open: wantsOpen, done: 0 };
    const run = async () => {
      if (gen !== this.findGen) {
        entry.done = Date.now();
        return { ok: false, reason: "superseded", error: "Skipped — a newer lookup replaced this one." };
      }
      const ack = await this.bridgeWithRetry(payload, () => gen !== this.findGen);
      entry.done = Date.now();
      return ack;
    };
    entry.promise = (this.bridgeQueue = (this.bridgeQueue || Promise.resolve()).catch(() => {}).then(run));
    this.lastFind = entry;
    return entry.promise;
  }

  async bridgeWithRetry(payload, superseded = () => false) {
    if (!["fpxFindShipment", "fpxFilter", "fpxOpenTracking", "fpxPing"].includes(payload.type)) {
      return { ok: false, error: `Unsupported bridge command ${payload.type}` };
    }
    if (payload.type !== "fpxPing" && !this.watchOnly && !(await this.signedIn())) {
      this.checkSignedIn(this.page?.url() || "").catch(() => {});
      return { ok: false, reason: "signed-out", error: "You're not signed in to FreightPOP here — sign in in the FreightPOP pane (or More → FreightPOP login), then try again." };
    }
    const deadline = Date.now() + 60_000;
    let ack;
    let movedToDashboard = false;
    while (!this.closed) {
      ack = await this.ext.bridge(payload);
      const waiting = ack.reason === "grid-not-ready" || ack.reason === "no-extension";
      if (!waiting || Date.now() > deadline) break;
      if (superseded()) return { ok: false, reason: "superseded", error: "Skipped — a newer lookup replaced this one." };
      // The window is on a page with no shipment grid (an error page, a
      // shipment detail, settings…) — waiting won't help. Go to the user's
      // dashboard once, then keep retrying while the grid renders. Not on
      // the login page: the user has to sign in first.
      if (!movedToDashboard && !this.watchOnly && this.page && /no shipment grid on this view/i.test(ack.error || "")) {
        movedToDashboard = true;
        const url = dashboardUrlFor(this.who.email);
        console.log(`[bridge] ${this.who.email} not on a grid page (${this.page.url()}) → opening ${url}`);
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return ack;
  }

  async close() {
    this.closed = true;
    clearInterval(this.readyTimer);
    clearInterval(this.idleTimer);
    this.offSettings?.();
    try { await this.cdp?.send("Page.stopScreencast"); } catch {}
    try { await this.cdp?.detach(); } catch {}
    if (this.lease) recordSession(this.who.email, Date.now() - (this.startedAt || Date.now()));
    if (this.ownsPage && this.page && this.lease) {
      if (this.onNav) this.page.off("framenavigated", this.onNav);
      if (this.onPopup) this.page.off("popup", this.onPopup);
      if (!this.page.isClosed() && this.lease.browser.connected) {
        // Keep the window (and the browser lease) for this user's next connection.
        park(this.who.email, this.page, this.lease);
      } else {
        this.lease.release();
      }
    } else {
      this.lease?.release();
    }
    this.lease = null;
  }
}

const SIGN_IN_URL = "https://app.freightpop.com/";
const FP_COOKIE_URLS = ["https://app.freightpop.com/", "https://app.freightpop.com/Broker/Broker.html", "https://app.freightpop.com/app/"];

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo)); }
