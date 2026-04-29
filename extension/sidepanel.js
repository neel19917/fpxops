const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");
const filterColSelect = document.getElementById("filterCol");
const filterValSelect = document.getElementById("filterVal");
const apiBadge = document.getElementById("apiBadge");
const costBadge = document.getElementById("costBadge");
// New branded header status + footer (defined in the redesigned sidepanel.html).
// Old apiBadge / costBadge / serverBadge stay in the DOM but hidden so this code
// can keep updating them without crashing legacy callers / tests.
const fpHeaderDot = document.getElementById("fpHeaderDot");
const fpHeaderText = document.getElementById("fpHeaderText");
const fpHeaderStatus = document.getElementById("fpHeaderStatus");
const fpFooterCost = document.getElementById("fpFooterCost");
const fpFooterServer = document.getElementById("fpFooterServer");

// Track API-key + server state so the header dot can reflect both:
// — green only when key is set AND server is reachable
// — amber when key set but server offline
// — red when key missing
let _hasApiKey = false;
let _serverOnline = false;
let _serverVersion = "";
let _serverUptime = null;
function renderHeaderStatus() {
  if (!fpHeaderDot || !fpHeaderText) return;
  let dotClass, label, title;
  if (!_hasApiKey) {
    dotClass = "offline";
    label = "Setup needed";
    title = "Open the popup to paste your API key.";
  } else if (!_serverOnline) {
    dotClass = "offline";
    label = "API offline";
    title = "Server isn't reachable. Try again or check your URL.";
  } else {
    dotClass = "online";
    label = "Connected";
    title = `API v${_serverVersion || "?"}` + (_serverUptime != null ? ` · up ${Math.round(_serverUptime / 60)}m` : "");
  }
  fpHeaderDot.className = "fp-status-dot " + dotClass;
  fpHeaderText.textContent = label;
  if (fpHeaderStatus) fpHeaderStatus.title = title;
}
const serverBadge = document.getElementById("serverBadge");
const serverCtrl = document.getElementById("serverCtrl");
const serverToggleBtn = document.getElementById("serverToggleBtn");
const serverInfo = document.getElementById("serverInfo");
const serverSub = document.getElementById("serverSub");
const serverHint = document.getElementById("serverHint");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");

const VALUE_OPTIONS = {
  Mode: ["LTL", "Parcel", "Truckload", "Air", "Ocean", "Auto", "Other"],
  "Shipment status": [
    "Booked", "Scheduled/Tendered", "In Transit", "Out for Delivery",
    "Delivered", "Issue", "PickupUnverified",
  ],
  "Carrier Name": [],
  "Company Name": [],
};

// --- Filter dropdowns ---

function populateValues() {
  const col = filterColSelect.value;
  filterValSelect.innerHTML = '<option value="">-- Select --</option>';
  const options = VALUE_OPTIONS[col] || [];
  for (const val of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    filterValSelect.appendChild(opt);
  }
}
filterColSelect.addEventListener("change", populateValues);
populateValues();

// --- Running state ---

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  filterColSelect.disabled = running;
  filterValSelect.disabled = running;
  if (!running) {
    progressBar.classList.remove("visible");
    progressText.classList.remove("visible");
  }
}

chrome.runtime.sendMessage({ type: "getState" }, (res) => {
  if (res) {
    statusDiv.textContent = res.status;
    if (res.running) setRunning(true);
  }
});

// --- API key check ---

function refreshApiKeyState() {
  chrome.runtime.sendMessage({ type: "checkApiKey" }, (res) => {
    const configured = !!(res && res.configured);
    _hasApiKey = configured;
    if (configured) {
      apiBadge.textContent = "API Key OK";
      apiBadge.classList.remove("missing");
      apiBadge.classList.add("ok");
    } else {
      apiBadge.textContent = "No API Key";
      apiBadge.classList.remove("ok");
      apiBadge.classList.add("missing");
    }
    renderHeaderStatus();
  });
}
refreshApiKeyState();

// --- Claude API cost tracking ---

function updateCostBadge() {
  chrome.runtime.sendMessage({ type: "getApiCost" }, (res) => {
    if (!res) return;
    const usd = res.totalUsd || 0;
    const txt = `$${usd.toFixed(4)}`;
    const title = `${res.calls || 0} API call(s) · ${(res.inputTokens || 0).toLocaleString()} in / ${(res.outputTokens || 0).toLocaleString()} out tokens — click to reset`;
    costBadge.textContent = txt;
    costBadge.title = title;
    costBadge.style.background = usd > 1 ? "#fef2f2" : usd > 0.1 ? "#fffbeb" : "#eff6ff";
    costBadge.style.color = usd > 1 ? "#991b1b" : usd > 0.1 ? "#92400e" : "#1e40af";
    if (fpFooterCost) {
      fpFooterCost.textContent = `Session: ${txt}`;
      fpFooterCost.title = title;
    }
  });
}
updateCostBadge();
setInterval(updateCostBadge, 5000);

function resetCostHandler() {
  if (confirm("Reset session API cost to $0?")) {
    chrome.runtime.sendMessage({ type: "resetApiCost" }, () => updateCostBadge());
  }
}
costBadge.addEventListener("click", resetCostHandler);
fpFooterCost?.addEventListener("click", resetCostHandler);

// --- API server health + (for localhost) Start/Stop control -----------------

let serverOnline = false;
let isLocalApi = false;
let busy = false;

function formatUptime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function setBtn(label, cls, disabled) {
  if (!serverToggleBtn) return;
  serverToggleBtn.textContent = label;
  serverToggleBtn.className = cls;
  serverToggleBtn.disabled = !!disabled;
}

