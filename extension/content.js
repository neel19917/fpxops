let stopRequested = false;
let logRows = [];

// Tracks the active MutationObserver so it can be disconnected before re-registering
// on the next "View Shipment" click (one observer per shipment interaction).
let activeDetailObserver = null;

// Debug flag — flip to true while debugging to restore the verbose
// console.log stream that used to fire on every scraped row, modal,
// and Kendo inject. In production we run quiet so reps' DevTools
// aren't drowned in [FPX] / [FPX-GP] / [FPX-INV] traffic during
// 5-minute scrapes. Errors (console.warn) still surface unconditionally.
const FPX_DEBUG = false;
function dlog(...args) {
  if (FPX_DEBUG) console.log(...args);
}

function sendStatus(text) {
  dlog("[FPX]", text);
  try { chrome.runtime.sendMessage({ type: "status", text }); } catch {}
}

function sendComplete(text) {
  dlog("[FPX] COMPLETE:", text);
  try { chrome.runtime.sendMessage({ type: "complete", text }); } catch {}
}

// ---------------------------------------------------------------------
// Background-safe clock.
//
// Chrome throttles a hidden tab's timers to 1/s, and to 1/min once the tab
// has been hidden for five minutes. Every wait in this script used to ride
// on those timers, so a scrape that did a row every 3s in the foreground
// took minutes per row the moment the operator switched tabs. The
// extension's service worker is NOT throttled by tab visibility, so while
// the tab is hidden we ask it to time our waits for us. If the worker is
// unreachable the local timer still fires — slower, but never stuck.
// ---------------------------------------------------------------------
let _bgClockOk = true;
function sleep(ms) {
  if (ms >= 50 && typeof document !== "undefined" && document.hidden && _bgClockOk) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        chrome.runtime.sendMessage({ type: "bgSleep", ms }, () => {
          // lastError (worker asleep / context gone) → just resolve; the
          // local fallback below guarantees progress either way.
          if (chrome.runtime.lastError) _bgClockOk = false;
          finish();
        });
      } catch { _bgClockOk = false; }
      // Fallback: local timer. Throttled when hidden, but it fires.
      setTimeout(finish, ms);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// Pause (hosted browser only). The browser service sets self.__fpxPaused in
// this content-script world when someone presses Pause on the Scraping page,
// and clears it on Resume. Nothing sets it in a rep's own Chrome, so there
// the gate is a no-op. A stop always gets through a pause.
// ---------------------------------------------------------------------
function fpxIsPaused() {
  try { return self.__fpxPaused === true; } catch { return false; }
}

async function fpxPauseGate() {
  while (fpxIsPaused() && !stopRequested) await sleep(500);
}

// Random delay between min and max ms — prevents robotic timing patterns.
// Holds while paused (before and after the wait), so every flow built on it
// stops at its next step.
async function humanDelay(minMs, maxMs) {
  if (fpxIsPaused()) await fpxPauseGate();
  const jitter = minMs + Math.random() * (maxMs - minMs);
  await sleep(Math.round(jitter));
  if (fpxIsPaused()) await fpxPauseGate();
}

// Yield to the browser so it can paint/reflow — prevents "page unresponsive"
function yieldToBrowser() {
  // setTimeout(0) is clamped to ≥1s in a hidden tab; go through the
  // background clock there instead.
  if (typeof document !== "undefined" && document.hidden) return sleep(60);
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Micro-pause: short randomized breath (50–200ms) to keep the main thread alive
function microPause() {
  return humanDelay(50, 200);
}

function isVisibleForClick(el) {
  if (!el) return false;
  const r = el.getClientRects();
  if (!r || r.length === 0) return false;
  const st = window.getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden") return false;
  return true;
}

// First visible control that can dismiss the shipment modal / Kendo window.
function findModalDismissControl() {
  const candidates = document.querySelectorAll(
    "button, a[role='button'], [role='button'], a.k-window-action"
  );
  for (const el of candidates) {
    if (!isVisibleForClick(el)) continue;
    const txt = el.innerText.replace(/\s+/g, " ").trim();
    if (/^close$/i.test(txt) || /^done$/i.test(txt)) return el;
    const al = (el.getAttribute("aria-label") || "").trim();
    if (/^(close|dismiss)$/i.test(al)) return el;
  }
  for (const sel of [
    ".k-window-action[aria-label='Close']",
    "a.k-window-action.k-window-action-close",
    ".k-window [class*='k-window-action'] .k-i-close",
  ]) {
    const inner = document.querySelector(sel);
    if (!inner || !isVisibleForClick(inner)) continue;
    return inner.closest("a, button") || inner;
  }
  return null;
}

// Poll for a dismiss control (CLOSE button, Kendo X, aria-label Close) up to `timeout` ms.
// Wall-clock deadline + background-safe sleep, so a hidden tab neither
// inflates the wait nor stalls it.
async function waitForCloseButton(timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const btn = findModalDismissControl();
    if (btn) return btn;
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

// Poll for an element matching `selector` to appear in the DOM (visible).
async function waitForElement(selector, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const el = document.querySelector(selector);
    if (el && el.offsetParent !== null) return el;
    if (Date.now() >= deadline) return null;
    await sleep(300);
  }
}

// MutationObserver-based wait for the shipment detail view (#ShipmentSale) to
// populate. Replaces the old sleep(2000) + 1s-polling loop, cutting detail-load
// wait from ~5-36s to <3s by reacting to actual DOM mutations instead of sleeping.
function waitForDetailWithObserver(timeout = 15000) {
  return new Promise((resolve) => {
    // Disconnect any leftover observer from a previous shipment interaction.
    if (activeDetailObserver) {
      activeDetailObserver.disconnect();
      activeDetailObserver = null;
    }

    // Fast path: element already exists and has content (0ms).
    const existing = document.getElementById("ShipmentSale");
    if (existing && existing.textContent.trim()) {
      resolve(existing);
      return;
    }

    let tabClicked = false;
    let settled = false;

    function tryResolve() {
      if (settled) return;
      const el = document.getElementById("ShipmentSale");
      if (el && el.textContent.trim()) {
        settled = true;
        if (activeDetailObserver) { activeDetailObserver.disconnect(); activeDetailObserver = null; }
        clearTimeout(timer);
        resolve(el);
        return;
      }

      // If #bdetails exists but is hidden, click its tab once to reveal it.
      if (!tabClicked) {
        const bd = document.getElementById("bdetails");
        if (bd && (bd.style.display === "none" || !bd.offsetParent)) {
          const tabs = document.querySelectorAll(
            "a[data-toggle='tab'], a[href='#bdetails'], li a, .nav-tabs a, .k-tabstrip-items a"
          );
          for (const tab of tabs) {
            const txt = (tab.textContent || "").trim();
            const href = tab.getAttribute("href") || "";
            if (href === "#bdetails" || /broker\s*details/i.test(txt) || /detail/i.test(txt)) {
              tabClicked = true;
              tab.click();
              break;
            }
          }
        }
      }
    }

    // Narrow the observer scope: prefer the detail container's parent over body.
    const scope =
      document.getElementById("bdetails")?.parentElement ||
      document.getElementById("details")?.parentElement ||
      document.querySelector(".tab-content, .k-tabstrip-wrapper, [ui-view], [ng-view]") ||
      document.body;

    const observer = new MutationObserver(() => tryResolve());
    activeDetailObserver = observer;
    observer.observe(scope, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    // Timeout fallback so we never hang indefinitely.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      activeDetailObserver = null;
      resolve(null);
    }, timeout);

    // Run one immediate check in case the mutation already happened before observe().
    tryResolve();
  });
}

// MutationObserver-based wait for the Kendo grid to reappear after navigating
// back from the detail view. Replaces hardcoded sleep(2000-3000) calls.
function waitForGridWithObserver(timeout = 8000) {
  return new Promise((resolve) => {
    function checkGrid() {
      const row = document.querySelector(".k-grid-content tbody tr, .k-grid tbody tr");
      if (row && !row.classList.contains("k-no-data")) return row;
      return null;
    }

    // Fast path.
    const existing = checkGrid();
    if (existing) { resolve(existing); return; }

    let settled = false;

    const scope =
      document.querySelector(".k-grid-content, .k-grid") ||
      document.body;

    const observer = new MutationObserver(() => {
      if (settled) return;
      const row = checkGrid();
      if (row) {
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(row);
      }
    });

    observer.observe(scope, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

// Apply a column filter via the Kendo header filter popup.
// `colName` is the header text (e.g. "Mode"), `value` is the filter
// value (e.g. "LTL"). If either is empty, filtering is skipped.
async function applyFilter(colName, value) {
  if (!colName || !value) {
    sendStatus("No filter configured — skipping.");
    return;
  }

  // Find the header column. Strategies in order:
  //   1. data-field exact match (e.g. "TrackingNumber") — survives renames
  //   2. header text starts-with (legacy behavior)
  //   3. case-insensitive header substring (catches "Tracking #" / "Tracking No")
  const headerCells = document.querySelectorAll(".k-grid th");
  const fieldGuess = colName.replace(/\s+/g, ""); // "Tracking Number" → "TrackingNumber"
  let targetHeader = null;

  // 1. data-field
  for (const cell of headerCells) {
    const f = cell.getAttribute("data-field") || cell.getAttribute("data-title");
    if (!f) continue;
    if (f.toLowerCase() === fieldGuess.toLowerCase() || f.toLowerCase() === colName.toLowerCase()) {
      targetHeader = cell; break;
    }
  }
  // 2. starts-with
  if (!targetHeader) {
    for (const cell of headerCells) {
      const link = cell.querySelector("a.k-link");
      const text = (link ? link.textContent : cell.textContent || "").trim();
      if (text.startsWith(colName)) { targetHeader = cell; break; }
    }
  }
  // 3. fuzzy contains
  if (!targetHeader) {
    const wantLower = colName.toLowerCase();
    for (const cell of headerCells) {
      const link = cell.querySelector("a.k-link");
      const text = (link ? link.textContent : cell.textContent || "").trim().toLowerCase();
      // Match "Tracking" against "Tracking Number" etc., but skip
      // false-positive "Tracking Comments" when looking for "Tracking Number".
      if (text === wantLower) { targetHeader = cell; break; }
      if (text.includes(wantLower) && !text.includes("comment")) { targetHeader = cell; break; }
    }
  }

  if (!targetHeader) {
    // Surface the header list once so the bridge ack carries something
    // actionable — far more useful than "not found".
    const seen = Array.from(headerCells).map((c) => {
      const f = c.getAttribute("data-field") || "";
      const t = (c.querySelector("a.k-link")?.textContent || c.textContent || "").trim();
      return f ? `${t} (${f})` : t;
    }).filter(Boolean);
    const msg = `"${colName}" column not found in this view. Visible headers: ${seen.join(", ") || "(none)"}.`;
    sendStatus(msg);
    throw new Error(msg);
  }

  const filterIcon =
    targetHeader.querySelector("a.k-grid-filter") ||
    targetHeader.querySelector("a.k-grid-filter-menu") ||
    targetHeader.querySelector(".k-grid-filter") ||
    targetHeader.querySelector("[data-role='columnmenu']");

  if (!filterIcon) {
    sendStatus(`"${colName}" filter icon not found — skipping filter.`);
    return;
  }

  filterIcon.click();
  await humanDelay(600, 1000);

  let filterPopup = null;
  const containers = document.querySelectorAll(
    ".k-animation-container, .k-filter-menu, .k-column-menu"
  );
  for (const c of containers) {
    if (c.offsetParent !== null || c.style.display !== "none") {
      const hasFilterBtn = Array.from(c.querySelectorAll("button")).some(
        (b) => b.textContent.trim() === "Filter"
      );
      if (hasFilterBtn) {
        filterPopup = c;
        break;
      }
    }
  }

  if (!filterPopup) {
    sendStatus("Filter popup did not open — skipping filter.");
    return;
  }

  const selects = filterPopup.querySelectorAll("select");
  const kendoDropdowns = filterPopup.querySelectorAll(
    "span.k-dropdown, span.k-widget.k-dropdown, [data-role='dropdownlist']"
  );

  if (selects.length >= 1) {
    const opSelect = selects[0];
    if (opSelect.value !== "eq") {
      opSelect.value = "eq";
      opSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await humanDelay(200, 500);
    }
  } else if (kendoDropdowns.length >= 1) {
    const opDd = kendoDropdowns[0];
    if (!opDd.textContent.includes("Is equal to")) {
      (opDd.querySelector(".k-dropdown-wrap, .k-input") || opDd).click();
      await humanDelay(400, 700);
      for (const item of document.querySelectorAll(
        ".k-animation-container .k-list .k-item, .k-popup .k-item"
      )) {
        if (item.textContent.trim() === "Is equal to") {
          item.click();
          break;
        }
      }
      await humanDelay(300, 600);
    }
  }

  let valueSet = false;

  if (selects.length >= 2) {
    const valSelect = selects[1];
    valSelect.value = value;
    valSelect.dispatchEvent(new Event("change", { bubbles: true }));
    valueSet = true;
    await humanDelay(200, 500);
  }

  if (!valueSet && kendoDropdowns.length >= 2) {
    const valDd = kendoDropdowns[1];
    (valDd.querySelector(".k-dropdown-wrap, .k-input") || valDd).click();
    await humanDelay(400, 800);
    for (const item of document.querySelectorAll(
      ".k-animation-container .k-list .k-item, " +
      ".k-list-container .k-item, " +
      ".k-popup .k-item"
    )) {
      if (item.textContent.trim() === value) {
        item.click();
        valueSet = true;
        break;
      }
    }
    await humanDelay(300, 600);
  }

  if (!valueSet) {
    const textInput = filterPopup.querySelector(
      'input[type="text"], input.k-textbox, input.k-input, input:not([type="hidden"]):not([type="checkbox"])'
    );
    if (textInput) {
      textInput.focus();
      // Use the native value setter — a plain `input.value = "..."`
      // updates the DOM but doesn't notify Kendo / React so the Filter
      // button stays disabled and the entered value reverts on focus
      // change. This was the cause of "filter popup opens but value
      // never sticks" on the Tracking Number column.
      try { fpxSetReactInputValue(textInput, value); }
      catch {
        textInput.value = value;
        textInput.dispatchEvent(new Event("input", { bubbles: true }));
        textInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Some Kendo inputs validate on blur — fire a synthetic blur after
      // setting so the framework commits the value.
      textInput.dispatchEvent(new Event("blur", { bubbles: true }));
      valueSet = true;
      await humanDelay(200, 500);
    }
  }

  if (!valueSet) {
    sendStatus(`Could not set "${value}" in filter — skipping.`);
    return;
  }

  await microPause();
  for (const btn of filterPopup.querySelectorAll("button")) {
    if (btn.textContent.trim() === "Filter") {
      btn.click();
      break;
    }
  }

  sendStatus(`Filtered ${colName} to "${value}".`);
  await humanDelay(1500, 2500);
}

// READ-ONLY CLICK: dispatch a mouse-click sequence on the element without
// scrolling the page. This extension NEVER types into fields, NEVER
// dispatches input/change events on data cells, and NEVER modifies grid
// data. The only writes are: (a) filter dropdown selection during the
// filter step, (b) clicking <a> links to open modals, (c) clicking the
// CLOSE button. All three are safe read-only operations.
function simulateClick(el) {
  const rect = el.getBoundingClientRect();
  const jitterX = (Math.random() - 0.5) * Math.min(rect.width * 0.3, 6);
  const jitterY = (Math.random() - 0.5) * Math.min(rect.height * 0.3, 4);
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 1,
    clientX: rect.left + rect.width / 2 + jitterX,
    clientY: rect.top + rect.height / 2 + jitterY,
  };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

// Scrape all visible label/value pairs from the currently open modal.
// Returns an object like { "TRACKING NUMBER": "401770491", "CARRIER": "...", ... }
function scrapeModal() {
  const data = {};

  // Strategy 1: look for label/value pairs in common modal patterns.
  // Many modals use <label> or <strong> or <b> for field names, with the
  // value in an adjacent sibling, parent's next child, or same container.
  const modal =
    document.querySelector(".modal.in, .modal.show, .k-window, [role='dialog']") ||
    document.body;

  // Pattern A: <label>FIELD</label> next to <span>/<div>/<input> with value.
  // We deliberately do NOT fall back to `parent.textContent` if the sibling is
  // empty — for nested modal layouts that grabs the entire surrounding text
  // (full event-history blob, ship-from + ship-to + comments mashed together)
  // and stamps it onto whatever label was nearest. Better to leave the field
  // empty than to corrupt it.
  const MAX_VALUE_LEN = 300;
  // "Details" is the carrier's full event history (status / comment /
  // timestamp / city per event). The server parses it to find when the
  // freight reached the destination terminal (storage-charge risk, see
  // server/lib/storageRisk.js), and for a shipment that has been sitting
  // for days that event is well past the first 300 chars — at 300 we were
  // keeping only the 2-3 newest events. Give it its own, much larger cap.
  const LONG_VALUE_KEYS = new Set(["Details"]);
  const MAX_LONG_VALUE_LEN = 8000;
  const capFor = (key) => (LONG_VALUE_KEYS.has(key) ? MAX_LONG_VALUE_LEN : MAX_VALUE_LEN);
  // `data[key]` truthiness is the wrong "already set" test: a label that
  // happens to read "constructor" or "toString" collides with Object
  // prototype members. Use an own-property check instead.
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(data, k);
  const isSafeKey = (k) => k !== "__proto__" && k !== "constructor" && k !== "prototype";
  const labels = modal.querySelectorAll("label, strong, b, .field-label, .control-label, dt");
  for (const lbl of labels) {
    // One odd node (detached mid-iteration, exotic element without
    // textContent, a getter that throws) must not abort the whole modal.
    try {
      const key = String(lbl.textContent || "").replace(/\s+/g, " ").trim().replace(/:$/, "");
      if (!key || key.length > 80) continue;
      if (key === "CLOSE") continue;
      if (!isSafeKey(key)) continue;
      if (hasKey(key)) continue;                             // first-write-wins; don't overwrite
      const maxLen = capFor(key);

      let val = "";
      const next = lbl.nextElementSibling;
      if (next) {
        const nv = next.value;
        val = String((typeof nv === "string" && nv) || next.textContent || "").trim();
      }
      // Sibling-of-parent: <div><label/></div><div>VALUE</div>
      if (!val && lbl.parentElement && lbl.parentElement.nextElementSibling) {
        const sib = lbl.parentElement.nextElementSibling;
        const sibText = String(sib.textContent || "").trim();
        if (sibText && sibText.length < maxLen) val = sibText;
      }

      if (!val) continue;
      val = val.replace(/\s+/g, " ").trim();
      if (val.length > maxLen) val = val.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
      data[key] = val;
    } catch (e) {
      console.warn("[FPX] scrapeModal: skipped a label node:", e?.message || e);
    }
  }

  // Pattern B: table rows with th/td pairs inside the modal
  const rows = modal.querySelectorAll("table tr");
  for (const row of rows) {
    try {
      const th = row.querySelector("th, td:first-child");
      const td = row.querySelector("td:last-child");
      if (th && td && th !== td) {
        const key = String(th.textContent || "").replace(/\s+/g, " ").trim().replace(/:$/, "");
        let val = String(td.textContent || "").replace(/\s+/g, " ").trim();
        if (key && key !== "CLOSE" && isSafeKey(key) && val) {
          const maxLen = capFor(key);
          if (val.length > maxLen) val = val.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
          data[key] = val;
        }
      }
    } catch (e) {
      console.warn("[FPX] scrapeModal: skipped a table row:", e?.message || e);
    }
  }

  const dialogRoot = document.querySelector(
    ".modal.in, .modal.show, .k-window, [role='dialog']"
  );
  if (dialogRoot) {
    try {
      const raw = String(dialogRoot.innerText || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t\f\v]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (raw) {
        data["FULL MODAL TEXT"] = raw;
      }
    } catch {}
  }

  dlog("[FPX] Scraped modal data keys:", Object.keys(data).length);
  return data;
}

function getLockedColumnCount() {
  const lockedHeaders = document.querySelectorAll(
    ".k-grid-header-locked th, .k-grid-header-locked td"
  );
  return lockedHeaders.length;
}

function readGridCellText(row, dataIndex, lockedCount) {
  if (dataIndex < 0) return "";
  const cells = row.querySelectorAll("td");
  const scrollIndex = dataIndex - lockedCount;
  let cell = null;
  if (scrollIndex >= 0 && scrollIndex < cells.length) {
    cell = cells[scrollIndex];
  }
  if (
    (!cell || !String(cell.textContent || "").trim()) &&
    dataIndex >= 0 &&
    dataIndex < cells.length
  ) {
    cell = cells[dataIndex];
  }
  if (!cell) return "";
  return String(cell.textContent || "").replace(/\s+/g, " ").trim();
}

function findColumnDataIndexByField(candidates) {
  for (const f of candidates) {
    const th = document.querySelector(`th[data-field="${f}"]`);
    if (th) {
      const idx = parseInt(th.getAttribute("data-index"), 10);
      if (!Number.isNaN(idx)) return idx;
    }
  }
  return -1;
}

function findPickupResponseDataIndex() {
  const byField = findColumnDataIndexByField([
    "PickupResponse",
    "pickupResponse",
    "PickupRequestResponse",
    "PickupReqResponse",
    "ShipperPickupResponse",
    "ShipPickupResponse",
    "PickupResponseText",
  ]);
  if (byField >= 0) return byField;

  const allTh = document.querySelectorAll(
    ".k-grid-header-wrap th[data-index], .k-grid-header th[data-index], .k-grid th[data-index]"
  );
  for (const th of allTh) {
    const link = th.querySelector("a.k-link");
    const text = (link ? link.textContent : th.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (/pickup\s*response/i.test(text)) {
      const idx = parseInt(th.getAttribute("data-index"), 10);
      if (!Number.isNaN(idx)) return idx;
    }
  }
  return -1;
}

// Grid "Pickup Response" cell (e.g. "Pickup Request number is …") merged into row export.
function applyGridPickupResponse(modalData, raw) {
  const full = String(raw || "").replace(/\s+/g, " ").trim();
  modalData["PICKUP RESPONSE"] = full;
  const pr = full.match(/Pickup Request number is\s*(\S+)/i);
  if (pr) modalData["PICKUP REQUEST NUMBER"] = pr[1].trim();
  const cn = full.match(/Confirmation Number\s*=\s*(\S+)/i);
  if (cn) modalData["CONFIRMATION NUMBER"] = cn[1].trim();
}

// ---------------------------------------------------------------------
// Bad-row hardening helpers
// ---------------------------------------------------------------------

// Grid cells that render a placeholder instead of a tracking number. Clicking
// these opens nothing, so the old loop burned a 25s modal timeout on each.
const TRACKING_PLACEHOLDERS = new Set(["", "-", "—", "–", "n/a", "na", "none", "null", "pending", "tbd", "undefined"]);
function isPlaceholderTracking(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  return TRACKING_PLACEHOLDERS.has(t);
}

// Coerce a scraped row into something structured-cloneable + JSON-safe:
// primitives only, no functions / DOM nodes / undefined, prototype-key names
// dropped, oversized strings capped. Anything that slips past here would
// throw inside chrome.runtime.sendMessage and take the whole page flush
// with it.
const ROW_VALUE_CAP = 20000;
function sanitizeRow(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const k of Object.keys(row)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    let v;
    try { v = row[k]; } catch { continue; }
    if (v === undefined || v === null || v === "") continue;
    const t = typeof v;
    if (t === "string") {
      out[k] = v.length > ROW_VALUE_CAP ? v.slice(0, ROW_VALUE_CAP) + "…" : v;
    } else if (t === "number" || t === "boolean") {
      if (t === "number" && !Number.isFinite(v)) continue;
      out[k] = v;
    } else if (t === "bigint") {
      out[k] = String(v);
    } else if (v instanceof Date) {
      if (!isNaN(v.getTime())) out[k] = v.toISOString();
    } else if (t === "object") {
      if (typeof Node !== "undefined" && v instanceof Node) continue;
      try {
        const j = JSON.stringify(v);
        if (j && j !== "{}" && j !== "[]") out[k] = j.length > ROW_VALUE_CAP ? j.slice(0, ROW_VALUE_CAP) + "…" : j;
      } catch { /* circular / unserializable — drop */ }
    }
    // functions, symbols: dropped
  }
  return Object.keys(out).length ? out : null;
}

// Collapse duplicate tracking numbers in a batch (last sighting wins) so the
// server's upsert never touches one conflict key twice, and sanitize every
// row on the way through. Rows without a usable tracking number are
// dropped and counted — they can't be keyed server-side anyway.
function prepareRowsForUpload(rows) {
  const byTracking = new Map();
  let dropped = 0;
  for (const raw of rows || []) {
    const row = sanitizeRow(raw);
    const tn = row && String(row._trackingNumber || "").replace(/\s+/g, " ").trim();
    if (!row || !tn || isPlaceholderTracking(tn)) { dropped++; continue; }
    row._trackingNumber = tn;
    byTracking.delete(tn);
    byTracking.set(tn, row);
  }
  return { rows: Array.from(byTracking.values()), dropped };
}

// A job's link element can be detached between collection and click — Kendo
// re-renders body rows after some modal closes, and a scroll/virtualize can
// swap them. Re-find the cell by tracking text in the live grid rather than
// clicking a ghost node and waiting 25s for a modal that never comes.
function resolveJobLink(job) {
  const link = job && job.link;
  if (link && link.isConnected) return link;
  const wanted = String(job && job.trackingNum || "").trim();
  if (!wanted) return null;
  const rows = document.querySelectorAll(".k-grid-content tbody tr, .k-grid-content-locked tbody tr, .k-grid tbody tr");
  for (const row of rows) {
    if (row.classList.contains("k-grouping-row") || row.classList.contains("k-no-data")) continue;
    const candidates = row.querySelectorAll("a, [ng-click], [onclick], span.k-link, span[style*='cursor']");
    for (const el of candidates) {
      if (String(el.textContent || "").trim() === wanted) return el;
    }
  }
  return null;
}

const DIALOG_ROOT_SELECTOR = ".modal.in, .modal.show, .k-window, [role='dialog']";

// The dialog element that owns a dismiss control (CLOSE button / Kendo X).
function dialogRootFor(el) {
  try { return (el && el.closest(".modal, .k-window, [role='dialog']")) || null; } catch { return null; }
}

// Dismiss control INSIDE a given dialog root only — never a "Close" button
// elsewhere on the page.
function findDismissControlWithin(root) {
  if (!root) return null;
  try {
    for (const el of root.querySelectorAll("button, a[role='button'], [role='button'], a.k-window-action")) {
      if (!isVisibleForClick(el)) continue;
      const txt = String(el.innerText || "").replace(/\s+/g, " ").trim();
      if (/^close$/i.test(txt) || /^done$/i.test(txt)) return el;
      const al = (el.getAttribute("aria-label") || "").trim();
      if (/^(close|dismiss)$/i.test(al)) return el;
      if (el.classList.contains("k-window-action") && el.querySelector(".k-i-close")) return el;
    }
  } catch {}
  return null;
}

// Is a shipment modal currently open?
//   - with `root`: is THAT dialog still attached and visible (the one we
//     just scraped) — no guessing about unrelated dialogs.
//   - without: is there a visible dialog that has its own dismiss control
//     inside it. A persistent role=dialog widget with no Close of its own
//     does not count, and neither does a Close button outside any dialog.
// Getting this wrong is expensive: a false "open" adds seconds of waiting
// plus an Escape/dismiss escalation to EVERY row on the page.
function isModalOpen(root) {
  try {
    if (root) return !!(root.isConnected && isVisibleForClick(root));
    for (const d of document.querySelectorAll(DIALOG_ROOT_SELECTOR)) {
      if (isVisibleForClick(d) && findDismissControlWithin(d)) return true;
    }
    return false;
  } catch { return false; }
}

// After clicking CLOSE, wait for the dialog to actually go away. If it
// lingers (animation stuck, second dialog, click swallowed), escalate:
// Escape key, then the dialog's own dismiss control again. A modal left
// open makes every subsequent row's click land on the overlay, so one bad
// row used to turn into a 25s timeout for each remaining row on the page.
// Returns quickly in the normal case — polls every 100ms and exits on the
// first "closed" reading.
async function ensureModalClosed(timeoutMs = 2500, root = null) {
  const start = Date.now();
  let escalated = 0;
  while (Date.now() - start < timeoutMs) {
    if (!isModalOpen(root)) return true;
    await sleep(100);
    const elapsed = Date.now() - start;
    if (escalated === 0 && elapsed > 800) {
      escalated = 1;
      try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })); } catch {}
    } else if (escalated === 1 && elapsed > 1600) {
      escalated = 2;
      const btn = root ? findDismissControlWithin(root) : null;
      if (btn) { try { simulateClick(btn); } catch {} }
    }
  }
  return !isModalOpen(root);
}

// The scrape keeps running while the tab is hidden (waits ride the
// background clock, see sleep()). FreightPOP's own page timers are still
// throttled by Chrome, so rows are a bit slower in the background — tell the
// operator once per hidden stretch so a slower pace isn't mistaken for a
// stall. Returns true when the tab is hidden.
let _wasHidden = false;
function noteBackgroundState(trackingNum) {
  const hidden = typeof document.hidden === "boolean" && document.hidden;
  if (hidden && !_wasHidden) {
    sendStatus(`Running in the background (tab hidden) — a little slower per row, keeps going${trackingNum ? ` (next: ${trackingNum})` : ""}.`);
  } else if (!hidden && _wasHidden) {
    sendStatus("Tab visible again — back to full speed.");
  }
  _wasHidden = hidden;
  return hidden;
}

// Circuit breaker for the "every modal times out" cascade. Seen 2026-09-23:
// FreightPOP stopped opening tracking modals mid-run (page state broke) and
// the loop burned 25s per row recording partials for the rest of the grid.
// After this many consecutive timeouts the run stops with a message telling
// the operator to refresh FreightPOP and restart.
const MAX_CONSECUTIVE_MODAL_TIMEOUTS = 5;
let consecutiveModalTimeouts = 0;
let lastGoodTrackingNum = null;
let abortRunReason = null;

// Which pager page the Kendo grid is on right now ("1" for the first page).
// Returns null when there is no pager (single page) or it can't be read.
function currentGridPage() {
  try {
    const sel = document.querySelector(".k-pager-numbers .k-state-selected, .k-pager-numbers .k-selected, .k-pager-numbers [aria-current='page']");
    const t = sel ? String(sel.textContent || "").trim() : "";
    return /^\d+$/.test(t) ? parseInt(t, 10) : null;
  } catch { return null; }
}

// Build the row we upload when a shipment could not be fully scraped. It
// carries the grid columns (Kendo merge + Pickup Response) plus `_error`, so
// the server updates only what we actually observed instead of nulling the
// modal-only fields it already holds.
function buildPartialRow(trackingNum, errorMsg, pickupResponse, kendoRow) {
  const row = {
    _trackingNumber: trackingNum,
    _timestamp: new Date().toISOString(),
    _error: errorMsg,
    _partial: true,
    _needsActionSheet: false,
  };
  try { applyGridPickupResponse(row, pickupResponse); } catch {}
  try { mergeKendoRow(row, kendoRow); } catch {}
  return row;
}

// Find the Tracking Number column and Pickup Response column, then collect
// { link, pickupResponse } for each body row that has a tracking control.
function collectShipmentJobs() {
  const trackingHeader = document.querySelector(
    'th[data-field="TrackingNumber"], th[data-field="trackingNumber"]'
  );
  const trackingDataIndex = trackingHeader
    ? parseInt(trackingHeader.getAttribute("data-index"), 10)
    : -1;

  const pickupDataIndex = findPickupResponseDataIndex();
  const lockedCount = getLockedColumnCount();
  const trackingScrollIndex =
    trackingDataIndex >= 0 ? trackingDataIndex - lockedCount : -1;

  dlog(
    "[FPX] TrackingNumber data-index:",
    trackingDataIndex,
    "Pickup Response data-index:",
    pickupDataIndex,
    "locked columns:",
    lockedCount,
    "tracking scroll col:",
    trackingScrollIndex
  );

  const bodyRows = document.querySelectorAll(
    ".k-grid-content tbody tr, .k-grid-content-locked tbody tr"
  );
  const allRows =
    bodyRows.length > 0
      ? bodyRows
      : document.querySelectorAll(".k-grid tbody tr");

  dlog("[FPX] Body rows found:", allRows.length);

  const jobs = [];
  let skippedRows = 0;
  const seenOnPage = new Set();

  for (const row of allRows) {
    // A single malformed row (missing cells, exotic node, detached mid-loop)
    // must not abort collection for the rest of the page.
    try {
      if (row.classList.contains("k-grouping-row")) continue;
      if (row.classList.contains("k-no-data")) continue;
      if (row.classList.contains("k-detail-row")) continue;
      const cells = row.querySelectorAll("td");
      if (!cells.length) continue;

      let cell = null;
      if (trackingScrollIndex >= 0 && trackingScrollIndex < cells.length) {
        cell = cells[trackingScrollIndex];
      }
      if (
        (!cell || !String(cell.textContent || "").trim()) &&
        trackingDataIndex >= 0 &&
        trackingDataIndex < cells.length
      ) {
        cell = cells[trackingDataIndex];
      }

      if (!cell) continue;

      const pickupText = readGridCellText(row, pickupDataIndex, lockedCount);

      const clickable =
        cell.querySelector("a") ||
        cell.querySelector("[ng-click]") ||
        cell.querySelector("[onclick]") ||
        cell.querySelector("span[style*='cursor']") ||
        cell.querySelector("span.k-link");

      let link = null;
      if (clickable && String(clickable.textContent || "").trim()) {
        link = clickable;
      } else if (String(cell.textContent || "").trim() && cell.querySelector("*")) {
        const children = cell.querySelectorAll("*");
        for (const child of children) {
          const t = String(child.textContent || "").trim();
          if (t && child.childElementCount === 0 && /\d/.test(t)) {
            link = child;
            break;
          }
        }
      }
      if (!link) continue;

      const trackingNum = String(link.textContent || "").replace(/\s+/g, " ").trim();
      if (isPlaceholderTracking(trackingNum)) { skippedRows++; continue; }
      // Same tracking number twice on one page (multi-leg / duplicate
      // booking): scrape it once. The second modal is identical and the
      // server would reject a batch that upserts the same key twice.
      if (seenOnPage.has(trackingNum)) { skippedRows++; continue; }
      seenOnPage.add(trackingNum);

      jobs.push({ link, trackingNum, pickupResponse: pickupText });
    } catch (e) {
      skippedRows++;
      console.warn("[FPX] collectShipmentJobs: skipped a grid row:", e?.message || e);
    }
  }

  dlog("[FPX] Shipment jobs:", jobs.length, "skipped:", skippedRows);
  sendStatus(
    `Found ${jobs.length} tracking link(s) on this page` +
      (skippedRows ? ` (${skippedRows} row(s) skipped: no usable tracking number)` : "") +
      (pickupDataIndex >= 0
        ? " (Pickup Response column mapped)."
        : " (Pickup Response header not found — column left blank).")
  );
  return jobs;
}

// Check for an enabled next-page button and click it.
function goToNextPage() {
  // Kendo pager uses aria-label or title attributes, or icon classes.
  const nextBtns = document.querySelectorAll(
    '.k-pager-nav[title="Go to the next page"], ' +
    '.k-pager-nav[aria-label="Go to the next page"], ' +
    ".k-pager-wrap .k-i-arrow-e, " +
    ".k-pager-wrap .k-i-arrow-60-right"
  );

  for (const btn of nextBtns) {
    const el = btn.closest("a, button") || btn;
    if (
      !el.classList.contains("k-state-disabled") &&
      !el.disabled &&
      el.getAttribute("aria-disabled") !== "true"
    ) {
      el.click();
      return true;
    }
  }
  return false;
}

async function waitForGridReady(timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const rows = document.querySelectorAll(".k-grid-content tbody tr, .k-grid tbody tr");
    const loading = document.querySelector(".k-loading-mask, .k-loading-image");
    if (rows.length > 0 && !loading) return;
    if (Date.now() >= deadline) return;
    await sleep(300);
  }
}

