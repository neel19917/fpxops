import { acquireUserBrowser, hasProfile, getServiceWorker, openWindowPage, ExtensionContexts, dashboardUrlFor, watchAuth, isAuthExpired, clearAuthExpired } from "./browser.js";
import { config } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { readXlsx } from "./xlsxRead.js";
import { filterSortXlsx, writeXlsx } from "./xlsxWrite.js";
import { saveExcel, storageEnabled } from "./storage.js";
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
let enabled = false;

// ── Lanes ──
// Two independent job slots. Each runs one job at a time; the two run side by
// side, also for the same user (same Chromium and FreightPOP login, each job
// in a window of its own).
//   scrape     Refresh All: manual rescrapes and schedules
//   invoicing  erp_audit (History Report pull), get_invoice, approval_check
// Everything a running job owns lives on its lane — nothing below is shared
// between lanes, and every helper that touches job state takes the lane.
const INVOICING_KINDS = ["erp_audit", "get_invoice", "approval_check"];
const makeLane = (name) => ({
  name,
  busy: false,       // a job is running (the lane's lock)
  claiming: false,   // a claim request is in flight: don't start a second job beside it
  current: null,     // live view of the running job: { requestId, user, kind, scope, startedAt, status, statusAt, log, counts, … }
  lastResult: null,  // the last finished job: its run summary + { requestId, log }
  page: null,        // the window the running job is driving
  ext: null,         // its content-script handle (ExtensionContexts), for pause
  stopFlag: false,
  // Pause: the job's content script holds at its next step while this is set
  // (self.__fpxPaused in ITS window's world). Time spent paused is added to
  // every limit.
  pauseFlag: false,
  pausedAt: 0,       // when the current pause began (ms)
  pausedMs: 0,       // earlier pauses of this job, summed
  pauseTimer: null,  // the 30-minute pause limit
  authExpired: false, // this job's own window saw FreightPOP refuse the login (see startAuth)
  // Jobs waiting for this lane inside the service: scheduled runs (scrape
  // lane), and requests claimed while the lane was busy.
  localQueue: [],    // { id, email, source, scheduleId, scheduleName, queuedAt, … }
});
const lanes = { scrape: makeLane("scrape"), invoicing: makeLane("invoicing") };
const laneNamed = (name) => (name === "invoicing" ? lanes.invoicing : lanes.scrape);
const laneForScope = (scope) => (INVOICING_KINDS.includes(scope) ? lanes.invoicing : lanes.scrape);
export const LANES = Object.keys(lanes);

const pausedTotal = (lane) => lane.pausedMs + (lane.pauseFlag ? Date.now() - lane.pausedAt : 0);

// The FreightPOP login is per user, not per lane, and so is browser.js's
// "expired" flag: it is raised by whichever of the user's windows gets the
// 401s. A job clears it when it starts, to judge the login afresh from its
// own window. With two lanes that clear could hide an expiry the other lane's
// running job is about to report — so that job is told first, and each lane
// also remembers what its own window saw (lane.authExpired, set by watchAuth
// in runIn / runPageJob). An expired login therefore fails both lanes: the
// running one through its own flag, the starting one as soon as its window
// is refused too.
function startAuth(lane, who) {
  const email = String(who).toLowerCase();
  if (isAuthExpired(who)) {
    for (const other of Object.values(lanes)) {
      if (other !== lane && other.current && String(other.current.user).toLowerCase() === email) other.authExpired = true;
    }
  }
  clearAuthExpired(who);
  lane.authExpired = false;
}
const authGone = (lane, who) => lane.authExpired || isAuthExpired(who);
const watchLaneAuth = (lane, page, who) => watchAuth(page, who, () => { lane.authExpired = true; }, () => { lane.authExpired = false; });
const EXPIRED = "Your FreightPOP login expired (FreightPOP rejects it) — open More → FreightPOP login, sign in again, then re-run";
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
function logLine(lane, text, level = "info", at = null) {
  if (!lane.current || !text) return;
  const now = new Date().toISOString();
  const t = at ? new Date(at).toISOString() : now;
  const entry = { t, text: String(text).slice(0, 500), level };
  let i = lane.current.log.length;
  if (at) while (i > 0 && lane.current.log[i - 1].t > t) i--;
  lane.current.log.splice(i, 0, entry);
  if (lane.current.log.length > LOG_CAP) lane.current.log.splice(0, lane.current.log.length - LOG_CAP);
  if (!at && level !== "data" && (!lane.stopFlag || level !== "info")) { lane.current.status = entry.text; lane.current.statusAt = now; }
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

// A lane's live job window, for read-only watching from the dashboard. Only
// the user whose browser it runs in may watch it.
export function lanePageFor(laneName, email) {
  const lane = laneNamed(laneName);
  return lane.current && lane.current.user === email && lane.page && !lane.page.isClosed() ? lane.page : null;
}
export function scrapePageFor(email) { return lanePageFor("scrape", email); }

const INVOICING_POLL_MS = 3000;

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
  // One loop per lane: poll() resolves only when the job it started has
  // finished, so a shared loop would hold the other lane up for a whole job.
  // setTimeout loops so an admin change to the poll interval applies live.
  Object.values(lanes).forEach((lane, i) => {
    const loop = async () => {
      await poll(lane).catch((e) => console.error(`[worker] ${lane.name} poll error:`, e.message));
      // Invoicing jobs are started by a person waiting at the screen: look
      // for one every 3 s. Scrapes keep the admin-set interval.
      setTimeout(loop, lane.name === "invoicing" ? INVOICING_POLL_MS : config.scrapePollMs);
    };
    // Offset the lanes so their claim requests don't always land together.
    setTimeout(loop, i * Math.min(2000, config.scrapePollMs / 2));
  });
}

// laneName: "scrape" (default) | "invoicing".
export function workerBusy(laneName = "scrape") { return laneNamed(laneName).busy; }

// Trim logs to the tail for polling; the full log is at fullLog().
const withTail = (job) => job && { ...job, log: job.log.slice(-LOG_TAIL), logTotal: job.log.length };

const laneState = (lane) => ({
  busy: lane.busy,
  // The running job, else the last finished one. Scrape lane: "scrape".
  // Invoicing lane: "erp_audit" | "get_invoice" | "approval_check".
  kind: (lane.current || lane.lastResult)?.kind || null,
  paused: !!lane.current && lane.pauseFlag,
  current: withTail(lane.current),
  lastResult: withTail(lane.lastResult),
  // Once the job has finished: { audit_id, total, pending } for an ERP audit
  // pull, { audit_id, total, ok, failed } for a get-invoices job,
  // { audit_id, approved_rows, matched, not_found } for an approval check.
  // Always null on the scrape lane.
  result: lane.lastResult?.result || null,
  queued: queuedJobs(lane.name),
});

// Served by /stats. The top level is the scrape lane (what the Scraping page
// reads); `invoicing` is the other lane, same inner shapes.
export function workerState() {
  return {
    enabled,
    reason: enabled ? null : (!config.scrapeWorker ? "SCRAPE_WORKER is off" : "FPX_API_KEY not set"),
    pollSeconds: config.scrapePollMs / 1000,
    ...laneState(lanes.scrape),
    invoicing: { enabled, ...laneState(lanes.invoicing) },
  };
}

// Full log of a lane's running job, else its last finished one.
export function fullLog(laneName = "scrape") {
  const lane = laneNamed(laneName);
  const job = lane.current || lane.lastResult;
  return job ? { requestId: job.requestId, user: job.user, counts: job.counts || null, log: job.log } : null;
}

// Ask a lane's running job to stop. A Refresh All finishes the row it's on.
export function requestStop(byEmail, laneName = "scrape") {
  const lane = laneNamed(laneName);
  if (!lane.current) return false;
  console.log(`[worker] stop requested by ${byEmail} for ${lane.current.requestId}`);
  stopJob(lane, lane.current.kind === "erp_audit" || lane.current.kind === "approval_check"
    ? `Stop requested by ${byEmail} — stopping at the next step…`
    : lane.current.kind === "get_invoice"
      ? `Stop requested by ${byEmail} — stopping after the shipment it is on…`
      : `Stop requested by ${byEmail} — finishing the current row…`);
  return true;
}

function stopJob(lane, line) {
  lane.stopFlag = true;
  // A stop gets through a pause; drop the pause so the job can wind down.
  clearTimeout(lane.pauseTimer);
  if (lane.pauseFlag) { lane.pausedMs += Date.now() - lane.pausedAt; lane.pauseFlag = false; lane.current.paused = false; pushPause(lane); }
  logLine(lane, line, "warn");
}

// How a stopped job's note starts: "Stopped by user", or why it stopped itself.
const stoppedBecause = (lane) => lane.current?.stopReason || "Stopped by user";

