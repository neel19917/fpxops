#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import puppeteer from "puppeteer-core";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXT_PATH = path.join(REPO_ROOT, "extension");
const PROFILE_DIR = path.join(__dirname, ".chrome-profile");

const FREIGHTPOP_ORIGIN = "https://app.freightpop.com";
const TRACKING_URL = `${FREIGHTPOP_ORIGIN}/Tracking`;

const SENTINEL_TYPES = {
  refreshAll: "complete",
  gpAudit: "gpAuditComplete",
  invoiceAudit: "invoiceAuditComplete",
};

const ACTION_FOR_MODE = {
  refreshAll: "start",
  gpAudit: "gpAudit",
  invoiceAudit: "invoiceAudit",
};

function resolveChromeBinary(explicit) {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"],
    win32: [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ],
  };
  for (const p of candidates[process.platform] ?? []) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "Could not locate Chrome. Pass --chrome <path> or set CHROME_PATH."
  );
}

function toUSDate(iso) {
  // sidepanel sends dates as M/D/YYYY (see sidepanel.js parseInvoiceFile area).
  // Accept ISO YYYY-MM-DD on the CLI and convert.
  if (!iso) return null;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(iso)) return iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Bad date "${iso}". Use YYYY-MM-DD.`);
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

function parseInvoiceXlsx(xlsxPath) {
  const wb = XLSX.read(fs.readFileSync(xlsxPath));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const shipments = [];
  const skippedRows = [];
  for (const r of rows) {
    const memo = String(r.Memo || "").trim();
    const idMatch = memo.match(/^(\d{5,})/);
    if (idMatch) {
      shipments.push({
        shipmentId: idMatch[1],
        billAmount: parseFloat(r.Amount) || 0,
        vendor: r.Vendor || "",
        invoiceNumber: r["Invoice Number"] || "",
        memo,
      });
    } else {
      skippedRows.push({
        vendor: r.Vendor || "",
        invoiceNumber: r["Invoice Number"] || "",
        amount: r.Amount || "",
        memo,
      });
    }
  }
  return { shipments, skippedRows };
}

async function launchBrowser({ headed, chromePath, offscreen = false }) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // Chrome's --headless=new mode does NOT reliably register MV3
  // service workers as debug targets (extension is loaded but the SW
  // is invisible to CDP). Stock Google Chrome additionally strips
  // --load-extension as a security policy. The reliable pattern is
  // headed mode with the window pushed off-screen — works on both
  // Chrome for Testing and Chromium and is what we default to when
  // the caller asks for offscreen mode (the smoke-test flow).
  const offscreenArgs = offscreen
    ? ["--window-position=-2000,-2000", "--window-size=1,1"]
    : [];
  const launchArgs = [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DialMediaRouteProvider",
    ...offscreenArgs,
  ];
  return puppeteer.launch({
    headless: headed || offscreen ? false : "new",
    executablePath: chromePath,
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1440, height: 900 },
    args: launchArgs,
  });
}

async function getServiceWorker(browser) {
  // Fast path: the SW might already be alive in Puppeteer's target list.
  const alive = browser.targets().find(
    (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
  );
  if (alive) {
    return { worker: await alive.worker(), extensionId: new URL(alive.url()).host };
  }

  // Slow path: MV3 service workers in headless Chrome are dormant
  // by default and Puppeteer's targets() filter sometimes hides
  // them. Two-pronged wake-up:
  //   (a) Use CDP Target.getTargets — that low-level call enumerates
  //       dormant service_worker targets even when puppeteer's
  //       higher-level browser.targets() omits them. Once we have
  //       the extension id we can attach to the SW.
  //   (b) Open chrome-extension://<id>/popup.html — loading the
  //       popup forces Chrome to start the worker, after which
  //       browser.waitForTarget() reliably resolves.

  const cdp = await browser.target().createCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const swInfo = targetInfos.find(
    (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
  );
  if (!swInfo) {
    // Most common cause: the user is running stock Google Chrome,
    // which silently ignores --load-extension / --disable-extensions-except
    // as a security policy. Chromium / Chrome for Testing / Chrome
    // Canary all honor those flags. Surface the fix instead of a
    // generic "service worker not found" error.
    throw new Error(
      "Extension service worker not registered with Chrome.\n" +
      "Most likely cause: Google Chrome blocks --load-extension as a security policy.\n" +
      "Fix: install Chrome for Testing and point the harness at it:\n" +
      "  npx @puppeteer/browsers install chrome@stable\n" +
      "  CHROME_PATH=/path/to/chrome-for-testing node run.js --smoke-test\n" +
      "Or use Chromium (brew install --cask chromium) / Chrome Canary.\n" +
      "Stock Google Chrome does not support automated extension loading."
    );
  }
  const extensionId = new URL(swInfo.url).host;

  // Wake the SW by loading its popup page. The page itself is
  // discarded immediately — we only need the start-up event.
  let wakePage;
  try {
    wakePage = await browser.newPage();
    await wakePage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    }).catch(() => { /* the popup might fail to render — SW still wakes */ });
  } catch { /* fall through */ }

  try {
    const target = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url() === swInfo.url,
      { timeout: 15_000 },
    );
    const worker = await target.worker();
    if (!worker) throw new Error("Got SW target but worker() returned null.");
    return { worker, extensionId };
  } finally {
    if (wakePage) await wakePage.close().catch(() => {});
  }
}

async function installSentinelListener(worker) {
  // Subscribed inside the SW so we capture every status / complete message
  // content.js fires (see content.js:10, 15, 859, 864, 1672, 1677).
  await worker.evaluate(() => {
    if (self.__fpxListenerInstalled) return;
    self.__fpxListenerInstalled = true;
    self.__fpxStatus = null;
    self.__fpxDone = null;
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (
        msg.type === "status" ||
        msg.type === "gpAuditStatus" ||
        msg.type === "invoiceAuditStatus"
      ) {
        self.__fpxStatus = { type: msg.type, text: msg.text, ts: Date.now() };
      } else if (
        msg.type === "complete" ||
        msg.type === "gpAuditComplete" ||
        msg.type === "invoiceAuditComplete"
      ) {
        self.__fpxDone = { type: msg.type, text: msg.text || "Done.", ts: Date.now() };
      }
    });
  });
}

async function seedCredentials(worker, { key, url, user }) {
  await worker.evaluate(
    async (k, u, n) => {
      const patch = {};
      if (k) patch.fpxApiKey = k;
      if (u) patch.fpxApiUrl = u;
      if (n) patch.fpxUserName = n;
      await chrome.storage.local.set(patch);
    },
    key,
    url,
    user
  );
}

async function findFreightpopTabId(worker) {
  return worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://app.freightpop.com/*" });
    return tabs[0]?.id ?? null;
  });
}

async function injectContentScript(worker, tabId) {
  await worker.evaluate(async (id) => {
    try {
      await chrome.tabs.sendMessage(id, { action: "ping" });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["content.js"],
      });
    }
  }, tabId);
}

async function dispatchAction(worker, tabId, payload) {
  await worker.evaluate(
    async (id, p) => chrome.tabs.sendMessage(id, p),
    tabId,
    payload
  );
}

async function waitForCompletion(worker, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastStatusTs = 0;
  while (Date.now() < deadline) {
    const snap = await worker.evaluate(() => ({
      status: self.__fpxStatus,
      done: self.__fpxDone,
    }));
    if (snap.status && snap.status.ts !== lastStatusTs) {
      lastStatusTs = snap.status.ts;
      console.log(`[${new Date().toISOString()}] ${snap.status.text}`);
    }
    if (snap.done) return snap.done;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 60_000)} min`);
}

