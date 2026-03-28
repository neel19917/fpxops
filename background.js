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

async function getPrompts() {
  const stored = await chrome.storage.local.get("prompts");
  return stored.prompts || { ...DEFAULT_PROMPTS };
}

const SHIPMENT_KEYS = [
  "_trackingNumber", "SHIPMENT STATUS", "CARRIER", "CARRIER NAME", "MODE",
  "COMMENTS", "PICKUP DATE", "UPDATED ETA", "ESTIMATED DEPARTURE DATE",
  "ACTUAL DEPARTURE DATE", "ESTIMATED ARRIVAL DATE", "ACTUAL ARRIVAL DATE",
  "DELIVERY DATE", "SIGNED BY",
];

function slimShipmentData(data) {
  const out = {};
  for (const k of SHIPMENT_KEYS) {
    const v = data[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

async function callClaude(systemPrompt, userMessage, maxTokens) {
  if (
    !ANTHROPIC_API_KEY ||
    ANTHROPIC_API_KEY === "YOUR_API_KEY_HERE"
  ) {
    return { error: "API key not configured. Edit config.js with your Anthropic key." };
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens || 1024,
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
  } else if (msg.type === "complete") {
    state.status = msg.text || "Done.";
    state.running = false;
  } else if (msg.type === "getState") {
    sendResponse(state);
    return;
  } else if (msg.type === "setRunning") {
    state.running = msg.running;
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
      const result = await callClaude(prompts.system, userMsg, 512);
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
      const result = await callClaude(prompts.system, userMsg);
      sendResponse(result);
    })();
    return true;
  } else if (msg.type === "checkApiKey") {
    const configured =
      typeof ANTHROPIC_API_KEY === "string" &&
      ANTHROPIC_API_KEY !== "YOUR_API_KEY_HERE" &&
      ANTHROPIC_API_KEY.length > 0;
    sendResponse({ configured });
    return;
  }
});