// Pause / resume a lane's running job (scrape lane: the scrape; invoicing
// lane: ERP audit pull, get invoices or approval check). The other lane is
// not touched.
// Returns whether it is paused now. The job holds at its next step, not
// mid-click.
const PAUSE_LIMIT_MS = 30 * 60 * 1000;
export function requestPause(byEmail, laneName = "scrape") { return setPaused(laneNamed(laneName), true, byEmail); }
export function requestResume(byEmail, laneName = "scrape") { return setPaused(laneNamed(laneName), false, byEmail); }

// `line`: the job pausing itself (get invoices) — logged in place of
// "Paused by …". Everything else is the same pause as the button.
function setPaused(lane, on, byEmail, line = null) {
  if (!lane.current || lane.stopFlag) return false;
  if (lane.pauseFlag === on) {
    if (on && line) logLine(lane, line, "warn"); // already paused by someone: still say why
    return lane.pauseFlag;
  }
  if (on) lane.pausedAt = Date.now(); else lane.pausedMs += Date.now() - lane.pausedAt;
  // A pause holds the lane's one-job-at-a-time lock, so it can't be open-ended.
  clearTimeout(lane.pauseTimer);
  if (on) {
    // Bound to this job: a timer that outlives it must not act on the next one.
    const job = lane.current;
    lane.pauseTimer = setTimeout(() => { if (lane.current === job) pauseLimitReached(lane); }, PAUSE_LIMIT_MS);
  }
  lane.pauseFlag = on;
  lane.current.paused = on;
  console.log(`[worker] ${on ? "pause" : "resume"} requested by ${byEmail || "the job"} for ${lane.current.requestId}`);
  logLine(lane, line || (on ? `Paused by ${byEmail}` : `Resumed by ${byEmail}`), on ? "warn" : "info");
  pushPause(lane);
  return lane.pauseFlag;
}

// 30 minutes paused. A scrape, an ERP audit pull or an approval check carries
// on by itself. A
// get-invoices job stops instead: it pauses because a person has to look, and
// clicking on unattended is the wrong default.
function pauseLimitReached(lane) {
  if (!lane.pauseFlag || !lane.current) return;
  if (lane.current.kind === "get_invoice") {
    lane.current.stopReason = "Stopped: nobody resumed within 30 minutes";
    console.log(`[worker] pause limit reached for ${lane.current.requestId} — stopping`);
    stopJob(lane, lane.current.stopReason);
  } else {
    setPaused(lane, false, "the 30-minute pause limit");
  }
}

// Tell the job's content script — the one in this lane's window only
// (self.__fpxPaused lives in each page's own content-script world). Also
// re-sent on every poll tick while paused, so a page that reloaded mid-pause
// stays paused.
function pushPause(lane) {
  lane.ext?.evaluate(`self.__fpxPaused = ${lane.pauseFlag ? "true" : "false"}; 'ok'`, { awaitPromise: false }).catch(() => {});
}

async function api(path, init = {}) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": config.apiKey, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

