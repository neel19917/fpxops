let stopRequested = false;
let logRows = [];
let aiEnabled = true;
let smartGateEnabled = false;
let useBatchMode = false;

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
    if (!key || key.length > 200) continue;

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
  if (ar === "ERROR") return true;
  if (ar === "YES" || ar === "TRUE" || ar === "Y" || ar === "1") return true;
  if (ar === "NO") return false;
  if (!issue) return false;
  if (isClearlyOnTrackIssue(issue)) return false;
  if (issue.length > 4000) {
    return /\b(error|failed|delay|contact|missing|stuck|exception|damaged|refused|undeliverable)\b/i.test(
      issue
    );
  }
  return true;
}

function finalizeActionSheetFlag(r) {
  r._needsActionSheet = computeNeedsActionForSheet(r);
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
  const jobs = collectShipmentJobs();
  const total = jobs.length;

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

    const { link, pickupResponse } = jobs[i];
    const trackingNum = link.textContent.trim();
    sendStatus(`Processing ${i + 1} of ${total} — ${trackingNum}`);

    simulateClick(link);
    await sleep(350);

    sendStatus(`Clicked ${trackingNum} — waiting for modal...`);
    const closeBtn = await waitForCloseButton(25000);
    if (closeBtn) {
      await sleep(400);
      sendStatus(`Scraping modal data for ${trackingNum}...`);
      const modalData = scrapeModal();
      modalData._trackingNumber = trackingNum;
      modalData._timestamp = new Date().toISOString();
      applyGridPickupResponse(modalData, pickupResponse);

      if (aiEnabled && !useBatchMode) {
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
      } else if (!useBatchMode) {
        modalData._needsActionSheet = modalData._actionRequired === "ERROR";
      }

      modalData._inputSummary = buildInputSummary(modalData);
      modalData._outputSummary = buildOutputSummary(modalData);
      delete modalData["FULL MODAL TEXT"];
      delete modalData["_aiRawAnalysis"];
      logRows.push(modalData);

      if (logRows.length % 25 === 0) {
        try { chrome.storage.local.set({ _fpxCheckpoint: logRows }); } catch {}
      }

      const actionTag = modalData._needsActionSheet ? " [ACTION NEEDED]" : "";
      sendStatus(`Done ${trackingNum}${actionTag} — closing modal...`);
      simulateClick(closeBtn);
      await sleep(250);
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
      timeoutRow._inputSummary = buildInputSummary(timeoutRow);
      logRows.push(timeoutRow);
      sendStatus(`Timeout on ${trackingNum} — no modal appeared, skipping.`);
    }

    await sleep(300);
  }
}

const BATCH_CHUNK_SIZE = 25;

