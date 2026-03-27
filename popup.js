const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");
const filterColSelect = document.getElementById("filterCol");
const filterValSelect = document.getElementById("filterVal");

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

startBtn.addEventListener("click", async () => {
  const filterCol = filterColSelect.value;
  const filterVal = filterValSelect.value;

  setRunning(true);
  statusDiv.textContent = "Starting...";
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    statusDiv.textContent = msg.text;
  } else if (msg.type === "complete") {
    statusDiv.textContent = msg.text || "Done — all tracking numbers refreshed.";
    setRunning(false);
  }
});
