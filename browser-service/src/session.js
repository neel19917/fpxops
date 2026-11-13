import { acquireUserBrowser, openWindowPage, ExtensionContexts, noteUrl, dashboardUrlFor, watchAuth, isAuthExpired, clearAuthExpired } from "./browser.js";
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
  // Never park one window twice: two entries for it would hand the same
  // window to two connections, or let dropParked close it while in use.
  const dup = list.find((e) => e.page === page);
  if (dup) {
    console.warn(`[ws] ${email}: window already parked — not parking it again`);
    if (dup.lease !== lease) lease.release();
    return;
  }
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
//   { type: "key", event: "keyDown"|"keyUp", key, code, keyCode, text, modifiers, commands }
//   { type: "insertText", text }                 // paste
//   { type: "copy", id }                         // Ctrl/Cmd+C / +X: selected text (for X the dashboard then sends Delete)
//   { type: "copyAt", id, x, y }                 // right-click: selection, or the word under the pointer
//   { type: "tab", action: "select"|"close"|"new", id }   // tabs: "main" or an id from the tabs list
//   { type: "nav", action: "back"|"forward"|"reload"|"goto", url }
//   { type: "bridge", id, payload: { type: "fpxFilter", column, value } | { type: "fpxOpenTracking", trackingNumber } }
//   { type: "pause" } | { type: "resume" }       // stop / restart the picture (hidden tab, closed panel)
//
// Server → client:
//   binary frames: JPEG screencast frames
//   { type: "ready", watchOnly, resumed? }       // resumed: true = a kept window, still on whatever page
//                                                // (and shipment popup) its last viewer left it on
//   { type: "url", url } | { type: "bridgeReady", ready }
//   { type: "bridgeAck", id, ack } | { type: "error", error }
//   { type: "copyResult", id, text }
//   { type: "selection", text }                  // what is selected now (for instant copy)
//   { type: "tabs", active, tabs: [{ id, title, url, main }] }   // the FreightPOP tab + windows opened from it
//   { type: "ended", reason }                    // followed by a close the dashboard does not retry (4004, 4010)
//
// Close codes sent from here: 4004 nothing to watch / scrape finished,
// 4010 idle, 4012 the view's window closed (the dashboard reconnects, as it
// does for any code it has no special case for).
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
    // Read by index.js (read-only there): `paused` = the dashboard said this
    // view is hidden, so no picture is being sent; `lastInputAt` = time (ms)
    // of the last click / key / navigation / lookup, or of creation.
    this.paused = false;
    this.lastInputAt = Date.now();
    this.viewport = { width: 1280, height: 800, dpr: 1 };
    this.bridgeReadyLast = null;
    // Extra tabs next to the FreightPOP tab: windows FreightPOP opened
    // (labels, documents, carrier links) and tabs the user added. `active`
    // is the one on show; null = the FreightPOP tab itself.
    this.popups = [];
    this.active = null;
    this.tabSeq = 0;
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // The tab on show.
  get vpage() { return this.active ? this.active.page : this.page; }
  get vcdp() { return this.active ? this.active.cdp : this.cdp; }

  // Forward screencast frames from `cdp`, but only while it is the tab on show.
  attachCast(cdp) {
    cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      // Ack first so Chrome keeps producing frames; drop frames if the socket
      // is backed up (slow client) instead of queueing unboundedly.
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (cdp !== this.vcdp) return;
      if (this.ws.readyState === 1 && this.ws.bufferedAmount < 2_000_000) {
        const buf = Buffer.from(data, "base64");
        countEgress(buf.length);
        this.ws.send(buf, { binary: true });
      }
    });
  }

  // Put a tab on show (null = the FreightPOP tab): stop streaming the old
  // one, size and stream the new one. Serialized so quick clicks can't interleave.
  showTab(tab) {
    const run = async () => {
      if (this.closed) return;
      if (tab && !this.popups.includes(tab)) tab = null;
      if (tab !== this.active) {
        await this.vcdp.send("Page.stopScreencast").catch(() => {});
        this.active = tab;
      }
      await this.applyViewport().catch(() => {});
      await this.vpage.bringToFront().catch(() => {});
      if (!this.paused) await this.startCast().catch(() => {});
      this.sendTabs();
      // A page that isn't repainting sends no screencast frame, which would
      // leave the previous tab's picture on screen. Send one still now.
      // (Skipped while paused — resumeCast() sends it when the view is shown.)
      await this.sendStill();
    };
    this.tabChain = (this.tabChain || Promise.resolve()).then(run, run);
    return this.tabChain;
  }

  // One still picture of the tab on show, sent like a screencast frame.
  // Chrome only produces screencast frames when the page repaints, so a page
  // that is sitting still would otherwise leave the dashboard's canvas blank
  // or showing an old picture after a tab switch, a resume or a reconnect.
  async sendStill() {
    const cdp = this.vcdp;
    const open = () => !this.closed && !this.paused && cdp === this.vcdp && this.ws.readyState === 1 && this.ws.bufferedAmount < 2_000_000;
    if (!cdp || !open()) return;
    // Bounded: a screenshot of a window Chrome isn't drawing can take very
    // long, and callers wait for this inside the tab queue.
    let timer;
    const shot = await Promise.race([
      cdp.send("Page.captureScreenshot", { format: "jpeg", quality: setting("browser.stream_quality") }).catch(() => null),
      new Promise((r) => { timer = setTimeout(r, 5000, null); }),
    ]);
    clearTimeout(timer);
    if (!shot?.data || !open()) return;
    const buf = Buffer.from(shot.data, "base64");
    countEgress(buf.length);
    this.ws.send(buf, { binary: true });
  }

  // The dashboard shows this view again after a pause: restart the stream
  // and send a still at once (a tab that loaded in the background pauses
  // right after "ready", so without the still its canvas stays blank until
  // FreightPOP happens to repaint). Queued with tab switches so the cast and
  // the still are for the tab that is on show when it runs.
  resumeCast() {
    const run = async () => {
      if (this.closed || this.paused) return; // paused again meanwhile
      await this.startCast().catch(() => {});
      await this.sendStill();
    };
    this.tabChain = (this.tabChain || Promise.resolve()).then(run, run);
    return this.tabChain;
  }

  // FreightPOP opened a new window (print labels / BOL, documents, carrier
  // links), or the user added a tab. It becomes a tab and is shown.
  // (Pop-ups used to be closed at once and their URL loaded in the main tab —
  // but a new window has no URL yet at that moment, so nothing appeared.)
  async openPopup(p) {
    if (this.closed || this.watchOnly || this.popups.length >= 8) { p.close().catch(() => {}); return; }
    try {
      const cdp = await p.createCDPSession();
      const tab = { id: `t${++this.tabSeq}`, page: p, cdp };
      this.attachCast(cdp);
      p.on("popup", this.onPopup);
      p.on("framenavigated", (f) => { if (f === p.mainFrame()) this.sendTabs(); });
      p.on("load", () => this.sendTabs());
      p.once("close", () => this.popupClosed(tab).catch(() => {}));
      this.popups.push(tab);
      await this.showTab(tab);
      console.log(`[tab] ${this.who.email} opened ${p.url().slice(0, 120)} (${this.popups.length + 1} tabs)`);
    } catch (e) {
      console.warn(`[tab] ${this.who.email}: ${e.message}`);
      this.popups = this.popups.filter((x) => x.page !== p);
      this.sendTabs();
    }
  }

  async popupClosed(tab) {
    const i = this.popups.indexOf(tab);
    if (i < 0) return;
    this.popups.splice(i, 1);
    try { await tab.cdp.detach(); } catch {}
    if (this.closed) return;
    if (this.active === tab) {
      // Its window is gone: fall back to the tab on its left.
      this.active = null;
      await this.showTab(this.popups[i - 1] || null);
    } else this.sendTabs();
  }

  // Text selected in a page: any frame, or the focused input.
  async readSelection(page) {
    let text = "";
    for (const f of page.frames()) {
      text = await f.evaluate(() => {
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "password" && typeof el.selectionStart === "number" && el.selectionEnd > el.selectionStart) {
          return el.value.slice(el.selectionStart, el.selectionEnd);
        }
        return String(window.getSelection?.() || "");
      }).catch(() => "");
      if (text && text.trim()) break;
    }
    return String(text || "").slice(0, 100_000);
  }

  // Keep the dashboard told what is selected, so Ctrl/Cmd+C there can fill
  // the user's clipboard at once (browsers refuse a clipboard write that
  // arrives later, after a round trip). Sent shortly after input settles.
  queueSelection() {
    if (this.watchOnly || this.closed) return;
    clearTimeout(this.selTimer);
    this.selTimer = setTimeout(async () => {
      const page = this.vpage;
      if (this.closed || !page) return;
      const text = await this.readSelection(page).catch(() => "");
      if (text !== this.selLast) { this.selLast = text; this.send({ type: "selection", text }); }
    }, 150);
  }

  // Tell the dashboard which tabs exist (titles are read from the pages).
  sendTabs() {
    const run = async () => {
      if (this.closed || this.watchOnly) return;
      const tabs = [{ id: "main", title: "FreightPOP", url: "", main: true }];
      try { tabs[0].url = this.page.url(); } catch {}
      for (const t of [...this.popups]) {
        let url = "", title = "";
        try { url = t.page.url(); title = await t.page.title(); } catch {}
        if (!title) { try { title = url && url !== "about:blank" ? new URL(url).hostname : "New window"; } catch { title = "New window"; } }
        tabs.push({ id: t.id, title: title.slice(0, 60), url, main: false });
      }
      this.send({ type: "tabs", active: this.active ? this.active.id : "main", tabs });
    };
    this.tabsSend = (this.tabsSend || Promise.resolve()).then(run, run);
    return this.tabsSend;
  }

  // close() can land while this is still waiting for the browser, the window
  // or the page (the view was replaced by a newer tab, or the dashboard tab
  // was closed). close() tears down what the session holds at that moment;
  // every wait in here is followed by a `closed` check that gives back only
  // what that wait returned and stops — otherwise this kept setting up, and
  // navigating, a window nobody owns (or one already kept for the next viewer).
  async start() {
    try { await this.open(); } catch (e) {
      // Closed meanwhile: the step in flight failed because close() took the
      // window away. Nothing to report, and close() has done the cleanup.
      if (!this.closed) throw e;
    }
  }

  async open() {
    this.startedAt = Date.now();
    if (this.watchOnly) {
      this.page = scrapePageFor(this.who.email);
      if (!this.page) { this.send({ type: "ended", reason: "No scrape is running in your browser" }); this.ws.close(4004, "no scrape"); return; }
      this.onPageClose = () => { this.send({ type: "ended", reason: "Scrape finished" }); try { this.ws.close(4004, "scrape ended"); } catch {} };
      // on(), not once(): puppeteer's once() wraps the handler, and close()
      // could then not remove it.
      this.page.on("close", this.onPageClose);
    } else {
      const resumed = takeParked(this.who.email);
      if (resumed) {
        this.lease = resumed.lease;
        this.page = resumed.page;
        this.resumed = true;
        this.parkable = true;
      } else {
        const lease = await acquireUserBrowser(this.who.email);
        if (this.closed) { lease.release(); return; }
        this.lease = lease;
        const page = await openWindowPage(lease.browser, null);
        // close() released the lease; this blank window is ours to close.
        if (this.closed) { page.close().catch(() => {}); return; }
        this.page = page;
      }
    }
    // false = closed meanwhile (close() detaches this.cdp and deals with the page).
    const attach = async () => {
      const cdp = await this.page.createCDPSession();
      if (this.closed) { cdp.detach().catch(() => {}); return false; }
      this.cdp = cdp;
      this.ext = new ExtensionContexts(this.cdp);
      await this.ext.init();
      return !this.closed;
    };
    try { if (!(await attach())) return; } catch (e) {
      // Closed while attaching: that is why it failed — not a crashed window.
      if (this.closed) return;
      // The window's page has crashed ("Target crashed") or gone. A kept
      // (parked) window in that state used to be handed back on every
      // reconnect, so the view never recovered. Replace it with a new one.
      if (this.watchOnly || !this.lease) throw e;
      console.warn(`[ws] ${this.who.email}: window unusable (${e.message}) → opening a new one`);
      this.page.close().catch(() => {});
      this.resumed = false;
      this.parkable = false;
      this.crashed = true; // until the new window attaches, never park this
      const page = await openWindowPage(this.lease.browser, null);
      if (this.closed) { page.close().catch(() => {}); return; }
      this.page = page;
      if (!(await attach())) return;
      this.crashed = false;
    }
    if (!this.watchOnly) {
      // Renderer crash while in use: don't keep this window for the next connection.
      this.onPageError = (e) => { this.crashed = true; console.warn(`[ws] ${this.who.email}: page crashed (${e?.message || e})`); };
      this.page.on("error", this.onPageError);
      // The window itself closed under a live view (FreightPOP closed it, or
      // Chrome did). Frames just stopped and the dashboard sat on a frozen
      // picture with the socket open. End the view with a code the dashboard
      // has no special case for, so it reconnects and gets a new window.
      this.onPageClose = () => {
        if (this.closed) return;
        this.pageGone = true; // nothing left to park (isClosed() is still false in this event)
        console.warn(`[ws] ${this.who.email}: window closed under a live view → ending it`);
        this.send({ type: "error", error: "The FreightPOP window closed — opening a new one…" });
        try { this.ws.close(4012, "window closed"); } catch {}
      };
      this.page.on("close", this.onPageClose);
    }

    this.attachCast(this.cdp);
    // Page-level listeners only on pages we own — a watcher must not change
    // the scrape window's behaviour (or leak listeners onto it).
    // Kept as fields so close() can remove them before the page is parked.
    if (!this.watchOnly) {
      this.onNav = (f) => {
        if (f === this.page.mainFrame()) {
          this.send({ type: "url", url: f.url() });
          this.sendTabs();
          this.checkSignedIn(f.url()).catch(() => {});
        }
      };
      // Popups (FreightPOP opens some docs in new windows) — show them in
      // the view until closed (see openPopup).
      this.onPopup = (p) => { if (p) this.openPopup(p).catch(() => {}); };
      this.page.on("framenavigated", this.onNav);
      this.page.on("popup", this.onPopup);
      // Expired FreightPOP login: drop the stale "user" record (otherwise
      // FreightPOP's sign-in page bounces straight back to the blank
      // dashboard) and show the sign-in form.
      this.offAuth = watchAuth(this.page, this.who.email, async () => {
        try {
          // The keep-alive may have renewed the login while this page kept
          // using its old token: a saved login that's still good → reload.
          const left = await this.page.evaluate(() => {
            try { return Date.parse(JSON.parse(localStorage.getItem("user") || "{}").User_State?.AccessTokenExpiryTime || "") - Date.now(); } catch { return NaN; }
          }).catch(() => NaN);
          if (left > 5 * 60_000 && Date.now() - (this.lastRenewReload || 0) > 60_000) {
            this.lastRenewReload = Date.now();
            clearAuthExpired(this.who.email);
            console.log(`[auth] ${this.who.email}: page had an old token, saved login is renewed → reload`);
            await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
            return;
          }
          this.send({ type: "signedIn", value: false });
          this.signedInLast = false;
          await this.page.evaluate(() => { try { localStorage.removeItem("user"); } catch {} }).catch(() => {});
          noteUrl(this.who.email, this.page.url(), false);
          this.lastSignInRedirect = Date.now();
          console.log(`[auth] ${this.who.email} → sign-in page`);
          await this.page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
        } catch {}
      }, () => {
        // Signed back in: tell the dashboard now, not on the next page load.
        this.signedInLast = true;
        this.send({ type: "signedIn", value: true });
        noteUrl(this.who.email, this.page.url(), true);
      });
      // Poll for the content script so the dashboard's "Ext" pill is accurate.
      this.readyTimer = setInterval(() => this.reportBridgeReady(), 1000);
    }

    if (!this.watchOnly) await this.applyViewport();
    if (this.closed) return;
    await this.startCast();
    // Checked before the timers and listeners below, which close() would
    // otherwise never get to clear.
    if (this.closed) return;
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
    // `resumed` (optional; older dashboards ignore it): this is a kept
    // window, so it may still show the shipment its previous viewer had open
    // until this viewer's own lookup lands. It is not reloaded or reset here —
    // a fast reconnect onto the same page is the point of keeping it — so
    // the dashboard is told and can show its own "loading" state.
    this.send({ type: "ready", watchOnly: this.watchOnly, ...(this.resumed ? { resumed: true } : {}) });
    this.sendTabs();
    if (this.watchOnly || this.resumed) {
      this.send({ type: "url", url: this.page.url() });
      // An already-loaded page may not repaint, so no frame would come.
      this.sendStill().catch(() => {});
      return;
    }
    // Open on the user's dashboard so the shipment grid is there for
    // Filter / Open tracking (the bare site root lands elsewhere).
    // Signed out → FreightPOP's sign-in page. (The Broker dashboard draws its
    // menu bar when signed out, then crashes with a blank body.)
    const start = config.startUrl !== "https://app.freightpop.com/" ? config.startUrl
      : (await this.signedIn()) ? dashboardUrlFor(this.who.email) : SIGN_IN_URL;
    if (this.closed) return;
    // From here the window is worth keeping for the next connection. Before
    // this it is a blank window, and a kept window is never navigated again,
    // so parking it would leave the next viewer on an empty page.
    this.parkable = true;
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
      // Paused or closed while this was waiting its turn: stay stopped.
      if (this.paused || this.closed) return;
      const cdp = this.vcdp;
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: setting("browser.stream_quality"),
        everyNthFrame: setting("browser.stream_every_nth_frame"),
        maxWidth: this.viewport.width, maxHeight: this.viewport.height,
      }).catch((e) => { if (!/already active/i.test(e.message)) throw e; });
    };
    this.castChain = (this.castChain || Promise.resolve()).then(run, run);
    return this.castChain;
  }

  // Stop streaming. In the same queue as startCast, so a pause that arrives
  // while a (re)start is in flight stops it afterwards instead of losing the race.
  stopCast() {
    const run = () => this.vcdp?.send("Page.stopScreencast").catch(() => {});
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
    await this.vcdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: dpr, mobile: false,
    });
  }

  async handle(msg) {
    // Input can arrive while the window is still opening (or after close);
    // drop it rather than throwing — except the viewport, which start() reads.
    if (this.closed) return;
    // Pause/resume apply to watchers too (closing the live view panel).
    if (this.cdp && msg.type === "pause") {
      if (!this.paused) { this.paused = true; await this.stopCast(); }
      return;
    }
    if (this.cdp && msg.type === "resume") {
      if (this.paused) { this.paused = false; await this.resumeCast(); }
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
        if (msg.event === "mouseReleased") this.queueSelection();
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
        if (msg.event === "keyUp") this.queueSelection();
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
          // Editing shortcuts (select all, undo, cut…) named by the dashboard:
          // a key event sent this way doesn't run them by itself.
          commands: msg.event !== "keyUp" && Array.isArray(msg.commands) ? msg.commands.filter((c) => KEY_COMMANDS.has(c)) : undefined,
        });
      }
      case "copy":
      case "copyAt": {
        // Ctrl/Cmd+C in the dashboard: hand back the text selected in
        // FreightPOP (any frame, or the focused input) so the dashboard can
        // put it on the user's own clipboard. Right-click (copyAt) does the
        // same, and with nothing selected copies the word under the pointer
        // (a tracking number, a PRO, a reference) and highlights it.
        const page = this.vpage;
        if (this.watchOnly || !page) return;
        let text = await this.readSelection(page);
        if (!(text && text.trim()) && msg.type === "copyAt") {
          text = await page.evaluate((x, y) => {
            let doc = document, el = doc.elementFromPoint(x, y);
            // Same-origin iframe (some FreightPOP pop-ups): look inside it.
            while (el && el.tagName === "IFRAME") {
              try {
                const r = el.getBoundingClientRect();
                x -= r.left; y -= r.top; doc = el.contentDocument;
                el = doc.elementFromPoint(x, y);
              } catch { return ""; }
            }
            if (!el) return "";
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.type === "password" ? "" : String(el.value || "");
            const range = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, y) : null;
            const node = range && range.startContainer;
            if (node && node.nodeType === 3 && el.contains(node)) {
              const t = node.data;
              let a = Math.min(range.startOffset, t.length), b = a;
              while (a > 0 && !/\s/.test(t[a - 1])) a--;
              while (b < t.length && !/\s/.test(t[b])) b++;
              // Trim punctuation around the word ("210991346," → "210991346").
              while (a < b && /[,;:()\[\]"']/.test(t[a])) a++;
              while (b > a && /[,;:()\[\]"'.]/.test(t[b - 1])) b--;
              if (b > a) {
                try {
                  const w = doc.createRange(); w.setStart(node, a); w.setEnd(node, b);
                  // Only when the pointer is really on the word, not in blank space beside it.
                  const hit = [...w.getClientRects()].some((r) => x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4);
                  if (!hit) return "";
                  const sel = doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(w);
                } catch {}
                return t.slice(a, b);
              }
            }
            return "";
          }, Number(msg.x) || 0, Number(msg.y) || 0).catch(() => "");
        }
        this.queueSelection();
        this.send({ type: "copyResult", id: msg.id, text: String(text || "").slice(0, 100_000), at: msg.type === "copyAt" });
        return;
      }
      case "tab": {
        if (msg.action === "select") return this.showTab(this.popups.find((t) => t.id === msg.id) || null);
        if (msg.action === "close") {
          const t = this.popups.find((x) => x.id === msg.id);
          if (t) await t.page.close().catch(() => {});
          return;
        }
        if (msg.action === "new" && this.lease && this.popups.length < 8) {
          // A second FreightPOP tab in the same browser (same login).
          const url = (await this.signedIn()) ? dashboardUrlFor(this.who.email) : SIGN_IN_URL;
          const p = await openWindowPage(this.lease.browser, null);
          await this.openPopup(p);
          p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        }
        return;
      }
      case "insertText":
        if (typeof msg.text === "string" && msg.text.length <= 10_000) {
          return this.vcdp.send("Input.insertText", { text: msg.text });
        }
        return;
      case "nav":
        if (msg.action === "back") return this.vpage.goBack().catch(() => {});
        if (msg.action === "forward") return this.vpage.goForward().catch(() => {});
        if (msg.action === "reload") return this.vpage.reload().catch(() => {});
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
    if (isAuthExpired(this.who.email)) return false;
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
      const r = await this.vcdp.send(method, params);
      this.inputErrors = 0;
      return r;
    } catch (e) {
      if (!/Internal error/i.test(e.message)) throw e;
      this.inputErrors = (this.inputErrors || 0) + 1;
      const now = Date.now();
      if (this.inputErrors >= 5 && !this.watchOnly && this.page && !this.active && now - (this.lastAutoReload || 0) > 30_000) {
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

  // Called more than once for one session: index.js closes a replaced view
  // itself AND the socket's "close" event closes it again. Both get the same
  // teardown — run twice, the second run parked the window a second time
  // while the first was still waiting on Chrome.
  close() {
    if (!this.closing) this.closing = this.teardown();
    return this.closing;
  }

  async teardown() {
    this.closed = true;
    clearInterval(this.readyTimer);
    clearInterval(this.idleTimer);
    clearTimeout(this.selTimer);
    this.offSettings?.();
    // Extra tabs don't outlive the view: a parked tab comes back without them.
    this.active = null;
    for (const pop of this.popups.splice(0)) {
      try { await pop.cdp.detach(); } catch {}
      pop.page.close().catch(() => {});
    }
    try { await this.cdp?.send("Page.stopScreencast"); } catch {}
    try { await this.cdp?.detach(); } catch {}
    if (this.lease) recordSession(this.who.email, Date.now() - (this.startedAt || Date.now()));
    // Also for a watcher: don't leave its listener on the scrape window.
    if (this.page && this.onPageClose) this.page.off("close", this.onPageClose);
    if (this.ownsPage && this.page && this.lease) {
      if (this.onNav) this.page.off("framenavigated", this.onNav);
      this.offAuth?.();
      if (this.onPopup) this.page.off("popup", this.onPopup);
      if (this.onPageError) this.page.off("error", this.onPageError);
      // Crashed, already gone, or closed before start() got it onto a
      // FreightPOP page (see `parkable`): not worth keeping.
      if (this.crashed || this.pageGone || !this.parkable) {
        this.page.close().catch(() => {});
        this.lease.release();
      } else if (!this.page.isClosed() && this.lease.browser.connected) {
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

// Editing commands the dashboard may attach to a key event.
const KEY_COMMANDS = new Set(["selectAll", "undo", "redo"]);

const SIGN_IN_URL = "https://app.freightpop.com/";
const FP_COOKIE_URLS = ["https://app.freightpop.com/", "https://app.freightpop.com/Broker/Broker.html", "https://app.freightpop.com/app/"];

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo)); }
