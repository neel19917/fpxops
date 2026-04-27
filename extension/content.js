let stopRequested = false;
let logRows = [];

// Tracks the active MutationObserver so it can be disconnected before re-registering
// on the next "View Shipment" click (one observer per shipment interaction).
let activeDetailObserver = null;

function sendStatus(text) {
  console.log("[FPX]", text);
  try { chrome.runtime.sendMessage({ type: "status", text }); } catch {}
}

function sendComplete(text) {
  console.log("[FPX] COMPLETE:", text);
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

  const headerCells = document.querySelectorAll(".k-grid th");
  let targetHeader = null;
  for (const cell of headerCells) {
    const link = cell.querySelector("a.k-link");
    const text = link ? link.textContent.trim() : cell.textContent.trim();
    if (text.startsWith(colName)) {
      targetHeader = cell;
      break;
    }
  }

  if (!targetHeader) {
    sendStatus(`"${colName}" column header not found — skipping filter.`);
    return;
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
      'input[type="text"], input.k-textbox, input:not([type="hidden"]):not([type="checkbox"])'
    );
    if (textInput) {
      textInput.focus();
      textInput.value = value;
      textInput.dispatchEvent(new Event("input", { bubbles: true }));
      textInput.dispatchEvent(new Event("change", { bubbles: true }));
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

  console.log("[FPX] Scraped modal data keys:", Object.keys(data).length);
  return data;
}

const DISPLAY_COLUMNS = [
  { key: "_trackingNumber", header: "Tracking Number" },
  { key: "SHIPMENT STATUS", header: "Shipment Status" },
  { key: "CARRIER", header: "Carrier" },
  { key: "CARRIER NAME", header: "Carrier Name" },
  { key: "MODE", header: "Mode" },
  { key: "COMMENTS", header: "Comments" },
  { key: "PICKUP RESPONSE", header: "Pickup Response" },
  { key: "PICKUP REQUEST NUMBER", header: "Pickup Request # (Grid)" },
  { key: "CONFIRMATION NUMBER", header: "Confirmation # (Grid)" },
  { key: "PICKUP DATE", header: "Pickup Date" },
  { key: "UPDATED ETA", header: "Updated ETA" },
  { key: "ESTIMATED DEPARTURE DATE", header: "Est. Departure" },
  { key: "ACTUAL DEPARTURE DATE", header: "Act. Departure" },
  { key: "ESTIMATED ARRIVAL DATE", header: "Est. Arrival" },
  { key: "ACTUAL ARRIVAL DATE", header: "Act. Arrival" },
  { key: "DELIVERY DATE", header: "Delivery Date" },
  { key: "SIGNED BY", header: "Signed By" },
  { key: "BOOKING DATE", header: "Booking Date" },
  { key: "INBOUND CUSTOMS DATE", header: "Inbound Customs" },
  { key: "PORT DEPARTURE DATE", header: "Port Departure" },
  { key: "OUTBOUND CUSTOMS DATE", header: "Outbound Customs" },
  { key: "ON-BOARD DATE", header: "On-Board Date" },
  { key: "LONGITUDE", header: "Longitude" },
  { key: "LATITUDE", header: "Latitude" },
  { key: "_inputSummary", header: "Input (Extracted)" },
  { key: "_outputSummary", header: "Output (AI Analysis)" },
  { key: "_actionRequired", header: "Action Required" },
  { key: "_aiIssue", header: "AI Issue" },
  { key: "_aiRecommendation", header: "AI Recommendation" },
  { key: "_actionQuickRef", header: "Action — Key Data" },
  { key: "_carrierEmailDraft", header: "Carrier Email Draft" },
  { key: "_inputsSheetLink", header: "Find on Inputs Sheet" },
  { key: "_timestamp", header: "Scraped At" },
  { key: "_error", header: "Error" },
];

function buildInputSummary(data) {
  const parts = [];
  const v = (k) => (data[k] || "").trim();

  if (v("_trackingNumber")) parts.push(`Tracking: ${v("_trackingNumber")}`);
  if (v("SHIPMENT STATUS")) parts.push(`Status: ${v("SHIPMENT STATUS")}`);
  if (v("CARRIER NAME") || v("CARRIER")) parts.push(`Carrier: ${v("CARRIER NAME") || v("CARRIER")}`);
  if (v("MODE")) parts.push(`Mode: ${v("MODE")}`);
  if (v("PICKUP DATE")) parts.push(`Pickup: ${v("PICKUP DATE")}`);
  if (v("UPDATED ETA")) parts.push(`ETA: ${v("UPDATED ETA")}`);
  if (v("ESTIMATED ARRIVAL DATE")) parts.push(`Est. Arrival: ${v("ESTIMATED ARRIVAL DATE")}`);
  if (v("ACTUAL ARRIVAL DATE")) parts.push(`Act. Arrival: ${v("ACTUAL ARRIVAL DATE")}`);
  if (v("DELIVERY DATE")) parts.push(`Delivered: ${v("DELIVERY DATE")}`);
  if (v("SIGNED BY")) parts.push(`Signed: ${v("SIGNED BY")}`);
  if (v("COMMENTS")) parts.push(`Comments: ${v("COMMENTS")}`);
  if (v("PICKUP RESPONSE")) parts.push(`Pickup Response: ${v("PICKUP RESPONSE")}`);

  return parts.join(" | ");
}

function buildOutputSummary(data) {
  const action = data._actionRequired || "";
  const issue = data._aiIssue || "";
  const rec = data._aiRecommendation || "";

  if (action === "ERROR") return `Error: ${issue}`;
  if (!action && !issue) return "";

  const parts = [];
  if (action === "YES") parts.push("ACTION NEEDED.");
  else if (action === "NO") parts.push("No action needed.");

  if (issue) parts.push(`Issue: ${issue}.`);
  if (rec) parts.push(`Next step: ${rec}.`);

  return parts.join(" ");
}

// Modal keys vary by tenant; try exact labels then loose key matches.
const PRO_FIELD_KEYS = [
  "PRO", "PRO NUMBER", "PRO #", "PRO NO", "CARRIER PRO", "CARRIER PRO NUMBER",
  "PRO NUM", "PRO NUMBERS",
];
const PICKUP_FIELD_KEYS = [
  "PICKUP REQUEST NUMBER",
  "PICKUP RESPONSE",
  "PICKUP NUMBER", "PICKUP #", "PICKUP NO", "PU NUMBER", "PU #",
  "PICKUP CONFIRMATION", "PICKUP CONF #", "PICKUP REF", "PICKUP REFERENCE",
];
const ORIGIN_ZIP_KEYS = [
  "ORIGIN ZIP", "SHIPPER ZIP", "PICKUP ZIP", "ORIGIN POSTAL CODE",
  "FROM ZIP", "SHIP FROM ZIP", "ORIGIN POSTAL", "SHIPPER POSTAL CODE",
];
const DEST_ZIP_KEYS = [
  "DESTINATION ZIP", "CONSIGNEE ZIP", "DELIVERY ZIP", "DEST ZIP", "TO ZIP",
  "DELIVERY POSTAL CODE", "DESTINATION POSTAL CODE", "CONSIGNEE POSTAL CODE",
];
const SHIP_FROM_KEYS = [
  "SHIP FROM", "SHIP FROM ADDRESS", "ORIGIN", "SHIPPER ADDRESS", "PICKUP ADDRESS",
];
const SHIP_TO_KEYS = [
  "SHIP TO", "SHIP TO ADDRESS", "DESTINATION", "CONSIGNEE ADDRESS", "DELIVERY ADDRESS",
];
const REF_NUMBER_KEYS = [
  "REF1 / REF2", "REF1", "REF2", "REFERENCE", "REFERENCE NUMBER", "REF #", "REF NO",
];

function getScrapedField(row, exactKeys, opts) {
  const rowKeyMustMatch = opts && opts.rowKeyMustMatch;
  if (!row || typeof row !== "object") return "";
  for (const k of exactKeys) {
    if (row[k] === undefined || row[k] === null) continue;
    const v = String(row[k]).trim();
    if (v) return v;
  }
  const rowKeys = Object.keys(row);
  for (const want of exactKeys) {
    const w = want.toUpperCase().replace(/\s+/g, " ");
    for (const k of rowKeys) {
      if (k.startsWith("_")) continue;
      if (rowKeyMustMatch && !rowKeyMustMatch.test(k)) continue;
      const ku = k.toUpperCase().replace(/\s+/g, " ");
      if (ku === w || ku.includes(w) || w.includes(ku)) {
        const v = String(row[k] ?? "").trim();
        if (v) return v;
      }
    }
  }
  return "";
}

function suggestsNoProTracking(row) {
  const blob = [
    row.COMMENTS,
    row._aiIssue,
    row._aiRecommendation,
    row["SHIPMENT STATUS"],
  ]
    .map((x) => String(x || ""))
    .join(" ");
  if (
    /\b(no tracking|not tracking|invalid pro|bad pro|pro not|unable to track|no visibility|not visible|carrier (portal|site)|trace|tracking (issue|problem|unavailable))\b/i.test(
      blob
    )
  ) {
    return true;
  }
  if (String(row["SHIPMENT STATUS"] || "").trim().toLowerCase() === "issue") {
    return true;
  }
  if (/\bcontact\s+(the\s+)?carrier\b/i.test(blob)) return true;
  return false;
}

/** Turn comma-separated modal address blobs into readable line breaks. */
function formatShipAddressBlob(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
}

function buildActionQuickRef(row) {
  const parts = [];
  const trk = String(row._trackingNumber || "").trim();
  parts.push(`Tracking: ${trk || "—"}`);
  const pro = getScrapedField(row, PRO_FIELD_KEYS);
  if (pro) parts.push(`PRO: ${pro}`);
  const pickup = getScrapedField(row, PICKUP_FIELD_KEYS);
  if (row["PICKUP RESPONSE"]) parts.push(`Pickup Response: ${row["PICKUP RESPONSE"]}`);
  if (pickup) parts.push(`Pickup #: ${pickup}`);
  const oz = getScrapedField(row, ORIGIN_ZIP_KEYS, {
    rowKeyMustMatch: /\b(ZIP|POSTAL)\b/i,
  });
  const dz = getScrapedField(row, DEST_ZIP_KEYS, {
    rowKeyMustMatch: /\b(ZIP|POSTAL)\b/i,
  });
  if (oz || dz) parts.push(`ZIPs: ${oz || "?"} → ${dz || "?"}`);
  const carrier = String(row["CARRIER NAME"] || row.CARRIER || "").trim();
  if (carrier) parts.push(`Carrier: ${carrier}`);
  if (row["SHIPMENT STATUS"]) parts.push(`Status: ${row["SHIPMENT STATUS"]}`);
  if (row["PICKUP DATE"]) parts.push(`Pickup date: ${row["PICKUP DATE"]}`);
  if (row["UPDATED ETA"]) parts.push(`ETA: ${row["UPDATED ETA"]}`);
  if (row["DELIVERY DATE"]) parts.push(`Delivery: ${row["DELIVERY DATE"]}`);
  return parts.join(" | ");
}

function buildCarrierEmailDraft(row) {
  const carrier = String(row["CARRIER NAME"] || row.CARRIER || "").trim();
  const trk = String(row._trackingNumber || "").trim();
  const pro = getScrapedField(row, PRO_FIELD_KEYS);
  const pickup = getScrapedField(row, PICKUP_FIELD_KEYS);
  const oz = getScrapedField(row, ORIGIN_ZIP_KEYS, {
    rowKeyMustMatch: /\b(ZIP|POSTAL)\b/i,
  });
  const dz = getScrapedField(row, DEST_ZIP_KEYS, {
    rowKeyMustMatch: /\b(ZIP|POSTAL)\b/i,
  });
  const mode = String(row.MODE || "").trim();
  const shipFromRaw = getScrapedField(row, SHIP_FROM_KEYS);
  const shipToRaw = getScrapedField(row, SHIP_TO_KEYS);
  const shipFromFmt = formatShipAddressBlob(shipFromRaw);
  const shipToFmt = formatShipAddressBlob(shipToRaw);

  const noProTracking = suggestsNoProTracking(row);
  // PRO is the carrier tracking number; grid/modal "tracking number" is the same PRO when data returns.
  const proNumber = trk || pro;
  const trackingReturning = Boolean(proNumber) && !noProTracking;

  const lines = [];
  if (trackingReturning) {
    lines.push(`Subject: Status update — PRO ${proNumber}`);
  } else {
    lines.push(
      `Subject: Tracking visibility — Ref ${pickup || proNumber || "shipment"}`
    );
  }
  lines.push("");
  lines.push(carrier ? `Hello ${carrier},` : "Hello,");
  lines.push("");

  if (trackingReturning) {
    lines.push(
      "We are following up on the shipment below. Please send a brief status update at your convenience."
    );
    lines.push("");
    lines.push(`PRO: ${proNumber}`);
    lines.push("");
    if (shipFromFmt) {
      lines.push("Ship from:");
      lines.push(shipFromFmt);
      lines.push("");
    }
    if (shipToFmt) {
      lines.push("Ship to:");
      lines.push(shipToFmt);
      lines.push("");
    }
    if (oz || dz) {
      lines.push(`Lane (ZIP): ${oz || "?"} → ${dz || "?"}.`);
      lines.push("");
    }
  } else {
    lines.push(
      "We are following up on a shipment and need your help with tracking visibility."
    );
    lines.push("");

    if (noProTracking && pickup) {
      lines.push(
        "We are not receiving usable tracking updates with the PRO number we have on file" +
          (pro ? ` (${pro})` : trk ? ` (${trk})` : "") +
          ". Please provide the correct or updated PRO number."
      );
      lines.push(`Please reference our pickup number: ${pickup}.`);
      lines.push("");
    } else if (!pickup && (oz || dz)) {
      lines.push(
        "We do not have a pickup number on file for this shipment. Please locate the load and confirm the active PRO using the origin and destination ZIP codes below."
      );
      lines.push(
        `Ship-from / origin ZIP: ${oz || "(not captured)"} — Ship-to / destination ZIP: ${dz || "(not captured)"}.`
      );
      if (pro || trk) {
        lines.push(
          `The PRO we have on file (if it helps): ${pro || trk}.`
        );
      }
      lines.push("");
    } else {
      lines.push(
        "Please confirm the active PRO and current status for this shipment."
      );
      if (pickup) lines.push(`Pickup reference: ${pickup}.`);
      if (oz || dz) {
        lines.push(`Lane: ZIP ${oz || "?"} → ${dz || "?"}.`);
      }
      lines.push("");
    }

    if (shipFromFmt) {
      lines.push("Ship from:");
      lines.push(shipFromFmt);
      lines.push("");
    }
    if (shipToFmt) {
      lines.push("Ship to:");
      lines.push(shipToFmt);
      lines.push("");
    }

    lines.push("Reference details:");
    const refVal = getScrapedField(row, REF_NUMBER_KEYS);
    if (trk) lines.push(`• FreightPOP / portal tracking: ${trk}`);
    if (pro && pro !== trk) lines.push(`• PRO on file: ${pro}`);
    if (pickup) lines.push(`• Pickup number: ${pickup}`);
    if (refVal) lines.push(`• Reference: ${refVal}`);
    if (oz || dz) lines.push(`• ZIPs: ${oz || "?"} → ${dz || "?"}`);
    if (mode) lines.push(`• Mode: ${mode}`);
    lines.push("");
  }

  lines.push("Thank you,");
  lines.push("[Your name / brokerage]");

  return lines.join("\n");
}

function buildActionRowForSheet(r, allRows) {
  const idx = allRows.indexOf(r);
  const excelRow = idx >= 0 ? idx + 2 : "";
  const trk = String(r._trackingNumber || "").trim();
  const linkHint =
    excelRow && trk
      ? `Inputs row ${excelRow} — search Inputs for "${trk}"`
      : excelRow
        ? `Inputs row ${excelRow} — use Find in Inputs sheet`
        : trk
          ? `Search Inputs sheet for "${trk}"`
          : "";
  return {
    ...r,
    _actionQuickRef: buildActionQuickRef(r),
    _carrierEmailDraft: buildCarrierEmailDraft(r),
    _inputsSheetLink: linkHint,
    _inputExcelRow: excelRow,
  };
}

function rowsToSheetData(rows) {
  const present = DISPLAY_COLUMNS.filter((col) =>
    rows.some((r) => r[col.key] !== undefined && r[col.key] !== "")
  );
  const headers = present.map((c) => c.header);
  const data = [headers];
  for (const row of rows) {
    data.push(present.map((c) => row[c.key] ?? ""));
  }
  return data;
}

function autoFitCols(sheetData) {
  return sheetData[0].map((_, ci) => {
    let max = 10;
    for (const row of sheetData) {
      const len = String(row[ci] ?? "").length;
      if (len > max) max = len;
    }
    return { wch: Math.min(max + 2, 60) };
  });
}

const XL_BORDER = {
  top:    { style: "thin", color: { rgb: "CCCCCC" } },
  bottom: { style: "thin", color: { rgb: "CCCCCC" } },
  left:   { style: "thin", color: { rgb: "CCCCCC" } },
  right:  { style: "thin", color: { rgb: "CCCCCC" } },
};
const XL_HDR_STYLE = {
  font: { name: "Arial", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: "1F4E79" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: XL_BORDER,
};
const XL_DATA_STYLE = {
  font: { name: "Arial", sz: 9 },
  alignment: { vertical: "center" },
  border: XL_BORDER,
};
const XL_ALT_FILL = { patternType: "solid", fgColor: { rgb: "EBF3FB" } };
const XL_YES_FONT = { name: "Arial", sz: 9, bold: true, color: { rgb: "C00000" } };
const XL_NO_FONT  = { name: "Arial", sz: 9, bold: true, color: { rgb: "1E6B31" } };
const XL_ERR_FONT = { name: "Arial", sz: 9, bold: true, color: { rgb: "C00000" } };
const XL_TITLE_STYLE = {
  font: { name: "Arial", sz: 13, bold: true, color: { rgb: "1F4E79" } },
};
const XL_LABEL_STYLE = {
  font: { name: "Arial", sz: 10, bold: true },
  border: XL_BORDER,
};
const XL_VALUE_STYLE = {
  font: { name: "Arial", sz: 10 },
  border: XL_BORDER,
};

function styleDataSheet(ws, sheetData, actionColIdx) {
  const numCols = sheetData[0].length;
  const numRows = sheetData.length;
  for (let c = 0; c < numCols; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = XL_HDR_STYLE;
  }
  for (let r = 1; r < numRows; r++) {
    const isAlt = r % 2 === 0;
    for (let c = 0; c < numCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) {
        ws[addr] = { t: "s", v: "" };
      }
      const s = { ...XL_DATA_STYLE, font: { ...XL_DATA_STYLE.font } };
      if (isAlt) s.fill = XL_ALT_FILL;
      if (actionColIdx >= 0 && c === actionColIdx) {
        const val = String(ws[addr].v || "").trim().toUpperCase();
        if (val === "YES") s.font = XL_YES_FONT;
        else if (val === "NO") s.font = XL_NO_FONT;
        else if (val === "ERROR") s.font = XL_ERR_FONT;
      }
      ws[addr].s = s;
    }
  }
  ws["!rows"] = [{ hpt: 28 }];
}

function findHeaderIndex(headers, name) {
  return headers.findIndex((h) =>
    typeof h === "string" && h.toLowerCase() === name.toLowerCase()
  );
}

function downloadXLSX(rows, summaryText) {
  if (!rows.length) return;
  if (typeof XLSX === "undefined") {
    console.error("[FPX] XLSX library not loaded, falling back to alert.");
    return;
  }

  const wb = XLSX.utils.book_new();

  // --- Sheet 1: Actions (items needing action) ---
  const actionRows = rows.filter((r) => r._needsActionSheet === true);
  const actionSheetRows =
    actionRows.length > 0
      ? actionRows.map((r) => buildActionRowForSheet(r, rows))
      : [];
  const actionData =
    actionSheetRows.length > 0
      ? rowsToSheetData(actionSheetRows)
      : [["No action items found."]];
  const wsActions = XLSX.utils.aoa_to_sheet(actionData);
  wsActions["!cols"] = autoFitCols(actionData);
  if (actionSheetRows.length > 0) {
    const actIdx = findHeaderIndex(actionData[0], "Action Required");
    styleDataSheet(wsActions, actionData, actIdx);
    const linkColIdx = findHeaderIndex(actionData[0], "Find on Inputs Sheet");
    if (linkColIdx >= 0) {
      for (let r = 1; r < actionData.length; r++) {
        const er = actionSheetRows[r - 1]._inputExcelRow;
        if (!er) continue;
        const addr = XLSX.utils.encode_cell({ r, c: linkColIdx });
        const label = `Inputs row ${er}`.replace(/"/g, '""');
        wsActions[addr] = { f: `HYPERLINK("#Inputs!A${er}","${label}")` };
      }
    }
  }
  XLSX.utils.book_append_sheet(wb, wsActions, "Actions");

  // --- Sheet 2: Inputs (all scraped fields, dynamic columns) ---
  const INPUT_EXCLUDE = new Set([
    "_aiRawAnalysis", "_aiIssue", "_aiRecommendation",
    "_actionRequired", "_needsActionSheet",
    "_inputSummary", "_outputSummary",
    "_actionQuickRef", "_carrierEmailDraft", "_inputsSheetLink", "_inputExcelRow",
    "FULL MODAL TEXT",
  ]);
  const inputKeysSet = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!INPUT_EXCLUDE.has(k)) inputKeysSet.add(k);
    }
  }
  const inputKeys = Array.from(inputKeysSet);
  const inputData = [inputKeys];
  for (const row of rows) {
    inputData.push(inputKeys.map((k) => {
      const v = row[k];
      if (v === undefined || v === null) return "";
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      return String(v);
    }));
  }
  const wsInputs = XLSX.utils.aoa_to_sheet(inputData);
  wsInputs["!cols"] = autoFitCols(inputData);
  styleDataSheet(wsInputs, inputData, -1);
  XLSX.utils.book_append_sheet(wb, wsInputs, "Inputs");

  // --- Sheet 3: All Shipments ---
  const allData = rowsToSheetData(rows);
  const wsAll = XLSX.utils.aoa_to_sheet(allData);
  wsAll["!cols"] = autoFitCols(allData);
  const allActIdx = findHeaderIndex(allData[0], "Action Required");
  styleDataSheet(wsAll, allData, allActIdx);
  XLSX.utils.book_append_sheet(wb, wsAll, "All Shipments");

  // --- Sheet 4: Summary ---
  const totalCount = rows.length;
  const actionCount = actionRows.length;
  const noActionCount = rows.filter((r) => r._actionRequired === "NO").length;
  const errorCount = rows.filter((r) => r._actionRequired === "ERROR").length;

  const summaryRows = [
    ["FPXpress Shipment Analysis Report"],
    ["Generated", new Date().toLocaleString()],
    [],
    ["Total Shipments", totalCount],
    ["Action Required", actionCount],
    ["No Action Needed", noActionCount],
    ["Errors", errorCount],
    [],
    ["AI Executive Summary"],
    [summaryText || "(No summary available)"],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 25 }, { wch: 80 }];

  const sc = (r, c) => XLSX.utils.encode_cell({ r, c });
  if (wsSummary[sc(0, 0)]) wsSummary[sc(0, 0)].s = XL_TITLE_STYLE;
  if (wsSummary[sc(1, 0)]) wsSummary[sc(1, 0)].s = XL_LABEL_STYLE;
  if (wsSummary[sc(1, 1)]) wsSummary[sc(1, 1)].s = XL_VALUE_STYLE;
  for (let r = 3; r <= 6; r++) {
    if (wsSummary[sc(r, 0)]) wsSummary[sc(r, 0)].s = XL_LABEL_STYLE;
    if (wsSummary[sc(r, 1)]) wsSummary[sc(r, 1)].s = XL_VALUE_STYLE;
  }
  if (wsSummary[sc(8, 0)]) wsSummary[sc(8, 0)].s = {
    font: { name: "Arial", sz: 11, bold: true, color: { rgb: "1F4E79" } },
  };
  if (wsSummary[sc(9, 0)]) wsSummary[sc(9, 0)].s = {
    font: { name: "Arial", sz: 9 },
    alignment: { wrapText: true, vertical: "top" },
  };
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `fpx-shipment-analysis-${ts}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildDashboardHtml(rows, summaryText) {
  const total = rows.length;
  const actionRows = rows.filter((r) => r._needsActionSheet === true);
  const noActionCount = rows.filter((r) => r._actionRequired === "NO").length;
  const errorCount = rows.filter((r) => r._actionRequired === "ERROR").length;
  const generatedAt = new Date().toLocaleString();
  const generatedIso = new Date().toISOString();

  const carrierCounts = {};
  const statusCounts = {};
  for (const r of rows) {
    const c = String(r["CARRIER NAME"] || "Unknown").trim() || "Unknown";
    carrierCounts[c] = (carrierCounts[c] || 0) + 1;
    const s = String(r["SHIPMENT STATUS"] || "Unknown").trim() || "Unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  const topCarriers = Object.entries(carrierCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const topStatuses = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  function bar(label, count, maxCount) {
    const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
    return `
      <div class="bar-row">
        <div class="bar-label" title="${escHtml(label)}">${escHtml(label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-count">${count}</div>
      </div>`;
  }
  const maxCarrier = topCarriers.length ? topCarriers[0][1] : 0;
  const maxStatus = topStatuses.length ? topStatuses[0][1] : 0;

  function actionRow(r) {
    return `
      <tr>
        <td>${escHtml(r._trackingNumber || "")}</td>
        <td>${escHtml(r["CARRIER NAME"] || "")}</td>
        <td>${escHtml(r["MODE"] || "")}</td>
        <td>${escHtml(r["SHIPMENT STATUS"] || "")}</td>
        <td>${escHtml(r["UPDATED ETA"] || r["DELIVERY DATE"] || "")}</td>
        <td>${escHtml(r._aiIssue || "")}</td>
        <td>${escHtml(r._aiRecommendation || "")}</td>
      </tr>`;
  }

  const actionTableBody = actionRows.length
    ? actionRows.map(actionRow).join("")
    : `<tr><td colspan="7" class="empty">No action items.</td></tr>`;

  const summaryBlock = summaryText
    ? `<div class="summary-card"><h2>AI Executive Summary</h2><pre>${escHtml(summaryText)}</pre></div>`
    : "";

  // Refresh meta tag triggers a re-load every 60 seconds — useful when the
  // file is overwritten by a subsequent Refresh All Shipments run.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="60">
<title>FPXpress Dashboard — ${escHtml(generatedAt)}</title>
<style>
  :root {
    --bg: #f3f4f6; --card: #ffffff; --text: #111827; --muted: #6b7280;
    --accent: #2563eb; --ok: #16a34a; --warn: #f59e0b; --err: #dc2626;
    --border: #e5e7eb;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text);
  }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 20px; flex-wrap: wrap; gap: 8px; }
  h1 { margin: 0; font-size: 22px; }
  .meta { color: var(--muted); font-size: 12px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .kpi .label { font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
  .kpi .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .kpi.action .value { color: var(--err); }
  .kpi.ok .value { color: var(--ok); }
  .kpi.err .value { color: var(--warn); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
  .summary-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .summary-card h2 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
  .summary-card pre { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; font-size: 13px; line-height: 1.5; margin: 0; color: var(--text); }
  .bar-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
  .bar-label { width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; background: #f3f4f6; border-radius: 3px; height: 14px; overflow: hidden; }
  .bar-fill { background: var(--accent); height: 100%; }
  .bar-count { width: 32px; text-align: right; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: var(--card); }
  thead th { background: #f9fafb; text-align: left; padding: 8px; border-bottom: 2px solid var(--border); font-weight: 600; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.3px; }
  tbody td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:hover { background: #f9fafb; }
  .empty { text-align: center; color: var(--muted); padding: 20px; }
  .table-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .table-wrap h2 { margin: 0; padding: 16px; font-size: 14px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  .filter { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .filter input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 13px; }
  .footer { color: var(--muted); font-size: 11px; text-align: center; margin-top: 20px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>FPXpress Shipment Dashboard</h1>
    <div class="meta">Generated <span id="genAt">${escHtml(generatedAt)}</span> · auto-refresh every 60s</div>
  </div>
  <div class="meta" id="ageMeta"></div>
</header>

<section class="kpis">
  <div class="kpi"><div class="label">Total Shipments</div><div class="value">${total}</div></div>
  <div class="kpi action"><div class="label">Action Required</div><div class="value">${actionRows.length}</div></div>
  <div class="kpi ok"><div class="label">No Action Needed</div><div class="value">${noActionCount}</div></div>
  <div class="kpi err"><div class="label">Errors</div><div class="value">${errorCount}</div></div>
</section>

${summaryBlock}

<section class="grid">
  <div class="card">
    <h2>Top Carriers</h2>
    ${topCarriers.length ? topCarriers.map(([k, v]) => bar(k, v, maxCarrier)).join("") : '<div class="empty">No data.</div>'}
  </div>
  <div class="card">
    <h2>Status Breakdown</h2>
    ${topStatuses.length ? topStatuses.map(([k, v]) => bar(k, v, maxStatus)).join("") : '<div class="empty">No data.</div>'}
  </div>
</section>

<section class="table-wrap">
  <h2>Action Items (${actionRows.length})</h2>
  <div class="filter"><input id="filterInput" type="text" placeholder="Filter rows..."></div>
  <table id="actionTable">
    <thead>
      <tr>
        <th>Tracking #</th><th>Carrier</th><th>Mode</th><th>Status</th><th>ETA / Delivery</th><th>Issue</th><th>Recommendation</th>
      </tr>
    </thead>
    <tbody>${actionTableBody}</tbody>
  </table>
</section>

<div class="footer">FPXpress Tracking Refresh · data snapshot at ${escHtml(generatedAt)}</div>

<script>
  const generatedIso = ${JSON.stringify(generatedIso)};
  function tickAge() {
    const ageEl = document.getElementById("ageMeta");
    if (!ageEl) return;
    const ms = Date.now() - new Date(generatedIso).getTime();
    const sec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(sec / 60), s = sec % 60;
    ageEl.textContent = "Snapshot age: " + (m ? m + "m " : "") + s + "s";
  }
  setInterval(tickAge, 1000); tickAge();
  const filterInput = document.getElementById("filterInput");
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      const rows = document.querySelectorAll("#actionTable tbody tr");
      rows.forEach((r) => {
        r.style.display = !q || r.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  }
</script>
</body>
</html>`;
}

async function downloadDashboard(rows, summaryText) {
  if (!rows || !rows.length) return;
  try {
    const html = buildDashboardHtml(rows, summaryText);
    const res = await chrome.runtime.sendMessage({
      type: "saveDashboard",
      html,
      filename: "fpx-dashboard-latest.html",
    });
    if (!res || !res.ok) {
      console.warn("[FPX] Dashboard save failed:", res && res.error);
    } else {
      console.log("[FPX] Dashboard saved (download id:", res.downloadId, ")");
    }
  } catch (e) {
    console.warn("[FPX] Dashboard generation error:", e);
  }
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

  console.log(
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

  console.log("[FPX] Body rows found:", allRows.length);

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

  console.log("[FPX] Shipment jobs:", jobs.length);
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
      if (logRows.length > 0) {
        downloadXLSX(logRows, "");
        downloadDashboard(logRows, "");
      }
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
      // We still build input/output summaries for the local XLSX export so
      // reps have a record on disk that mirrors what they uploaded.
      modalData._inputSummary = buildInputSummary(modalData);
      modalData._outputSummary = buildOutputSummary(modalData);
      delete modalData["FULL MODAL TEXT"];
      logRows.push(modalData);

      if (logRows.length % 25 === 0) {
        try { chrome.storage.local.set({ _fpxCheckpoint: logRows }); } catch {}
      }

      const actionTag = modalData._needsActionSheet ? " [ACTION NEEDED]" : "";
      sendStatus(`Done ${trackingNum}${actionTag} — closing modal...`);
      simulateClick(closeBtn);
      await humanDelay(200, 500);
    } else {
      const timeoutRow = {
        _trackingNumber: trackingNum,
        _timestamp: new Date().toISOString(),
        _error: "Modal did not appear (timeout)",
        _actionRequired: "",
        _aiIssue: "",
        _aiRecommendation: "",
        _inputSummary: "",
        _outputSummary: "Error: Modal did not appear (timeout)",
        _needsActionSheet: false,
      };
      applyGridPickupResponse(timeoutRow, pickupResponse);
      mergeKendoRow(timeoutRow, kendoRowMap.get(trackingNum));
      timeoutRow._inputSummary = buildInputSummary(timeoutRow);
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

  while (true) {
    if (stopRequested) {
      if (logRows.length > 0) {
        downloadXLSX(logRows, "");
        downloadDashboard(logRows, "");
      }
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    sendStatus(`Processing page ${pageNum}...`);
    await processPage();

    if (stopRequested) {
      if (logRows.length > 0) {
        downloadXLSX(logRows, "");
        downloadDashboard(logRows, "");
      }
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    sendStatus(`Page ${pageNum} done. Checking for next page...`);
    const advanced = goToNextPage();
    if (!advanced) break;

    pageNum++;
    await waitForGridReady(3000);
  }

  // Push to dashboard. Server analyzes new rows in the background and creates
  // any necessary tasks / drafts; this extension just hands off raw data.
  if (logRows.length > 0) {
    sendStatus(`Uploading ${logRows.length} shipment(s) to the dashboard...`);
    let uploadOk = false;
    try {
      const uploadResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "upsertShipmentsBulk", rows: logRows }, (r) => resolve(r));
      });
      if (uploadResp && uploadResp.ok) {
        uploadOk = true;
        console.log(`[FPX] Pushed ${uploadResp.count} shipments to dashboard`);
      } else if (uploadResp && uploadResp.error) {
        console.warn("[FPX] Dashboard upsert error:", uploadResp.error);
        sendStatus(`Upload error: ${uploadResp.error}`);
      }
    } catch (e) {
      console.warn("[FPX] Dashboard push failed:", e.message);
      sendStatus(`Upload failed: ${e.message}`);
    }
    // Local XLSX export still happens — reps want a copy on disk.
    downloadXLSX(logRows, "");
    downloadDashboard(logRows, "");
    if (uploadOk) {
      sendStatus(`Uploaded ${logRows.length} shipment(s). The dashboard is analyzing them now.`);
    }
  }

  try { chrome.storage.local.remove("_fpxCheckpoint"); } catch {}

  // No AI summary in the extension anymore — clear any stale summary in the UI.
  try { chrome.runtime.sendMessage({ type: "aiSummary", text: "" }); } catch {}
  sendComplete(
    `Done — ${pageNum} page(s), ${logRows.length} shipment(s) uploaded. Open the dashboard to see analysis.`
  );
}

