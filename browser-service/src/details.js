import { acquireUserBrowser, closeUserBrowser, hasProfile, saveCookiesNow, openWindowPage } from "./browser.js";
import { recordRun } from "./runs.js";
import { config } from "./config.js";

// The shipment details job: for each shipment it is asked about, it opens
// FreightPOP's own Shipment Details page and reads what is on it (carrier,
// sale, cost, gross profit, the quote breakdown). What it reads goes to the
// API, which keeps it in fpx_shipment_details for the tracking dashboard.
//
// It runs in a second, separate Chromium (see `variant` in browser.js), so it
// never shares a window or a process with the scraping and invoicing jobs or
// with the person's own FreightPOP view.
//
// READ ONLY. The page is opened by address, never through a button. A guard
// installed before the page's own scripts stops every click, key press and
// form submit except the one control this job marks: the quote's DETAILS
// link, which opens the read-only Quote Detail panel. Browser prompts are
// always cancelled. Nothing is typed, saved, sent, cancelled or deleted.

export const DETAILS_SCOPE = "shipment_details";
const VARIANT = "details";
const MAX_SHIPMENTS = 20;       // a request that names its shipments
const MAX_SWEEP = 3000;         // a sweep of every tracked shipment
const SWEEP_LIMIT_MS = 4 * 60 * 60_000;
const LOG_KEEP = 5000;
const PAGE_WAIT_MS = 60_000;
const FP_ORIGIN = "https://app.freightpop.com";
// A small page on FreightPOP's own address: enough to read and write its
// stored login without loading the app.
const LOGIN_CARRIER_URL = `${FP_ORIGIN}/Scripts/PageScripts/Config.js`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;
let current = null; // the running job: { requestId, user, startedAt, sweep, counts, shipment, stopping, log }
let livePage = null; // its window, for read-only watching
let last = null;    // the last finished job

export const detailsWorkerState = () => (busy ? "busy" : "idle");
// What the monitor page shows. Only the person running a job (or an admin) sees its log.
export function detailsState(who) {
  const mine = (job) => job && (job.user === who.email || who.isAdmin);
  return {
    state: busy ? "busy" : "idle",
    current: mine(current) ? { ...current, log: current.log.slice(-500) } : null,
    last: mine(last) ? { ...last, log: last.log.slice(-500) } : null,
  };
}
// The job's window, for the watch-only live view. Only its owner may watch.
export function detailsPageFor(email) {
  return current && current.user === email && livePage && !livePage.isClosed() ? livePage : null;
}
// Stop after the shipment in progress.
export function requestDetailsStop(who) {
  if (!current || (current.user !== who.email && !who.isAdmin)) return false;
  current.stopping = true;
  return true;
}

async function api(path, init = {}) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": config.apiKey, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

// note: "q=<shipment id>:<quote id>[:<sale>:<cost>],…" — sale and cost are the
// two figures FreightPOP's own shipment grid hands this page when a person
// opens it (the page shows the cost it is given; it does not look it up).
function quotesFromNote(note) {
  const out = new Map();
  const m = /(?:^|;)\s*q=([^;]*)/.exec(String(note || ""));
  for (const pair of (m ? m[1] : "").split(",")) {
    const [sid, qid, sale, cost, alt] = pair.split(":").map((x) => String(x || "").trim());
    if (!/^\d+$/.test(sid) || !/^\d+$/.test(qid)) continue;
    const num = (v) => (/^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
    out.set(sid, { quoteId: qid, sale: num(sale), cost: num(cost), altQuoteId: /^\d+$/.test(alt || "") ? alt : null, spot: alt === "s" });
  }
  return out;
}

// The same address FreightPOP's dashboard builds for its DETAILS button
// (Broker/Scripts/Dashboard.js, ViewShipHistory), opened as a page of its own.
function detailUrl({ quoteId, sale, cost }) {
  const p = new URLSearchParams({ FromHistory: "true", QuoteID: quoteId, FromEmailLink: "false", IsFromIframe: "false" });
  if (sale != null) p.set("Amount", String(sale));
  p.set("bh", "true");
  if (cost != null) {
    p.set("co", String(cost));
    p.set("pr", sale != null && sale > cost ? (sale - cost).toFixed(2) : "0");
  }
  p.set("v", "");
  return `${FP_ORIGIN}/ShipmentDetail.html?${p}`;
}

// Runs in the page, before FreightPOP's scripts: nothing can be pressed
// except an element this job has marked with data-fpx-allowed.
function installGuard() {
  try { window.print = () => {}; } catch { /* left as it is */ }
  const stop = (e) => {
    const t = e.target;
    if (t && t.closest && t.closest("[data-fpx-allowed]")) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  for (const type of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "keydown", "keypress", "keyup", "submit", "change", "input", "paste", "drop"]) {
    document.addEventListener(type, stop, true);
  }
}

// Reads the person's FreightPOP login out of their own browser (FreightPOP
// keeps it in the page's local storage, not only in cookies).
async function readLogin(email) {
  const lease = await acquireUserBrowser(email);
  let page = null;
  try {
    page = await openWindowPage(lease.browser, LOGIN_CARRIER_URL);
    return await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => [k, String(v)]));
  } finally {
    if (page) await page.close().catch(() => {});
    lease.release();
  }
}

