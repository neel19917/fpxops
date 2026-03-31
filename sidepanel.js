const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");
const filterColSelect = document.getElementById("filterCol");
const filterValSelect = document.getElementById("filterVal");
const aiToggle = document.getElementById("aiToggle");
const smartGateToggle = document.getElementById("smartGateToggle");
const promptToggle = document.getElementById("promptToggle");
const promptArrow = document.getElementById("promptArrow");
const promptEditor = document.getElementById("promptEditor");
const systemPromptEl = document.getElementById("systemPrompt");
const perShipmentPromptEl = document.getElementById("perShipmentPrompt");
const summaryPromptEl = document.getElementById("summaryPrompt");
const savePromptsBtn = document.getElementById("savePromptsBtn");
const resetPromptsBtn = document.getElementById("resetPromptsBtn");
const saveStatusEl = document.getElementById("saveStatus");
const apiBadge = document.getElementById("apiBadge");
const serverBadge = document.getElementById("serverBadge");
const serverHint = document.getElementById("serverHint");
const serverToggleBtn = document.getElementById("serverToggleBtn");
const serverInfo = document.getElementById("serverInfo");
const aiSummarySection = document.getElementById("aiSummarySection");
const aiSummaryText = document.getElementById("aiSummaryText");
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

const DEFAULT_PROMPTS = {
  system:
    "You are a freight brokerage logistics analyst reviewing a live shipment tracking record.",
  perShipment:
    'Analyze the shipment data below and answer three questions:\n1. Does this shipment require action right now?\n2. If yes, what is the problem?\n3. What should the broker do next to keep the customer informed or resolve the issue?\n\nRules:\n- Use plain English. No jargon the customer wouldn\'t understand.\n- If the shipment is on track, say so clearly.\n- If there is a delay, exception, or missed appointment, state it directly.\n- Base your answer ONLY on the data provided. Do not assume or invent information.\n\nRespond in this exact JSON format:\n{\n  "actionRequired": true or false,\n  "issue": "One sentence describing the problem, or \'None - shipment is on track\'",\n  "recommendation": "One to two sentences on what the broker should do or communicate to the customer"\n}\n\nShipment data:\n{{data}}',
  summary:
    "You are reviewing a summary of shipment records scraped from the FreightPOP dashboard.\n\nThe data includes aggregate counts and two lists: actionItems (shipments needing action) and sample (a sample of on-track shipments). Provide a brief executive summary for the brokerage team:\n- How many shipments need immediate action?\n- What are the most common issues?\n- Which shipments are top priority and why?\n- Any patterns the team should be aware of?\n\nUse plain English. Be direct and actionable.\n\nShipment summary:\n{{allShipments}}",
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

chrome.runtime.sendMessage({ type: "checkApiKey" }, (res) => {
  if (res && res.configured) {
    apiBadge.textContent = "API Key OK";
    apiBadge.classList.remove("missing");
    apiBadge.classList.add("ok");
  } else {
    apiBadge.textContent = "No API Key";
    apiBadge.classList.remove("ok");
    apiBadge.classList.add("missing");
  }
});

// --- Server status check with polling ---

let serverOnline = false;
let nativeHostAvailable = true;

function updateServerStatus(online, version, uptime) {
  serverOnline = online;
  if (online) {
    const uptimeStr = uptime != null ? ` (up ${formatUptime(uptime)})` : "";
    serverBadge.className = "server-badge online";
    serverBadge.innerHTML = `<span class="dot"></span> Server v${version || "?"}`;
    serverInfo.textContent = uptimeStr;
    serverToggleBtn.textContent = "Stop";
    serverToggleBtn.className = "stop";
    serverToggleBtn.disabled = false;
    serverHint.classList.remove("visible");
  } else {
    serverBadge.className = "server-badge offline";
    serverBadge.innerHTML = '<span class="dot"></span> Offline';
    serverInfo.textContent = "";
    serverToggleBtn.textContent = "Start";
    serverToggleBtn.className = "start";
    serverToggleBtn.disabled = false;
  }
}

function formatUptime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function checkServer() {
  chrome.runtime.sendMessage({ type: "checkServer" }, (res) => {
    if (chrome.runtime.lastError) return;
    updateServerStatus(res && res.online, res && res.version, res && res.uptime);
  });
}

checkServer();
setInterval(checkServer, 15000);

serverToggleBtn.addEventListener("click", () => {
  serverToggleBtn.disabled = true;
  if (serverOnline) {
    serverToggleBtn.textContent = "Stopping...";
    chrome.runtime.sendMessage({ type: "stopServer" }, (res) => {
      if (chrome.runtime.lastError || (res && res.error)) {
        serverHint.textContent = res?.error || chrome.runtime.lastError?.message || "Could not stop server.";
        serverHint.classList.add("visible");
        serverToggleBtn.disabled = false;
        return;
      }
      setTimeout(checkServer, 1500);
    });
  } else {
    serverToggleBtn.textContent = "Starting...";
    chrome.runtime.sendMessage({ type: "startServer" }, (res) => {
      if (chrome.runtime.lastError || (res && res.error)) {
        const errMsg = res?.error || chrome.runtime.lastError?.message || "";
        if (/not installed|not found|native/i.test(errMsg)) {
          nativeHostAvailable = false;
          serverHint.textContent = "Run install-native-host.command first, or start manually with start-server.command";
        } else {
          serverHint.textContent = errMsg;
        }
        serverHint.classList.add("visible");
        serverToggleBtn.disabled = false;
        serverToggleBtn.textContent = "Start";
        return;
      }
      setTimeout(checkServer, 2500);
    });
  }
});

// --- AI toggle persistence ---

chrome.storage.local.get("aiEnabled", (res) => {
  aiToggle.checked = res.aiEnabled !== false;
});
aiToggle.addEventListener("change", () => {
  chrome.storage.local.set({ aiEnabled: aiToggle.checked });
});

chrome.storage.local.get("smartGateEnabled", (res) => {
  smartGateToggle.checked = res.smartGateEnabled === true;
});
smartGateToggle.addEventListener("change", () => {
  chrome.storage.local.set({ smartGateEnabled: smartGateToggle.checked });
});

// --- Content script injection ---

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["xlsx.full.min.js"],
    });
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
  const aiEnabled = aiToggle.checked;
  const smartGate = smartGateToggle.checked;

  setRunning(true);
  progressBar.classList.add("visible");
  progressText.classList.add("visible");
  progressFill.style.width = "0%";
  progressText.textContent = "";
  statusDiv.textContent = aiEnabled ? "Starting with AI analysis..." : "Starting (scrape only)...";
  aiSummarySection.classList.remove("visible");
  chrome.runtime.sendMessage({ type: "setRunning", running: true });

  try {
    await sendToTab("start", { filterCol, filterVal, aiEnabled, smartGate });
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

// --- Prompt editor toggle ---

promptToggle.addEventListener("click", () => {
  const isOpen = promptEditor.classList.toggle("visible");
  promptArrow.classList.toggle("open", isOpen);
});

// --- Load prompts ---

chrome.runtime.sendMessage({ type: "getPrompts" }, (prompts) => {
  if (prompts) {
    systemPromptEl.value = prompts.system || DEFAULT_PROMPTS.system;
    perShipmentPromptEl.value = prompts.perShipment || DEFAULT_PROMPTS.perShipment;
    summaryPromptEl.value = prompts.summary || DEFAULT_PROMPTS.summary;
  }
});

// --- Save prompts ---

savePromptsBtn.addEventListener("click", () => {
  const prompts = {
    system: systemPromptEl.value,
    perShipment: perShipmentPromptEl.value,
    summary: summaryPromptEl.value,
  };
  chrome.runtime.sendMessage({ type: "savePrompts", prompts }, () => {
    saveStatusEl.textContent = "Saved!";
    setTimeout(() => { saveStatusEl.textContent = ""; }, 2000);
  });
});

// --- Reset prompts ---

resetPromptsBtn.addEventListener("click", () => {
  systemPromptEl.value = DEFAULT_PROMPTS.system;
  perShipmentPromptEl.value = DEFAULT_PROMPTS.perShipment;
  summaryPromptEl.value = DEFAULT_PROMPTS.summary;
  const prompts = { ...DEFAULT_PROMPTS };
  chrome.runtime.sendMessage({ type: "savePrompts", prompts }, () => {
    saveStatusEl.textContent = "Reset to defaults!";
    setTimeout(() => { saveStatusEl.textContent = ""; }, 2000);
  });
});

// --- Listen for status, complete, progress, and AI summary ---

function parseProgress(text) {
  const m = text.match(/(\d+)\s+of\s+(\d+)/i);
  if (m) return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  const m2 = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (m2) return { current: parseInt(m2[1], 10), total: parseInt(m2[2], 10) };
  return null;
}

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
  } else if (msg.type === "aiSummary" && msg.text) {
    aiSummaryText.textContent = msg.text;
    aiSummarySection.classList.add("visible");
  }
});