function updateServerStatus(online, version, uptime) {
  serverOnline = online;
  _serverOnline = !!online;
  _serverVersion = version || "";
  _serverUptime = uptime != null ? uptime : null;
  if (online) {
    const uptimeStr = uptime != null ? ` (up ${formatUptime(uptime)})` : "";
    serverBadge.className = "server-badge online";
    serverBadge.innerHTML = `<span class="dot"></span> API v${version || "?"}${uptimeStr}`;
    if (isLocalApi) {
      serverInfo.textContent = uptimeStr;
      serverSub.textContent = "Server is running. Click Stop to shut it down when you're done.";
      setBtn("Stop", "stop", busy);
      serverHint.classList.remove("visible");
    }
    if (fpFooterServer) fpFooterServer.textContent = `API v${version || "?"}${uptimeStr}`;
  } else {
    serverBadge.className = "server-badge offline";
    serverBadge.innerHTML = '<span class="dot"></span> API offline';
    if (isLocalApi) {
      serverInfo.textContent = "";
      serverSub.textContent = "Click Start to launch the Node server on your machine.";
      setBtn("Start", "start", busy);
    }
    if (fpFooterServer) fpFooterServer.textContent = "API offline";
  }
  renderHeaderStatus();
}

function checkServer() {
  chrome.runtime.sendMessage({ type: "checkServer" }, (res) => {
    if (chrome.runtime.lastError) return;
    updateServerStatus(res && res.online, res && res.version, res && res.uptime);
  });
}

function refreshServerCard() {
  chrome.runtime.sendMessage({ type: "getApiKey" }, (res) => {
    if (chrome.runtime.lastError) return;
    const url = (res && res.url) || "";
    // Only show Start/Stop when the API URL is localhost — cloud deploys don't need it.
    isLocalApi = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url);
    if (serverCtrl) serverCtrl.hidden = !isLocalApi;
  });
  checkServer();
}

if (serverToggleBtn) {
  serverToggleBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    if (serverOnline) {
      setBtn("Stopping…", "stop", true);
      chrome.runtime.sendMessage({ type: "stopServer" }, (res) => {
        busy = false;
        if (!res || res.ok === false) {
          serverHint.textContent = (res && res.error) || "Couldn't stop the server. See install-native-host setup.";
          serverHint.classList.add("visible");
        }
        setTimeout(checkServer, 600);
      });
    } else {
      setBtn("Starting…", "start", true);
      chrome.runtime.sendMessage({ type: "startServer" }, (res) => {
        busy = false;
        if (!res || res.ok === false) {
          const err = (res && res.error) || "";
          if (/native host|not installed|not found|disconnect/i.test(err)) {
            serverHint.textContent = "The native host isn't installed yet. Double-click install-native-host.command (Mac) or install-native-host.bat (Windows) in the FPXpress folder, paste this extension's ID when asked, then reload the extension.";
          } else {
            serverHint.textContent = err || "Couldn't start the server.";
          }
          serverHint.classList.add("visible");
          setBtn("Start", "start", false);
          return;
        }
        // Give Node a moment to bind the port, then poll health.
        setTimeout(checkServer, 1200);
        setTimeout(checkServer, 2800);
      });
    }
  });
}

refreshServerCard();
setInterval(checkServer, 15000);

// Persistent-upload queue indicator. Renders as a small chip next to
// the server-status display so the rep sees pending/dead chunks at a
// glance. We poll every 10 s — chrome.storage events would be more
// elegant but the chip is unobtrusive enough that polling is fine.
function refreshQueueStatus() {
  chrome.runtime.sendMessage({ type: "getQueueStatus" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    const el = document.getElementById("fp-queue-status");
    if (!el) return;
    const total = (res.pending || 0) + (res.dead || 0);
    if (total === 0) { el.hidden = true; return; }
    el.hidden = false;
    const parts = [];
    if (res.pending) parts.push(`${res.pending} pending`);
    if (res.dead)    parts.push(`${res.dead} failed`);
    el.textContent = `Upload queue: ${parts.join(" · ")} (${res.total_rows} row${res.total_rows === 1 ? "" : "s"})`;
    el.title = res.last_errors && res.last_errors.length
      ? `Last errors:\n${res.last_errors.map((e) => `• ${e.error}`).join("\n")}\nClick to retry.`
      : "Click to retry the queue manually.";
  });
}
const queueStatusEl = document.getElementById("fp-queue-status");
if (queueStatusEl) {
  queueStatusEl.addEventListener("click", () => {
    queueStatusEl.textContent = "Retrying queue…";
    chrome.runtime.sendMessage({ type: "flushQueue" }, () => refreshQueueStatus());
  });
}
refreshQueueStatus();
setInterval(refreshQueueStatus, 10000);

// Re-evaluate when the popup saves a new URL/key.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "apiKeyUpdated") {
    refreshServerCard();
    refreshApiKeyState();
  }
});

// --- Content script injection ---

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function sendToTab(action, data) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await ensureContentScript(tab.id);
  chrome.tabs.sendMessage(tab.id, { action, ...data });
}

// --- Start / Stop ---

startBtn.addEventListener("click", async () => {
  const filterCol = filterColSelect.value;
  const filterVal = filterValSelect.value;

  setRunning(true);
  progressBar.classList.add("visible");
  progressText.classList.add("visible");
  progressFill.style.width = "0%";
  progressText.textContent = "";
  statusDiv.textContent = "Scraping shipments — analysis runs in the dashboard after upload.";
  chrome.runtime.sendMessage({ type: "setRunning", running: true });

  try {
    await sendToTab("start", { filterCol, filterVal });
  } catch (e) {
    statusDiv.textContent = "Error: " + e.message;
    setRunning(false);
  }
});

stopBtn.addEventListener("click", async () => {
  setRunning(false);
  statusDiv.textContent = "Stopping...";
  chrome.runtime.sendMessage({ type: "setRunning", running: false });
  try {
    await sendToTab("stop");
  } catch (e) {
    statusDiv.textContent = "Error: " + e.message;
  }
});

// --- Listen for status, complete, progress, and AI summary ---

function parseProgress(text) {
  const m = text.match(/(\d+)\s+of\s+(\d+)/i);
  if (m) return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  const m2 = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (m2) return { current: parseInt(m2[1], 10), total: parseInt(m2[2], 10) };
  return null;
}