async function processPage() {
  let jobs = [];
  try {
    jobs = collectShipmentJobs();
  } catch (e) {
    console.warn("[FPX] collectShipmentJobs failed:", e?.message || e);
    sendStatus(`Could not read the grid on this page (${e?.message || e}) — skipping page.`);
    return;
  }
  const total = jobs.length;

  if (total === 0) {
    sendStatus("No tracking links found on this page.");
    return;
  }

  // One kendo prefetch per page-scrape; merged into each row by tracking number.
  // Captures grid-only columns the modal doesn't expose (Order #, References,
  // Company, Shipment Date, Spot Quote, Appointments, etc.).
  const kendoRowMap = await fetchKendoRowMap();

  let failures = 0;
  for (let i = 0; i < total; i++) {
    await fpxPauseGate(); // paused: wait here, between shipments
    if (stopRequested) {
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    const job = jobs[i];
    const trackingNum = job.trackingNum || String(job.link?.textContent || "").trim();
    const pickupResponse = job.pickupResponse;
    const kendoRow = kendoRowMap.get(trackingNum);
    const hiddenAtStart = noteBackgroundState(trackingNum);
    sendStatus(`Processing ${i + 1} of ${total} — ${trackingNum}`);

    // Every step for one shipment is isolated: a throw records a partial row
    // for THIS shipment and the loop moves on. Before this, a single bad row
    // unwound processPage → run, the side panel stayed on "running" forever,
    // and the rest of the page was never scraped or uploaded.
    try {
      // If a stale modal is still up from the previous row, our click would
      // land on its overlay. Clear it first. Scoped to a dialog that has its
      // own dismiss control, so this is a no-op on a clean page.
      const rowStart = Date.now();
      let preCloseMs = 0;
      if (isModalOpen()) { await ensureModalClosed(1500); preCloseMs = Date.now() - rowStart; }

      const link = resolveJobLink(job);
      if (!link) {
        failures++;
        logRows.push(buildPartialRow(trackingNum, "Row disappeared from grid before click", pickupResponse, kendoRow));
        sendStatus(`Row ${trackingNum} left the grid — recorded grid data only, skipping modal.`);
        continue;
      }

      simulateClick(link);
      await humanDelay(300, 600);

      sendStatus(`Clicked ${trackingNum} — waiting for modal...`);
      const waitStart = Date.now();
      const closeBtn = await waitForCloseButton(25000);
      const modalWaitMs = Date.now() - waitStart;
      if (!closeBtn) {
        failures++;
        consecutiveModalTimeouts++;
        logRows.push(buildPartialRow(trackingNum, "Modal did not appear (timeout)", pickupResponse, kendoRow));
        sendStatus(`Timeout on ${trackingNum} — no modal appeared, recorded grid data only.`);
        if (consecutiveModalTimeouts >= MAX_CONSECUTIVE_MODAL_TIMEOUTS) {
          abortRunReason = `FreightPOP stopped opening tracking modals — ${consecutiveModalTimeouts} rows in a row timed out` +
            (lastGoodTrackingNum ? ` (last good: ${lastGoodTrackingNum})` : "") +
            `. Refresh the FreightPOP page and click Scrape & upload again.`;
          return;
        }
        continue;
      }
      consecutiveModalTimeouts = 0;
      lastGoodTrackingNum = trackingNum;

      await humanDelay(350, 700);
      sendStatus(`Scraping modal data for ${trackingNum}...`);
      let modalData;
      try {
        modalData = scrapeModal();
      } catch (e) {
        // Scrape blew up on this modal's DOM — keep what the grid knows.
        console.warn(`[FPX] scrapeModal failed for ${trackingNum}:`, e?.message || e);
        modalData = { _error: `Modal scrape failed: ${e?.message || e}`, _partial: true };
        failures++;
      }
      modalData._trackingNumber = trackingNum;
      modalData._timestamp = new Date().toISOString();
      try { applyGridPickupResponse(modalData, pickupResponse); } catch {}
      try { mergeKendoRow(modalData, kendoRow); } catch {}

      // Extension is scrape-only — analysis runs server-side after upload.
      delete modalData["FULL MODAL TEXT"];
      // Per-row timing lands in raw_data so a slow run can be diagnosed
      // from the database: was it the carrier modal, or our own waits?
      modalData._modalWaitMs = modalWaitMs;
      if (preCloseMs) modalData._preCloseMs = preCloseMs;
      if (hiddenAtStart) modalData._scrapedHidden = true;
      const dialogRoot = dialogRootFor(closeBtn);
      logRows.push(modalData);
      // Legacy 25-row chrome.storage._fpxCheckpoint write was retired —
      // the persistent upload queue (background.js / chrome.storage
      // pendingUploads) covers crash recovery, and serializing
      // logRows every 25 modals was the most expensive bookkeeping
      // step on rep laptops.

      const actionTag = modalData._needsActionSheet ? " [ACTION NEEDED]" : "";
      sendStatus(`Done ${trackingNum}${actionTag} — closing modal...`);
      try { simulateClick(closeBtn); } catch {}
      const closeStart = Date.now();
      const closed = await ensureModalClosed(2500, dialogRoot);
      modalData._closeMs = Date.now() - closeStart;
      modalData._rowMs = Date.now() - rowStart;
      if (!closed) console.warn(`[FPX] modal for ${trackingNum} did not close cleanly`);
      await humanDelay(200, 500);
    } catch (e) {
      failures++;
      console.warn(`[FPX] row ${trackingNum} failed:`, e?.message || e);
      logRows.push(buildPartialRow(trackingNum, `Scrape error: ${e?.message || e}`, pickupResponse, kendoRow));
      sendStatus(`Error on ${trackingNum} (${e?.message || e}) — recorded grid data only, continuing.`);
      // Don't leave a half-open dialog for the next row to trip over.
      try { await ensureModalClosed(2000); } catch {}
    }

    await humanDelay(250, 600);
    if (i % 5 === 4) await yieldToBrowser();
  }
  if (failures) sendStatus(`Page done — ${failures} of ${total} row(s) recorded with grid data only.`);
}

async function run(filterCol, filterVal) {
  // Extension is scrape-only as of 2026-04. Analysis happens server-side
  // after upload (POST /api/shipments → background per-row Claude).
  stopRequested = false;
  logRows = [];
  consecutiveModalTimeouts = 0;
  lastGoodTrackingNum = null;
  abortRunReason = null;
  // Tracks every tracking number we see across the entire sweep (not just
  // this page). On a clean unfiltered completion we ship this to the
  // server so it can soft-archive shipments that have left the
  // dashboard — FreightPOP hides delivered shipments, so absence here
  // is the delivery signal. logRows is cleared per-page to bound memory,
  // so we can't reconstruct the full set from it later.
  const sweepTrackingNumbers = new Set();

  sendStatus("Checking server...");
  try {
    const serverCheck = await chrome.runtime.sendMessage({ type: "checkServer" });
    if (serverCheck && serverCheck.online) {
      sendStatus(`Server online (v${serverCheck.version || "?"}) — uploads will be analyzed in the dashboard.`);
    } else {
      sendStatus("Server offline — uploads will fail until it's reachable.");
    }
  } catch {
    sendStatus("Server check failed.");
  }

  if (filterCol && filterVal) {
    sendStatus(`Filtering ${filterCol} to "${filterVal}"...`);
    await applyFilter(filterCol, filterVal);
    await humanDelay(800, 1300);
  } else {
    sendStatus("No filter set — proceeding with current grid view.");
  }

  // Mode filter (LTL / Truckload / Parcel). Only the modes that were actually
  // applied scope the delivered-archive pass below; if the filter can't be
  // applied the run covers every mode, so a full archive is still right.
  let appliedModes = null;
  const modes = Array.isArray(fpxScrapeModes) ? fpxScrapeModes.map(String).filter(Boolean) : [];
  if (modes.length && modes.length < 3) {
    sendStatus(`Limiting to ${modes.join(" + ")} shipments...`);
    const ok = await fpxFilterViaKendoApi(JSON.stringify(modes), [], { mode: "modes" });
    if (ok) {
      appliedModes = modes;
      sendStatus(`Grid limited to ${modes.join(" + ")} (${fpxLastInjectDetail.split("|").pop().trim()}).`);
    } else {
      sendStatus(`Couldn't limit the grid to ${modes.join(" + ")} — refreshing every mode instead.`);
    }
    await humanDelay(800, 1300);
  }

  // Fewer, bigger pages. Changing the page size returns the grid to page 1,
  // so do it BEFORE reading the starting page below (the delivered-archive
  // guard depends on that read).
  if (Number(fpxScrapePageSize) > 10) {
    sendStatus(`Setting the grid to ${fpxScrapePageSize} rows per page...`);
    try { await setGridPageSize(Number(fpxScrapePageSize), sendStatus); } catch (e) { console.warn("[FPX] page size change failed:", e?.message || e); }
    await humanDelay(600, 900);
  }

  let pageNum = 1;
  // A sweep that starts anywhere but the grid's first page cannot see every
  // shipment, so its "not seen" set must never drive the delivered-archive
  // pass. Read the pager before we touch anything.
  const startingGridPage = currentGridPage();
  const startedOnFirstPage = startingGridPage === null || startingGridPage === 1;
  if (!startedOnFirstPage) {
    sendStatus(`Starting from grid page ${startingGridPage} — delivered-shipment archiving will be skipped for this run.`);
  }
  // We drop uploaded rows from logRows so the array doesn't grow
  // unboundedly during long scrapes (a 50-page sweep with 50 rows/page
  // and ~30 KB per modal = ~75 MB resident otherwise — tips reps with
  // older laptops into memory pressure). Rows that DID upload land in
  // counters we use for the final status; the rows themselves are
  // gone-from-this-tab the moment Railway acks.
  let pageRowCount = 0;        // rows scraped this page (reset each iteration)
  let totalScraped = 0;        // total rows scraped this run, for the "Done" line
  let confirmedRows = 0;       // rows the server has acked
  let droppedRows = 0;         // rows with no usable tracking number (never uploaded)
  const uploadsInFlight = new Set(); // page uploads background hasn't answered yet

  // Helper: ship the current logRows buffer to background, then
  // truncate logRows so memory stays bounded to ~one page at a time.
  // Background's persistent queue handles concurrent pushes + worker
  // restarts, so we can fire-and-forget without blocking the next
  // page's scrape.
  function flushAndDropLogRows(label) {
    if (!logRows.length) return Promise.resolve({ count: 0, ok: true });
    // Hand the buffer to background and immediately reset so the
    // next page starts clean. structuredClone via postMessage means
    // background gets its own copy — we don't have to wait for the
    // round-trip to clear our reference.
    const buffered = logRows;
    logRows = [];
    // Memorize every tracking number leaving the page so we can compare
    // against the DB at sweep-completion time. Done on the raw buffer so a
    // shipment we saw but couldn't upload is still never archived.
    for (const row of buffered) {
      const tn = row && row._trackingNumber;
      if (tn) sweepTrackingNumbers.add(String(tn).replace(/\s+/g, " ").trim());
    }
    // Primitive-only values, duplicates collapsed, unkeyed rows dropped.
    const { rows: slice, dropped } = prepareRowsForUpload(buffered);
    if (dropped) {
      droppedRows += dropped;
      console.warn(`[FPX] ${label}: dropped ${dropped} row(s) with no usable tracking number`);
    }
    if (!slice.length) return Promise.resolve({ count: 0, ok: true });
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "upsertShipmentsBulk", rows: slice }, (r) => {
          // A dead service worker surfaces as lastError + undefined response.
          const le = chrome.runtime.lastError;
          if (r && r.ok) {
            confirmedRows += r.count || slice.length;
          } else if (r && r.error) {
            // Background queues the chunk on failure — it'll retry on
            // the next page's stream call AND on worker boot. We just
            // surface the side-panel chip; no in-page logging.
          }
          resolve(r || { ok: false, error: le?.message || "no response" });
        });
      } catch (e) {
        // sendMessage itself threw (extension context invalidated, or an
        // unserializable value that slipped past sanitizeRow). The rows are
        // lost for this run, but the sweep continues.
        console.warn(`[FPX] ${label}: sendMessage failed:`, e?.message || e);
        resolve({ ok: false, error: e?.message || "sendMessage failed" });
      }
    });
  }

  // Everything from here on is guarded: any throw (grid vanished, pager
  // changed shape, page navigated) flushes whatever was scraped and sends
  // a terminal "complete" so the side panel / headless runner never sit on
  // "running" forever.
  try {
  while (true) {
    await fpxPauseGate(); // paused: wait here, between pages
    if (stopRequested) {
      await flushAndDropLogRows("stopped");
      sendComplete(`Stopped by user. ${totalScraped} row(s) scraped, ${confirmedRows} confirmed.`);
      return;
    }

    sendStatus(`Processing page ${pageNum}...`);
    // logRows was emptied by the previous page's flush, so its length
    // after processPage is exactly this page's contribution.
    try {
      await processPage();
    } catch (e) {
      // processPage isolates per-row failures; this catches the rare
      // page-level throw (kendo prefetch, grid read). Keep whatever rows
      // it managed to log and move to the next page.
      console.warn(`[FPX] page ${pageNum} failed:`, e?.message || e);
      sendStatus(`Page ${pageNum} hit an error (${e?.message || e}) — keeping ${logRows.length} row(s), moving on.`);
    }
    pageRowCount = logRows.length;
    totalScraped += pageRowCount;

    if (stopRequested) {
      await flushAndDropLogRows("stopped");
      sendComplete(`Stopped by user. ${totalScraped} row(s) scraped, ${confirmedRows} confirmed.`);
      return;
    }
    if (abortRunReason) {
      await flushAndDropLogRows("aborted");
      sendComplete(`Stopped on page ${pageNum}: ${abortRunReason} ${totalScraped} row(s) scraped, ${confirmedRows} confirmed.`);
      return;
    }

    // Stream this page's rows to the dashboard. Don't await — the
    // upload runs in parallel with the next page's scrape so the
    // dashboard fills in real time and the next page can't pile up
    // on top of an unsent batch. logRows is reset inside the helper
    // so memory stays bounded to ~one page at a time.
    sendStatus(`Page ${pageNum} done — uploading ${pageRowCount} row(s)…`);
    const upload = flushAndDropLogRows(`page ${pageNum}`).catch(() => { /* surfaced via side-panel chip */ });
    uploadsInFlight.add(upload);
    upload.then(() => uploadsInFlight.delete(upload));

    let advanced = false;
    try { advanced = goToNextPage(); } catch (e) { console.warn("[FPX] goToNextPage failed:", e?.message || e); }
    if (!advanced) break;

    pageNum++;
    await waitForGridReady(3000);
  }

  // Final flush — catches anything still buffered (rare, since we
  // flush after each page, but safe). Awaited so the "Done" status
  // reflects the true confirmed count.
  if (logRows.length > 0) {
    sendStatus(`Finalizing upload of ${logRows.length} remaining row(s)…`);
    await flushAndDropLogRows("final flush");
  }
  // Page uploads run in the background, so the last page's is normally still
  // on its way here. Wait for it (capped) — otherwise the "Done" line reports
  // that whole page as "queued for retry" when nothing failed, and the
  // delivered-archive pass below runs before the final rows have landed.
  if (uploadsInFlight.size > 0) {
    sendStatus(`Waiting for the last upload${uploadsInFlight.size === 1 ? "" : "s"} to be confirmed…`);
    await Promise.race([Promise.all([...uploadsInFlight]), sleep(60000)]);
  }

  // Background-side bookkeeping: drop the legacy checkpoint blob so
  // chrome.storage doesn't carry stale data into the next session.
  try { chrome.storage.local.remove("_fpxCheckpoint"); } catch {}
  try { chrome.runtime.sendMessage({ type: "aiSummary", text: "" }); } catch {}

  // Auto-archive shipments that left the dashboard (i.e. delivered).
  // Only when this was a clean unfiltered sweep — a filtered run can't
  // tell delivered apart from filtered-out, and a stopped run hasn't
  // visited every page so its set is incomplete.
  let archiveSummary = "";
  if (!filterCol && !filterVal && startedOnFirstPage && sweepTrackingNumbers.size > 0) {
    sendStatus(`Reconciling delivered ${appliedModes ? appliedModes.join(" + ") + " " : ""}shipments (${sweepTrackingNumbers.size} seen)…`);
    try {
      const r = await chrome.runtime.sendMessage({
        type: "sweepComplete",
        trackingNumbers: Array.from(sweepTrackingNumbers),
        // A mode-limited run only archives within the modes it covered.
        modes: appliedModes,
      });
      if (r && r.ok && (r.archived_shipments > 0 || r.archived_tasks > 0)) {
        archiveSummary = `, archived ${r.archived_shipments} delivered shipment${r.archived_shipments === 1 ? "" : "s"}` +
          (r.archived_tasks > 0 ? ` and ${r.archived_tasks} task${r.archived_tasks === 1 ? "" : "s"}` : "");
      }
    } catch (e) {
      // Best-effort — don't fail the sweep if archive RPC didn't land.
      console.warn("[FPX] sweep-complete failed:", e?.message || e);
    }
  }

  const queuedButUnconfirmed = Math.max(0, totalScraped - droppedRows - confirmedRows);
  sendComplete(
    `Done — ${pageNum} page(s), ${confirmedRows} confirmed${queuedButUnconfirmed > 0 ? `, ${queuedButUnconfirmed} queued for retry` : ""}${droppedRows > 0 ? `, ${droppedRows} skipped (no tracking number)` : ""}${archiveSummary}. Open the dashboard to see analysis.`
  );
  } catch (e) {
    console.error("[FPX] run() aborted:", e?.stack || e);
    // Ship whatever is buffered so the rows already scraped aren't lost.
    try { await flushAndDropLogRows("error flush"); } catch {}
    sendComplete(`Stopped after an error on page ${pageNum}: ${e?.message || e}. ${totalScraped} row(s) scraped, ${confirmedRows} confirmed.`);
  }
}

// =====================================================================
// GP AUDIT MODE
// =====================================================================

function sendGpStatus(text) {
  dlog("[FPX-GP]", text);
  try { chrome.runtime.sendMessage({ type: "gpAuditStatus", text }); } catch {}
}

function sendGpComplete(text) {
  dlog("[FPX-GP] COMPLETE:", text);
  try { chrome.runtime.sendMessage({ type: "gpAuditComplete", text }); } catch {}
}

function normalizeRowKeys(row) {
  const keyMap = {
    "customerid": "Customer Id",
    "customer_id": "Customer Id",
    "CustomerId": "Customer Id",
    "customername": "Customer Name",
    "customer_name": "Customer Name",
    "CustomerName": "Customer Name",
    "shipmentid": "ShipmentID",
    "shipment_id": "ShipmentID",
    "ShipmentId": "ShipmentID",
    "shipmentmarkeduprate": "Shipment Marked-Up Rate",
    "ShipmentMarkedUpRate": "Shipment Marked-Up Rate",
    "Shipment_Marked_Up_Rate": "Shipment Marked-Up Rate",
    "shipmentratewithoutmarkup": "Shipment Rate without mark up",
    "ShipmentRateWithoutMarkUp": "Shipment Rate without mark up",
    "shipmentgrossprofit": "Shipment Gross Profit",
    "ShipmentGrossProfit": "Shipment Gross Profit",
    "Shipment_Gross_Profit": "Shipment Gross Profit",
    "shippeddate": "Shipped Date",
    "ShippedDate": "Shipped Date",
    "Shipped_Date": "Shipped Date",
    "originalmarkedupamount": "Original Marked-Up Amount",
    "OriginalMarkedUpAmount": "Original Marked-Up Amount",
    "ratechangeamount": "Rate Change Amount",
    "RateChangeAmount": "Rate Change Amount",
    "accountmanager": "Account Manager",
    "AccountManager": "Account Manager",
  };

  const normalized = {};
  for (const [key, val] of Object.entries(row)) {
    const mapped = keyMap[key] || keyMap[key.replace(/[\s\-_]/g, "")] || key;
    normalized[mapped] = val;
  }
  return normalized;
}

// "MM/DD/YYYY" → "YYYY-MM-DD" so the server can store dates as PG `date` values.
// Returns null when the input doesn't match the expected shape.
function isoDateFromMmDdYyyy(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// Strip our internal `_` keys before persisting raw row JSON — the server's
// audit row table stores `raw` as jsonb, and we don't want UI bookkeeping
// (_gpPct, _isOutlier, _customerMean, ...) leaking into the canonical record.
function stripUnderscoreKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

function gpComputeGpPct(grossProfit, markupRate) {
  const gp = parseFloat(grossProfit);
  const mr = parseFloat(markupRate);
  if (!Number.isFinite(gp) || !Number.isFinite(mr) || mr === 0) return null;
  return (gp / mr) * 100;
}

function gpComputeStats(rows) {
  const groups = new Map();
  for (const row of rows) {
    const cid = row["Customer Id"] || "";
    if (!cid) continue;
    const pct = gpComputeGpPct(row["Shipment Gross Profit"], row["Shipment Marked-Up Rate"]);
    if (pct === null) continue;
    if (!groups.has(cid)) {
      groups.set(cid, { customerId: cid, customerName: row["Customer Name"] || "", values: [] });
    }
    groups.get(cid).values.push(pct);
  }
  const stats = new Map();
  for (const [cid, g] of groups) {
    const n = g.values.length;
    const mean = g.values.reduce((a, b) => a + b, 0) / n;
    const variance = g.values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    stats.set(cid, { customerId: cid, customerName: g.customerName, count: n, mean, stdev, outlierCount: 0 });
  }
  return stats;
}

function gpFlagOutliers(rows, stats) {
  for (const row of rows) {
    const cid = row["Customer Id"] || "";
    const pct = gpComputeGpPct(row["Shipment Gross Profit"], row["Shipment Marked-Up Rate"]);
    row._gpPct = pct;
    row._isOutlier = false;
    const st = stats.get(cid);
    if (!st || pct === null) continue;
    row._customerMean = st.mean;
    row._customerStdev = st.stdev;
    if (st.count < 3) continue;
    const deviation = Math.abs(pct - st.mean);
    row._deviation = deviation;
    if (deviation > 2 * st.stdev) {
      row._isOutlier = true;
      st.outlierCount++;
    }
  }
  return rows;
}

function buildKendoFieldMap(kendoGrid) {
  const fieldToTitle = {};
  const columns = kendoGrid.columns || [];
  for (const col of columns) {
    if (col.field && col.title) {
      fieldToTitle[col.field] = col.title;
    }
  }
  dlog("[FPX-GP] Kendo column map:", JSON.stringify(fieldToTitle));
  return fieldToTitle;
}

function kendoItemToRow(item, fieldMap) {
  const skipKeys = new Set(["_events", "uid", "dirty", "_handlers", "__metadata"]);
  const row = {};
  for (const key of Object.keys(item)) {
    if (skipKeys.has(key) || key.startsWith("_")) continue;
    const val = item[key];
    if (val === null || val === undefined || val === "") continue;
    const displayName = fieldMap[key] || key;
    row[displayName] = typeof val === "object" ? JSON.stringify(val) : String(val);
  }
  return row;
}

// Fetch kendo grid rows once and key them by tracking number so the per-row
// scrape loop can fold in grid-only fields (Order #, References, Company,
// Spot Quote, etc.) without doing a separate kendo round-trip per click.
// Returns an empty Map if the kendo widget isn't reachable — callers can
// safely lookup() with no merge effect.
async function fetchKendoRowMap() {
  try {
    const rows = await getKendoGridAllRows();
    if (!rows || !rows.length) return new Map();
    const map = new Map();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const tn = String(
        row["Tracking Number"] || row["TrackingNumber"] || row["Tracking"] || ""
      ).replace(/\s+/g, " ").trim();
      if (tn) map.set(tn, row);
    }
    dlog("[FPX] Kendo row map: keyed", map.size, "of", rows.length);
    return map;
  } catch (e) {
    dlog("[FPX] Kendo prefetch failed:", e.message);
    return new Map();
  }
}

// Modal data wins for shared keys (it's richer / has freshest timestamps).
// Kendo row only fills keys not already present, and skips internal keys.
function mergeKendoRow(modalData, kendoRow) {
  if (!kendoRow || typeof kendoRow !== "object" || !modalData) return;
  for (const k of Object.keys(kendoRow)) {
    if (k.startsWith("_") || k === "__proto__" || k === "constructor") continue;
    const existing = modalData[k];
    if (existing !== undefined && existing !== null && existing !== "") continue;
    const v = kendoRow[k];
    if (v === null || v === undefined || v === "") continue;
    modalData[k] = v;
  }
}

// `timeoutMs` — how long to wait for the page-world reader (3s suits the
// shipment grid; a multi-thousand-row history report needs longer).
// `meta` — optional object filled with { total, fieldMap, skipped, error }
// so a caller can tell "0 rows" from "could not read" and spot a paged grid.
function getKendoGridAllRows(timeoutMs = 3000, meta = null) {
  return new Promise((resolve) => {
    let settled = false;

    function onMessage(event) {
      if (!event.data || event.data.type !== "_fpxKendoResult") return;
      window.removeEventListener("message", onMessage);
      settled = true;
      // Everything below runs after `settled` flips, so a throw here would
      // leave the promise pending forever (the timeout guard checks
      // `settled`). Wrap it: a malformed payload resolves null instead of
      // hanging the whole page scrape.
      try {
        const result = event.data.payload;
        if (!result || typeof result !== "object") { resolve(null); return; }
        if (meta) {
          meta.total = typeof result.total === "number" ? result.total : null;
          meta.fieldMap = result.fieldMap || null;
          meta.skipped = result.skipped || 0;
          meta.error = result.error || null;
        }

        if (result.error) {
          dlog("[FPX-GP] Kendo inject error:", result.error);
          resolve(null);
          return;
        }
        if (!Array.isArray(result.rows)) { resolve(null); return; }

        dlog("[FPX-GP] Kendo inject: got", result.rows.length, "of", result.total, "total rows",
          result.skipped ? `(${result.skipped} skipped)` : "");
        dlog("[FPX-GP] Field map:", JSON.stringify(result.fieldMap));
        if (result.rows.length > 0) {
          dlog("[FPX-GP] Sample keys:", Object.keys(result.rows[0]).join(", "));
          dlog("[FPX-GP] Sample row:", JSON.stringify(result.rows[0]));
        }
        resolve(result.rows.filter((r) => r && typeof r === "object"));
      } catch (e) {
        console.warn("[FPX] Kendo result handler failed:", e?.message || e);
        resolve(null);
      }
    }

    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject-kendo.js");
    script.onload = () => script.remove();
    script.onerror = () => {
      dlog("[FPX-GP] Failed to load inject-kendo.js");
      script.remove();
      if (meta) meta.error = "inject-kendo.js failed to load";
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        resolve(null);
      }
    };
    (document.head || document.documentElement).appendChild(script);

    setTimeout(() => {
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        dlog("[FPX-GP] Kendo inject timed out after", timeoutMs, "ms");
        if (meta) meta.error = `no answer from the grid after ${Math.round(timeoutMs / 1000)}s`;
        resolve(null);
      }
    }, timeoutMs);
  });
}

