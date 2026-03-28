let stopRequested = false;
let logRows = [];
let aiEnabled = true;
let smartGateEnabled = false;

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

const DISPLAY_COLUMNS = [
  { key: "_trackingNumber", header: "Tracking Number" },
  { key: "SHIPMENT STATUS", header: "Shipment Status" },
  { key: "CARRIER", header: "Carrier" },
  { key: "CARRIER NAME", header: "Carrier Name" },
  { key: "MODE", header: "Mode" },
  { key: "COMMENTS", header: "Comments" },
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
  { key: "_timestamp", header: "Scraped At" },
  { key: "_error", header: "Error" },
];

function repairModelJson(s) {
  let t = s;
  t = t.replace(
    /"actionRequired"\s*:\s*true\s+or\s+false/gi,
    '"actionRequired": false'
  );
  t = t.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  return t;
}

function findAnalysisObject(obj, depth) {
  const d = depth ?? 0;
  if (d > 10 || obj == null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = findAnalysisObject(item, d + 1);
      if (f) return f;
    }
    return null;
  }
  const keys = Object.keys(obj);
  const hasSignal = keys.some((k) =>
    /actionrequired|issue|recommendation|action_required|requiresaction/i.test(
      k.replace(/_/g, "")
    )
  );
  if (hasSignal) return obj;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && typeof v === "object") {
      const f = findAnalysisObject(v, d + 1);
      if (f) return f;
    }
  }
  return null;
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/im);
  if (fence) t = fence[1].trim();
  t = repairModelJson(t);
  try {
    const p = JSON.parse(t);
    return findAnalysisObject(p, 0) || p;
  } catch {}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const slice = repairModelJson(t.slice(start, end + 1));
      const p = JSON.parse(slice);
      return findAnalysisObject(p, 0) || p;
    } catch {}
  }
  return null;
}

function coerceActionRequired(val) {
  if (val === undefined || val === null) return "";
  if (val === true || val === 1) return "YES";
  if (val === false || val === 0) return "NO";
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return "YES";
    if (["false", "no", "n", "0"].includes(s)) return "NO";
  }
  return "";
}

