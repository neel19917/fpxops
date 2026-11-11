import { acquireUserBrowser, hasProfile, getServiceWorker, openWindowPage, ExtensionContexts, dashboardUrlFor, watchAuth, isAuthExpired, clearAuthExpired } from "./browser.js";
import { config } from "./config.js";
import { recordScrape } from "./usage.js";
import { recordRun } from "./runs.js";
import { reindexAssistant } from "./assistant.js";
import { get as setting } from "./settings.js";

// Consumer for the fpx_scrape_requests queue (server/routes/ops.js). Until now
// nothing fulfilled these — the dashboard's "Rescrape" button relied on some
// rep's local extension. Here the hosted Chromium claims a request, runs the
// extension's normal Refresh All loop in its own tab, and reports back.
//
// Runs AS THE REQUESTER: the scrape uses requested_by's own hosted browser and
// FreightPOP login. There is no service account — if that rep has never
// logged in through the hosted view, the request fails with a clear note.
//
// MVP limitation: scope="selected" runs a full Refresh All too (the extension
// has no "only these tracking numbers" mode yet).
let busy = false;
let enabled = false;
// Live view of the running job for the dashboard's Scraping page.
let current = null; // { requestId, user, scope, startedAt, status, statusAt }
let stopFlag = false;
let lastResult = null; // { requestId, user, ok, note, finishedAt, durationMs }
let currentPage = null; // the window the running scrape is driving
const LOG_CAP = 5000;  // kept in memory; /stats only ships the tail
const LOG_TAIL = 400;

// Timestamped log for the dashboard's live log panel. Also mirrors the latest
// line into current.status (the one-line summary).
function logLine(text, level = "info") {
  if (!current || !text) return;
  const t = new Date().toISOString();
  current.log.push({ t, text: String(text).slice(0, 500), level });
  if (current.log.length > LOG_CAP) current.log.splice(0, current.log.length - LOG_CAP);
  if (level !== "data" && (!stopFlag || level !== "info")) { current.status = String(text).slice(0, 500); current.statusAt = t; }
}

// The live scrape window, for read-only watching from the dashboard. Only the
// user whose browser it runs in may watch it.
export function scrapePageFor(email) {
  return current && current.user === email && currentPage && !currentPage.isClosed() ? currentPage : null;
}

export function startScrapeWorker() {
  if (!config.apiKey) {
    console.warn("[worker] SCRAPE_WORKER set but FPX_API_KEY missing — worker disabled");
    return;
  }
  enabled = true;
  console.log(`[worker] polling rescrape queue every ${config.scrapePollMs / 1000}s`);
  // Nothing can be running yet: close out anything this worker had claimed
  // before a restart, or the Scraping page shows it as running forever.
  api("/api/ops/rescrape/release-orphans", { method: "POST", body: JSON.stringify({ by: "fpx-browser" }) })
    .then((r) => { if (r?.released?.length) console.log(`[worker] closed ${r.released.length} request(s) interrupted by a restart`); })
    .catch((e) => console.warn("[worker] release-orphans failed:", e.message));
  // setTimeout loop so an admin change to the poll interval applies live.
  const loop = async () => {
    await poll().catch((e) => console.error("[worker] poll error:", e.message));
    setTimeout(loop, config.scrapePollMs);
  };
  loop();
}

export function workerBusy() { return busy; }

// Trim logs to the tail for polling; the full log is at fullLog().
const withTail = (job) => job && { ...job, log: job.log.slice(-LOG_TAIL), logTotal: job.log.length };

export function workerState() {
  return {
    enabled,
    reason: enabled ? null : (!config.scrapeWorker ? "SCRAPE_WORKER is off" : "FPX_API_KEY not set"),
    pollSeconds: config.scrapePollMs / 1000,
    current: withTail(current),
    lastResult: withTail(lastResult),
    queued: queuedJobs(),
  };
}

// Full log of the running job, else the last finished one.
export function fullLog() {
  const job = current || lastResult;
  return job ? { requestId: job.requestId, user: job.user, counts: job.counts || null, log: job.log } : null;
}

// Ask the running Refresh All to stop. The extension finishes the row it's on.
export function requestStop(byEmail) {
  if (!current) return false;
  console.log(`[worker] stop requested by ${byEmail} for ${current.requestId}`);
  stopFlag = true;
  logLine(`Stop requested by ${byEmail} — finishing the current row…`, "warn");
  return true;
}

async function api(path, init = {}) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": config.apiKey, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