// --- Tab switching ---

const tabTracking = document.getElementById("tabTracking");
const tabGpAudit = document.getElementById("tabGpAudit");
const tabInvoiceAudit = document.getElementById("tabInvoiceAudit");
const trackingTabContent = document.getElementById("trackingTab");
const gpAuditTabContent = document.getElementById("gpAuditTab");
const invoiceAuditTabContent = document.getElementById("invoiceAuditTab");

function switchTab(tab) {
  tabTracking.classList.toggle("active", tab === "tracking");
  tabGpAudit.classList.toggle("active", tab === "gp");
  tabInvoiceAudit.classList.toggle("active", tab === "invoice");
  trackingTabContent.classList.toggle("active", tab === "tracking");
  gpAuditTabContent.classList.toggle("active", tab === "gp");
  invoiceAuditTabContent.classList.toggle("active", tab === "invoice");
  if (tab === "gp") fetchGpDate();
  if (tab === "invoice") fetchInvDate();
}

tabTracking.addEventListener("click", () => switchTab("tracking"));
tabGpAudit.addEventListener("click", () => switchTab("gp"));
tabInvoiceAudit.addEventListener("click", () => switchTab("invoice"));

// --- GP Audit logic ---

const gpDateInfo = document.getElementById("gpDateInfo");
const gpStartBtn = document.getElementById("gpStartBtn");
const gpStopBtn = document.getElementById("gpStopBtn");
const gpStatus = document.getElementById("gpStatus");
const gpProgressBar = document.getElementById("gpProgressBar");
const gpProgressFill = document.getElementById("gpProgressFill");
const gpProgressText = document.getElementById("gpProgressText");
const gpOutlierAlert = document.getElementById("gpOutlierAlert");
const gpOutlierList = document.getElementById("gpOutlierList");
const gpNoOutliers = document.getElementById("gpNoOutliers");
const gpAiSummarySection = document.getElementById("gpAiSummarySection");
const gpAiSummaryText = document.getElementById("gpAiSummaryText");
const gpQuickFilters = document.getElementById("gpQuickFilters");
const gpCustomDateRow = document.getElementById("gpCustomDateRow");
const gpCustomFrom = document.getElementById("gpCustomFrom");
const gpCustomTo = document.getElementById("gpCustomTo");
const gpCustomerFilter = document.getElementById("gpCustomerFilter");

let gpNtpToday = null;
let gpNtpSource = "ntp";
let gpDateMode = "lastBizDay";
let gpFromDate = null;
let gpToDate = null;

function fmtMmDdYyyy(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function fmtIso(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function lastBizDay(today) {
  const day = today.getDay();
  const offset = day === 0 ? 2 : day === 1 ? 3 : day === 6 ? 1 : 1;
  const d = new Date(today);
  d.setDate(d.getDate() - offset);
  return d;
}

function calcDateRange(mode, today) {
  const t = new Date(today);
  const y = t.getFullYear();
  const m = t.getMonth();
  const lbd = lastBizDay(t);

  function clampTo(from, to) {
    return to >= from ? to : from;
  }

  switch (mode) {
    case "lastBizDay":
      return { from: lbd, to: lbd };
    case "last7": {
      const from = new Date(t);
      from.setDate(from.getDate() - 7);
      return { from, to: lbd };
    }
    case "last30": {
      const from = new Date(t);
      from.setDate(from.getDate() - 30);
      return { from, to: lbd };
    }
    case "thisWeek": {
      const dayOfWeek = t.getDay();
      const monday = new Date(t);
      monday.setDate(monday.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      return { from: monday, to: clampTo(monday, lbd) };
    }
    case "thisMonth": {
      const from = new Date(y, m, 1);
      return { from, to: clampTo(from, lbd) };
    }
    case "lastMonth":
      return { from: new Date(y, m - 1, 1), to: new Date(y, m, 0) };
    case "thisQuarter": {
      const qStart = Math.floor(m / 3) * 3;
      const from = new Date(y, qStart, 1);
      return { from, to: clampTo(from, lbd) };
    }
    default:
      return null;
  }
}

function updateDateDisplay() {
  if (!gpNtpToday) {
    gpDateInfo.textContent = "Fetching date...";
    return;
  }

  if (gpDateMode === "custom") {
    if (gpCustomFrom.value && gpCustomTo.value) {
      const parts1 = gpCustomFrom.value.split("-");
      const parts2 = gpCustomTo.value.split("-");
      gpFromDate = `${parts1[1]}/${parts1[2]}/${parts1[0]}`;
      gpToDate = `${parts2[1]}/${parts2[2]}/${parts2[0]}`;
      gpDateInfo.textContent = `Custom range: ${gpFromDate} — ${gpToDate}`;
    } else {
      gpFromDate = null;
      gpToDate = null;
      gpDateInfo.textContent = "Select from and to dates";
    }
    return;
  }

  const range = calcDateRange(gpDateMode, gpNtpToday);
  if (!range) return;
  gpFromDate = fmtMmDdYyyy(range.from);
  gpToDate = fmtMmDdYyyy(range.to);

  const src = gpNtpSource === "local" ? " (local clock)" : "";
  const modeLabels = {
    lastBizDay: "Last Business Day",
    last7: "Last 7 Days",
    last30: "Last 30 Days",
    thisWeek: "This Week",
    thisMonth: "This Month",
    lastMonth: "Last Month",
    thisQuarter: "This Quarter",
  };

  if (gpFromDate === gpToDate) {
    gpDateInfo.textContent = `${modeLabels[gpDateMode]}: ${gpFromDate}${src}`;
  } else {
    gpDateInfo.textContent = `${modeLabels[gpDateMode]}: ${gpFromDate} — ${gpToDate}${src}`;
  }
}

gpQuickFilters.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  gpDateMode = btn.dataset.mode;
  for (const b of gpQuickFilters.querySelectorAll("button")) {
    b.classList.toggle("active", b === btn);
  }
  gpCustomDateRow.classList.toggle("visible", gpDateMode === "custom");
  updateDateDisplay();
});

gpCustomFrom.addEventListener("change", updateDateDisplay);
gpCustomTo.addEventListener("change", updateDateDisplay);

function fetchGpDate() {
  gpDateInfo.textContent = "Fetching date...";
  chrome.runtime.sendMessage({ type: "fetchNtpDate" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      gpDateInfo.textContent = "Could not fetch date. Please retry.";
      return;
    }
    const parts = res.today.split("/");
    gpNtpToday = new Date(+parts[2], +parts[0] - 1, +parts[1]);
    gpNtpSource = res.source;

    const todayIso = fmtIso(gpNtpToday);
    gpCustomTo.max = todayIso;
    gpCustomFrom.max = todayIso;

    updateDateDisplay();
  });
}