// ---------- Subcommand handlers ----------

async function cmdLogin(argv) {
  const chromePath = resolveChromeBinary(argv.chrome);
  const browser = await launchBrowser({ headed: true, chromePath });
  const page = await browser.newPage();
  await page.goto(FREIGHTPOP_ORIGIN, { waitUntil: "domcontentloaded" });
  console.log("Sign in to FreightPOP (clear MFA), then close the window.");
  await new Promise((resolve) => browser.on("disconnected", resolve));
  console.log("Login session saved to", PROFILE_DIR);
}

async function cmdSeedKey(argv) {
  const chromePath = resolveChromeBinary(argv.chrome);
  const key = argv.apiKey || process.env.FPX_API_KEY;
  const url = argv.apiUrl || process.env.FPX_API_URL;
  const user = argv.user || process.env.FPX_USER;
  if (!key || !url) {
    throw new Error("Provide --api-key + --api-url (or FPX_API_KEY/FPX_API_URL env).");
  }
  const browser = await launchBrowser({ headed: false, chromePath });
  try {
    const { worker } = await getServiceWorker(browser);
    await seedCredentials(worker, { key, url, user });
    console.log("Seeded chrome.storage.local with API credentials.");
  } finally {
    await browser.close();
  }
}

// Smoke-test the harness without running a real scrape. Verifies:
// 1. Chrome binary is locatable.
// 2. Chrome boots with --load-extension=../extension.
// 3. The extension's MV3 service worker shows up under
//    browser.targets() within ~10s (the same path cmdRun uses).
// 4. Optional Railway reachability check from inside the worker:
//    fetches /health on whatever FPX_API_URL is configured.
// 5. Optional Supabase session sniff: reports whether
//    fpxSupabaseSession is present + un-expired in chrome.storage.
//
// Exits 0 on success, non-zero on first failure with a message
// pointing at what to fix. CI-friendly: no network state is
// changed, no scrape side effects.
async function cmdSmokeTest(argv) {
  const checks = [];
  const fail = (label, err) => { checks.push({ label, ok: false, msg: err.message || String(err) }); };
  const pass = (label, info) => { checks.push({ label, ok: true, msg: info || "" }); };

  // 1. Chrome binary
  let chromePath;
  try {
    chromePath = resolveChromeBinary(argv.chrome);
    pass("Chrome binary located", chromePath);
  } catch (e) {
    fail("Chrome binary located", e);
    printSmokeReport(checks);
    process.exit(1);
  }

  // 2. Boot Chrome with the extension loaded.
  //    Default to offscreen-headed so the smoke test works reliably
  //    on systems where Chrome's --headless=new can't see the
  //    extension's service worker. Caller can override with --headed
  //    to get a visible window for debugging.
  let browser;
  try {
    browser = await launchBrowser({
      headed: !!argv.headed,
      chromePath,
      offscreen: !argv.headed,
    });
    pass("Chrome booted with extension", `profile=${PROFILE_DIR}, mode=${argv.headed ? "headed" : "offscreen"}`);
  } catch (e) {
    fail("Chrome booted with extension", e);
    printSmokeReport(checks);
    process.exit(1);
  }

  try {
    // 3. Extension service worker reachable + manifest version
    let worker; let extensionId; let manifestVersion = "?";
    try {
      const got = await getServiceWorker(browser);
      worker = got.worker; extensionId = got.extensionId;
      try {
        manifestVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
      } catch { /* informational only */ }
      pass("Extension service worker present", `id=${extensionId}, manifest v${manifestVersion}`);
    } catch (e) {
      fail("Extension service worker present", e);
      printSmokeReport(checks); process.exit(1);
    }

    // 4. Railway reachability — best-effort, only if FPX_API_URL is set
    const apiUrl = argv.apiUrl || process.env.FPX_API_URL || "";
    if (apiUrl) {
      try {
        const r = await worker.evaluate(async (url) => {
          const resp = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
          if (!resp.ok) return { ok: false, status: resp.status };
          const j = await resp.json();
          return { ok: true, status: resp.status, body: j };
        }, apiUrl);
        if (r.ok) pass("Railway /health reachable from extension", `${r.body.version || "?"} db=${r.body.db ? "ok" : "missing"}`);
        else fail("Railway /health reachable from extension", new Error(`HTTP ${r.status}`));
      } catch (e) {
        fail("Railway /health reachable from extension", e);
      }
    } else {
      pass("Railway /health (skipped)", "set FPX_API_URL to include this check");
    }

    // 5. Supabase session sniff
    try {
      const sess = await worker.evaluate(async () => {
        const r = await chrome.storage.local.get("fpxSupabaseSession");
        return r.fpxSupabaseSession || null;
      });
      if (!sess) {
        pass("Supabase session", "none — sign in via the popup or `--login` first");
      } else {
        const expSec = typeof sess.expires_at === "number" ? sess.expires_at : 0;
        const live = expSec * 1000 > Date.now();
        if (live) pass("Supabase session", `live for ${sess.email || "(unknown email)"} until ${new Date(expSec * 1000).toISOString()}`);
        else fail("Supabase session", new Error(`expired at ${new Date(expSec * 1000).toISOString()}`));
      }
    } catch (e) {
      fail("Supabase session", e);
    }

    // 6. Persistent upload queue sniff — surfaces stuck rows from a
    //    prior session so the operator can flush before scraping more.
    try {
      const q = await worker.evaluate(async () => {
        const r = await chrome.storage.local.get("pendingUploads");
        const arr = Array.isArray(r.pendingUploads) ? r.pendingUploads : [];
        return {
          chunks: arr.length,
          rows: arr.reduce((n, q) => n + (q.rows?.length || 0), 0),
          dead: arr.filter((q) => (q.attempts || 0) >= 5).length,
        };
      });
      if (q.chunks === 0) pass("Upload queue clean", "0 pending");
      else pass("Upload queue", `${q.chunks} chunk(s), ${q.rows} row(s), ${q.dead} dead`);
    } catch (e) {
      fail("Upload queue sniff", e);
    }
  } finally {
    await browser.close();
  }

  printSmokeReport(checks);
  const anyFailed = checks.some((c) => !c.ok);
  process.exit(anyFailed ? 1 : 0);
}