// Jobs from the scheduler wait here (the API queue holds manual requests).
// One scrape runs at a time across the whole service.
const localQueue = []; // { id, email, source: "schedule", scheduleId, scheduleName, queuedAt }

export function enqueueScheduled(schedule) {
  if (current?.scheduleId === schedule.id || localQueue.some((j) => j.scheduleId === schedule.id)) {
    return { queued: false, reason: "already queued or running" };
  }
  const job = {
    id: `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    email: schedule.owner, source: "schedule",
    scheduleId: schedule.id, scheduleName: schedule.name || null,
    modes: Array.isArray(schedule.modes) && schedule.modes.length ? schedule.modes : null,
    queuedAt: new Date().toISOString(),
  };
  localQueue.push(job);
  console.log(`[worker] queued scheduled run ${job.id} for ${job.email} (${schedule.name || schedule.id})`);
  setImmediate(() => poll().catch((e) => console.error("[worker] poll error:", e.message)));
  return { queued: true, job };
}

export function queuedJobs() {
  return localQueue.map(({ id, email, source, scheduleId, scheduleName, queuedAt }) => ({ id, user: email, source, scheduleId, scheduleName, queuedAt }));
}

async function poll() {
  if (busy || !enabled) return;
  if (localQueue.length) {
    const job = localQueue.shift();
    return runJob(job);
  }
  const { request } = await api(`/api/ops/rescrape/pending?claim=1&by=${encodeURIComponent("fpx-browser")}`);
  if (!request) return;
  return runJob({ id: request.id, apiRequestId: request.id, email: String(request.requested_by || ""), source: "manual", scope: request.scope, modes: Array.isArray(request.modes) && request.modes.length ? request.modes : null });
}

// Run one job (manual or scheduled) end to end, then record it in the
// persistent run history with its full log.
async function runJob(job) {
  busy = true;
  stopFlag = false;
  const email = job.email;
  const startedAt = Date.now();
  current = {
    requestId: job.id, user: email, scope: job.scope || "all", source: job.source, modes: job.modes || null,
    scheduleId: job.scheduleId || null, scheduleName: job.scheduleName || null,
    startedAt: new Date(startedAt).toISOString(), status: "Starting…", statusAt: new Date().toISOString(), log: [],
    counts: { scraped: 0, partial: 0, saved: 0, changed: 0, uploadErrors: 0, archived: 0, processed: 0 },
    total: null, // shipments in the grid, from the Kendo pager ("1 - 10 of 659 items")
    fpCounts: null, // FreightPOP's dashboard tiles: { TOTAL, BOOKED, "IN TRANSIT", ISSUES, "OUT FOR DELIVERY" }
    fpCountsAt: null,
    fpBefore: null, // first complete tile reading of the run
    fpAfter: null,  // tile reading when the run ended
  };
  if (job.modes) logLine(`Limited to ${job.modes.join(" + ")} shipments`);
  logLine(job.source === "schedule"
    ? `Scheduled run${job.scheduleName ? ` "${job.scheduleName}"` : ""} — running as ${email}`
    : `Claimed request — running as ${email || "unknown user"}`);
  console.log(`[worker] starting ${job.source} run ${job.id} for ${email}`);
  let ok = false;
  let note = "";
  try {
    if (!email.includes("@")) throw new Error(`Request has no user (requested_by="${email}") — rescrapes must come from a signed-in rep`);
    if (!hasProfile(email)) throw new Error(`${email} hasn't logged in to FreightPOP in the hosted view yet`);
    if (current) current.tasksBefore = await taskSnapshot();
    const result = await runRefreshAll(email, job.modes || null);
    ok = true; note = result;
    console.log(`[worker] ${job.id} done: ${result}`);
  } catch (e) {
    note = e.message;
    console.error(`[worker] ${job.id} failed:`, e.message);
  } finally {
    if (job.apiRequestId) {
      await api(`/api/ops/rescrape/${job.apiRequestId}/complete`, {
        method: "POST",
        body: JSON.stringify(ok ? { note: note.slice(0, 500), result_count: current?.counts?.saved ?? null } : { error: true, note: String(note).slice(0, 500) }),
      }).catch((e) => console.warn("[worker] complete failed:", e.message));
    }
    if (email.includes("@")) recordScrape(email, Date.now() - startedAt, ok);
    const tasksAfter = current?.tasksBefore ? await taskSnapshot() : null;
    logLine(ok ? `Finished: ${note}` : `Failed: ${note}`, ok ? "done" : "error");
    const finishedAt = new Date().toISOString();
    const summary = {
      id: job.id, source: job.source, user: email,
      scheduleId: job.scheduleId || null, scheduleName: job.scheduleName || null,
      startedAt: new Date(startedAt).toISOString(), finishedAt, durationMs: Date.now() - startedAt,
      ok, note: String(note).slice(0, 500), modes: job.modes || null,
      counts: current?.counts ? { ...current.counts, total: current.total ?? null } : null,
      // FreightPOP dashboard totals at the start and end of the run (trends).
      fpBefore: current?.fpBefore || null,
      fpAfter: current?.fpAfter || (current?.fpCounts ? { ...current.fpCounts, at: current.fpCountsAt } : null),
      // The task board (segments, health flags, shipment dispositions) at the
      // start and end of the run.
      tasksBefore: current?.tasksBefore || null,
      tasksAfter,
    };
    recordRun(summary, current?.log || []);
    // Fresh data → rebuild the Ask FPX search index and embed what changed.
    reindexAssistant("scrape").catch(() => {});
    lastResult = { ...summary, requestId: job.id, log: current?.log || [] };
    current = null;
    busy = false;
    // Something may have been queued while we ran.
    if (localQueue.length) setImmediate(() => poll().catch(() => {}));
  }
}

