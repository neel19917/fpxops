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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random delay between min and max ms — prevents robotic timing patterns
function humanDelay(minMs, maxMs) {
  const jitter = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(jitter));
}

// Yield to the browser so it can paint/reflow — prevents "page unresponsive"
function yieldToBrowser() {
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
function waitForCloseButton(timeout = 25000) {
  return new Promise((resolve) => {
    const interval = 400;
    let elapsed = 0;

    const timer = setInterval(() => {
      const btn = findModalDismissControl();
      if (btn) {
        clearInterval(timer);
        resolve(btn);
        return;
      }
      elapsed += interval;
      if (elapsed >= timeout) {
        clearInterval(timer);
        resolve(null);
      }
    }, interval);
  });
}

// Poll for an element matching `selector` to appear in the DOM (visible).
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const interval = 300;
    let elapsed = 0;
    const timer = setInterval(() => {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) {
        clearInterval(timer);
        resolve(el);
        return;
      }
      elapsed += interval;
      if (elapsed >= timeout) {
        clearInterval(timer);
        resolve(null);
      }
    }, interval);
  });
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
  const labels = modal.querySelectorAll("label, strong, b, .field-label, .control-label, dt");
  for (const lbl of labels) {
    const key = lbl.textContent.trim().replace(/:$/, "");
    if (!key || key.length > 80) continue;
    if (key === "CLOSE") continue;
    if (data[key]) continue;                                // first-write-wins; don't overwrite

    let val = "";
    const next = lbl.nextElementSibling;
    if (next) {
      val = (next.value || next.textContent || "").trim();
    }
    // Sibling-of-parent: <div><label/></div><div>VALUE</div>
    if (!val && lbl.parentElement && lbl.parentElement.nextElementSibling) {
      const sib = lbl.parentElement.nextElementSibling;
      const sibText = (sib.textContent || "").trim();
      if (sibText && sibText.length < MAX_VALUE_LEN) val = sibText;
    }

    if (!val) continue;
    val = val.replace(/\s+/g, " ").trim();
    if (val.length > MAX_VALUE_LEN) val = val.slice(0, MAX_VALUE_LEN).replace(/\s+\S*$/, "") + "…";
    data[key] = val;
  }

  // Pattern B: table rows with th/td pairs inside the modal
  const rows = modal.querySelectorAll("table tr");
  for (const row of rows) {
    const th = row.querySelector("th, td:first-child");
    const td = row.querySelector("td:last-child");
    if (th && td && th !== td) {
      const key = th.textContent.trim().replace(/:$/, "");
      const val = td.textContent.trim();
      if (key && key !== "CLOSE") {
        data[key] = val;
      }
    }
  }

  const dialogRoot = document.querySelector(
    ".modal.in, .modal.show, .k-window, [role='dialog']"
  );
  if (dialogRoot) {
    const raw = String(dialogRoot.innerText || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\f\v]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (raw) {
      data["FULL MODAL TEXT"] = raw;
    }
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

  for (const row of allRows) {
    if (row.classList.contains("k-grouping-row")) continue;
    if (row.classList.contains("k-no-data")) continue;
    const cells = row.querySelectorAll("td");

    let cell = null;
    if (trackingScrollIndex >= 0 && trackingScrollIndex < cells.length) {
      cell = cells[trackingScrollIndex];
    }
    if (
      (!cell || !cell.textContent.trim()) &&
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

    if (clickable && clickable.textContent.trim()) {
      jobs.push({ link: clickable, pickupResponse: pickupText });
    } else if (cell.textContent.trim() && cell.querySelector("*")) {
      const children = cell.querySelectorAll("*");
      for (const child of children) {
        const t = child.textContent.trim();
        if (t && child.childElementCount === 0 && /\d/.test(t)) {
          jobs.push({ link: child, pickupResponse: pickupText });
          break;
        }
      }
    }
  }

  dlog("[FPX] Shipment jobs:", jobs.length);
  sendStatus(
    `Found ${jobs.length} tracking link(s) on this page` +
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

function waitForGridReady(timeout = 3000) {
  return new Promise((resolve) => {
    const interval = 300;
    let elapsed = 0;
    const timer = setInterval(() => {
      const rows = document.querySelectorAll(
        ".k-grid-content tbody tr, .k-grid tbody tr"
      );
      const loading = document.querySelector(".k-loading-mask, .k-loading-image");
      if (rows.length > 0 && !loading) {
        clearInterval(timer);
        resolve();
        return;
      }
      elapsed += interval;
      if (elapsed >= timeout) {
        clearInterval(timer);
        resolve();
      }
    }, interval);
  });
}

async function processPage() {
  const jobs = collectShipmentJobs();
  const total = jobs.length;

  if (total === 0) {
    sendStatus("No tracking links found on this page.");
    return;
  }

  // One kendo prefetch per page-scrape; merged into each row by tracking number.
  // Captures grid-only columns the modal doesn't expose (Order #, References,
  // Company, Shipment Date, Spot Quote, Appointments, etc.).
  const kendoRowMap = await fetchKendoRowMap();

  for (let i = 0; i < total; i++) {
    if (stopRequested) {
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    const { link, pickupResponse } = jobs[i];
    const trackingNum = link.textContent.trim();
    sendStatus(`Processing ${i + 1} of ${total} — ${trackingNum}`);

    simulateClick(link);
    await humanDelay(300, 600);

    sendStatus(`Clicked ${trackingNum} — waiting for modal...`);
    const closeBtn = await waitForCloseButton(25000);
    if (closeBtn) {
      await humanDelay(350, 700);
      sendStatus(`Scraping modal data for ${trackingNum}...`);
      const modalData = scrapeModal();
      modalData._trackingNumber = trackingNum;
      modalData._timestamp = new Date().toISOString();
      applyGridPickupResponse(modalData, pickupResponse);
      mergeKendoRow(modalData, kendoRowMap.get(trackingNum));

      // Extension is scrape-only — analysis runs server-side after upload.
      delete modalData["FULL MODAL TEXT"];
      logRows.push(modalData);
      // Legacy 25-row chrome.storage._fpxCheckpoint write was retired —
      // the persistent upload queue (background.js / chrome.storage
      // pendingUploads) covers crash recovery, and serializing
      // logRows every 25 modals was the most expensive bookkeeping
      // step on rep laptops.

      const actionTag = modalData._needsActionSheet ? " [ACTION NEEDED]" : "";
      sendStatus(`Done ${trackingNum}${actionTag} — closing modal...`);
      simulateClick(closeBtn);
      await humanDelay(200, 500);
    } else {
      const timeoutRow = {
        _trackingNumber: trackingNum,
        _timestamp: new Date().toISOString(),
        _error: "Modal did not appear (timeout)",
        _needsActionSheet: false,
      };
      applyGridPickupResponse(timeoutRow, pickupResponse);
      mergeKendoRow(timeoutRow, kendoRowMap.get(trackingNum));
      logRows.push(timeoutRow);
      sendStatus(`Timeout on ${trackingNum} — no modal appeared, skipping.`);
    }

    await humanDelay(250, 600);
    if (i % 5 === 4) await yieldToBrowser();
  }
}

async function run(filterCol, filterVal) {
  // Extension is scrape-only as of 2026-04. Analysis happens server-side
  // after upload (POST /api/shipments → background per-row Claude).
  stopRequested = false;
  logRows = [];
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

  let pageNum = 1;
  // We drop uploaded rows from logRows so the array doesn't grow
  // unboundedly during long scrapes (a 50-page sweep with 50 rows/page
  // and ~30 KB per modal = ~75 MB resident otherwise — tips reps with
  // older laptops into memory pressure). Rows that DID upload land in
  // counters we use for the final status; the rows themselves are
  // gone-from-this-tab the moment Railway acks.
  let pageRowCount = 0;        // rows scraped this page (reset each iteration)
  let totalScraped = 0;        // total rows scraped this run, for the "Done" line
  let confirmedRows = 0;       // rows the server has acked

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
    const slice = logRows;
    logRows = [];
    // Memorize every tracking number leaving the page so we can compare
    // against the DB at sweep-completion time.
    for (const row of slice) {
      const tn = row && row._trackingNumber;
      if (tn) sweepTrackingNumbers.add(String(tn).trim());
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "upsertShipmentsBulk", rows: slice }, (r) => {
        if (r && r.ok) {
          confirmedRows += r.count || slice.length;
        } else if (r && r.error) {
          // Background queues the chunk on failure — it'll retry on
          // the next page's stream call AND on worker boot. We just
          // surface the side-panel chip; no in-page logging.
        }
        resolve(r || { ok: false, error: "no response" });
      });
    });
  }

  while (true) {
    if (stopRequested) {
      await flushAndDropLogRows("stopped");
      sendComplete(`Stopped by user. ${totalScraped} row(s) scraped, ${confirmedRows} confirmed.`);
      return;
    }

    sendStatus(`Processing page ${pageNum}...`);
    // logRows was emptied by the previous page's flush, so its length
    // after processPage is exactly this page's contribution.
    await processPage();
    pageRowCount = logRows.length;
    totalScraped += pageRowCount;

    if (stopRequested) {
      await flushAndDropLogRows("stopped");
      sendComplete(`Stopped by user. ${totalScraped} row(s) scraped, ${confirmedRows} confirmed.`);
      return;
    }

    // Stream this page's rows to the dashboard. Don't await — the
    // upload runs in parallel with the next page's scrape so the
    // dashboard fills in real time and the next page can't pile up
    // on top of an unsent batch. logRows is reset inside the helper
    // so memory stays bounded to ~one page at a time.
    sendStatus(`Page ${pageNum} done — uploading ${pageRowCount} row(s)…`);
    flushAndDropLogRows(`page ${pageNum}`).catch(() => { /* surfaced via side-panel chip */ });

    sendStatus(`Page ${pageNum} done. Checking for next page...`);
    const advanced = goToNextPage();
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

  // Background-side bookkeeping: drop the legacy checkpoint blob so
  // chrome.storage doesn't carry stale data into the next session.
  try { chrome.storage.local.remove("_fpxCheckpoint"); } catch {}
  try { chrome.runtime.sendMessage({ type: "aiSummary", text: "" }); } catch {}

  // Auto-archive shipments that left the dashboard (i.e. delivered).
  // Only when this was a clean unfiltered sweep — a filtered run can't
  // tell delivered apart from filtered-out, and a stopped run hasn't
  // visited every page so its set is incomplete.
  let archiveSummary = "";
  if (!filterCol && !filterVal && sweepTrackingNumbers.size > 0) {
    sendStatus(`Reconciling delivered shipments (${sweepTrackingNumbers.size} seen)…`);
    try {
      const r = await chrome.runtime.sendMessage({
        type: "sweepComplete",
        trackingNumbers: Array.from(sweepTrackingNumbers),
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

  const queuedButUnconfirmed = totalScraped - confirmedRows;
  sendComplete(
    `Done — ${pageNum} page(s), ${confirmedRows} confirmed${queuedButUnconfirmed > 0 ? `, ${queuedButUnconfirmed} queued for retry` : ""}${archiveSummary}. Open the dashboard to see analysis.`
  );
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
      const tn = String(
        row["Tracking Number"] || row["TrackingNumber"] || row["Tracking"] || ""
      ).trim();
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
  if (!kendoRow) return;
  for (const k of Object.keys(kendoRow)) {
    if (k.startsWith("_")) continue;
    const existing = modalData[k];
    if (existing !== undefined && existing !== null && existing !== "") continue;
    const v = kendoRow[k];
    if (v === null || v === undefined || v === "") continue;
    modalData[k] = v;
  }
}

function getKendoGridAllRows() {
  return new Promise((resolve) => {
    let settled = false;

    function onMessage(event) {
      if (event.data && event.data.type === "_fpxKendoResult") {
        window.removeEventListener("message", onMessage);
        settled = true;
        const result = event.data.payload;

        if (result.error) {
          dlog("[FPX-GP] Kendo inject error:", result.error);
          resolve(null);
          return;
        }

        dlog("[FPX-GP] Kendo inject: got", result.rows.length, "of", result.total, "total rows");
        dlog("[FPX-GP] Field map:", JSON.stringify(result.fieldMap));
        if (result.rows.length > 0) {
          dlog("[FPX-GP] Sample keys:", Object.keys(result.rows[0]).join(", "));
          dlog("[FPX-GP] Sample row:", JSON.stringify(result.rows[0]));
        }
        resolve(result.rows);
      }
    }

    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject-kendo.js");
    script.onload = () => script.remove();
    script.onerror = () => {
      dlog("[FPX-GP] Failed to load inject-kendo.js");
      script.remove();
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
        dlog("[FPX-GP] Kendo inject timed out after 3s");
        resolve(null);
      }
    }, 3000);
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

function findDateInputs() {
  const result = { from: null, to: null };
  const candidates = [];

  const allInputs = document.querySelectorAll("input:not([type='hidden']):not([type='checkbox']):not([type='submit']):not([type='button'])");

  for (const input of allInputs) {
    if (!isVisibleForClick(input)) continue;

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

async function invoiceSetPageSize(target) {
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
      sendInvStatus(`Page size set to ${target} via Kendo API.`);
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
      sendInvStatus(`Set page size to ${bestVal} from dropdown.`);
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
      sendInvStatus(`Set page size to ${bestN} from Kendo dropdown.`);
      await waitForGridReady(10000);
      return;
    }
  }

  sendInvStatus("Could not change page size — will use default page size.");
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

async function invoiceGenerateReport(fromDate, toDate, shipmentType, customerFilter) {
  const currentUrl = window.location.href;
  const onTransactions = currentUrl.includes("Transactions");
  if (!onTransactions) {
    sendInvStatus("Navigating to Transactions page...");
    window.location.hash = "#!/Transactions";
    await humanDelay(2500, 4000);
  } else {
    sendInvStatus("Already on Transactions page.");
  }

  sendInvStatus("Waiting for Generate History Report dialog...");
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
    sendInvStatus("Looking for Generate Report button...");
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
  sendInvStatus("Filling date fields: " + dateLabel + "...");

  const dateFields = findDateInputs();
  if (!dateFields.from && !dateFields.to) {
    sendInvComplete("Failed — no date inputs found.");
    return false;
  }

  if (dateFields.from) {
    setDateInput(dateFields.from, fromDate);
    sendInvStatus("Set FROM DATE to " + fromDate);
  }
  await humanDelay(400, 800);

  if (dateFields.to) {
    setDateInput(dateFields.to, toDate);
    sendInvStatus("Set TO DATE to " + toDate);
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

  sendInvStatus(useAllCustomers ? "Setting All Customers..." : `Setting customer to "${custTarget}"...`);
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

  sendInvStatus("Clicking CONTINUE...");
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
    sendInvComplete("ERROR: Could not find CONTINUE button.");
    return false;
  }

  sendInvStatus("Waiting for results grid to load...");
  await humanDelay(2500, 4000);

  let gridReady = false;
  for (let wait = 0; wait < 15000; wait += 1000) {
    const gridRows = document.querySelectorAll(".k-grid-content tbody tr, .k-grid tbody tr");
    const visibleRows = [...gridRows].filter(
      (r) => !r.classList.contains("k-no-data") && !r.classList.contains("k-grouping-row")
    );
    if (visibleRows.length > 0) { gridReady = true; break; }
    await humanDelay(800, 1300);
  }

  if (!gridReady) {
    sendInvComplete("No grid data loaded. Report may not have generated.");
    return false;
  }

  const typeToClick = shipmentType || "non-parcel";
  if (typeToClick !== "all") {
    sendInvStatus("Selecting " + (typeToClick === "parcel" ? "Parcel" : "Non-Parcel") + " tab...");
    clickShipmentTypeTab(typeToClick);
    await humanDelay(1500, 2500);
    await waitForGridReady(5000);
  }

  sendInvStatus("Report generated. Ready to process shipments.");
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
        console.warn("[FPX] inject-kendo-popup.js failed to load");
        resolve(false);
      }
    };
    (document.head || document.documentElement).appendChild(script);

    setTimeout(() => {
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        console.warn("[FPX] Kendo popup driver timed out");
        resolve(false);
      }
    }, 4000);
  });
}
function fpxFilterViaKendoApi(value, fieldCandidates) {
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
    script.onload = () => script.remove();
    script.onerror = () => {
      script.remove();
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        console.warn("[FPX] inject-kendo-filter.js failed to load");
        resolve(false);
      }
    };
    (document.head || document.documentElement).appendChild(script);

    setTimeout(() => {
      if (!settled) {
        window.removeEventListener("message", onMessage);
        settled = true;
        console.warn("[FPX] Kendo API filter timed out (jQuery not on page?)");
        resolve(false);
      }
    }, 1500);
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

window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.source !== "fpxpress") return;
  if (!fpxIsTrustedParentOrigin(event.origin)) {
    console.warn("[FPX] Ignored bridge message from untrusted origin:", event.origin);
    return;
  }
  if (data.type === "fpxFilter") {
    const col = String(data.column || "").trim();
    const val = String(data.value || "").trim();
    if (!col || !val) return;
    sendStatus(`Bridge: filtering ${col} → "${val}"`);
    let applied = false;
    let strategy = "";
    let lastErr = null;
    // Strategy 1: Kendo dataSource API (most reliable; bypasses UI).
    // Runs in the page's main world via inject-kendo-filter.js so it can
    // see window.jQuery + Kendo widgets (content scripts are sandboxed
    // away from those by Chrome's isolated-world rules).
    try {
      if (await fpxFilterViaKendoApi(val, ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"])) {
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
      try { event.source && event.source.postMessage({ source: "fpx-extension", type: "fpxFilterAck", column: col, value: val, ok: true, strategy, injectDetail: fpxLastInjectDetail }, event.origin); } catch {}
    } else {
      console.warn("[FPX] Bridge filter failed (all strategies):", lastErr, "inject:", fpxLastInjectDetail);
      try {
        event.source && event.source.postMessage({
          source: "fpx-extension",
          type: "fpxFilterAck",
          column: col,
          value: val,
          ok: false,
          error: String(lastErr?.message || lastErr || "no matching input"),
          injectDetail: fpxLastInjectDetail,
        }, event.origin);
      } catch {}
    }
  } else if (data.type === "fpxOpenTracking") {
    // Open FreightPOP's native tracking modal for a specific tracking
    // number — without leaving the embedded iframe. We first apply the
    // tracking-number filter so the row is guaranteed to be visible,
    // wait briefly for the grid to re-render, then simulate a click on
    // the row's tracking link (the same UI path a rep takes manually).
    const tn = String(data.trackingNumber || "").trim();
    if (!tn) return;
    sendStatus(`Bridge: opening modal for ${tn}`);
    let openOk = false;
    let openErr = null;
    try {
      // Filter first so the matching row is on-screen; ignore failure
      // here because the row may already be visible from a prior filter.
      try { await fpxFilterViaKendoApi(tn, ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"]); } catch {}
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
    try {
      event.source && event.source.postMessage({
        source: "fpx-extension",
        type: "fpxOpenTrackingAck",
        trackingNumber: tn,
        ok: openOk,
        error: openErr,
      }, event.origin);
    } catch {}
  } else if (data.type === "fpxPing") {
    // Lets the dashboard detect whether the extension is installed +
    // running inside this iframe. No filter side effects.
    try { event.source && event.source.postMessage({ source: "fpx-extension", type: "fpxPong" }, event.origin); } catch {}
  }
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