function setGpRunning(running) {
  gpStartBtn.disabled = running;
  gpStopBtn.disabled = !running;
  if (!running) {
    gpProgressBar.classList.remove("visible");
    gpProgressText.classList.remove("visible");
  }
}

gpStartBtn.addEventListener("click", async () => {
  if (!gpFromDate || !gpToDate) {
    gpStatus.textContent = "Date not loaded yet. Please wait...";
    if (!gpNtpToday) fetchGpDate();
    return;
  }
  setGpRunning(true);
  gpProgressBar.classList.add("visible");
  gpProgressText.classList.add("visible");
  gpProgressFill.style.width = "0%";
  gpProgressText.textContent = "";
  gpStatus.textContent = "Starting GP Audit...";
  gpOutlierAlert.classList.remove("visible");
  gpNoOutliers.classList.remove("visible");
  gpAiSummarySection?.classList.remove("visible");
  chrome.runtime.sendMessage({ type: "setRunning", running: true });

  const shipmentType = document.getElementById("gpShipmentType").value;
  // The AI dropdown is hidden (analysis runs server-side); fall back to
  // 'summary' if the element was removed entirely.
  const aiAnalysis = document.getElementById("gpAiAnalysis")?.value || "summary";
  const customerFilter = gpCustomerFilter.value.trim();

  try {
    await sendToTab("gpAudit", {
      fromDate: gpFromDate,
      toDate: gpToDate,
      shipmentType,
      aiAnalysis,
      customerFilter,
    });
  } catch (e) {
    gpStatus.textContent = "Error: " + e.message;
    setGpRunning(false);
  }
});

gpStopBtn.addEventListener("click", async () => {
  setGpRunning(false);
  gpStatus.textContent = "Stopping...";
  chrome.runtime.sendMessage({ type: "setRunning", running: false });
  try {
    await sendToTab("stop");
  } catch (e) {
    gpStatus.textContent = "Error: " + e.message;
  }
});

// --- GP Audit Prompt Editor ---

const GP_DEFAULT_PROMPTS = {
  system:
    "You are a freight brokerage GP (gross profit) analyst. You review GP audit reports " +
    "covering one or more business days from the FreightPOP transaction history. " +
    "Your audience is brokerage operations management. Be precise with numbers, " +
    "reference actual customer names and IDs, and clearly separate urgent items from informational observations.",
  execSummary:
    "You are reviewing a GP audit for a freight brokerage. The JSON below contains:\n\n" +
    "• date — the shipped date(s) covered\n" +
    "• totalShipments, totalCustomers, outlierCount, reviewCount — aggregate counts\n" +
    "• customerSummaries[] — per-customer: customerId, customerName, shipments (count), avgGpPct, stdev, outliers (count)\n" +
    "• flaggedShipments[] — rows needing review: shipmentId, customerId, customerName, markedUpRate, grossProfit, gpPct, customerAvgGpPct, deviation, reason (e.g. 'Outlier >2 STDEV', 'Borderline >1.5 STDEV', 'Negative gross profit', 'GP% below 2%'), carrier, service\n\n" +
    "GP% = Gross Profit / Marked-Up Rate × 100. Outliers are >2 standard deviations from that customer's average. Borderline = 1.5–2 STDEV.\n\n" +
    "Write an executive summary in markdown with these sections:\n" +
    "1. **Overall GP Health** — one-line verdict (Healthy / Mixed / Critical), then 2-3 sentences on portfolio-wide margin trends.\n" +
    "2. **Critical Outliers** — each outlier customer with ID, shipment count, avg GP%, volatility, and specific flagged shipments. State what's abnormal and why it matters.\n" +
    "3. **Patterns & Trends** — systematic underperformance, auto-pricing floors, carrier-specific variance, volume vs. margin traps.\n" +
    "4. **Recommended Actions** — prioritized (Immediate / This Week / Strategic). Be specific: name the customer, the action, and the expected outcome.\n\n" +
    "Rules:\n" +
    "- Reference actual customer names/IDs and shipment IDs from the data — do NOT generalize.\n" +
    "- Healthy brokerage GP benchmark is 15-20%. Flag anything consistently below 10%.\n" +
    "- If customers show zero stdev, note potential auto-pricing/flat-rate concerns.\n" +
    "- Keep total length 250-400 words.\n\n" +
    "Data:\n{{data}}",
  rowReview:
    "You are reviewing a single flagged shipment from a freight brokerage GP audit.\n\n" +
    "The JSON contains: shipmentId, customerId, customerName, markedUpRate, rateWithoutMarkup, " +
    "grossProfit, gpPct (Gross Profit / Marked-Up Rate × 100), customerAvgGpPct, stdev, " +
    "deviation (how far from mean in percentage points), reason (why it was flagged), carrier, service, accountManager.\n\n" +
    "Provide a 2-3 sentence assessment:\n" +
    "1. Why this GP% is unusual for this customer.\n" +
    "2. Most likely cause (pricing error, carrier cost spike, rate negotiation issue, one-off accessorial, etc.).\n" +
    "3. What the account manager should verify or do next.\n\n" +
    "Be specific. Reference the actual numbers.\n\n" +
    "Shipment:\n{{row}}",
};

