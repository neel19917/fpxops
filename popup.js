const openBtn = document.getElementById("openBtn");
const apiBadge = document.getElementById("apiBadge");
const serverBadge = document.getElementById("serverBadge");

chrome.runtime.sendMessage({ type: "checkApiKey" }, (res) => {
  if (res && res.configured) {
    apiBadge.textContent = "API Key OK";
    apiBadge.classList.remove("missing");
    apiBadge.classList.add("ok");
  }
});

chrome.runtime.sendMessage({ type: "checkServer" }, (res) => {
  if (res && res.online) {
    serverBadge.className = "badge ok";
    serverBadge.innerHTML = '<span class="dot"></span> Online';
  } else {
    serverBadge.className = "badge missing";
    serverBadge.innerHTML = '<span class="dot"></span> Offline';
  }
});

openBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  window.close();
});
