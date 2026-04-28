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
  importFileBtn:  $("importFileBtn"),
  importFileInput:$("importFileInput"),
  msSignInBtn:    $("msSignInBtn"),
  msSignInLabel:  $("msSignInLabel"),
  msSignedInRow:  $("msSignedInRow"),
  msSignedInEmail:$("msSignedInEmail"),
  msSignOutLink:  $("msSignOutLink"),
};

// Parse a credentials file the admin downloaded from the dashboard. Handles
// both formats:
//   config.js      → `const FPX_API_URL = "..."` / `const FPX_API_KEY = "..."`
//   credentials.txt → `API URL: ...` / `API Key: ...`
// Returns { url, key } with whichever fields were found.
function parseCredentialsFile(text) {
  const out = { url: "", key: "" };
  const url1 = text.match(/FPX_API_URL\s*=\s*["']([^"']+)["']/);
  const key1 = text.match(/FPX_API_KEY\s*=\s*["']([^"']+)["']/);
  if (url1) out.url = url1[1].trim();
  if (key1) out.key = key1[1].trim();
  if (!out.url) {
    const url2 = text.match(/(?:^|\n)\s*API\s*URL\s*[:=]\s*(\S+)/i);
    if (url2) out.url = url2[1].trim();
  }
  if (!out.key) {
    const key2 = text.match(/(?:^|\n)\s*API\s*Key\s*[:=]\s*(\S+)/i);
    if (key2) out.key = key2[1].trim();
  }
  return out;
}

// Track configured-ness so the status pill, primary CTA, and setup form
// can re-render without round-tripping to the background again.
let isConfigured = false;
let savedName = "";
let signedInAs = null;
let signedInApproved = null;     // null when not signed in; true/false otherwise
let signedInFullName = null;

function setStatus(configured, name) {
  if (configured) {
    els.status.classList.remove("setup");
    els.status.classList.add("connected");
    if (signedInAs) {
      els.statusLabel.textContent = `Signed in as ${signedInFullName || signedInAs}`;
      els.statusSub.textContent = "Approved · ready to scrape.";
    } else {
      els.statusLabel.textContent = name ? `Connected as ${name}` : "Connected";
      els.statusSub.textContent = "Your scrapes are stamped with your name.";
    }
  } else if (signedInAs && signedInApproved === false) {
    // Signed in but admin hasn't enabled them yet — distinct visual state so
    // the rep knows what they're waiting on.
    els.status.classList.remove("connected");
    els.status.classList.add("setup");
    els.statusLabel.textContent = `Awaiting admin approval`;
    els.statusSub.textContent = `${signedInAs} is signed in. An admin needs to enable API access in the Users tab.`;
  } else {
    els.status.classList.remove("connected");
    els.status.classList.add("setup");
    els.statusLabel.textContent = "Setup needed";
    els.statusSub.textContent = "Sign in with Microsoft, or paste an API key to get started.";
  }
  els.openBtn.disabled = !configured;
}