async function runRefreshAll(email, modes = null) {
  const lease = await acquireUserBrowser(email, { busy: true });
  try {
    return await runIn(lease.browser, dashboardUrlFor(email), email, modes);
  } finally {
    lease.release();
  }
}

async function runIn(browser, url, who, modes = null) {
  const worker = await getServiceWorker(browser);
  // Same sentinel trick as extension-headless/run.js: content.js reports
  // progress/completion to the service worker via chrome.runtime.sendMessage.
  await worker.evaluate(() => {
    self.__fpxDone = null;
    self.__fpxStatus = null;
    self.__fpxLog = [];
    const push = (e) => {
      (self.__fpxLog ||= []).push({ t: Date.now(), ...e });
      if (self.__fpxLog.length > 2000) self.__fpxLog.splice(0, self.__fpxLog.length - 2000);
    };
    self.__fpxPush = push;

    // Wrap fetch once: the extension's background posts scraped rows to
    // /api/shipments; log what the server says it saved.
    if (!self.__fpxFetchWrapped) {
      self.__fpxFetchWrapped = true;
      const orig = self.fetch.bind(self);
      self.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input?.url || "";
        const method = (init?.method || input?.method || "GET").toUpperCase();
        const res = await orig(input, init);
        try {
          if (method === "POST" && /\/api\/shipments(\/sweep-complete)?(\?|$)/.test(url)) {
            const body = await res.clone().json().catch(() => null);
            const p = self.__fpxPush;
            if (!p) return res;
            if (/sweep-complete/.test(url)) {
              p(res.ok
                ? { kind: "archived", level: "done", n: body?.archived_shipments || 0, text: `Archived ${body?.archived_shipments || 0} delivered shipment(s) no longer in FreightPOP (${body?.archived_tasks || 0} task(s) closed)` }
                : { kind: "uploadError", level: "error", text: `Archive step failed: ${body?.error || res.status}` });
            } else if (res.ok) {
              const n = body?.count ?? (body?.shipment ? 1 : 0);
              const changed = body?.material_changes || 0;
              p({ kind: "saved", level: "done", n, changed, text: `Saved ${n} shipment(s) to the dashboard` + (changed ? ` · ${changed} with changes` : "") + (body?.skipped ? ` · ${body.skipped} skipped` : "") });
            } else {
              p({ kind: "uploadError", level: "error", text: `Upload failed (${res.status}): ${body?.error || "unknown error"} — the extension will retry` });
            }
          }
        } catch { /* never break the extension's own fetch */ }
        return res;
      };
    }

    if (self.__fpxListenerInstalled) return;
    self.__fpxListenerInstalled = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "status") {
        self.__fpxStatus = msg.text;
        self.__fpxPush?.({ text: msg.text });
      }
      if (msg?.type === "upsertShipmentsBulk" && Array.isArray(msg.rows)) {
        // One line per scraped shipment: tracking # + the most useful fields.
        const pick = (row, re) => {
          for (const [k, v] of Object.entries(row)) {
            if (!k.startsWith("_") && re.test(k) && v != null && String(v).trim()) return String(v).trim().slice(0, 60);
          }
          return null;
        };
        for (const row of msg.rows) {
          const tn = row?._trackingNumber || "?";
          const bits = [
            pick(row, /status/i),
            pick(row, /carrier/i),
            pick(row, /customer|company|consignee/i),
            pick(row, /eta|delivery.?date|estimated/i),
          ].filter(Boolean);
          const partial = row?._partial || row?._error;
          self.__fpxPush?.({
            kind: "scraped", level: partial ? "warn" : "data", partial: !!partial,
            text: `Scraped ${tn}` + (bits.length ? ` — ${bits.join(" · ")}` : "") + (partial ? ` (grid data only: ${row._error || "partial"})` : ""),
          });
        }
        self.__fpxPush?.({ text: `Uploading ${msg.rows.length} shipment(s)…` });
      }
      if (msg?.type === "complete") self.__fpxDone = msg.text || "Done.";
    });
  });

  clearAuthExpired(who);
  const page = await openWindowPage(browser, url);
  currentPage = page;
  const offAuth = watchAuth(page, who);
  const EXPIRED = "Your FreightPOP login expired (FreightPOP rejects it) — open More → FreightPOP login, sign in again, then re-run";
  try {
    if (/\/login/i.test(page.url())) {
      throw new Error("Your FreightPOP session expired — log in again through the dashboard's hosted view");
    }
    const cdp = await page.createCDPSession();
    const ext = new ExtensionContexts(cdp);
    await ext.init();
    // Contexts created before Runtime.enable are replayed on enable, but give
    // the content script (document_idle) a moment to attach.
    const t0 = Date.now();
    while (!ext.ready && Date.now() - t0 < 30_000) await sleep(1000);
    logLine(`Opened ${page.url()} — waiting for the shipment grid…`);
    // Don't start until rows are on screen — otherwise run() "finishes" an
    // empty page in seconds and reports Done with 0 shipments.
    let gridReady = false;
    for (let i = 0; i < 6 && !gridReady; i++) {
      if (/#\/login|\/login\b/i.test(page.url())) throw new Error("Your FreightPOP session expired — open FreightPOP on the Scraping page and log in again");
      if (isAuthExpired(who)) throw new Error(EXPIRED);
      gridReady = (await ext.evaluate("fpxEnsureGridReady(10000)").catch(() => ({ value: false }))).value === true;
    }
    if (!gridReady && isAuthExpired(who)) throw new Error(EXPIRED);
    if (!gridReady) {
      const why = (await ext.evaluate("fpxDescribeFrameState()").catch(() => ({ value: "" }))).value;
      throw new Error(`FreightPOP's shipment grid never loaded on ${page.url()}${why ? ` (${why})` : ""}`);
    }
    const total = await readGridTotal(page);
    if (current && total != null) current.total = total;
    let counts = await readDashboardCounts(page);
    if (!counts || Object.keys(counts).length < 5) { await sleep(3000); counts = (await readDashboardCounts(page)) || counts; }
    noteCounts(counts);
    logLine(total != null ? `Grid loaded — ${total} shipment(s) in the grid. Starting Refresh All` : "Grid loaded — starting Refresh All");
    const pageSize = Number(setting("browser.scrape_page_size")) || 50;
    await ext.evaluate(`fpxScrapePageSize = ${pageSize}; 'ok'`).catch(() => {});
    // Mode filter (LTL / Truckload / Parcel) — content.js applies it on the grid.
    await ext.evaluate(`fpxScrapeModes = ${JSON.stringify(modes && modes.length ? modes : null)}; 'ok'`).catch(() => {});
    await ext.evaluate("run(); 'started'", { awaitPromise: false });

    const deadline = Date.now() + config.scrapeTimeoutMs;
    let lastStatus = "";
    let tick = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      const { done, status, lines } = await worker.evaluate(() => ({
        done: self.__fpxDone, status: self.__fpxStatus, lines: (self.__fpxLog || []).splice(0),
      }));
      for (const l of lines) {
        logLine(l.text, l.level || "info");
        const c = current?.counts;
        if (!c) continue;
        // One per row the extension finished (with or without modal data).
        if (!l.kind && /^(Done |Timeout on |Row \S+ left the grid)/.test(l.text || "")) c.processed++;
        if (l.kind === "scraped") { c.scraped++; if (l.partial) c.partial++; }
        else if (l.kind === "saved") { c.saved += l.n || 0; c.changed += l.changed || 0; }
        else if (l.kind === "uploadError") c.uploadErrors++;
        else if (l.kind === "archived") c.archived += l.n || 0;
      }
      if (status && status !== lastStatus) {
        lastStatus = status;
        console.log(`[worker] ${status}`);
        if (current && !stopFlag) { current.status = status; current.statusAt = new Date().toISOString(); }
      }
      if (done) {
        // The run's "after" snapshot of FreightPOP's dashboard totals.
        const end = await readDashboardCounts(page);
        if (current && end) { noteCounts(end); current.fpAfter = { ...end, at: new Date().toISOString() }; }
        return stopFlag ? `Stopped by user. ${done}` : done;
      }
      // Keep the totals fresh (shipments get added/delivered mid-run):
      // FreightPOP's dashboard tiles every ~10s, the grid pager every ~30s.
      ++tick;
      if (tick % 5 === 0 && current) {
        noteCounts(await readDashboardCounts(page));
      }
      if (tick % 15 === 0 && current) {
        const t = await readGridTotal(page);
        if (t != null) current.total = t;
      }
      if (stopFlag && !page.__fpxStopSentAt) {
        page.__fpxStopSentAt = Date.now();
        await ext.evaluate("stopRequested = true; 'stopping'", { awaitPromise: false }).catch(() => {});
      }
      // If the extension never acknowledges the stop, give up after 2 min.
      if (page.__fpxStopSentAt && Date.now() - page.__fpxStopSentAt > 120_000) {
        return `Stopped by user (last status: ${lastStatus || "none"})`;
      }
      if (/\/login/i.test(page.url())) throw new Error("Redirected to FreightPOP login mid-run");
    }
    await ext.evaluate("stopRequested = true; 'stopping'", { awaitPromise: false }).catch(() => {});
    throw new Error(`Timed out after ${config.scrapeTimeoutMs / 60000} min (last status: ${lastStatus || "none"})`);
  } finally {
    offAuth();
    currentPage = null;
    await page.close().catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Tasks board in numbers, from the API (null if it can't be read — a
// missing snapshot must never fail a scrape).
async function taskSnapshot() {
  try { return await api("/api/tasks/v2/snapshot"); }
  catch (e) { console.warn("[worker] task snapshot failed:", e.message); return null; }
}

// Remember the latest tile reading; the first complete one (all five tiles)
// is the run's "before" snapshot — FreightPOP fills the tiles a moment after
// the grid, so the very first read can be partial.
function noteCounts(c) {
  if (!current || !c) return;
  const at = new Date().toISOString();
  current.fpCounts = c; current.fpCountsAt = at;
  if (!current.fpBefore && Object.keys(c).length >= 5) current.fpBefore = { ...c, at };
}

// FreightPOP's dashboard tiles (TOTAL / BOOKED / IN TRANSIT / ISSUES /
// OUT FOR DELIVERY) with the number shown under each. Matched by geometry —
// the number is the nearest numeric text directly below its label — so it
// doesn't depend on FreightPOP's class names.
async function readDashboardCounts(page) {
  try {
    return await page.evaluate(() => {
      const LABELS = ["TOTAL", "BOOKED", "IN TRANSIT", "ISSUES", "OUT FOR DELIVERY"];
      const all = [...document.querySelectorAll("body *")].filter((el) => el.offsetParent !== null && el.children.length === 0);
      const labels = all.filter((el) => LABELS.includes((el.textContent || "").trim().toUpperCase()));
      const nums = all.filter((el) => /^\d[\d,]*$/.test((el.textContent || "").trim()));
      const out = {};
      for (const lab of labels) {
        const key = lab.textContent.trim().toUpperCase();
        if (out[key] != null) continue;
        const r = lab.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        let best = null, bestD = Infinity;
        for (const n of nums) {
          const nr = n.getBoundingClientRect();
          const dy = nr.top - r.bottom;
          if (dy < -2 || dy > 90) continue;                  // must sit just below the label
          const dx = Math.abs(nr.left + nr.width / 2 - cx);
          if (dx > Math.max(60, r.width / 2)) continue;     // and roughly under it
          const d = dy + dx;
          if (d < bestD) { bestD = d; best = n; }
        }
        if (best) out[key] = Number(best.textContent.trim().replace(/,/g, ""));
      }
      return Object.keys(out).length ? out : null;
    });
  } catch { return null; }
}

// Total shipments in the Kendo grid, from its pager ("1 - 10 of 659 items").
// Read in the page's main world — the pager is plain DOM. Null if not found.
async function readGridTotal(page) {
  try {
    return await page.evaluate(() => {
      const els = [...document.querySelectorAll(".k-pager-info, .k-pager .k-label, [class*='pager-info']")];
      for (const el of els) {
        const m = /of\s+([\d,]+)\s+items?/i.exec(el.textContent || "");
        if (m) return Number(m[1].replace(/,/g, ""));
      }
      if (/no items to display/i.test(document.querySelector(".k-pager-info")?.textContent || "")) return 0;
      return null;
    });
  } catch { return null; }
}