function setDateInput(input, dateStr) {
  const parts = dateStr.split("/");
  const mm = parts[0], dd = parts[1], yyyy = parts[2];
  const isoDate = `${yyyy}-${mm}-${dd}`;
  const dateObj = new Date(+yyyy, +mm - 1, +dd);

  try {
    const kendoWidget = window.jQuery && window.jQuery(input).data("kendoDatePicker");
    if (kendoWidget) {
      kendoWidget.value(dateObj);
      kendoWidget.trigger("change");
      dlog("[FPX-GP] Set via Kendo API:", dateStr);
      return;
    }
  } catch (e) {
    dlog("[FPX-GP] Kendo API failed, trying direct:", e.message);
  }

  const valueToSet = input.type === "date" ? isoDate : dateStr;

  input.focus();
  try {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    ).set;
    nativeSetter.call(input, valueToSet);
  } catch {
    input.value = valueToSet;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0" }));
  input.blur();

  if (!input.value) {
    input.setAttribute("value", valueToSet);
    input.value = valueToSet;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  dlog("[FPX-GP] setDateInput:", input.type, "value after:", input.value, "target:", valueToSet);
}

function getNearbyLabelText(input) {
  const row = input.closest("tr");
  if (row) return row.textContent.toUpperCase().replace(/\s+/g, " ");

  const formGroup = input.closest(".form-group, .control-group");
  if (formGroup) return formGroup.textContent.toUpperCase().replace(/\s+/g, " ");

  const parent = input.parentElement;
  if (parent) {
    const prev = parent.previousElementSibling;
    if (prev) return prev.textContent.toUpperCase().replace(/\s+/g, " ");
  }

  const td = input.closest("td");
  if (td) {
    const prevTd = td.previousElementSibling;
    if (prevTd) return prevTd.textContent.toUpperCase().replace(/\s+/g, " ");
  }

  return "";
}

// root: look only inside this element (default: the whole page).
// skip(input): optional, true for an input that must not be considered.
// → { from, to, all } — `all` is every date-like input found, in page order.
function findDateInputs(root = document, skip = null) {
  const result = { from: null, to: null, all: [] };
  const candidates = result.all;

  const allInputs = root.querySelectorAll("input:not([type='hidden']):not([type='checkbox']):not([type='submit']):not([type='button'])");

  for (const input of allInputs) {
    if (!isVisibleForClick(input)) continue;
    if (skip && skip(input)) continue;

    const ph = (input.placeholder || "").toLowerCase();
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();

    const isDateField =
      input.type === "date" ||
      ph.includes("mm/dd") || ph.includes("mm-dd") || ph.includes("date") ||
      name.includes("date") || id.includes("date") ||
      input.closest("[data-role='datepicker']") ||
      input.closest(".k-datepicker") ||
      input.closest(".k-widget.k-datepicker");

    if (!isDateField) continue;
    candidates.push(input);
  }

  dlog("[FPX-GP] findDateInputs: found", candidates.length, "date-like inputs");

  for (const input of candidates) {
    const label = getNearbyLabelText(input);
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();
    dlog("[FPX-GP]   candidate:", input.type, "id='" + input.id + "' name='" + input.name + "' nearby='" + label.slice(0, 60) + "'");

    if (!result.from && (label.includes("FROM") || name.includes("from") || id.includes("from") || name.includes("start"))) {
      result.from = input;
    } else if (!result.to && (label.includes("TO DATE") || label.includes("TO:") || name.includes("to") || id.includes("to") || name.includes("end"))) {
      result.to = input;
    }
  }

  if ((!result.from || !result.to) && candidates.length >= 2) {
    dlog("[FPX-GP] Using positional fallback for date inputs");
    if (!result.from) result.from = candidates[0];
    if (!result.to) result.to = candidates[1];
  } else if ((!result.from || !result.to) && candidates.length === 1) {
    if (!result.from) result.from = candidates[0];
    if (!result.to) result.to = candidates[0];
  }

  dlog("[FPX-GP] Final: from=", result.from?.id || result.from?.name || "?", "to=", result.to?.id || result.to?.name || "?");
  return result;
}

function clickShipmentTypeTab(type) {
  const navLinks = document.querySelectorAll("a, button, li, span, div[role='tab']");
  for (const el of navLinks) {
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (type === "parcel" && /^parcel$/i.test(txt)) {
      simulateClick(el);
      return true;
    }
    if (type === "non-parcel" && /^non[\s-]?parcel$/i.test(txt)) {
      simulateClick(el);
      return true;
    }
  }
  return false;
}

async function gpAuditRun(fromDate, toDate, shipmentType, aiAnalysis, customerFilter) {
  stopRequested = false;
  const aiLevel = aiAnalysis || "off";
  const dateLabel = fromDate === toDate ? fromDate : `${fromDate} — ${toDate}`;

  if (shipmentType === "all") {
    sendGpStatus("Running GP Audit for ALL types (Non-Parcel + Parcel)...");
    const nonParcelRows = await gpAuditSingleRun(fromDate, toDate, "non-parcel", customerFilter);
    if (stopRequested) { sendGpComplete("Stopped by user."); return; }
    const parcelRows = await gpAuditSingleRun(fromDate, toDate, "parcel", customerFilter);
    if (stopRequested) { sendGpComplete("Stopped by user."); return; }

    const allRows = [...(nonParcelRows || []), ...(parcelRows || [])];
    if (allRows.length === 0) {
      sendGpComplete("No transactions found for " + dateLabel + ".");
      return;
    }
    sendGpStatus(`Combined ${allRows.length} total transaction(s). Computing GP stats...`);
    await gpFinalize(allRows, dateLabel, aiLevel, { fromDate, toDate, shipmentType });
    return;
  }

  const rows = await gpAuditSingleRun(fromDate, toDate, shipmentType, customerFilter);
  if (stopRequested) { sendGpComplete("Stopped by user."); return; }
  if (!rows || rows.length === 0) {
    sendGpComplete("No transactions found for " + dateLabel + ".");
    return;
  }
  await gpFinalize(rows, dateLabel, aiLevel, { fromDate, toDate, shipmentType });
}

function gpIdentifyNeedsReview(allRows, stats) {
  const review = [];
  for (const row of allRows) {
    if (row._isOutlier) {
      row._reviewReason = "Outlier (>2 STDEV from customer avg)";
      review.push(row);
      continue;
    }
    const cid = row["Customer Id"] || "";
    const st = stats.get(cid);
    if (!st || row._gpPct === null || row._gpPct === undefined) continue;

    if (st.count >= 3 && st.stdev > 0) {
      const dev = Math.abs(row._gpPct - st.mean);
      if (dev > 1.5 * st.stdev) {
        row._reviewReason = "Borderline (>1.5 STDEV from customer avg)";
        review.push(row);
        continue;
      }
    }

    const gp = parseFloat(row["Shipment Gross Profit"]);
    if (Number.isFinite(gp) && gp < 0) {
      row._reviewReason = "Negative gross profit";
      review.push(row);
      continue;
    }

    if (row._gpPct !== null && row._gpPct !== undefined && row._gpPct < 2) {
      row._reviewReason = "GP% below 2% threshold";
      review.push(row);
      continue;
    }

    const mr = parseFloat(row["Shipment Marked-Up Rate"]);
    if (Number.isFinite(mr) && mr === 0) {
      row._reviewReason = "Zero marked-up rate";
      review.push(row);
    }
  }
  return review;
}

function gpBuildAiPayload(allRows, stats, outliers, reviewRows) {
  const custSummaries = [];
  for (const [, st] of stats) {
    custSummaries.push({
      customerId: st.customerId,
      customerName: st.customerName,
      shipments: st.count,
      avgGpPct: +st.mean.toFixed(2),
      stdev: +st.stdev.toFixed(2),
      outliers: st.outlierCount,
    });
  }

  const flaggedRows = reviewRows.map((r) => ({
    shipmentId: r["ShipmentID"] || "",
    customerId: r["Customer Id"] || "",
    customerName: r["Customer Name"] || "",
    markedUpRate: r["Shipment Marked-Up Rate"] || "",
    grossProfit: r["Shipment Gross Profit"] || "",
    gpPct: r._gpPct != null ? +r._gpPct.toFixed(2) : null,
    customerAvgGpPct: r._customerMean != null ? +r._customerMean.toFixed(2) : null,
    deviation: r._deviation != null ? +r._deviation.toFixed(2) : null,
    reason: r._reviewReason || "",
    carrier: r["Carrier"] || "",
    service: r["Service"] || "",
  }));

  return {
    date: allRows[0]?.["Shipped Date"] || "",
    totalShipments: allRows.length,
    totalCustomers: stats.size,
    outlierCount: outliers.length,
    reviewCount: reviewRows.length,
    customerSummaries: custSummaries.sort((a, b) => b.outliers - a.outliers),
    flaggedShipments: flaggedRows,
  };
}

async function gpFinalize(allRows, bizDate, aiLevel, runMeta = {}) {
  for (let i = 0; i < allRows.length; i++) {
    allRows[i] = normalizeRowKeys(allRows[i]);
  }
  dlog("[FPX-GP] Normalized", allRows.length, "rows. Sample keys:", Object.keys(allRows[0] || {}).join(", "));

  const stats = gpComputeStats(allRows);
  gpFlagOutliers(allRows, stats);

  const outliers = allRows.filter((r) => r._isOutlier);
  const reviewRows = gpIdentifyNeedsReview(allRows, stats);

  sendGpStatus(`Found ${outliers.length} outlier(s), ${reviewRows.length} row(s) needing review across ${stats.size} customer(s).`);

  const outlierSummary = outliers.map((r) => ({
    customerId: r["Customer Id"] || "",
    customerName: r["Customer Name"] || "",
    shipmentId: r["ShipmentID"] || "",
    gpPct: r._gpPct != null ? r._gpPct.toFixed(2) : "?",
    mean: r._customerMean != null ? r._customerMean.toFixed(2) : "?",
    deviation: r._deviation != null ? r._deviation.toFixed(2) : "?",
  }));

  try {
    chrome.runtime.sendMessage({ type: "gpAuditOutliers", outliers: outlierSummary });
  } catch {}

  // GP audit AI moved to the dashboard server. The extension now scrapes +
  // uploads only; analysis runs in the background after POST /api/audits/gp.
  // `aiLevel` is still passed through to the server so users can opt out.

  // Upload the audit run + rows to the server. The POST handler kicks off AI
  // in the background based on `ai_level`.
  try {
    const allPctValues = allRows.map((r) => r._gpPct).filter((v) => Number.isFinite(v));
    const meanGpPct = allPctValues.length
      ? allPctValues.reduce((a, b) => a + b, 0) / allPctValues.length
      : null;
    const variance = allPctValues.length
      ? allPctValues.reduce((a, v) => a + (v - meanGpPct) ** 2, 0) / allPctValues.length
      : null;
    const stdevGpPct = variance !== null ? Math.sqrt(variance) : null;
    const runPayload = {
      run: {
        date_from: isoDateFromMmDdYyyy(runMeta.fromDate) || null,
        date_to: isoDateFromMmDdYyyy(runMeta.toDate) || null,
        shipment_type: runMeta.shipmentType || null,
        total_rows: allRows.length,
        outlier_count: outliers.length,
        mean_gp_pct: meanGpPct != null ? +meanGpPct.toFixed(4) : null,
        stdev_gp_pct: stdevGpPct != null ? +stdevGpPct.toFixed(4) : null,
      },
      rows: allRows.map((r) => ({
        shipment_id: String(r["ShipmentID"] || r["Shipment Id"] || ""),
        customer_name: r["Customer Name"] || null,
        invoice_number: r["Invoice Number"] || null,
        gross_profit: parseFloat(r["Shipment Gross Profit"]) || null,
        gp_pct: r._gpPct != null ? +r._gpPct.toFixed(4) : null,
        rate_without_markup: parseFloat(r["Shipment Rate without mark up"]) || null,
        marked_up_rate: parseFloat(r["Shipment Marked-Up Rate"]) || null,
        is_outlier: !!r._isOutlier,
        std_deviations: r._deviation != null && r._customerStdev
          ? +(r._deviation / r._customerStdev).toFixed(2)
          : null,
        raw: stripUnderscoreKeys(r),
      })),
      ai_level: aiLevel,
    };
    sendGpStatus("Uploading audit run to dashboard...");
    const resp = await chrome.runtime.sendMessage({ type: "uploadGpAudit", payload: runPayload });
    if (resp && resp.ok) {
      sendGpStatus(`Uploaded ${resp.row_count || allRows.length} row(s). Analysis runs in the dashboard.`);
    } else if (resp && resp.error) {
      console.warn("[FPX-GP] Upload failed:", resp.error);
      sendGpStatus("Upload failed: " + resp.error);
    }
  } catch (e) {
    console.warn("[FPX-GP] Upload threw:", e.message);
  }

  sendGpComplete(
    `GP Audit done — ${allRows.length} transaction(s), ${stats.size} customer(s), ${outliers.length} outlier(s), ${reviewRows.length} review row(s).`
  );
}

async function gpAuditSingleRun(fromDate, toDate, shipmentType, customerFilter) {
  const typeLabel = shipmentType === "parcel" ? "Parcel" : "Non-Parcel";
  const dateLabel = fromDate === toDate ? fromDate : `${fromDate} — ${toDate}`;
  sendGpStatus("Starting GP Audit (" + typeLabel + ") for " + dateLabel + "...");

  const currentUrl = window.location.href;
  if (!currentUrl.includes("Transactions")) {
    sendGpStatus("Navigating to Transactions page...");
    window.location.hash = "#!/Transactions";
    await humanDelay(2500, 4000);
  }

  sendGpStatus("Waiting for Generate History Report dialog...");
  let dialogFound = false;
  for (let wait = 0; wait < 20000; wait += 500) {
    const allText = document.body.innerText.toUpperCase();
    if (allText.includes("GENERATE HISTORY REPORT") || allText.includes("GENERATE REPORT")) {
      dialogFound = true;
      break;
    }
    const btn = document.querySelector("button.generate-report, [ng-click*='generate'], a.btn");
    if (btn && /generate report/i.test(btn.textContent)) {
      simulateClick(btn);
      await humanDelay(1200, 2000);
    }
    await humanDelay(400, 700);
  }

  if (!dialogFound) {
    sendGpStatus("Looking for Generate Report button...");
    const allBtns = document.querySelectorAll("button, a.btn, input[type='button']");
    for (const b of allBtns) {
      if (/generate\s*report/i.test(b.textContent || b.value || "")) {
        simulateClick(b);
        await humanDelay(1500, 2500);
        break;
      }
    }
  }

  await humanDelay(800, 1500);

  sendGpStatus("Filling date fields: " + dateLabel + "...");

  const dateFields = findDateInputs();
  if (!dateFields.from && !dateFields.to) {
    sendGpStatus("ERROR: Could not find any date inputs on this page. Check that the Generate History Report dialog is open.");
    sendGpComplete("Failed — no date inputs found.");
    return;
  }

  if (dateFields.from) {
    setDateInput(dateFields.from, fromDate);
    sendGpStatus("Set FROM DATE to " + fromDate + " (value: " + dateFields.from.value + ")");
  }
  await humanDelay(400, 800);

  if (dateFields.to) {
    setDateInput(dateFields.to, toDate);
    sendGpStatus("Set TO DATE to " + toDate + " (value: " + dateFields.to.value + ")");
  }
  await humanDelay(400, 800);

  function retryDateFill(input, label, dateStr) {
    if (!input || input.value) return;
    const parts = dateStr.split("/");
    const isoVal = `${parts[2]}-${parts[0]}-${parts[1]}`;
    const valForType = input.type === "date" ? isoVal : dateStr;

    sendGpStatus(`Retrying ${label} with angular model...`);
    try {
      const scope = window.angular && window.angular.element(input).scope();
      if (scope) {
        const modelAttr = input.getAttribute("ng-model") || input.getAttribute("data-ng-model");
        if (modelAttr) {
          const keys = modelAttr.split(".");
          let target = scope;
          for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
          target[keys[keys.length - 1]] = valForType;
          scope.$apply();
          sendGpStatus(`Set ${label} via Angular model: ${modelAttr}`);
        }
      }
    } catch (e) {
      dlog("[FPX-GP] Angular retry failed:", e.message);
    }
    input.value = valForType;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  retryDateFill(dateFields.from, "FROM DATE", fromDate);
  retryDateFill(dateFields.to, "TO DATE", toDate);
  await humanDelay(400, 800);

  const custTarget = customerFilter || "";
  const useAllCustomers = !custTarget || /^all(\s*customers)?$/i.test(custTarget);

  sendGpStatus(useAllCustomers ? "Setting SELECT CUSTOMER to All Customers..." : `Setting customer filter to "${custTarget}"...`);
  const selects = document.querySelectorAll("select");
  for (const sel of selects) {
    const row = sel.closest("tr, div, .form-group");
    const rowText = row ? row.textContent.toUpperCase() : "";
    const name = (sel.name || "").toLowerCase();
    const id = (sel.id || "").toLowerCase();

    if (rowText.includes("CUSTOMER") || name.includes("customer") || id.includes("customer")) {
      let matched = false;

      if (useAllCustomers) {
        for (const opt of sel.options) {
          if (/all\s*customers/i.test(opt.text)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            sendGpStatus("Set customer dropdown to: " + opt.text);
            matched = true;
            break;
          }
        }
      } else {
        const needle = custTarget.toLowerCase();
        for (const opt of sel.options) {
          const optText = opt.text.toLowerCase();
          if (optText.includes(needle) || opt.value === custTarget) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            sendGpStatus("Set customer dropdown to: " + opt.text);
            matched = true;
            break;
          }
        }
        if (!matched) {
          sendGpStatus(`Customer "${custTarget}" not found in dropdown, using All Customers.`);
          for (const opt of sel.options) {
            if (/all\s*customers/i.test(opt.text)) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              break;
            }
          }
        }
      }

      try {
        const kendoWidget = window.jQuery && window.jQuery(sel).data("kendoDropDownList");
        if (kendoWidget) {
          const ds = kendoWidget.dataSource.data();
          const searchTarget = useAllCustomers ? /all\s*customers/i : new RegExp(custTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          for (let i = 0; i < ds.length; i++) {
            const itemText = ds[i].text || ds[i].Text || ds[i].Name || "";
            if (searchTarget.test(itemText)) {
              kendoWidget.select(i);
              kendoWidget.trigger("change");
              sendGpStatus("Set customer via Kendo dropdown: " + itemText);
              break;
            }
          }
        }
      } catch (e) {
        dlog("[FPX-GP] Kendo dropdown failed:", e.message);
      }
      break;
    }
  }
  await humanDelay(400, 800);

  sendGpStatus("Clicking CONTINUE...");
  let continueClicked = false;
  const buttons = document.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn, .btn");
  for (const btn of buttons) {
    const txt = (btn.textContent || btn.value || "").replace(/\s+/g, " ").trim().toUpperCase();
    if (txt === "CONTINUE" || txt === "GENERATE" || txt === "SUBMIT") {
      simulateClick(btn);
      continueClicked = true;
      break;
    }
  }

  if (!continueClicked) {
    sendGpComplete("ERROR: Could not find CONTINUE button.");
    return;
  }

  sendGpStatus("Waiting for results grid to load...");
  await humanDelay(2500, 4000);

  let gridReady = false;
  for (let wait = 0; wait < 15000; wait += 1000) {
    const gridRows = document.querySelectorAll(
      ".k-grid-content tbody tr, .k-grid tbody tr"
    );
    const visibleRows = [...gridRows].filter(
      (r) => !r.classList.contains("k-no-data") && !r.classList.contains("k-grouping-row")
    );
    if (visibleRows.length > 0) {
      gridReady = true;
      break;
    }
    await humanDelay(800, 1300);
  }

  if (!gridReady) {
    sendGpStatus("No grid data loaded for " + typeLabel + ". The form may not have submitted.");
    return [];
  }

  sendGpStatus("Selecting " + typeLabel + " tab...");
  clickShipmentTypeTab(shipmentType);
  await humanDelay(1500, 2500);
  await waitForGridReady(5000);

  sendGpStatus("Reading " + typeLabel + " transaction data...");

  let allRows = await getKendoGridAllRows();

  if (allRows !== null) {
    sendGpStatus(`Kendo API: got ${allRows.length} ${typeLabel} transaction(s).`);
  } else {
    sendGpStatus("Kendo API unavailable, scraping pages...");
    allRows = [];
    let pageNum = 1;
    while (true) {
      if (stopRequested) {
        sendGpStatus("Stopped by user.");
        return allRows;
      }
      sendGpStatus(`Scraping ${typeLabel} grid page ${pageNum}...`);
      const pageRows = scrapeTransactionGrid();
      sendGpStatus(`Page ${pageNum}: found ${pageRows.length} row(s).`);
      allRows = allRows.concat(pageRows);

      const advanced = goToNextPage();
      if (!advanced) break;
      pageNum++;
      await waitForGridReady(5000);
    }
  }

  sendGpStatus(`Read ${allRows.length} ${typeLabel} transaction(s).`);
  return allRows;
}

// =====================================================================
// INVOICE AUDIT
// =====================================================================

function sendInvStatus(text) {
  dlog("[FPX-INV]", text);
  try { chrome.runtime.sendMessage({ type: "invoiceAuditStatus", text }); } catch {}
}

function sendInvComplete(text) {
  dlog("[FPX-INV] COMPLETE:", text);
  try { chrome.runtime.sendMessage({ type: "invoiceAuditComplete", text }); } catch {}
}

async function invoiceAuditRun(shipments, skippedRows, fromDate, toDate, shipmentType, customerFilter, aiAnalysis, skipReport) {
  stopRequested = false;
  const aiLevel = aiAnalysis || "off";
  const dateLabel = fromDate === toDate ? fromDate : `${fromDate} — ${toDate}`;
  const total = shipments.length;

  sendInvStatus(`Starting Invoice Audit: ${total} shipment(s), lookback ${dateLabel}`);

  if (skipReport) {
    sendInvStatus("Skipping report generation — using existing grid data.");
  } else {
    const reportGenerated = await invoiceGenerateReport(fromDate, toDate, shipmentType, customerFilter);
    if (!reportGenerated || stopRequested) {
      sendInvComplete(stopRequested ? "Stopped by user." : "Report generation failed.");
      return;
    }
  }

  // Build a lookup of shipments we need from the uploaded carrier invoice
  const needMap = new Map();
  for (const ship of shipments) {
    needMap.set(String(ship.shipmentId), ship);
  }

  // Restore progress from session storage (survives page changes)
  const prevSession = invLoadSession();
  const results = [];
  const found = new Set();
  if (prevSession && prevSession.foundIds) {
    for (const id of prevSession.foundIds) found.add(id);
    if (prevSession.results) results.push(...prevSession.results);
    sendInvStatus(`Resumed session: ${found.size} already processed.`);
  }
  let pageNum = 1;

  // Save progress to sessionStorage after each shipment
  function persistProgress() {
    invSaveSession({
      foundIds: [...found],
      results,
      needIds: [...needMap.keys()],
      total,
    });
  }

  // Wait for the grid to fully load after report generation
  sendInvStatus("Waiting for grid to fully load…");
  for (let wait = 0; wait < 30000; wait += 1000) {
    const rows = document.querySelectorAll(".k-grid-content tbody tr");
    const dataRows = [...rows].filter(r => !r.classList.contains("k-no-data"));
    if (dataRows.length > 0) break;
    await humanDelay(800, 1300);
  }
  await humanDelay(1500, 2500);

  sendInvStatus(`Setting page size to ${INV_PAGE_SIZE}…`);
  await invoiceSetPageSize(INV_PAGE_SIZE);
  await humanDelay(1500, 2500);

  // Kendo grids with locked (frozen) columns split rows into two <table> elements:
  //   .k-grid-content-locked — locked cols (VIEW SHIPMENT, GET INVOICE buttons)
  //   .k-grid-content        — scrollable cols (Customer ID, …, ShipmentID, …)
  // The rows match by index: locked row[i] ↔ scrollable row[i].

  function getRowPairs() {
    const lockedRows = [...document.querySelectorAll(".k-grid-content-locked tbody tr")].filter(
      r => !r.classList.contains("k-no-data") && !r.classList.contains("k-grouping-row")
    );
    const scrollRows = [...document.querySelectorAll(".k-grid-content tbody tr")].filter(
      r => !r.classList.contains("k-no-data") && !r.classList.contains("k-grouping-row")
    );

    if (lockedRows.length === 0) {
      return scrollRows.map(r => ({ buttonRow: r, dataRow: r }));
    }

    const pairs = [];
    const len = Math.min(lockedRows.length, scrollRows.length);
    for (let i = 0; i < len; i++) {
      pairs.push({ buttonRow: lockedRows[i], dataRow: scrollRows[i] });
    }
    return pairs;
  }

  function findShipmentIdInRow(dataRow) {
    const cells = dataRow.querySelectorAll("td");
    for (const cell of cells) {
      const text = cell.textContent.replace(/\s+/g, "").trim();
      if (text && needMap.has(text)) return text;
    }
    for (const cell of cells) {
      const text = cell.textContent.replace(/\s+/g, "").trim();
      const m = text.match(/^\d{7,}$/);
      if (m && needMap.has(m[0])) return m[0];
    }
    return null;
  }

  function clickViewShipmentOnRow(buttonRow) {
    const btns = buttonRow.querySelectorAll("a, button, input[type='button']");
    for (const btn of btns) {
      const txt = (btn.textContent || btn.value || "").replace(/\s+/g, " ").trim();
      if (/view\s*shipment/i.test(txt)) {
        btn.click();
        return true;
      }
    }
    const firstLink = buttonRow.querySelector("a");
    if (firstLink) { firstLink.click(); return true; }
    return false;
  }

  async function processPage() {
    const pairs = getRowPairs();
    sendInvStatus(`Page ${pageNum}: ${pairs.length} row(s). Scanning for matches… (${found.size}/${total} done)`);

    for (let ri = 0; ri < pairs.length; ri++) {
      if (stopRequested) return;
      const { buttonRow, dataRow } = pairs[ri];
      const sid = findShipmentIdInRow(dataRow);
      if (!sid || found.has(sid)) {
        if (ri % 20 === 19) await yieldToBrowser();
        continue;
      }

      const ship = needMap.get(sid);
      found.add(sid);
      sendInvStatus(`[${found.size}/${total}] ShipID ${sid}: clicking View Shipment…`);

      await microPause();
      if (!clickViewShipmentOnRow(buttonRow)) {
        results.push(makeErrorResult(ship, "View Shipment button not found on row"));
        persistProgress();
        continue;
      }

      sendInvStatus(`[${found.size}/${total}] ShipID ${sid}: waiting for detail view…`);
      await humanDelay(2500, 4000);

      const result = await invoiceScreenshotShipment(ship);
      results.push(result);
      persistProgress();

      await invoiceCloseModal(sid);
      await humanDelay(800, 1800);
      await yieldToBrowser();
    }
  }

  // Paginate through grid — 50 rows per page
  while (true) {
    if (stopRequested) break;
    await processPage();
    if (found.size >= total) {
      sendInvStatus(`All ${total} shipment(s) found.`);
      break;
    }
    const advanced = goToNextPage();
    if (!advanced) {
      sendInvStatus(`Reached last page (page ${pageNum}). ${total - found.size} shipment(s) not in grid.`);
      break;
    }
    pageNum++;
    sendInvStatus(`Page ${pageNum}: loading… (${found.size}/${total} found so far)`);
    await humanDelay(800, 1500);
    await waitForGridReady(8000);
  }

  // Report shipments not found in the grid
  for (const ship of shipments) {
    if (!found.has(String(ship.shipmentId))) {
      results.push(makeErrorResult(ship, "Shipment not found in grid"));
    }
  }

  if (stopRequested) {
    persistProgress();
    sendInvComplete(`Stopped by user. Processed ${found.size} of ${total}. Progress saved — resume to continue.`);
    return;
  }

  invClearSession();
  sendInvStatus(`Processed ${found.size} of ${total}. ${results.filter(r => r.error).length} not found.`);
  await invoiceFinalize(results, skippedRows, dateLabel, aiLevel);
}

const INV_PAGE_SIZE = 50;
const INV_SESSION_KEY = "_fpxInvAuditState";

function invSaveSession(state) {
  try { sessionStorage.setItem(INV_SESSION_KEY, JSON.stringify(state)); } catch {}
}

function invLoadSession() {
  try {
    const raw = sessionStorage.getItem(INV_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function invClearSession() {
  try { sessionStorage.removeItem(INV_SESSION_KEY); } catch {}
}

// Rows per grid page for Refresh All. Bigger pages = fewer page turns (each
// turn costs a grid reload + settle wait). The hosted browser service sets
// this from its admin setting before calling run(); 10 or less leaves the
// grid as it is.
let fpxScrapePageSize = 50;
// Limit Refresh All to these FreightPOP modes (e.g. ["LTL","Truckload"]); null = every mode.
let fpxScrapeModes = null;

function invoiceSetPageSize(target) { return setGridPageSize(target, sendInvStatus); }

async function setGridPageSize(target, report = sendInvStatus) {
  // Strategy 1: Kendo API
  try {
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        var $ = window.jQuery || window.$;
        if (!$) return;
        var grid = $(".k-grid").data("kendoGrid");
        if (!grid) return;
        grid.dataSource.pageSize(${target});
        window.postMessage({ type: "_fpxPageSizeSet", size: ${target} }, "*");
      })();
    `;
    document.head.appendChild(script);
    script.remove();

    const ok = await new Promise((resolve) => {
      function onMsg(e) {
        if (e.data && e.data.type === "_fpxPageSizeSet") {
          window.removeEventListener("message", onMsg);
          resolve(true);
        }
      }
      window.addEventListener("message", onMsg);
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve(false); }, 3000);
    });
    if (ok) {
      report(`Page size set to ${target} via Kendo API.`);
      await waitForGridReady(10000);
      return;
    }
  } catch (e) {
    dlog("[FPX-INV] Kendo pageSize error:", e.message);
  }

  // Strategy 2: Native <select> dropdown — pick closest value >= target
  const pageSizeSelects = document.querySelectorAll(
    ".k-pager-sizes select, .k-pager-wrap select, select[data-role='dropdownlist']"
  );
  for (const sel of pageSizeSelects) {
    let bestOpt = null, bestVal = Infinity;
    for (const opt of sel.options) {
      const n = parseInt(opt.value, 10);
      if (Number.isFinite(n) && n >= target && n < bestVal) { bestVal = n; bestOpt = opt; }
    }
    if (!bestOpt) {
      let maxVal = 0;
      for (const opt of sel.options) {
        const n = parseInt(opt.value, 10);
        if (Number.isFinite(n) && n > maxVal) { maxVal = n; bestOpt = opt; bestVal = n; }
      }
    }
    if (bestOpt) {
      sel.value = bestOpt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      report(`Set page size to ${bestVal} from dropdown.`);
      await waitForGridReady(10000);
      return;
    }
  }

  // Strategy 3: Kendo-rendered dropdown
  const kendoDropdowns = document.querySelectorAll(".k-pager-sizes .k-dropdown, .k-pager-sizes .k-dropdownlist");
  for (const dd of kendoDropdowns) {
    dd.click();
    await humanDelay(400, 700);
    const listItems = document.querySelectorAll(".k-animation-container .k-list .k-item, .k-animation-container .k-list-item");
    let bestLi = null, bestN = Infinity;
    for (const li of listItems) {
      const n = parseInt(li.textContent.trim(), 10);
      if (Number.isFinite(n) && n >= target && n < bestN) { bestN = n; bestLi = li; }
    }
    if (!bestLi) {
      let maxN = 0;
      for (const li of listItems) {
        const n = parseInt(li.textContent.trim(), 10);
        if (Number.isFinite(n) && n > maxN) { maxN = n; bestLi = li; bestN = n; }
      }
    }
    if (bestLi) {
      bestLi.click();
      report(`Set page size to ${bestN} from Kendo dropdown.`);
      await waitForGridReady(10000);
      return;
    }
  }

  report("Could not change page size — will use default page size.");
}

function makeErrorResult(ship, errorMsg) {
  return {
    shipmentId: ship.shipmentId,
    billAmount: ship.billAmount,
    vendor: ship.vendor,
    invoiceNumber: ship.invoiceNumber,
    memo: ship.memo,
    shipmentSale: null, shipmentCost: null, grossProfit: null,
    difference: null, pctDifference: null, direction: "N/A",
    matched: false, marginDollars: null, marginPct: null,
    error: errorMsg, scrapedFields: {},
  };
}

// Scroll the financial confirmation area into the viewport so captureVisibleTab
// captures Shipment Sale / Cost / Gross Profit regardless of window size.
function scrollFinancialFieldsIntoView() {
  const selectors = [
    "span:has(+ span)", // generic adjacent spans (confirmation area)
  ];
  const keywords = /shipment\s*(sale|cost)|gross\s*profit/i;

  // Strategy 1: Find the actual text labels and scroll the last one into view
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      keywords.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  let lastMatch = null;
  while (walker.nextNode()) lastMatch = walker.currentNode;
  if (lastMatch && lastMatch.parentElement) {
    lastMatch.parentElement.scrollIntoView({ behavior: "instant", block: "center" });
    return true;
  }

  // Strategy 2: Look for known container IDs / classes
  for (const id of ["ShipmentCost", "ShipmentSale", "GrossProfit"]) {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "instant", block: "center" });
      return true;
    }
  }

  // Strategy 3: Scroll the confirmation section if it exists
  const confirmEl = document.querySelector("[id*='confirmation' i], [class*='confirmation' i], [id*='bdetails'], #bdetails");
  if (confirmEl) {
    confirmEl.scrollIntoView({ behavior: "instant", block: "center" });
    return true;
  }

  return false;
}

// Quick DOM scrape for the three financial fields — free, instant, no API cost
function domScrapeFinancials() {
  const sale = scrapeShipmentSaleAmount();
  const cost = scrapeShipmentCostAmount();

  let gp = null;
  const bodyText = document.body.innerText || "";
  const gpMatch = bodyText.match(/Gross\s*Profit\s*[:\s]*\$?\s*([\d,]+\.?\d*)/i);
  if (gpMatch) {
    const val = parseFloat(gpMatch[1].replace(/,/g, ""));
    if (Number.isFinite(val)) gp = val;
  }

  return { sale, cost, gp };
}

async function invoiceScreenshotShipment(ship) {
  const result = {
    shipmentId: ship.shipmentId,
    billAmount: ship.billAmount,
    vendor: ship.vendor,
    invoiceNumber: ship.invoiceNumber,
    memo: ship.memo,
    shipmentSale: null, shipmentCost: null, grossProfit: null,
    difference: null, pctDifference: null, direction: "N/A",
    matched: false, marginDollars: null, marginPct: null,
    error: null, scrapedFields: {},
  };

  let saleAmount = null;
  let costAmount = null;
  let gpAmount = null;

  // Phase 1: Try instant DOM scrape first (free, no API cost)
  const domData = domScrapeFinancials();
  if (domData.sale !== null) saleAmount = domData.sale;
  if (domData.cost !== null) costAmount = domData.cost;
  if (domData.gp !== null) gpAmount = domData.gp;

  if (saleAmount !== null && costAmount !== null && gpAmount !== null) {
    sendInvStatus(`ShipID ${ship.shipmentId}: DOM scrape → Cost $${costAmount}, Sale $${saleAmount}, GP $${gpAmount}`);
    result.scrapedFields._method = "dom";
  } else {
    // Phase 2: Scroll financial area into view, then screenshot + vision
    sendInvStatus(`ShipID ${ship.shipmentId}: scrolling financial fields into view…`);
    scrollFinancialFieldsIntoView();
    await humanDelay(300, 600);

    sendInvStatus(`ShipID ${ship.shipmentId}: capturing screenshot…`);
    try {
      const visionResp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "invoiceScreenshotParse" }, (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(resp);
        });
      });
      if (visionResp && visionResp.data) {
        const d = visionResp.data;
        if (d.shipmentSale != null && Number.isFinite(d.shipmentSale) && saleAmount === null) saleAmount = d.shipmentSale;
        if (d.shipmentCost != null && Number.isFinite(d.shipmentCost) && costAmount === null) costAmount = d.shipmentCost;
        if (d.grossProfit != null && Number.isFinite(d.grossProfit) && gpAmount === null) gpAmount = d.grossProfit;
        sendInvStatus(
          `ShipID ${ship.shipmentId}: vision → Cost $${costAmount ?? "N/A"}, Sale $${saleAmount ?? "N/A"}, GP $${gpAmount ?? "N/A"}`
        );
        result.scrapedFields._visionUsed = true;
        result.scrapedFields._visionRaw = visionResp.raw;
      } else {
        sendInvStatus(`ShipID ${ship.shipmentId}: vision parse failed — ${visionResp?.error || "unknown"}`);
      }
    } catch (e) {
      sendInvStatus(`ShipID ${ship.shipmentId}: screenshot error — ${e.message}`);
    }
    result.scrapedFields._method = saleAmount !== null || costAmount !== null ? "dom+vision" : "vision";
  }

  result.shipmentSale = saleAmount;
  result.shipmentCost = costAmount;
  result.grossProfit = gpAmount;

  // PRIMARY COMPARISON: Bill Amount [CI] vs Shipment Cost [FPX]
  if (costAmount !== null) {
    result.difference = +(ship.billAmount - costAmount).toFixed(2);
    result.pctDifference = costAmount !== 0 ? +((result.difference / costAmount) * 100).toFixed(2) : 0;
    result.direction = result.difference > 0.01 ? "OVER" : result.difference < -0.01 ? "UNDER" : "MATCH";
    result.matched = Math.abs(result.difference) <= 0.01;
  } else {
    result.error = "Shipment Cost not found on detail page";
  }

  // Margin: Sale minus Cost
  if (saleAmount !== null && costAmount !== null) {
    result.marginDollars = +(saleAmount - costAmount).toFixed(2);
    result.marginPct = saleAmount !== 0 ? +((result.marginDollars / saleAmount) * 100).toFixed(2) : 0;
  }

  sendInvStatus(
    `ShipID ${ship.shipmentId}: Bill $${ship.billAmount.toFixed(2)} vs FPX Cost $${costAmount != null ? costAmount.toFixed(2) : "N/A"} — ${result.direction}` +
    (result.matched ? "" : result.difference != null ? ` ($${result.difference.toFixed(2)})` : "")
  );

  return result;
}

async function invoiceCloseModal(shipmentId) {
  // Strategy 1: Click Back / Close / Return button visible on the detail view
  const candidates = document.querySelectorAll("a, button, input[type='button'], .btn");
  for (const el of candidates) {
    const txt = (el.textContent || el.value || "").replace(/\s+/g, " ").trim();
    if (/^(back|close|return|cancel|go\s*back|back\s*to\s*list|×|✕)/i.test(txt) && isVisibleForClick(el)) {
      el.click();
      await waitForGridWithObserver(5000);
      return;
    }
  }

  // Strategy 2: Click the Transactions breadcrumb / link
  const links = document.querySelectorAll("a[href*='Transactions'], .breadcrumb a, .nav a");
  for (const a of links) {
    if (/transaction/i.test(a.textContent || "")) {
      a.click();
      await waitForGridWithObserver(5000);
      return;
    }
  }

  // Strategy 3: Browser back
  sendInvStatus(`ShipID ${shipmentId}: using browser back to close detail…`);
  history.back();
  await waitForGridWithObserver(5000);
}

function invoiceMatchFromGrid(ship, gridMap) {
  const result = {
    shipmentId: ship.shipmentId,
    billAmount: ship.billAmount,
    vendor: ship.vendor,
    invoiceNumber: ship.invoiceNumber,
    memo: ship.memo,
    shipmentSale: null,
    shipmentCost: null,
    grossProfit: null,
    difference: null,
    pctDifference: null,
    direction: "N/A",
    matched: false,
    marginDollars: null,
    marginPct: null,
    error: null,
    scrapedFields: {},
  };

  const gridRow = gridMap.get(String(ship.shipmentId));
  if (!gridRow) {
    result.error = "Shipment not found in grid data";
    return result;
  }

  // FPX Grid fields:
  //   "Shipment Marked-Up Rate"       = Sale (what customer was charged)
  //   "Shipment Rate without mark up"  = Cost (what FreightPOP pays carrier)
  //   "Shipment Gross Profit"          = Sale - Cost
  const saleRaw = gridRow["Shipment Marked-Up Rate"];
  const costRaw = gridRow["Shipment Rate without mark up"];
  const gpRaw = gridRow["Shipment Gross Profit"];

  const saleAmount = saleRaw != null ? parseFloat(String(saleRaw).replace(/[$,]/g, "")) : null;
  const costAmount = costRaw != null ? parseFloat(String(costRaw).replace(/[$,]/g, "")) : null;
  const gpAmount = gpRaw != null ? parseFloat(String(gpRaw).replace(/[$,]/g, "")) : null;

  result.shipmentSale = Number.isFinite(saleAmount) ? saleAmount : null;
  result.shipmentCost = Number.isFinite(costAmount) ? costAmount : null;
  result.grossProfit = Number.isFinite(gpAmount) ? gpAmount : null;

  // Copy all grid fields for reference
  for (const [k, v] of Object.entries(gridRow)) {
    if (!k.startsWith("_")) result.scrapedFields[k] = v;
  }

  // PRIMARY COMPARISON: Bill Amount (carrier invoice) vs Shipment Cost (FPX recorded cost)
  if (result.shipmentCost !== null) {
    result.difference = +(ship.billAmount - result.shipmentCost).toFixed(2);
    result.pctDifference = result.shipmentCost !== 0 ? +((result.difference / result.shipmentCost) * 100).toFixed(2) : 0;
    result.direction = result.difference > 0.01 ? "OVER" : result.difference < -0.01 ? "UNDER" : "MATCH";
    result.matched = Math.abs(result.difference) <= 0.01;
  } else {
    result.error = "Shipment Cost not available in grid data";
  }

  // Margin: Sale minus Cost (FreightPOP's profit on this shipment)
  if (result.shipmentSale !== null && result.shipmentCost !== null) {
    result.marginDollars = +(result.shipmentSale - result.shipmentCost).toFixed(2);
    result.marginPct = result.shipmentSale !== 0
      ? +((result.marginDollars / result.shipmentSale) * 100).toFixed(2) : 0;
  }

  return result;
}

// Drives Transactions → Generate History Report → CONTINUE and waits for the
// results grid. Shared by the invoice audit (4 arguments, unchanged) and the
// ERP audit pull, which passes `opts`:
//   status(text) / fail(text)  where progress and the failure reason go
//   openDialog                 click "Generate History Report" if the dialog isn't already open
//   beforeContinue()           runs once the dates and customer are set; return a string to abort with it
//   gridWaitSec                how long to wait for the results grid (default 15)
//   onGridWait(sec)            called about once a second while waiting
//   stoppable                  give up waiting when a stop is requested
async function invoiceGenerateReport(fromDate, toDate, shipmentType, customerFilter, opts = {}) {
  const status = opts.status || sendInvStatus;
  const fail = opts.fail || sendInvComplete;
  const currentUrl = window.location.href;
  const onTransactions = currentUrl.includes("Transactions");
  if (!onTransactions) {
    status("Navigating to Transactions page...");
    window.location.hash = "#!/Transactions";
    await humanDelay(2500, 4000);
  } else {
    status("Already on Transactions page.");
  }

  status("Waiting for Generate History Report dialog...");
  let dialogFound = false;
  for (let wait = 0; wait < 20000; wait += 500) {
    const allText = document.body.innerText.toUpperCase();
    if (allText.includes("GENERATE HISTORY REPORT") || allText.includes("GENERATE REPORT")) {
      dialogFound = true;
      break;
    }
    const btn = document.querySelector("button.generate-report, [ng-click*='generate'], a.btn");
    if (btn && /generate report/i.test(btn.textContent)) {
      simulateClick(btn);
      await humanDelay(1200, 2000);
    }
    await humanDelay(400, 700);
  }

  if (!dialogFound) {
    status("Looking for Generate Report button...");
    const allBtns = document.querySelectorAll("button, a.btn, input[type='button']");
    for (const b of allBtns) {
      if (/generate\s*report/i.test(b.textContent || b.value || "")) {
        simulateClick(b);
        await humanDelay(1500, 2500);
        break;
      }
    }
  }

  await humanDelay(800, 1500);

  const dateLabel = fromDate === toDate ? fromDate : `${fromDate} — ${toDate}`;
  status("Filling date fields: " + dateLabel + "...");

  let dateFields = findDateInputs();
  if (opts.openDialog && !dateFields.from && !dateFields.to) {
    // The dialog did not open by itself: press the page's own button for it.
    const openers = document.querySelectorAll("button, a, input[type='button'], [role='button']");
    for (const b of openers) {
      if (!isVisibleForClick(b)) continue;
      const txt = (b.textContent || b.value || "").replace(/\s+/g, " ").trim();
      if (/^generate\s+(history\s+)?report$/i.test(txt)) { simulateClick(b); break; }
    }
    for (let wait = 0; wait < 10 && !dateFields.from && !dateFields.to; wait++) {
      await humanDelay(800, 1200);
      dateFields = findDateInputs();
    }
  }
  if (!dateFields.from && !dateFields.to) {
    fail("Failed — no date inputs found.");
    return false;
  }

  if (dateFields.from) {
    setDateInput(dateFields.from, fromDate);
    status("Set FROM DATE to " + fromDate);
  }
  await humanDelay(400, 800);

  if (dateFields.to) {
    setDateInput(dateFields.to, toDate);
    status("Set TO DATE to " + toDate);
  }
  await humanDelay(400, 800);

  function retryDateFill(input, label, dateStr) {
    if (!input || input.value) return;
    const parts = dateStr.split("/");
    const isoVal = `${parts[2]}-${parts[0]}-${parts[1]}`;
    const valForType = input.type === "date" ? isoVal : dateStr;
    try {
      const scope = window.angular && window.angular.element(input).scope();
      if (scope) {
        const modelAttr = input.getAttribute("ng-model") || input.getAttribute("data-ng-model");
        if (modelAttr) {
          const keys = modelAttr.split(".");
          let target = scope;
          for (let k = 0; k < keys.length - 1; k++) target = target[keys[k]];
          target[keys[keys.length - 1]] = valForType;
          scope.$apply();
        }
      }
    } catch {}
    input.value = valForType;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  retryDateFill(dateFields.from, "FROM DATE", fromDate);
  retryDateFill(dateFields.to, "TO DATE", toDate);
  await humanDelay(400, 800);

  const custTarget = customerFilter || "";
  const useAllCustomers = !custTarget || /^all(\s*customers)?$/i.test(custTarget);

  status(useAllCustomers ? "Setting All Customers..." : `Setting customer to "${custTarget}"...`);
  const selects = document.querySelectorAll("select");
  for (const sel of selects) {
    const row = sel.closest("tr, div, .form-group");
    const rowText = row ? row.textContent.toUpperCase() : "";
    const name = (sel.name || "").toLowerCase();
    const id = (sel.id || "").toLowerCase();

    if (rowText.includes("CUSTOMER") || name.includes("customer") || id.includes("customer")) {
      if (useAllCustomers) {
        for (const opt of sel.options) {
          if (/all\s*customers/i.test(opt.text)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            break;
          }
        }
      } else {
        const needle = custTarget.toLowerCase();
        let matched = false;
        for (const opt of sel.options) {
          if (opt.text.toLowerCase().includes(needle) || opt.value === custTarget) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (const opt of sel.options) {
            if (/all\s*customers/i.test(opt.text)) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              break;
            }
          }
        }
      }

      try {
        const kendoWidget = window.jQuery && window.jQuery(sel).data("kendoDropDownList");
        if (kendoWidget) {
          const ds = kendoWidget.dataSource.data();
          const pat = useAllCustomers ? /all\s*customers/i : new RegExp(custTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          for (let k = 0; k < ds.length; k++) {
            const txt = ds[k].text || ds[k].Text || ds[k].Name || "";
            if (pat.test(txt)) {
              kendoWidget.select(k);
              kendoWidget.trigger("change");
              break;
            }
          }
        }
      } catch {}
      break;
    }
  }
  await humanDelay(400, 800);

  if (opts.beforeContinue) {
    const abort = await opts.beforeContinue(dateFields);
    if (abort) { fail(abort); return false; }
  }

  status("Clicking CONTINUE...");
  let continueClicked = false;
  const buttons = document.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn, .btn");
  for (const btn of buttons) {
    const txt = (btn.textContent || btn.value || "").replace(/\s+/g, " ").trim().toUpperCase();
    if (txt === "CONTINUE" || txt === "GENERATE" || txt === "SUBMIT") {
      simulateClick(btn);
      continueClicked = true;
      break;
    }
  }

  if (!continueClicked) {
    fail("ERROR: Could not find CONTINUE button.");
    return false;
  }

  status("Waiting for results grid to load...");
  await humanDelay(2500, 4000);

  let gridReady = false;
  const gridWaitMs = (opts.gridWaitSec || 15) * 1000;
  for (let wait = 0; wait < gridWaitMs; wait += 1000) {
    if (opts.stoppable && stopRequested) return false;
    if (opts.onGridWait) opts.onGridWait(wait / 1000);
    const gridRows = document.querySelectorAll(".k-grid-content tbody tr, .k-grid tbody tr");
    const visibleRows = [...gridRows].filter(
      (r) => !r.classList.contains("k-no-data") && !r.classList.contains("k-grouping-row")
    );
    if (visibleRows.length > 0) { gridReady = true; break; }
    await humanDelay(800, 1300);
  }

  if (!gridReady) {
    fail("No grid data loaded. Report may not have generated.");
    return false;
  }

  const typeToClick = shipmentType || "non-parcel";
  if (typeToClick !== "all") {
    status("Selecting " + (typeToClick === "parcel" ? "Parcel" : "Non-Parcel") + " tab...");
    clickShipmentTypeTab(typeToClick);
    await humanDelay(1500, 2500);
    await waitForGridReady(5000);
  }

  status("Report generated. Ready to process shipments.");
  return true;
}

async function filterGridByShipmentId(shipmentId) {
  sendInvStatus(`Filtering grid for ShipmentID ${shipmentId}...`);

  const headerCells = document.querySelectorAll(".k-grid th");
  let targetHeader = null;
  for (const cell of headerCells) {
    const link = cell.querySelector("a.k-link");
    const text = link ? link.textContent.trim() : cell.textContent.trim();
    if (/shipment\s*id/i.test(text) || text === "ShipmentID") {
      targetHeader = cell;
      break;
    }
  }

  if (!targetHeader) {
    sendInvStatus("ShipmentID column header not found. Trying Kendo API...");
    return await filterGridViaKendoApi(shipmentId);
  }

  const filterIcon =
    targetHeader.querySelector("a.k-grid-filter") ||
    targetHeader.querySelector("a.k-grid-filter-menu") ||
    targetHeader.querySelector(".k-grid-filter") ||
    targetHeader.querySelector("[data-role='columnmenu']");

  if (!filterIcon) {
    sendInvStatus("ShipmentID filter icon not found. Trying Kendo API...");
    return await filterGridViaKendoApi(shipmentId);
  }

  filterIcon.click();
  await humanDelay(600, 1000);

  let filterPopup = null;
  const containers = document.querySelectorAll(".k-animation-container, .k-filter-menu, .k-column-menu");
  for (const c of containers) {
    if (c.offsetParent !== null || c.style.display !== "none") {
      const hasFilterBtn = Array.from(c.querySelectorAll("button")).some(
        (b) => b.textContent.trim() === "Filter"
      );
      if (hasFilterBtn) { filterPopup = c; break; }
    }
  }

  if (!filterPopup) {
    sendInvStatus("Filter popup did not open. Trying Kendo API...");
    return await filterGridViaKendoApi(shipmentId);
  }

  const selects = filterPopup.querySelectorAll("select");
  const kendoDropdowns = filterPopup.querySelectorAll("span.k-dropdown, span.k-widget.k-dropdown, [data-role='dropdownlist']");

  if (selects.length >= 1) {
    const opSelect = selects[0];
    if (opSelect.value !== "eq") {
      opSelect.value = "eq";
      opSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await humanDelay(200, 500);
    }
  } else if (kendoDropdowns.length >= 1) {
    const opDd = kendoDropdowns[0];
    if (!opDd.textContent.includes("Is equal to")) {
      (opDd.querySelector(".k-dropdown-wrap, .k-input") || opDd).click();
      await humanDelay(400, 700);
      for (const item of document.querySelectorAll(".k-animation-container .k-list .k-item, .k-popup .k-item")) {
        if (item.textContent.trim() === "Is equal to") { item.click(); break; }
      }
      await humanDelay(300, 600);
    }
  }

  const textInput = filterPopup.querySelector('input[type="text"], input.k-textbox, input:not([type="hidden"]):not([type="checkbox"])');
  if (textInput) {
    textInput.focus();
    textInput.value = shipmentId;
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
    textInput.dispatchEvent(new Event("change", { bubbles: true }));
    await humanDelay(200, 500);
  }

  for (const btn of filterPopup.querySelectorAll("button")) {
    if (btn.textContent.trim() === "Filter") { btn.click(); break; }
  }

  await humanDelay(1500, 2500);
  await waitForGridReady(5000);
  return true;
}

async function filterGridViaKendoApi(shipmentId) {
  try {
    const grids = document.querySelectorAll("[data-role='grid'], .k-grid");
    for (const gridEl of grids) {
      const kGrid = window.jQuery && window.jQuery(gridEl).data("kendoGrid");
      if (!kGrid) continue;
      kGrid.dataSource.filter({
        field: "ShipmentID",
        operator: "eq",
        value: shipmentId,
      });
      await humanDelay(1500, 2500);
      await waitForGridReady(5000);
      return true;
    }
  } catch (e) {
    sendInvStatus("Kendo API filter failed: " + e.message);
  }
  return false;
}

async function clearShipmentIdFilter() {
  try {
    const grids = document.querySelectorAll("[data-role='grid'], .k-grid");
    for (const gridEl of grids) {
      const kGrid = window.jQuery && window.jQuery(gridEl).data("kendoGrid");
      if (!kGrid) continue;
      kGrid.dataSource.filter({});
      await humanDelay(1200, 2000);
      await waitForGridReady(3000);
      return true;
    }
  } catch (e) {
    sendInvStatus("Clear filter failed: " + e.message);
  }

  const headerCells = document.querySelectorAll(".k-grid th");
  for (const cell of headerCells) {
    const link = cell.querySelector("a.k-link");
    const text = link ? link.textContent.trim() : cell.textContent.trim();
    if (/shipment\s*id/i.test(text) || text === "ShipmentID") {
      const filterIcon = cell.querySelector("a.k-grid-filter") || cell.querySelector(".k-grid-filter");
      if (filterIcon) {
        filterIcon.click();
        await humanDelay(600, 1000);
        const containers = document.querySelectorAll(".k-animation-container, .k-filter-menu");
        for (const c of containers) {
          if (c.offsetParent === null && c.style.display === "none") continue;
          for (const btn of c.querySelectorAll("button")) {
            if (btn.textContent.trim() === "Clear") { btn.click(); break; }
          }
        }
        await humanDelay(1200, 2000);
      }
      break;
    }
  }

  return true;
}

function parseMoneyText(el) {
  if (!el) return null;
  const raw = (el.textContent || el.value || "").replace(/[$,\s]/g, "");
  const val = parseFloat(raw);
  return Number.isFinite(val) ? val : null;
}

function scrapeShipmentSaleAmount() {
  const byId = document.getElementById("ShipmentSale");
  if (byId) {
    const val = parseMoneyText(byId);
    if (val !== null) { dlog("[FPX-INV] #ShipmentSale by ID:", val); return val; }
  }

  const allWindows = document.querySelectorAll(".k-window, .modal, [role='dialog']");
  for (const modal of allWindows) {
    const text = modal.innerText || "";
    const m = text.match(/Shipment\s*Sale[s]?\s*[:\s]*\$?\s*([\d,]+\.?\d*)/i);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(val)) { dlog("[FPX-INV] ShipmentSale from modal text:", val); return val; }
    }
  }

  const bodyText = document.body.innerText || "";
  const m2 = bodyText.match(/Shipment\s*Sale[s]?\s*[:\s]*\$?\s*([\d,]+\.?\d*)/i);
  if (m2) {
    const val = parseFloat(m2[1].replace(/,/g, ""));
    if (Number.isFinite(val)) { dlog("[FPX-INV] ShipmentSale from body text:", val); return val; }
  }

  dlog("[FPX-INV] ShipmentSale NOT found. #ShipmentSale el:", byId, "modals found:", allWindows.length);
  return null;
}

function scrapeShipmentCostAmount() {
  const byId = document.getElementById("ShipmentCost");
  if (byId) {
    const val = parseMoneyText(byId);
    if (val !== null) { dlog("[FPX-INV] #ShipmentCost by ID:", val); return val; }
  }

  const allWindows = document.querySelectorAll(".k-window, .modal, [role='dialog']");
  for (const modal of allWindows) {
    const text = modal.innerText || "";
    const m = text.match(/Shipment\s*Cost\s*[:\s]*\$?\s*([\d,]+\.?\d*)/i);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(val)) { dlog("[FPX-INV] ShipmentCost from modal text:", val); return val; }
    }
  }

  return null;
}

async function invoiceProcessShipment(ship, idx, total) {
  const result = {
    shipmentId: ship.shipmentId,
    billAmount: ship.billAmount,
    vendor: ship.vendor,
    invoiceNumber: ship.invoiceNumber,
    memo: ship.memo,
    shipmentSale: null,
    shipmentCost: null,
    grossProfit: null,
    difference: null,
    pctDifference: null,
    direction: "N/A",
    matched: false,
    marginDollars: null,
    marginPct: null,
    error: null,
    scrapedFields: {},
  };

  try {
    const filtered = await filterGridByShipmentId(ship.shipmentId);
    if (!filtered) {
      result.error = "Could not filter grid";
      await clearShipmentIdFilter();
      return result;
    }

    const gridRows = document.querySelectorAll(".k-grid-content tbody tr, .k-grid tbody tr");
    const dataRows = [...gridRows].filter(
      (r) => !r.classList.contains("k-no-data") && !r.classList.contains("k-grouping-row")
    );

    if (dataRows.length === 0) {
      result.error = "No grid rows after filter — shipment not found in report";
      sendInvStatus(`ShipID ${ship.shipmentId}: not found in report.`);
      await clearShipmentIdFilter();
      return result;
    }

    sendInvStatus(`ShipID ${ship.shipmentId}: found ${dataRows.length} row(s). Opening View Shipment...`);

    // --- Click "View Shipment" ---
    let viewClicked = false;

    const allClickables = document.querySelectorAll(
      ".k-grid-content a, .k-grid-content button, .k-grid-content input[type='button'], " +
      ".k-grid a, .k-grid button, .k-grid input[type='button']"
    );
    for (const el of allClickables) {
      const txt = (el.textContent || el.value || "").replace(/\s+/g, " ").trim();
      if (/view\s*shipment/i.test(txt) && isVisibleForClick(el)) {
        sendInvStatus(`ShipID ${ship.shipmentId}: clicking "${txt}"...`);
        el.click();
        viewClicked = true;
        break;
      }
    }

    if (!viewClicked) {
      for (const row of dataRows) {
        const btns = row.querySelectorAll("a, button, input[type='button']");
        for (const btn of btns) {
          const txt = (btn.textContent || btn.value || "").replace(/\s+/g, " ").trim();
          if (/view\s*shipment/i.test(txt)) {
            btn.click();
            viewClicked = true;
            break;
          }
        }
        if (viewClicked) break;
      }
    }

    if (!viewClicked) {
      for (const row of dataRows) {
        const firstLink = row.querySelector("a");
        if (firstLink) {
          sendInvStatus(`ShipID ${ship.shipmentId}: fallback — clicking first link in row.`);
          firstLink.click();
          viewClicked = true;
          break;
        }
      }
    }

    if (!viewClicked) {
      result.error = "Could not find View Shipment link";
      await clearShipmentIdFilter();
      return result;
    }

    sendInvStatus(`ShipID ${ship.shipmentId}: waiting for detail view to render…`);
    await humanDelay(2000, 3500);

    // --- Extract financials (DOM first, then vision fallback) ---
    let saleAmount = null;
    let costAmount = null;
    let gpAmount = null;

    const domData = domScrapeFinancials();
    if (domData.sale !== null) saleAmount = domData.sale;
    if (domData.cost !== null) costAmount = domData.cost;
    if (domData.gp !== null) gpAmount = domData.gp;

    if (saleAmount !== null && costAmount !== null && gpAmount !== null) {
      sendInvStatus(`ShipID ${ship.shipmentId}: DOM scrape → Cost $${costAmount}, Sale $${saleAmount}, GP $${gpAmount}`);
      result.scrapedFields._method = "dom";
    } else {
      scrollFinancialFieldsIntoView();
      await humanDelay(300, 600);
      sendInvStatus(`ShipID ${ship.shipmentId}: capturing screenshot…`);
      try {
        const visionResp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "invoiceScreenshotParse" }, (resp) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(resp);
          });
        });
        if (visionResp && visionResp.data) {
          const d = visionResp.data;
          if (d.shipmentSale != null && Number.isFinite(d.shipmentSale) && saleAmount === null) saleAmount = d.shipmentSale;
          if (d.shipmentCost != null && Number.isFinite(d.shipmentCost) && costAmount === null) costAmount = d.shipmentCost;
          if (d.grossProfit != null && Number.isFinite(d.grossProfit) && gpAmount === null) gpAmount = d.grossProfit;
          sendInvStatus(
            `ShipID ${ship.shipmentId}: vision → Sale $${saleAmount ?? "N/A"}, Cost $${costAmount ?? "N/A"}, GP $${gpAmount ?? "N/A"}`
          );
          result.scrapedFields._visionUsed = true;
          result.scrapedFields._visionRaw = visionResp.raw;
        } else {
          sendInvStatus(`ShipID ${ship.shipmentId}: vision parse failed — ${visionResp?.error || "unknown"}`);
        }
      } catch (e) {
        sendInvStatus(`ShipID ${ship.shipmentId}: screenshot error — ${e.message}`);
      }
      result.scrapedFields._method = saleAmount !== null || costAmount !== null ? "dom+vision" : "vision";
    }

    result.shipmentSale = saleAmount;
    result.shipmentCost = costAmount;
    result.grossProfit = gpAmount;

    // Scrape additional fields from the detail section
    for (const containerId of ["bdetails", "details", "shipmentDetails"]) {
      const container = document.getElementById(containerId);
      if (!container) continue;
      const labels = container.querySelectorAll("label span, label, .control-label");
      for (const lbl of labels) {
        const key = lbl.textContent.trim().replace(/:$/, "");
        if (!key) continue;
        const parent = lbl.closest(".row, .form-group, .col-md-12, .col-sm-12");
        if (!parent) continue;
        const valEl = parent.querySelector("span[id], input[readonly], .form-control-static, p");
        if (valEl && valEl !== lbl) {
          const val = (valEl.value || valEl.textContent || "").trim();
          if (val) result.scrapedFields[key] = val;
        }
      }
    }

    // --- PRIMARY COMPARISON: Bill Amount [CI] vs Shipment Cost [FPX] ---
    if (costAmount !== null) {
      result.difference = +(ship.billAmount - costAmount).toFixed(2);
      result.pctDifference = costAmount !== 0 ? +((result.difference / costAmount) * 100).toFixed(2) : 0;
      result.direction = result.difference > 0.01 ? "OVER" : result.difference < -0.01 ? "UNDER" : "MATCH";
      result.matched = Math.abs(result.difference) <= 0.01;
    } else {
      result.error = "Shipment Cost not found on detail page";
    }

    // Margin: Sale minus Cost
    if (saleAmount !== null && costAmount !== null) {
      result.marginDollars = +(saleAmount - costAmount).toFixed(2);
      result.marginPct = saleAmount !== 0 ? +((result.marginDollars / saleAmount) * 100).toFixed(2) : 0;
    }

    setTimeout(() => {
      const s = ship.shipmentId;
      if (costAmount !== null) {
        sendInvStatus(
          `ShipID ${s}: Bill $${ship.billAmount.toFixed(2)} vs FPX Cost $${costAmount.toFixed(2)} — ${result.direction}` +
          (result.matched ? "" : ` ($${result.difference.toFixed(2)})`) +
          (saleAmount !== null ? ` | Sale $${saleAmount.toFixed(2)}` : "") +
          (result.grossProfit !== null ? ` | GP $${result.grossProfit.toFixed(2)}` : "")
        );
      } else {
        sendInvStatus(`ShipID ${s}: could not read Shipment Cost from detail page.`);
      }
    }, 0);

    // --- Navigate back to the grid ---
    await invoiceReturnToGrid(ship.shipmentId);

    await clearShipmentIdFilter();

  } catch (e) {
    result.error = e.message;
    sendInvStatus(`ShipID ${ship.shipmentId}: error — ${e.message}`);
    try { await invoiceReturnToGrid(ship.shipmentId); } catch {}
    try { await clearShipmentIdFilter(); } catch {}
  }

  return result;
}

async function invoiceReturnToGrid(shipmentId) {
  // Strategy 1: Look for a Back / Close / Return button
  const candidates = document.querySelectorAll(
    "a, button, input[type='button'], .btn"
  );
  for (const el of candidates) {
    const txt = (el.textContent || el.value || "").replace(/\s+/g, " ").trim();
    if (/^(back|close|return|cancel|go\s*back|back\s*to\s*list)/i.test(txt) && isVisibleForClick(el)) {
      sendInvStatus(`ShipID ${shipmentId}: clicking "${txt}" to return to grid...`);
      el.click();
      // Was: sleep(2000). Now: observer fires as soon as grid rows appear in the DOM.
      const gridBack = await waitForGridWithObserver(8000);
      if (gridBack) return;
    }
  }

  // Strategy 2: Click the Transactions hash link / breadcrumb
  const links = document.querySelectorAll("a[href*='Transactions'], .breadcrumb a, .nav a");
  for (const a of links) {
    if (/transaction/i.test(a.textContent || "")) {
      sendInvStatus(`ShipID ${shipmentId}: clicking Transactions link...`);
      a.click();
      // Was: sleep(2500). Now: observer-based wait.
      const gridBack = await waitForGridWithObserver(8000);
      if (gridBack) return;
    }
  }

  // Strategy 3: Hash navigation
  sendInvStatus(`ShipID ${shipmentId}: hash-navigating back to Transactions...`);
  window.location.hash = "#!/Transactions";
  // Was: sleep(3000) + 1s-polling loop up to 15s. Now: single observer wait.
  const gridBack = await waitForGridWithObserver(10000);
  if (gridBack) return;

  sendInvStatus(`ShipID ${shipmentId}: grid may not have reloaded — proceeding.`);
}

async function invoiceFinalize(results, skippedRows, dateLabel, aiLevel) {
  const discrepancies = results.filter((r) => !r.matched && r.shipmentCost !== null);
  const matches = results.filter((r) => r.matched);
  const errors = results.filter((r) => r.error);
  const totalVariance = discrepancies.reduce((sum, r) => sum + (r.difference || 0), 0);

  sendInvStatus(`${discrepancies.length} discrepancy(ies), ${matches.length} match(es), ${errors.length} error(s).`);

  try {
    chrome.runtime.sendMessage({
      type: "invoiceAuditDiscrepancies",
      discrepancies: discrepancies.map((d) => ({
        shipmentId: d.shipmentId,
        vendor: d.vendor,
        billAmount: d.billAmount,
        shipmentSale: d.shipmentSale,
        shipmentCost: d.shipmentCost,
        difference: d.difference,
        direction: d.direction,
      })),
    });
  } catch {}

  // Invoice audit AI moved to the dashboard server. The extension scrapes +
  // uploads only; analysis runs in the background after POST /api/audits/invoice.

  // Upload the audit run + rows to the dashboard server. AI runs in the
  // background per `ai_level` — no extension-side Claude calls anymore.
  try {
    const runPayload = {
      run: {
        shipment_type: null, // not currently captured by invoiceAuditRun
        total_rows: results.length,
        match_count: matches.length,
        discrepancy_count: discrepancies.length,
        unmatched_count: errors.length,
      },
      rows: results.map((r) => ({
        shipment_id: String(r.shipmentId || ""),
        carrier: r.vendor || null,
        customer_name: r.customerName || null,
        bill_amount: typeof r.billAmount === "number" ? r.billAmount : null,
        shipment_cost: typeof r.shipmentCost === "number" ? r.shipmentCost : null,
        difference: typeof r.difference === "number" ? r.difference : null,
        status: r.error ? "error" : (r.matched ? "match" : (r.shipmentCost == null ? "error" : "discrepancy")),
        raw: {
          invoiceNumber: r.invoiceNumber,
          shipmentSale: r.shipmentSale,
          grossProfit: r.grossProfit,
          pctDifference: r.pctDifference,
          direction: r.direction,
          marginDollars: r.marginDollars,
          marginPct: r.marginPct,
          memo: r.memo,
          error: r.error,
        },
      })),
      ai_level: aiLevel,
    };
    sendInvStatus("Uploading audit run to dashboard...");
    const resp = await chrome.runtime.sendMessage({ type: "uploadInvoiceAudit", payload: runPayload });
    if (resp && resp.ok) {
      sendInvStatus(`Uploaded ${resp.row_count || results.length} row(s). Analysis runs in the dashboard.`);
    } else if (resp && resp.error) {
      console.warn("[FPX-INV] Upload failed:", resp.error);
      sendInvStatus("Upload failed: " + resp.error);
    }
  } catch (e) {
    console.warn("[FPX-INV] Upload threw:", e.message);
  }

  sendInvComplete(
    `Invoice Audit done — ${results.length} shipment(s), ${discrepancies.length} discrepancy(ies), ${matches.length} match(es), ${errors.length} error(s).`
  );
}

// =====================================================================
// ERP AUDIT PULL (hosted browser job)
//
// Transactions → Generate History Report for the last N months, all
// customers, all carriers → read both result tabs (Non-Parcel + Parcel) →
// keep the rows whose "Exported to ERP" is false → upload them for an
// invoice audit (POST /api/audits/invoice/from-history via the background).
//
// Started by the browser service with erpAuditPull(months, runBy); it polls
// fpxErpPoll() for log lines and the outcome. Every wait has a limit and
// every failure ends the run with a sentence that names the step.
// Pause: every step passes erpCheckpoint() / humanDelay(), which hold while
// self.__fpxPaused is set. Stop: `stopRequested`, as for a scrape.
// =====================================================================
let fpxErp = null; // { lines: [{ level, text }], counts, done: null | { ok, note, result, stopped } }

const ERP_UPLOAD_MAX_BYTES = 12 * 1024 * 1024; // per POST; the API's limit is 20 MB

function fpxErpPoll() {
  if (!fpxErp) return { started: false };
  return {
    started: true, lines: fpxErp.lines.splice(0), counts: fpxErp.counts, done: fpxErp.done,
    upload: fpxErp.outbox ? { rows: fpxErp.outbox.rows.length } : null,
    download: fpxErp.wantDownload || null,
    // Get-invoices job only: finished shipments (emptied when read, like
    // `lines`) and a request to pause the job ({ id, text }).
    job: fpxErp.job || "erp_audit",
    // Approval check only: "history" once Recently Approved is dealt with.
    phase: fpxErp.phase || null,
    results: fpxErp.results ? fpxErp.results.splice(0) : [],
    pause: fpxErp.wantPause || null,
  };
}

// ── FreightPOP's own Excel export ──
// The browser service captures the file: it sees `download` in the poll,
// points Chromium's downloads at a folder, calls fpxErpClickExport(), reads
// the .xlsx and answers with fpxErpDownloadDone().
function erpExportCandidates() {
  // The approval check has its own, narrower search (see apExportCandidates).
  if (fpxErp && fpxErp.job === "approval_check") return apExportCandidates();
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button], .k-button, .k-grid-excel, [ng-click], [data-ng-click], i, span, img")) {
    const target = el.closest("a, button, [role=button], .k-button, [ng-click], [data-ng-click]") || el;
    if (seen.has(target) || !isVisibleForClick(target)) continue;
    const text = (target.textContent || target.value || "").replace(/\s+/g, " ").trim();
    if (text.length > 60) continue;
    const hay = [text, target.title, target.getAttribute("aria-label"), target.getAttribute("data-original-title"),
      target.getAttribute("uib-tooltip"), target.getAttribute("tooltip"), target.className && String(target.className),
      target.getAttribute("ng-click"), target.getAttribute("data-ng-click"), target.id, el.className && String(el.className), el.getAttribute("src"), el.getAttribute("alt"), el.title,
    ].filter(Boolean).join(" | ").toLowerCase();
    // Never click anything that could act on shipments: "Export to ERP"
    // style buttons push data out of FreightPOP. Only a button that says
    // Excel, or a bare Export / Download, is a file export.
    if (/\berp\b|quickbooks|netsuite|accounting|invoice|send|e-?mail|\bedi\b|delete|void|cancel|approve|import|upload|template|pdf|print/.test(hay)) continue;
    let score = 0;
    if (/k-grid-excel/.test(hay)) score += 10;
    if (/excel|xlsx?\b|\.xls/.test(hay)) score += 8;
    if (/^(export|download)( (data|report|results|all|to file))?$/i.test(text)) score += 5;
    if (score <= 0) continue;
    seen.add(target);
    out.push({ el: target, score, desc: (text || target.title || target.getAttribute("aria-label") || String(target.className || target.tagName)).slice(0, 60) });
  }
  return out.sort((a, b) => b.score - a.score);
}
function fpxErpClickExport() {
  const c = erpExportCandidates();
  if (!c.length) {
    const near = [...document.querySelectorAll("a, button, .k-button")].filter(isVisibleForClick)
      .map((e) => (e.textContent || e.title || "").replace(/\s+/g, " ").trim()).filter((t) => t && t.length < 40);
    return JSON.stringify({ error: "No Excel / Export button found on the report", buttons: [...new Set(near)].slice(0, 40) });
  }
  simulateClick(c[0].el);
  return JSON.stringify({ clicked: c[0].desc, others: c.slice(1, 5).map((x) => x.desc) });
}
function fpxErpDownloadDone(resp) {
  if (!fpxErp) return "no job";
  fpxErp.wantDownload = null;
  fpxErp.downloadResult = resp || { ok: false, error: "empty answer" };
  return "ok";
}
// Ask the browser service to capture the export for the tab on screen.
async function erpHandOffDownload(label) {
  fpxErp.downloadResult = null;
  fpxErp.wantDownload = { label };
  const until = Date.now() + 4 * 60 * 1000;
  while (Date.now() < until) {
    if (fpxErp.downloadResult) { const r = fpxErp.downloadResult; fpxErp.downloadResult = null; return r; }
    if (stopRequested) { fpxErp.wantDownload = null; return { ok: false, error: "stopped" }; }
    await new Promise((r) => setTimeout(r, 300));
  }
  fpxErp.wantDownload = null;
  return { ok: false, error: "no answer from the browser service after 4 min" };
}

// The upload itself is done by the browser service, not from this page: it
// collects the waiting body in slices with these, posts it to the API with
// its own key, and hands the answer back. (Sending it through the extension's
// background script failed with "message port closed".)
function fpxErpTakeMeta() {
  if (!fpxErp || !fpxErp.outbox) return "null";
  const { rows, ...meta } = fpxErp.outbox;
  return JSON.stringify({ ...meta, rowCount: rows.length });
}
function fpxErpTake(start, count) {
  if (!fpxErp || !fpxErp.outbox) return "[]";
  return JSON.stringify(fpxErp.outbox.rows.slice(start, start + count));
}
function fpxErpDeliver(resp) {
  if (!fpxErp) return "no job";
  fpxErp.outbox = null;
  fpxErp.inbox = resp || { ok: false, error: "empty answer" };
  return "ok";
}
// Park one upload body for the browser service and wait for its answer.
async function erpHandOff(payload) {
  fpxErp.inbox = null;
  fpxErp.outbox = payload;
  const until = Date.now() + 5 * 60 * 1000;
  while (Date.now() < until) {
    if (fpxErp.inbox) { const r = fpxErp.inbox; fpxErp.inbox = null; return r; }
    if (stopRequested) { fpxErp.outbox = null; return { ok: false, error: "stopped before the upload finished" }; }
    await new Promise((r) => setTimeout(r, 300));
  }
  fpxErp.outbox = null;
  return { ok: false, error: "no answer from the browser service after 5 min" };
}

function erpLog(text, level = "info") {
  dlog("[FPX-ERP]", level, text);
  if (fpxErp) fpxErp.lines.push({ level, text: String(text) });
}

function erpNum(n) { return Number(n || 0).toLocaleString("en-US"); }

// MM/DD/YYYY — the format the report dialog's date fields take (see setDateInput).
function erpDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

// Same day N months back; a day that doesn't exist there (May 31 → Feb 31)
// becomes that month's last day.
function erpMonthsAgo(d, months) {
  const out = new Date(d.getFullYear(), d.getMonth() - months, 1);
  const lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(d.getDate(), lastDay));
  return out;
}

// Holds while paused; throws (caught in erpAuditPull) once a stop is asked for.
async function erpCheckpoint() {
  await fpxPauseGate();
  if (stopRequested) throw Object.assign(new Error("Stopped by user"), { fpxStop: true });
}

function erpLoginExpired() {
  return /[#/]login\b/i.test(window.location.pathname + window.location.hash);
}

// Why invoiceGenerateReport() gave up, as a sentence that names the step.
function erpReportFailure(failNote) {
  const where = window.location.hash || window.location.pathname;
  if (/no date inputs/i.test(failNote || "")) return `Generate History Report dialog not found on the Transactions page (no date fields appeared; page is ${where})`;
  if (/CONTINUE/.test(failNote || "")) return "Generate History Report dialog: CONTINUE button not found";
  if (/No grid data/i.test(failNote || "")) return "Report grid never loaded — no rows appeared within 7 min of pressing Continue (FreightPOP is still loading, or there are no transactions in this range)";
  return failNote || "Generate History Report failed";
}

// "Exported to ERP" false / 0 / No / blank → not exported. Anything else
// (true, 1, Yes, a date…) counts as exported.
function erpIsNotExported(v) {
  if (v === null || v === undefined || v === false || v === 0) return true;
  const t = String(v).trim().toLowerCase();
  return t === "" || t === "0" || t === "false" || t === "no";
}

// The report's "Exported to ERP" column, as the rows are keyed. Rows omit
// blank cells, so the grid's own column list is checked too.
// → { key } or { error }
function erpFindExportedKey(rows, fieldMap) {
  const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Map(); // key → rows that carry it
  for (const r of rows) for (const k of Object.keys(r)) seen.set(k, (seen.get(k) || 0) + 1);
  for (const [field, title] of Object.entries(fieldMap || {})) {
    const k = title || field;
    if (!seen.has(k)) seen.set(k, 0);
  }
  const keys = [...seen.keys()];
  const exact = ["exportedtoerp", "isexportedtoerp", "exportedtoerpflag", "erpexported", "isexportedtoerpflag"];
  for (const want of exact) {
    const hit = keys.find((k) => norm(k) === want);
    if (hit) return { key: hit };
  }
  const loose = keys.filter((k) => { const n = norm(k); return n.includes("export") && n.includes("erp"); });
  if (loose.length === 1) return { key: loose[0] };
  if (loose.length > 1) return { error: `Could not tell which column is "Exported to ERP" — the report has ${loose.map((k) => `"${k}"`).join(", ")}` };
  return { error: `The report has no "Exported to ERP" column (columns: ${keys.slice(0, 60).join(", ") || "none"})` };
}

// A <select> of the report dialog by what it filters ("customer" / "carrier"):
// by its own name / id / ng-model first, then by a label right next to it.
function erpFindDialogSelect(word, exclude = null) {
  const w = word.toLowerCase();
  const selects = [...document.querySelectorAll("select")].filter((s) => s !== exclude);
  for (const sel of selects) {
    const own = `${sel.name || ""} ${sel.id || ""} ${sel.getAttribute("ng-model") || ""} ${sel.getAttribute("data-ng-model") || ""}`.toLowerCase();
    if (own.includes(w)) return sel;
  }
  for (const sel of selects) {
    const box = sel.closest("tr, .form-group, .control-group, label");
    const text = box ? box.textContent.replace(/\s+/g, " ").trim().toLowerCase() : "";
    // A short label only: a whole-dialog container mentions every filter.
    const labelOnly = [...(box ? box.childNodes : [])]
      .filter((n) => !(n.nodeType === 1 && n.contains(sel)))
      .map((n) => n.textContent || "").join(" ").toLowerCase();
    if (text && labelOnly.length < 120 && labelOnly.includes(w)) return sel;
  }
  return null;
}

const ERP_ALL_OPTION = /^[\s\-–—]*(all|any|select all)(\s+(customers?|carriers?))?[\s\-–—]*$/i;

// → { label, select, error?, note? }
function erpCheckCustomer() {
  const sel = erpFindDialogSelect("customer");
  if (!sel) return { label: "all customers", select: null, note: "No customer dropdown found in the dialog — FreightPOP's own default applies" };
  const opt = sel.options[sel.selectedIndex];
  const text = opt ? opt.text.replace(/\s+/g, " ").trim() : "";
  if (!opt || ERP_ALL_OPTION.test(text) || /all\s*customers/i.test(text)) return { label: "all customers", select: sel };
  return { label: text, select: sel, error: `Could not set the customer to All Customers (the dialog shows "${text}")` };
}

// Makes sure no carrier is filtered out. → { label, note?, level? }
function erpSetAllCarriers(customerSelect) {
  const sel = erpFindDialogSelect("carrier", customerSelect);
  if (!sel) return { label: "all carriers", note: "No carrier filter in the dialog — FreightPOP's default (all carriers) applies" };
  if (sel.multiple) {
    const picked = [...sel.selectedOptions];
    if (!picked.length) return { label: "all carriers" };
    for (const o of picked) o.selected = false;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { label: "all carriers", level: "warn", note: `Carrier filter had ${picked.length} carrier(s) picked — cleared them so every carrier is included` };
  }
  const cur = sel.options[sel.selectedIndex];
  const curText = cur ? cur.text.replace(/\s+/g, " ").trim() : "";
  if (!cur || ERP_ALL_OPTION.test(curText) || (cur.value === "" && sel.selectedIndex === 0)) return { label: "all carriers" };
  for (const opt of sel.options) {
    if (ERP_ALL_OPTION.test(opt.text)) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { label: "all carriers", note: `Carrier filter was "${curText}" — set to "${opt.text.trim()}"` };
    }
  }
  // No "All" choice. A placeholder such as "Select Carrier" means no carrier
  // is picked, which FreightPOP treats as every carrier. Either way the
  // filter is left exactly as FreightPOP shows it; the pull never fails here.
  if (/^(select|choose|pick|--|—|none)\b/i.test(curText) || /^select\s/i.test(curText)) return { label: "all carriers" };
  return { label: `carrier filter left as "${curText}"`, level: "warn", note: `The carrier filter shows "${curText}" and was left as is — if that is one carrier, only its shipments are in the report` };
}

function erpGridSig() {
  const grid = document.querySelector(".k-grid");
  if (!grid) return "";
  const pager = (grid.querySelector(".k-pager-info") || {}).textContent || "";
  const first = (grid.querySelector(".k-grid-content tbody tr, tbody tr") || {}).textContent || "";
  return pager.trim() + "|" + first.replace(/\s+/g, " ").slice(0, 200);
}

// After a tab click: wait until the grid has finished loading. True once the
// loading mask has come and gone or the rows changed, or after ~8 quiet
// seconds with nothing changing (the tab was already the one on screen).
// False if it is still loading after `maxSec`. Counts steps, not wall time,
// so a pause doesn't use the limit up.
async function erpWaitGridSettled(prevSig, maxSec = 60) {
  let calm = 0;
  let sawLoading = false;
  for (let i = 0; i < maxSec * 2; i++) {
    await erpCheckpoint();
    if (document.querySelector(".k-loading-mask, .k-loading-image")) { sawLoading = true; calm = 0; }
    else calm++;
    if (calm >= 3 && (sawLoading || erpGridSig() !== prevSig)) return true;
    if (calm >= 16) return true;
    await sleep(500);
  }
  return false;
}

// Every row of the grid on screen, through the grid's own data (not the
// visible page). Throws with the reason when it can't be read in full.
async function erpReadGrid(label) {
  const read = async () => {
    let rows = null;
    let meta = {};
    for (let attempt = 1; attempt <= 3; attempt++) {
      await erpCheckpoint();
      meta = {};
      rows = await getKendoGridAllRows(30000, meta);
      // An empty answer is checked once more before it is believed.
      if (rows && (rows.length > 0 || attempt >= 2)) break;
      await humanDelay(2500, 3500);
    }
    return { rows, meta };
  };
  let { rows, meta } = await read();
  if (!rows) throw new Error(`Could not read the ${label} rows from the report grid (${meta.error || "grid data not reachable"})`);
  const short = () => meta.total != null && meta.total > rows.length + (meta.skipped || 0);
  if (short()) {
    // The grid holds one page at a time: ask it for everything, then re-read.
    erpLog(`${label} · grid holds ${erpNum(rows.length)} of ${erpNum(meta.total)} rows — asking it for all of them`, "warn");
    const before = erpGridSig();
    try { await setGridPageSize(meta.total, () => {}); } catch { /* reported below if it didn't help */ }
    await erpWaitGridSettled(before, 60);
    ({ rows, meta } = await read());
    if (!rows || short()) {
      throw new Error(`${label}: the report has ${erpNum(meta.total)} rows but only ${erpNum(rows ? rows.length : 0)} could be read (the grid loads one page at a time)`);
    }
  }
  if (meta.skipped) erpLog(`${label} · ${erpNum(meta.skipped)} unreadable row(s) skipped`, "warn");
  return rows;
}

function erpUploadChunk(payload, retry) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, error: "no answer from the API after 4 min" }), 240000);
    try {
      chrome.runtime.sendMessage({ type: "uploadErpAudit", payload, retry }, (resp) => {
        if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
        else finish(resp || { ok: false, error: "empty reply from the extension" });
      });
    } catch (e) {
      finish({ ok: false, error: e?.message || String(e) });
    }
  });
}

// shipmentType: "non-parcel" (default) | "parcel" | "both"
// opts: { from, to } (YYYY-MM-DD) — a fixed range instead of the last N months;
//       backfill: true — hand EVERY report row to the browser service for the
//       Supabase copy and stop there (no audit is made).
async function erpAuditPull(months, runBy, shipmentType, opts) {
  const erpOpts = opts && typeof opts === "object" ? opts : {};
  const erpIsoToMdy = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "")); return m ? `${m[2]}/${m[3]}/${m[1]}` : null; };
  const erpType = shipmentType === "parcel" || shipmentType === "both" ? shipmentType : "non-parcel";
  const erpTabs = [["non-parcel", "Non-Parcel"], ["parcel", "Parcel"]].filter(([t]) => erpType === "both" || t === erpType);
  if (fpxErp && !fpxErp.done) return; // already running in this page
  stopRequested = false;
  const state = { lines: [], counts: { reportRows: 0, notExported: 0, uploaded: 0 }, done: null };
  fpxErp = state;
  let lastResult = null;

  try {
    const n = Math.min(12, Math.max(1, Math.round(Number(months)) || 3));
    const today = new Date();
    const fixed = erpIsoToMdy(erpOpts.from) && erpIsoToMdy(erpOpts.to);
    const fromStr = fixed ? erpIsoToMdy(erpOpts.from) : erpDate(erpMonthsAgo(today, n));
    const toStr = fixed ? erpIsoToMdy(erpOpts.to) : erpDate(today);

    await erpCheckpoint();
    if (erpLoginExpired()) throw new Error("FreightPOP login expired — sign in to FreightPOP again in the hosted browser, then re-run");

    erpLog("Opening Transactions");
    let failNote = null;
    const generated = await invoiceGenerateReport(fromStr, toStr, erpTabs[0][0], "", {
      status: (t) => dlog("[FPX-ERP]", t),
      fail: (t) => { failNote = t; },
      openDialog: true,
      stoppable: true,
      gridWaitSec: 420,
      beforeContinue: async (dateFields) => {
        await erpCheckpoint();
        const f = dateFields.from ? dateFields.from.value : "";
        const t = dateFields.to ? dateFields.to.value : "";
        if (!f || !t) return `Could not fill the report dates (From "${f}", To "${t}")`;
        const cust = erpCheckCustomer();
        if (cust.error) return cust.error;
        const carr = erpSetAllCarriers(cust.select);
        if (carr.error) return carr.error;
        erpLog(`Generate History Report · ${fromStr} to ${toStr} · ${cust.label} · ${carr.label} · ${erpTabs.map((t) => t[1]).join(" + ")}`);
        if (cust.note) erpLog(cust.note, "warn");
        if (carr.note) erpLog(carr.note, carr.level || "info");
        await humanDelay(300, 600);
        return null;
      },
      onGridWait: (sec) => {
        if (sec === 0) erpLog("Continue pressed · waiting for the report (up to 7 min)");
        else if (sec % 15 === 0) erpLog(`Still loading the report · ${sec}s`);
      },
    });

    if (!generated) {
      await erpCheckpoint(); // a stop ends here as "stopped", not as a failure
      if (erpLoginExpired()) throw new Error("FreightPOP login expired — sign in to FreightPOP again in the hosted browser, then re-run");
      throw new Error(erpReportFailure(failNote));
    }

    // One result tab per shipment type asked for.
    const parts = [];
    for (const [type, label] of erpTabs) {
      await erpCheckpoint();
      const before = erpGridSig();
      if (!clickShipmentTypeTab(type)) { parts.push({ label, rows: null }); continue; }
      erpLog(`Reading the ${label} tab`);
      await humanDelay(800, 1400);
      if (!(await erpWaitGridSettled(before, 60))) throw new Error(`The ${label} tab was still loading after 60s`);
      parts.push({ label, rows: await erpReadGrid(label) });
      await erpCheckpoint();
      erpLog(`Downloading FreightPOP's Excel export · ${label}`);
      const dl = await erpHandOffDownload(label);
      if (!dl.ok) erpLog(`Excel export not captured (${dl.error}) — using the rows read from the report on screen`, "warn");
    }
    if (parts.every((p) => p.rows === null)) {
      erpLog("Parcel / Non-Parcel tabs not found — reading the report as shown", "warn");
      parts.length = 0;
      parts.push({ label: "All", rows: await erpReadGrid("report") });
    } else {
      for (const p of parts) if (p.rows === null) erpLog(`${p.label} tab not found — its rows are not included`, "warn");
    }
    const got = parts.filter((p) => p.rows !== null);
    if (got.length === 2 && got[0].rows.length > 0 && got[0].rows.length === got[1].rows.length) {
      const a = got[0].rows, b = got[1].rows;
      if (JSON.stringify(a[0]) === JSON.stringify(b[0]) && JSON.stringify(a[a.length - 1]) === JSON.stringify(b[b.length - 1])) {
        erpLog(`${got[1].label} tab gave the same rows as ${got[0].label} — counted once; check the ${got[1].label} tab by hand`, "warn");
        got.pop();
      }
    }

    const allRows = [];
    for (const p of got) for (const r of p.rows) allRows.push(normalizeRowKeys(r));
    state.counts.reportRows = allRows.length;
    erpLog(`Report loaded · ${erpNum(allRows.length)} rows (${got.map((p) => `${p.label} ${erpNum(p.rows.length)}`).join(", ")})`);
    if (!allRows.length) {
      state.done = { ok: true, note: `No transactions in the report for ${fromStr} to ${toStr} — nothing to audit`, result: null };
      return;
    }

    // Backfill: every row goes to the Supabase copy; no audit is made.
    if (erpOpts.backfill) {
      const parts = [[]];
      let bytes = 0;
      for (const r of allRows) {
        const b = JSON.stringify(r).length * 1.1 + 1;
        if (bytes + b > ERP_UPLOAD_MAX_BYTES && parts[parts.length - 1].length) { parts.push([]); bytes = 0; }
        parts[parts.length - 1].push(r);
        bytes += b;
      }
      erpLog(`Backfill · handing ${erpNum(allRows.length)} rows over for Supabase` + (parts.length > 1 ? ` in ${parts.length} parts` : ""));
      let last = null;
      for (let c = 0; c < parts.length; c++) {
        await erpCheckpoint();
        last = await erpHandOff({ backfill: true, from: isoDateFromMmDdYyyy(fromStr), to: isoDateFromMmDdYyyy(toStr), final: c === parts.length - 1, rows: parts[c] });
        if (!last || !last.ok) throw new Error(`Backfill copy failed${parts.length > 1 ? ` on part ${c + 1} of ${parts.length}` : ""}: ${(last && last.error) || "no reply"}`);
        state.counts.uploaded += parts[c].length;
      }
      state.done = {
        ok: true,
        note: `Backfill ${fromStr} to ${toStr} · ${erpNum(allRows.length)} report rows · ${erpNum(last.stored)} shipments stored in Supabase` + (last.failed ? ` · ${erpNum(last.failed)} not stored` : ""),
        result: null,
      };
      return;
    }

    // The column list of whichever tab is on screen (rows drop blank cells).
    const colMeta = {};
    await getKendoGridAllRows(30000, colMeta).catch(() => null);
    const found = erpFindExportedKey(allRows, colMeta.fieldMap);
    if (found.error) throw new Error(found.error);
    const seenValues = new Map();
    const pending = [];
    for (const r of allRows) {
      const v = r[found.key];
      const shown = v === null || v === undefined || String(v).trim() === "" ? "blank" : String(v).trim();
      seenValues.set(shown, (seenValues.get(shown) || 0) + 1);
      if (!erpIsNotExported(v)) continue;
      if (found.key !== "Exported to ERP" && v !== undefined) { r["Exported to ERP"] = v; delete r[found.key]; }
      pending.push(r);
    }
    state.counts.notExported = pending.length;
    const valueList = [...seenValues].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([v, c]) => `${v} ${erpNum(c)}`).join(", ");
    erpLog(`Not exported to ERP · ${erpNum(pending.length)} rows · column "${found.key}" (${valueList})`, seenValues.size === 1 && allRows.length > 20 ? "warn" : "info");
    if (!pending.length) {
      state.done = { ok: true, note: `All ${erpNum(allRows.length)} rows are already exported to ERP — nothing to audit`, result: null };
      return;
    }

    const run = {
      date_from: isoDateFromMmDdYyyy(fromStr),
      date_to: isoDateFromMmDdYyyy(toStr),
      run_by: runBy || null,
      total_report_rows: allRows.length,
    };
    // Biggest invoices first (the server keeps this order).
    const rate = (r) => {
      const v = r["Shipment Marked-Up Rate"];
      if (v === null || v === undefined || v === "") return null;
      const x = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(x) ? x : null;
    };
    pending.sort((x, y) => {
      const a = rate(x), b = rate(y);
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    });

    // One POST when it fits (the API takes 20 MB); otherwise parts of at most
    // ~12 MB, the last one marked final so the AI summary runs once.
    const posts = [[]];
    let size = 0;
    for (const r of pending) {
      const bytes = JSON.stringify(r).length * 1.1 + 1;
      if (size + bytes > ERP_UPLOAD_MAX_BYTES && posts[posts.length - 1].length) { posts.push([]); size = 0; }
      posts[posts.length - 1].push(r);
      size += bytes;
    }
    const chunks = posts.length;
    erpLog(`Uploading · ${erpNum(pending.length)} rows` + (chunks > 1 ? ` in ${chunks} parts` : ""));
    let auditId = null;
    for (let c = 0; c < chunks; c++) {
      await erpCheckpoint();
      const rows = posts[c];
      const payload = c === 0 ? { run, rows, ai_level: "summary" } : { audit_id: auditId, rows };
      if (chunks > 1) payload.final = c === chunks - 1;
      // Never retried: a repeat could leave a second audit or double the rows.
      const resp = await erpHandOff(payload);
      if (!resp || !resp.ok) {
        const msg = `Upload failed${chunks > 1 ? ` on part ${c + 1} of ${chunks}` : ""}: ${(resp && resp.error) || "no reply"}` +
          (auditId ? ` — audit ${String(auditId).slice(0, 8)} holds ${erpNum(state.counts.uploaded)} of ${erpNum(pending.length)} rows` : "");
        erpLog(msg, "error");
        throw new Error(msg);
      }
      if (!resp.audit_id) throw new Error("The API took the upload but returned no audit id");
      auditId = resp.audit_id;
      // total = every row the report had; pending = the not-exported rows stored.
      lastResult = { audit_id: resp.audit_id, total: state.counts.reportRows || resp.total || null, pending: resp.pending ?? null };
      // The API says how many rows it could read each money column from. A
      // zero means FreightPOP's column title differs from what we expect.
      if (resp.fields && c === chunks - 1) {
        const f = resp.fields;
        erpLog(`Columns read · charge ${erpNum(f.charge)} · cost ${erpNum(f.cost)} · invoice amount ${erpNum(f.invoice)} · of ${erpNum(f.rows)} rows`);
        if (f.rows && (!f.charge || !f.cost || !f.shipment_id)) {
          erpLog(`Some columns could not be read (charge ${f.charge}, cost ${f.cost}, shipment id ${f.shipment_id}). The audit is saved but its numbers are incomplete — the report's column titles need checking.`, "warn");
        }
      }
      state.counts.uploaded += rows.length;
      if (chunks > 1) erpLog(`Uploaded ${erpNum(state.counts.uploaded)} of ${erpNum(pending.length)} rows`);
    }
    const id8 = String(auditId).slice(0, 8);
    erpLog(`Uploaded · audit ${id8} · ${erpNum(state.counts.uploaded)} rows` + (lastResult.pending != null ? ` · ${erpNum(lastResult.pending)} waiting for review` : ""), "done");
    state.done = {
      ok: true,
      note: `${erpNum(pending.length)} of ${erpNum(allRows.length)} report rows not exported to ERP · audit ${id8}`,
      result: lastResult,
    };
  } catch (e) {
    if (e && e.fpxStop) {
      state.done = {
        ok: true, stopped: true, result: lastResult,
        note: lastResult
          ? `${erpNum(state.counts.uploaded)} of ${erpNum(state.counts.notExported)} rows uploaded before the stop · audit ${String(lastResult.audit_id).slice(0, 8)}`
          : "Nothing was uploaded.",
      };
    } else {
      console.warn("[FPX-ERP] failed:", e?.message || e);
      state.done = { ok: false, note: String(e?.message || e), result: lastResult };
    }
  }
}

