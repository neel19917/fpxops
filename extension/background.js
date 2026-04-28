// Optional baked-in defaults. Most users set API URL + key from the popup
// (saved in chrome.storage.local), which always wins. Drop a config.js next
// to background.js if you want a pre-configured zip; otherwise this is a
// no-op and the popup is the source of truth.
try {
  importScripts("config.js");
} catch {
  self.FPX_API_URL = "";
  self.FPX_API_KEY = "";
}

// ---------- API key & URL resolution ----------
// User-set key in chrome.storage.local takes precedence over config.js.
async function getApiKey() {
  try {
    const { fpxApiKey } = await chrome.storage.local.get("fpxApiKey");
    if (typeof fpxApiKey === "string" && fpxApiKey.length > 0) return fpxApiKey;
  } catch {}
  return typeof FPX_API_KEY === "string" ? FPX_API_KEY : "";
}

// ---------- Supabase session (Microsoft sign-in) ----------
// Stored shape: { access_token, refresh_token, expires_at, email, provider }
// expires_at is a unix timestamp in seconds. Refresh handling is deferred —
// once expired the popup re-prompts. Bearer auth always wins over x-api-key
// in callApi, so adding a session implicitly upgrades the extension.
const SUPABASE_URL = "https://vvplkjgymahavqrejmgm.supabase.co";

async function getSupabaseSession() {
  try {
    const { fpxSupabaseSession } = await chrome.storage.local.get("fpxSupabaseSession");
    if (fpxSupabaseSession && typeof fpxSupabaseSession.access_token === "string") {
      return fpxSupabaseSession;
    }
  } catch {}
  return null;
}

async function saveSupabaseSession(session) {
  await chrome.storage.local.set({ fpxSupabaseSession: session });
}

async function clearSupabaseSession() {
  await chrome.storage.local.remove("fpxSupabaseSession");
}

// True when the session expiry is in the future. We don't refresh proactively;
// the user re-prompts via the popup if the token has lapsed.
function isSessionLive(session) {
  if (!session || !session.access_token) return false;
  if (typeof session.expires_at === "number" && session.expires_at * 1000 <= Date.now()) return false;
  return true;
}

// Decode a JWT payload safely (no signature check — just for the email claim).
function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const padded = part + "=".repeat((4 - part.length % 4) % 4);
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch { return null; }
}

async function signInWithMicrosoft() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl =
    `${SUPABASE_URL}/auth/v1/authorize` +
    `?provider=azure&redirect_to=${encodeURIComponent(redirectUrl)}`;
  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Sign-in cancelled" });
        return;
      }
      // Supabase OAuth implicit flow returns tokens in the URL hash:
      //   <redirect>#access_token=...&refresh_token=...&expires_in=...&token_type=bearer
      const hashIdx = responseUrl.indexOf("#");
      if (hashIdx === -1) {
        resolve({ ok: false, error: "No token in OAuth response" });
        return;
      }
      const params = new URLSearchParams(responseUrl.slice(hashIdx + 1));
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token") || null;
      const expires_in = Number(params.get("expires_in") || 3600);
      if (!access_token) {
        const err = params.get("error_description") || params.get("error") || "Missing access_token";
        resolve({ ok: false, error: err });
        return;
      }
      const claims = decodeJwtPayload(access_token) || {};
      const session = {
        access_token,
        refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + expires_in,
        email: claims.email || null,
        provider: "azure",
      };
      await saveSupabaseSession(session);
      // Auto-stamp the user's name from their profile so the rep doesn't have
      // to type it. Surfaces approval state too — the popup uses it to render
      // "Awaiting admin approval" when the user isn't enabled yet.
      const profile = await fetchProfileWithSession(session);
      if (profile?.fullName || profile?.email) {
        const name = profile.fullName || profile.email.split("@")[0];
        await chrome.storage.local.set({ fpxUserName: name });
      }
      resolve({
        ok: true,
        email: session.email,
        approved: !!profile?.enabled,
        role: profile?.role || null,
        fullName: profile?.fullName || null,
      });
    });
  });
}