async function readOne(page, shipmentId, quote, log) {
  // A spot quote opens by its spot quote id; if that page is not this
  // shipment's, the shipment's own quote id is tried.
  let quoteId = quote.quoteId;
  let ready = false;
  for (const tryId of [quote.quoteId, quote.altQuoteId].filter(Boolean)) {
    quoteId = tryId;
    await page.goto(detailUrl({ ...quote, quoteId: tryId }), { waitUntil: "domcontentloaded", timeout: PAGE_WAIT_MS });
    if (/login/i.test(new URL(page.url()).pathname + new URL(page.url()).hash)) throw Object.assign(new Error("FreightPOP asked for a login: sign in again on the FreightPOP login page, then read again"), { fatal: true });
    // The page fills in from FreightPOP's API: wait for this shipment's id, then for the text to stop growing.
    ready = await page.waitForFunction(
      (sid) => new RegExp(`ShipmentID:\\s*${sid}\\b`).test(document.body ? document.body.innerText : ""),
      { timeout: quote.altQuoteId && tryId === quote.quoteId ? 25_000 : PAGE_WAIT_MS, polling: 500 }, String(shipmentId),
    ).then(() => true, () => false);
    if (ready) break;
    if (quote.altQuoteId && tryId === quote.quoteId) log(`Shipment ${shipmentId} · quote ${tryId} did not show this shipment — trying its own quote ${quote.altQuoteId}`, "warn");
  }
  if (!ready) throw new Error(`FreightPOP's Shipment Details page did not show shipment ${shipmentId} (quote ${quoteId})`);
  let len = -1;
  for (let i = 0, calm = 0; i < 24 && calm < 3; i++) {
    const n = await page.evaluate(() => document.body.innerText.length);
    calm = n === len ? calm + 1 : 0;
    len = n;
    await sleep(500);
  }
  const main = await page.evaluate(() => {
    const clean = (t) => String(t || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    // Typed-in values are not part of the page text: the vendor name is one.
    const inputs = {};
    for (const el of document.querySelectorAll("input[type='text'], input:not([type]), select, textarea")) {
      const r = el.getClientRects();
      if (!r.length) continue;
      const value = el.tagName === "SELECT" ? ((el.options[el.selectedIndex] || {}).text || "") : el.value;
      if (!String(value || "").trim()) continue;
      const row = el.closest("tr, .row, .form-group, div");
      const label = clean(row ? row.innerText : "").split("\n")[0].slice(0, 60) || el.id || el.name || "";
      if (label && !(label in inputs)) inputs[label] = clean(value).slice(0, 300);
    }
    return { text: clean(document.body.innerText).slice(0, 200000), inputs, url: location.href.slice(0, 300) };
  });
  if (!new RegExp(`ShipmentID:\\s*${shipmentId}\\b`).test(main.text)) {
    throw new Error(`The page for quote ${quoteId} is not shipment ${shipmentId}: nothing was stored`);
  }

  // The one click this job makes: the quote's DETAILS link (opens Quote Detail, read only).
  let quoteText = "";
  const marked = await page.evaluate(() => {
    // FreightPOP's own control: <span id="RateBreakDownSpan"><b onclick="ShowRateBreakDown()">DETAILS</b></span>
    const leaf = [...document.querySelectorAll("[onclick*='ShowRateBreakDown']")]
      .find((el) => el.getClientRects().length && /^details$/i.test((el.innerText || el.textContent || "").trim()));
    if (!leaf) return false;
    leaf.setAttribute("data-fpx-allowed", "1");
    leaf.click();
    return true;
  });
  if (marked) {
    log(`Click · DETAILS (the quote's breakdown) · shipment ${shipmentId}`);
    api("/api/audits/erp/click-log", {
      method: "POST", signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ clicks: [{ at: new Date().toISOString(), n: 1, label: "DETAILS (quote breakdown)", tag: "a", page: "/ShipmentDetail.html", shipment_id: String(shipmentId), job: DETAILS_SCOPE, request_id: log.requestId, run_by: log.who }] }),
    }).catch(() => {});
    // Usually open within a second. A shipment with no breakdown (some truckloads) never opens it.
    const shown = await page.waitForFunction(() => {
      const m = document.querySelector("#RateBreakDownModal");
      return !!m && m.getClientRects().length > 0 && /TOTAL/i.test(m.innerText || "");
    }, { timeout: 6_000, polling: 250 }).then(() => true, () => false);
    if (shown) {
      await sleep(500);
      quoteText = await page.evaluate(() => String(document.querySelector("#RateBreakDownModal").innerText || "")
        .replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 20000));
    }
    if (!quoteText) log(`Shipment ${shipmentId} has no quote breakdown panel: stored without it`);
  } else {
    log(`No DETAILS link beside the quote for shipment ${shipmentId}: stored without the breakdown`, "warn");
  }
  return { shipment_id: String(shipmentId), quote_id: String(quoteId), text: main.text, inputs: main.inputs, quote_text: quoteText, url: main.url, cost_given: quote.cost != null, spot: quote.spot === true, grid_sale: quote.sale, grid_cost: quote.cost };
}