// =====================================================================
// APPROVAL CHECK (hosted browser job)
//
// Audit page → "Recently Approved" → hand the grid's Excel export to the
// browser service, which matches it against an ERP audit's shipments (who
// approved each one: the EDI or a person). Then the same for the "History"
// tab, over a date range the browser service gives (60 days before the
// pull's start date … today), because Recently Approved only reaches back a
// short while.
//
// Started by the browser service with erpApprovalCheck(runBy, resumed, opts);
// it polls fpxErpPoll() like the ERP audit pull. Pause / stop work the same way.
//   opts: { historyFrom, historyTo } (MM/DD/YYYY), skipApproved (Recently
//         Approved was already read before the page reloaded)
//
// HARD RULE — this job is read-only. On the Audit page it clicks exactly:
// the AUDIT item in the top navigation, the "Recently Approved" tab, the
// "History" tab, and on the History tab one control that applies the date
// range (text exactly one of AP_APPLY_WORDS), after typing the range into
// that tab's from / to date fields. (Plus, only when the browser service asks
// through fpxErpClickExport() for Recently Approved, an Excel export button.)
// It never clicks approve / reject / un-approve / dispute / pay / edit /
// delete / reprocess controls, checkboxes or anything inside a grid row. On
// Recently Approved the date range and page size are read and logged as shown.
// A failure in the History part never fails the job: it ends as a warning.
// =====================================================================
const AP_GRID_MARK = "data-fpx-export-grid"; // on the grid being exported, for the browser service
const AP_TAB_RE = /^recently\s+approved(\s*[(\[]?\s*[\d,]+\s*[)\]]?)?$/i;
const AP_HISTORY_RE = /^history(\s*[(\[]?\s*[\d,]+\s*[)\]]?)?$/i;
// The only controls the History tab may press to apply its date range, best first.
const AP_APPLY_WORDS = ["search", "go", "apply", "filter", "submit", "generate", "view", "refresh", "load", "show", "get history"];
// A control whose handler says it does one of these is never pressed, whatever its text.
const AP_APPLY_NEVER_RE = /approv|reject|dispute|delete|remove|void|reprocess|process|save|update|edit|pay(?!load)|send|e-?mail|import|upload|erp|edi(?![a-z])|export/i;
const AP_EXPIRED = "FreightPOP login expired — sign in to FreightPOP again in the hosted browser, then re-run";
const AP_TABLIKE = "[role=tab], .nav-tabs li, .nav-tabs a, .nav-pills li, .nav-pills a, .k-tabstrip-items .k-item, .k-tabstrip-items .k-link, md-tab-item, .md-tab";
const AP_DANGER_RE = /\b(approve|reject|dispute|pay|delete|void|cancel|send|e-?mail|import|upload|erp|edi|accounting|template|quickbooks|netsuite|pdf|print)\b/i;