function stringifyField(v) {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

function normalizeAiFields(obj) {
  if (!obj || typeof obj !== "object") return null;
  const actionRaw =
    obj.actionRequired ??
    obj.ActionRequired ??
    obj.action_required ??
    obj.requiresAction ??
    obj.requires_action;
  const issue = stringifyField(obj.issue ?? obj.Issue);
  const recommendation = stringifyField(
    obj.recommendation ?? obj.Recommendation
  );
  return { actionRaw, issue, recommendation };
}

function isClearlyOnTrackIssue(issue) {
  if (!issue || typeof issue !== "string") return true;
  const s = issue.trim().toLowerCase();
  return (
    /^(none|n\/a)\b/.test(s) ||
    /\bon track\b/.test(s) ||
    /\bno issue\b/.test(s) ||
    /\bno action needed\b/.test(s) ||
    /\bno immediate action\b/.test(s) ||
    /\bshipment is on track\b/.test(s) ||
    /\bproceeding normally\b/.test(s) ||
    /\bas expected\b/.test(s)
  );
}

function deriveActionRequired(actionCoerced, issue) {
  if (actionCoerced === "YES") return "YES";
  const actionable =
    issue.length > 0 && !isClearlyOnTrackIssue(issue);
  if (actionCoerced === "NO" && actionable) return "YES";
  if (actionCoerced === "" && actionable) return "YES";
  return actionCoerced;
}

function scrapeFieldsFromLooseJson(text) {
  let issueM = text.match(/"issue"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!issueM) {
    const m2 = text.match(
      /"issue"\s*:\s*"([\s\S]*?)"\s*,\s*"recommendation"/i
    );
    if (m2) issueM = m2;
  }
  const recM = text.match(/"recommendation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const arTrue =
    /"actionRequired"\s*:\s*true\b/.test(text) ||
    /'actionRequired'\s*:\s*true\b/.test(text);
  const arFalse =
    /"actionRequired"\s*:\s*false\b/.test(text) ||
    /'actionRequired'\s*:\s*false\b/.test(text);
  return {
    issue: issueM ? issueM[1].replace(/\\"/g, '"').replace(/\\n/g, "\n") : "",
    recommendation: recM
      ? recM[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")
      : "",
    arTrue,
    arFalse,
  };
}

function applyAiResponseToRow(modalData, aiText) {
  const parsed = extractJsonObject(aiText);
  if (!parsed) {
    const loose = scrapeFieldsFromLooseJson(aiText);
    let coerced = "";
    if (loose.arTrue) coerced = "YES";
    else if (loose.arFalse) coerced = "NO";
    modalData._aiRawAnalysis = aiText;
    modalData._aiIssue = loose.issue || aiText;
    modalData._aiRecommendation = loose.recommendation;
    if (loose.issue || loose.arTrue || loose.arFalse) {
      modalData._actionRequired = deriveActionRequired(
        coerced,
        modalData._aiIssue
      );
    } else {
      modalData._actionRequired = "";
    }
    return;
  }
  const norm = normalizeAiFields(parsed);
  if (!norm) {
    modalData._aiRawAnalysis = aiText;
    modalData._actionRequired = "";
    modalData._aiIssue = aiText;
    modalData._aiRecommendation = "";
    return;
  }
  modalData._aiRawAnalysis = aiText;
  const coerced = coerceActionRequired(norm.actionRaw);
  modalData._actionRequired = deriveActionRequired(coerced, norm.issue);
  modalData._aiIssue = norm.issue;
  modalData._aiRecommendation = norm.recommendation;
}

function computeNeedsActionForSheet(r) {
  const ar = String(r._actionRequired ?? "").trim().toUpperCase();
  const issue = String(r._aiIssue ?? "").trim();
  const onTrack = isClearlyOnTrackIssue(issue);
  if (ar === "ERROR") return true;
  if (ar === "YES" || ar === "TRUE" || ar === "Y" || ar === "1") return true;
  if (ar === "NO") return issue.length > 0 && !onTrack;
  if (!issue) return false;
  if (onTrack) return false;
  if (issue.length > 4000) {
    return /\b(error|failed|contact|reschedule|delay|wrong|incorrect|attention|call|customer|data|delivery|attempt|problem|urgent|immediately)\b/i.test(
      issue
    );
  }
  return true;
}

function finalizeActionSheetFlag(r) {
  r._needsActionSheet = computeNeedsActionForSheet(r);
  if (r._needsActionSheet && r._actionRequired !== "ERROR") {
    r._actionRequired = "YES";
  }
}

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

function buildSummaryPayload(rows) {
  const actionRows = rows.filter((r) => r._needsActionSheet === true);
  const errorCount = rows.filter((r) => r._actionRequired === "ERROR").length;
  const noActionCount = rows.filter((r) => r._actionRequired === "NO").length;
  const SUMMARY_KEYS = [
    "_trackingNumber", "SHIPMENT STATUS", "CARRIER NAME", "MODE",
    "UPDATED ETA", "DELIVERY DATE", "_actionRequired", "_aiIssue",
    "_aiRecommendation",
  ];
  const compact = (r) => {
    const o = {};
    for (const k of SUMMARY_KEYS) {
      const v = r[k];
      if (v !== undefined && v !== "") o[k] = v;
    }
    return o;
  };
  return {
    total: rows.length,
    actionNeeded: actionRows.length,
    noAction: noActionCount,
    errors: errorCount,
    actionItems: actionRows.map(compact),
    sample: rows.filter((r) => !r._needsActionSheet).slice(0, 30).map(compact),
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
  const actionData = actionRows.length > 0
    ? rowsToSheetData(actionRows)
    : [["No action items found."]];
  const wsActions = XLSX.utils.aoa_to_sheet(actionData);
  wsActions["!cols"] = autoFitCols(actionData);
  if (actionRows.length > 0) {
    const actIdx = findHeaderIndex(actionData[0], "Action Required");
    styleDataSheet(wsActions, actionData, actIdx);
  }
  XLSX.utils.book_append_sheet(wb, wsActions, "Actions");

  // --- Sheet 2: Inputs (all scraped fields, dynamic columns) ---
  const INPUT_EXCLUDE = new Set([
    "_aiRawAnalysis", "_aiIssue", "_aiRecommendation",
    "_actionRequired", "_needsActionSheet",
    "_inputSummary", "_outputSummary",
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

const ROUTINE_STATUSES = new Set([
  "delivered", "in transit", "booked", "scheduled/tendered",
]);
const EXCEPTION_KEYWORDS = /\b(delay|exception|missed|failed|refused|damaged|lost|hold|return|cancel|wrong|incorrect|urgent|rescheduled|appointment missed)\b/i;

function shipmentNeedsAi(modalData) {
  if (!smartGateEnabled) return true;
  const status = (modalData["SHIPMENT STATUS"] || "").trim().toLowerCase();
  const comments = (modalData["COMMENTS"] || "").trim();
  if (status === "issue") return true;
  if (EXCEPTION_KEYWORDS.test(comments)) return true;
  if (ROUTINE_STATUSES.has(status) && !EXCEPTION_KEYWORDS.test(comments)) return false;
  return true;
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
      if (logRows.length > 0) downloadXLSX(logRows, "");
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    const link = links[i];
    const trackingNum = link.textContent.trim();
    sendStatus(`Processing ${i + 1} of ${total} — ${trackingNum}`);

    simulateClick(link);
    await sleep(300);

    sendStatus(`Clicked ${trackingNum} — waiting for modal...`);
    const closeBtn = await waitForCloseButton(15000);
    if (closeBtn) {
      await sleep(600);
      sendStatus(`Scraping modal data for ${trackingNum}...`);
      const modalData = scrapeModal();
      modalData._trackingNumber = trackingNum;
      modalData._timestamp = new Date().toISOString();

      if (aiEnabled) {
        if (shipmentNeedsAi(modalData)) {
          sendStatus(`Analyzing ${trackingNum} with AI...`);
          try {
            const aiResult = await chrome.runtime.sendMessage({
              type: "analyzeShipment",
              data: modalData,
            });
            if (aiResult && aiResult.text) {
              applyAiResponseToRow(modalData, aiResult.text);
            } else if (aiResult && aiResult.error) {
              modalData._aiRawAnalysis = aiResult.error;
              modalData._actionRequired = "ERROR";
              modalData._aiIssue = aiResult.error;
              modalData._aiRecommendation = "";
            }
          } catch (e) {
            modalData._aiRawAnalysis = e.message;
            modalData._actionRequired = "ERROR";
            modalData._aiIssue = e.message;
            modalData._aiRecommendation = "";
          }
        } else {
          modalData._actionRequired = "NO";
          modalData._aiIssue = "None - shipment is on track";
          modalData._aiRecommendation = "No action needed (auto-classified by smart gate).";
        }
        finalizeActionSheetFlag(modalData);
      } else {
        modalData._needsActionSheet = false;
      }

      modalData._inputSummary = buildInputSummary(modalData);
      modalData._outputSummary = buildOutputSummary(modalData);
      logRows.push(modalData);

      const actionTag = modalData._needsActionSheet ? " [ACTION NEEDED]" : "";
      sendStatus(`Done ${trackingNum}${actionTag} — closing modal...`);
      simulateClick(closeBtn);
      await sleep(300);
    } else {
      logRows.push({
        _trackingNumber: trackingNum,
        _timestamp: new Date().toISOString(),
        _error: "Modal did not appear (timeout)",
        _actionRequired: "",
        _aiIssue: "",
        _aiRecommendation: "",
        _inputSummary: `Tracking: ${trackingNum}`,
        _outputSummary: "Error: Modal did not appear (timeout)",
        _needsActionSheet: false,
      });
      sendStatus(`Timeout on ${trackingNum} — no modal appeared, skipping.`);
    }

    await sleep(500);
  }
}

async function run(filterCol, filterVal, useAi, useSmartGate) {
  stopRequested = false;
  logRows = [];
  aiEnabled = useAi !== false;
  smartGateEnabled = useSmartGate === true;

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
      if (logRows.length > 0) downloadXLSX(logRows, "");
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    sendStatus(`Processing page ${pageNum}...`);
    await processPage();

    if (stopRequested) {
      if (logRows.length > 0) downloadXLSX(logRows, "");
      sendComplete(`Stopped by user. ${logRows.length} row(s) logged.`);
      return;
    }

    sendStatus(`Page ${pageNum} done. Checking for next page...`);
    const advanced = goToNextPage();
    if (!advanced) break;

    pageNum++;
    await waitForGridReady(3000);
  }

  let summaryText = "";
  if (logRows.length > 0) {
    if (aiEnabled) {
      sendStatus(`Requesting AI summary for ${logRows.length} shipment(s)...`);
      try {
        const summaryResult = await chrome.runtime.sendMessage({
          type: "summarizeAll",
          payload: buildSummaryPayload(logRows),
        });
        if (summaryResult && summaryResult.text) {
          summaryText = summaryResult.text;
        } else if (summaryResult && summaryResult.error) {
          summaryText = "Summary error: " + summaryResult.error;
        }
      } catch (e) {
        summaryText = "Summary error: " + e.message;
      }
    }

    sendStatus(`Downloading XLSX with ${logRows.length} row(s)...`);
    downloadXLSX(logRows, summaryText);
  }

  const actionCount = logRows.filter((r) => r._needsActionSheet === true).length;
  try {
    chrome.runtime.sendMessage({ type: "aiSummary", text: summaryText });
  } catch {}
  sendComplete(
    `Done — ${pageNum} page(s), ${logRows.length} shipment(s). ${actionCount} need action.\n\n${summaryText}`
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log("[FPX] Message received:", msg);
  if (msg.action === "ping") {
    sendResponse({ ok: true });
  } else if (msg.action === "start") {
    run(msg.filterCol, msg.filterVal, msg.aiEnabled, msg.smartGate);
    sendResponse({ ok: true });
  } else if (msg.action === "stop") {
    stopRequested = true;
    sendResponse({ ok: true });
  }
});