// =====================================================================
// GP AUDIT MODE
// =====================================================================

function sendGpStatus(text) {
  console.log("[FPX-GP]", text);
  try { chrome.runtime.sendMessage({ type: "gpAuditStatus", text }); } catch {}
}

function sendGpComplete(text) {
  console.log("[FPX-GP] COMPLETE:", text);
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
  console.log("[FPX-GP] Kendo column map:", JSON.stringify(fieldToTitle));
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
    console.log("[FPX] Kendo row map: keyed", map.size, "of", rows.length);
    return map;
  } catch (e) {
    console.log("[FPX] Kendo prefetch failed:", e.message);
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
          console.log("[FPX-GP] Kendo inject error:", result.error);
          resolve(null);
          return;
        }

        console.log("[FPX-GP] Kendo inject: got", result.rows.length, "of", result.total, "total rows");
        console.log("[FPX-GP] Field map:", JSON.stringify(result.fieldMap));
        if (result.rows.length > 0) {
          console.log("[FPX-GP] Sample keys:", Object.keys(result.rows[0]).join(", "));
          console.log("[FPX-GP] Sample row:", JSON.stringify(result.rows[0]));
        }
        resolve(result.rows);
      }
    }

    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject-kendo.js");
    script.onload = () => script.remove();
    script.onerror = () => {
      console.log("[FPX-GP] Failed to load inject-kendo.js");
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
        console.log("[FPX-GP] Kendo inject timed out after 3s");
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
      console.log("[FPX-GP] Set via Kendo API:", dateStr);
      return;
    }
  } catch (e) {
    console.log("[FPX-GP] Kendo API failed, trying direct:", e.message);
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

  console.log("[FPX-GP] setDateInput:", input.type, "value after:", input.value, "target:", valueToSet);
}