// Jobs from the scheduler wait in the scrape lane's localQueue (the API queue
// holds manual requests). Schedules only ever go to the scrape lane; one
// scrape runs at a time across the whole service.
export function enqueueScheduled(schedule) {
  const lane = lanes.scrape;
  if (lane.current?.scheduleId === schedule.id || lane.localQueue.some((j) => j.scheduleId === schedule.id)) {
    return { queued: false, reason: "already queued or running" };
  }
  const job = {
    id: `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    email: schedule.owner, source: "schedule",
    scheduleId: schedule.id, scheduleName: schedule.name || null,
    modes: Array.isArray(schedule.modes) && schedule.modes.length ? schedule.modes : null,
    queuedAt: new Date().toISOString(),
  };
  lane.localQueue.push(job);
  console.log(`[worker] queued scheduled run ${job.id} for ${job.email} (${schedule.name || schedule.id})`);
  setImmediate(() => poll(lane).catch((e) => console.error("[worker] poll error:", e.message)));
  return { queued: true, job };
}

export function queuedJobs(laneName = "scrape") {
  return laneNamed(laneName).localQueue.map(({ id, email, source, scheduleId, scheduleName, queuedAt }) => ({ id, user: email, source, scheduleId, scheduleName, queuedAt }));
}

// A lane only takes a job while it is idle. Resolves when the job it started
// (if any) has finished.
async function poll(lane) {
  if (lane.busy || lane.claiming || !enabled) return;
  if (lane.localQueue.length) {
    const job = lane.localQueue.shift();
    return runJob(lane, job);
  }
  return claimAndRun(lane);
}

async function claimAndRun(lane) {
  // only: the API hands this lane its own kind of request and nothing else
  // (scrape = everything that is not an invoicing scope).
  // caps: the API only hands scope "erp_audit" / "get_invoice" /
  // "approval_check" rows to a worker that says it can run them (an older
  // build would run one as a full rescrape). Sent by both lanes.
  let request;
  lane.claiming = true;
  try {
    ({ request } = await api(`/api/ops/rescrape/pending?claim=1&by=${encodeURIComponent("fpx-browser")}&only=${lane.name}&caps=${INVOICING_KINDS.join(",")}`));
  } finally { lane.claiming = false; }
  if (!request) return;
  const job = {
    id: request.id, apiRequestId: request.id, email: String(request.requested_by || ""), source: "manual", scope: request.scope,
    modes: Array.isArray(request.modes) && request.modes.length ? request.modes : null,
    // Read now: completing the request overwrites its note.
    months: request.scope === "erp_audit" ? monthsFromNote(request.note) : null,
    shipmentType: request.scope === "erp_audit" ? typeFromNote(request.note) : null,
    getInvoice: request.scope === "get_invoice" ? getInvoiceFromRequest(request) : null,
    approvalAuditId: request.scope === "approval_check" ? auditFromNote(request.note) : null,
    requestNote: String(request.note || "").slice(0, 200),
  };
  // An API that does not know `only` yet hands out whatever is oldest: a
  // request is run by the lane its scope belongs to, never by the one that
  // happened to claim it. It is already claimed, so it waits there.
  const owner = laneForScope(job.scope);
  if (owner !== lane) {
    console.warn(`[worker] ${lane.name} lane was handed a ${job.scope || "scrape"} request (${job.id}) — passing it to the ${owner.name} lane`);
    owner.localQueue.push(job);
    setImmediate(() => poll(owner).catch((e) => console.error(`[worker] ${owner.name} poll error:`, e.message)));
    return;
  }
  // A scheduled job may have started while the claim was in flight: this one
  // is already claimed, so it waits its turn instead of running beside it.
  if (lane.busy) { lane.localQueue.push(job); return; }
  return runJob(lane, job);
}

// A get-invoices request: the shipment ids are in tracking_numbers and the
// rest in its note, "audit=<uuid>;from=YYYY-MM-DD;to=YYYY-MM-DD;pause_first=1|0".
// Pause-first is on unless the note switches it off.
export function getInvoiceFromRequest(request) {
  const parts = {};
  for (const piece of String(request?.note || "").split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts[piece.slice(0, eq).trim().toLowerCase()] = piece.slice(eq + 1).trim();
  }
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null);
  const list = Array.isArray(request?.tracking_numbers) ? request.tracking_numbers : [];
  return {
    auditId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts.audit || "") ? parts.audit : null,
    from: date(parts.from),
    to: date(parts.to),
    pauseFirst: parts.pause_first !== "0",
    shipmentIds: [...new Set(list.map((v) => String(v ?? "").trim()).filter(Boolean))],
    note: String(request?.note || "").slice(0, 200),
  };
}

// "audit=<uuid>" in an approval-check request's note → the uuid, else null.
export function auditFromNote(note) {
  const m = /(?:^|;)\s*audit\s*=\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*(?:;|$)/i.exec(String(note || ""));
  return m ? m[1].toLowerCase() : null;
}

// "type=parcel|both|non-parcel" in an ERP audit request's note (non-parcel when absent).
export function typeFromNote(note) {
  const m = /type\s*=\s*(non-parcel|parcel|both)/i.exec(String(note || ""));
  return m ? m[1].toLowerCase() : "non-parcel";
}

// "months=3" in an ERP audit request's note → 1-12 (3 when absent or unreadable).
export function monthsFromNote(note) {
  const m = /months\s*=\s*(\d+)/i.exec(String(note || ""));
  const n = m ? Number(m[1]) : 3;
  return Math.min(12, Math.max(1, Number.isFinite(n) ? n : 3));
}

// Run one job (manual or scheduled) end to end, then record it in the
// persistent run history with its full log.
async function runJob(lane, job) {
  lane.busy = true;
  lane.stopFlag = false;
  clearTimeout(lane.pauseTimer);
  lane.pauseFlag = false; lane.pausedAt = 0; lane.pausedMs = 0;
  lane.authExpired = false;
  const email = job.email;
  const startedAt = Date.now();
  // Scrape lane: a Refresh All scrape. Invoicing lane: an ERP audit pull,
  // get invoices (click GET INVOICE on the shipments picked from an audit), or
  // an approval check (match an audit against the Audit page's Recently Approved).
  const kind = INVOICING_KINDS.includes(job.scope) ? job.scope : "scrape";
  const gi = kind === "get_invoice" ? job.getInvoice || { shipmentIds: [] } : null;
  // `cur` is this job's own record. Everything below reads and writes it
  // through `cur`, so the summary, the log and the result are this job's.
  const cur = lane.current = {
    lane: lane.name, kind, paused: false, result: null, months: kind === "erp_audit" ? job.months || 3 : null, shipmentType: kind === "erp_audit" ? job.shipmentType || "non-parcel" : null,
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
  if (kind === "erp_audit") {
    Object.assign(cur.counts, { reportRows: 0, notExported: 0, uploaded: 0 });
    logLine(lane, `Claimed ERP audit pull · last ${cur.months} month(s) · ${cur.shipmentType} — running as ${email || "unknown user"}`);
  } else if (kind === "approval_check") {
    cur.counts = { approvedRows: 0, matched: 0, notFound: 0 };
    cur.auditId = job.approvalAuditId || null;
    logLine(lane, `Claimed approval check · audit ${String(job.approvalAuditId || "?").slice(0, 8)} — running as ${email || "unknown user"}`);
  } else if (kind === "get_invoice") {
    cur.counts = { total: gi.shipmentIds.length, done: 0, ok: 0, failed: 0 };
    cur.auditId = gi.auditId || null;
    logLine(lane, `Claimed get invoices · ${gi.shipmentIds.length} shipment(s) · report ${gi.from || "?"} to ${gi.to || "?"} · audit ${String(gi.auditId || "?").slice(0, 8)}` +
      `${gi.pauseFirst ? " · pauses after the first" : ""} — running as ${email || "unknown user"}`);
  } else {
    if (job.modes) logLine(lane, `Limited to ${job.modes.join(" + ")} shipments`);
    logLine(lane, job.source === "schedule"
      ? `Scheduled run${job.scheduleName ? ` "${job.scheduleName}"` : ""} — running as ${email}`
      : `Claimed request — running as ${email || "unknown user"}`);
  }
  console.log(`[worker] starting ${job.source} ${kind} run ${job.id} for ${email}`);
  let ok = false;
  let note = "";
  try {
    if (!email.includes("@")) throw new Error(`Request has no user (requested_by="${email}") — rescrapes must come from a signed-in rep`);
    if (!hasProfile(email)) throw new Error(`${email} hasn't logged in to FreightPOP in the hosted view yet`);
    let result;
    if (kind === "erp_audit") {
      result = await runErpAudit(lane, email, cur.months, cur.shipmentType);
    } else if (kind === "get_invoice") {
      if (!gi.auditId || !gi.from || !gi.to) throw new Error(`The request's note could not be read ("${gi.note || ""}") — expected audit=<id>;from=YYYY-MM-DD;to=YYYY-MM-DD;pause_first=1|0`);
      if (!gi.shipmentIds.length) throw new Error("The request has no shipment ids (tracking_numbers is empty)");
      result = await runGetInvoices(lane, email, gi);
    } else if (kind === "approval_check") {
      if (!job.approvalAuditId) throw new Error(`The request's note could not be read ("${job.requestNote || ""}") — expected audit=<id>`);
      result = await runApprovalCheck(lane, email, job.approvalAuditId);
    } else {
      cur.tasksBefore = await taskSnapshot();
      result = await runRefreshAll(lane, email, job.modes || null);
    }
    ok = true; note = result;
    console.log(`[worker] ${job.id} done: ${result}`);
  } catch (e) {
    note = e.message;
    console.error(`[worker] ${job.id} failed:`, e.message);
  } finally {
    if (job.apiRequestId) {
      await api(`/api/ops/rescrape/${job.apiRequestId}/complete`, {
        method: "POST",
        body: JSON.stringify(ok
          ? { note: note.slice(0, 500), result_count: kind === "erp_audit" ? cur.counts?.uploaded ?? 0 : kind === "get_invoice" ? cur.counts?.ok ?? 0 : kind === "approval_check" ? cur.counts?.matched ?? 0 : cur.counts?.saved ?? null }
          : { error: true, note: String(note).slice(0, 500) }),
      }).catch((e) => console.warn("[worker] complete failed:", e.message));
    }
    if (email.includes("@")) recordScrape(email, Date.now() - startedAt, ok);
    const tasksAfter = cur.tasksBefore ? await taskSnapshot() : null;
    logLine(lane, ok ? `Finished: ${note}` : `Failed: ${note}`, ok ? "done" : "error");
    // Get invoices: what was done, whether it finished, stopped or failed.
    if (kind === "get_invoice") {
      const c = cur.counts || {};
      cur.result = { audit_id: gi.auditId || null, total: c.total ?? gi.shipmentIds.length, ok: c.ok || 0, failed: c.failed || 0 };
    }
    // Approval check: what was matched (zeros when it failed or was stopped).
    if (kind === "approval_check") {
      const c = cur.counts || {};
      cur.result = { audit_id: job.approvalAuditId || null, approved_rows: c.approvedRows || 0, matched: c.matched || 0, not_found: c.notFound || 0 };
    }
    const finishedAt = new Date().toISOString();
    const summary = {
      id: job.id, source: job.source, user: email, kind,
      // ERP audit pull: the audit it made ({ audit_id, total, pending }).
      // Get invoices: { audit_id, total, ok, failed }.
      // Approval check: { audit_id, approved_rows, matched, not_found }.
      result: cur.result || null,
      scheduleId: job.scheduleId || null, scheduleName: job.scheduleName || null,
      startedAt: new Date(startedAt).toISOString(), finishedAt, durationMs: Date.now() - startedAt,
      ok, note: String(note).slice(0, 500), modes: job.modes || null,
      counts: cur.counts ? { ...cur.counts, total: cur.total ?? cur.counts.total ?? null } : null,
      // FreightPOP dashboard totals at the start and end of the run (trends).
      fpBefore: cur.fpBefore || null,
      fpAfter: cur.fpAfter || (cur.fpCounts ? { ...cur.fpCounts, at: cur.fpCountsAt } : null),
      // The task board (segments, health flags, shipment dispositions) at the
      // start and end of the run.
      tasksBefore: cur.tasksBefore || null,
      tasksAfter,
    };
    recordRun(summary, cur.log || []);
    if (kind === "scrape") {
      // Fresh data → rebuild the Ask FPX search index and embed what changed.
      reindexAssistant("scrape").catch(() => {});
      // Email everyone subscribed to "scrape finished" (Scraping page).
      notifyRunDone(summary).catch(() => {});
    }
    // Only this lane's state is touched: the other lane's job, log, pause and
    // window are its own.
    lane.lastResult = { ...summary, requestId: job.id, log: cur.log || [] };
    lane.current = null;
    clearTimeout(lane.pauseTimer);
    lane.pauseTimer = null;
    lane.stopFlag = false;
    lane.pauseFlag = false; lane.pausedAt = 0; lane.pausedMs = 0;
    lane.authExpired = false;
    lane.busy = false;
    // Something may have been queued while we ran.
    if (lane.localQueue.length) setImmediate(() => poll(lane).catch(() => {}));
  }
}

async function runRefreshAll(lane, email, modes = null) {
  const lease = await acquireUserBrowser(email, { busy: true });
  try {
    return await runIn(lane, lease.browser, dashboardUrlFor(email), email, modes);
  } finally {
    lease.release();
  }
}