function printSmokeReport(checks) {
  const w = Math.max(...checks.map((c) => c.label.length));
  console.log("\nFPXpress headless smoke test\n" + "=".repeat(34));
  for (const c of checks) {
    const pad = " ".repeat(w - c.label.length);
    console.log(`${c.ok ? "✔" : "✖"}  ${c.label}${pad}  ${c.msg}`);
  }
  const failedCount = checks.filter((c) => !c.ok).length;
  if (failedCount === 0) console.log("\nAll checks passed. Harness is ready.");
  else console.log(`\n${failedCount} failed — fix the above before running --mode.`);
}

async function cmdRun(argv) {
  const chromePath = resolveChromeBinary(argv.chrome);
  const mode = argv.mode;
  if (!ACTION_FOR_MODE[mode]) throw new Error(`Unknown --mode ${mode}`);

  const browser = await launchBrowser({ headed: !!argv.headed, chromePath });
  try {
    const { worker, extensionId } = await getServiceWorker(browser);
    console.log(`Extension loaded as ${extensionId}`);

    const envKey = process.env.FPX_API_KEY;
    const envUrl = process.env.FPX_API_URL;
    const envUser = process.env.FPX_USER;
    if (envKey || envUrl || envUser) {
      await seedCredentials(worker, { key: envKey, url: envUrl, user: envUser });
    }

    await installSentinelListener(worker);

    const page = await browser.newPage();
    await page.goto(TRACKING_URL, { waitUntil: "networkidle2", timeout: 90_000 });
    if (page.url().includes("/Login") || page.url().includes("/Account/Login")) {
      throw new Error(
        "Redirected to /Login — session expired. Run `node run.js --login` to refresh."
      );
    }

    const tabId = await findFreightpopTabId(worker);
    if (!tabId) throw new Error("Could not locate the FreightPOP tab.");
    await injectContentScript(worker, tabId);

    const payload = buildPayload(mode, argv);
    console.log(`Dispatching ${ACTION_FOR_MODE[mode]} payload to tab ${tabId}`);
    await dispatchAction(worker, tabId, payload);

    const timeoutMs = (argv.timeout || 30) * 60_000;
    const done = await waitForCompletion(worker, { timeoutMs });
    console.log(`\n[done] ${done.text}`);
  } finally {
    await browser.close();
  }
}