// Fetch /api/me using a specific session (used right after sign-in, before
// the session is fully saved) and again on demand to surface approval state
// in the popup without requiring a re-sign-in.
async function fetchProfileWithSession(session) {
  if (!session?.access_token) return null;
  const apiUrl = await getApiUrl();
  if (!apiUrl) return null;
  try {
    const resp = await fetch(`${apiUrl}/api/me`, {
      headers: { "Authorization": `Bearer ${session.access_token}` },
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    return body?.user || null;
  } catch { return null; }
}

async function fetchOwnProfile() {
  const session = await getSupabaseSession();
  if (!isSessionLive(session)) return null;
  return fetchProfileWithSession(session);
}

async function getApiUrl() {
  try {
    const { fpxApiUrl } = await chrome.storage.local.get("fpxApiUrl");
    if (typeof fpxApiUrl === "string" && fpxApiUrl.length > 0) return fpxApiUrl.replace(/\/$/, "");
  } catch {}
  return (typeof FPX_API_URL === "string" ? FPX_API_URL : "").replace(/\/$/, "");
}

// Runner name — stamped on shipments + tasks so dashboards can attribute
// scrapes and auto-assign tasks. Plain string, set via popup.
async function getUserName() {
  try {
    const { fpxUserName } = await chrome.storage.local.get("fpxUserName");
    if (typeof fpxUserName === "string" && fpxUserName.length > 0) return fpxUserName;
  } catch {}
  return "";
}

function isValidKey(k) {
  return typeof k === "string" && k.length > 10 && k !== "YOUR_FPX_API_KEY_HERE";
}

async function getKeySource() {
  try {
    const { fpxApiKey } = await chrome.storage.local.get("fpxApiKey");
    if (typeof fpxApiKey === "string" && fpxApiKey.length > 0) return "storage";
  } catch {}
  if (isValidKey(FPX_API_KEY)) return "config.js";
  return "none";
}

// ---------- State ----------
let state = {
  running: false,
  status: "Ready. Set your filter, then click Start.",
};

let sessionCost = { inputTokens: 0, outputTokens: 0, totalUsd: 0, calls: 0 };
let keepaliveTimer = null;

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25000);
}
function stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

// ---------- Native host (local server control) ----------
// Only used when the API URL is localhost — the extension can launch/stop the
// node server via a native messaging host installed by install-native-host.command.
const NATIVE_HOST = "com.fpxpress.server";

function sendNativeMessage(action) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action }, (response) => {
        if (chrome.runtime.lastError) {
          done({ ok: false, error: chrome.runtime.lastError.message || "Native host unavailable" });
          return;
        }
        done(response || { ok: false, error: "Empty native response" });
      });
    } catch (e) {
      done({ ok: false, error: e && e.message || String(e) });
    }
    setTimeout(() => done({ ok: false, error: "Native host timeout" }), 8000);
  });
}

// ---------- Prompts (still stored locally so users can tweak) ----------
const DEFAULT_PROMPTS = {
  system:
    "You are a freight brokerage logistics analyst reviewing a live shipment tracking record.",
  perShipment:
    'Analyze the shipment data below and answer three questions:\n1. Does this shipment require action right now?\n2. If yes, what is the problem?\n3. What should the broker do next to keep the customer informed or resolve the issue?\n\nRules:\n- Use plain English. No jargon the customer wouldn\'t understand.\n- If the shipment is on track, say so clearly.\n- If there is a delay, exception, or missed appointment, state it directly.\n- Base your answer ONLY on the data provided. Do not assume or invent information.\n\nRespond in this exact JSON format:\n{\n  "actionRequired": true or false,\n  "issue": "One sentence describing the problem, or \'None - shipment is on track\'",\n  "recommendation": "One to two sentences on what the broker should do or communicate to the customer"\n}\n\nShipment data:\n{{data}}',
  summary:
    "You are reviewing a summary of shipment records scraped from the FreightPOP dashboard.\n\nThe data includes aggregate counts and two lists: actionItems (shipments needing action) and sample (a sample of on-track shipments). Provide a brief executive summary for the brokerage team:\n- How many shipments need immediate action?\n- What are the most common issues?\n- Which shipments are top priority and why?\n- Any patterns the team should be aware of?\n\nUse plain English. Be direct and actionable.\n\nShipment summary:\n{{allShipments}}",
};

