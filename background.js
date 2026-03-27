let state = { running: false, status: "Ready. Set your filter, then click Start." };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "status") {
    state.status = msg.text;
    state.running = true;
  } else if (msg.type === "complete") {
    state.status = msg.text || "Done — all tracking numbers refreshed.";
    state.running = false;
  } else if (msg.type === "getState") {
    sendResponse(state);
    return;
  } else if (msg.type === "setRunning") {
    state.running = msg.running;
  }
});