const gpSystemPromptEl = document.getElementById("gpSystemPrompt");
const gpExecSummaryPromptEl = document.getElementById("gpExecSummaryPrompt");
const gpRowReviewPromptEl = document.getElementById("gpRowReviewPrompt");
const gpSavePromptsBtn = document.getElementById("gpSavePromptsBtn");
const gpResetPromptsBtn = document.getElementById("gpResetPromptsBtn");
const gpSaveStatusEl = document.getElementById("gpSaveStatus");
const gpPromptToggle = document.getElementById("gpPromptToggle");
const gpPromptArrow = document.getElementById("gpPromptArrow");
const gpPromptEditor = document.getElementById("gpPromptEditor");

// GP audit prompt editor is hidden (analysis runs in the dashboard now).
// We keep the wiring so users with stale prompts in chrome.storage.local
// can still see them if the elements are restored, but every binding
// optional-chains so a future hard-removal won't crash sidepanel.js.
gpPromptToggle?.addEventListener("click", () => {
  if (!gpPromptEditor) return;
  const isOpen = gpPromptEditor.classList.toggle("visible");
  gpPromptArrow?.classList.toggle("open", isOpen);
});

chrome.storage.local.get("gpPrompts", (res) => {
  const p = res.gpPrompts || {};
  if (gpSystemPromptEl) gpSystemPromptEl.value = p.system || GP_DEFAULT_PROMPTS.system;
  if (gpExecSummaryPromptEl) gpExecSummaryPromptEl.value = p.execSummary || GP_DEFAULT_PROMPTS.execSummary;
  if (gpRowReviewPromptEl) gpRowReviewPromptEl.value = p.rowReview || GP_DEFAULT_PROMPTS.rowReview;
});

gpSavePromptsBtn?.addEventListener("click", () => {
  const gpPrompts = {
    system: gpSystemPromptEl?.value || "",
    execSummary: gpExecSummaryPromptEl?.value || "",
    rowReview: gpRowReviewPromptEl?.value || "",
  };
  chrome.storage.local.set({ gpPrompts }, () => {
    if (gpSaveStatusEl) {
      gpSaveStatusEl.textContent = "Saved!";
      setTimeout(() => { gpSaveStatusEl.textContent = ""; }, 2000);
    }
  });
});

gpResetPromptsBtn?.addEventListener("click", () => {
  if (gpSystemPromptEl) gpSystemPromptEl.value = GP_DEFAULT_PROMPTS.system;
  if (gpExecSummaryPromptEl) gpExecSummaryPromptEl.value = GP_DEFAULT_PROMPTS.execSummary;
  if (gpRowReviewPromptEl) gpRowReviewPromptEl.value = GP_DEFAULT_PROMPTS.rowReview;
  chrome.storage.local.set({ gpPrompts: { ...GP_DEFAULT_PROMPTS } }, () => {
    if (gpSaveStatusEl) {
      gpSaveStatusEl.textContent = "Reset to defaults!";
      setTimeout(() => { gpSaveStatusEl.textContent = ""; }, 2000);
    }
  });
});

// =====================================================================
// INVOICE AUDIT
// =====================================================================

const invModeToggle = document.getElementById("invModeToggle");
const invBatchFields = document.getElementById("invBatchFields");
const invSingleFields = document.getElementById("invSingleFields");
const invFileZone = document.getElementById("invFileZone");
const invFileInput = document.getElementById("invFileInput");
const invFileName = document.getElementById("invFileName");
const invParsedInfo = document.getElementById("invParsedInfo");
const invSingleId = document.getElementById("invSingleId");
const invSingleAmount = document.getElementById("invSingleAmount");
const invDateInfo = document.getElementById("invDateInfo");
const invLookbackFilters = document.getElementById("invLookbackFilters");
const invCustomDateRow = document.getElementById("invCustomDateRow");
const invCustomFrom = document.getElementById("invCustomFrom");
const invCustomTo = document.getElementById("invCustomTo");
const invStartBtn = document.getElementById("invStartBtn");
const invStopBtn = document.getElementById("invStopBtn");
const invStatus = document.getElementById("invStatus");
const invProgressBar = document.getElementById("invProgressBar");
const invProgressFill = document.getElementById("invProgressFill");
const invProgressText = document.getElementById("invProgressText");
const invDiscAlert = document.getElementById("invDiscAlert");
const invDiscList = document.getElementById("invDiscList");
const invNoDisc = document.getElementById("invNoDisc");
const invAiSummarySection = document.getElementById("invAiSummarySection");
const invAiSummaryText = document.getElementById("invAiSummaryText");

let invMode = "batch";
let invParsedShipments = [];
let invSkippedRows = [];
let invNtpToday = null;
let invNtpSource = "ntp";
let invLookbackDays = 180;
let invFromDate = null;
let invToDate = null;

// --- Mode toggle ---

invModeToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  invMode = btn.dataset.mode;
  for (const b of invModeToggle.querySelectorAll("button")) {
    b.classList.toggle("active", b === btn);
  }
  invBatchFields.style.display = invMode === "batch" ? "block" : "none";
  invSingleFields.classList.toggle("visible", invMode === "single");
});

// --- File upload ---

invFileZone.addEventListener("click", () => invFileInput.click());
invFileZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  invFileZone.classList.add("dragover");
});
invFileZone.addEventListener("dragleave", () => invFileZone.classList.remove("dragover"));
invFileZone.addEventListener("drop", (e) => {
  e.preventDefault();
  invFileZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) parseInvoiceFile(e.dataTransfer.files[0]);
});
invFileInput.addEventListener("change", () => {
  if (invFileInput.files.length) parseInvoiceFile(invFileInput.files[0]);
});