async function runIn(lane, browser, url, who, modes = null) {
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

  startAuth(lane, who);
  const page = await openWindowPage(browser, url);
  lane.page = page;
  const offAuth = watchLaneAuth(lane, page, who);
  try {
    if (/\/login/i.test(page.url())) {
      throw new Error("Your FreightPOP session expired — log in again through the dashboard's hosted view");
    }
    const cdp = await page.createCDPSession();
    const ext = new ExtensionContexts(cdp);
    await ext.init();
    lane.ext = ext;
    // Contexts created before Runtime.enable are replayed on enable, but give
    // the content script (document_idle) a moment to attach.
    const t0 = Date.now();
    while (!ext.ready && Date.now() - t0 < 30_000) await sleep(1000);
    logLine(lane, `Opened ${page.url()} — waiting for the shipment grid…`);
    // Don't start until rows are on screen — otherwise run() "finishes" an
    // empty page in seconds and reports Done with 0 shipments.
    let gridReady = false;
    for (let i = 0; i < 6 && !gridReady; i++) {
      if (/#\/login|\/login\b/i.test(page.url())) throw new Error("Your FreightPOP session expired — open FreightPOP on the Scraping page and log in again");
      if (authGone(lane, who)) throw new Error(EXPIRED);
      gridReady = (await ext.evaluate("fpxEnsureGridReady(10000)").catch(() => ({ value: false }))).value === true;
    }
    if (!gridReady && authGone(lane, who)) throw new Error(EXPIRED);
    if (!gridReady) {
      const why = (await ext.evaluate("fpxDescribeFrameState()").catch(() => ({ value: "" }))).value;
      throw new Error(`FreightPOP's shipment grid never loaded on ${page.url()}${why ? ` (${why})` : ""}`);
    }
    const total = await readGridTotal(page);
    if (lane.current && total != null) lane.current.total = total;
    let counts = await readDashboardCounts(page);
    if (!counts || Object.keys(counts).length < 5) { await sleep(3000); counts = (await readDashboardCounts(page)) || counts; }
    noteCounts(lane, counts);
    logLine(lane, total != null ? `Grid loaded — ${total} shipment(s) in the grid. Starting Refresh All` : "Grid loaded — starting Refresh All");
    const pageSize = Number(setting("browser.scrape_page_size")) || 50;
    await ext.evaluate(`fpxScrapePageSize = ${pageSize}; 'ok'`).catch(() => {});
    // Mode filter (LTL / Truckload / Parcel) — content.js applies it on the grid.
    await ext.evaluate(`fpxScrapeModes = ${JSON.stringify(modes && modes.length ? modes : null)}; 'ok'`).catch(() => {});
    if (lane.pauseFlag) pushPause(lane); // paused while it was starting up
    await ext.evaluate("run(); 'started'", { awaitPromise: false });

    const deadline = Date.now() + config.scrapeTimeoutMs;
    let lastStatus = "";
    let tick = 0;
    // Paused time doesn't count towards the limit.
    while (Date.now() < deadline + pausedTotal(lane)) {
      await sleep(2000);
      if (lane.pauseFlag) pushPause(lane);
      const { done, status, lines } = await worker.evaluate(() => ({
        done: self.__fpxDone, status: self.__fpxStatus, lines: (self.__fpxLog || []).splice(0),
      }));
      for (const l of lines) {
        const got = scrapeLog.ingest(l);
        // A new page: re-read the pager so its lines can say "Page 3 of 27".
        if (got.pageStart) {
          const pager = await readPager(page);
          if (lane.current && pager?.total != null) lane.current.total = pager.total;
          scrapeLog.setPages(pagesFrom(pager, got.pageStart));
        }
        for (const o of got.lines) logLine(lane, o.text, o.level, o.at);
        const c = lane.current?.counts;
        if (c) for (const [k, n] of Object.entries(got.counts)) c[k] = (c[k] || 0) + n;
      }
      if (status && status !== lastStatus) {
        lastStatus = status;
        console.log(`[worker] ${status}`);
        if (lane.current && !lane.stopFlag) { lane.current.status = status; lane.current.statusAt = new Date().toISOString(); }
      }
      if (done) {
        for (const o of scrapeLog.finish()) logLine(lane, o.text, o.level);
        // The run's "after" snapshot of FreightPOP's dashboard totals.
        const end = await readDashboardCounts(page);
        if (lane.current && end) { noteCounts(lane, end); lane.current.fpAfter = { ...end, at: new Date().toISOString() }; }
        return lane.stopFlag ? `Stopped by user. ${done}` : done;
      }
      // Keep the totals fresh (shipments get added/delivered mid-run):
      // FreightPOP's dashboard tiles every ~10s, the grid pager every ~30s.
      ++tick;
      if (tick % 5 === 0 && lane.current) {
        noteCounts(lane, await readDashboardCounts(page));
      }
      if (tick % 15 === 0 && lane.current) {
        const t = await readGridTotal(page);
        if (t != null) lane.current.total = t;
      }
      if (lane.stopFlag && !page.__fpxStopSentAt) {
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
    if (lane.page === page) { lane.page = null; lane.ext = null; }
    await page.close().catch(() => {});
  }
}

// ── ERP audit pull ──────────────────────────────────────────────────────────
// In the requester's own hosted browser: Transactions → Generate History
// Report for the last `months` months (all customers, carriers and shipment
// types), keep the rows not exported to ERP, upload them for an invoice audit.
// The page work is erpAuditPull() in the extension's content.js; this opens
// the window (so the read-only live view shows it, like a scrape), relays its
// log lines, and passes stop / pause on.
async function runErpAudit(lane, email, months, shipmentType) {
  const lease = await acquireUserBrowser(email, { busy: true });
  try {
    return await runErpIn(lane, lease.browser, dashboardUrlFor(email), email, months, shipmentType);
  } finally {
    lease.release();
  }
}

const ERP_LIMIT_MS = 45 * 60_000; // whole pull, not counting paused time

// The part the ERP audit pull and the get-invoices job share: open FreightPOP
// in a window, wait for the extension, start the page work and poll
// fpxErpPoll() every 1.5 s until the page reports the outcome. `job`:
//   noun           "pull" | "get-invoices job" — for messages
//   limitMs        whole job, not counting paused time
//   has / missing  expression that is true when the extension can do it / the error when it can't
//   start          expression that starts the page work
//   setup(ctx)     optional, before the start; returns a cleanup function (awaited at the end)
//   blocked()      optional; true while the page can't answer (a browser prompt is open)
//   onPoll(r, ctx) optional, after the log lines and counts of one poll;
//                  true = it answered a hand-off, skip the rest of this tick
// ctx: { browser, page, cdp, ext, who }
async function runPageJob(lane, browser, url, who, job) {
  startAuth(lane, who);
  const page = await openWindowPage(browser, url);
  lane.page = page;
  const offAuth = watchLaneAuth(lane, page, who);
  const onLogin = () => /#\/login|\/login\b/i.test(page.url());
  let cleanup = null;
  try {
    if (onLogin()) throw new Error("Your FreightPOP session expired — log in again through the dashboard's hosted view");
    const cdp = await page.createCDPSession();
    const ext = new ExtensionContexts(cdp);
    await ext.init();
    lane.ext = ext;
    const t0 = Date.now();
    while (!ext.ready && Date.now() - t0 < 30_000) await sleep(1000);
    if (onLogin()) throw new Error("Your FreightPOP session expired — open FreightPOP on the Scraping page and log in again");
    if (authGone(lane, who)) throw new Error(EXPIRED);
    if (!ext.ready) throw new Error(`FreightPOP never finished loading on ${page.url()} (the extension did not attach to the page)`);
    logLine(lane, `Opened ${page.url()} — waiting for FreightPOP to load…`);
    // The shipment grid on screen = signed in and the app is up. Not needed
    // for the report itself, so its absence is a warning, not a failure.
    let appUp = false;
    for (let i = 0; i < 3 && !appUp; i++) {
      if (onLogin()) throw new Error("Your FreightPOP session expired — open FreightPOP on the Scraping page and log in again");
      if (authGone(lane, who)) throw new Error(EXPIRED);
      appUp = (await ext.evaluate("fpxEnsureGridReady(10000)").catch(() => ({ value: false }))).value === true;
    }
    if (!appUp && authGone(lane, who)) throw new Error(EXPIRED);
    if (!appUp) logLine(lane, "FreightPOP's start page did not finish loading — going to Transactions anyway", "warn");
    const has = (await ext.evaluate(job.has).catch(() => ({ value: false }))).value === true;
    if (!has) throw new Error(job.missing);

    const ctx = { browser, page, cdp, ext, who };
    if (job.setup) cleanup = await job.setup(ctx);
    if (lane.pauseFlag) pushPause(lane); // paused while it was starting up
    await ext.evaluate(job.start, { awaitPromise: false });

    const startedAt = Date.now();
    let lost = 0, restarts = 0;
    // Paused time doesn't count towards the limit.
    while (Date.now() < startedAt + job.limitMs + pausedTotal(lane)) {
      await sleep(1500);
      if (job.blocked?.()) continue;
      if (lane.pauseFlag) pushPause(lane);
      const r = (await ext.evaluate("fpxErpPoll()").catch(() => null))?.value;
      if (!r || !r.started) {
        if (job.blocked?.()) continue; // the prompt opened while this poll was on its way
        // The page (and the job running in it) went away.
        if (onLogin()) throw new Error("Redirected to FreightPOP login mid-run — sign in again, then re-run");
        if (authGone(lane, who)) throw new Error(EXPIRED);
        // A job that moves to another FreightPOP page (Audit is a separate
        // page, so its content script starts afresh) is started again there
        // and carries on from where the page now is.
        if (job.resumeOnReload && ++lost >= 2 && restarts < 4 && ext.ready) {
          const again = await ext.evaluate(job.has).catch(() => null);
          if (again?.value === true) {
            restarts++; lost = 0;
            logLine(lane, `FreightPOP moved to another page (${page.url().replace(/^https?:\/\/[^/]+/, "")}) — carrying on there`);
            if (lane.pauseFlag) pushPause(lane);
            await ext.evaluate(job.restart || job.start, { awaitPromise: false }).catch(() => {});
            continue;
          }
        }
        if (++lost >= 20) throw new Error(`The FreightPOP page reloaded mid-run and the ${job.noun} was lost — re-run it (page is ${page.url()})`);
        continue;
      }
      lost = 0;
      for (const l of r.lines || []) logLine(lane, l.text, l.level || "info");
      if (lane.current && r.counts) Object.assign(lane.current.counts, r.counts);
      if (job.onPoll && (await job.onPoll(r, ctx))) continue;
      if (r.done) {
        if (lane.current && r.done.result) lane.current.result = r.done.result;
        if (!r.done.ok) {
          if (onLogin() || authGone(lane, who)) throw new Error(`${EXPIRED} (${r.done.note})`);
          throw new Error(r.done.note || `The ${job.noun} failed`);
        }
        return r.done.stopped ? `${stoppedBecause(lane)}. ${r.done.note}` : r.done.note;
      }
      if (lane.stopFlag && !page.__fpxStopSentAt) {
        page.__fpxStopSentAt = Date.now();
        await ext.evaluate("stopRequested = true; 'stopping'", { awaitPromise: false }).catch(() => {});
      }
      // If the extension never acknowledges the stop, give up after 2 min.
      if (page.__fpxStopSentAt && Date.now() - page.__fpxStopSentAt > 120_000) {
        return `${stoppedBecause(lane)} (last step: ${lane.current?.status || "none"})`;
      }
      if (onLogin()) throw new Error("Redirected to FreightPOP login mid-run — sign in again, then re-run");
    }
    await ext.evaluate("stopRequested = true; 'stopping'", { awaitPromise: false }).catch(() => {});
    throw new Error(`Timed out after ${job.limitMs / 60000} min (last step: ${lane.current?.status || "none"})`);
  } finally {
    if (cleanup) await Promise.resolve().then(cleanup).catch(() => {});
    offAuth();
    if (lane.page === page) { lane.page = null; lane.ext = null; }
    await page.close().catch(() => {});
  }
}

async function runErpIn(lane, browser, url, who, months, shipmentType) {
  // Rows from FreightPOP's Excel export, all tabs together.
  const excelRows = [];
  const excelFiles = []; // the workbooks themselves, one per tab captured
  let excelHeaders = [];
  let excelFailed = false;
  // For the Excel copy kept in storage (saved once, after the last upload).
  let usedExcel = false;
  let excelResp = null; // the API answer to the one Excel upload
  const screenRows = [];
  let filesSaved = false;
  let saving = null; // the save, finished after the page work
  return runPageJob(lane, browser, url, who, {
    noun: "pull",
    limitMs: ERP_LIMIT_MS,
    has: "typeof erpAuditPull === 'function' && typeof fpxErpPoll === 'function'",
    missing: "The extension in the hosted browser has no ERP audit pull (needs version 4.7 or later) — redeploy the browser service",
    start: `erpAuditPull(${Number(months) || 3}, ${JSON.stringify(String(who))}, ${JSON.stringify(String(shipmentType || "non-parcel"))}); 'started'`,
    onPoll: async (r, { cdp, ext }) => {
      // The page wants FreightPOP's Excel export captured for the tab on screen.
      if (r.download && !r.done) {
        let answer;
        try {
          const got = await captureExport(lane, browser, cdp, ext, lane.current?.requestId || "job");
          const before = excelRows.length;
          const dup = before && got.rows.length === before && JSON.stringify(got.rows[0]) === JSON.stringify(excelRows[0]);
          if (dup) logLine(lane, `Excel export · ${r.download.label} · same rows as the previous tab, counted once`, "warn");
          else { excelRows.push(...got.rows); if (got.buf) excelFiles.push(got.buf); }
          if (!excelHeaders.length) excelHeaders = got.headers;
          logLine(lane, `Excel export · ${r.download.label} · ${got.file} · ${got.rows.length.toLocaleString("en-US")} rows · ${got.headers.length} columns · button "${got.clicked}"`);
          answer = { ok: true, rows: got.rows.length, file: got.file };
        } catch (e) {
          excelFailed = true;
          answer = { ok: false, error: e.message };
        }
        await ext.evaluate(`fpxErpDownloadDone(${JSON.stringify(answer)})`).catch(() => {});
        return true;
      }
      // The page has rows ready: fetch them in slices and post them from here.
      if (r.upload && !r.done) {
        let answer;
        let lastPart = false;
        try {
          const meta = JSON.parse((await ext.evaluate("fpxErpTakeMeta()")).value || "null");
          if (!meta) throw new Error("the page had no upload waiting");
          const rows = [];
          for (let at = 0; at < meta.rowCount; at += 400) {
            rows.push(...JSON.parse((await ext.evaluate(`fpxErpTake(${at}, 400)`)).value || "[]"));
          }
          if (rows.length !== meta.rowCount) throw new Error(`read ${rows.length} of ${meta.rowCount} rows from the page`);
          const { rowCount, ...body } = meta;
          // Prefer the Excel export when every tab's file was captured.
          let send = rows;
          const fromExcel = !excelFailed && excelRows.length ? notExportedSorted(excelRows) : null;
          if (fromExcel && !fromExcel.error && !body.audit_id) {
            // FreightPOP's Excel export leaves some columns blank that the
            // report on screen has (the approved invoice amounts and dates).
            // The saved file stays exactly as FreightPOP wrote it; the audit
            // takes those values from the screen rows of the same shipment.
            const rowKey = (r) => `${String(r["ShipmentID"] ?? "").trim()}|${String(r["Tracking"] ?? "").trim()}`;
            const onScreen = new Map(rows.map((r) => [rowKey(r), r]));
            let filledRows = 0;
            send = fromExcel.rows.map((r) => {
              const scr = onScreen.get(rowKey(r));
              if (!scr) return r;
              let out = r;
              for (const [k, v] of Object.entries(scr)) {
                const has = out[k] !== undefined && out[k] !== null && String(out[k]).trim() !== "";
                if (!has && v !== undefined && v !== null && String(v).trim() !== "") {
                  if (out === r) out = { ...r };
                  out[k] = v;
                }
              }
              if (out !== r) filledRows++;
              return out;
            });
            if (filledRows) logLine(lane, `Filled in values the Excel export leaves blank (approved invoice amounts and dates) from the report on screen · ${filledRows.toLocaleString("en-US")} shipments`);
            usedExcel = true;
            if (body.run) body.run.total_report_rows = excelRows.length;
            logLine(lane, `Source: FreightPOP Excel export · ${excelRows.length.toLocaleString("en-US")} rows · ${send.length.toLocaleString("en-US")} not exported to ERP` +
              (send.length !== rows.length ? ` (the report on screen gave ${rows.length.toLocaleString("en-US")})` : ""), send.length !== rows.length ? "warn" : "info");
          } else {
            logLine(lane, `Source: rows read from the report on screen${fromExcel?.error ? ` (${fromExcel.error})` : ""}`, fromExcel?.error ? "warn" : "info");
          }
          let resp;
          if (usedExcel && body.audit_id) {
            // The Excel export already went up whole with the first part:
            // later parts from the page would only duplicate rows.
            resp = excelResp;
          } else {
            // With the Excel export there is one post, so it is the final one.
            const post = usedExcel ? { ...body, final: true, rows: send } : { ...body, rows: send };
            resp = await api("/api/audits/invoice/from-history", { method: "POST", body: JSON.stringify(post) });
            if (usedExcel) excelResp = resp;
          }
          answer = { ok: true, ...resp };
          if (!usedExcel) screenRows.push(...rows);
          lastPart = usedExcel || body.final !== false;
        } catch (e) {
          answer = { ok: false, error: e.message };
        }
        await ext.evaluate(`fpxErpDeliver(${JSON.stringify(answer)})`).catch(() => {});
        // Keep the Excel files with the audit: once, after the only / last
        // part (the Excel export goes up whole with the first part). The page
        // already has its answer and the save is not waited for here, so a slow
        // one holds nothing up.
        if (answer.ok && answer.audit_id && !filesSaved && lastPart) {
          filesSaved = true;
          saving = saveErpExcel(lane, answer.audit_id, usedExcel ? { files: excelFiles, total: excelRows.length } : { rows: screenRows });
        }
        return true;
      }
      return false;
    },
  }).finally(() => saving); // saveErpExcel never rejects
}

// ── Get invoices ────────────────────────────────────────────────────────────
// After a person has reviewed an ERP audit and picked shipments: in the
// requester's own hosted browser, generate the same History Report and click
// GET INVOICE on each picked shipment, one at a time. The page work is
// erpGetInvoices() in the extension's content.js. This side relays its log,
// saves each shipment's result to the audit as it finishes, pauses the job
// when the page asks (after the first invoice; when FreightPOP asks
// something), and tells the page what only the browser can see: a new
// window, a file download, a browser prompt.
const GET_INVOICE_LIMIT_MS = 90 * 60_000; // whole job, not counting paused time

async function runGetInvoices(lane, email, gi) {
  const lease = await acquireUserBrowser(email, { busy: true });
  try {
    return await runGetInvoicesIn(lane, lease.browser, dashboardUrlFor(email), email, gi);
  } finally {
    lease.release();
  }
}

async function runGetInvoicesIn(lane, browser, url, who, gi) {
  // Results not yet saved to the audit. A failed save never fails the job:
  // it is logged and sent again with the next batch.
  const unsaved = [];
  const save = async (again = false) => {
    if (!unsaved.length) return true;
    const batch = unsaved.slice();
    try {
      const resp = await api(`/api/audits/invoice/${encodeURIComponent(gi.auditId)}/get-invoice-results`, {
        method: "POST", body: JSON.stringify({ by: who, results: batch }), signal: AbortSignal.timeout(20_000),
      });
      // The API counts the rows it could not write but does not name them:
      // the whole batch goes again (saving a result twice is harmless).
      if (resp?.failed) throw new Error(`the API could not write ${resp.failed} of them`);
      if (resp?.unknown) logLine(lane, `${resp.unknown} of ${batch.length} result(s) are for shipments that are not in audit ${String(gi.auditId).slice(0, 8)}`, "warn");
      unsaved.splice(0, batch.length);
      return true;
    } catch (e) {
      logLine(lane, `Could not save ${batch.length} result(s) to the audit (${String(e.message).slice(0, 200)}) — ${again ? "trying again" : "they go with the next batch"}`, "warn");
      return false;
    }
  };
  // Every result saved, or three tries 3 s apart. → how many were left unsaved.
  const saveAll = async () => {
    for (let i = 0; i < 3 && unsaved.length; i++) {
      if (i) await sleep(3000);
      await save(i < 2);
    }
    if (unsaved.length) logLine(lane, `${unsaved.length} result(s) could not be saved to the audit: ${unsaved.map((r) => `${r.shipment_id} ${r.ok ? "OK" : "failed"}`).join(", ")}`.slice(0, 500), "error");
    return unsaved.length;
  };

  let promptOpen = false; // a browser confirm / prompt is on screen: the page is frozen
  let lastPauseId = 0;
  let note;
  try {
    note = await runPageJob(lane, browser, url, who, {
      noun: "get-invoices job",
      limitMs: GET_INVOICE_LIMIT_MS,
      has: "typeof erpGetInvoices === 'function' && typeof fpxErpNote === 'function' && typeof fpxErpPoll === 'function'",
      missing: "The extension in the hosted browser cannot get invoices (needs version 4.11 or later) — redeploy the browser service",
      start: `erpGetInvoices(${JSON.stringify(JSON.stringify({ from: gi.from, to: gi.to, shipmentIds: gi.shipmentIds, pauseFirst: !!gi.pauseFirst, runBy: who }))}); 'started'`,
      blocked: () => promptOpen,
      setup: async ({ page, cdp, ext }) => {
        let ended = false;
        const tell = (n) => ext.evaluate(`fpxErpNote(${JSON.stringify(n)})`, { awaitPromise: false }).catch(() => {});

        // Browser prompts freeze the page until answered. An alert only has
        // OK. A confirm / prompt is a question: it is not answered — the job
        // pauses, and Resume (or a stop) cancels it.
        const onDialog = async (d) => {
          const text = String(d.message() || "").replace(/\s+/g, " ").trim().slice(0, 200);
          try {
            if (d.type() === "alert") { await d.accept(); tell({ kind: "alert", text }); return; }
            if (d.type() === "beforeunload") {
              await d.dismiss(); // stay on the page
              logLine(lane, "FreightPOP tried to leave the page — stayed on it", "warn");
              return;
            }
            promptOpen = true;
            setPaused(lane, true, null, `Get Invoice · FreightPOP is asking in a browser prompt: "${text}" — buttons: OK, Cancel. Nothing was chosen. Press Resume to cancel it and carry on with the next shipment`);
            while (!ended && lane.pauseFlag && !lane.stopFlag) await sleep(500);
            await d.dismiss();
            tell({ kind: "confirm", text });
          } catch (e) {
            logLine(lane, `A browser prompt could not be closed (${e.message})`, "warn");
          } finally {
            promptOpen = false;
          }
        };
        page.on("dialog", onDialog);

        // A window opened by the click: say so, then close it (closing is
        // passive; left open they would pile up, one per shipment).
        const onTarget = async (t) => {
          try {
            if (t.type() !== "page" || t.opener() !== page.target()) return;
            tell({ kind: "window" });
            await sleep(8000);
            let where = "";
            try { const u = new URL(t.url()); where = u.protocol.startsWith("http") ? u.host + u.pathname : u.protocol; } catch { /* blank */ }
            const p = await t.page().catch(() => null);
            if (p && !p.isClosed()) await p.close().catch(() => {});
            logLine(lane, `Get Invoice · the new window${where ? ` (${where.slice(0, 120)})` : ""} was closed`);
          } catch { /* the window went away by itself */ }
        };
        browser.on("targetcreated", onTarget);

        // File downloads: let them land in a folder of this job so they can be
        // seen starting; the folder is removed when the job ends.
        const dir = path.join(path.dirname(config.profileRoot), "erp-downloads", `gi-${String(lane.current?.requestId || "job").replace(/[^a-zA-Z0-9_-]/g, "")}`);
        fs.mkdirSync(dir, { recursive: true });
        await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).catch(() => {});
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true }).catch(() => {});
        const downloads = new Set();
        const onDownload = (e) => {
          if (downloads.has(e.guid)) return;
          downloads.add(e.guid);
          tell({ kind: "download", file: String(e.suggestedFilename || "").slice(0, 80) });
        };
        cdp.on("Page.downloadWillBegin", onDownload);
        cdp.on("Browser.downloadWillBegin", onDownload);

        return async () => {
          ended = true;
          page.off("dialog", onDialog);
          browser.off("targetcreated", onTarget);
          await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
          fs.rmSync(dir, { recursive: true, force: true });
        };
      },
      onPoll: async (r) => {
        if (r.results?.length) {
          unsaved.push(...r.results.map((x) => ({
            shipment_id: String(x.shipment_id), ok: x.ok === true, note: String(x.note || "").slice(0, 500), at: x.at || new Date().toISOString(),
          })));
          await save();
        }
        // The page asks for a pause: the same pause as the button, with its line.
        if (r.pause && r.pause.id > lastPauseId && !r.done) {
          lastPauseId = r.pause.id;
          setPaused(lane, true, null, String(r.pause.text || "Paused by the job — press Resume to continue"));
        }
        return false;
      },
    });
  } catch (e) {
    await saveAll();
    throw e;
  }
  const left = await saveAll();
  return left ? `${note} · ${left} result(s) not saved to the audit` : note;
}