function apText(el) { return ((el && (el.textContent || el.value)) || "").replace(/\s+/g, " ").trim(); }
function apUniq(list, max = 30) { return [...new Set(list.filter(Boolean))].slice(0, max); }
function apInRow(el) { return !!el.closest("tbody tr, .k-grid-content, .k-grid-header, .k-window, .modal, .k-animation-container"); }

// The top-nav item whose text is exactly AUDIT. → { el } or { labels } (what the nav shows).
function apFindAuditNav() {
  const NAV = "nav, header, .navbar, .nav, [role=navigation], [role=menubar], .menu, .top-menu, .main-menu, .header";
  const hits = [];
  for (const el of document.querySelectorAll("a, button, li, span, div, [role=menuitem], [role=tab]")) {
    if (!/^audit$/i.test(apText(el)) || !isVisibleForClick(el) || apInRow(el)) continue;
    const r = el.getBoundingClientRect();
    hits.push({ el, nav: el.closest(NAV) ? 1 : 0, top: r.top, depth: el.querySelectorAll("*").length });
  }
  if (hits.length) {
    // In the navigation first, then the highest on the page, then the innermost element.
    hits.sort((a, b) => b.nav - a.nav || a.top - b.top || a.depth - b.depth);
    const inner = hits[0].el;
    // Click the link itself: the <a>/<button> around the text, or the one inside an <li>.
    const link = inner.closest("a, button, [role=menuitem], [ui-sref]");
    const target = (link && /^audit$/i.test(apText(link)) ? link : null) ||
      [...inner.querySelectorAll("a, button")].find(isVisibleForClick) || inner;
    // Outside a recognised navigation bar only a real link in the top strip
    // of the page counts: any other "Audit" text is not clicked.
    const linkLike = target.matches("a, button, [role=menuitem], [ui-sref]");
    if (hits[0].nav || (linkLike && hits[0].top < 140)) return { el: target, inNav: !!hits[0].nav };
  }
  const labels = [];
  for (const el of document.querySelectorAll(`${NAV}`)) {
    for (const a of el.querySelectorAll("a, button, [role=menuitem]")) {
      const t = apText(a);
      if (t && t.length <= 30 && isVisibleForClick(a)) labels.push(t);
    }
  }
  // No recognised navigation bar: the links across the top of the page.
  if (!labels.length) {
    for (const a of document.querySelectorAll("a, button, [role=menuitem]")) {
      const t = apText(a);
      if (t && t.length <= 30 && isVisibleForClick(a) && a.getBoundingClientRect().top < 140) labels.push(t);
    }
  }
  return { labels: apUniq(labels) };
}