function parseInvoiceFile(file) {
  invFileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

      invParsedShipments = [];
      invSkippedRows = [];

      for (const r of rows) {
        const memo = String(r.Memo || "").trim();
        const idMatch = memo.match(/^(\d{5,})/);
        if (idMatch) {
          invParsedShipments.push({
            shipmentId: idMatch[1],
            billAmount: parseFloat(r.Amount) || 0,
            vendor: r.Vendor || "",
            invoiceNumber: r["Invoice Number"] || "",
            memo,
          });
        } else {
          invSkippedRows.push({
            vendor: r.Vendor || "",
            invoiceNumber: r["Invoice Number"] || "",
            amount: r.Amount || "",
            memo,
          });
        }
      }

      invParsedInfo.textContent = `${invParsedShipments.length} shipment(s) found, ${invSkippedRows.length} row(s) skipped (no ID in Memo)`;
      invParsedInfo.classList.add("visible");
    } catch (err) {
      invParsedInfo.textContent = "Error parsing file: " + err.message;
      invParsedInfo.classList.add("visible");
    }
  };
  reader.readAsArrayBuffer(file);
}

// --- Lookback date calculation ---

function updateInvDateDisplay() {
  if (!invNtpToday) {
    invDateInfo.textContent = "Fetching date...";
    return;
  }

  if (invLookbackDays === "custom") {
    if (invCustomFrom.value && invCustomTo.value) {
      const p1 = invCustomFrom.value.split("-");
      const p2 = invCustomTo.value.split("-");
      invFromDate = `${p1[1]}/${p1[2]}/${p1[0]}`;
      invToDate = `${p2[1]}/${p2[2]}/${p2[0]}`;
      invDateInfo.textContent = `Custom: ${invFromDate} — ${invToDate}`;
    } else {
      invFromDate = null;
      invToDate = null;
      invDateInfo.textContent = "Select from and to dates";
    }
    return;
  }

  const lbd = lastBizDay(invNtpToday);
  const from = new Date(invNtpToday);
  from.setDate(from.getDate() - invLookbackDays);
  invFromDate = fmtMmDdYyyy(from);
  invToDate = fmtMmDdYyyy(lbd);

  const src = invNtpSource === "local" ? " (local clock)" : "";
  const labels = { 180: "180 Days", 270: "270 Days", 365: "1 Year", 730: "2 Years" };
  invDateInfo.textContent = `${labels[invLookbackDays] || invLookbackDays + " Days"}: ${invFromDate} — ${invToDate}${src}`;
}

invLookbackFilters.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-days]");
  if (!btn) return;
  const val = btn.dataset.days;
  invLookbackDays = val === "custom" ? "custom" : parseInt(val, 10);
  for (const b of invLookbackFilters.querySelectorAll("button")) {
    b.classList.toggle("active", b === btn);
  }
  invCustomDateRow.classList.toggle("visible", val === "custom");
  updateInvDateDisplay();
});

invCustomFrom.addEventListener("change", updateInvDateDisplay);
invCustomTo.addEventListener("change", updateInvDateDisplay);

function fetchInvDate() {
  invDateInfo.textContent = "Fetching date...";
  chrome.runtime.sendMessage({ type: "fetchNtpDate" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      invDateInfo.textContent = "Could not fetch date. Please retry.";
      return;
    }
    const parts = res.today.split("/");
    invNtpToday = new Date(+parts[2], +parts[0] - 1, +parts[1]);
    invNtpSource = res.source;

    const todayIso = fmtIso(invNtpToday);
    invCustomTo.max = todayIso;
    invCustomFrom.max = todayIso;

    updateInvDateDisplay();
  });
}

// --- Running state ---

function setInvRunning(running) {
  invStartBtn.disabled = running;
  invStopBtn.disabled = !running;
  if (!running) {
    invProgressBar.classList.remove("visible");
    invProgressText.classList.remove("visible");
  }
}

// --- Start / Stop ---

invStartBtn.addEventListener("click", async () => {
  if (!invFromDate || !invToDate) {
    invStatus.textContent = "Date not loaded yet. Please wait...";
    if (!invNtpToday) fetchInvDate();
    return;
  }

  let shipments;
  if (invMode === "single") {
    const sid = invSingleId.value.trim();
    const amt = parseFloat(invSingleAmount.value);
    if (!sid) { invStatus.textContent = "Enter a Shipment ID."; return; }
    if (!Number.isFinite(amt)) { invStatus.textContent = "Enter a valid bill amount."; return; }
    shipments = [{ shipmentId: sid, billAmount: amt, vendor: "Manual", invoiceNumber: "Manual", memo: "" }];
    invSkippedRows = [];
  } else {
    if (invParsedShipments.length === 0) {
      invStatus.textContent = "Upload a Carrier Bill XLSX first.";
      return;
    }
    shipments = invParsedShipments;
  }

  setInvRunning(true);
  invProgressBar.classList.add("visible");
  invProgressText.classList.add("visible");
  invProgressFill.style.width = "0%";
  invProgressText.textContent = "";
  invStatus.textContent = "Starting Invoice Audit...";
  invDiscAlert.classList.remove("visible");
  invNoDisc.classList.remove("visible");
  invAiSummarySection?.classList.remove("visible");
  chrome.runtime.sendMessage({ type: "setRunning", running: true });

  const shipmentType = document.getElementById("invShipmentType").value;
  const customerFilter = document.getElementById("invCustomerFilter").value.trim();
  // The AI dropdown is hidden (analysis runs server-side); fall back to
  // 'summary' if the element was removed entirely.
  const aiAnalysis = document.getElementById("invAiAnalysis")?.value || "summary";
  const skipReport = document.getElementById("invSkipReport").checked;

  try {
    await sendToTab("invoiceAudit", {
      shipments,
      skippedRows: invSkippedRows,
      fromDate: invFromDate,
      toDate: invToDate,
      shipmentType,
      customerFilter,
      aiAnalysis,
      skipReport,
    });
  } catch (e) {
    invStatus.textContent = "Error: " + e.message;
    setInvRunning(false);
  }
});

