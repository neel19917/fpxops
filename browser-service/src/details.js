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
const MAX_SHIPMENTS = 20;
const PAGE_WAIT_MS = 60_000;
const FP_ORIGIN = "https://app.freightpop.com";
// A small page on FreightPOP's own address: enough to read and write its
// stored login without loading the app.
const LOGIN_CARRIER_URL = `${FP_ORIGIN}/Scripts/PageScripts/Config.js`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;
let last = null; // the last finished job, for /health

export const detailsWorkerState = () => (busy ? "busy" : "idle");
export const detailsLast = () => last;

async function api(path, init = {}) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": config.apiKey, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

// note: "q=<shipment id>:<quote id>,<shipment id>:<quote id>"
function quotesFromNote(note) {
  const out = new Map();
  const m = /(?:^|;)\s*q=([^;]*)/.exec(String(note || ""));
  for (const pair of (m ? m[1] : "").split(",")) {
    const [sid, qid] = pair.split(":").map((x) => String(x || "").trim());
    if (/^\d+$/.test(sid) && /^\d+$/.test(qid)) out.set(sid, qid);
  }
  return out;
}

const detailUrl = (quoteId) => `${FP_ORIGIN}/ShipmentDetail.html?${new URLSearchParams({ FromHistory: "true", QuoteID: quoteId, FromEmailLink: "false", IsFromIframe: "false", bh: "true" })}`;

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

async function readOne(page, shipmentId, quoteId, log) {
  await page.goto(detailUrl(quoteId), { waitUntil: "domcontentloaded", timeout: PAGE_WAIT_MS });
  if (/login/i.test(new URL(page.url()).pathname + new URL(page.url()).hash)) throw Object.assign(new Error("FreightPOP asked for a login: sign in again on the FreightPOP login page, then read again"), { fatal: true });
  // The page fills in from FreightPOP's API: wait for this shipment's ids, then for the text to stop growing.
  const ready = await page.waitForFunction(
    (q) => new RegExp(`QuoteID:\\s*${q}\\b`).test(document.body ? document.body.innerText : ""),
    { timeout: PAGE_WAIT_MS, polling: 500 }, quoteId,
  ).then(() => true, () => false);
  if (!ready) throw new Error(`FreightPOP's Shipment Details page did not show quote ${quoteId} within ${PAGE_WAIT_MS / 1000}s`);
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
    const leaf = [...document.querySelectorAll("a, button, span, label")]
      .filter((el) => el.getClientRects().length && /^details$/i.test((el.innerText || el.textContent || "").trim()))
      .find((el) => /Quote\s*:/i.test((el.parentElement?.innerText || "") + (el.parentElement?.parentElement?.innerText || "")));
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
    const shown = await page.waitForFunction(() => /QUOTE DETAIL/i.test(document.body.innerText), { timeout: 15_000, polling: 300 }).then(() => true, () => false);
    if (shown) {
      await sleep(800);
      quoteText = await page.evaluate(() => {
        const clean = (t) => String(t || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
        const boxes = [...document.querySelectorAll(".modal, .k-window, [role='dialog'], .modal-content, div")]
          .filter((el) => el.getClientRects().length && /^\s*QUOTE DETAIL/i.test(el.innerText || ""));
        // The smallest element that starts with the heading is the panel itself.
        boxes.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
        return boxes.length ? clean(boxes[0].innerText).slice(0, 20000) : "";
      });
    }
    if (!quoteText) log(`Quote Detail did not open for shipment ${shipmentId}: stored without the breakdown`, "warn");
  } else {
    log(`No DETAILS link beside the quote for shipment ${shipmentId}: stored without the breakdown`, "warn");
  }
  return { shipment_id: String(shipmentId), quote_id: String(quoteId), text: main.text, inputs: main.inputs, quote_text: quoteText, url: main.url };
}

async function run(request) {
  const startedAt = Date.now();
  const who = String(request.requested_by || "");
  const lines = [];
  const log = (text, level = "info") => { lines.push({ t: new Date().toISOString(), level, text: String(text) }); console.log(`[details] ${level} ${text}`); };
  log.requestId = request.id;
  log.who = who;
  const quotes = quotesFromNote(request.note);
  const ids = (Array.isArray(request.tracking_numbers) ? request.tracking_numbers : []).map(String).filter((id) => quotes.has(id)).slice(0, MAX_SHIPMENTS);
  let ok = false, note = "", stored = 0, failed = 0;
  let lease = null, page = null;
  try {
    if (!who.includes("@")) throw new Error(`The request has no person to run as (requested_by="${who}")`);
    if (!ids.length) throw new Error("The request names no shipment with a FreightPOP quote id");
    if (!hasProfile(who)) await saveCookiesNow(who);
    if (!hasProfile(who)) throw new Error(`${who} hasn't logged in to FreightPOP in the hosted view yet`);
    log(`Claimed shipment details · ${ids.length} shipment(s) — running as ${who} in a separate browser · read only`);

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

    for (const id of ids) {
      try {
        const record = await readOne(page, id, quotes.get(id), log);
        const out = await api("/api/shipment-details", { method: "POST", signal: AbortSignal.timeout(30_000), body: JSON.stringify({ by: who, records: [record] }) });
        if (out?.stored) { stored++; log(`Shipment ${id} · stored · ${out.summary?.[0] || `${record.text.length} characters`}`, "done"); }
        else { failed++; log(`Shipment ${id} · read, but not stored (${String(out?.error || "the API refused it").slice(0, 160)})`, "error"); }
      } catch (e) {
        failed++;
        log(`Shipment ${id} · ${String(e.message || e).slice(0, 300)}`, "error");
        if (e.fatal) throw e;
      }
    }
    ok = stored > 0;
    note = `${stored} of ${ids.length} shipment(s) read from FreightPOP${failed ? ` · ${failed} failed` : ""}`;
    if (!ok) note = lines.filter((l) => l.level === "error").pop()?.text || note;
  } catch (e) {
    note = String(e.message || e).slice(0, 400);
    log(`Failed: ${note}`, "error");
  } finally {
    if (page) await page.close().catch(() => {});
    if (lease) lease.release();
    await closeUserBrowser(who, VARIANT).catch(() => {});
  }
  log(`Finished: ${note}`, ok ? "done" : "error");
  await api(`/api/ops/rescrape/${request.id}/complete`, { method: "POST", body: JSON.stringify({ result_count: stored, note, ...(ok ? {} : { error: true }) }) })
    .catch((e) => console.warn("[details] could not complete the request:", e.message));
  try {
    recordRun({
      id: request.id, source: "manual", user: who, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt, ok, note, counts: { scraped: stored, saved: stored, uploadErrors: failed, total: ids.length },
    }, lines);
  } catch (e) { console.warn("[details] run not recorded:", e.message); }
  last = { requestId: request.id, ok, note, finishedAt: new Date().toISOString() };
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