async function tryBatchAnalyze(rows) {
  const total = rows.length;
  const allAnalyzed = [];
  const summaries = [];
  let totalErrors = 0;

  sendStatus(`Batch analysis: ${total} shipment(s) in chunks of ${BATCH_CHUNK_SIZE}...`);

  for (let offset = 0; offset < total; offset += BATCH_CHUNK_SIZE) {
    if (stopRequested) return null;

    const chunk = rows.slice(offset, offset + BATCH_CHUNK_SIZE);
    const chunkEnd = Math.min(offset + BATCH_CHUNK_SIZE, total);
    sendStatus(`Analyzing batch ${offset + 1}–${chunkEnd} of ${total}...`);

    try {
      const result = await chrome.runtime.sendMessage({
        type: "analyzeBatch",
        rows: chunk,
      });

      if (result && result.error) {
        sendStatus(`Batch ${offset + 1}–${chunkEnd} failed: ${result.error}. Continuing...`);
        for (const row of chunk) {
          allAnalyzed.push({ ...row, _actionRequired: "ERROR", _aiIssue: result.error, _aiRecommendation: "" });
        }
        totalErrors += chunk.length;
        continue;
      }

      if (result && Array.isArray(result.analyzed)) {
        allAnalyzed.push(...result.analyzed);
        if (result.summary) summaries.push(result.summary);
        totalErrors += result.errors || 0;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  return {
    analyzed: allAnalyzed,
    summary: summaries.join("\n\n"),
    errors: totalErrors,
  };
}

async function fallbackPerRowAnalysis() {
  sendStatus("LangGraph server unavailable — falling back to per-row AI analysis...");
  for (let i = 0; i < logRows.length; i++) {
    if (stopRequested) return;
    const row = logRows[i];
    if (row._actionRequired) continue;

    sendStatus(`Fallback AI: ${i + 1}/${logRows.length} — ${row._trackingNumber || "?"}`);
    if (shipmentNeedsAi(row)) {
      try {
        const aiResult = await chrome.runtime.sendMessage({
          type: "analyzeShipment",
          data: row,
        });
        if (aiResult && aiResult.text) {
          applyAiResponseToRow(row, aiResult.text);
        } else if (aiResult && aiResult.error) {
          row._aiRawAnalysis = aiResult.error;
          row._actionRequired = "ERROR";
          row._aiIssue = aiResult.error;
          row._aiRecommendation = "";
        }
      } catch (e) {
        row._aiRawAnalysis = e.message;
        row._actionRequired = "ERROR";
        row._aiIssue = e.message;
        row._aiRecommendation = "";
      }
    } else {
      row._actionRequired = "NO";
      row._aiIssue = "None - shipment is on track";
      row._aiRecommendation = "No action needed (auto-classified by smart gate).";
    }
    finalizeActionSheetFlag(row);
    row._inputSummary = buildInputSummary(row);
    row._outputSummary = buildOutputSummary(row);
  }
}

async function run(filterCol, filterVal, useAi, useSmartGate) {
  stopRequested = false;
  logRows = [];
  aiEnabled = useAi !== false;
  smartGateEnabled = useSmartGate === true;
  useBatchMode = false;

  if (aiEnabled) {
    sendStatus("Checking LangGraph server...");
    try {
      const serverCheck = await chrome.runtime.sendMessage({ type: "checkServer" });
      if (serverCheck && serverCheck.online) {
        useBatchMode = true;
        sendStatus("LangGraph server online — using batch mode.");
      } else {
        sendStatus("LangGraph server offline — using per-row mode.");
      }
    } catch {
      sendStatus("LangGraph server unreachable — using per-row mode.");
    }
  }

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
  if (logRows.length > 0 && aiEnabled) {
    if (useBatchMode) {
      const batchResult = await tryBatchAnalyze(logRows);
      if (batchResult) {
        const analyzedMap = new Map();
        for (const a of batchResult.analyzed) {
          analyzedMap.set(a._trackingNumber || "", a);
        }
        for (const row of logRows) {
          const match = analyzedMap.get(row._trackingNumber || "");
          if (match) {
            row._actionRequired = match._actionRequired || "";
            row._aiIssue = match._aiIssue || "";
            row._aiRecommendation = match._aiRecommendation || "";
            row._needsActionSheet = match._needsActionSheet;
          }
          finalizeActionSheetFlag(row);
          row._inputSummary = buildInputSummary(row);
          row._outputSummary = buildOutputSummary(row);
          delete row._aiRawAnalysis;
        }
        summaryText = batchResult.summary || "";
        sendStatus(`Batch analysis complete — ${logRows.length} shipments processed.`);
      } else {
        await fallbackPerRowAnalysis();
        sendStatus(`Requesting AI summary for ${logRows.length} shipment(s)...`);
        try {
          const summaryResult = await chrome.runtime.sendMessage({
            type: "summarizeAll",
            payload: buildSummaryPayload(logRows),
          });
          if (summaryResult && summaryResult.text) summaryText = summaryResult.text;
          else if (summaryResult && summaryResult.error)
            summaryText = "Summary error: " + summaryResult.error;
        } catch (e) {
          summaryText = "Summary error: " + e.message;
        }
      }
    } else {
      sendStatus(`Requesting AI summary for ${logRows.length} shipment(s)...`);
      try {
        const summaryResult = await chrome.runtime.sendMessage({
          type: "summarizeAll",
          payload: buildSummaryPayload(logRows),
        });
        if (summaryResult && summaryResult.text) summaryText = summaryResult.text;
        else if (summaryResult && summaryResult.error)
          summaryText = "Summary error: " + summaryResult.error;
      } catch (e) {
        summaryText = "Summary error: " + e.message;
      }
    }
  }

  if (logRows.length > 0) {
    sendStatus(`Downloading XLSX with ${logRows.length} row(s)...`);
    downloadXLSX(logRows, summaryText);
  }

  try { chrome.storage.local.remove("_fpxCheckpoint"); } catch {}

  const actionCount = logRows.filter((r) => r._needsActionSheet === true).length;
  try {
    chrome.runtime.sendMessage({ type: "aiSummary", text: summaryText });
  } catch {}
  sendComplete(
    `Done — ${pageNum} page(s), ${logRows.length} shipment(s). ${actionCount} need action.\n\n${summaryText}`
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

function scrapeTransactionGrid() {
  const $ = window.jQuery;

  if ($) {
    const gridEl = $(".k-grid").first();
    const kendoGrid = gridEl.data("kendoGrid");
    if (kendoGrid) {
      const ds = kendoGrid.dataSource;
      const total = ds.total();
      const pageData = ds.data();
      const rows = [];
      const skipKeys = new Set(["_events", "uid", "dirty", "_handlers"]);

      for (let i = 0; i < pageData.length; i++) {
        const item = pageData[i];
        const row = {};
        for (const key of Object.keys(item)) {
          if (skipKeys.has(key) || key.startsWith("_")) continue;
          const val = item[key];
          if (val === null || val === undefined || val === "") continue;
          row[key] = typeof val === "object" ? JSON.stringify(val) : String(val);
        }
        if (Object.keys(row).length > 0) rows.push(row);
      }
      console.log("[FPX-GP] Kendo API: got", rows.length, "of", total, "total rows. Keys:", Object.keys(rows[0] || {}).join(", "));
      return rows;
    }
  }

  console.log("[FPX-GP] Kendo grid not found, falling back to DOM scrape");
  const grid = document.querySelector(".k-grid");
  if (!grid) return [];

  const headers = [];
  for (const th of grid.querySelectorAll("th")) {
    const link = th.querySelector("a.k-link");
    headers.push((link ? link.textContent : th.textContent || "").replace(/\s+/g, " ").trim());
  }

  const rows = [];
  for (const tr of grid.querySelectorAll("tbody tr")) {
    if (tr.classList.contains("k-grouping-row") || tr.classList.contains("k-no-data")) continue;
    const cells = tr.querySelectorAll("td");
    const row = {};
    for (let i = 0; i < cells.length && i < headers.length; i++) {
      if (!headers[i]) continue;
      const val = (cells[i].textContent || "").replace(/\s+/g, " ").trim();
      if (val) row[headers[i]] = val;
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  console.log("[FPX-GP] DOM scrape:", rows.length, "rows");
  return rows;
}

function getKendoGridAllRows() {
  const $ = window.jQuery;
  if (!$) return null;

  const gridEl = $(".k-grid").first();
  const kendoGrid = gridEl.data("kendoGrid");
  if (!kendoGrid) return null;

  const ds = kendoGrid.dataSource;
  const total = ds.total();
  const pageSize = ds.pageSize();
  const totalPages = ds.totalPages();

  console.log("[FPX-GP] Kendo grid: total=" + total + " pageSize=" + pageSize + " pages=" + totalPages);

  if (total <= 0) return [];

  const allRows = [];
  const skipKeys = new Set(["_events", "uid", "dirty", "_handlers"]);

  for (let page = 1; page <= totalPages; page++) {
    ds.page(page);
    const pageData = ds.data();
    for (let i = 0; i < pageData.length; i++) {
      const item = pageData[i];
      const row = {};
      for (const key of Object.keys(item)) {
        if (skipKeys.has(key) || key.startsWith("_")) continue;
        const val = item[key];
        if (val === null || val === undefined || val === "") continue;
        row[key] = typeof val === "object" ? JSON.stringify(val) : String(val);
      }
      if (Object.keys(row).length > 0) allRows.push(row);
    }
  }

  console.log("[FPX-GP] Kendo all-pages: got", allRows.length, "rows across", totalPages, "pages");
  return allRows;
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

function gpDownloadXLSX(rows, stats, bizDate) {
  if (!rows.length || typeof XLSX === "undefined") return;
  const wb = XLSX.utils.book_new();

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

  const custData = [["Customer Id", "Customer Name", "Shipment Count", "Avg GP%", "StdDev", "Outlier Count"]];
  for (const [, st] of stats) {
    custData.push([st.customerId, st.customerName, st.count, st.mean.toFixed(2) + "%", st.stdev.toFixed(2), st.outlierCount]);
  }
  const wsCust = XLSX.utils.aoa_to_sheet(custData);
  wsCust["!cols"] = custData[0].map(() => ({ wch: 18 }));
  styleDataSheet(wsCust, custData, -1);
  XLSX.utils.book_append_sheet(wb, wsCust, "By Customer");

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
  a.download = `fpx-gp-audit-${bizDate.replace(/\//g, "-")}-${ts}.xlsx`;
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

async function gpAuditRun(bizDate, shipmentType) {
  stopRequested = false;

  if (shipmentType === "all") {
    sendGpStatus("Running GP Audit for ALL types (Non-Parcel + Parcel)...");
    const nonParcelRows = await gpAuditSingleRun(bizDate, "non-parcel");
    if (stopRequested) return;
    const parcelRows = await gpAuditSingleRun(bizDate, "parcel");
    if (stopRequested) return;

    const allRows = [...(nonParcelRows || []), ...(parcelRows || [])];
    if (allRows.length === 0) {
      sendGpComplete("No transactions found for " + bizDate + ".");
      return;
    }
    sendGpStatus(`Combined ${allRows.length} total transaction(s). Computing GP stats...`);
    gpFinalize(allRows, bizDate);
    return;
  }

  const rows = await gpAuditSingleRun(bizDate, shipmentType);
  if (stopRequested) return;
  if (!rows || rows.length === 0) {
    sendGpComplete("No transactions found for " + bizDate + ".");
    return;
  }
  gpFinalize(rows, bizDate);
}

function gpFinalize(allRows, bizDate) {
  for (let i = 0; i < allRows.length; i++) {
    allRows[i] = normalizeRowKeys(allRows[i]);
  }
  console.log("[FPX-GP] Normalized", allRows.length, "rows. Sample keys:", Object.keys(allRows[0] || {}).join(", "));

  const stats = gpComputeStats(allRows);
  gpFlagOutliers(allRows, stats);

  const outliers = allRows.filter((r) => r._isOutlier);
  sendGpStatus(`Found ${outliers.length} outlier(s) across ${stats.size} customer(s).`);

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

  sendGpStatus("Downloading GP Audit XLSX...");
  gpDownloadXLSX(allRows, stats, bizDate);

  sendGpComplete(
    `GP Audit done — ${allRows.length} transaction(s), ${stats.size} customer(s), ${outliers.length} outlier(s).`
  );
}

async function gpAuditSingleRun(bizDate, shipmentType) {
  const typeLabel = shipmentType === "parcel" ? "Parcel" : "Non-Parcel";
  sendGpStatus("Starting GP Audit (" + typeLabel + ") for " + bizDate + "...");

  const currentUrl = window.location.href;
  if (!currentUrl.includes("Transactions")) {
    sendGpStatus("Navigating to Transactions page...");
    window.location.hash = "#!/Transactions";
    await sleep(3000);
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
      await sleep(1500);
    }
    await sleep(500);
  }

  if (!dialogFound) {
    sendGpStatus("Looking for Generate Report button...");
    const allBtns = document.querySelectorAll("button, a.btn, input[type='button']");
    for (const b of allBtns) {
      if (/generate\s*report/i.test(b.textContent || b.value || "")) {
        simulateClick(b);
        await sleep(2000);
        break;
      }
    }
  }

  await sleep(1000);

  sendGpStatus("Filling date fields with " + bizDate + "...");

  const dateFields = findDateInputs();
  if (!dateFields.from && !dateFields.to) {
    sendGpStatus("ERROR: Could not find any date inputs on this page. Check that the Generate History Report dialog is open.");
    sendGpComplete("Failed — no date inputs found.");
    return;
  }

  if (dateFields.from) {
    setDateInput(dateFields.from, bizDate);
    sendGpStatus("Set FROM DATE to " + bizDate + " (value: " + dateFields.from.value + ")");
  }
  await sleep(500);

  if (dateFields.to) {
    setDateInput(dateFields.to, bizDate);
    sendGpStatus("Set TO DATE to " + bizDate + " (value: " + dateFields.to.value + ")");
  }
  await sleep(500);

  function retryDateFill(input, label) {
    if (!input || input.value) return;
    const parts = bizDate.split("/");
    const isoVal = `${parts[2]}-${parts[0]}-${parts[1]}`;
    const valForType = input.type === "date" ? isoVal : bizDate;

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

  retryDateFill(dateFields.from, "FROM DATE");
  retryDateFill(dateFields.to, "TO DATE");
  await sleep(500);

  sendGpStatus("Setting SELECT CUSTOMER to All Customers...");
  const selects = document.querySelectorAll("select");
  for (const sel of selects) {
    const row = sel.closest("tr, div, .form-group");
    const rowText = row ? row.textContent.toUpperCase() : "";
    const name = (sel.name || "").toLowerCase();
    const id = (sel.id || "").toLowerCase();

    if (rowText.includes("CUSTOMER") || name.includes("customer") || id.includes("customer")) {
      for (const opt of sel.options) {
        if (/all\s*customers/i.test(opt.text)) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          sendGpStatus("Set customer dropdown to: " + opt.text);
          break;
        }
      }

      try {
        const kendoWidget = window.jQuery && window.jQuery(sel).data("kendoDropDownList");
        if (kendoWidget) {
          const ds = kendoWidget.dataSource.data();
          for (let i = 0; i < ds.length; i++) {
            if (/all\s*customers/i.test(ds[i].text || ds[i].Text || ds[i].Name || "")) {
              kendoWidget.select(i);
              kendoWidget.trigger("change");
              sendGpStatus("Set customer via Kendo dropdown");
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
  await sleep(500);

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
  await sleep(3000);

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
    await sleep(1000);
  }

  if (!gridReady) {
    sendGpStatus("No grid data loaded for " + typeLabel + ". The form may not have submitted.");
    return [];
  }

  sendGpStatus("Selecting " + typeLabel + " tab...");
  clickShipmentTypeTab(shipmentType);
  await sleep(2000);
  await waitForGridReady(5000);

  sendGpStatus("Reading " + typeLabel + " transaction data...");

  let allRows = getKendoGridAllRows();

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
  } else if (msg.action === "gpAudit") {
    gpAuditRun(msg.bizDate, msg.shipmentType);
    sendResponse({ ok: true });
  }
});
