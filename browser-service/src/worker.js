import { acquireUserBrowser, hasProfile, getServiceWorker, openWindowPage, ExtensionContexts, dashboardUrlFor, watchAuth, isAuthExpired, clearAuthExpired } from "./browser.js";
import { config } from "./config.js";
import { recordScrape } from "./usage.js";
import { recordRun } from "./runs.js";
import { reindexAssistant } from "./assistant.js";
import { notifyRunDone } from "./notify.js";
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

// ── Scrape log convention (the Scraping page and the saved run logs rely on it) ──
//
// An entry is { t: ISO time, level, text } — nothing else goes over the wire
// (/stats tail, GET /scrape/log and the saved run log as "t\tlevel\ttext").
//
// level   meaning                                   text starts with
// ─────   ───────────────────────────────────────   ─────────────────────────────
// data    one shipment scraped in full              "Scraped <tracking #> · "
// warn    one shipment saved from the grid only     "Scraped <tracking #> · … · grid data only (<why>)"
// info    page progress                             "Page <n> of <N> · "
// warn    a page or setup step needs a look         "Page <n> of <N> · …" or the extension's own sentence
// done    rows confirmed by the dashboard API       "Saved <n> shipment(s)" / "Archived <n> …"
// error   an upload or the whole run failed         "Upload failed" / "Archive step failed" / "Failed: "
// done    last line of a good run                   "Finished: "
// info    everything else (start-up, filters)       free text
//
// So: level "data" is the per-shipment detail (hide it for a short log), and
// warn + error are everything that needs attention. Fields inside a line are
// always separated by " · ". `t` on a "Scraped" line is when that shipment
// was finished, not when its page was uploaded, and entries stay in time order.
//
// The extension's per-row steps ("Processing 3 of 40 — …", "Clicked …",
// "Scraping modal data …", "Done …") are NOT logged: they only drive the
// one-line live status. At four lines a shipment they filled the 5,000-line
// cap on a 1,000-shipment run and pushed the start of the log out.
//
// `at` backdates an entry (ms); it is slotted in by time and leaves the
// one-line status alone.
function logLine(text, level = "info", at = null) {
  if (!current || !text) return;
  const now = new Date().toISOString();
  const t = at ? new Date(at).toISOString() : now;
  const entry = { t, text: String(text).slice(0, 500), level };
  let i = current.log.length;
  if (at) while (i > 0 && current.log[i - 1].t > t) i--;
  current.log.splice(i, 0, entry);
  if (current.log.length > LOG_CAP) current.log.splice(0, current.log.length - LOG_CAP);
  if (!at && level !== "data" && (!stopFlag || level !== "info")) { current.status = entry.text; current.statusAt = now; }
}

// One scraped row → the few fields an operator recognises. Runs INSIDE the
// extension's service worker (injected with toString), so it must not use
// anything outside its own body.
//
// Keys are matched by exact name, not by pattern. Pattern matching is what
// printed "18192" on every line: /customer|company/ hit FreightPOP's
// "CompanyId" (the id of the FPX account itself, identical on every
// shipment) before the real customer in "Company Name". "CompanyName" is
// likewise the account ("FreightPOP Inc"), not the customer.
export function summarizeRow(row) {
  const byKey = {};
  for (const k of Object.keys(row || {})) {
    if (k.charAt(0) === "_") continue;
    const v = row[k] == null ? "" : String(row[k]).replace(/\s+/g, " ").trim();
    // A value ending in ":" is the next label on the modal ("Ship Date:"),
    // scraped because the real value cell was empty.
    if (v && !/:$/.test(v)) byKey[k.toLowerCase()] = v;
  }
  const first = (names) => {
    for (const n of names) if (byKey[n]) return byKey[n].slice(0, 40);
    return null;
  };
  const date = (names) => {
    for (const n of names) {
      const v = byKey[n];
      if (!v) continue;
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      if (iso) return `${+iso[2]}/${+iso[3]}/${iso[1]}`;
      const us = /^\d{1,2}\/\d{1,2}\/\d{2,4}/.exec(v);
      if (us) return us[0];
    }
    return null;
  };
  const partial = !!(row && (row._partial || row._error));
  return {
    tn: String((row && row._trackingNumber) || "?"),
    status: first(["shipment status", "current status", "lastupdatedstatus", "status"]),
    carrier: first(["carrier name", "carrier"]),
    customer: first(["customer name", "customer", "company name", "brokerspotquotecustomername"]),
    eta: date(["updated eta", "estimated delivery date", "eta", "original eta"]),
    delivered: date(["delivery date", "delivered date"]),
    partial,
    why: partial ? String((row && row._error) || "partial").slice(0, 80) : null,
  };
}

