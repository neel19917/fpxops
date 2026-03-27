let stopRequested = false;
let logRows = [];

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

// Poll for a visible CLOSE button up to `timeout` ms.
function waitForCloseButton(timeout = 15000) {
  return new Promise((resolve) => {
    const interval = 500;
    let elapsed = 0;

    const timer = setInterval(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if (
          btn.innerText.trim().toUpperCase() === "CLOSE" &&
          btn.offsetParent !== null
        ) {
          clearInterval(timer);
          resolve(btn);
          return;
        }
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
  await sleep(800);

  // Find the visible filter popup containing a "Filter" button.
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

  // Ensure operator is "Is equal to".
  if (selects.length >= 1) {
    const opSelect = selects[0];
    if (opSelect.value !== "eq") {
      opSelect.value = "eq";
      opSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(300);
    }
  } else if (kendoDropdowns.length >= 1) {
    const opDd = kendoDropdowns[0];
    if (!opDd.textContent.includes("Is equal to")) {
      (opDd.querySelector(".k-dropdown-wrap, .k-input") || opDd).click();
      await sleep(500);
      for (const item of document.querySelectorAll(
        ".k-animation-container .k-list .k-item, .k-popup .k-item"
      )) {
        if (item.textContent.trim() === "Is equal to") {
          item.click();
          break;
        }
      }
      await sleep(400);
    }
  }

  // Set the value — try native <select>, then Kendo dropdown, then text input.
  let valueSet = false;

  if (selects.length >= 2) {
    const valSelect = selects[1];
    valSelect.value = value;
    valSelect.dispatchEvent(new Event("change", { bubbles: true }));
    valueSet = true;
    await sleep(300);
  }

  if (!valueSet && kendoDropdowns.length >= 2) {
    const valDd = kendoDropdowns[1];
    (valDd.querySelector(".k-dropdown-wrap, .k-input") || valDd).click();
    await sleep(600);
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
    await sleep(400);
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
      await sleep(300);
    }
  }

  if (!valueSet) {
    sendStatus(`Could not set "${value}" in filter — skipping.`);
    return;
  }

  await sleep(300);
  for (const btn of filterPopup.querySelectorAll("button")) {
    if (btn.textContent.trim() === "Filter") {
      btn.click();
      break;
    }
  }

  sendStatus(`Filtered ${colName} to "${value}".`);
  await sleep(2000);
}

// READ-ONLY CLICK: dispatch a mouse-click sequence on the element without
// scrolling the page. This extension NEVER types into fields, NEVER
// dispatches input/change events on data cells, and NEVER modifies grid
// data. The only writes are: (a) filter dropdown selection during the
// filter step, (b) clicking <a> links to open modals, (c) clicking the
// CLOSE button. All three are safe read-only operations.
function simulateClick(el) {
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 1,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
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

  // Pattern A: <label>FIELD</label> next to <span>/<div>/<input> with value
  const labels = modal.querySelectorAll("label, strong, b, .field-label, .control-label, dt");
  for (const lbl of labels) {
    const key = lbl.textContent.trim().replace(/:$/, "");
    if (!key || key.length > 60) continue;

    let val = "";
    const next = lbl.nextElementSibling;
    if (next) {
      val = (next.value || next.textContent || "").trim();
    }
    if (!val) {
      const parent = lbl.closest(".form-group, .field-row, .row, dd, div");
      if (parent) {
        const allText = parent.textContent.trim();
        val = allText.replace(key, "").replace(/^[:\s]+/, "").trim();
      }
    }
    if (key && key !== "CLOSE") {
      data[key] = val;
    }
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

  console.log("[FPX] Scraped modal data:", data);
  return data;
}

function downloadCSV(rows) {
  if (!rows.length) return;

  const allKeys = [];
  const keySet = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keySet.has(key)) {
        keySet.add(key);
        allKeys.push(key);
      }
    }
  }

  const escape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };

  const lines = [allKeys.map(escape).join(",")];
  for (const row of rows) {
    lines.push(allKeys.map((k) => escape(row[k] || "")).join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `tracking-refresh-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Find the Tracking Number column index from the grid header using the
// data-field attribute, then collect clickable elements from that column
// in every body row.
function collectTrackingLinks() {
  // Step 1: find the Tracking Number column via data-field attribute.
  const trackingHeader = document.querySelector(
    'th[data-field="TrackingNumber"], th[data-field="trackingNumber"]'
  );
  const dataIndex = trackingHeader
    ? parseInt(trackingHeader.getAttribute("data-index"), 10)
    : -1;

  console.log("[FPX] TrackingNumber header found:", !!trackingHeader, "data-index:", dataIndex);

  // Step 2: count locked (frozen) columns so we can compute the offset
  // inside the scrollable body table.
  const lockedHeaders = document.querySelectorAll(
    ".k-grid-header-locked th, .k-grid-header-locked td"
  );
  const lockedCount = lockedHeaders.length;
  const scrollIndex = dataIndex >= 0 ? dataIndex - lockedCount : -1;

  console.log("[FPX] Locked columns:", lockedCount, "Scroll-body column index:", scrollIndex);

  // Step 3: get body rows from the scrollable section of the grid.
  const bodyRows = document.querySelectorAll(
    ".k-grid-content tbody tr, .k-grid-content-locked tbody tr"
  );
  // Also try all tbody rows if the above finds nothing.
  const allRows = bodyRows.length > 0
    ? bodyRows
    : document.querySelectorAll(".k-grid tbody tr");

  console.log("[FPX] Body rows found:", allRows.length);

  const links = [];

  for (const row of allRows) {
    if (row.classList.contains("k-grouping-row")) continue;
    if (row.classList.contains("k-no-data")) continue;
    const cells = row.querySelectorAll("td");

    // Try the computed column index first.
    let cell = null;
    if (scrollIndex >= 0 && scrollIndex < cells.length) {
      cell = cells[scrollIndex];
    }
    // Fallback: try with the raw data-index.
    if ((!cell || !cell.textContent.trim()) && dataIndex >= 0 && dataIndex < cells.length) {
      cell = cells[dataIndex];
    }

    if (!cell) continue;

    // Find any clickable element inside the cell: <a>, or element with
    // ng-click, or the cell itself if it has text content.
    const clickable =
      cell.querySelector("a") ||
      cell.querySelector("[ng-click]") ||
      cell.querySelector("[onclick]") ||
      cell.querySelector("span[style*='cursor']") ||
      cell.querySelector("span.k-link");

    if (clickable && clickable.textContent.trim()) {
      links.push(clickable);
      console.log("[FPX]   Found:", clickable.textContent.trim(), "tag:", clickable.tagName);
    } else if (cell.textContent.trim() && cell.querySelector("*")) {
      // If no obvious clickable child, look for any child with text.
      const children = cell.querySelectorAll("*");
      for (const child of children) {
        const t = child.textContent.trim();
        if (t && child.childElementCount === 0 && /\d/.test(t)) {
          links.push(child);
          console.log("[FPX]   Found (fallback):", t, "tag:", child.tagName);
          break;
        }
      }
    }
  }

  console.log("[FPX] Matched tracking links:", links.map((el) => el.textContent.trim()));
  sendStatus(`Found ${links.length} tracking link(s) on this page.`);
  return links;
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

async function processPage() {
  const links = collectTrackingLinks();
  const total = links.length;

  if (total === 0) {
    sendStatus("No tracking links found on this page.");
    return;
  }

  for (let i = 0; i < total; i++) {
    if (stopRequested) {
      if (logRows.length > 0) downloadCSV(logRows);
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    const link = links[i];
    const trackingNum = link.textContent.trim();
    sendStatus(`Processing ${i + 1} of ${total} — ${trackingNum}`);

    simulateClick(link);
    await sleep(500);

    sendStatus(`Clicked ${trackingNum} — waiting for modal...`);
    const closeBtn = await waitForCloseButton(15000);
    if (closeBtn) {
      await sleep(1000);
      sendStatus(`Scraping modal data for ${trackingNum}...`);
      const modalData = scrapeModal();
      modalData._trackingNumber = trackingNum;
      modalData._timestamp = new Date().toISOString();
      logRows.push(modalData);

      sendStatus(`Closing modal for ${trackingNum}...`);
      simulateClick(closeBtn);
      await sleep(500);
    } else {
      logRows.push({
        _trackingNumber: trackingNum,
        _timestamp: new Date().toISOString(),
        _error: "Modal did not appear (timeout)",
      });
      sendStatus(`Timeout on ${trackingNum} — no modal appeared, skipping.`);
    }

    await sleep(1000);
  }
}

async function run(filterCol, filterVal) {
  stopRequested = false;
  logRows = [];

  if (filterCol && filterVal) {
    sendStatus(`Filtering ${filterCol} to "${filterVal}"...`);
    await applyFilter(filterCol, filterVal);
    await sleep(1000);
  } else {
    sendStatus("No filter set — proceeding with current grid view.");
  }

  let pageNum = 1;

  while (true) {
    if (stopRequested) {
      if (logRows.length > 0) downloadCSV(logRows);
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    sendStatus(`Processing page ${pageNum}...`);
    await processPage();

    if (stopRequested) {
      if (logRows.length > 0) downloadCSV(logRows);
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    sendStatus(`Page ${pageNum} done. Checking for next page...`);
    const advanced = goToNextPage();
    if (!advanced) break;

    pageNum++;
    await sleep(2000); // wait for grid to reload
  }

  if (logRows.length > 0) {
    sendStatus(`Downloading CSV with ${logRows.length} row(s)...`);
    downloadCSV(logRows);
  }

  sendComplete(`Done — processed ${pageNum} page(s), ${logRows.length} tracking number(s) logged.`);
}

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
  }
});