function gpDownloadXLSX(rows, stats, bizDate, reviewRows, execSummaryText, perRowNotes, apiCost) {
  if (!rows.length || typeof XLSX === "undefined") return;
  const wb = XLSX.utils.book_new();

  // --- Sheet 1: Executive Summary ---
  const totalOutliers = rows.filter((r) => r._isOutlier).length;
  const totalReview = (reviewRows || []).length;
  const summaryData = [
    ["FPXpress GP Audit Report"],
    ["Date Audited", bizDate],
    ["Generated", new Date().toLocaleString()],
    [],
    ["Total Transactions", rows.length],
    ["Total Customers", stats.size],
    ["Outliers (>2 STDEV)", totalOutliers],
    ["Needs Review", totalReview],
    ["Claude API Cost", apiCost ? `$${apiCost.totalUsd.toFixed(4)} (${apiCost.calls} calls, ${apiCost.inputTokens.toLocaleString()} in / ${apiCost.outputTokens.toLocaleString()} out tokens)` : "N/A"],
    [],
    ["AI Executive Summary"],
    [execSummaryText || "(AI analysis not enabled)"],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  wsSummary["!cols"] = [{ wch: 25 }, { wch: 90 }];
  const sc = (r, c) => XLSX.utils.encode_cell({ r, c });
  if (wsSummary[sc(0, 0)]) wsSummary[sc(0, 0)].s = XL_TITLE_STYLE;
  for (let r = 1; r <= 2; r++) {
    if (wsSummary[sc(r, 0)]) wsSummary[sc(r, 0)].s = XL_LABEL_STYLE;
    if (wsSummary[sc(r, 1)]) wsSummary[sc(r, 1)].s = XL_VALUE_STYLE;
  }
  for (let r = 4; r <= 8; r++) {
    if (wsSummary[sc(r, 0)]) wsSummary[sc(r, 0)].s = XL_LABEL_STYLE;
    if (wsSummary[sc(r, 1)]) wsSummary[sc(r, 1)].s = XL_VALUE_STYLE;
  }
  if (wsSummary[sc(10, 0)]) wsSummary[sc(10, 0)].s = {
    font: { name: "Arial", sz: 11, bold: true, color: { rgb: "1F4E79" } },
  };
  if (wsSummary[sc(10, 0)]) wsSummary[sc(10, 0)].s = {
    font: { name: "Arial", sz: 9 },
    alignment: { wrapText: true, vertical: "top" },
  };
  XLSX.utils.book_append_sheet(wb, wsSummary, "Executive Summary");

  // --- Sheet 2: Needs Review (outliers + borderline + negative GP + low GP%) ---
  const reviewHeaders = [
    "Review Reason", "Customer Id", "Customer Name", "ShipmentID", "Shipped Date",
    "Carrier", "Service", "Account Manager",
    "Shipment Marked-Up Rate", "Shipment Rate without mark up", "Shipment Gross Profit",
    "GP%", "Avg GP%", "StdDev", "Deviation",
  ];
  if (perRowNotes) reviewHeaders.push("AI Notes");
  const reviewData = [reviewHeaders];
  const sortedReview = [...(reviewRows || [])].sort((a, b) => (b._deviation || 0) - (a._deviation || 0));
  for (const r of sortedReview) {
    const sid = r["ShipmentID"] || "";
    const rowData = [
      r._reviewReason || "",
      r["Customer Id"] || "", r["Customer Name"] || "", sid, r["Shipped Date"] || "",
      r["Carrier"] || "", r["Service"] || "", r["Account Manager"] || "",
      r["Shipment Marked-Up Rate"] || "", r["Shipment Rate without mark up"] || "", r["Shipment Gross Profit"] || "",
      r._gpPct != null ? r._gpPct.toFixed(2) + "%" : "",
      r._customerMean != null ? r._customerMean.toFixed(2) + "%" : "",
      r._customerStdev != null ? r._customerStdev.toFixed(2) : "",
      r._deviation != null ? r._deviation.toFixed(2) : "",
    ];
    if (perRowNotes) rowData.push(perRowNotes.get(sid) || "");
    reviewData.push(rowData);
  }
  if (reviewData.length === 1) reviewData.push(["No rows flagged for review."]);
  const wsReview = XLSX.utils.aoa_to_sheet(reviewData);
  wsReview["!cols"] = reviewHeaders.map((h) => ({
    wch: h === "AI Notes" ? 50 : h === "Review Reason" ? 30 : 18,
  }));
  const reasonColIdx = 0;
  styleDataSheet(wsReview, reviewData, -1);
  for (let r = 1; r < reviewData.length; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: reasonColIdx });
    if (wsReview[addr]) {
      const reason = String(wsReview[addr].v || "");
      if (reason.includes("Outlier")) {
        wsReview[addr].s = { ...wsReview[addr].s, font: { ...XL_YES_FONT } };
      } else if (reason.includes("Borderline")) {
        wsReview[addr].s = { ...wsReview[addr].s, font: { name: "Arial", sz: 9, bold: true, color: { rgb: "D4A017" } } };
      } else {
        wsReview[addr].s = { ...wsReview[addr].s, font: { name: "Arial", sz: 9, bold: true, color: { rgb: "9C4500" } } };
      }
    }
  }
  XLSX.utils.book_append_sheet(wb, wsReview, "Needs Review");

  // --- Sheet 3: Outliers ---
  const outlierRows = rows.filter((r) => r._isOutlier);
  const outlierData = [["Customer Id", "Customer Name", "ShipmentID", "Shipped Date", "Shipment Marked-Up Rate", "Shipment Gross Profit", "GP%", "Avg GP%", "StdDev", "Deviation"]];
  for (const r of outlierRows.sort((a, b) => (b._deviation || 0) - (a._deviation || 0))) {
    outlierData.push([
      r["Customer Id"] || "", r["Customer Name"] || "", r["ShipmentID"] || "", r["Shipped Date"] || "",
      r["Shipment Marked-Up Rate"] || "", r["Shipment Gross Profit"] || "",
      r._gpPct != null ? r._gpPct.toFixed(2) + "%" : "",
      r._customerMean != null ? r._customerMean.toFixed(2) + "%" : "",
      r._customerStdev != null ? r._customerStdev.toFixed(2) : "",
      r._deviation != null ? r._deviation.toFixed(2) : "",
    ]);
  }
  if (outlierData.length === 1) outlierData.push(["No outliers detected."]);
  const wsOutliers = XLSX.utils.aoa_to_sheet(outlierData);
  wsOutliers["!cols"] = outlierData[0].map(() => ({ wch: 18 }));
  styleDataSheet(wsOutliers, outlierData, -1);
  XLSX.utils.book_append_sheet(wb, wsOutliers, "Outliers");

  // --- Sheet 4: By Customer ---
  const custData = [["Customer Id", "Customer Name", "Shipment Count", "Avg GP%", "StdDev", "Outlier Count"]];
  for (const [, st] of stats) {
    custData.push([st.customerId, st.customerName, st.count, st.mean.toFixed(2) + "%", st.stdev.toFixed(2), st.outlierCount]);
  }
  const wsCust = XLSX.utils.aoa_to_sheet(custData);
  wsCust["!cols"] = custData[0].map(() => ({ wch: 18 }));
  styleDataSheet(wsCust, custData, -1);
  XLSX.utils.book_append_sheet(wb, wsCust, "By Customer");

  // --- Sheet 5: All Transactions ---
  const allHeaders = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!k.startsWith("_")) allHeaders.add(k);
    }
  }
  const allKeys = [...allHeaders];
  allKeys.push("GP%");
  const allData = [allKeys];
  for (const r of rows) {
    const vals = allKeys.map((k) => {
      if (k === "GP%") return r._gpPct != null ? r._gpPct.toFixed(2) + "%" : "";
      return r[k] || "";
    });
    allData.push(vals);
  }
  const wsAll = XLSX.utils.aoa_to_sheet(allData);
  wsAll["!cols"] = allData[0].map(() => ({ wch: 18 }));
  styleDataSheet(wsAll, allData, -1);
  XLSX.utils.book_append_sheet(wb, wsAll, "All Transactions");

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeDateLabel = bizDate.replace(/[\/\s—]+/g, "-").replace(/-{2,}/g, "-");
  a.download = `fpx-gp-audit-${safeDateLabel}-${ts}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

  console.log("[FPX-GP] findDateInputs: found", candidates.length, "date-like inputs");

  for (const input of candidates) {
    const label = getNearbyLabelText(input);
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();
    console.log("[FPX-GP]   candidate:", input.type, "id='" + input.id + "' name='" + input.name + "' nearby='" + label.slice(0, 60) + "'");

    if (!result.from && (label.includes("FROM") || name.includes("from") || id.includes("from") || name.includes("start"))) {
      result.from = input;
    } else if (!result.to && (label.includes("TO DATE") || label.includes("TO:") || name.includes("to") || id.includes("to") || name.includes("end"))) {
      result.to = input;
    }
  }

  if ((!result.from || !result.to) && candidates.length >= 2) {
    console.log("[FPX-GP] Using positional fallback for date inputs");
    if (!result.from) result.from = candidates[0];
    if (!result.to) result.to = candidates[1];
  } else if ((!result.from || !result.to) && candidates.length === 1) {
    if (!result.from) result.from = candidates[0];
    if (!result.to) result.to = candidates[0];
  }

  console.log("[FPX-GP] Final: from=", result.from?.id || result.from?.name || "?", "to=", result.to?.id || result.to?.name || "?");
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
  console.log("[FPX-GP] Normalized", allRows.length, "rows. Sample keys:", Object.keys(allRows[0] || {}).join(", "));

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
  let execSummaryText = "";
  let perRowNotes = null;

  // Upload the audit run + rows to the server. The POST handler kicks off AI
  // in the background based on `ai_level`. Failures here only log; the local
  // XLSX download still happens so users aren't blocked on connectivity.
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

  let apiCost = null;
  try {
    apiCost = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getApiCost" }, resolve);
    });
  } catch {}

  sendGpStatus("Downloading GP Audit XLSX...");
  gpDownloadXLSX(allRows, stats, bizDate, reviewRows, execSummaryText, perRowNotes, apiCost);

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
      console.log("[FPX-GP] Angular retry failed:", e.message);
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
        console.log("[FPX-GP] Kendo dropdown failed:", e.message);
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
  console.log("[FPX-INV]", text);
  try { chrome.runtime.sendMessage({ type: "invoiceAuditStatus", text }); } catch {}
}

function sendInvComplete(text) {
  console.log("[FPX-INV] COMPLETE:", text);
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
    console.log("[FPX-INV] Kendo pageSize error:", e.message);
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
    if (val !== null) { console.log("[FPX-INV] #ShipmentSale by ID:", val); return val; }
  }

  const allWindows = document.querySelectorAll(".k-window, .modal, [role='dialog']");
  for (const modal of allWindows) {
    const text = modal.innerText || "";
    const m = text.match(/Shipment\s*Sale[s]?\s*[:\s]*\$?\s*([\d,]+\.?\d*)/i);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(val)) { console.log("[FPX-INV] ShipmentSale from modal text:", val); return val; }
    }
  }

  const bodyText = document.body.innerText || "";
  const m2 = bodyText.match(/Shipment\s*Sale[s]?\s*[:\s]*\$?\s*([\d,]+\.?\d*)/i);
  if (m2) {
    const val = parseFloat(m2[1].replace(/,/g, ""));
    if (Number.isFinite(val)) { console.log("[FPX-INV] ShipmentSale from body text:", val); return val; }
  }

  console.log("[FPX-INV] ShipmentSale NOT found. #ShipmentSale el:", byId, "modals found:", allWindows.length);
  return null;
}

function scrapeShipmentCostAmount() {
  const byId = document.getElementById("ShipmentCost");
  if (byId) {
    const val = parseMoneyText(byId);
    if (val !== null) { console.log("[FPX-INV] #ShipmentCost by ID:", val); return val; }
  }

  const allWindows = document.querySelectorAll(".k-window, .modal, [role='dialog']");
  for (const modal of allWindows) {
    const text = modal.innerText || "";
    const m = text.match(/Shipment\s*Cost\s*[:\s]*\$?\s*([\d,]+\.?\d*)/i);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(val)) { console.log("[FPX-INV] ShipmentCost from modal text:", val); return val; }
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
  let execSummaryText = "";
  let perRowNotes = null;

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

  // Grab API cost snapshot before downloading
  let apiCost = null;
  try {
    apiCost = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getApiCost" }, resolve);
    });
  } catch {}

  sendInvStatus("Downloading Invoice Audit XLSX...");
  invoiceDownloadXLSX(results, skippedRows, dateLabel, execSummaryText, perRowNotes, apiCost);

  sendInvComplete(
    `Invoice Audit done — ${results.length} shipment(s), ${discrepancies.length} discrepancy(ies), ${matches.length} match(es), ${errors.length} error(s).`
  );
}

function invoiceDownloadXLSX(results, skippedRows, dateLabel, execSummaryText, perRowNotes, apiCost) {
  if (typeof XLSX === "undefined") return;
  const wb = XLSX.utils.book_new();
  const sc = (r, c) => XLSX.utils.encode_cell({ r, c });

  const discrepancies = results.filter((r) => !r.matched && r.shipmentCost !== null);
  const matches = results.filter((r) => r.matched);
  const errors = results.filter((r) => r.error);
  const totalVariance = discrepancies.reduce((sum, r) => sum + (r.difference || 0), 0);

  const marginRows = results.filter((r) => r.marginDollars != null);
  const totalMargin = marginRows.reduce((s, r) => s + r.marginDollars, 0);
  const avgMarginPct = marginRows.length > 0
    ? +(marginRows.reduce((s, r) => s + (r.marginPct || 0), 0) / marginRows.length).toFixed(2)
    : 0;

  // --- Sheet 1: Executive Summary ---
  const summaryData = [
    ["FPXpress Invoice Audit Report"],
    ["Date Range", dateLabel],
    ["Generated", new Date().toLocaleString()],
    [],
    ["Data Sources"],
    ["  Carrier Invoice File", "Columns: Amount (→ Bill Amount), Memo (→ Shipment ID), Vendor, Invoice Number"],
    ["  FPX Transaction Grid", "Columns: Shipment Rate without mark up (→ Cost), Shipment Marked-Up Rate (→ Sale), Shipment Gross Profit"],
    [],
    ["Comparison", "Bill Amount (Carrier Invoice)  vs  Shipment Cost (FPX Grid)"],
    [],
    ["Total Audited", results.length],
    ["Matched (Bill = Cost)", matches.length],
    ["Discrepancies (Bill ≠ Cost)", discrepancies.length],
    ["Errors / Not Found", errors.length],
    ["Skipped (No ID)", (skippedRows || []).length],
    ["Total $ Variance", "$" + totalVariance.toFixed(2)],
    [],
    ["Total Est. Margin ($)", "$" + totalMargin.toFixed(2)],
    ["Avg Est. Margin (%)", avgMarginPct + "%"],
    [],
    ["Claude API Cost", apiCost ? `$${apiCost.totalUsd.toFixed(4)} (${apiCost.calls} calls, ${apiCost.inputTokens.toLocaleString()} in / ${apiCost.outputTokens.toLocaleString()} out tokens)` : "N/A"],
    [],
    ["AI Executive Summary"],
    [execSummaryText || "(AI analysis not enabled)"],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  wsSummary["!cols"] = [{ wch: 30 }, { wch: 100 }];
  if (wsSummary[sc(0, 0)]) wsSummary[sc(0, 0)].s = XL_TITLE_STYLE;
  for (let r = 1; r <= 2; r++) {
    if (wsSummary[sc(r, 0)]) wsSummary[sc(r, 0)].s = XL_LABEL_STYLE;
    if (wsSummary[sc(r, 1)]) wsSummary[sc(r, 1)].s = XL_VALUE_STYLE;
  }
  if (wsSummary[sc(4, 0)]) wsSummary[sc(4, 0)].s = { font: { name: "Arial", sz: 11, bold: true, color: { rgb: "1F4E79" } } };
  for (let r = 5; r <= 6; r++) {
    if (wsSummary[sc(r, 0)]) wsSummary[sc(r, 0)].s = XL_LABEL_STYLE;
    if (wsSummary[sc(r, 1)]) wsSummary[sc(r, 1)].s = { font: { name: "Arial", sz: 10, italic: true, color: { rgb: "555555" } } };
  }
  if (wsSummary[sc(8, 0)]) wsSummary[sc(8, 0)].s = XL_LABEL_STYLE;
  if (wsSummary[sc(8, 1)]) wsSummary[sc(8, 1)].s = { font: { name: "Arial", sz: 11, bold: true } };
  for (let r = 10; r <= 20; r++) {
    if (wsSummary[sc(r, 0)]) wsSummary[sc(r, 0)].s = XL_LABEL_STYLE;
    if (wsSummary[sc(r, 1)]) wsSummary[sc(r, 1)].s = XL_VALUE_STYLE;
  }
  if (wsSummary[sc(22, 0)]) wsSummary[sc(22, 0)].s = {
    font: { name: "Arial", sz: 11, bold: true, color: { rgb: "1F4E79" } },
  };
  XLSX.utils.book_append_sheet(wb, wsSummary, "Executive Summary");

  // --- Sheet 2: Discrepancies ---
  // Source labels: [CI] = Carrier Invoice file, [FPX] = FreightPOP Grid
  const discHeaders = [
    "Shipment ID", "[CI] Vendor", "[CI] Invoice #", "[CI] Bill Amount ($)",
    "[FPX] Cost ($)", "[FPX] Sale ($)", "[FPX] Gross Profit ($)",
    "Difference ($)", "% Difference", "Direction",
    "Est. Margin ($)", "Est. Margin %",
    "AI Notes",
  ];
  const discData = [discHeaders];
  for (const d of discrepancies) {
    discData.push([
      d.shipmentId,
      d.vendor,
      d.invoiceNumber,
      d.billAmount,
      d.shipmentCost != null ? d.shipmentCost : "",
      d.shipmentSale != null ? d.shipmentSale : "",
      d.grossProfit != null ? d.grossProfit : "",
      d.difference,
      d.pctDifference != null ? d.pctDifference + "%" : "",
      d.direction,
      d.marginDollars != null ? d.marginDollars : "",
      d.marginPct != null ? d.marginPct + "%" : "",
      perRowNotes ? (perRowNotes.get(d.shipmentId) || "") : "",
    ]);
  }
  const wsDisc = XLSX.utils.aoa_to_sheet(discData);
  wsDisc["!cols"] = [
    { wch: 14 }, { wch: 28 }, { wch: 18 }, { wch: 18 },
    { wch: 16 }, { wch: 16 }, { wch: 18 },
    { wch: 14 }, { wch: 12 }, { wch: 10 },
    { wch: 14 }, { wch: 12 },
    { wch: 50 },
  ];
  for (let c = 0; c < discHeaders.length; c++) {
    if (wsDisc[sc(0, c)]) wsDisc[sc(0, c)].s = XL_HDR_STYLE;
  }
  for (let r = 1; r < discData.length; r++) {
    const isAlt = r % 2 === 0;
    for (let c = 0; c < discHeaders.length; c++) {
      const cell = wsDisc[sc(r, c)];
      if (!cell) continue;
      cell.s = isAlt
        ? { ...XL_DATA_STYLE, fill: XL_ALT_FILL }
        : { ...XL_DATA_STYLE };
    }
  }
  XLSX.utils.book_append_sheet(wb, wsDisc, "Discrepancies");

  // --- Sheet 3: All Audited ---
  const allHeaders = [
    "Shipment ID", "[CI] Vendor", "[CI] Invoice #", "[CI] Bill Amount ($)",
    "[FPX] Cost ($)", "[FPX] Sale ($)", "[FPX] Gross Profit ($)",
    "Difference ($)", "% Difference", "Direction",
    "Est. Margin ($)", "Est. Margin %",
    "Status", "Error",
  ];
  const allData = [allHeaders];
  for (const r of results) {
    allData.push([
      r.shipmentId,
      r.vendor,
      r.invoiceNumber,
      r.billAmount,
      r.shipmentCost != null ? r.shipmentCost : "",
      r.shipmentSale != null ? r.shipmentSale : "",
      r.grossProfit != null ? r.grossProfit : "",
      r.difference != null ? r.difference : "",
      r.pctDifference != null ? r.pctDifference + "%" : "",
      r.direction,
      r.marginDollars != null ? r.marginDollars : "",
      r.marginPct != null ? r.marginPct + "%" : "",
      r.matched ? "MATCH" : r.error ? "ERROR" : "MISMATCH",
      r.error || "",
    ]);
  }
  const wsAll = XLSX.utils.aoa_to_sheet(allData);
  wsAll["!cols"] = [
    { wch: 14 }, { wch: 28 }, { wch: 18 }, { wch: 18 },
    { wch: 16 }, { wch: 16 }, { wch: 18 },
    { wch: 14 }, { wch: 12 }, { wch: 10 },
    { wch: 14 }, { wch: 12 },
    { wch: 12 }, { wch: 35 },
  ];
  for (let c = 0; c < allHeaders.length; c++) {
    if (wsAll[sc(0, c)]) wsAll[sc(0, c)].s = XL_HDR_STYLE;
  }
  for (let r = 1; r < allData.length; r++) {
    const isAlt = r % 2 === 0;
    for (let c = 0; c < allHeaders.length; c++) {
      const cell = wsAll[sc(r, c)];
      if (!cell) continue;
      cell.s = isAlt
        ? { ...XL_DATA_STYLE, fill: XL_ALT_FILL }
        : { ...XL_DATA_STYLE };
    }
  }
  XLSX.utils.book_append_sheet(wb, wsAll, "All Audited");

  // --- Sheet 4: Skipped ---
  const skipHeaders = ["Vendor", "Invoice Number", "Amount", "Memo"];
  const skipData = [skipHeaders];
  for (const s of (skippedRows || [])) {
    skipData.push([s.vendor, s.invoiceNumber, s.amount, s.memo]);
  }
  const wsSkip = XLSX.utils.aoa_to_sheet(skipData);
  wsSkip["!cols"] = [{ wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 50 }];
  for (let c = 0; c < skipHeaders.length; c++) {
    if (wsSkip[sc(0, c)]) wsSkip[sc(0, c)].s = XL_HDR_STYLE;
  }
  XLSX.utils.book_append_sheet(wb, wsSkip, "Skipped");

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeDateLabel = dateLabel.replace(/[/\s—]+/g, "-").replace(/-{2,}/g, "-");
  const ts = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  a.download = `fpx-invoice-audit-${safeDateLabel}-${ts}.xlsx`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 2000);
}

// =====================================================================
// MESSAGE LISTENER
// =====================================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log("[FPX] Message received:", msg);
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