// ── Approval check ──────────────────────────────────────────────────────────
// A second look at an ERP audit: in the requester's own hosted browser, open
// FreightPOP's Audit page, take the Excel export of "Recently Approved" and
// hand every row to the API, which matches them against the audit's shipments
// (approved by EDI, or by which person). The page work is erpApprovalCheck()
// in the extension's content.js — it opens the page and the tab and clicks
// nothing else. The export is kept as <audit id>/recently-approved.xlsx.
const APPROVAL_LIMIT_MS = 20 * 60_000; // page work, not counting paused time
const APPROVAL_POST_MAX_BYTES = 12 * 1024 * 1024; // per POST; the API's limit is 20 MB

async function runApprovalCheck(lane, email, auditId) {
  const lease = await acquireUserBrowser(email, { busy: true });
  try {
    return await runApprovalCheckIn(lane, lease.browser, dashboardUrlFor(email), email, auditId);
  } finally {
    lease.release();
  }
}

async function runApprovalCheckIn(lane, browser, url, who, auditId) {
  let got = null; // the Recently Approved export: { rows, headers, buf, file }
  const note = await runPageJob(lane, browser, url, who, {
    noun: "approval check",
    resumeOnReload: true,
    limitMs: APPROVAL_LIMIT_MS,
    has: "typeof erpApprovalCheck === 'function' && typeof fpxErpPoll === 'function'",
    missing: "The extension in the hosted browser has no approval check (needs version 4.12 or later) — redeploy the browser service",
    start: `erpApprovalCheck(${JSON.stringify(String(who))}); 'started'`,
    restart: `erpApprovalCheck(${JSON.stringify(String(who))}, true); 'started'`,
    onPoll: async (r, { cdp, ext }) => {
      // The page has Recently Approved on screen and wants its Excel captured.
      if (!r.download || r.done) return false;
      let answer;
      try {
        got = await captureExport(lane, browser, cdp, ext, lane.current?.requestId || "job");
        if (lane.current) lane.current.counts.approvedRows = got.rows.length;
        logLine(lane, `Excel export · ${r.download.label} · ${got.file} · ${num(got.rows.length)} rows · ${got.headers.length} columns · button "${got.clicked}"`);
        // A grid that exports only the page on screen gives fewer rows than it holds.
        if (got.gridTotal && got.gridTotal > got.rows.length) {
          logLine(lane, `The Recently Approved grid holds ${num(got.gridTotal)} rows but its Excel export has ${num(got.rows.length)} — only those are matched (FreightPOP exports the page on screen)`, "warn");
        }
        answer = { ok: true, rows: got.rows.length, file: got.file };
      } catch (e) {
        got = null;
        answer = { ok: false, error: e.message };
      }
      await ext.evaluate(`fpxErpDownloadDone(${JSON.stringify(answer)})`).catch(() => {});
      return true;
    },
  });
  // Stopped, or Recently Approved was empty: the page's own sentence stands.
  if (!got) return note;
  if (lane.stopFlag) return `${stoppedBecause(lane)}. The Recently Approved export was read (${num(got.rows.length)} rows) but not matched against the audit.`;

  if (got.buf) await saveExcelFiles(lane, auditId, [{ name: "recently-approved.xlsx", buf: got.buf, rows: got.rows.length }]);

  logLine(lane, `Matching · ${num(got.rows.length)} approved rows against audit ${String(auditId).slice(0, 8)} · columns: ${got.headers.join(", ")}`.slice(0, 500));
  const resp = await postApprovals(lane, auditId, who, got.headers, got.rows);
  const matched = Number(resp?.matched) || 0;
  const notFound = Number(resp?.not_found) || 0;
  const approvedRows = got.rows.length; // the API counts its last part only
  const unsaved = Number(resp?.failed) || 0;
  if (unsaved) logLine(lane, `The API could not save ${num(unsaved)} of the matched shipments — run the approval check again`, "warn");
  if (lane.current) Object.assign(lane.current.counts, { approvedRows, matched, notFound });

  // "EDI 180 · Shaun Smith 20 · others 12"
  const byEdi = Number(resp?.by_edi) || 0;
  const people = Object.entries(resp?.by_person || {}).map(([name, n]) => [String(name), Number(n) || 0])
    .filter(([name, n]) => n > 0 && !/^edi$/i.test(name.trim())).sort((a, b) => b[1] - a[1]);
  const others = people.slice(3).reduce((sum, p) => sum + p[1], 0);
  const who3 = [`EDI ${num(byEdi)}`, ...people.slice(0, 3).map(([name, n]) => `${name.slice(0, 40)} ${num(n)}`), ...(others ? [`others ${num(others)}`] : [])].join(" · ");
  const cu = resp?.columns_used || {};
  const cols = [["shipment", cu.shipment], ["approved by", cu.approved_by], ["approved at", cu.approved_at], ["amount", cu.amount]]
    .map(([label, col]) => `${label} ${col ? `"${col}"` : "not found"}`).join(", ");
  const head = `${num(matched)} of ${num(matched + notFound)} shipments`;
  logLine(lane, `Approvals matched · ${head} · ${who3} · columns used: ${cols}`.slice(0, 500),
    !matched || !cu.approved_by ? "warn" : "done");
  return `${head} of audit ${String(auditId).slice(0, 8)} are in Recently Approved (${num(approvedRows)} approved rows) · ${who3}` + (unsaved ? ` · ${num(unsaved)} not saved, run it again` : "");
}