invStopBtn.addEventListener("click", async () => {
  setInvRunning(false);
  invStatus.textContent = "Stopping...";
  chrome.runtime.sendMessage({ type: "setRunning", running: false });
  try {
    await sendToTab("stop");
  } catch (e) {
    invStatus.textContent = "Error: " + e.message;
  }
});

// --- Invoice Audit Prompt Editor ---

const INV_DEFAULT_PROMPTS = {
  system:
    "You are a freight brokerage accounting auditor. You compare carrier invoices (bills) against " +
    "FreightPOP's recorded shipment cost to identify billing discrepancies. Your audience is the " +
    "brokerage accounting/operations team. Be precise with dollar amounts and percentages.\n\n" +
    "Data sources:\n" +
    "  [CI] Carrier Invoice file — columns: Amount (→ Bill Amount), Memo (→ Shipment ID), Vendor, Invoice Number\n" +
    "  [FPX] FreightPOP Transaction Grid — columns: Shipment Rate without mark up (→ Cost), Shipment Marked-Up Rate (→ Sale), Shipment Gross Profit\n\n" +
    "Primary comparison: Bill Amount [CI] vs Shipment Cost [FPX]",
  execSummary:
    "You are reviewing an invoice audit for a freight brokerage. The JSON below contains:\n\n" +
    "• totalAudited — number of shipments checked\n" +
    "• totalMatched — shipments where carrier bill amount ≈ FPX Shipment Cost (within $0.01)\n" +
    "• totalDiscrepancies — shipments where carrier bill differs from FPX Shipment Cost\n" +
    "• totalErrors — shipments where Shipment Cost was not available in the FPX grid\n" +
    "• totalSkipped — rows from the uploaded file that had no extractable shipment ID in the Memo column\n" +
    "• totalVariance — net dollar variance across all discrepancies (positive = carrier overbilled vs FPX cost, negative = carrier underbilled)\n" +
    "• discrepancies[] — each: shipmentId, vendor, invoiceNumber, billAmount [CI], shipmentCost [FPX] (primary comparison target), shipmentSale [FPX] (what customer was charged), grossProfit [FPX] (sale - cost), difference (billAmount - shipmentCost), pctDifference (difference/shipmentCost × 100), direction (OVER = carrier billed more than FPX cost, UNDER = carrier billed less)\n" +
    "• matches[] — sample of shipments that matched (bill ≈ FPX cost within $0.01)\n\n" +
    "Write an executive summary in markdown with:\n" +
    "1. **Overall Assessment** — one-line verdict (Clean / Minor Issues / Significant), then total audited, matched, discrepancies, errors, net $ variance.\n" +
    "2. **Discrepancies** — list each with shipment ID, vendor, invoice #, Bill Amount [CI], Cost [FPX], difference, and likely cause (rate renegotiation, accessorial, data entry error, fuel surcharge adjustment, etc.).\n" +
    "3. **Vendor Patterns** — any vendor consistently over/under billing? Note if a vendor appears multiple times.\n" +
    "4. **Recommended Actions** — prioritized: which discrepancies to dispute first (largest $ impact), which to verify internally, which may be legitimate.\n\n" +
    "Rules:\n" +
    "- Reference actual shipment IDs and vendor names from the data.\n" +
    "- OVER means the carrier invoiced MORE than what FPX has on record as cost — investigate potential overbilling.\n" +
    "- UNDER means the carrier invoiced LESS than FPX cost — verify this is not a partial bill or credit pending.\n" +
    "- Keep to 200-400 words.\n\n" +
    "Data:\n{{data}}",
  rowReview:
    "You are reviewing a single carrier bill discrepancy.\n\n" +
    "The JSON contains: shipmentId, vendor, invoiceNumber, " +
    "billAmount [CI] (what carrier invoiced — from the uploaded carrier invoice file), " +
    "shipmentCost [FPX] (what FreightPOP recorded as the cost — from the FPX transaction grid, column 'Shipment Rate without mark up'), " +
    "shipmentSale [FPX] (what customer was charged — column 'Shipment Marked-Up Rate'), " +
    "grossProfit [FPX] (sale - cost), " +
    "difference (billAmount - shipmentCost), pctDifference, " +
    "direction (OVER = carrier billed more than FPX cost, UNDER = carrier billed less).\n\n" +
    "Provide a 2-3 sentence assessment of the most likely cause and what the accounting team should do.\n\n" +
    "Shipment:\n{{row}}",
};

const invSystemPromptEl = document.getElementById("invSystemPrompt");
const invExecSummaryPromptEl = document.getElementById("invExecSummaryPrompt");
const invRowReviewPromptEl = document.getElementById("invRowReviewPrompt");
const invSavePromptsBtn = document.getElementById("invSavePromptsBtn");
const invResetPromptsBtn = document.getElementById("invResetPromptsBtn");
const invSaveStatusEl = document.getElementById("invSaveStatus");
const invPromptToggle = document.getElementById("invPromptToggle");
const invPromptArrow = document.getElementById("invPromptArrow");
const invPromptEditor = document.getElementById("invPromptEditor");

// Invoice audit prompt editor — hidden, same pattern as GP.
invPromptToggle?.addEventListener("click", () => {
  if (!invPromptEditor) return;
  const isOpen = invPromptEditor.classList.toggle("visible");
  invPromptArrow?.classList.toggle("open", isOpen);
});

chrome.storage.local.get("invoicePrompts", (res) => {
  const p = res.invoicePrompts || {};
  if (invSystemPromptEl) invSystemPromptEl.value = p.system || INV_DEFAULT_PROMPTS.system;
  if (invExecSummaryPromptEl) invExecSummaryPromptEl.value = p.execSummary || INV_DEFAULT_PROMPTS.execSummary;
  if (invRowReviewPromptEl) invRowReviewPromptEl.value = p.rowReview || INV_DEFAULT_PROMPTS.rowReview;
});

