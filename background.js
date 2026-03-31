importScripts("config.js");

const DEFAULT_PROMPTS = {
  system:
    "You are a freight brokerage logistics analyst reviewing a live shipment tracking record.",
  perShipment:
    'Analyze the shipment data below and answer three questions:\n1. Does this shipment require action right now?\n2. If yes, what is the problem?\n3. What should the broker do next to keep the customer informed or resolve the issue?\n\nRules:\n- Use plain English. No jargon the customer wouldn\'t understand.\n- If the shipment is on track, say so clearly.\n- If there is a delay, exception, or missed appointment, state it directly.\n- Base your answer ONLY on the data provided. Do not assume or invent information.\n\nRespond in this exact JSON format:\n{\n  "actionRequired": true or false,\n  "issue": "One sentence describing the problem, or \'None - shipment is on track\'",\n  "recommendation": "One to two sentences on what the broker should do or communicate to the customer"\n}\n\nShipment data:\n{{data}}',
  summary:
    "You are reviewing a summary of shipment records scraped from the FreightPOP dashboard.\n\nThe data includes aggregate counts and two lists: actionItems (shipments needing action) and sample (a sample of on-track shipments). Provide a brief executive summary for the brokerage team:\n- How many shipments need immediate action?\n- What are the most common issues?\n- Which shipments are top priority and why?\n- Any patterns the team should be aware of?\n\nUse plain English. Be direct and actionable.\n\nShipment summary:\n{{allShipments}}",
};

let state = {
  running: false,
  status: "Ready. Set your filter, then click Start.",
};

let keepaliveTimer = null;

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25000);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

const NATIVE_HOST = "com.fpxpress.server";
let nativePort = null;
let pendingNativeCallback = null;

function connectNativeHost() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener((msg) => {
      if (pendingNativeCallback) {
        const cb = pendingNativeCallback;
        pendingNativeCallback = null;
        cb(msg);
      }
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      if (pendingNativeCallback) {
        const cb = pendingNativeCallback;
        pendingNativeCallback = null;
        cb({ error: chrome.runtime.lastError?.message || "Native host disconnected" });
      }
    });
  } catch (e) {
    nativePort = null;
    return null;
  }
  return nativePort;
}

function sendNativeMessage(action) {
  return new Promise((resolve) => {
    const port = connectNativeHost();
    if (!port) {
      resolve({ error: "Native host not installed. Run install-native-host.command first." });
      return;
    }
    pendingNativeCallback = resolve;
    setTimeout(() => {
      if (pendingNativeCallback === resolve) {
        pendingNativeCallback = null;
        resolve({ error: "Native host timeout" });
      }
    }, 10000);
    port.postMessage({ action });
  });
}

async function getPrompts() {
  const stored = await chrome.storage.local.get("prompts");
  return stored.prompts || { ...DEFAULT_PROMPTS };
}

// Send full scraped modal + grid fields to Claude (no per-field truncation). Strip only
// internal FPX keys. Optional FPX_MAX_FIELD_CHARS in config.js caps extremely long values.
function slimShipmentData(data) {
  const out = {};
  const excludeKeys = new Set([
    "_aiRawAnalysis",
    "_inputSummary",
    "_outputSummary",
    "_needsActionSheet",
  ]);
  const maxField =
    typeof FPX_MAX_FIELD_CHARS === "number" &&
    FPX_MAX_FIELD_CHARS > 0 &&
    Number.isFinite(FPX_MAX_FIELD_CHARS)
      ? FPX_MAX_FIELD_CHARS
      : null;
  for (const [k, v] of Object.entries(data)) {
    if (excludeKeys.has(k)) continue;
    if (k.startsWith("_") && k !== "_trackingNumber") continue;
    if (v === undefined || v === null) continue;
    let s;
    if (typeof v === "string") {
      s = v;
    } else if (typeof v === "object") {
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
      }
    } else {
      s = String(v);
    }
    if (!s.trim()) continue;
    if (maxField != null && s.length > maxField) {
      s = s.slice(0, maxField) + "…";
    }
    out[k] = s;
  }
  return out;
}

