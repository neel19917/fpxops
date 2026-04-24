const openBtn = document.getElementById("openBtn");
const apiBadge = document.getElementById("apiBadge");
const serverBadge = document.getElementById("serverBadge");
const toggleKey = document.getElementById("toggleKey");
const keyPanel = document.getElementById("keyPanel");
const keyInput = document.getElementById("keyInput");
const urlInput = document.getElementById("urlInput");
const showHideBtn = document.getElementById("showHideBtn");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const clearKeyBtn = document.getElementById("clearKeyBtn");
const keySource = document.getElementById("keySource");
const keyMsg = document.getElementById("keyMsg");

function setBadge(configured) {
  if (configured) {
    apiBadge.textContent = "API Key OK";
    apiBadge.classList.remove("missing");
    apiBadge.classList.add("ok");
  } else {
    apiBadge.textContent = "No API Key";
    apiBadge.classList.remove("ok");
    apiBadge.classList.add("missing");
  }
}

function refreshKeyState() {
  chrome.runtime.sendMessage({ type: "checkApiKey" }, (res) => {
    if (chrome.runtime.lastError) return;
    setBadge(!!(res && res.configured));
    if (keySource) {
      const src = res && res.source;
      keySource.textContent =
        src === "storage" ? "Source: saved in extension"
        : src === "config.js" ? "Source: config.js (fallback)"
        : "Source: none — paste a key above";
    }
  });
}

function openKeyPanel(prefill) {
  keyPanel.classList.remove("hidden");
  toggleKey.textContent = "Hide";
  keyMsg.textContent = "";
  if (prefill) {
    chrome.runtime.sendMessage({ type: "getApiKey" }, (res) => {
      if (chrome.runtime.lastError) return;
      keyInput.value = (res && res.key) || "";
      if (urlInput) urlInput.value = (res && res.url) || "";
    });
  }
}

function closeKeyPanel() {
  keyPanel.classList.add("hidden");
  toggleKey.textContent = "Edit API Key";
  keyInput.type = "password";
  showHideBtn.textContent = "Show";
}

refreshKeyState();

chrome.runtime.sendMessage({ type: "checkServer" }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res && res.online) {
    serverBadge.className = "badge ok";
    serverBadge.innerHTML = '<span class="dot"></span> Online';
  } else {
    serverBadge.className = "badge missing";
    serverBadge.innerHTML = '<span class="dot"></span> Offline';
  }
});

apiBadge.addEventListener("click", () => {
  if (keyPanel.classList.contains("hidden")) openKeyPanel(true);
  else closeKeyPanel();
});

toggleKey.addEventListener("click", () => {
  if (keyPanel.classList.contains("hidden")) openKeyPanel(true);
  else closeKeyPanel();
});

showHideBtn.addEventListener("click", () => {
  if (keyInput.type === "password") {
    keyInput.type = "text";
    showHideBtn.textContent = "Hide";
  } else {
    keyInput.type = "password";
    showHideBtn.textContent = "Show";
  }
});

saveKeyBtn.addEventListener("click", () => {
  const key = keyInput.value.trim();
  const url = (urlInput && urlInput.value || "").trim();
  keyMsg.textContent = "";
  keyMsg.className = "msg";
  chrome.runtime.sendMessage({ type: "saveApiKey", key, url }, (res) => {
    if (chrome.runtime.lastError) {
      keyMsg.textContent = chrome.runtime.lastError.message;
      keyMsg.className = "msg err";
      return;
    }
    if (res && res.ok) {
      keyMsg.textContent = res.cleared ? "Cleared." : "Saved.";
      keyMsg.className = "msg ok";
      refreshKeyState();
    } else {
      keyMsg.textContent = (res && res.error) || "Save failed.";
      keyMsg.className = "msg err";
    }
  });
});

clearKeyBtn.addEventListener("click", () => {
  keyInput.value = "";
  chrome.runtime.sendMessage({ type: "saveApiKey", key: "" }, (res) => {
    if (chrome.runtime.lastError) return;
    keyMsg.textContent = "Cleared.";
    keyMsg.className = "msg ok";
    refreshKeyState();
  });
});

openBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  window.close();
});