function apTabIsActive(el) {
  for (const n of [el, el.closest("li, .k-item, md-tab-item, [role=tab]"), el.parentElement]) {
    if (!n) continue;
    if (n.getAttribute("aria-selected") === "true") return true;
    if (/(^|\s)(active|k-state-active|k-active|md-active|selected|current)(\s|$)/.test(String(n.className || ""))) return true;
  }
  return false;
}

// Everything on the page whose text is the tab's name (`re`), best first:
// [{ el, kind: "tab" | "heading", score, label }]. A tab is clicked; a section
// heading (the grid simply sits under it) is not.
function apTabHits(re) {
  const hits = [];
  for (const el of document.querySelectorAll(`${AP_TABLIKE}, a, button, h1, h2, h3, h4, h5, legend, .panel-heading, .panel-title, .card-header, span, div, li, label`)) {
    const text = apText(el);
    if (text.length > 40 || !re.test(text) || !isVisibleForClick(el) || apInRow(el)) continue;
    const tabby = el.matches(AP_TABLIKE) ? el : el.closest(AP_TABLIKE);
    let score, kind = "tab", target = el;
    if (tabby && re.test(apText(tabby))) { score = 10; target = tabby; }
    else if (el.matches("a, button") || (el.closest("a, button") && re.test(apText(el.closest("a, button"))))) { score = 5; target = el.closest("a, button") || el; }
    else if (el.matches("h1, h2, h3, h4, h5, legend, .panel-heading, .panel-title, .card-header")) { score = 3; kind = "heading"; }
    else {
      const clickable = el.hasAttribute("ng-click") || el.hasAttribute("data-ng-click") || el.hasAttribute("onclick") || window.getComputedStyle(el).cursor === "pointer";
      score = clickable ? 2 : 1;
      if (!clickable) kind = "heading";
    }
    hits.push({ el: target, kind, score, label: text, len: el.querySelectorAll("*").length });
  }
  hits.sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.len - b.len);
  return hits;
}

// → { el, kind: "tab" | "heading", score, label } or null.
function apFindTab(re) { return apTabHits(re)[0] || null; }

// The History tab. Only a real tab is taken, and when Recently Approved is a
// tab too, only one in the same strip (so a "History" link elsewhere on the
// page is never clicked). → { tab, approved, others: labels not taken }
function apFindHistoryTab() {
  const approved = apFindTab(AP_TAB_RE);
  const hits = apTabHits(AP_HISTORY_RE).filter((h) => h.kind === "tab" && h.score >= 5);
  const sameStrip = (h) => {
    let up = approved.el;
    for (let i = 0; i <= 4 && up && up !== document.body; i++) {
      if (up.contains(h.el)) return i;
      up = up.parentElement;
    }
    return -1;
  };
  let ok;
  if (approved && approved.kind === "tab") {
    ok = hits.map((h) => ({ ...h, level: sameStrip(h) })).filter((h) => h.level >= 0).sort((a, b) => a.level - b.level || b.score - a.score);
  } else {
    ok = hits.filter((h) => h.score >= 10);
  }
  const others = hits.filter((h) => !ok.some((o) => o.el === h.el)).map((h) => `<${h.el.tagName.toLowerCase()}> "${h.label}"`);
  return { tab: ok[0] || null, approved, others: apUniq(others, 5) };
}

// The pane a tab names (aria-controls / href="#id"), or null.
function apTabPane(tab) {
  if (!tab || tab.kind !== "tab") return null;
  const link = tab.el.matches("a") ? tab.el : tab.el.querySelector("a");
  const id = tab.el.getAttribute("aria-controls") || (link && (link.getAttribute("aria-controls") || (/^#[\w-]+$/.test(link.getAttribute("href") || "") ? link.getAttribute("href").slice(1) : "")));
  return id ? document.getElementById(id) : null;
}

function apTabLabels() {
  const seen = [];
  for (const el of document.querySelectorAll("[role=tab], .nav-tabs > li, .nav-pills > li, .k-tabstrip-items .k-item, md-tab-item, .md-tab")) {
    const t = apText(el);
    if (t && t.length <= 40 && isVisibleForClick(el)) seen.push(t);
  }
  if (seen.length) return apUniq(seen);
  for (const el of document.querySelectorAll("h1, h2, h3, h4, .panel-heading, .panel-title, .card-header")) {
    const t = apText(el);
    if (t && t.length <= 40 && isVisibleForClick(el) && !apInRow(el)) seen.push(t);
  }
  return apUniq(seen);
}

// A tab's grid (Recently Approved, History): inside the tab's pane when the tab names one,
// the first grid after a section heading, else the biggest visible grid.
function apFindGrid(tab) {
  const grids = [...document.querySelectorAll(".k-grid")].filter(isVisibleForClick);
  if (!grids.length) return null;
  if (tab && tab.kind === "tab") {
    const pane = apTabPane(tab);
    const inPane = pane ? grids.filter((g) => pane.contains(g)) : [];
    if (inPane.length) return inPane[0];
  }
  if (tab && tab.kind === "heading") {
    const after = grids.filter((g) => tab.el.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (after.length) return after[0];
  }
  const area = (g) => { const r = g.getBoundingClientRect(); return r.width * r.height; };
  return grids.sort((a, b) => area(b) - area(a))[0];
}

function apGridRows(grid) {
  return [...grid.querySelectorAll(".k-grid-content tbody tr, .k-grid-content-locked tbody tr, :scope > table > tbody > tr")]
    .filter((tr) => !/k-grouping-row|k-group-footer|k-no-data|k-detail-row/.test(String(tr.className || ""))).length;
}

function apGridSig(grid) {
  const pager = apText(grid.querySelector(".k-pager-info"));
  const first = apText(grid.querySelector(".k-grid-content tbody tr, tbody tr")).slice(0, 200);
  return `${pager}|${apGridRows(grid)}|${first}`;
}

function apLoading(grid) {
  const scope = grid ? [grid, grid.parentElement].filter(Boolean) : [document];
  return scope.some((s) => [...s.querySelectorAll(".k-loading-mask, .k-loading-image")].some(isVisibleForClick));
}

// The nearest container that holds the grid, its toolbar and its filters but
// no other grid.
function apGridScope(grid) {
  const pane = grid.closest(".tab-pane, [role=tabpanel], .k-tabstrip > .k-content, md-tab-content");
  if (pane) return pane;
  let scope = grid;
  for (let i = 0; i < 4 && scope.parentElement && scope.parentElement !== document.body; i++) {
    const up = scope.parentElement;
    if ([...up.querySelectorAll(".k-grid")].filter(isVisibleForClick).some((g) => g !== grid && !grid.contains(g))) break;
    scope = up;
  }
  return scope;
}

// What the grid is showing — read only, nothing is changed.
function apDescribeView(grid) {
  const parts = [];
  const scope = apGridScope(grid);
  const dates = [];
  for (const inp of scope.querySelectorAll("input")) {
    if (!isVisibleForClick(inp) || apInRow(inp)) continue;
    const v = String(inp.value || "").trim();
    if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$|^\d{4}-\d{2}-\d{2}$/.test(v)) dates.push(v);
    else if (/\d{1,2}\/\d{1,2}\/\d{2,4}\s*(-|–|to)\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i.test(v)) dates.push(v);
  }
  if (dates.length === 1) parts.push(`showing ${dates[0]}`);
  else if (dates.length >= 2) parts.push(`showing ${dates[0]} to ${dates[1]}`);
  for (const sel of scope.querySelectorAll("select")) {
    if (!isVisibleForClick(sel) || apInRow(sel) || sel.closest(".k-pager-sizes, .k-pager-wrap, .k-pager")) continue;
    const t = apText(sel.options[sel.selectedIndex]);
    if (t && t.length <= 40 && /day|week|month|year|quarter|range|last|today|all/i.test(t)) parts.push(`range "${t}"`);
  }
  const sizes = grid.querySelector(".k-pager-sizes");
  if (sizes) {
    const sel = sizes.querySelector("select");
    const size = (sel && sel.value) || apText(sizes.querySelector(".k-input, .k-input-value-text, .k-input-inner"));
    if (size) parts.push(`page size ${String(size).slice(0, 12)}`);
  }
  const info = apText(grid.querySelector(".k-pager-info"));
  if (info) parts.push(info.slice(0, 60));
  return parts;
}

// Excel export button for the approval check: only inside the Recently
// Approved section, never a row control, judged by what the button itself
// says (text / title / tooltip), not by class names or handlers.
function apExportCandidates() {
  const grid = document.querySelector(`[${AP_GRID_MARK}]`);
  if (!grid) return []; // no Recently Approved grid in hand: click nothing
  if (fpxErp && fpxErp.phase === "history") return []; // History: the grid's own export only, no button
  const scope = apGridScope(grid);
  const out = [];
  const seen = new Set();
  for (const el of scope.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button], .k-button, .k-grid-excel, i, span, img")) {
    const target = el.closest("a, button, input[type=button], input[type=submit], [role=button], .k-button") || el;
    if (seen.has(target) || !scope.contains(target) || !isVisibleForClick(target)) continue;
    if (target.closest("tbody tr, .k-grid-content, .k-pager-wrap, .k-pager, .k-grid-header")) continue; // never a row, pager or column control
    const text = apText(target);
    if (text.length > 60) continue;
    const said = [text, target.title, target.getAttribute("aria-label"), target.getAttribute("data-original-title"),
      target.getAttribute("uib-tooltip"), target.getAttribute("tooltip"), el.title, el.getAttribute("alt"), el.getAttribute("aria-label"),
    ].filter(Boolean).join(" | ");
    if (AP_DANGER_RE.test(said)) continue;
    // What the button does when its handler says so: never one that pushes
    // data out or acts on invoices. ("Approved" in a handler name is the
    // section's name, so approve is judged by the visible text above.)
    const does = [target.getAttribute("ng-click"), target.getAttribute("data-ng-click"), target.getAttribute("onclick"), target.id].filter(Boolean).join(" | ");
    if (/erp|quickbooks|netsuite|accounting|edi(?![a-z])|send|e-?mail|delete|void|reject|dispute|import|upload|submit|pay(?!load)/i.test(does)) continue;
    // Only a button that is an Excel export: a bare "Export" could be anything.
    let score = 0;
    if (/(^|\s)k-grid-excel(\s|$)/.test(String(target.className || ""))) score += 10;
    if (/excel|xlsx?\b|\.xls/i.test(said)) score += 8;
    if (score <= 0) continue;
    seen.add(target);
    out.push({ el: target, score, desc: (text || target.title || target.getAttribute("aria-label") || String(target.className || target.tagName)).slice(0, 60) });
  }
  return out.sort((a, b) => b.score - a.score);
}

// A tab's grid, loaded and quiet. Counts steps (half a second each), so a
// pause doesn't use the limit up. → { grid, settled, sawLoading }
//   find()     the grid, or null while it isn't there
//   changed(sig)  true when the grid no longer shows what it did before
//   need({ rows, sawLoading, changed })  quiet steps wanted before it counts as loaded
// What the page is showing while a grid is awaited (for the log only).
function apPageState() {
  try {
    const vis = (sel) => [...document.querySelectorAll(sel)].filter(isVisibleForClick);
    const grids = vis(".k-grid").map((g) => `${g.id || g.className.split(" ").slice(0, 2).join(".")}(${g.querySelectorAll("tbody tr").length} rows, in ${(g.closest(".tab-pane") || {}).id || "no pane"})`);
    const tables = vis("table").filter((t) => !t.closest(".k-grid")).map((t) => `${t.id || "table"}(${t.querySelectorAll("tbody tr").length} rows)`);
    const loaders = vis(".k-loading-mask, .k-loading-image, .loading, .loader, .spinner, [class*=spinner], [class*=loading]").length;
    const msgs = vis(".alert, .toast, .toast-message, .k-notification, .modal.in .modal-body, .swal2-popup, .sweet-alert, .validation-summary-errors, .text-danger, .error")
      .map((e) => apText(e).slice(0, 100)).filter(Boolean);
    const pane = document.querySelector(".tab-pane.active") ;
    const paneText = pane ? apText(pane).replace(/Export To Excel|Search/g, "").slice(0, 160) : "";
    return `grids: ${grids.slice(0, 4).join(", ") || "none"} · tables: ${tables.slice(0, 3).join(", ") || "none"} · loading indicators: ${loaders} · messages: ${apUniq(msgs).slice(0, 3).join(" / ") || "none"} · pane text: "${paneText}"`;
  } catch (e) { return `state unreadable (${e.message})`; }
}

async function apWaitGrid({ find, label, steps, changed, need }) {
  let grid = null, calm = 0, sawLoading = false, lastSig = null;
  for (let i = 0; i < steps; i++) {
    await erpCheckpoint();
    if (erpLoginExpired()) throw new Error(AP_EXPIRED);
    grid = find();
    if (!grid) { calm = 0; }
    else if (apLoading(grid)) { sawLoading = true; calm = 0; }
    else {
      const sig = apGridSig(grid);
      calm = sig === lastSig ? calm + 1 : 0;
      lastSig = sig;
      if (calm >= need({ rows: apGridRows(grid), sawLoading, changed: changed(sig) })) return { grid, settled: true, sawLoading };
    }
    if (i > 0 && i % 30 === 0) erpLog(`Still loading ${label} · ${i / 2}s${grid ? "" : ` · ${apPageState()}`}`);
    await sleep(500);
  }
  return { grid, settled: false, sawLoading };
}

// ── History tab ──
// Inside a grid (rows, header, filter row, pager) or a popup: never touched.
function apInGrid(el) {
  if (el.closest(".k-grid-toolbar")) return false;
  return !!el.closest(".k-grid, .k-grid-content, .k-grid-header, .k-pager-wrap, .k-pager, .k-filter-row, .k-window, .modal, .k-animation-container");
}

function apDescribeEl(el) {
  if (!el) return "?";
  const cls = String(el.className || "").replace(/\s+/g, ".").slice(0, 60);
  return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}>`;
}

// The part of the page that belongs to the open tab: the pane the tab names,
// else the grid's surroundings, else the open tab pane, else the smallest
// block around the tab strip that also holds fields or a grid.
function apTabPanel(tab, grid) {
  const pane = apTabPane(tab);
  if (pane && isVisibleForClick(pane)) return pane;
  if (grid) return apGridScope(grid);
  const open = [...document.querySelectorAll(".tab-pane.active, [role=tabpanel], .k-tabstrip > .k-content, md-tab-content.md-active")].filter(isVisibleForClick);
  if (open.length === 1) return open[0];
  const strip = tab.el.closest("ul, [role=tablist], .nav-tabs, .k-tabstrip-items, md-tabs-wrapper") || tab.el.parentElement;
  let up = strip ? strip.parentElement : null;
  for (let i = 0; i < 4 && up && up !== document.body; i++) {
    const holds = [...up.querySelectorAll("input:not([type=hidden]), select, .k-grid")].some((e) => isVisibleForClick(e) && !strip.contains(e));
    if (holds) return up;
    up = up.parentElement;
  }
  return null;
}

// "input[placeholder="…" ng-model=… name=…]=value" for every visible field of the tab.
function apPanelFields(panel) {
  return [...panel.querySelectorAll("input:not([type=hidden]), select, textarea")]
    .filter((e) => isVisibleForClick(e) && !apInGrid(e))
    .map((e) => {
      const about = [
        e.getAttribute("placeholder") ? `placeholder="${e.getAttribute("placeholder").slice(0, 30)}"` : "",
        (e.getAttribute("ng-model") || e.getAttribute("data-ng-model") || e.getAttribute("k-ng-model")) ? `ng-model=${(e.getAttribute("ng-model") || e.getAttribute("data-ng-model") || e.getAttribute("k-ng-model")).slice(0, 40)}` : "",
        e.name ? `name=${String(e.name).slice(0, 30)}` : "",
        !e.getAttribute("placeholder") && !e.name && e.id ? `id=${String(e.id).slice(0, 30)}` : "",
        e.tagName === "INPUT" && e.type && e.type !== "text" ? `type=${e.type}` : "",
      ].filter(Boolean).join(" ");
      const value = e.tagName === "SELECT" ? apText(e.options[e.selectedIndex]) : (e.type === "checkbox" || e.type === "radio") ? (e.checked ? "on" : "off") : e.value;
      return `${e.tagName.toLowerCase()}[${about}]=${String(value || "").slice(0, 30)}`;
    });
}

function apPanelButtons(panel) {
  const out = [];
  for (const e of panel.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button], .k-button")) {
    if (!isVisibleForClick(e) || apInGrid(e)) continue;
    const t = apText(e) || e.title || e.getAttribute("aria-label") || "";
    if (t && t.length <= 30) out.push(t);
  }
  return apUniq(out, 40);
}

// The controls that may be pressed to apply the History date range: visible,
// in the tab's panel, outside any grid, text exactly one of AP_APPLY_WORDS.
// → { ok: [{ el, text }] best first, refused: [text (why)] }
function apApplyControls(panel) {
  const ok = [], refused = [];
  const seen = new Set();
  for (const e of panel.querySelectorAll("button, input[type=button], input[type=submit], a, [role=button], .k-button")) {
    if (seen.has(e) || !isVisibleForClick(e) || apInGrid(e)) continue;
    const text = apText(e);
    const rank = AP_APPLY_WORDS.indexOf(text.toLowerCase());
    if (rank < 0) continue;
    seen.add(e);
    const does = [e.getAttribute("ng-click"), e.getAttribute("data-ng-click"), e.getAttribute("onclick")].filter(Boolean).join(" | ");
    if (e.disabled || e.getAttribute("aria-disabled") === "true") { refused.push(`"${text}" (disabled)`); continue; }
    if (AP_APPLY_NEVER_RE.test(does)) { refused.push(`"${text}" (its handler is ${does.slice(0, 60)})`); continue; }
    ok.push({ el: e, text, rank });
  }
  ok.sort((a, b) => a.rank - b.rank);
  return { ok, refused };
}

// Does a date field show this MM/DD/YYYY day (in whatever format it uses)?
function apShowsDay(input, mdy) {
  const v = String((input && input.value) || "").trim();
  const [mm, dd, yyyy] = mdy.split("/").map(Number);
  let m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) return +m[1] === mm && +m[2] === dd && (+m[3] === yyyy || +m[3] === yyyy % 100);
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return +m[1] === yyyy && +m[2] === mm && +m[3] === dd;
  return false;
}

function apFieldName(input) {
  return (input.getAttribute("ng-model") || input.getAttribute("k-ng-model") || input.name || input.id || input.getAttribute("placeholder") || input.type || "field").slice(0, 40);
}

// Open History, set its date range, wait for the grid and hand it over for
// the Excel capture. → { rows, note }. Throws with the reason when History
// could not be read; the caller turns that into a warning.
//   mark(grid)  puts the export mark on the grid (and takes it off any other)
async function apHistoryPhase(from, to, mark) {
  const where = () => window.location.hash || window.location.pathname;
  const controls = (panel) => `fields: ${panel ? apPanelFields(panel).slice(0, 12).join(" | ") || "none" : "?"} · buttons: ${panel ? apPanelButtons(panel).join(" | ") || "none" : "?"}`;

  // a. The History tab, in the same strip as Recently Approved.
  let found = null;
  for (let i = 0; i < 20; i++) { // 10 s
    await erpCheckpoint();
    if (erpLoginExpired()) throw new Error(AP_EXPIRED);
    found = apFindHistoryTab();
    if (found.tab) break;
    await sleep(500);
  }
  if (!found.tab) {
    throw new Error(`"History" tab not found on the Audit page — tabs seen: ${apTabLabels().join(", ") || "none"}` +
      `${found.others.length ? ` ("History" elsewhere on the page was not clicked: ${found.others.join(", ")})` : ""} (waited 10s; page is ${where()})`);
  }
  let tab = found.tab;

  // b. Open it. It must be the open tab — and Recently Approved must not be —
  // before anything is read or typed.
  const isOpen = () => {
    const f = apFindHistoryTab();
    if (f.tab) tab = f.tab;
    const other = f.approved && f.approved.kind === "tab" && f.approved.el !== tab.el && apTabIsActive(f.approved.el);
    return apTabIsActive(tab.el) && !other;
  };
  if (isOpen()) {
    erpLog(`"${tab.label}" tab is already open`);
  } else {
    erpLog(`Opening the "${tab.label}" tab`);
    simulateClick(tab.el.matches("li") ? ([...tab.el.querySelectorAll("a, .k-link")].find(isVisibleForClick) || tab.el) : tab.el);
    await humanDelay(800, 1400);
    let open = false;
    for (let i = 0; i < 30 && !open; i++) { // 15 s
      await erpCheckpoint();
      if (erpLoginExpired()) throw new Error(AP_EXPIRED);
      open = isOpen();
      if (!open) await sleep(500);
    }
    if (!open) {
      const li = tab.el.closest("li, .k-item, md-tab-item, [role=tab]") || tab.el;
      const f = apFindHistoryTab();
      throw new Error(`clicked the "${tab.label}" tab but it did not become the open tab within 15s — nothing was read or typed ` +
        `(tab is <${tab.el.tagName.toLowerCase()} class="${String(li.className || "").slice(0, 80)}" aria-selected="${li.getAttribute("aria-selected") || ""}">` +
        `${f.approved && f.approved.kind === "tab" && apTabIsActive(f.approved.el) ? "; Recently Approved still reads as the open tab" : ""})`);
    }
  }
  await humanDelay(1200, 1800); // let the tab's content render

  // c. Its part of the page. A grid counts only inside the pane the tab names.
  const findGrid = () => {
    const g = apFindGrid(tab);
    const pane = apTabPane(tab);
    return g && pane && isVisibleForClick(pane) && !pane.contains(g) ? null : g;
  };
  let grid = null, panel = null;
  for (let i = 0; i < 20; i++) { // 10 s
    await erpCheckpoint();
    grid = findGrid();
    panel = apTabPanel(tab, grid);
    if (panel && (grid || apPanelFields(panel).length)) break;
    await sleep(500);
  }
  if (!panel) throw new Error(`the History tab is open but nothing under it could be read after 10s (no grid, no fields; page is ${where()})`);
  erpLog(`History tab open · reading ${apDescribeEl(panel)} · ${grid ? `grid on screen with ${erpNum(apGridRows(grid))} row(s)` : "no grid on screen yet"}`);
  erpLog(`History tab fields: ${apPanelFields(panel).slice(0, 25).join(" | ") || "none"}`.slice(0, 900));
  erpLog(`History tab buttons: ${apPanelButtons(panel).join(" | ") || "none"}`.slice(0, 900));

  // d. The date range.
  const found2 = findDateInputs(panel, apInGrid);
  let fromInput = found2.from, toInput = found2.to;
  if (found2.all.length >= 2 && (!fromInput || !toInput || fromInput === toInput)) { fromInput = found2.all[0]; toInput = found2.all[1]; }
  const sigBefore = grid ? apGridSig(grid) : "";
  let applied = false;
  if (found2.all.length < 2 || !fromInput || !toInput || fromInput === toInput) {
    const shown = grid ? apDescribeView(grid) : [];
    erpLog(`History has ${found2.all.length === 1 ? "one date field, not a from / to pair" : "no date fields"} — left as it is` +
      ` (wanted ${from} to ${to}) · ${shown.length ? shown.join(" · ") : "no date range or pager could be read"}`, "warn");
  } else {
    await erpCheckpoint();
    erpLog(`History · setting the range ${from} to ${to} (from field ${apFieldName(fromInput)}, was "${String(fromInput.value).slice(0, 20)}" · to field ${apFieldName(toInput)}, was "${String(toInput.value).slice(0, 20)}")`);
    setDateInput(fromInput, from);
    await humanDelay(300, 600);
    setDateInput(toInput, to);
    await humanDelay(400, 800);
    const fromOk = apShowsDay(fromInput, from), toOk = apShowsDay(toInput, to);
    erpLog(`History dates · from shows "${String(fromInput.value).slice(0, 20)}"${fromOk ? "" : ` (wanted ${from})`} · to shows "${String(toInput.value).slice(0, 20)}"${toOk ? "" : ` (wanted ${to})`}`, fromOk && toOk ? "info" : "warn");

    // e. Apply it: one of the allowed controls, else Enter on the To field.
    await erpCheckpoint();
    const apply = apApplyControls(panel);
    if (apply.refused.length) erpLog(`History · not pressed: ${apply.refused.join(", ")}`, "warn");
    if (apply.ok.length) {
      erpLog(`History · applying the range · clicking "${apply.ok[0].text}"${apply.ok.length > 1 ? ` (also there: ${apply.ok.slice(1).map((c) => `"${c.text}"`).join(", ")})` : ""}`);
      simulateClick(apply.ok[0].el);
      applied = true;
      await humanDelay(600, 1000);
    } else {
      erpLog(`History · no Search-type button on the tab (allowed: ${AP_APPLY_WORDS.join(", ")}) — pressing Enter in the To date field`);
      toInput.focus();
      for (const type of ["keydown", "keypress", "keyup"]) {
        toInput.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
      }
      toInput.dispatchEvent(new Event("change", { bubbles: true }));
      toInput.blur();
      let reacted = false;
      for (let i = 0; i < 20 && !reacted; i++) { // 10 s
        await erpCheckpoint();
        const g = findGrid();
        reacted = !!g && (apLoading(g) || apGridSig(g) !== sigBefore);
        if (!reacted) await sleep(500);
      }
      const g = findGrid();
      if (reacted) {
        erpLog("History · the grid reloaded after Enter in the To date field");
        applied = true;
      } else if (!g || apGridRows(g) === 0) {
        // Nothing loads without a control that is not on the list: stop here.
        throw new Error(`the dates were typed but nothing loads them: no button named ${AP_APPLY_WORDS.join(" / ")}, and Enter did nothing in 10s — on the tab: ${controls(panel)}`.slice(0, 900));
      } else {
        erpLog(`History · the grid did not reload after Enter (10s) — reading what it shows, which may not be ${from} to ${to} · on the tab: ${controls(panel)}`.slice(0, 900), "warn");
      }
    }
  }

  // f. The grid, loaded. A long range can take a while: up to 3 minutes.
  // After the range was applied, rows that look the same as before must stay
  // quiet for 20s (a slow search with no loading mask), an empty grid 30s.
  const waited = await apWaitGrid({
    find: findGrid, label: "History", steps: 840, // 7 min: the search alone has taken 95 s to over 3 min
    changed: (sig) => sig !== sigBefore,
    need: ({ rows, sawLoading, changed }) => (rows > 0
      ? ((sawLoading || changed) ? 4 : (applied ? 40 : 10))
      : (sawLoading ? 16 : (applied ? 60 : 16))),
  });
  grid = waited.grid;
  if (!grid) throw new Error(`the History grid never appeared (waited 7 min; page is ${where()}) — on the tab: ${controls(apTabPanel(tab, null) || panel)}`.slice(0, 900));
  if (!waited.settled) throw new Error("the History grid was still loading after 3 min");

  // g. What it shows.
  const rowsOnScreen = apGridRows(grid);
  const view = apDescribeView(grid);
  erpLog(`History · ${view.length ? view.join(" · ") : "no date range or pager could be read"} · ${erpNum(rowsOnScreen)} row(s) on screen`);
  if (rowsOnScreen === 0 || /no items to display/i.test(apText(grid.querySelector(".k-pager-info")))) {
    return { rows: 0, note: `History is empty for ${from} to ${to}` };
  }

  // h. The browser service takes the grid's Excel export (all pages).
  await erpCheckpoint();
  mark(grid);
  erpLog("Taking FreightPOP's Excel export · History");
  const dl = await erpHandOffDownload("History");
  await erpCheckpoint(); // a stop during the hand-off ends as "stopped"
  if (!dl || !dl.ok) throw new Error(`export not captured: ${(dl && dl.error) || "no reply"}`);
  return { rows: Number(dl.rows) || 0, note: `History export captured · ${erpNum(dl.rows)} rows (${from} to ${to})` };
}

async function erpApprovalCheck(runBy, resumed = false, opts = null) {
  if (fpxErp && !fpxErp.done) return; // already running in this page
  stopRequested = false;
  opts = opts && typeof opts === "object" ? opts : {};
  const state = { job: "approval_check", lines: [], counts: { approvedRows: 0, historyRows: 0 }, done: null, phase: null };
  fpxErp = state;
  const where = () => window.location.hash || window.location.pathname;
  const expired = AP_EXPIRED;
  let marked = null;
  const mark = (grid) => {
    for (const g of document.querySelectorAll(`[${AP_GRID_MARK}]`)) g.removeAttribute(AP_GRID_MARK);
    grid.setAttribute(AP_GRID_MARK, "1");
    marked = grid;
  };
  let approvedNote = null; // set once Recently Approved is dealt with

  try {
    await erpCheckpoint();
    if (erpLoginExpired()) throw new Error(expired);
    if (!resumed) erpLog(`Approval check${runBy ? ` for ${runBy}` : ""} · read-only: nothing on the Audit page is approved, rejected or edited`);

    // 1. The AUDIT item in the top navigation (it can take a moment to render).
    // AUDIT can be a separate page: the click then reloads everything and the
    // browser service starts this again on the new page with resumed = true,
    // which goes straight to waiting for the page instead of clicking again.
    const before = where();
    if (resumed) {
      erpLog(`On the Audit page (${before})`);
    } else {
      let nav = null;
      for (let i = 0; i < 40; i++) { // 20 s
        nav = apFindAuditNav();
        if (nav.el) break;
        await erpCheckpoint();
        await sleep(500);
      }
      if (!nav.el) throw new Error(`AUDIT was not found in FreightPOP's top navigation after 20s (page is ${where()}) — navigation shows: ${nav.labels.join(", ") || "nothing readable"}`);
      erpLog(`Opening Audit · clicking "${apText(nav.el) || "AUDIT"}" in the ${nav.inNav ? "top navigation" : "page header"} (page is ${before})`);
      simulateClick(nav.el);
      await humanDelay(800, 1400);
    }

    // 2. The Audit page is up once its "Recently Approved" tab is there.
    let tab = null;
    for (let i = 0; i < 60; i++) { // 30 s
      await erpCheckpoint();
      if (erpLoginExpired()) throw new Error(expired);
      tab = apFindTab(AP_TAB_RE);
      if (tab) break;
      await sleep(500);
    }
    const after = where();
    erpLog(after !== before ? `Audit page open · ${after}` : `The page address did not change after clicking AUDIT (still ${after})`, after !== before ? "info" : "warn");
    if (!tab) {
      const tabs = apTabLabels();
      erpLog(`Tabs on the page: ${tabs.join(", ") || "none found"}`, "warn");
      throw new Error(`"Recently Approved" tab not found on the Audit page — tabs seen: ${tabs.join(", ") || "none"} (waited 30s; page is ${after})`);
    }

    if (opts.skipApproved) {
      // The page reloaded after Recently Approved was handed over.
      erpLog("Recently Approved was already read — going on to History");
      approvedNote = "Recently Approved export captured";
    } else {
      // 3. Show Recently Approved.
      await erpCheckpoint();
      const sigBefore = (() => { const g = apFindGrid(tab); return g ? apGridSig(g) : ""; })();
      let clicked = false;
      if (tab.kind === "heading") {
        erpLog(`"${tab.label}" is a section on the page, not a tab — nothing to click`);
      } else if (apTabIsActive(tab.el)) {
        erpLog(`"${tab.label}" tab is already open`);
      } else {
        erpLog(`Opening the "${tab.label}" tab`);
        simulateClick(tab.el.matches("li") ? ([...tab.el.querySelectorAll("a, .k-link")].find(isVisibleForClick) || tab.el) : tab.el);
        clicked = true;
        await humanDelay(800, 1400);
        // The tab must be the open one before any grid is read: otherwise the
        // grid on screen is another tab's and its rows are not approvals.
        let open = false, seenTab = tab;
        for (let i = 0; i < 30 && !open; i++) { // 15 s
          await erpCheckpoint();
          seenTab = apFindTab(AP_TAB_RE) || seenTab;
          open = seenTab.kind === "tab" && apTabIsActive(seenTab.el);
          if (!open) await sleep(500);
        }
        if (!open) {
          const li = seenTab.el.closest("li, .k-item, md-tab-item, [role=tab]") || seenTab.el;
          throw new Error(`Clicked the "${tab.label}" tab but it did not become the open tab within 15s — nothing was read ` +
            `(tab is <${seenTab.el.tagName.toLowerCase()} class="${String(li.className || "").slice(0, 80)}" aria-selected="${li.getAttribute("aria-selected") || ""}">)`);
        }
      }

      // 4. Its grid, loaded (90 s). Rows on screen: 2 quiet seconds after a
      // load or a change, else 5. No rows: 8 quiet seconds before calling it empty.
      const waited = await apWaitGrid({
        find: () => apFindGrid(apFindTab(AP_TAB_RE) || tab), label: "Recently Approved", steps: 180,
        changed: (sig) => clicked && sig !== sigBefore,
        need: ({ rows, sawLoading, changed }) => (rows > 0 ? ((sawLoading || changed) ? 4 : 10) : 16),
      });
      const grid = waited.grid;
      if (!grid) throw new Error(`The Recently Approved grid never appeared (waited 90s; page is ${where()}; tabs seen: ${apTabLabels().join(", ") || "none"})`);
      if (!waited.settled) throw new Error("The Recently Approved grid was still loading after 90s");

      mark(grid);

      // 5. What it shows. Date range and page size are left exactly as they are.
      const rowsOnScreen = apGridRows(grid);
      const view = apDescribeView(grid);
      erpLog(`Recently Approved · ${view.length ? view.join(" · ") : "no date range or pager could be read"} · ${erpNum(rowsOnScreen)} row(s) on screen`);
      erpLog(`Audit page tabs: ${apTabLabels().join(" | ") || "none found"}`);
      const pagerInfo = apText(grid.querySelector(".k-pager-info"));
      if (rowsOnScreen === 0 || /no items to display/i.test(pagerInfo)) {
        erpLog("Recently Approved is empty — going on to History");
        approvedNote = "Recently Approved is empty";
      } else {
        // 6. The browser service takes the grid's Excel export.
        await erpCheckpoint();
        erpLog("Taking FreightPOP's Excel export · Recently Approved");
        const dl = await erpHandOffDownload("Recently Approved");
        await erpCheckpoint(); // a stop during the hand-off ends as "stopped"
        if (!dl || !dl.ok) throw new Error(`Recently Approved export not captured: ${(dl && dl.error) || "no reply"}`);
        state.counts.approvedRows = Number(dl.rows) || 0;
        approvedNote = `Recently Approved export captured · ${erpNum(state.counts.approvedRows)} rows`;
      }
    }

    // 7. History, for the range the browser service asked for. Nothing in
    // here can fail the job: Recently Approved stands whatever happens.
    state.phase = "history";
    if (marked) { marked.removeAttribute(AP_GRID_MARK); marked = null; }
    let historyNote;
    try {
      if (!opts.historyFrom || !opts.historyTo) throw new Error("the browser service sent no date range (it needs redeploying)");
      const h = await apHistoryPhase(String(opts.historyFrom), String(opts.historyTo), mark);
      state.counts.historyRows = h.rows;
      historyNote = h.note;
    } catch (e) {
      if (e && e.fpxStop) throw e;
      console.warn("[FPX-ERP] approval check, History:", e?.message || e);
      historyNote = `History not read: ${String(e?.message || e)}`;
      erpLog(historyNote.slice(0, 900), "warn");
    }
    state.done = { ok: true, note: `${approvedNote} · ${historyNote}`.slice(0, 480) };
  } catch (e) {
    if (e && e.fpxStop) {
      state.done = { ok: true, stopped: true, note: approvedNote ? `${approvedNote}; History was not read.` : "Nothing was checked." };
    } else {
      console.warn("[FPX-ERP] approval check failed:", e?.message || e);
      state.done = { ok: false, note: String(e?.message || e) };
    }
  } finally {
    if (marked) marked.removeAttribute(AP_GRID_MARK);
  }
}