async function getPrompts() {
  const stored = await chrome.storage.local.get("prompts");
  return stored.prompts || { ...DEFAULT_PROMPTS };
}

// ---------- Railway API helper ----------
async function callApi(path, body, options = {}) {
  const [apiUrl, apiKey, userName, session] = await Promise.all([
    getApiUrl(), getApiKey(), getUserName(), getSupabaseSession(),
  ]);
  if (!apiUrl) return { error: "FPX_API_URL not configured. Open the popup and set it." };
  const haveBearer = isSessionLive(session);
  if (!haveBearer && !isValidKey(apiKey)) {
    return { error: "Sign in or paste an API key from the popup." };
  }

  const headers = { "Content-Type": "application/json" };
  if (haveBearer) headers["Authorization"] = `Bearer ${session.access_token}`;
  else headers["x-api-key"] = apiKey;
  if (userName) headers["x-fpx-user-name"] = userName;

  try {
    const resp = await fetch(`${apiUrl}${path}`, {
      method: options.method || "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { error: `API ${resp.status}: ${text.slice(0, 200)}` };
    }
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
}

function accumulateCost(result) {
  if (!result || result.error) return;
  const inTok = result.input_tokens || 0;
  const outTok = result.output_tokens || 0;
  const cost = Number(result.cost_usd) || 0;
  if (inTok || outTok || cost) {
    sessionCost.inputTokens += inTok;
    sessionCost.outputTokens += outTok;
    sessionCost.totalUsd += cost;
    sessionCost.calls++;
  }
}

// ---------- Message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "status" || msg.type === "gpAuditStatus" || msg.type === "invoiceAuditStatus") {
    state.status = msg.text;
    state.running = true;
    startKeepalive();
  } else if (msg.type === "complete" || msg.type === "gpAuditComplete" || msg.type === "invoiceAuditComplete") {
    state.status = msg.text || "Done.";
    state.running = false;
    stopKeepalive();
  } else if (msg.type === "getState") {
    sendResponse(state); return;
  } else if (msg.type === "setRunning") {
    state.running = msg.running;
    if (msg.running) startKeepalive(); else stopKeepalive();
  } else if (msg.type === "getPrompts") {
    getPrompts().then((p) => sendResponse(p));
    return true;
  } else if (msg.type === "savePrompts") {
    chrome.storage.local.set({ prompts: msg.prompts }).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "analyzeShipment") {
    (async () => {
      const prompts = await getPrompts();
      const result = await callApi("/api/analyze/shipment", {
        shipment: msg.data,
        system: prompts.system,
        template: prompts.perShipment,
      });
      accumulateCost(result);
      sendResponse(result.error ? { error: result.error } : { text: result.text });
    })();
    return true;
  } else if (msg.type === "summarizeAll") {
    (async () => {
      const prompts = await getPrompts();
      const result = await callApi("/api/analyze/summary", {
        payload: msg.payload || msg.rows,
        system: prompts.system,
        template: prompts.summary,
      });
      accumulateCost(result);
      sendResponse(result.error ? { error: result.error } : { text: result.text });
    })();
    return true;
  } else if (msg.type === "upsertShipment") {
    (async () => {
      const result = await callApi("/api/shipments", { shipment: msg.data });
      sendResponse(result.error ? { ok: false, error: result.error } : { ok: true, id: result.shipment?.id });
    })();
    return true;
  } else if (msg.type === "upsertShipmentsBulk") {
    (async () => {
      const result = await callApi("/api/shipments", { shipments: msg.rows });
      sendResponse(result.error ? { ok: false, error: result.error } : { ok: true, count: result.count });
    })();
    return true;
  } else if (msg.type === "analyzeBatch") {
    (async () => {
      // Uses the LangGraph /analyze endpoint on the server.
      const payload = { shipments: msg.rows };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await callApi("/analyze", payload);
        if (!result.error) { sendResponse(result); return; }
        if (attempt === 0) {
          console.log("[FPX] analyzeBatch retry after error:", result.error);
          await new Promise((r) => setTimeout(r, 2000));
        } else sendResponse({ error: result.error });
      }
    })();
    return true;
  } else if (msg.type === "checkServer") {
    (async () => {
      try {
        const apiUrl = await getApiUrl();
        if (!apiUrl) { sendResponse({ online: false, reason: "no_url" }); return; }
        const resp = await fetch(`${apiUrl}/health`, { method: "GET", signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.json();
          sendResponse({ online: true, version: data.version, uptime: data.uptime, db: data.db });
        } else sendResponse({ online: false });
      } catch { sendResponse({ online: false }); }
    })();
    return true;
  } else if (msg.type === "checkApiKey") {
    (async () => {
      const k = await getApiKey();
      const session = await getSupabaseSession();
      const sessionLive = isSessionLive(session);
      // When signed in via Microsoft, ping /api/me so the popup knows whether
      // the admin has enabled this user yet (= API access approved). Skip the
      // ping if no session — we don't need it for the API-key path.
      let approved = null;
      let signedInAs = null;
      let fullName = null;
      if (sessionLive) {
        signedInAs = session.email || null;
        const profile = await fetchProfileWithSession(session);
        approved = profile?.enabled ?? false;
        fullName = profile?.fullName || null;
      }
      // "Configured" = the user has an auth path AND, if signed in, the
      // admin has approved them. API-key path doesn't need a separate
      // approval — the key being non-revoked IS the approval.
      const configured = sessionLive ? !!approved : isValidKey(k);
      sendResponse({
        configured,
        source: sessionLive ? "supabase" : await getKeySource(),
        signedInAs,
        approved,
        fullName,
      });
    })();
    return true;
  } else if (msg.type === "getApiKey") {
    (async () => {
      const { fpxApiKey, fpxApiUrl, fpxUserName } = await chrome.storage.local.get(["fpxApiKey", "fpxApiUrl", "fpxUserName"]);
      const session = await getSupabaseSession();
      const sessionLive = isSessionLive(session);
      sendResponse({
        key: fpxApiKey || "",
        url: fpxApiUrl || "",
        name: fpxUserName || "",
        source: sessionLive ? "supabase" : await getKeySource(),
        signedInAs: sessionLive ? (session.email || null) : null,
      });
    })();
    return true;
  } else if (msg.type === "saveApiKey") {
    (async () => {
      const k = (msg.key || "").trim();
      const url = (msg.url || "").trim();
      const name = (msg.name || "").trim();
      const updates = {};
      if (k) updates.fpxApiKey = k; else await chrome.storage.local.remove("fpxApiKey");
      if (url) updates.fpxApiUrl = url;
      if (name) updates.fpxUserName = name;
      if (Object.keys(updates).length) await chrome.storage.local.set(updates);
      sendResponse({ ok: true, cleared: !k });
    })();
    return true;
  } else if (msg.type === "signInWithMicrosoft") {
    (async () => {
      const result = await signInWithMicrosoft();
      sendResponse(result);
    })();
    return true;
  } else if (msg.type === "signOutSupabase") {
    (async () => {
      await clearSupabaseSession();
      sendResponse({ ok: true });
    })();
    return true;
  } else if (msg.type === "fetchNtpDate") {
    (async () => {
      function fmtDate(d) {
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${mm}/${dd}/${d.getFullYear()}`;
      }
      function calcLastBizDay(today) {
        const day = today.getDay();
        const offset = day === 0 ? 2 : day === 1 ? 3 : day === 6 ? 1 : 1;
        const bizDate = new Date(today);
        bizDate.setDate(bizDate.getDate() - offset);
        return { date: fmtDate(bizDate), iso: bizDate.toISOString().slice(0, 10) };
      }
      let today; let source = "ntp";
      try {
        const resp = await fetch("https://worldtimeapi.org/api/timezone/America/New_York", { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        today = new Date(data.datetime);
      } catch { today = new Date(); source = "local"; }
      const result = calcLastBizDay(today);
      result.source = source; result.today = fmtDate(today); result.todayIso = today.toISOString().slice(0, 10);
      sendResponse(result);
    })();
    return true;
  } else if (msg.type === "uploadGpAudit") {
    (async () => {
      const result = await callApi("/api/audits/gp", msg.payload);
      sendResponse(result.error
        ? { ok: false, error: result.error }
        : { ok: true, run_id: result.run?.id, row_count: result.row_count });
    })();
    return true;
  } else if (msg.type === "uploadInvoiceAudit") {
    (async () => {
      const result = await callApi("/api/audits/invoice", msg.payload);
      sendResponse(result.error
        ? { ok: false, error: result.error }
        : { ok: true, run_id: result.run?.id, row_count: result.row_count });
    })();
    return true;
  } else if (msg.type === "gpAuditAiSummary") {
    (async () => {
      const stored = await chrome.storage.local.get("gpPrompts");
      const p = stored.gpPrompts || {};
      const result = await callApi("/api/analyze/gp-summary", {
        system: p.system,
        template: p.execSummary,
        payload: msg.payload,
        gp_audit_id: msg.gpAuditId,
      });
      accumulateCost(result);
      sendResponse(result.error ? { error: result.error } : { text: result.text });
    })();
    return true;
  } else if (msg.type === "gpAuditRowReview") {
    (async () => {
      const stored = await chrome.storage.local.get("gpPrompts");
      const p = stored.gpPrompts || {};
      const result = await callApi("/api/analyze/gp-row", {
        system: p.system,
        template: p.rowReview,
        row: msg.row,
        gp_audit_id: msg.gpAuditId,
      });
      accumulateCost(result);
      sendResponse(result.error ? { error: result.error } : { text: result.text });
    })();
    return true;
  } else if (msg.type === "invoiceAuditAiSummary") {
    (async () => {
      const stored = await chrome.storage.local.get("invoicePrompts");
      const p = stored.invoicePrompts || {};
      const result = await callApi("/api/analyze/invoice-summary", {
        system: p.system,
        template: p.execSummary,
        payload: msg.payload,
        invoice_audit_id: msg.invoiceAuditId,
      });
      accumulateCost(result);
      sendResponse(result.error ? { error: result.error } : { text: result.text });
    })();
    return true;
  } else if (msg.type === "invoiceAuditRowReview") {
    (async () => {
      const stored = await chrome.storage.local.get("invoicePrompts");
      const p = stored.invoicePrompts || {};
      const result = await callApi("/api/analyze/invoice-row", {
        system: p.system,
        template: p.rowReview,
        row: msg.row,
        invoice_audit_id: msg.invoiceAuditId,
      });
      accumulateCost(result);
      sendResponse(result.error ? { error: result.error } : { text: result.text });
    })();
    return true;
  } else if (msg.type === "invoiceScreenshotParse") {
    (async () => {
      try {
        const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");
        const result = await callApi("/api/analyze/vision", { image_base64: base64 });
        if (result.error) { sendResponse({ error: result.error }); return; }
        sendResponse({ data: result.data, raw: result.raw });
      } catch (e) { sendResponse({ error: e.message }); }
    })();
    return true;
  } else if (msg.type === "getApiCost") {
    sendResponse({ ...sessionCost }); return;
  } else if (msg.type === "resetApiCost") {
    sessionCost = { inputTokens: 0, outputTokens: 0, totalUsd: 0, calls: 0 };
    sendResponse({ ok: true }); return;
  } else if (msg.type === "startServer") {
    sendNativeMessage("start").then(sendResponse); return true;
  } else if (msg.type === "stopServer") {
    sendNativeMessage("stop").then(sendResponse); return true;
  } else if (msg.type === "serverStatus") {
    sendNativeMessage("status").then(sendResponse); return true;
  } else if (msg.type === "serverTailLog") {
    sendNativeMessage("tail-log").then(sendResponse); return true;
  }
});
