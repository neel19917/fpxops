// Wires the simplified, FreightPOP-branded popup. Background-message API
// (checkApiKey / getApiKey / saveApiKey / checkServer) is unchanged from the
// previous popup so background.js needs no changes.

const $ = (id) => document.getElementById(id);

const els = {
  openBtn:        $("openBtn"),
  status:         $("status"),
  statusLabel:    $("statusLabel"),
  statusSub:      $("statusSub"),
  setup:          $("setup"),
  setupTitle:     $("setupTitle"),
  nameInput:      $("nameInput"),
  keyInput:       $("keyInput"),
  urlInput:       $("urlInput"),
  advToggle:      $("advToggle"),
  advBlock:       $("advBlock"),
  saveKeyBtn:     $("saveKeyBtn"),
  cancelSetupBtn: $("cancelSetupBtn"),
  settingsBtn:    $("settingsBtn"),
  keyMsg:         $("keyMsg"),
  serverState:    $("serverState"),
  serverLabel:    $("serverLabel"),
};

// Track configured-ness so the status pill, primary CTA, and setup form
// can re-render without round-tripping to the background again.
let isConfigured = false;
let savedName = "";

function setStatus(configured, name) {
  if (configured) {
    els.status.classList.remove("setup");
    els.status.classList.add("connected");
    els.statusLabel.textContent = name ? `Connected as ${name}` : "Connected";
    els.statusSub.textContent = "Your scrapes are stamped with your name.";
  } else {
    els.status.classList.remove("connected");
    els.status.classList.add("setup");
    els.statusLabel.textContent = "Setup needed";
    els.statusSub.textContent = "Add your name and API key to get started.";
  }
  els.openBtn.disabled = !configured;
}

function showSetup({ firstTime, prefill }) {
  els.setup.classList.add("visible");
  els.setupTitle.textContent = firstTime ? "First-time setup" : "Settings";
  els.keyMsg.textContent = "";
  els.keyMsg.className = "save-msg";
  if (prefill) {
    chrome.runtime.sendMessage({ type: "getApiKey" }, (res) => {
      if (chrome.runtime.lastError) return;
      els.nameInput.value = (res && res.name) || "";
      els.urlInput.value  = (res && res.url) || "";
      els.keyInput.value  = (res && res.key) || "";
    });
  } else {
    els.nameInput.value = "";
    els.urlInput.value = "";
    els.keyInput.value = "";
  }
  setTimeout(() => els.nameInput.focus(), 50);
}

function hideSetup() {
  els.setup.classList.remove("visible");
  els.advBlock.classList.remove("visible");
  els.keyInput.type = "password";
}

function refreshKeyState() {
  chrome.runtime.sendMessage({ type: "checkApiKey" }, (res) => {
    if (chrome.runtime.lastError) return;
    const configured = !!(res && res.configured);
    isConfigured = configured;
    // Pull the saved name for the status sub-line.
    chrome.runtime.sendMessage({ type: "getApiKey" }, (nameRes) => {
      if (chrome.runtime.lastError) return;
      savedName = (nameRes && nameRes.name) || "";
      setStatus(configured, savedName);
      // First-time users see setup unfolded immediately; configured users
      // get the setup hidden behind the Settings cog.
      if (!configured) showSetup({ firstTime: true, prefill: true });
      else hideSetup();
    });
  });
}

function refreshServerState() {
  chrome.runtime.sendMessage({ type: "checkServer" }, (res) => {
    if (chrome.runtime.lastError) return;
    const online = !!(res && res.online);
    els.serverState.classList.toggle("online", online);
    els.serverState.classList.toggle("offline", !online);
    els.serverLabel.textContent = online ? "Server online" : "Server offline";
  });
}

// ─── Wiring ───────────────────────────────────────────────────────────

els.status.addEventListener("click", () => {
  // Tapping the status pill jumps straight to setup.
  showSetup({ firstTime: !isConfigured, prefill: true });
});

els.settingsBtn.addEventListener("click", () => {
  if (els.setup.classList.contains("visible")) hideSetup();
  else showSetup({ firstTime: !isConfigured, prefill: true });
});

els.advToggle.addEventListener("click", () => {
  els.advBlock.classList.toggle("visible");
});

els.cancelSetupBtn.addEventListener("click", () => {
  hideSetup();
  els.keyMsg.textContent = "";
});

els.saveKeyBtn.addEventListener("click", () => {
  const key  = els.keyInput.value.trim();
  const url  = els.urlInput.value.trim();
  const name = els.nameInput.value.trim();
  els.keyMsg.textContent = "";
  els.keyMsg.className = "save-msg";

  // Require name + key — URL is optional (background.js falls back to config.js
  // or the production default).
  if (!name) {
    els.keyMsg.textContent = "Add your name so we can stamp your scrapes.";
    els.keyMsg.className = "save-msg err";
    els.nameInput.focus();
    return;
  }
  if (!key) {
    els.keyMsg.textContent = "Paste the API key your admin gave you.";
    els.keyMsg.className = "save-msg err";
    els.keyInput.focus();
    return;
  }

  chrome.runtime.sendMessage({ type: "saveApiKey", key, url, name }, (res) => {
    if (chrome.runtime.lastError) {
      els.keyMsg.textContent = chrome.runtime.lastError.message;
      els.keyMsg.className = "save-msg err";
      return;
    }
    if (res && res.ok) {
      els.keyMsg.textContent = "Saved. You're all set.";
      els.keyMsg.className = "save-msg ok";
      refreshKeyState();
      // Auto-close the setup form a moment after a successful save so the user
      // sees the green check, then the primary CTA.
      setTimeout(hideSetup, 700);
    } else {
      els.keyMsg.textContent = (res && res.error) || "Save failed.";
      els.keyMsg.className = "save-msg err";
    }
  });
});

els.openBtn.addEventListener("click", async () => {
  if (els.openBtn.disabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  window.close();
});

// Keyboard niceties: Enter inside the setup form saves; Escape closes it.
for (const inp of [els.nameInput, els.keyInput, els.urlInput]) {
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); els.saveKeyBtn.click(); }
    if (e.key === "Escape") { e.preventDefault(); hideSetup(); }
  });
}

refreshKeyState();
refreshServerState();
