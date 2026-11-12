import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { WebSocket } from "ws";
import { config } from "./config.js";

// One Chromium PER DASHBOARD USER, each with its own profile directory
// (/data/profiles/<hash of email>). Logins are never shared: every rep signs
// in to FreightPOP with their own account inside their own browser, and the
// FreightPOP cookies live only in that user's profile.
//
// A user's browser starts on first use and is closed after IDLE_CLOSE_MIN
// with no viewer tabs and no running scrape. Cookies (including session-only
// ones, which Chrome drops on exit) are snapshotted to the profile and
// restored on relaunch so the rep doesn't have to log in again every time.

const pool = new Map(); // key -> { email, promise, browser, extensionId, refs, busy, lastUsed, saveTimer }

export function profileKey(email) {
  return crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 24);
}
function profileDirFor(email) { return path.join(config.profileRoot, profileKey(email)); }
const cookieFile = (dir) => path.join(dir, "fpx-cookies.json");

export function hasProfile(email) {
  return fs.existsSync(cookieFile(profileDirFor(email)));
}

const stateFile = (email) => path.join(profileDirFor(email), "fpx-state.json");

// Remember where the user's FreightPOP tab last was, so we can say "logged in"
// vs "needs login" even while their browser is closed.
// FreightPOP keeps its "user" record in localStorage after the API token
// behind it expires; the Broker page then draws its menu and every API call
// (appbe.freightpop.com) answers 401. Watch those answers: several 401s and
// no successful call in between = the login is gone.
const authState = new Map(); // email -> { fails: [ts], expiredAt }
const FP_API = /^https:\/\/appbe\.freightpop\.com\//i;
export function isAuthExpired(email) {
  return !!authState.get(String(email).toLowerCase())?.expiredAt;
}
export function clearAuthExpired(email) {
  authState.delete(String(email).toLowerCase());
}
// onExpired fires once when this page's calls start failing.
export function watchAuth(page, email, onExpired, onRestored) {
  const key = String(email).toLowerCase();
  const handler = (res) => {
    let url; try { url = res.url(); } catch { return; }
    if (!FP_API.test(url)) return;
    const s = authState.get(key) || { fails: [], expiredAt: 0, paths: new Set() };
    const status = res.status();
    const path = url.replace(/[?#].*$/, "");
    // Some FreightPOP calls answer 200 without a login; only a success on a
    // call that was refused proves the user signed back in.
    if (status >= 200 && status < 300) { if (s.paths.has(path)) { const was = s.expiredAt; authState.delete(key); if (was) { console.log(`[auth] ${email}: FreightPOP accepts the login again`); try { onRestored?.(); } catch {} } } return; }
    if (status !== 401) return;
    s.paths.add(path);
    const now = Date.now();
    s.fails = s.fails.filter((t) => now - t < 20_000).concat(now);
    if (s.fails.length >= 3 && !s.expiredAt) {
      s.expiredAt = now;
      authState.set(key, s);
      console.log(`[auth] ${email}: FreightPOP API answers 401 — login expired`);
      try { onExpired?.(); } catch {}
      return;
    }
    authState.set(key, s);
  };
  page.on("response", handler);
  return () => page.off("response", handler);
}

export function noteUrl(email, url, signedIn = true) {
  if (!/^https:\/\/([a-z0-9-]+\.)*freightpop\.com/i.test(url || "")) return;
  const loggedIn = signedIn && !/#\/login|\/login\b|\/Account\/Login/i.test(url);
  writeState(email, { loggedIn, url, at: new Date().toISOString() });
}

// Merge into the user's fpx-state.json (keeps the email so background jobs —
// the login keep-alive — can find whose profile a folder is).
export function writeState(email, patch) {
  const prev = readState(email) || {};
  try { fs.writeFileSync(stateFile(email), JSON.stringify({ ...prev, ...patch, email: String(email).toLowerCase() })); } catch {}
}

// The account's dashboard (where the shipment grid lives):
// /Broker/Broker.html#!/Dashboard. Prefer the last real dashboard page this
// user was on (an app page — "…html#!/Dashboard"). NOT the bare /dashboard
// path: FreightPOP answers that with an IIS 404, and saving it once used to
// send every later view (and every lookup) to the 404 page.
export const DEFAULT_DASHBOARD_URL = "https://app.freightpop.com/Broker/Broker.html#!/Dashboard";
const APP_DASHBOARD_RE = /\.html#!?\/dashboard/i;
export function dashboardUrlFor(email) {
  if (config.trackingUrl) return config.trackingUrl;
  const last = readState(email);
  if (last?.loggedIn && APP_DASHBOARD_RE.test(last.url || "")) return last.url;
  return DEFAULT_DASHBOARD_URL;
}

export function readState(email) {
  try { return JSON.parse(fs.readFileSync(stateFile(email), "utf8")); } catch { return null; }
}

// Memory (MB, PSS) of a process and all its descendants, from /proc. Linux only.
function treeRssMb(rootPid) {
  if (!rootPid) return null;
  try {
    const kids = new Map();
    const rss = new Map();
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = fs.readFileSync(`/proc/${d}/status`, "utf8");
        const ppid = Number(/^PPid:\s+(\d+)/m.exec(st)?.[1]);
        // PSS splits shared pages (Chromium's processes share a lot) across
        // processes, so the tree sum isn't inflated. Fall back to RSS.
        let kb;
        try { kb = Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${d}/smaps_rollup`, "utf8"))?.[1]); } catch {}
        if (!Number.isFinite(kb)) kb = Number(/^VmRSS:\s+(\d+)/m.exec(st)?.[1] || 0);
        rss.set(Number(d), kb);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(Number(d));
      } catch { /* process exited */ }
    }
    let total = 0;
    const stack = [rootPid];
    while (stack.length) { const p = stack.pop(); total += rss.get(p) || 0; stack.push(...(kids.get(p) || [])); }
    return Math.round(total / 1024);
  } catch { return null; }
}

function entryStats(e) {
  return {
    user: e.email,
    tabs: e.refs,
    busy: e.busy,
    startedAt: e.startedAt ? new Date(e.startedAt).toISOString() : null,
    lastUsed: new Date(e.lastUsed).toISOString(),
    memoryMb: treeRssMb(e.browser?.process()?.pid),
  };
}

export function poolStats() {
  return [...pool.values()].map(entryStats);
}

export function userStatus(email) {
  const e = pool.get(profileKey(email));
  return {
    running: !!e?.browser,
    ...(e ? entryStats(e) : { user: email, tabs: 0, busy: false, memoryMb: null }),
    hasProfile: hasProfile(email),
    freightpop: readState(email),
  };
}

// Acquire the user's browser (launching it if needed). Callers must release().
export async function acquireUserBrowser(email, { busy = false } = {}) {
  if (!email) throw new Error("No user identity");
  const key = profileKey(email);
  let entry = pool.get(key);
  if (!entry) {
    const running = [...pool.values()];
    if (running.length >= config.maxBrowsers) {
      // Evict the longest-idle browser with nobody on it, if any.
      const idle = running.filter((e) => e.refs === 0 && !e.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) { const err = new Error("Hosted browser capacity reached — try again shortly"); err.code = "CAPACITY"; throw err; }
      await closeEntry(idle);
    }
    entry = { email, key, refs: 0, busy: false, lastUsed: Date.now(), browser: null, extensionId: null };
    entry.promise = launch(entry).catch((e) => { pool.delete(key); throw e; });
    pool.set(key, entry);
  }
  entry.refs++;
  if (busy) entry.busy = true;
  entry.lastUsed = Date.now();
  try {
    await entry.promise;
  } catch (e) {
    entry.refs--;
    throw e;
  }
  let released = false;
  return {
    browser: entry.browser,
    extensionId: entry.extensionId,
    // Idempotent: a lease can move between a session and the parked-window
    // pool, and a double release must not under-count the browser's users.
    release: () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (busy) entry.busy = false;
      entry.lastUsed = Date.now();
      saveCookies(entry).catch((e) => console.warn(`[browser] cookie save for ${entry.email} failed:`, e.message));
    },
  };
}

async function launch(entry) {
  const dir = profileDirFor(entry.email);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fpx-owner.json"), JSON.stringify({ email: entry.email }));
  // A crashed container leaves Chrome's singleton lock behind and the next
  // launch refuses the profile. Safe to drop: one process per profile here.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch {}
  }
  const browser = await puppeteer.launch({
    // Headed under Xvfb: MV3 extension service workers are reliable here,
    // unlike --headless (see extension-headless/README.md).
    headless: false,
    executablePath: config.chromePath,
    userDataDir: dir,
    defaultViewport: null,
    protocolTimeout: 120_000,
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
    args: [
      `--disable-extensions-except=${config.extensionPath}`,
      `--load-extension=${config.extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox", // container runs as an unprivileged user without userns
      "--disable-dev-shm-usage",
      "--window-size=1440,900",
      // A user with several dashboard tabs gets several (possibly occluded)
      // windows. Without these, Chrome stops painting covered windows and
      // the screencast freezes.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion,DialMediaRouteProvider",
      "--password-store=basic",
      // FreightPOP opens labels/documents with window.open after a request
      // finishes, which Chrome's pop-up blocker would otherwise swallow.
      "--disable-popup-blocking",
    ],
  });
  entry.browser = browser;
  entry.startedAt = Date.now();
  browser.on("disconnected", () => {
    console.error(`[browser] Chromium for ${entry.email} exited`);
    clearInterval(entry.saveTimer);
    if (pool.get(entry.key) === entry) pool.delete(entry.key);
  });

  try {
    await restoreCookies(entry, dir);
    await finishLaunch(entry, browser);
  } catch (e) {
    // Don't leave an orphaned Chromium holding the profile lock.
    console.error(`[browser] setup for ${entry.email} failed:`, e.message);
    await browser.close().catch(() => {});
    throw e;
  }
  return browser;
}

async function finishLaunch(entry, browser) {
  entry.extensionId = EXTENSION_ID;
  // Uploads go through the service API key, but tagged with THIS user's name
  // so scrape history/audit shows who it was.
  const seed = async (k, u, n) => { await chrome.storage.local.set({ fpxApiKey: k, fpxApiUrl: u, fpxUserName: n }); return true; };
  try {
    const worker = await getServiceWorker(browser);
    if (config.apiKey) await worker.evaluate(seed, config.apiKey, config.apiUrl, entry.email);
  } catch (e) {
    // Viewing FreightPOP doesn't need the SW — don't fail the launch over it.
    // Seed through an extension page instead (those always have chrome.*).
    console.warn(`[browser] SW not reachable for ${entry.email} (${e.message}); seeding via extension page`);
    if (config.apiKey) {
      const p = await browser.newPage();
      try {
        await p.goto(`chrome-extension://${EXTENSION_ID}/popup.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await p.evaluate(seed, config.apiKey, config.apiUrl, entry.email);
      } finally { await p.close().catch(() => {}); }
    }
  }
  entry.saveTimer = setInterval(() => saveCookies(entry).catch((e) => console.warn(`[browser] cookie save for ${entry.email} failed:`, e.message)), 5 * 60_000);
  console.log(`[browser] Chromium up for ${entry.email} (${pool.size} running)`);
  return browser;
}

async function saveCookies(entry) {
  if (!entry.browser?.connected) return;
  // Browser-level CDP call on the root connection. (browser.target()
  // .createCDPSession() intermittently fails with "Browser target is not found".)
  const { cookies } = await rootSend(entry.browser, "Storage.getCookies");
  const file = cookieFile(profileDirFor(entry.email));
  fs.writeFileSync(file, JSON.stringify(cookies), { mode: 0o600 });
}

// One-shot browser-level CDP command over a fresh connection to the browser's
// DevTools endpoint (puppeteer keeps its own root connection private).
function rootSend(browser, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(browser.wsEndpoint(), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${method} timed out`)); }, 15_000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function restoreCookies(entry, dir) {
  let cookies;
  try { cookies = JSON.parse(fs.readFileSync(cookieFile(dir), "utf8")); } catch { return; }
  if (!Array.isArray(cookies) || !cookies.length) return;
  try {
    await rootSend(entry.browser, "Storage.setCookies", { cookies: cookies.map(({ size, session, ...c }) => c) });
  } catch (e) {
    console.warn(`[browser] cookie restore for ${entry.email} failed:`, e.message);
  }
}

async function closeEntry(entry) {
  pool.delete(entry.key);
  clearInterval(entry.saveTimer);
  try { await saveCookies(entry); } catch (e) { console.warn(`[browser] cookie save for ${entry.email} failed:`, e.message); }
  try { await entry.browser?.close(); } catch {}
  console.log(`[browser] closed idle Chromium for ${entry.email}`);
}

// Sign the user out of the hosted browser completely: close their Chromium
// WITHOUT saving cookies, then delete their whole profile (cookies, FreightPOP
// session, saved page). Their next view starts fresh on the FreightPOP login.
// Refused while their browser is running a scrape.
export async function resetUserProfile(email) {
  const key = profileKey(email);
  const entry = pool.get(key);
  if (entry?.busy) throw Object.assign(new Error("A scrape is running in this browser — stop it first"), { status: 409 });
  if (entry) {
    pool.delete(key);
    clearInterval(entry.saveTimer);
    try { await entry.promise; } catch {}
    try { await entry.browser?.close(); } catch {}
  }
  await fs.promises.rm(profileDirFor(email), { recursive: true, force: true });
  console.log(`[browser] reset hosted login for ${email}`);
}

// Idle reaper.
setInterval(() => {
  const cutoff = Date.now() - config.idleCloseMs;
  for (const e of [...pool.values()]) {
    if (e.refs === 0 && !e.busy && e.lastUsed < cutoff && e.browser) closeEntry(e);
  }
}, 60_000).unref();

// Boot self-test: launch a throwaway Chromium, confirm the extension's service
// worker is reachable with chrome.* ready, then remove the temp profile.
export async function selfTest() {
  const dir = path.join(path.dirname(config.profileRoot), "selftest-profile");
  const t0 = Date.now();
  let browser;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    browser = await puppeteer.launch({
      headless: false, executablePath: config.chromePath, userDataDir: dir, defaultViewport: null,
      ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
      args: [`--disable-extensions-except=${config.extensionPath}`, `--load-extension=${config.extensionPath}`,
        "--no-first-run", "--no-sandbox", "--disable-dev-shm-usage"],
    });
    const worker = await getServiceWorker(browser);
    const v = await worker.evaluate(() => chrome.runtime.getManifest().version);
    return { ok: true, extensionId: EXTENSION_ID, version: v, chromium: await browser.version(), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, extensionId: EXTENSION_ID, error: e.message, ms: Date.now() - t0 };
  } finally {
    await browser?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function closeAll() {
  await Promise.all([...pool.values()].map(closeEntry));
}

// Chromium derives an unpacked extension's ID from its absolute path:
// sha256(path) → first 32 hex digits → each mapped 0-f → a-p. Knowing it lets
// us pick OUR service worker rather than whichever extension SW shows up first.
export const EXTENSION_ID = (() => {
  let p = config.extensionPath;
  try { p = fs.realpathSync(p); } catch {}
  const hex = crypto.createHash("sha256").update(p).digest("hex").slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The FPXpress service worker, with its chrome.* APIs ready. On slower hosts
// (Railway) the SW target appears before the extension bindings are attached,
// so evaluating immediately threw "chrome is not defined". MV3 SWs also stop
// when idle; if ours isn't running, loading an extension page wakes it.
export async function getServiceWorker(browser) {
  const prefix = `chrome-extension://${EXTENSION_ID}/`;
  const isOurs = (t) => t.type() === "service_worker" && t.url().startsWith(prefix);
  const deadline = Date.now() + 45_000;
  let woke = false;
  let lastErr = null;
  while (Date.now() < deadline) {
    let target = browser.targets().find(isOurs);
    if (!target) {
      if (!woke) {
        woke = true;
        // Wake a stopped SW by opening one of the extension's pages.
        browser.newPage().then(async (p) => {
          await p.goto(`${prefix}popup.html`, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
          await sleep(1500);
          await p.close().catch(() => {});
        }).catch(() => {});
      }
      target = await browser.waitForTarget(isOurs, { timeout: 10_000 }).catch(() => null);
      if (!target) continue;
    }
    try {
      const worker = await target.worker();
      if (worker) {
        const ready = await worker.evaluate(() => typeof chrome !== "undefined" && !!chrome.storage && !!chrome.runtime?.id);
        if (ready) return worker;
        lastErr = new Error("extension APIs not attached yet");
      }
    } catch (e) { lastErr = e; }
    await sleep(500);
  }
  throw new Error(`FPXpress extension (${EXTENSION_ID}) service worker not ready: ${lastErr?.message || "never registered — is CHROME_PATH a Chromium build that honors --load-extension?"}`);
}

// Open a page in its own window of the given browser. A separate window (not
// just a tab) keeps each of a user's dashboard tabs "visible" to the
// compositor so every screencast keeps flowing.
// Third-party trackers/widgets FreightPOP pages pull in. Nothing the scrape
// or the user needs; blocking them saves CPU and makes pages load faster.
export const BLOCKED_URLS = [
  "*://*.hubspot.com/*", "*://*.hs-analytics.net/*", "*://*.hs-banner.com/*", "*://*.hsadspixel.net/*",
  "*://*.hscollectedforms.net/*", "*://*.hsforms.com/*", "*://*.hs-scripts.com/*", "*://*.hsappstatic.net/*",
  "*://*.usemessages.com/*", "*://*.hubspotusercontent-na1.net/*",
  "*://*.adroll.com/*", "*://*.linkedin.com/*", "*://*.licdn.com/*", "*://*.apollo.io/*",
  "*://*.google-analytics.com/*", "*://*.googletagmanager.com/*", "*://*.doubleclick.net/*",
  "*://*.facebook.net/*", "*://*.facebook.com/*", "*://*.clarity.ms/*", "*://*.hotjar.com/*",
];

async function blockTrackers(page) {
  try {
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: BLOCKED_URLS });
    // Keep this session attached for the page's lifetime (detaching drops the block list).
    page.__fpxBlockSession = cdp;
  } catch (e) { console.warn("[browser] tracker block failed:", e.message); }
}

export async function openWindowPage(browser, url) {
  // rootSend, not browser.target().createCDPSession(): the latter
  // intermittently throws "Browser target is not found".
  const { targetId } = await rootSend(browser, "Target.createTarget", { url: "about:blank", newWindow: true });
  const target = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 10_000 });
  const page = await target.page();
  await blockTrackers(page);
  if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => console.warn("[browser] goto:", e.message));
  return page;
}

// Run a function in the FPXpress content script's isolated world for the
// page's main frame (falling back to any frame the extension is in). This is
// how we reach content.js without a parent iframe or chrome.tabs plumbing:
// top-level function declarations in a content script are globals of its
// isolated world, so `fpxBridgeHandle(...)` / `run(...)` are directly callable.
export class ExtensionContexts {
  constructor(cdp) {
    this.cdp = cdp;
    this.contexts = new Map(); // contextId -> { frameId, origin }
    this.mainFrameId = null;
  }

  async init() {
    this.cdp.on("Runtime.executionContextCreated", ({ context }) => {
      const aux = context.auxData || {};
      if (aux.type === "isolated" && String(context.origin || "").startsWith("chrome-extension://")) {
        this.contexts.set(context.id, { frameId: aux.frameId, origin: context.origin });
      }
    });
    this.cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
      this.contexts.delete(executionContextId);
    });
    this.cdp.on("Runtime.executionContextsCleared", () => this.contexts.clear());
    this.cdp.on("Page.frameNavigated", ({ frame }) => { if (!frame.parentId) this.mainFrameId = frame.id; });
    await this.cdp.send("Page.enable");
    const { frameTree } = await this.cdp.send("Page.getFrameTree");
    this.mainFrameId = frameTree.frame.id;
    await this.cdp.send("Runtime.enable");
  }

  // Ordered: main frame first, then sub-frames.
  candidates() {
    const all = [...this.contexts.entries()];
    all.sort(([, a], [, b]) => (a.frameId === this.mainFrameId ? -1 : 0) - (b.frameId === this.mainFrameId ? -1 : 0));
    return all.map(([id]) => id);
  }

  get ready() { return this.candidates().length > 0; }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const ids = this.candidates();
    if (!ids.length) throw new Error("FPXpress content script not present on this page (not on app.freightpop.com yet?)");
    let last = null;
    for (const contextId of ids) {
      try {
        const r = await this.cdp.send("Runtime.evaluate", { expression, contextId, awaitPromise, returnByValue: true });
        if (r.exceptionDetails) { last = new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); continue; }
        return { value: r.result?.value, contextId };
      } catch (e) { last = e; }
    }
    throw last || new Error("evaluate failed");
  }

  // Bridge command → ack. Tries each frame until one has a grid.
  async bridge(payload) {
    const ids = this.candidates();
    if (!ids.length) return { ok: false, reason: "no-extension", error: "FreightPOP page not loaded yet" };
    let lastAck = null;
    for (const contextId of ids) {
      try {
        const r = await this.cdp.send("Runtime.evaluate", {
          expression: `fpxBridgeHandle(${JSON.stringify(payload)})`,
          contextId, awaitPromise: true, returnByValue: true,
        });
        const ack = r.result?.value;
        if (r.exceptionDetails || !ack) continue;
        if (ack.ok || ack.reason !== "grid-not-ready") return ack;
        lastAck = ack;
      } catch { /* context went away mid-call */ }
    }
    return lastAck || { ok: false, error: "No frame answered the bridge command" };
  }
}