async function run(request) {
  const startedAt = Date.now();
  const who = String(request.requested_by || "");
  const sweep = /(?:^|;)\s*all=1\b/.test(String(request.note || ""));
  const lines = [];
  const job = { requestId: request.id, user: who, startedAt: new Date(startedAt).toISOString(), sweep, counts: { total: 0, done: 0, stored: 0, failed: 0 }, shipment: null, stopping: false, log: lines };
  current = job;
  const log = (text, level = "info") => {
    lines.push({ t: new Date().toISOString(), level, text: String(text) });
    if (lines.length > LOG_KEEP) lines.splice(0, lines.length - LOG_KEEP);
    console.log(`[details] ${level} ${text}`);
  };
  log.requestId = request.id;
  log.who = who;
  let ok = false, note = "";
  let lease = null, page = null;
  try {
    if (!who.includes("@")) throw new Error(`The request has no person to run as (requested_by="${who}")`);
    // Which shipments: the ones the request names, or every tracked shipment.
    let quotes = quotesFromNote(request.note);
    let ids = (Array.isArray(request.tracking_numbers) ? request.tracking_numbers : []).map(String).filter((id) => quotes.has(id)).slice(0, MAX_SHIPMENTS);
    if (sweep) {
      const list = await api("/api/shipment-details/sweep-list", { signal: AbortSignal.timeout(120_000) });
      quotes = new Map();
      for (const r of (list.shipments || []).slice(0, MAX_SWEEP)) {
        if (/^\d+$/.test(String(r.shipment_id)) && /^\d+$/.test(String(r.quote))) quotes.set(String(r.shipment_id), { quoteId: String(r.quote), sale: r.sale ?? null, cost: r.cost ?? null, altQuoteId: null, spot: r.spot === true });
      }
      ids = [...quotes.keys()];
      if (list.skipped) log(`${list.skipped} tracked shipment(s) have no FreightPOP quote id yet and are left out`, "warn");
    }
    if (!ids.length) throw new Error(sweep ? "No tracked shipment has a FreightPOP quote id yet: run a scrape first" : "The request names no shipment with a FreightPOP quote id");
    job.counts.total = ids.length;
    if (!hasProfile(who)) await saveCookiesNow(who);
    if (!hasProfile(who)) throw new Error(`${who} hasn't logged in to FreightPOP in the hosted view yet`);
    log(`Claimed shipment details · ${ids.length} shipment(s)${sweep ? " (every tracked shipment)" : ""} — running as ${who} in a separate browser · read only`);

    const login = await readLogin(who);
    if (!login.length) throw new Error("No FreightPOP login was found in your hosted browser: sign in on the FreightPOP login page, then read again");
    lease = await acquireUserBrowser(who, { busy: true, variant: VARIANT });
    page = await openWindowPage(lease.browser, LOGIN_CARRIER_URL);
    await page.evaluate((entries) => { for (const [k, v] of entries) localStorage.setItem(k, v); }, login);
    await page.evaluateOnNewDocument(installGuard);
    page.on("dialog", (d) => { log(`FreightPOP opened a browser prompt ("${String(d.message()).slice(0, 120)}") — cancelled`, "warn"); d.dismiss().catch(() => {}); });
    // A window the page opens by itself is closed unread.
    lease.browser.on("targetcreated", async (t) => {
      try { if (t.type() === "page" && t.opener() === page.target()) { const p = await t.page(); if (p) await p.close(); } } catch { /* gone */ }
    });
    livePage = page;

    let inARow = 0; // failures in a row: several means the login or FreightPOP itself is gone
    for (const id of ids) {
      if (job.stopping) { log(`Stopped by ${who} after ${job.counts.done} of ${ids.length}`, "warn"); break; }
      if (Date.now() - startedAt > SWEEP_LIMIT_MS) { log(`Stopped: the ${SWEEP_LIMIT_MS / 3_600_000}-hour limit was reached after ${job.counts.done} of ${ids.length}`, "warn"); break; }
      job.shipment = id;
      try {
        const record = await readOne(page, id, quotes.get(id), log);
        const out = await api("/api/shipment-details", { method: "POST", signal: AbortSignal.timeout(30_000), body: JSON.stringify({ by: who, records: [record] }) });
        if (out?.stored) { job.counts.stored++; inARow = 0; log(`Shipment ${id} · stored · ${out.summary?.[0] || `${record.text.length} characters`}`, "done"); }
        else { job.counts.failed++; inARow++; log(`Shipment ${id} · read, but not stored (${String(out?.error || "the API refused it").slice(0, 160)})`, "error"); }
      } catch (e) {
        job.counts.failed++; inARow++;
        log(`Shipment ${id} · ${String(e.message || e).slice(0, 300)}`, "error");
        if (e.fatal) throw e;
      }
      job.counts.done++;
      if (inARow >= 6) throw new Error(`Stopped: ${inARow} shipments in a row could not be read. Check the FreightPOP login, then read again`);
      if (job.counts.done % 25 === 0) log(`${job.counts.done} of ${ids.length} done · ${job.counts.stored} stored · ${job.counts.failed} failed`);
      await sleep(400); // a breath between pages
    }
    ok = job.counts.stored > 0;
    note = `${job.counts.stored} of ${ids.length} shipment(s) read from FreightPOP${job.counts.failed ? ` · ${job.counts.failed} failed` : ""}${job.counts.done < ids.length ? ` · stopped after ${job.counts.done}` : ""}`;
    if (!ok) note = lines.filter((l) => l.level === "error").pop()?.text || note;
  } catch (e) {
    note = String(e.message || e).slice(0, 400);
    if (job.counts.stored) note = `${job.counts.stored} of ${job.counts.total} read, then: ${note}`.slice(0, 480);
    log(`Failed: ${note}`, "error");
  } finally {
    livePage = null;
    job.shipment = null;
    if (page) await page.close().catch(() => {});
    if (lease) lease.release();
    await closeUserBrowser(who, VARIANT).catch(() => {});
  }
  log(`Finished: ${note}`, ok ? "done" : "error");
  const stored = job.counts.stored;
  await api(`/api/ops/rescrape/${request.id}/complete`, { method: "POST", body: JSON.stringify({ result_count: stored, note, ...(ok ? {} : { error: true }) }) })
    .catch((e) => console.warn("[details] could not complete the request:", e.message));
  try {
    recordRun({
      id: request.id, source: "manual", user: who, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt, ok, note, counts: { scraped: stored, saved: stored, uploadErrors: job.counts.failed, total: job.counts.total },
    }, lines);
  } catch (e) { console.warn("[details] run not recorded:", e.message); }
  last = { requestId: request.id, user: who, ok, note, finishedAt: new Date().toISOString(), counts: { ...job.counts }, log: lines };
  current = null;
}

async function tick() {
  if (busy || !config.apiKey) return;
  busy = true;
  try {
    const { request } = await api(`/api/ops/rescrape/pending?claim=1&by=${encodeURIComponent("fpx-browser")}&only=details&caps=${DETAILS_SCOPE}`);
    if (request && request.scope === DETAILS_SCOPE) await run(request);
    else if (request) console.warn(`[details] was handed a ${request.scope} request (${request.id}) — not run here`);
  } catch (e) {
    console.warn("[details] poll error:", e.message);
  } finally {
    busy = false;
  }
}

export function startDetailsWorker() {
  setInterval(() => { tick().catch(() => {}); }, 8000).unref();
  console.log("[details] shipment details worker started (read only, separate browser)");
}