// =====================================================================
// GET INVOICES (hosted browser job)
//
// After a person has reviewed an ERP audit and picked shipments: generate the
// same History Report, then for each picked shipment find its row and click
// that row's GET INVOICE button. One shipment at a time, one click each.
//
// Started by the browser service with erpGetInvoices(optsJson); it polls
// fpxErpPoll() for log lines, finished shipments (`results`) and pause
// requests (`pause`), and tells this page about things only it can see
// (a new window, a file download, a browser prompt) with fpxErpNote().
//
// What FreightPOP does after the click is not known, so the job watches for
// ~15 s, writes down what it saw in plain words, and only ever puts a dialog
// away with a passive control (GI_PASSIVE, a close icon, or a lone OK on a
// message). It never clicks anything else. A dialog that wants an answer is
// left open and the job pauses for a person.
// Pause / stop: as for the ERP audit pull (erpCheckpoint / humanDelay).
// =====================================================================
const GI_OBSERVE_STEPS = 50; // × 300 ms ≈ 15 s. Steps, not wall time: a browser prompt freezes the page.
const GI_DIALOG_SELECTOR = ".modal.in, .modal.show, .k-window, [role='dialog'], [role='alertdialog'], .bootbox, .sweet-alert, .swal2-popup, .swal-modal, .ui-dialog, md-dialog";
const GI_MESSAGE_SELECTOR = "#toast-container > *, .toast, .k-notification, .noty_bar, .ui-pnotify, .growl, .snackbar, .alert, [role='alert']";
// The only button texts that are ever clicked inside a dialog.
const GI_PASSIVE = /^(close|x|×|✕|✖|cancel|done|dismiss)$/i;
// Clicked only when it is the one button of a plain message (no Cancel beside
// it, no fields, no question mark).
const GI_OK = /^(ok|okay|got it)$/i;
const GI_ERROR_TEXT = /\b(error|failed|failure|unable to|could not|couldn't|cannot|can't|not found|invalid|denied|not authorized|unauthorized|exception|went wrong|try again)\b/i;
const GI_BUSY_TEXT = /please wait|loading|generating|processing|in progress/i;
// Field names the report grid may use for the shipment id. Not "Id": that is
// an internal key and would match some other row.
const GI_SHIPMENT_ID_FIELDS = ["ShipmentID", "ShipmentId", "shipmentId", "Shipment_ID", "Shipment_Id", "shipment_id", "ShipmentNumber", "ShipmentNo", "ShipId"];

// The browser service reports what the page can't see for itself:
// { kind: "window" } · { kind: "download", file } · { kind: "alert", text } · { kind: "confirm", text }
function fpxErpNote(note) {
  if (!fpxErp || fpxErp.done || !fpxErp.notes || !note) return "no job";
  fpxErp.notes.push(note);
  return "ok";
}

function giFatal(message) {
  return Object.assign(new Error(message), { fpxFatal: true });
}

function giText(el) {
  return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
}

// Visible matches, outermost only.
function giVisible(selector) {
  const all = [...document.querySelectorAll(selector)].filter(isVisibleForClick);
  return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
}

function giStillOpen(el) {
  return !!(el && el.isConnected && isVisibleForClick(el));
}

async function giWaitGone(el, ms) {
  for (let i = 0; i < ms / 250; i++) {
    if (!giStillOpen(el)) return true;
    await sleep(250);
  }
  return !giStillOpen(el);
}

// Asks the browser service to pause the job exactly as if Pause had been
// pressed (it logs `text`), then holds here until Resume. Throws on a stop.
// If the pause never arrives the job stops: carrying on unattended is the
// wrong default for this job.
async function erpAskPause(text) {
  const state = fpxErp;
  state.pauseSeq = (state.pauseSeq || 0) + 1;
  state.wantPause = { id: state.pauseSeq, text: String(text) };
  const until = Date.now() + 30000;
  while (!fpxIsPaused()) {
    if (stopRequested) { state.wantPause = null; throw Object.assign(new Error("Stopped by user"), { fpxStop: true }); }
    if (Date.now() > until) {
      state.wantPause = null;
      throw giFatal("Asked the browser service to pause the job and it did not within 30s — stopped here rather than carry on unattended");
    }
    await sleep(300);
  }
  state.wantPause = null;
  await erpCheckpoint();
}

// The report grid on screen: rows as { buttonRow, dataRow } (locked ↔
// scrollable by index, as in the invoice audit), and where the Shipment ID
// column sits in each half (-1 when its header can't be found).
function giGrid() {
  const grids = [...document.querySelectorAll(".k-grid")].filter(isVisibleForClick);
  const grid = grids.find((g) => g.querySelector(".k-grid-content")) || grids[0];
  if (!grid) return null;
  const real = (r) => !r.classList.contains("k-no-data") && !r.classList.contains("k-grouping-row") && !r.classList.contains("k-detail-row");
  const locked = [...grid.querySelectorAll(".k-grid-content-locked tbody tr")].filter(real);
  const scroll = [...grid.querySelectorAll(grid.querySelector(".k-grid-content") ? ".k-grid-content tbody tr" : "tbody tr")].filter(real);
  const pairs = locked.length
    ? scroll.slice(0, Math.min(locked.length, scroll.length)).map((r, i) => ({ buttonRow: locked[i], dataRow: r }))
    : scroll.map((r) => ({ buttonRow: r, dataRow: r }));
  const colOf = (sel) => {
    const ths = [...grid.querySelectorAll(sel)];
    return ths.findIndex((th) => /^shipment\s*(id|#|no\.?|number)$/i.test(giText(th.querySelector("a.k-link") || th)));
  };
  return {
    pairs,
    col: colOf(grid.querySelector(".k-grid-header-wrap") ? ".k-grid-header-wrap thead tr:last-child th" : "thead tr:last-child th"),
    lockedCol: colOf(".k-grid-header-locked thead tr:last-child th"),
  };
}

function giReportOnScreen() {
  return /Transactions/i.test(window.location.href) && !!giGrid();
}

// Rows on screen that are this shipment. The Shipment ID cell must read
// exactly `id`. A match in some other cell only counts when the grid's own
// filter has already narrowed it to this shipment (`filtered`), or when the
// Shipment ID column could not be located and exactly one row has it.
function giRowsFor(id, filtered) {
  const g = giGrid();
  if (!g) return { rows: [], onScreen: 0 };
  const want = String(id).replace(/\s+/g, "");
  const cellIs = (td) => !!td && td.textContent.replace(/\s+/g, "") === want;
  const byCol = g.pairs.filter((p) =>
    (g.col >= 0 && cellIs(p.dataRow.children[g.col])) ||
    (g.lockedCol >= 0 && p.buttonRow !== p.dataRow && cellIs(p.buttonRow.children[g.lockedCol])));
  if (byCol.length) return { rows: byCol, onScreen: g.pairs.length };
  const any = g.pairs.filter((p) => [...p.dataRow.children, ...(p.buttonRow !== p.dataRow ? p.buttonRow.children : [])].some(cellIs));
  if (filtered || (g.col < 0 && g.lockedCol < 0 && any.length === 1)) return { rows: any, onScreen: g.pairs.length };
  return { rows: [], onScreen: g.pairs.length };
}

async function giClearFilter(st) {
  try { await fpxFilterViaKendoApi("", [], { mode: "clear" }); } catch { /* the next lookup starts with another clear */ }
  if (st.uiFilter) {
    st.uiFilter = false;
    try { await clearShipmentIdFilter(); } catch { /* same */ }
  }
}

// Narrow the grid on screen to one shipment and return its rows.
// → { rows, why } (rows empty when it isn't in this tab; `why` says what was tried)
async function giFilterTo(id, st) {
  await giClearFilter(st); // start clean: a miss must not leave the previous shipment's row
  fpxLastInjectDetail = "";
  let confirmed = false; // the grid itself said it now holds only this shipment
  let filtered = false;
  let why = "";
  if (await fpxFilterViaKendoApi(id, GI_SHIPMENT_ID_FIELDS, { titleRe: FPX_SHIPMENT_ID_TITLE_RE })) {
    confirmed = true;
    filtered = true;
  } else {
    why = fpxLastInjectDetail || "the grid's data did not answer";
    // "→ 0 row(s)" = the grid answered and has no such shipment. Anything
    // else = the grid's data could not be reached: use the column's own
    // filter box instead.
    if (!/→ 0 row/.test(why)) {
      await erpCheckpoint();
      st.uiFilter = true;
      try { filtered = (await filterGridByShipmentId(id)) === true; } catch (e) { why += ` | column filter: ${e?.message || e}`; }
    }
  }
  let got = { rows: [], onScreen: 0 };
  for (let k = 0; k < (filtered ? 12 : 3); k++) {
    got = giRowsFor(id, confirmed);
    if (got.rows.length) return { rows: got.rows };
    await sleep(500);
  }
  if (filtered) why = `the filter ran but none of the ${got.onScreen} row(s) on screen shows this shipment id`;
  return { rows: [], why: String(why).slice(0, 200) };
}

// The row for one shipment: the tab on screen first, then the other one.
// → { rows } or { error }
async function giFindRow(id, st) {
  const tabs = [["non-parcel", "Non-Parcel"], ["parcel", "Parcel"]];
  const order = [...tabs.filter((t) => t[0] === st.tab), ...tabs.filter((t) => t[0] !== st.tab)];
  const tried = [];
  for (const [type, label] of order) {
    await erpCheckpoint();
    if (type !== st.tab) {
      await giClearFilter(st);
      const before = erpGridSig();
      if (!clickShipmentTypeTab(type)) { tried.push(`${label}: tab not found`); continue; }
      st.tab = type;
      await humanDelay(800, 1400);
      if (!(await erpWaitGridSettled(before, 60))) { tried.push(`${label}: still loading after 60s`); continue; }
    }
    const r = await giFilterTo(id, st);
    if (r.rows.length) return { rows: r.rows };
    tried.push(`${label}: ${r.why}`);
  }
  return { error: `Not found in the report (${tried.join("; ")})` };
}

// The GET INVOICE control of a row. → { el } or { error }
function giFindButton(pair) {
  const rows = pair.buttonRow === pair.dataRow ? [pair.dataRow] : [pair.buttonRow, pair.dataRow];
  const label = (b) => String(b.textContent || b.value || b.title || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const all = [];
  for (const row of rows) for (const b of row.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button']")) all.push(b);
  const hit = all.find((b) => /^getinvoices?$/.test(label(b).toLowerCase().replace(/[^a-z]/g, "")));
  if (!hit) {
    const texts = [...new Set(all.map(label).filter(Boolean))].slice(0, 8);
    return { error: `No Get Invoice button on this row (buttons: ${texts.join(", ") || "none"})` };
  }
  if (hit.disabled || hit.hasAttribute("disabled") || hit.getAttribute("aria-disabled") === "true" || /(^|\s)(disabled|k-state-disabled)(\s|$)/.test(String(hit.className || ""))) {
    return { error: "The Get Invoice button is disabled on this row" };
  }
  if (!isVisibleForClick(hit)) return { error: "The Get Invoice button is hidden on this row" };
  return { el: hit, text: label(hit) };
}

// What a dialog says and which of its buttons may be clicked.
function giDescribeDialog(d) {
  const full = giText(d);
  const controls = [];
  for (const el of d.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn, a.k-button, .btn, .k-button, [role='button'], a.k-window-action, .close, [data-dismiss]")) {
    if (!isVisibleForClick(el) || controls.some((c) => c.el.contains(el))) continue;
    const text = String(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").replace(/\s+/g, " ").trim();
    const windowAction = el.matches(".k-window-action");
    const closeIcon = windowAction
      ? !!el.querySelector(".k-i-close, .k-i-x, .k-svg-i-x") || /^close$/i.test(el.getAttribute("aria-label") || "")
      : el.matches(".close, [data-dismiss]") && (text.length <= 1 || GI_PASSIVE.test(text));
    if (windowAction && !closeIcon) continue; // minimise / maximise
    const kind = closeIcon || GI_PASSIVE.test(text) ? "passive" : GI_OK.test(text) ? "ok" : "other";
    controls.push({ el, kind, icon: closeIcon && !GI_PASSIVE.test(text), label: closeIcon && text.length <= 1 ? "X" : text || "(unlabelled button)" });
  }
  const passives = controls.filter((c) => c.kind === "passive");
  const oks = controls.filter((c) => c.kind === "ok");
  const others = controls.filter((c) => c.kind === "other");
  const fields = [...d.querySelectorAll("input, select, textarea")].filter((el) =>
    isVisibleForClick(el) && !el.disabled && !el.readOnly && !/^(hidden|button|submit|image|reset)$/i.test(el.type || ""));
  const hasCancel = passives.some((c) => /^cancel$/i.test(c.label));
  // A button that isn't purely "put this away" means a person has to choose.
  const decision = others.length > 0 || oks.length > 1 || (oks.length === 1 && (hasCancel || fields.length > 0 || full.includes("?")));
  const rank = (c) => (/^(close|done|dismiss)$/i.test(c.label) ? 0 : c.icon || /^(x|×|✕|✖)$/i.test(c.label) ? 1 : 2); // Cancel last
  const passive = passives.slice().sort((a, b) => rank(a) - rank(b))[0] || null;
  const errorMark = [...d.querySelectorAll(".text-danger, .alert-danger, .k-i-error, .swal2-error, .sa-error, .fa-exclamation-triangle, .fa-times-circle")].some(isVisibleForClick);
  return {
    text: full.slice(0, 120),
    buttons: controls.map((c) => c.label),
    decision,
    passive,                                   // Close / X / Cancel / Done — never OK
    closer: decision ? null : passive || oks[0] || null,
    busy: !decision && !oks.length && (GI_BUSY_TEXT.test(full) || !!d.querySelector(".progress, .k-progressbar, .spinner, .fa-spinner, .k-loading-image")),
    error: /(^|[\s-])(error|danger)($|[\s-])/i.test(String(d.className || "")) || errorMark || GI_ERROR_TEXT.test(full.slice(0, 300)),
  };
}

function giSnapshot() {
  return {
    href: window.location.href,
    dialogs: new Set(giVisible(GI_DIALOG_SELECTOR)),
    messages: new Map(giVisible(GI_MESSAGE_SELECTOR).map((el) => [el, giText(el)])),
  };
}

// Watch the page after the click. Ends ~3 s after the first thing seen, or
// after the whole ~15 s when nothing shows.
// → { messages: Map(el → { text, error }), dialogs: Map(el → text), loading, href }
async function giObserve(before, state) {
  const seen = { messages: new Map(), dialogs: new Map(), loading: false, href: null };
  let firstAt = -1;
  for (let step = 0; step < GI_OBSERVE_STEPS; step++) {
    if (stopRequested) break;
    const dialogs = giVisible(GI_DIALOG_SELECTOR).filter((d) => !before.dialogs.has(d));
    for (const d of dialogs) seen.dialogs.set(d, giText(d).slice(0, 120) || seen.dialogs.get(d) || "");
    for (const el of giVisible(GI_MESSAGE_SELECTOR)) {
      if (dialogs.some((d) => d.contains(el))) continue;
      const text = giText(el);
      if (!text || before.messages.get(el) === text) continue; // was already there, unchanged
      const had = seen.messages.get(el);
      if (!had || text.length > had.text.length) {
        seen.messages.set(el, { text, error: /error|danger|fail/i.test(String(el.className || "")) || GI_ERROR_TEXT.test(text) });
      }
    }
    const loading = !!document.querySelector(".k-loading-mask, .k-loading-image");
    if (loading) seen.loading = true;
    if (window.location.href !== before.href) seen.href = window.location.href;
    const something = seen.dialogs.size > 0 || seen.messages.size > 0 || seen.href || state.notes.length > 0;
    if (something && firstAt < 0) firstAt = step;
    if (firstAt >= 0 && step - firstAt >= 10 && !loading) break;
    await sleep(300);
  }
  return seen;
}

// Put away every dialog the click opened. `out`: { parts, fail(text), emit(), paused }.
// A dialog that wants an answer, or that has no passive control, is left
// open: the shipment is recorded as failed, the job pauses, and after Resume
// it is closed with Close / X / Cancel if it has one — otherwise the job stops.
async function giSettleDialogs(id, before, out) {
  for (let round = 0; round < 4; round++) {
    const open = giVisible(GI_DIALOG_SELECTOR).filter((d) => !before.dialogs.has(d));
    if (!open.length) return;
    const d = open[open.length - 1]; // the one on top
    let info = giDescribeDialog(d);
    if (info.busy) {
      // A progress message: let it finish by itself (up to 45 s more).
      for (let i = 0; i < 90 && !stopRequested && giStillOpen(d) && giDescribeDialog(d).busy; i++) await sleep(500);
      if (!giStillOpen(d)) { out.parts.push(`"${info.text}" was shown, then went away`); continue; }
      info = giDescribeDialog(d);
      if (info.busy) out.fail(`Still showing "${info.text}" after a minute`);
    }
    if (info.error) out.fail(`Error shown: "${info.text}"`);

    let closedWith = null;
    if (info.closer) {
      await erpCheckpoint();
      simulateClick(info.closer.el);
      if (await giWaitGone(d, 5000)) closedWith = info.closer.label;
    }
    if (closedWith) { out.parts.push(info.error ? `closed with ${closedWith}` : `Dialog opened: "${info.text}" · closed with ${closedWith}`); continue; }

    const buttons = info.buttons.join(", ") || "none";
    out.fail(info.decision
      ? `Needs a decision: ${info.text} — buttons: ${buttons}`
      : `A dialog could not be closed: ${info.text} — buttons: ${buttons}`);
    out.emit();
    await erpAskPause(`Get Invoice · ${id} · FreightPOP is showing "${info.text}" — buttons: ${buttons}. Nothing was chosen. Press Resume to carry on: it is closed with Close or Cancel if it has one, otherwise the job stops`);
    out.paused = true;
    if (!giStillOpen(d)) continue; // someone dealt with it during the pause
    const again = giDescribeDialog(d);
    if (again.passive) {
      simulateClick(again.passive.el);
      if (await giWaitGone(d, 5000)) continue;
    }
    throw giFatal(`Stopped: FreightPOP is still showing "${again.text}" for shipment ${id} and it has no Close or Cancel button that works (buttons: ${again.buttons.join(", ") || "none"}). Close it in FreightPOP, then run the remaining shipments again`);
  }
  if (giVisible(GI_DIALOG_SELECTOR).some((d) => !before.dialogs.has(d))) {
    throw giFatal(`Stopped: dialogs kept opening for shipment ${id} — look at FreightPOP, then run the remaining shipments again`);
  }
}

// optsJson: { from, to, shipmentIds, pauseFirst, runBy } — from / to are YYYY-MM-DD.
async function erpGetInvoices(optsJson) {
  if (fpxErp && !fpxErp.done) return; // already running in this page
  let opts = {};
  try { opts = (typeof optsJson === "string" ? JSON.parse(optsJson) : optsJson) || {}; } catch { opts = {}; }
  stopRequested = false;
  const ids = [...new Set((Array.isArray(opts.shipmentIds) ? opts.shipmentIds : []).map((v) => String(v ?? "").trim()).filter(Boolean))];
  const state = {
    job: "get_invoice", lines: [], results: [], notes: [], wantPause: null, pauseSeq: 0,
    counts: { total: ids.length, done: 0, ok: 0, failed: 0 }, done: null,
  };
  fpxErp = state;
  const st = { tab: "non-parcel", uiFilter: false };
  const summary = () => `${erpNum(state.counts.ok)} of ${erpNum(state.counts.total)} invoice(s) clicked` +
    (state.counts.failed ? ` · ${erpNum(state.counts.failed)} failed` : "") +
    (state.counts.done < state.counts.total ? ` · ${erpNum(state.counts.total - state.counts.done)} not reached` : "");

  const record = (id, ok, note) => {
    state.results.push({ shipment_id: id, ok: !!ok, note: String(note).slice(0, 480), at: new Date().toISOString() });
    state.counts.done++;
    if (ok) state.counts.ok++; else state.counts.failed++;
    erpLog(`Get Invoice · ${id} · ${note}`, ok ? "info" : "warn");
  };

  try {
    const mmddyyyy = (iso) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
      return m ? `${m[2]}/${m[3]}/${m[1]}` : null;
    };
    const fromStr = mmddyyyy(opts.from);
    const toStr = mmddyyyy(opts.to);
    if (!ids.length) throw new Error("No shipments were given to get invoices for");
    if (!fromStr || !toStr) throw new Error(`The report dates could not be read (from "${opts.from}", to "${opts.to}") — expected YYYY-MM-DD`);

    const loginGone = () => giFatal("FreightPOP login expired — sign in to FreightPOP again in the hosted browser, then re-run");
    const openReport = async () => {
      await erpCheckpoint();
      if (erpLoginExpired()) throw loginGone();
      erpLog("Opening Transactions");
      let failNote = null;
      const generated = await invoiceGenerateReport(fromStr, toStr, "non-parcel", "", {
        status: (t) => dlog("[FPX-ERP]", t),
        fail: (t) => { failNote = t; },
        openDialog: true,
        stoppable: true,
        gridWaitSec: 420,
        beforeContinue: async (dateFields) => {
          await erpCheckpoint();
          const f = dateFields.from ? dateFields.from.value : "";
          const t = dateFields.to ? dateFields.to.value : "";
          if (!f || !t) return `Could not fill the report dates (From "${f}", To "${t}")`;
          const cust = erpCheckCustomer();
          if (cust.error) return cust.error;
          // The carrier filter is left exactly as FreightPOP shows it.
          const carrier = erpFindDialogSelect("carrier", cust.select);
          const shown = carrier ? [...carrier.selectedOptions].map((o) => o.text.replace(/\s+/g, " ").trim()).filter(Boolean).join(", ") : "";
          erpLog(`Generate History Report · ${fromStr} to ${toStr} · ${cust.label} · carrier filter untouched${shown ? ` ("${shown}")` : ""}`);
          if (cust.note) erpLog(cust.note, "warn");
          await humanDelay(300, 600);
          return null;
        },
        onGridWait: (sec) => {
          if (sec === 0) erpLog("Continue pressed · waiting for the report (up to 7 min)");
          else if (sec % 15 === 0) erpLog(`Still loading the report · ${sec}s`);
        },
      });
      if (!generated) {
        await erpCheckpoint(); // a stop ends here as "stopped", not as a failure
        if (erpLoginExpired()) throw loginGone();
        throw giFatal(erpReportFailure(failNote));
      }
      st.tab = "non-parcel";
      st.uiFilter = false;
    };

    // One shipment. → true when the job paused for a person along the way.
    const one = async (id) => {
      let clicked = false;
      let emitted = false;
      const out = {
        parts: [], failure: null, paused: false,
        fail(text) { if (!this.failure) this.failure = text; },
        emit() {
          if (emitted) return;
          emitted = true;
          // A failure after the click says so: running it again would click twice.
          const tail = this.failure && clicked ? "the button was clicked" : null;
          record(id, !this.failure, [this.failure, ...this.parts, tail].filter(Boolean).join(" · ") || "Nothing visible changed");
        },
      };
      try {
        let found = await giFindRow(id, st);
        if (found.error) { out.fail(found.error); return false; }
        let btn = giFindButton(found.rows[0]);
        if (btn.error) { out.fail(btn.error); return false; }
        await erpCheckpoint();
        if (!btn.el.isConnected) {
          // The grid redrew (a long pause): look the row up again.
          found = await giFindRow(id, st);
          if (found.error) { out.fail(found.error); return false; }
          btn = giFindButton(found.rows[0]);
          if (btn.error) { out.fail(btn.error); return false; }
          await erpCheckpoint();
        }
        if (found.rows.length > 1) out.parts.push(`${found.rows.length} rows for this shipment — clicked the first`);

        const before = giSnapshot();
        state.notes.length = 0;
        try { btn.el.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* not needed for the click */ }
        // The one click of this shipment. Never repeated.
        simulateClick(btn.el);
        clicked = true;
        const seen = await giObserve(before, state);

        // What the browser service saw.
        for (const n of state.notes.splice(0)) {
          if (n.kind === "window") out.parts.push("A new window opened");
          else if (n.kind === "download") out.parts.push(`A file downloaded${n.file ? `: ${n.file}` : ""}`);
          else if (n.kind === "alert") {
            out.parts.push(`Message: "${String(n.text || "").slice(0, 120)}"`);
            if (GI_ERROR_TEXT.test(String(n.text || ""))) out.fail(`Error shown: "${String(n.text || "").slice(0, 120)}"`);
          } else if (n.kind === "confirm") {
            out.fail(`Needs a decision: ${String(n.text || "").slice(0, 120)} — buttons: OK, Cancel (a browser prompt; cancelled after Resume)`);
            out.paused = true;
          }
        }
        for (const m of seen.messages.values()) {
          if (m.error) out.fail(`Error shown: "${m.text.slice(0, 120)}"`);
          else out.parts.push(`Message: "${m.text.slice(0, 120)}"`);
        }

        for (const [d, text] of seen.dialogs) if (!giStillOpen(d)) out.parts.push(`"${text}" was shown, then went away`);
        await giSettleDialogs(id, before, out);

        if (seen.href) {
          out.parts.push(`The page went to ${(window.location.hash || window.location.pathname).slice(0, 80)}`);
          if (erpLoginExpired()) throw loginGone();
          if (!giReportOnScreen()) {
            history.back();
            for (let i = 0; i < 20 && !giReportOnScreen(); i++) await sleep(500);
          }
        }
        if (!giReportOnScreen()) {
          // Back at the grid is part of "ok". Getting the report again is the
          // only way back; if that fails the job ends (report not loading).
          out.fail("The page did not come back to the report by itself");
          out.emit();
          erpLog("The report is no longer on screen — generating it again", "warn");
          await openReport();
        } else if (!out.parts.length && !out.failure) {
          // Nothing appeared: say whether the row itself changed.
          const now = giRowsFor(id, true).rows[0];
          const nowBtn = now ? giFindButton(now) : null;
          if (!now) out.parts.push(seen.loading ? "The list reloaded and the row is no longer in it" : "The row is no longer in the list");
          else if (nowBtn.error) out.parts.push("The row no longer has a Get Invoice button");
          else if (nowBtn.text !== btn.text) out.parts.push(`The button now reads "${nowBtn.text}"`);
          else if (seen.loading) out.parts.push("The list reloaded");
        }
        return out.paused;
      } catch (e) {
        if (e && (e.fpxStop || e.fpxFatal)) {
          if (clicked) out.fail(e.fpxStop ? "Stopped before the result could be checked" : String(e.message));
          throw e;
        }
        // Anything else is this shipment's failure, not the job's.
        out.fail(`${clicked ? "Clicked, then: " : ""}${e?.message || e}`);
        return out.paused;
      } finally {
        // A shipment that was clicked always gets its line, stop or not.
        if (clicked || out.failure) out.emit();
      }
    };

    await openReport();
    erpLog(`Report on screen · ${erpNum(ids.length)} shipment(s) to do, one at a time`);

    for (let i = 0; i < ids.length; i++) {
      await erpCheckpoint();
      if (erpLoginExpired()) throw loginGone();
      if (!giReportOnScreen()) {
        erpLog("The report is no longer on screen — generating it again", "warn");
        await openReport();
      }
      const failedBefore = state.counts.failed;
      const paused = await one(ids[i]);
      const left = ids.length - i - 1;
      if (i === 0 && opts.pauseFirst && left > 0 && !paused) {
        await erpAskPause(state.counts.failed > failedBefore
          ? `First shipment could not be done — check it in FreightPOP, then press Resume to continue with the other ${left}`
          : `First invoice done — check it in FreightPOP, then press Resume to continue with the other ${left}`);
      }
      if (left > 0) await humanDelay(1500, 3000);
    }

    await giClearFilter(st);
    erpLog(summary(), "done");
    state.done = { ok: true, note: summary(), result: null };
  } catch (e) {
    if (e && e.fpxStop) {
      state.done = { ok: true, stopped: true, result: null, note: summary() };
    } else {
      console.warn("[FPX-ERP] get invoices failed:", e?.message || e);
      state.done = { ok: false, note: `${String(e?.message || e)}${state.counts.done ? ` — ${summary()}` : ""}`, result: null };
    }
  }
}

// =====================================================================
// MESSAGE LISTENER
// =====================================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  dlog("[FPX] Message received:", msg);
  if (msg.action === "ping") {
    sendResponse({ ok: true });
  } else if (msg.action === "start") {
    run(msg.filterCol, msg.filterVal);
    sendResponse({ ok: true });
  } else if (msg.action === "stop") {
    stopRequested = true;
    sendResponse({ ok: true });
  } else if (msg.action === "gpAudit") {
    gpAuditRun(msg.fromDate, msg.toDate, msg.shipmentType, msg.aiAnalysis, msg.customerFilter);
    sendResponse({ ok: true });
  } else if (msg.action === "invoiceAudit") {
    invoiceAuditRun(msg.shipments, msg.skippedRows, msg.fromDate, msg.toDate, msg.shipmentType, msg.customerFilter, msg.aiAnalysis, msg.skipReport);
    sendResponse({ ok: true });
  }
});

// =====================================================================
// FreightPOP iframe ↔ FPXpress dashboard bridge
//
// When the FreightPOP page is loaded inside the FPXpress dashboard's
// iframe (the "FreightPOP" embed), the dashboard can't reach across
// origins to filter the Kendo grid for the focused shipment. This
// extension's content script DOES run inside that iframe (its host
// permissions match app.freightpop.com regardless of frame depth),
// so it can act as a postMessage bridge.
//
// Protocol (window.postMessage from the dashboard parent):
//   { source: "fpxpress", type: "fpxFilter",
//     column: "Tracking Number" | "Shipment status" | …,
//     value:  "<filter value>" }
//
// We accept messages only when (a) the message has the magic source
// tag (so we don't react to FreightPOP's own postMessages) and
// (b) the parent's origin matches the FPXpress dashboard hosts we
// trust. Anyone embedding FreightPOP as a third-party can't drive
// the filter.
// =====================================================================
const FPX_TRUSTED_PARENT_ORIGINS = [
  "https://fpxpress.netlify.app",
  "https://fpx.netlify.app",
  "http://localhost:5173",
  "http://localhost:4173",
];

function fpxIsTrustedParentOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  if (FPX_TRUSTED_PARENT_ORIGINS.includes(origin)) return true;
  // Allow Netlify deploy-preview / branch subdomains under the same site.
  if (/^https:\/\/(?:[a-z0-9-]+--)?fpxpress\.netlify\.app$/.test(origin)) return true;
  if (/^https:\/\/deploy-preview-\d+--fpxpress\.netlify\.app$/.test(origin)) return true;
  return false;
}

// Drive the Kendo grid's underlying dataSource directly via the page's
// main-world jQuery + Kendo. The content script's isolated world doesn't
// see window.jQuery (that's a hard Chrome boundary), so we inject
// inject-kendo-filter.js as a real <script> tag, pass the value via
// data-* attributes, and listen for its postMessage result.
//
// Returns true if the filter was applied, false otherwise. Times out at
// 1.5s — if the page didn't answer by then, jQuery / Kendo wasn't
// available and the bridge falls back to the column-filter UI path.
// Most recent inject-script detail string — surfaced to the dashboard
// in the fpxFilterAck so failures are debuggable from the parent's
// console without DevTools-frame-switching.
let fpxLastInjectDetail = "";

// Drive the Kendo column-filter popup (open icon → set "Is equal to" →
// fill input via Kendo widget API → click Filter) entirely in the page's
// main world. This is the same flow that the existing "Mode → LTL" path
// uses, but ported to a free-text column. Required for Tracking Number
// because the popup's text input is a Kendo widget whose value() method
// is only reachable from the main world (jQuery.data(...) doesn't work
// across the content-script isolated boundary).
function fpxFilterViaKendoPopup(colName, value) {
  return new Promise((resolve) => {
    const requestId = "fpx-popup-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    let settled = false;
    function onMessage(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.type !== "fpx-kendo-popup-result" || d.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      settled = true;
      fpxLastInjectDetail = d.detail || "";
      dlog("[FPX] Inject popup result:", d.ok ? "ok" : "fail", "—", d.detail);
      resolve(!!d.ok);
    }
    window.addEventListener("message", onMessage);

    let scriptUrl;
    try { scriptUrl = chrome.runtime.getURL("inject-kendo-popup.js"); }
    catch { resolve(false); return; }
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.setAttribute("data-fpx-request-id", requestId);
    script.setAttribute("data-fpx-column", String(colName));
    script.setAttribute("data-fpx-value", String(value));
    script.onload = () => script.remove();
    script.onerror = () => {
      script.remove();
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        dlog("[FPX] inject-kendo-popup.js failed to load");
        resolve(false);
      }
    };
    (document.head || document.documentElement).appendChild(script);

    setTimeout(() => {
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        dlog("[FPX] Kendo popup driver timed out");
        resolve(false);
      }
    }, 4000);
  });
}
// opts: { mode: "filter"|"clear", titleRe: "regex for column titles" }
// Resolves true only when the filter matched at least one row (the injector
// restores the previous filter on a zero-row miss).
function fpxFilterViaKendoApi(value, fieldCandidates, opts = {}) {
  return new Promise((resolve) => {
    const requestId = "fpx-filter-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    let settled = false;
    function onMessage(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.type !== "fpx-kendo-filter-result" || d.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      settled = true;
      fpxLastInjectDetail = d.detail || "";
      dlog("[FPX] Inject filter result:", d.ok ? "ok" : "fail", "—", d.detail);
      resolve(!!d.ok);
    }
    window.addEventListener("message", onMessage);

    let scriptUrl;
    try { scriptUrl = chrome.runtime.getURL("inject-kendo-filter.js"); }
    catch { resolve(false); return; }
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.setAttribute("data-fpx-request-id", requestId);
    script.setAttribute("data-fpx-value", String(value));
    script.setAttribute("data-fpx-fields", JSON.stringify(fieldCandidates || ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"]));
    script.setAttribute("data-fpx-mode", opts.mode || "filter");
    if (opts.op) script.setAttribute("data-fpx-op", opts.op);
    if (opts.titleRe) script.setAttribute("data-fpx-title-re", opts.titleRe);
    if (opts.keepEmpty) script.setAttribute("data-fpx-keep-empty", "1");
    script.onload = () => script.remove();
    script.onerror = () => {
      script.remove();
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        dlog("[FPX] inject-kendo-filter.js failed to load");
        resolve(false);
      }
    };
    (document.head || document.documentElement).appendChild(script);

    setTimeout(() => {
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        dlog("[FPX] Kendo API filter timed out (jQuery not on page?)");
        resolve(false);
      }
      // Each candidate field can take up to ~16s (server load + restore on a
      // zero-row miss), so allow a few of them.
    }, 45000);
  });
}