function buildPayload(mode, argv) {
  if (mode === "refreshAll") {
    return {
      action: "start",
      filterCol: argv.filterCol || "",
      filterVal: argv.filterVal || "",
    };
  }
  if (mode === "gpAudit") {
    if (!argv.fromDate || !argv.toDate)
      throw new Error("gpAudit needs --from-date and --to-date (YYYY-MM-DD).");
    return {
      action: "gpAudit",
      fromDate: toUSDate(argv.fromDate),
      toDate: toUSDate(argv.toDate),
      shipmentType: argv.shipmentType || "All",
      aiAnalysis: argv.aiAnalysis || "summary",
      customerFilter: argv.customerFilter || "",
    };
  }
  if (mode === "invoiceAudit") {
    if (!argv.bill) throw new Error("invoiceAudit needs --bill <xlsx-path>.");
    if (!argv.fromDate || !argv.toDate)
      throw new Error("invoiceAudit needs --from-date and --to-date (YYYY-MM-DD).");
    const billPath = path.resolve(argv.bill);
    if (!fs.existsSync(billPath)) throw new Error(`Bill not found: ${billPath}`);
    const { shipments, skippedRows } = parseInvoiceXlsx(billPath);
    if (shipments.length === 0)
      throw new Error("No shipments parsed from bill XLSX (expected Memo + Amount columns).");
    console.log(
      `Parsed ${shipments.length} shipments and ${skippedRows.length} skipped rows from ${billPath}`
    );
    return {
      action: "invoiceAudit",
      shipments,
      skippedRows,
      fromDate: toUSDate(argv.fromDate),
      toDate: toUSDate(argv.toDate),
      shipmentType: argv.shipmentType || "All",
      customerFilter: argv.customerFilter || "",
      aiAnalysis: argv.aiAnalysis || "summary",
      skipReport: !!argv.skipReport,
    };
  }
  throw new Error(`Unhandled mode ${mode}`);
}