invSavePromptsBtn?.addEventListener("click", () => {
  const invoicePrompts = {
    system: invSystemPromptEl?.value || "",
    execSummary: invExecSummaryPromptEl?.value || "",
    rowReview: invRowReviewPromptEl?.value || "",
  };
  chrome.storage.local.set({ invoicePrompts }, () => {
    if (invSaveStatusEl) {
      invSaveStatusEl.textContent = "Saved!";
      setTimeout(() => { invSaveStatusEl.textContent = ""; }, 2000);
    }
  });
});

invResetPromptsBtn?.addEventListener("click", () => {
  if (invSystemPromptEl) invSystemPromptEl.value = INV_DEFAULT_PROMPTS.system;
  if (invExecSummaryPromptEl) invExecSummaryPromptEl.value = INV_DEFAULT_PROMPTS.execSummary;
  if (invRowReviewPromptEl) invRowReviewPromptEl.value = INV_DEFAULT_PROMPTS.rowReview;
  chrome.storage.local.set({ invoicePrompts: { ...INV_DEFAULT_PROMPTS } }, () => {
    if (invSaveStatusEl) {
      invSaveStatusEl.textContent = "Reset to defaults!";
      setTimeout(() => { invSaveStatusEl.textContent = ""; }, 2000);
    }
  });
});

// --- Listen for messages ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    statusDiv.textContent = msg.text;
    const p = parseProgress(msg.text);
    if (p && p.total > 0) {
      const pct = Math.round((p.current / p.total) * 100);
      progressFill.style.width = pct + "%";
      progressText.textContent = `${p.current} / ${p.total}`;
      progressBar.classList.add("visible");
      progressText.classList.add("visible");
    }
  } else if (msg.type === "complete") {
    statusDiv.textContent = msg.text || "Done.";
    setRunning(false);
    progressFill.style.width = "100%";
    setTimeout(() => {
      progressBar.classList.remove("visible");
      progressText.classList.remove("visible");
    }, 3000);
  } else if (msg.type === "gpAuditStatus") {
    gpStatus.textContent = msg.text;
    const p = parseProgress(msg.text);
    if (p && p.total > 0) {
      const pct = Math.round((p.current / p.total) * 100);
      gpProgressFill.style.width = pct + "%";
      gpProgressText.textContent = `${p.current} / ${p.total}`;
      gpProgressBar.classList.add("visible");
      gpProgressText.classList.add("visible");
    }
  } else if (msg.type === "gpAuditComplete") {
    gpStatus.textContent = msg.text || "Done.";
    setGpRunning(false);
    gpProgressFill.style.width = "100%";
    setTimeout(() => {
      gpProgressBar.classList.remove("visible");
      gpProgressText.classList.remove("visible");
    }, 3000);
  } else if (msg.type === "gpAiSummary" && msg.text) {
    // Section is hidden (AI now runs server-side) but we keep the handler
    // so legacy / future re-enabled flows still update the text safely.
    if (gpAiSummaryText) gpAiSummaryText.textContent = msg.text;
    gpAiSummarySection?.classList.add("visible");
  } else if (msg.type === "gpAuditOutliers") {
    const outliers = msg.outliers || [];
    if (outliers.length === 0) {
      gpNoOutliers.classList.add("visible");
      gpOutlierAlert.classList.remove("visible");
    } else {
      gpNoOutliers.classList.remove("visible");
      gpOutlierList.innerHTML = "";
      for (const o of outliers.slice(0, 20)) {
        const div = document.createElement("div");
        div.className = "outlier-row";
        div.textContent = `${o.customerId} / ${o.customerName} — ShipID ${o.shipmentId}: GP ${o.gpPct}% (avg ${o.mean}%, dev ${o.deviation}%)`;
        gpOutlierList.appendChild(div);
      }
      if (outliers.length > 20) {
        const more = document.createElement("div");
        more.className = "outlier-row";
        more.textContent = `...and ${outliers.length - 20} more. See Excel for full list.`;
        gpOutlierList.appendChild(more);
      }
      gpOutlierAlert.classList.add("visible");
    }
  } else if (msg.type === "invoiceAuditStatus") {
    invStatus.textContent = msg.text;
    const p = parseProgress(msg.text);
    if (p && p.total > 0) {
      const pct = Math.round((p.current / p.total) * 100);
      invProgressFill.style.width = pct + "%";
      invProgressText.textContent = `${p.current} / ${p.total}`;
      invProgressBar.classList.add("visible");
      invProgressText.classList.add("visible");
    }
  } else if (msg.type === "invoiceAuditComplete") {
    invStatus.textContent = msg.text || "Done.";
    setInvRunning(false);
    invProgressFill.style.width = "100%";
    setTimeout(() => {
      invProgressBar.classList.remove("visible");
      invProgressText.classList.remove("visible");
    }, 3000);
  } else if (msg.type === "invoiceAiSummary" && msg.text) {
    if (invAiSummaryText) invAiSummaryText.textContent = msg.text;
    invAiSummarySection?.classList.add("visible");
  } else if (msg.type === "invoiceAuditDiscrepancies") {
    const discs = msg.discrepancies || [];
    if (discs.length === 0) {
      invNoDisc.classList.add("visible");
      invDiscAlert.classList.remove("visible");
    } else {
      invNoDisc.classList.remove("visible");
      invDiscList.innerHTML = "";
      for (const d of discs.slice(0, 20)) {
        const div = document.createElement("div");
        div.className = "disc-row";
        const sign = d.difference > 0 ? "+" : "";
        const costAmt = d.shipmentCost != null ? d.shipmentCost.toFixed(2) : "N/A";
        div.textContent = `Ship ${d.shipmentId} (${d.vendor}): Bill $${d.billAmount.toFixed(2)} vs FPX Cost $${costAmt} — ${sign}$${d.difference.toFixed(2)} (${d.direction})`;
        invDiscList.appendChild(div);
      }
      if (discs.length > 20) {
        const more = document.createElement("div");
        more.className = "disc-row";
        more.textContent = `...and ${discs.length - 20} more. See Excel for full list.`;
        invDiscList.appendChild(more);
      }
      invDiscAlert.classList.add("visible");
    }
  }
});