// Native value setter — required when programmatically filling React /
// Kendo inputs so their internal state listeners actually run. A plain
// `input.value = "..."` mutates the DOM but the framework misses it.
function fpxSetReactInputValue(input, value) {
  const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// Try the page's top-level "Tracking Number" search box first — that's
// what the FPXpress dashboard exposes (Dashboard / In Transit views).
// If the input + Search button are present, this is far more reliable
// than poking at column-level Kendo filters.
async function fpxFillTopSearch(value) {
  // Enumerate plausible inputs. Match by adjacent label text or placeholder.
  const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
  function labelMatches(el) {
    const ph = (el.placeholder || el.getAttribute("aria-label") || "").toLowerCase();
    if (ph.includes("tracking")) return true;
    // Walk up to a small wrapper, then look for a label with "Tracking" in it.
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      n = n.parentElement;
      if (!n) break;
      const lbl = n.querySelector?.("label");
      if (lbl && /tracking/i.test(lbl.textContent || "")) return true;
    }
    // Sibling text node (some pages render label as plain text before input).
    const prev = el.previousElementSibling;
    if (prev && /tracking/i.test(prev.textContent || "")) return true;
    return false;
  }
  const target = inputs.find(labelMatches);
  if (!target) return false;
  fpxSetReactInputValue(target, value);
  // Look for a Search button on the same row (very small DOM neighborhood).
  let host = target.parentElement;
  for (let i = 0; i < 5 && host; i++) {
    const btn = Array.from(host.querySelectorAll("button, a")).find(
      (b) => /^\s*search\s*$/i.test(b.textContent || ""),
    );
    if (btn) { btn.click(); return true; }
    host = host.parentElement;
  }
  // No explicit Search button — try Enter on the input. Some grids submit
  // on enter via React handlers.
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", bubbles: true }));
  return true;
}

// Column titles that mean "tracking number" — and NOT "Tracking Comments".
const FPX_TRACKING_TITLE_RE = "^\\s*tracking\\s*(number|#|no\\.?)?\\s*$";
const FPX_SHIPMENT_ID_FIELDS = ["ShipmentId", "ShipmentID", "shipmentId", "Shipment_Id", "shipment_id", "ShipmentNumber", "ShipmentNo", "ShipId", "Id", "ID"];
// The dashboard grid's "Shipment Id" column uses a field name we can't
// predict, so also match it by column TITLE.
const FPX_SHIPMENT_ID_TITLE_RE = "^\\s*shipment\\s*(id|#|no\\.?|number)\\s*$";
const FPX_TRACKING_FIELDS = ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number", "TrackingNo", "ProNumber"];

// A Kendo grid is on screen and initialised — even if it currently shows "No
// items to display". (fpxEnsureGridReady waits for ROWS, which made an empty
// filter result look like "grid not loaded" forever.)
async function fpxGridExists(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.readyState === "complete" && document.querySelector(".k-grid .k-grid-header, .k-grid .k-pager-wrap, .k-grid .k-pager, .k-grid .k-grid-pager")) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function fpxVisibleRowCount() {
  return Array.from(document.querySelectorAll(".k-grid-content tbody tr, .k-grid tbody tr"))
    .filter((tr) => !tr.classList.contains("k-no-data") && tr.offsetParent !== null && (tr.textContent || "").trim()).length;
}

// Wait for a visible grid row that is actually the target shipment (its
// text contains the shipment id or tracking number) — not just "any row".
async function fpxWaitForTargetRow(needles, timeoutMs = 10000) {
  const want = needles.map((n) => String(n || "").trim()).filter(Boolean);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = Array.from(document.querySelectorAll(".k-grid-content tbody tr, .k-grid tbody tr"))
      .some((tr) => tr.offsetParent !== null && want.some((w) => (tr.textContent || "").includes(w)));
    if (hit) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Find one shipment in the dashboard grid. Tries, in order:
//   1. Kendo filter on the Shipment Id column (always present on the
//      dashboard, exact numeric match)
//   2. Kendo filter on a real tracking-number field
//   3. FreightPOP's own "Tracking Number" search box + SEARCH (searches across
//      tabs, server-side)
// A miss never leaves the grid empty: the injector restores the previous
// filter, and if everything misses we clear our filters.
async function fpxFindShipment(shipmentId, trackingNumber) {
  const sid = String(shipmentId || "").trim();
  const tn = String(trackingNumber || "").trim();
  if (!sid && !tn) return { ok: false, error: "Nothing to look up" };
  if (!(await fpxGridExists(8000))) {
    return { ok: false, reason: "grid-not-ready", error: `FreightPOP grid not loaded (${fpxDescribeFrameState()})` };
  }
  const details = [];
  // Start clean: drop filters left by an earlier lookup, so a miss can't
  // "restore" the previous shipment and pass for this one.
  try { await fpxFilterViaKendoApi("", [], { mode: "clear" }); } catch {}
  if (sid && /^\d+$/.test(sid)) {
    if (await fpxFilterViaKendoApi(sid, FPX_SHIPMENT_ID_FIELDS, { titleRe: FPX_SHIPMENT_ID_TITLE_RE })) return { ok: true, strategy: "shipment-id", injectDetail: fpxLastInjectDetail };
    details.push("shipment id: " + fpxLastInjectDetail);
  }
  if (tn) {
    if (await fpxFilterViaKendoApi(tn, FPX_TRACKING_FIELDS, { titleRe: FPX_TRACKING_TITLE_RE })) return { ok: true, strategy: "tracking-field", injectDetail: fpxLastInjectDetail };
    details.push("tracking field: " + fpxLastInjectDetail);
    // FreightPOP sometimes stores the number differently (e.g. without the
    // leading zero: 069931950 vs 69931950). Contains-match the core digits;
    // the injector only accepts it when exactly one row matches.
    const core = tn.replace(/^0+/, "") || tn;
    if (core.length >= 6 && await fpxFilterViaKendoApi(core, FPX_TRACKING_FIELDS, { titleRe: FPX_TRACKING_TITLE_RE, op: "contains" })) {
      return { ok: true, strategy: "tracking-contains", injectDetail: fpxLastInjectDetail };
    }
    details.push("tracking contains: " + fpxLastInjectDetail);
    try {
      if (await fpxFillTopSearch(tn)) {
        // FreightPOP reloads the grid after SEARCH; only a row showing this
        // shipment counts.
        if (await fpxWaitForTargetRow([sid, tn], 12000)) return { ok: true, strategy: "freightpop-search", injectDetail: details.join(" || ") };
        details.push(`FreightPOP search for ${tn}: no row with ${sid || tn}`);
      }
    } catch (e) { details.push("FreightPOP search threw: " + (e?.message || e)); }
  }
  // Not found. Like the extension's own filter: leave the grid filtered to
  // this Shipment Id (or tracking #) so it visibly shows 0 items — the user
  // can see it isn't on this dashboard — instead of an unfiltered grid that
  // looks like the lookup never ran. FreightPOP's "Reset Grid Settings" or
  // the column filter clears it.
  try { await fpxFilterViaKendoApi("", [], { mode: "clear" }); } catch {}
  let shown = false;
  try {
    shown = sid && /^\d+$/.test(sid)
      ? await fpxFilterViaKendoApi(sid, FPX_SHIPMENT_ID_FIELDS, { titleRe: FPX_SHIPMENT_ID_TITLE_RE, keepEmpty: true })
      : tn ? await fpxFilterViaKendoApi(tn, FPX_TRACKING_FIELDS, { titleRe: FPX_TRACKING_TITLE_RE, keepEmpty: true }) : false;
    if (shown) details.push("shown empty: " + fpxLastInjectDetail);
  } catch {}
  return {
    ok: false,
    reason: "not-on-dashboard",
    shownEmpty: !!shown,
    error: `Shipment ${sid || tn} isn't on this FreightPOP dashboard${shown ? " — the grid is filtered to it and shows 0 items" : ""}. It may be delivered, cancelled, or under Return / Pending Shipments.`,
    injectDetail: details.join(" || "),
  };
}

// Click the row's tracking link (or its DETAILS button) to open FreightPOP's
// own shipment modal. Assumes the grid is already filtered to the shipment.
async function fpxOpenShipmentModal(shipmentId, trackingNumber) {
  await new Promise((r) => setTimeout(r, 400));
  const tn = String(trackingNumber || "").trim();
  const sid = String(shipmentId || "").trim();
  const jobs = collectShipmentJobs();
  let match = tn ? jobs.find((j) => (j.link?.textContent || "").trim() === tn) : null;
  if (!match && jobs.length === 1) match = jobs[0];
  if (match?.link) { simulateClick(match.link); return { ok: true }; }
  // Fall back to the DETAILS button on the row that shows this shipment id.
  const row = Array.from(document.querySelectorAll(".k-grid tbody tr"))
    .find((tr) => (sid && (tr.textContent || "").includes(sid)) || (tn && (tr.textContent || "").includes(tn)));
  const btn = row && Array.from(row.querySelectorAll("a, button")).find((b) => /details|track/i.test(b.textContent || ""));
  if (btn) { simulateClick(btn); return { ok: true }; }
  return { ok: false, reason: "open-failed", error: "Found it — the grid is filtered to this shipment. Click its tracking number in the grid to open the details." };
}

// Bridge command handler, shared by two transports:
//   1. window.postMessage from the dashboard parent (iframe embed, below).
//   2. The hosted browser service (browser-service/), which calls this
//      function directly in the content script's isolated world over CDP
//      Runtime.evaluate — there is no parent frame in that setup.
// Returns the ack payload (without the `source` tag) or null when there is
// nothing to answer.
async function fpxBridgeHandle(data) {
  if (!data || typeof data !== "object") return null;
  if (data.type === "fpxFindShipment") {
    // { shipmentId, trackingNumber, open }
    sendStatus(`Bridge: finding shipment ${data.shipmentId || data.trackingNumber}`);
    const found = await fpxFindShipment(data.shipmentId, data.trackingNumber);
    if (!found.ok || !data.open) return { type: "fpxFindAck", ...found, opened: false };
    const opened = await fpxOpenShipmentModal(data.shipmentId, data.trackingNumber);
    // Found but the popup didn't open: still a successful lookup (the grid
    // shows the row) — say so instead of reporting a failure.
    return { type: "fpxFindAck", ...found, opened: opened.ok, ok: true, reason: opened.ok ? undefined : "open-failed", note: opened.ok ? null : opened.error };
  }
  if (data.type === "fpxFilter") {
    const col = String(data.column || "").trim();
    const val = String(data.value || "").trim();
    if (!col || !val) return null;
    // The dashboard fires this as soon as any FreightPOP frame says hello —
    // which includes FP's login page (third-party cookies) and the first
    // seconds before Kendo has rendered. Running the strategy chain there
    // can only fail, and every failure used to land as a console.warn on
    // the chrome://extensions Errors page. Wait briefly for a grid; if
    // none shows up, answer quietly and let fpxGridReady trigger a resend.
    if (!(await fpxEnsureGridReady(6000))) {
      const reason = fpxDescribeFrameState();
      dlog(`[FPX] Bridge filter deferred — ${reason}`);
      return {
        type: "fpxFilterAck",
        column: col,
        value: val,
        ok: false,
        reason: "grid-not-ready",
        error: `FreightPOP grid not loaded in this frame (${reason}). The filter will re-apply once the grid appears.`,
        injectDetail: "",
      };
    }
    sendStatus(`Bridge: filtering ${col} → "${val}"`);
    let applied = false;
    let strategy = "";
    let lastErr = null;
    // Strategy 1: Kendo dataSource API (most reliable; bypasses UI).
    // Runs in the page's main world via inject-kendo-filter.js so it can
    // see window.jQuery + Kendo widgets (content scripts are sandboxed
    // away from those by Chrome's isolated-world rules).
    try {
      if (await fpxFilterViaKendoApi(val, ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"], { titleRe: FPX_TRACKING_TITLE_RE })) {
        applied = true; strategy = "kendo-api";
      }
    } catch (e) { lastErr = e; }
    // Strategy 1b: Kendo popup driver in main world. Same UI path the
    // "Mode → LTL" flow uses (open filter icon → set "Is equal to" →
    // fill input → click Filter), but the value-fill goes through the
    // input's Kendo widget API which only works from the main world.
    // Fixes the symptom where the popup opens but the text never
    // sticks, especially on Tracking Number.
    if (!applied) {
      try {
        if (await fpxFilterViaKendoPopup(col, val)) {
          applied = true; strategy = "kendo-popup-main-world";
        }
      } catch (e) { lastErr = e; }
    }
    // Strategy 2: top-level Tracking Number search input (Dashboard view
    // doesn't always have a Tracking Number column at all — but it has
    // a free-form Tracking Number search box at the top of the page).
    if (!applied && col.toLowerCase().includes("tracking")) {
      try {
        applied = await fpxFillTopSearch(val);
        if (applied) strategy = "top-search";
      } catch (e) { lastErr = e; }
    }
    // Strategy 3: Kendo column-header UI filter (Transactions view).
    // Tries the requested column first, then falls back to common
    // synonyms ("Tracking Number" ↔ "Tracking #" ↔ "Tracking No").
    if (!applied) {
      const candidates = [col];
      if (col.toLowerCase().includes("tracking")) {
        candidates.push("Tracking Number", "Tracking #", "Tracking No", "Tracking");
      }
      for (const c of candidates) {
        try {
          await applyFilter(c, val);
          applied = true; strategy = `kendo-ui:${c}`;
          break;
        } catch (e) { lastErr = e; }
      }
    }
    if (applied) {
      dlog(`[FPX] Bridge filter ok via ${strategy}: ${col}="${val}"`);
      return { type: "fpxFilterAck", column: col, value: val, ok: true, strategy, injectDetail: fpxLastInjectDetail };
    } else {
      console.warn("[FPX] Bridge filter failed (all strategies):", lastErr, "inject:", fpxLastInjectDetail);
      return {
        type: "fpxFilterAck",
        column: col,
        value: val,
        ok: false,
        error: String(lastErr?.message || lastErr || "no matching input"),
        injectDetail: fpxLastInjectDetail,
      };
    }
  } else if (data.type === "fpxOpenTracking") {
    // Open FreightPOP's native tracking modal for a specific tracking
    // number — without leaving the embedded iframe. We first apply the
    // tracking-number filter so the row is guaranteed to be visible,
    // wait briefly for the grid to re-render, then simulate a click on
    // the row's tracking link (the same UI path a rep takes manually).
    const tn = String(data.trackingNumber || "").trim();
    if (!tn) return null;
    let openOk = false;
    let openErr = null;
    if (!(await fpxEnsureGridReady(6000))) {
      openErr = `FreightPOP grid not loaded in this frame (${fpxDescribeFrameState()})`;
      dlog(`[FPX] Bridge open-tracking skipped — ${openErr}`);
      return { type: "fpxOpenTrackingAck", trackingNumber: tn, ok: false, reason: "grid-not-ready", error: openErr };
    }
    sendStatus(`Bridge: opening modal for ${tn}`);
    try {
      // Filter first so the matching row is on-screen; ignore failure
      // here because the row may already be visible from a prior filter.
      try { await fpxFilterViaKendoApi(tn, ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"], { titleRe: FPX_TRACKING_TITLE_RE }); } catch {}
      // Give the grid a beat to re-render the filtered rowset before
      // hunting for the link. 400ms covers slow Kendo redraws on rep
      // laptops without making the click feel laggy.
      await new Promise((r) => setTimeout(r, 400));
      // Walk the visible rows and pick the link whose text matches the
      // requested tracking number. Reuses collectShipmentJobs() so the
      // selector heuristics stay in lockstep with the bulk scrape path.
      const jobs = collectShipmentJobs();
      const match = jobs.find((j) => (j.link?.textContent || "").trim() === tn);
      if (match?.link) {
        simulateClick(match.link);
        openOk = true;
      } else {
        openErr = "Tracking link not found in the filtered grid";
      }
    } catch (e) {
      openErr = String(e?.message || e || "Unknown error");
    }
    return { type: "fpxOpenTrackingAck", trackingNumber: tn, ok: openOk, error: openErr };
  } else if (data.type === "fpxPing") {
    // Lets the dashboard detect whether the extension is installed +
    // running inside this iframe. No filter side effects.
    return { type: "fpxPong" };
  }
  return null;
}

// Transport 1: postMessage from the dashboard parent frame.
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.source !== "fpxpress") return;
  if (!fpxIsTrustedParentOrigin(event.origin)) {
    console.warn("[FPX] Ignored bridge message from untrusted origin:", event.origin);
    return;
  }
  const ack = await fpxBridgeHandle(data);
  if (!ack) return;
  try { event.source && event.source.postMessage({ source: "fpx-extension", ...ack }, event.origin); } catch {}
});

// Announce presence to the parent on every load so the dashboard's overlay
// can show an "extension connected" indicator without polling. Parent's
// origin is unknown until it greets us; the targetOrigin '*' is fine here
// because the payload is just a presence ping with no privileged data.
try {
  if (window.parent !== window) {
    window.parent.postMessage({ source: "fpx-extension", type: "fpxHello" }, "*");
  }
} catch {}

// True once the Kendo grid in this frame has at least one data row; waits
// up to `timeoutMs` for it to render.
async function fpxEnsureGridReady(timeoutMs = 6000) {
  try {
    const existing = document.querySelector(".k-grid-content tbody tr, .k-grid tbody tr");
    if (existing && !existing.classList.contains("k-no-data")) return true;
    return !!(await waitForGridWithObserver(timeoutMs));
  } catch { return false; }
}

// Short human-readable reason for "no grid here", surfaced in the bridge ack
// so the dashboard can tell the operator what to do (log in, wait, open the
// Transactions view) instead of showing a generic failure.
function fpxDescribeFrameState() {
  try {
    if (document.querySelector("input[type='password']")) return "FreightPOP login page — sign in inside the frame";
    if (document.readyState !== "complete") return "page still loading";
    if (document.querySelector(".k-grid")) return "grid has no rows yet";
    return "no shipment grid on this view";
  } catch { return "frame state unknown"; }
}

// Tell the dashboard when the grid actually becomes usable in this frame
// (after login, after FP finishes rendering). The dashboard re-sends any
// filter that was deferred with reason "grid-not-ready". Observer
// disconnects as soon as the first row appears, or after 5 minutes.
(async function fpxAnnounceGridReady() {
  if (window.parent === window) return;
  try {
    if (await fpxEnsureGridReady(5 * 60 * 1000)) fpxTellParent({ type: "fpxGridReady" });
  } catch {}
})();

// =====================================================================
// Third-party cookie recovery for the FPXpress embed.
//
// The dashboard is served from netlify.app; FreightPOP runs on
// freightpop.com. Because netlify.app is on the Public Suffix List those
// are different *sites*, so inside the FPXpress iframe FreightPOP's
// session cookies are third-party and the browser refuses to send them.
// FP therefore shows its login on every load, and the operator reads that
// as "the embed keeps logging me out". Note the cookie is not missing —
// the browser simply won't attach it in a third-party context, which is
// why no amount of "saving the session" on the dashboard side can help.
//
// The Storage Access API is the sanctioned fix, and it can only be driven
// from INSIDE the embedded frame: it needs transient activation from a
// real user gesture *in that frame*, plus the storage-access permission
// policy from the embedder (the dashboard already sets
// allow="storage-access *"). The dashboard cannot call it on the frame's
// behalf — a click in the parent does not confer activation on a
// cross-origin child. This content script does run in the frame, so it
// can: it renders its own one-click affordance inside the FP page and
// calls requestStorageAccess() from that click.
//
// On a grant we reload the frame so FP's next request finally carries the
// cookie. On a denial we report it, so the dashboard can stop guessing and
// point the operator at "New tab" instead.
// =====================================================================
const FPX_SA_DISMISS_KEY = "fpx.storageAccess.dismissed";

// Which origin is embedding us. ancestorOrigins is exact where supported;
// document.referrer is the fallback (the dashboard's iframe sends a full
// referrer for https→https).
function fpxParentOrigin() {
  try {
    const ao = location.ancestorOrigins;
    if (ao && ao.length) return ao[ao.length - 1];
  } catch {}
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch {}
  return "";
}

function fpxTellParent(payload) {
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ source: "fpx-extension", ...payload }, "*");
    }
  } catch {}
}

async function fpxStorageAccessState() {
  const supported = typeof document.hasStorageAccess === "function";
  let hasAccess = null;
  if (supported) {
    try { hasAccess = await document.hasStorageAccess(); } catch { hasAccess = null; }
  }
  return {
    supported,
    hasAccess,
    // Weak but useful corroboration: HttpOnly cookies never appear here, so
    // an empty string doesn't prove blocking — but a non-empty one proves
    // some cookie access exists.
    cookiesVisible: (document.cookie || "").length > 0,
  };
}

function fpxRenderStorageAccessPrompt() {
  try { if (sessionStorage.getItem(FPX_SA_DISMISS_KEY) === "1") return; } catch {}
  if (!document.body || document.getElementById("fpx-sa-bar")) return;

  const bar = document.createElement("div");
  bar.id = "fpx-sa-bar";
  bar.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
    "display:flex", "align-items:center", "gap:12px",
    "padding:10px 14px", "box-sizing:border-box",
    "background:#fffbeb", "border-bottom:1px solid #fde68a",
    "color:#78350f", "font:500 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif",
    "box-shadow:0 1px 3px rgba(0,0,0,.08)",
  ].join(";");

  const msg = document.createElement("div");
  msg.style.cssText = "flex:1;min-width:0";
  msg.textContent = "FreightPOP can't keep you signed in inside FPX Control Station — your browser is blocking its cookies here.";

  const allow = document.createElement("button");
  allow.type = "button";
  allow.textContent = "Allow cookies";
  allow.style.cssText = [
    "flex:none", "cursor:pointer", "padding:6px 12px", "border-radius:6px",
    "border:1px solid #b45309", "background:#b45309", "color:#fff",
    "font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif",
  ].join(";");

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.style.cssText = [
    "flex:none", "cursor:pointer", "padding:6px 10px", "border-radius:6px",
    "border:1px solid #fcd34d", "background:transparent", "color:#92400e",
    "font:500 12px/1 system-ui,-apple-system,Segoe UI,sans-serif",
  ].join(";");

  allow.addEventListener("click", async () => {
    // This handler IS the transient activation requestStorageAccess needs.
    allow.disabled = true;
    allow.textContent = "Requesting…";
    try {
      await document.requestStorageAccess();
      fpxTellParent({ type: "fpxStorageAccess", supported: true, hasAccess: true, granted: true });
      bar.remove();
      // FP already rendered without its cookie; only a reload re-issues the
      // request now that the cookie will be attached.
      location.reload();
    } catch (e) {
      const detail = String((e && e.message) || e || "denied");
      fpxTellParent({ type: "fpxStorageAccess", supported: true, hasAccess: false, granted: false, error: detail });
      msg.textContent = "The browser denied cookie access for FreightPOP here. Use \"New tab\" in the FPX header — it isn't affected.";
      allow.remove();
    }
  });

  dismiss.addEventListener("click", () => {
    try { sessionStorage.setItem(FPX_SA_DISMISS_KEY, "1"); } catch {}
    bar.remove();
  });

  bar.appendChild(msg);
  bar.appendChild(allow);
  bar.appendChild(dismiss);
  document.body.appendChild(bar);
}

(async function fpxInitStorageAccess() {
  // Only inside the FPXpress embed. In a normal FreightPOP tab there is no
  // third-party context and nothing to fix — never touch FP's own page there.
  if (window.parent === window) return;
  if (!fpxIsTrustedParentOrigin(fpxParentOrigin())) return;

  const state = await fpxStorageAccessState();
  fpxTellParent({ type: "fpxStorageAccess", ...state });

  // Only prompt when the browser positively tells us access is absent.
  // supported === false (older browser) or hasAccess === null (threw) are
  // both "we don't know", and guessing is what makes these banners noise.
  if (state.supported && state.hasAccess === false) {
    fpxRenderStorageAccessPrompt();
  }
})();