// Every row of the Recently Approved export → the API, in one POST when it
// fits, else parts of at most ~12 MB; the answer to the final part is the
// match. A 422 (the API found no shipment-id column) fails with its message.
async function postApprovals(lane, auditId, by, columns, rows) {
  const posts = [[]];
  let size = 0;
  for (const r of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (size + bytes > APPROVAL_POST_MAX_BYTES && posts[posts.length - 1].length) { posts.push([]); size = 0; }
    posts[posts.length - 1].push(r);
    size += bytes;
  }
  const path_ = `/api/audits/invoice/${encodeURIComponent(auditId)}/approval-results`;
  let resp = null;
  for (let i = 0; i < posts.length; i++) {
    const part = posts.length > 1 ? ` (part ${i + 1} of ${posts.length})` : "";
    let res;
    try {
      res = await fetch(`${config.apiUrl}${path_}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": config.apiKey },
        body: JSON.stringify({ by, columns, rows: posts[i], part: i + 1, final: i === posts.length - 1 }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      throw new Error(`Sending the approved rows to the API failed${part}: ${e.name === "TimeoutError" ? "no answer after 3 min" : e.message}`);
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status === 422) {
      const seen = Array.isArray(json?.columns) && json.columns.length ? json.columns : columns;
      throw new Error(`${json?.error || "The API could not find a shipment id column in the Recently Approved export"} — columns in the export: ${seen.join(", ")}`.slice(0, 480));
    }
    if (!res.ok) throw new Error(`POST ${path_} → ${res.status} ${(json?.error || text).slice(0, 200)}${part}`);
    resp = json;
    if (posts.length > 1) logLine(lane, `Sent part ${i + 1} of ${posts.length} · ${num(posts[i].length)} rows`);
  }
  if (!resp || typeof resp !== "object") throw new Error(`POST ${path_} returned no JSON`);
  return resp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Click the report's Excel export and read the file Chromium saves.
// → { rows, headers, file, clicked, buf } — buf is the .xlsx itself.
// The same file "Export to Excel" would save, taken straight from the grid:
// ask the report's Kendo grid to build its Excel workbook, keep the bytes and
// skip the browser's download step (which never delivered a file here).
// FreightPOP's own export handlers run first, so the workbook is theirs.
async function kendoExport(page) {
  const t0 = Date.now();
  const out = await page.evaluate(() => new Promise((resolve) => {
    try {
      const $ = window.jQuery, kendo = window.kendo;
      if (!$ || !kendo) return resolve({ error: "the page has no Kendo grid library" });
      if (!kendo.ooxml || !kendo.ooxml.Workbook) return resolve({ error: "the page's Kendo build has no Excel export" });
      const grids = $(".k-grid").filter(":visible").toArray().map((el) => $(el).data("kendoGrid")).filter(Boolean);
      if (!grids.length) return resolve({ error: "no report grid on the page" });
      // The page work may have marked the grid it means (approval check);
      // otherwise the largest one on screen.
      const mark = $("[data-fpx-export-grid]");
      const marked = mark.length ? mark.find(".k-grid, [data-role=grid]").addBack().toArray().map((el) => $(el).data("kendoGrid")).filter(Boolean)[0] : null;
      if (mark.length && !marked) return resolve({ error: "the grid the page marked for export is not a Kendo grid" });
      const grid = marked || grids.sort((a, b) => (b.dataSource.total() || 0) - (a.dataSource.total() || 0))[0];
      if (typeof grid.saveAsExcel !== "function") return resolve({ error: "the report grid has no Excel export" });
      const timer = setTimeout(() => { grid.unbind("excelExport", onExport); resolve({ error: "the grid took over 3 minutes to build the Excel file" }); }, 180000);
      function onExport(e) {
        e.preventDefault(); // we take the bytes; nothing is saved to disk
        grid.unbind("excelExport", onExport);
        try {
          const wb = new kendo.ooxml.Workbook(e.workbook);
          const done = (url) => { clearTimeout(timer); resolve({ dataUrl: String(url), rows: grid.dataSource.total() }); };
          const fail = (err) => { clearTimeout(timer); resolve({ error: "building the Excel file failed: " + (err && err.message || err) }); };
          if (typeof wb.toDataURLAsync === "function") wb.toDataURLAsync().then(done, fail);
          else done(wb.toDataURL());
        } catch (err) { clearTimeout(timer); resolve({ error: "building the Excel file failed: " + (err && err.message || err) }); }
      }
      grid.bind("excelExport", onExport);
      // Every row, not just the page on screen (Recently Approved shows 10
      // of 155). Only this export call is affected; the setting is put back.
      const excelBefore = grid.options.excel;
      grid.options.excel = Object.assign({}, excelBefore, { allPages: true });
      try { grid.saveAsExcel(); } finally { setTimeout(() => { grid.options.excel = excelBefore; }, 0); }
    } catch (err) { resolve({ error: String(err && err.message || err) }); }
  }));
  if (out.error) throw new Error(out.error);
  const b64 = String(out.dataUrl).split(",")[1] || "";
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100) throw new Error("the grid returned an empty Excel file");
  const { headers, rows } = readXlsx(buf);
  if (!rows.length) throw new Error("the Excel file has no rows");
  return { rows, headers, buf, gridTotal: Number(out.rows) || null, file: `Excel export (${(buf.length / 1024 / 1024).toFixed(1)} MB, built in ${Math.round((Date.now() - t0) / 1000)}s)`, clicked: "Export to Excel" };
}

async function captureExport(lane, browser, cdp, ext, jobId) {
  if (lane.page) {
    try { return await kendoExport(lane.page); }
    catch (e) { logLine(lane, `Excel export from the grid failed (${e.message}) — trying the Export to Excel button`, "warn"); }
  }
  const dir = path.join(path.dirname(config.profileRoot), "erp-downloads", String(jobId).replace(/[^a-zA-Z0-9_-]/g, ""));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  // Page-level and browser-level: Chromium versions differ in which they honour.
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).catch(() => {});
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).catch(() => {});
  try {
    const root = await browser.target().createCDPSession();
    await root.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).catch(() => {});
    await root.detach().catch(() => {});
  } catch { /* page-level setting may be enough */ }

  const click = JSON.parse((await ext.evaluate("fpxErpClickExport()")).value || "{}");
  if (click.error) throw new Error(`${click.error}${click.buttons?.length ? ` — buttons on the page: ${click.buttons.join(", ")}` : ""}`);

  const until = Date.now() + 45_000;
  let last = null;
  while (Date.now() < until) {
    await sleep(1000);
    const done = fs.readdirSync(dir).filter((f) => !/\.(crdownload|tmp|part)$/i.test(f));
    if (!done.length) continue;
    const file = path.join(dir, done[0]);
    const size = fs.statSync(file).size;
    if (size > 0 && last === size) {
      try {
        if (!/\.xlsx$/i.test(done[0])) throw new Error(`the export is "${done[0]}", not an .xlsx file`);
        const buf = fs.readFileSync(file);
        const { headers, rows } = readXlsx(buf);
        if (!rows.length) throw new Error(`"${done[0]}" has no rows`);
        return { rows, headers, buf, file: done[0], clicked: click.clicked };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    last = size;
  }
  const partial = fs.readdirSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  throw new Error(`clicked "${click.clicked}" but no file arrived within 45s${partial.length ? ` (still downloading: ${partial.join(", ")})` : ""}${click.others?.length ? ` — other candidates: ${click.others.join(", ")}` : ""}`);
}

// The "not exported to ERP, highest charge first" rule, shared by the rows
// that are uploaded and the Excel copy that is kept.
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
const exportedKey = (keys) => keys.find((k) => normKey(k) === "exportedtoerp") || keys.find((k) => normKey(k).includes("export") && normKey(k).includes("erp")) || null;
const isNotExported = (v) => v === null || v === undefined || ["", "0", "0.0", "false", "no", "n"].includes(String(v).trim().toLowerCase());
function markedUpRate(r) {
  const v = r["Shipment Marked-Up Rate"];
  if (v === null || v === undefined || v === "") return null;
  const x = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(x) ? x : null;
}
function byRateDesc(x, y) {
  const a = markedUpRate(x), b = markedUpRate(y);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

// Rows of the export that are not exported to ERP, highest charge first.
// → { rows } or { error }
function notExportedSorted(all) {
  const key = exportedKey(Object.keys(all[0] || {}));
  if (!key) return { error: 'the Excel file has no "Exported to ERP" column' };
  const rows = all.filter((r) => isNotExported(r[key])).map((r) => (key === "Exported to ERP" ? r : { ...r, "Exported to ERP": r[key] }));
  rows.sort(byRateDesc);
  return { rows };
}

// ── Excel copies kept with an audit (Supabase Storage, private bucket) ──
const mb = (buf) => `${(buf.length / 1024 / 1024).toFixed(1)} MB`;
const num = (n) => Number(n || 0).toLocaleString("en-US");

// Save [{ name, buf, rows }] under <audit id>/ and say so in one line. Never
// throws: a file that could not be kept is a warning, not a failed job.
async function saveExcelFiles(lane, auditId, files) {
  if (!files.length) return;
  if (!storageEnabled) {
    logLine(lane, `Excel not saved (${files.map((f) => f.name).join(", ")}) — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on the browser service`, "warn");
    return;
  }
  const saved = [];
  for (const f of files) {
    try {
      await saveExcel(`${auditId}/${f.name}`, f.buf);
      saved.push(`${f.name} (${num(f.rows)} rows, ${mb(f.buf)})`);
    } catch (e) {
      logLine(lane, `Excel not saved · ${f.name} (${String(e.message).slice(0, 300)})`, "warn");
    }
  }
  if (saved.length) logLine(lane, `Excel saved · ${saved.join(" · ")}`);
}

// The ERP pull's files. With FreightPOP's Excel export captured:
// not-exported.xlsx is that same workbook (layout, titles, column order and
// styles untouched) holding only the not-exported rows, highest charge first,
// and full.xlsx is the export as it came. Without it: not-exported.xlsx is a
// plain workbook of the rows read from the screen, and there is no full file.
//   src: { files: Buffer[], total } | { rows: object[] }
async function saveErpExcel(lane, auditId, src) {
  const out = [];
  try {
    if (src.files?.length) {
      const [first, ...more] = src.files;
      const key = exportedKey(readXlsx(first).headers);
      if (!key) throw new Error('the Excel file has no "Exported to ERP" column');
      const keep = (k) => (r) => isNotExported(r[k]);
      const add = (name, buf, rows) => out.push({ name, buf, rows: rows ?? readXlsx(buf).rows.length });
      let merged = null;
      if (more.length) {
        // Two tabs captured (type "both"): one workbook with the rows of both.
        try {
          merged = { part: filterSortXlsx(first, { keep: keep(key), compare: byRateDesc, more }), full: filterSortXlsx(first, { more }) };
        } catch (e) {
          logLine(lane, `The tabs' Excel files could not be joined into one (${String(e.message).slice(0, 200)}) — saving one file per tab`, "warn");
        }
      }
      if (merged) {
        add("not-exported.xlsx", merged.part);
        add("full.xlsx", merged.full, src.total);
      } else {
        // One tab — or tabs with different columns: each as FreightPOP gave it.
        src.files.forEach((file, i) => {
          const tag = i ? `-${i + 1}` : "";
          const k = exportedKey(readXlsx(file).headers);
          if (k) add(`not-exported${tag}.xlsx`, filterSortXlsx(file, { keep: keep(k), compare: byRateDesc }));
          else logLine(lane, `Tab ${i + 1}'s Excel file has no "Exported to ERP" column — no not-exported${tag}.xlsx for it`, "warn");
          add(`full${tag}.xlsx`, file, more.length ? undefined : src.total);
        });
      }
    } else if (src.rows?.length) {
      // Title order of the first row; rows leave blank cells out, so titles
      // that first show up further down are added after those.
      const headers = [];
      const seen = new Set();
      for (const r of src.rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
      out.push({ name: "not-exported.xlsx", buf: writeXlsx(headers, src.rows), rows: src.rows.length });
      logLine(lane, "FreightPOP's Excel export was not captured — not-exported.xlsx is built from the rows read on screen (plain layout), and there is no full.xlsx", "warn");
    }
  } catch (e) {
    logLine(lane, `Excel files could not be built (${String(e.message).slice(0, 300)})`, "warn");
  }
  await saveExcelFiles(lane, auditId, out);
}

// The Tasks board in numbers, from the API (null if it can't be read — a
// missing snapshot must never fail a scrape).
async function taskSnapshot() {
  try { return await api("/api/tasks/v2/snapshot"); }
  catch (e) { console.warn("[worker] task snapshot failed:", e.message); return null; }
}

// Remember the latest tile reading; the first complete one (all five tiles)
// is the run's "before" snapshot — FreightPOP fills the tiles a moment after
// the grid, so the very first read can be partial.
function noteCounts(lane, c) {
  if (!lane.current || !c) return;
  const at = new Date().toISOString();
  lane.current.fpCounts = c; lane.current.fpCountsAt = at;
  if (!lane.current.fpBefore && Object.keys(c).length >= 5) lane.current.fpBefore = { ...c, at };
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
