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
const aiSummarySection = document.getElementById("aiSummarySection");
const aiSummaryText = document.getElementById("aiSummaryText");

const VALUE_OPTIONS = {
  Mode: ["LTL", "Parcel", "Truckload", "Air", "Ocean", "Auto", "Other"],
  "Shipment status": [
    "Booked",
    "Scheduled/Tendered",
    "In Transit",
    "Out for Delivery",
    "Delivered",
    "Issue",
    "PickupUnverified",
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

// --- Listen for status, complete, and AI summary ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    statusDiv.textContent = msg.text;
  } else if (msg.type === "complete") {
    statusDiv.textContent = msg.text || "Done.";
    setRunning(false);
  } else if (msg.type === "aiSummary" && msg.text) {
    aiSummaryText.textContent = msg.text;
    aiSummarySection.classList.add("visible");
  }
});