// ---------- CLI ----------

await yargs(hideBin(process.argv))
  .scriptName("fpx-headless")
  .strict()
  .option("chrome", { type: "string", describe: "Path to Chrome binary" })
  .option("headed", { type: "boolean", describe: "Show the browser window (debug)" })
  .command(
    "$0",
    "Run a scrape (default subcommand). Use --login or --seed-key for setup.",
    (y) =>
      y
        .option("login", { type: "boolean", describe: "Open Chrome headed to log in to FreightPOP" })
        .option("seed-key", { type: "boolean", describe: "Write API credentials to chrome.storage.local and exit" })
        .option("smoke-test", { type: "boolean", describe: "Verify the harness (boot, extension load, /health, session, queue) without running a scrape" })
        .option("mode", { type: "string", choices: ["refreshAll", "gpAudit", "invoiceAudit"] })
        .option("api-key", { type: "string", describe: "FPX API key (or env FPX_API_KEY)" })
        .option("api-url", { type: "string", describe: "FPX API URL  (or env FPX_API_URL)" })
        .option("user", { type: "string", describe: "User name to attribute the run (or env FPX_USER)" })
        .option("filter-col", { type: "string", describe: "refreshAll: filter column" })
        .option("filter-val", { type: "string", describe: "refreshAll: filter value" })
        .option("from-date", { type: "string", describe: "audit modes: YYYY-MM-DD" })
        .option("to-date", { type: "string", describe: "audit modes: YYYY-MM-DD" })
        .option("shipment-type", { type: "string", default: "All" })
        .option("customer-filter", { type: "string", default: "" })
        .option("ai-analysis", { type: "string", default: "summary" })
        .option("bill", { type: "string", describe: "invoiceAudit: path to carrier-bill XLSX" })
        .option("skip-report", { type: "boolean", default: false })
        .option("timeout", { type: "number", default: 30, describe: "Run timeout, minutes" }),
    async (argv) => {
      if (argv.login) return cmdLogin(argv);
      if (argv.seedKey) return cmdSeedKey(argv);
      if (argv.smokeTest) return cmdSmokeTest(argv);
      if (!argv.mode) {
        console.error("Specify --mode <refreshAll|gpAudit|invoiceAudit>, or --login / --seed-key / --smoke-test.");
        process.exit(2);
      }
      return cmdRun(argv);
    }
  )
  .help()
  .parseAsync()
  .catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