// "Scraped FRTPOP-1 · Issue · carrier BIG O TRANS INC · customer Clark Pacific · ETA 10/16/2026"
export function formatRow(r) {
  return [
    `Scraped ${r.tn}`,
    r.status,
    r.carrier && `carrier ${r.carrier}`,
    r.customer && `customer ${r.customer}`,
    r.delivered ? `delivered ${r.delivered}` : r.eta && `ETA ${r.eta}`,
    r.partial && `grid data only (${r.why || "partial"})`,
  ].filter(Boolean).join(" · ");
}

// Extension status sentences that mean something went wrong but the run goes on.
const WARN_STATUS = /^(Server offline|Server check failed|Couldn't limit the grid|Starting from grid page|Could not read the grid|Page \d+ hit an error|Filter popup did not open|Could not set |Running in the background)|filter icon not found/;
// Per-row steps: live status only, never logged (see the convention above).
const ROW_STEP = /^(Processing \d+ of \d+ — |Clicked .+ — waiting for modal|Scraping modal data for )/;
// A row the extension finished, with or without modal data. The outcome is
// logged once, by that row's "Scraped" line.
const ROW_END = /^(Done .+ — closing modal|Timeout on |Error on |Row .+ left the grid)/;
// Said again by the page summary, or (the "Checking for next page" one) also
// printed after the last page.
const REDUNDANT = /^(Page \d+ done\. Checking for next page|Page done — \d+ of \d+ row\(s\) recorded with grid data only|No tracking links found on this page)/;

// How many pages the sweep has, from the grid pager ("41 - 80 of 1074 items")
// while the extension is on its page `n`. Null when it can't be told.
export function pagesFrom(pager, n) {
  if (!pager || !pager.total || pager.from == null || pager.to == null) return null;
  if (pager.to >= pager.total) return pager.from === 1 ? 1 : n; // on the last page
  const per = pager.to - pager.from + 1;
  if (per <= 0 || Math.floor((pager.from - 1) / per) + 1 !== n) return null; // sweep didn't start on page 1
  return Math.ceil(pager.total / per);
}

// Turns what the extension reports (status sentences, uploaded rows, API
// replies) into log entries that follow the convention above. Pure — the
// caller applies the returned lines and count changes.
//   ingest(event) → { lines: [{ text, level, at? }], counts: {…deltas}, pageStart: n | null }
export function createScrapeLog() {
  let page = null;    // the extension's page counter
  let pages = null;   // total pages, when the pager could be read
  let held = null;    // "Page n done — uploading m row(s)" waiting for its rows
  const label = () => (page ? `Page ${page}${pages ? ` of ${pages}` : ""}` : "Page ?");

  const flushHeld = (lines) => {
    if (!held) return;
    // Rows were scraped but none reached the uploader. (An empty page has
    // already said so on its "0 shipment(s) to scrape" line.)
    if (held.rows > 0) lines.push({ level: "warn", text: `${held.label} · ${held.rows} scraped · none uploaded (no usable tracking number)` });
    held = null;
  };

  function ingest(l) {
    const lines = [];
    const counts = {};
    const add = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
    let pageStart = null;

    if (l.kind === "rows") {
      const rows = Array.isArray(l.rows) ? l.rows : [];
      const byStatus = new Map();
      let partial = 0;
      for (const r of rows) {
        lines.push({ level: r.partial ? "warn" : "data", text: formatRow(r), at: r.t || null });
        add("scraped");
        if (r.partial) { partial++; add("partial"); }
        if (r.status) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
      }
      const top = [...byStatus].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => `${s} ${n}`).join(", ");
      lines.push({
        level: partial ? "warn" : "info",
        text: `${held ? held.label : label()} · ${rows.length} scraped` + (partial ? ` · ${partial} grid data only` : "") + (top ? ` · ${top}` : "") + " · uploading",
      });
      held = null;
      return { lines, counts, pageStart };
    }

    if (l.kind !== "status") {
      // API replies, already worded and levelled where the fetch is wrapped.
      // (An earlier page's reply can land between a page's "uploading" status
      // and its rows, so `held` is left alone here.)
      if (l.kind === "saved") { add("saved", l.n || 0); add("changed", l.changed || 0); }
      else if (l.kind === "uploadError") add("uploadErrors");
      else if (l.kind === "archived") add("archived", l.n || 0);
      if (l.text) lines.push({ level: l.level || "info", text: l.text });
      return { lines, counts, pageStart };
    }

    const text = String(l.text || "");
    if (ROW_STEP.test(text)) return { lines, counts, pageStart };
    if (ROW_END.test(text)) { add("processed"); return { lines, counts, pageStart }; }
    flushHeld(lines);
    let m;
    if ((m = /^Processing page (\d+)/.exec(text))) {
      page = Number(m[1]); pageStart = page;
    } else if ((m = /^Found (\d+) tracking link\(s\) on this page(?: \((\d+) row\(s\) skipped)?/.exec(text))) {
      const noPickup = /Pickup Response header not found/.test(text);
      lines.push({
        level: m[2] || noPickup || m[1] === "0" ? "warn" : "info",
        text: `${label()} · ${m[1]} shipment(s) to scrape` +
          (m[2] ? ` · ${m[2]} row(s) skipped (duplicate or no tracking number)` : "") +
          (noPickup ? " · Pickup Response column not found" : ""),
      });
    } else if ((m = /^Page (\d+) done — uploading (\d+) row/.exec(text))) {
      page = Number(m[1]);
      held = { label: label(), rows: Number(m[2]) };
    } else if (!REDUNDANT.test(text) && text) {
      lines.push({ level: WARN_STATUS.test(text) ? "warn" : "info", text });
    }
    return { lines, counts, pageStart };
  }

  return {
    ingest,
    // A pager that can't be read keeps the last known total.
    setPages(n) { if (n) pages = n; else if (pages && page > pages) pages = null; },
    // End of the run: nothing may stay held back.
    finish() { const lines = []; flushHeld(lines); return lines; },
  };
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
    // Email everyone subscribed to "scrape finished" (Scraping page).
    notifyRunDone(summary).catch(() => {});
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
    self.__fpxRow = null;
    self.__fpxRowAt = {};
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
        // Note when each row finishes, so its "Scraped" line (built at upload
        // time, a page later) can carry the time the row was actually done.
        const text = String(msg.text || "");
        const row = /^Processing \d+ of \d+ — (.+)$/.exec(text);
        if (row) self.__fpxRow = row[1];
        else if (self.__fpxRow && /^(Done |Timeout on |Error on |Row .+ left the grid)/.test(text)) {
          (self.__fpxRowAt ||= {})[self.__fpxRow] = Date.now();
          self.__fpxRow = null;
        }
        self.__fpxPush?.({ kind: "status", text });
      }
      if (msg?.type === "upsertShipmentsBulk" && Array.isArray(msg.rows)) {
        const at = self.__fpxRowAt || {};
        const rows = msg.rows.map((raw) => {
          const r = self.__fpxSummarize(raw);
          r.t = at[r.tn] || null;
          delete at[r.tn];
          return r;
        });
        self.__fpxPush?.({ kind: "rows", rows });
      }
      if (msg?.type === "complete") self.__fpxDone = msg.text || "Done.";
    });
  });

  await worker.evaluate(`self.__fpxSummarize = ${summarizeRow.toString()}; true`);
  const scrapeLog = createScrapeLog();

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
        const got = scrapeLog.ingest(l);
        // A new page: re-read the pager so its lines can say "Page 3 of 27".
        if (got.pageStart) {
          const pager = await readPager(page);
          if (current && pager?.total != null) current.total = pager.total;
          scrapeLog.setPages(pagesFrom(pager, got.pageStart));
        }
        for (const o of got.lines) logLine(o.text, o.level, o.at);
        const c = current?.counts;
        if (c) for (const [k, n] of Object.entries(got.counts)) c[k] = (c[k] || 0) + n;
      }
      if (status && status !== lastStatus) {
        lastStatus = status;
        console.log(`[worker] ${status}`);
        if (current && !stopFlag) { current.status = status; current.statusAt = new Date().toISOString(); }
      }
      if (done) {
        for (const o of scrapeLog.finish()) logLine(o.text, o.level);
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

// The Kendo grid's pager ("41 - 80 of 1074 items") as { from, to, total };
// from/to are null when only the total is shown. Read in the page's main
// world — the pager is plain DOM. Null if not found.
async function readPager(page) {
  try {
    return await page.evaluate(() => {
      const num = (s) => Number(String(s).replace(/,/g, ""));
      const els = [...document.querySelectorAll(".k-pager-info, .k-pager .k-label, [class*='pager-info']")];
      for (const el of els) {
        const t = el.textContent || "";
        const r = /([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)\s+items?/i.exec(t);
        if (r) return { from: num(r[1]), to: num(r[2]), total: num(r[3]) };
        const m = /of\s+([\d,]+)\s+items?/i.exec(t);
        if (m) return { from: null, to: null, total: num(m[1]) };
      }
      if (/no items to display/i.test(document.querySelector(".k-pager-info")?.textContent || "")) return { from: null, to: null, total: 0 };
      return null;
    });
  } catch { return null; }
}

// Total shipments in the grid, from the pager. Null if not found.
async function readGridTotal(page) {
  return (await readPager(page))?.total ?? null;
}