function resolveClaudeRouting(systemPrompt, userMessage, opts) {
  const threshold =
    typeof FPX_LARGE_PROMPT_CHARS === "number" ? FPX_LARGE_PROMPT_CHARS : 12000;
  const inputChars = String(systemPrompt ?? "").length + String(userMessage ?? "").length;
  const useLarge = inputChars >= threshold;
  const modelDefault =
    typeof FPX_MODEL_DEFAULT === "string" && FPX_MODEL_DEFAULT
      ? FPX_MODEL_DEFAULT
      : "claude-haiku-4-5-20251001";
  const modelLarge =
    typeof FPX_MODEL_LARGE_PROMPT === "string" && FPX_MODEL_LARGE_PROMPT
      ? FPX_MODEL_LARGE_PROMPT
      : "claude-sonnet-4-5-20250929";
  const maxLarge =
    typeof FPX_MAX_TOKENS_LARGE === "number" && FPX_MAX_TOKENS_LARGE > 0
      ? FPX_MAX_TOKENS_LARGE
      : 4096;
  const requestedSmall = opts.maxTokens != null ? opts.maxTokens : 1024;
  return {
    model: useLarge ? modelLarge : modelDefault,
    maxTokens: useLarge ? maxLarge : requestedSmall,
    useLarge,
    inputChars,
  };
}

async function callClaude(systemPrompt, userMessage, opts) {
  if (
    !ANTHROPIC_API_KEY ||
    ANTHROPIC_API_KEY === "YOUR_API_KEY_HERE"
  ) {
    return { error: "API key not configured. Edit config.js with your Anthropic key." };
  }

  const options = typeof opts === "number" ? { maxTokens: opts } : (opts || {});
  const route = resolveClaudeRouting(systemPrompt, userMessage, options);
  console.log(
    "[FPX] Claude:",
    route.model,
    "max_tokens:",
    route.maxTokens,
    "prompt_chars:",
    route.inputChars,
    route.useLarge ? "(large prompt tier)" : ""
  );

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: route.model,
      max_tokens: route.maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error("[FPX] Anthropic API error:", resp.status, body);
    return { error: `API ${resp.status}: ${body.slice(0, 200)}` };
  }

  const json = await resp.json();
  const text =
    json.content && json.content[0] ? json.content[0].text : "";
  return { text };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "status") {
    state.status = msg.text;
    state.running = true;
    startKeepalive();
  } else if (msg.type === "complete") {
    state.status = msg.text || "Done.";
    state.running = false;
    stopKeepalive();
  } else if (msg.type === "getState") {
    sendResponse(state);
    return;
  } else if (msg.type === "setRunning") {
    state.running = msg.running;
    if (msg.running) startKeepalive();
    else stopKeepalive();
  } else if (msg.type === "getPrompts") {
    getPrompts().then((p) => sendResponse(p));
    return true;
  } else if (msg.type === "savePrompts") {
    chrome.storage.local.set({ prompts: msg.prompts }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "analyzeShipment") {
    (async () => {
      const prompts = await getPrompts();
      const slim = slimShipmentData(msg.data);
      const userMsg = prompts.perShipment.replace(
        "{{data}}",
        JSON.stringify(slim)
      );
      const result = await callClaude(prompts.system, userMsg, { maxTokens: 512 });
      sendResponse(result);
    })();
    return true;
  } else if (msg.type === "summarizeAll") {
    (async () => {
      const prompts = await getPrompts();
      const data = msg.payload || msg.rows;
      const userMsg = prompts.summary.replace(
        "{{allShipments}}",
        JSON.stringify(data)
      );
      const result = await callClaude(prompts.system, userMsg, { maxTokens: 2048 });
      sendResponse(result);
    })();
    return true;
  } else if (msg.type === "analyzeBatch") {
    (async () => {
      const payload = JSON.stringify({ shipments: msg.rows });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await fetch("http://localhost:3210/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          });
          if (!resp.ok) {
            const body = await resp.text();
            sendResponse({ error: `Server ${resp.status}: ${body.slice(0, 200)}` });
            return;
          }
          const result = await resp.json();
          sendResponse(result);
          return;
        } catch (e) {
          if (attempt === 0) {
            console.log("[FPX] analyzeBatch retry after network error:", e.message);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            sendResponse({ error: e.message });
          }
        }
      }
    })();
    return true;
  } else if (msg.type === "checkServer") {
    (async () => {
      try {
        const resp = await fetch("http://localhost:3210/health", {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const data = await resp.json();
          sendResponse({ online: true, version: data.version, uptime: data.uptime });
        } else {
          sendResponse({ online: false });
        }
      } catch {
        sendResponse({ online: false });
      }
    })();
    return true;
  } else if (msg.type === "checkApiKey") {
    const configured =
      typeof ANTHROPIC_API_KEY === "string" &&
      ANTHROPIC_API_KEY !== "YOUR_API_KEY_HERE" &&
      ANTHROPIC_API_KEY.length > 0;
    sendResponse({ configured });
    return;
  } else if (msg.type === "startServer") {
    sendNativeMessage("start").then(sendResponse);
    return true;
  } else if (msg.type === "stopServer") {
    sendNativeMessage("stop").then(sendResponse);
    return true;
  } else if (msg.type === "serverStatus") {
    sendNativeMessage("status").then(sendResponse);
    return true;
  }
});