function renderSignedIn(email, approved, fullName) {
  signedInAs = email || null;
  signedInApproved = email ? !!approved : null;
  signedInFullName = email ? (fullName || null) : null;
  if (email) {
    if (els.msSignedInEmail) els.msSignedInEmail.textContent = fullName ? `${fullName} (${email})` : email;
    if (els.msSignedInRow) els.msSignedInRow.style.display = "";
    if (els.msSignInLabel) els.msSignInLabel.textContent = "Re-authenticate";
    // Hide the API-key block when the rep is signed in — the Bearer JWT is
    // doing the work. They can still expose it via Advanced if needed.
    if (els.keyInput) {
      const apiKeyStep = els.keyInput.closest(".setup-step");
      if (apiKeyStep) apiKeyStep.style.display = "none";
    }
  } else {
    if (els.msSignedInRow) els.msSignedInRow.style.display = "none";
    if (els.msSignInLabel) els.msSignInLabel.textContent = "Sign in with Microsoft";
    if (els.keyInput) {
      const apiKeyStep = els.keyInput.closest(".setup-step");
      if (apiKeyStep) apiKeyStep.style.display = "";
    }
  }
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
    renderSignedIn(
      res && res.signedInAs,
      res && res.approved,
      res && res.fullName,
    );
    // Pull the saved name for the status sub-line.
    chrome.runtime.sendMessage({ type: "getApiKey" }, (nameRes) => {
      if (chrome.runtime.lastError) return;
      savedName = (nameRes && nameRes.name) || "";
      setStatus(configured, savedName);
      // First-time users see setup unfolded immediately; configured users
      // get the setup hidden behind the Settings cog. Pending-approval users
      // also see the setup so they understand the state.
      if (!configured) showSetup({ firstTime: !signedInAs, prefill: true });
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
  // API key is optional when the user is signed in with Microsoft — the Bearer
  // session is enough to authenticate API calls.
  if (!key && !signedInAs) {
    els.keyMsg.textContent = "Sign in with Microsoft above, or paste an API key.";
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

// "Sign in with Microsoft" — kicks off the Supabase OAuth flow in background.js
// via chrome.identity.launchWebAuthFlow. The popup window can stay open during
// the auth flow because the flow opens its own window.
els.msSignInBtn?.addEventListener("click", () => {
  els.keyMsg.textContent = "Opening Microsoft sign-in…";
  els.keyMsg.className = "save-msg";
  els.msSignInBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "signInWithMicrosoft" }, (res) => {
    els.msSignInBtn.disabled = false;
    if (chrome.runtime.lastError) {
      els.keyMsg.textContent = chrome.runtime.lastError.message;
      els.keyMsg.className = "save-msg err";
      return;
    }
    if (res && res.ok) {
      els.keyMsg.textContent = `Signed in as ${res.email || "Microsoft account"}.`;
      els.keyMsg.className = "save-msg ok";
      refreshKeyState();
      refreshServerState();
    } else {
      els.keyMsg.textContent = (res && res.error) || "Sign-in failed.";
      els.keyMsg.className = "save-msg err";
    }
  });
});

els.msSignOutLink?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: "signOutSupabase" }, () => {
    els.keyMsg.textContent = "Signed out.";
    els.keyMsg.className = "save-msg";
    refreshKeyState();
  });
});

// "Import config file" — open the picker, parse the file, fill the inputs.
els.importFileBtn.addEventListener("click", () => els.importFileInput.click());
els.importFileInput.addEventListener("change", () => {
  const file = els.importFileInput.files && els.importFileInput.files[0];
  if (!file) return;
  if (file.size > 64 * 1024) {
    els.keyMsg.textContent = "That file is too big to be a credentials file.";
    els.keyMsg.className = "save-msg err";
    els.importFileInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const { url, key } = parseCredentialsFile(String(reader.result || ""));
    if (!key) {
      els.keyMsg.textContent = "Couldn't find an API key in that file.";
      els.keyMsg.className = "save-msg err";
      els.importFileInput.value = "";
      return;
    }
    if (url) els.urlInput.value = url;
    els.keyInput.value = key;
    // Reveal the advanced block when the file pre-fills a custom URL so the
    // user can see what was imported before saving.
    if (url) els.advBlock.classList.add("visible");
    els.keyMsg.textContent = `Imported from ${file.name}. Review and click Save.`;
    els.keyMsg.className = "save-msg ok";
    els.importFileInput.value = "";
    if (!els.nameInput.value.trim()) els.nameInput.focus();
  };
  reader.onerror = () => {
    els.keyMsg.textContent = "Couldn't read that file.";
    els.keyMsg.className = "save-msg err";
    els.importFileInput.value = "";
  };
  reader.readAsText(file);
});

refreshKeyState();
refreshServerState();
