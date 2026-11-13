import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { poolStats, closeAll, userStatus, selfTest, resetUserProfile } from "./browser.js";
import { summary as usageSummary, flush as flushUsage } from "./usage.js";
import { ViewerSession, egressStats, dropAllParked } from "./session.js";
import { startSettings, list as listSettings, update as updateSettings } from "./settings.js";
import { startScrapeWorker, workerBusy, workerState, requestStop, fullLog } from "./worker.js";
import { listRuns, readRunLog, initRuns, supabaseEnabled } from "./runs.js";
import { chat, assistantEnabled, startAssistantIndexer, assistantIndexStatus, saveChatTurn, listChats, getChat, deleteChat } from "./assistant.js";

// 20 assistant messages per person per minute.
const chatHits = new Map();
function allowChat(email) {
  const now = Date.now();
  const hits = (chatHits.get(email) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 20) return false;
  hits.push(now); chatHits.set(email, hits);
  return true;
}
import { startLoginKeepAlive } from "./keepalive.js";
import { listSchedules, createSchedule, updateSchedule, deleteSchedule, runScheduleNow, startScheduler } from "./schedules.js";

const sessions = new Set();
const resetting = new Set(); // emails whose hosted login is being reset

const bootedAt = new Date().toISOString();
let selfTestResult = { ok: null, pending: true };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // CORS for the dashboard's fetch() calls (WS has its own Origin check).
  const origin = req.headers.origin || "";
  if (config.devNoAuth || config.allowedOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin || "*");
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  // Authenticated JSON API for the dashboard (Scraping page, admin logs).
  if (API_PATH.test(url.pathname)) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const who = await verifyUser(token, url.searchParams.get("devUser"));
    if (!who) return json(res, 401, { error: "unauthorized" });
    try {
      return await handleApi(req, res, url, who);
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      sessions: sessions.size,
      // Count only — never list whose browsers are running on an unauthenticated endpoint.
      browsers: poolStats().length,
      scrapeWorker: config.scrapeWorker ? (workerBusy() ? "busy" : "idle") : "off",
      selfTest: selfTestResult,
      runHistory: supabaseEnabled ? "supabase" : "local",
      assistant: assistantEnabled,
    }));
    return;
  }
  res.writeHead(404).end();
});

const API_PATH = /^\/(stats|me|scrape\/stop|scrape\/log|runs|schedules|assistant|admin)(\/|$)/;

async function readJson(req, maxBytes = 64 * 1024) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > maxBytes) throw new Error("body too large"); }
  try { return body ? JSON.parse(body) : {}; } catch { throw new Error("invalid JSON"); }
}

function sendLog(res, filename, text) {
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  res.end(text.endsWith("\n") ? text : text + "\n");
}

// Run history visible to `who`: admins see everyone's, others their own.
function runsFor(who, { limit = 20, user, source, ok } = {}) {
  let rows = listRuns(200);
  if (!who.isAdmin) rows = rows.filter((r) => r.user === who.email);
  else if (user) rows = rows.filter((r) => r.user === user);
  if (source) rows = rows.filter((r) => r.source === source);
  if (ok === "true" || ok === "false") rows = rows.filter((r) => String(r.ok) === ok);
  return rows.slice(0, Math.min(200, Math.max(1, Number(limit) || 20)));
}

async function handleApi(req, res, url, who) {
  const p = url.pathname;
  const m = req.method;

  // Sign out of FreightPOP in the hosted browser and start over. Admins may
  // reset someone else's ({ email }); everyone else only their own.
  if (p === "/me/reset-login" && m === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const email = String(body.email || who.email).trim().toLowerCase();
    if (email !== who.email.toLowerCase() && !who.isAdmin) return json(res, 403, { error: "Only admins can reset someone else's login" });
    if (resetting.has(email)) return json(res, 409, { error: "Already resetting" });
    resetting.add(email);
    try {
      if (userStatus(email).busy) return json(res, 409, { error: "A scrape is running in this browser — stop it first" });
      for (const s of [...sessions]) {
        if (s.who.email.toLowerCase() !== email) continue;
        try { s.ws.close(4011, "login reset"); } catch {}
        await endSession(s, "login reset");
      }
      dropAllParked(email);
      await resetUserProfile(email);
      console.log(`[ws] ${who.email} reset the hosted FreightPOP login for ${email}`);
      return json(res, 200, { reset: true, email });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message });
    } finally {
      resetting.delete(email);
    }
  }

  if (p === "/me" && m === "GET") {
    return json(res, 200, { user: who.email, isAdmin: who.isAdmin, browser: userStatus(who.email) });
  }
  if (p === "/stats" && m === "GET") {
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const browsers = poolStats();
    return json(res, 200, {
      bootedAt,
      now: new Date().toISOString(),
      isAdmin: who.isAdmin,
      limits: { maxBrowsers: config.maxBrowsers, maxSessions: config.maxSessions, maxTabsPerUser: config.maxTabsPerUser, idleCloseMin: config.idleCloseMs / 60_000 },
      live: {
        sessions: sessions.size,
        browsers: browsers.length,
        memoryMb: browsers.reduce((t, b) => t + (b.memoryMb || 0), 0),
        egress: egressStats(),
        perBrowser: browsers,
      },
      me: userStatus(who.email),
      worker: workerState(),
      usage: usageSummary(days),
      runs: runsFor(who, { limit: 10 }),
      schedules: listSchedules(who),
    });
  }
  if (p === "/scrape/stop" && m === "POST") {
    const cur = workerState().current;
    if (cur && cur.user !== who.email && !who.isAdmin) return json(res, 403, { error: "Only the person running it (or an admin) can stop this scrape" });
    return json(res, 200, { stopping: requestStop(who.email) });
  }
  if (p === "/scrape/log" && m === "GET") {
    const runId = url.searchParams.get("run");
    if (runId) {
      const got = await readRunLog(runId);
      if (!got) return json(res, 404, { error: "run not found" });
      if (got.run.user !== who.email && !who.isAdmin) return json(res, 403, { error: "not your run" });
      return sendLog(res, `scrape-${runId.slice(0, 12)}.log`, got.text);
    }
    const job = fullLog();
    if (!job) return json(res, 404, { error: "no scrape log yet" });
    if (job.user !== who.email && !who.isAdmin) return json(res, 403, { error: "not your run" });
    return sendLog(res, `scrape-${String(job.requestId).slice(0, 12)}.log`, job.log.map((l) => `${l.t}\t${l.level}\t${l.text}`).join("\n"));
  }
  // FreightPOP dashboard totals at the start / end of every run — company-wide
  // numbers, so everyone sees the trend (only the totals, not run details).
  if (p === "/runs/totals" && m === "GET") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
    const points = listRuns(200)
      .filter((r) => r.fpBefore || r.fpAfter || r.tasksBefore || r.tasksAfter)
      .slice(0, limit)
      .map((r) => ({ id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, ok: r.ok, source: r.source, scheduleName: r.scheduleName || null, before: r.fpBefore || null, after: r.fpAfter || null, tasksBefore: r.tasksBefore || null, tasksAfter: r.tasksAfter || null }));
    return json(res, 200, { points });
  }
  if (p === "/runs" && m === "GET") {
    const q = Object.fromEntries(url.searchParams);
    return json(res, 200, { isAdmin: who.isAdmin, runs: runsFor(who, q) });
  }
  // Admin: live state of the data pipeline (for the Data Flow page).
  if (p === "/admin/pipeline" && m === "GET") {
    if (!who.isAdmin) return json(res, 403, { error: "Admins only" });
    const last = listRuns(1)[0] || null;
    return json(res, 200, {
      scrape: { running: workerBusy(), lastRun: last ? { startedAt: last.startedAt, finishedAt: last.finishedAt, ok: last.ok, saved: last.counts?.saved ?? null, note: last.note } : null },
      assistant: assistantEnabled ? assistantIndexStatus() : null,
    });
  }
  // Admin: each person's hosted FreightPOP login (for the Users page).
  if (p === "/admin/logins" && m === "POST") {
    if (!who.isAdmin) return json(res, 403, { error: "Admins only" });
    const { emails = [] } = await readJson(req).catch(() => ({}));
    const list = [...new Set((Array.isArray(emails) ? emails : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, 500);
    return json(res, 200, {
      logins: list.map((email) => {
        const st = userStatus(email);
        const views = [...sessions].filter((s) => s.who.email.toLowerCase() === email && !s.watchOnly).length;
        return { email, signedIn: !!(st.hasProfile && st.freightpop?.loggedIn), hasProfile: st.hasProfile, running: st.running, busy: st.busy, views, memoryMb: st.memoryMb, freightpop: st.freightpop };
      }),
    });
  }
  if (p === "/admin/settings") {
    if (!who.isAdmin) return json(res, 403, { error: "Admins only" });
    if (m === "GET") return json(res, 200, { settings: listSettings(), live: { sessions: sessions.size, browsers: poolStats().length, memoryMb: poolStats().reduce((t, b) => t + (b.memoryMb || 0), 0), egress: egressStats() } });
    if (m === "PUT") return json(res, 200, { settings: await updateSettings((await readJson(req)).settings, who.email) });
  }
  // Chat history — each person's own conversations only.
  if (p === "/assistant/chats" && m === "GET") {
    if (!assistantEnabled) return json(res, 503, { error: "Assistant isn't configured on this service" });
    return json(res, 200, { chats: await listChats(who.email) });
  }
  const cm = /^\/assistant\/chats\/([0-9a-f-]{36})$/i.exec(p);
  if (cm && assistantEnabled) {
    if (m === "GET") {
      const c = await getChat(who.email, cm[1]);
      return c ? json(res, 200, { chat: c }) : json(res, 404, { error: "Chat not found" });
    }
    if (m === "DELETE") { await deleteChat(who.email, cm[1]); return json(res, 200, { deleted: true }); }
  }
  // Streaming chat: newline-delimited JSON events — {type:"text",delta},
  // {type:"status",text}, {type:"reset"}, then {type:"done", ...reply} or
  // {type:"error",error}. Words show as they're written.
  if (p === "/assistant/chat/stream" && m === "POST") {
    if (!assistantEnabled) return json(res, 503, { error: "Assistant isn't configured on this service" });
    if (!allowChat(who.email)) return json(res, 429, { error: "Slow down — too many questions in the last minute" });
    const body = await readJson(req, 2 * 1024 * 1024);
    const message = String(body.message || "").trim().slice(0, 4000);
    if (!message) return json(res, 400, { error: "message required" });
    const history = Array.isArray(body.history) ? body.history.slice(-60) : [];
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
    const emit = (ev) => { if (!res.writableEnded) res.write(JSON.stringify(ev) + "\n"); };
    const t0 = Date.now();
    try {
      const out = await chat({ history, message, who, context: body.context || null, onEvent: emit });
      console.log(`[assistant] ${who.email} (stream): ${out.usage.steps} step(s) [${out.usage.tools.join(",")}], ${out.usage.input}+${out.usage.output} tok (${out.usage.cache_read} cached), cost ${(out.usage.cost_usd || 0).toFixed(4)} USD, ${Date.now() - t0}ms`);
      emit({ type: "done", ...out });
      if (body.chatId) saveChatTurn({ chatId: body.chatId, email: who.email, message, reply: out.reply, actions: out.actions, messages: out.messages })
        .catch((e) => console.warn("[assistant] history save failed:", e.message));
    } catch (e) {
      console.warn("[assistant] stream error:", e.status || "", e.message);
      emit({ type: "error", error: e.status === 429 ? "Claude is rate-limited right now — try again in a moment" : `Assistant error: ${e.message}` });
    }
    return res.end();
  }
  if (p === "/assistant/chat" && m === "POST") {
    if (!assistantEnabled) return json(res, 503, { error: "Assistant isn't configured on this service" });
    if (!allowChat(who.email)) return json(res, 429, { error: "Slow down — too many questions in the last minute" });
    const body = await readJson(req, 2 * 1024 * 1024); // history carries tool results
    const message = String(body.message || "").trim().slice(0, 4000);
    if (!message) return json(res, 400, { error: "message required" });
    const history = Array.isArray(body.history) ? body.history.slice(-60) : [];
    const t0 = Date.now();
    try {
      const out = await chat({ history, message, who, context: body.context || null });
      console.log(`[assistant] ${who.email}: ${out.usage.steps} step(s) [${out.usage.tools.join(",")}], ${out.actions.length} action(s), ${out.usage.input}+${out.usage.output} tok (${out.usage.cache_read} cached), cost ${(out.usage.cost_usd || 0).toFixed(4)} USD, ${Date.now() - t0}ms`);
      if (body.chatId) saveChatTurn({ chatId: body.chatId, email: who.email, message, reply: out.reply, actions: out.actions, messages: out.messages })
        .catch((e) => console.warn("[assistant] history save failed:", e.message));
      return json(res, 200, out);
    } catch (e) {
      console.warn("[assistant] error:", e.status || "", e.message);
      return json(res, e.status === 429 ? 429 : 502, { error: e.status === 429 ? "Claude is rate-limited right now — try again in a moment" : `Assistant error: ${e.message}` });
    }
  }
  if (p === "/schedules" && m === "GET") return json(res, 200, { schedules: listSchedules(who) });
  if (p === "/schedules" && m === "POST") return json(res, 201, { schedule: createSchedule(who, await readJson(req)) });
  const sm = /^\/schedules\/([0-9a-f-]{36})(\/run)?$/.exec(p);
  if (sm) {
    const [, id, run] = sm;
    if (run && m === "POST") return json(res, 200, runScheduleNow(who, id));
    if (!run && m === "PUT") return json(res, 200, { schedule: updateSchedule(who, id, await readJson(req)) });
    if (!run && m === "DELETE") { deleteSchedule(who, id); return json(res, 200, { deleted: true }); }
  }
  return json(res, 405, { error: "method not allowed" });
}

// Verify the dashboard user's Supabase JWT against the existing API, which
// already enforces "enabled" profiles. /api/ops/rescrape is a cheap read-only
// GET behind the same requireAuth gate (deliberately NOT /api/me, which has a
// side effect: it clears the user's pending extension API key).
// Successful verifications are cached for 60s (keyed by token hash) so the
// Scraping page's polling doesn't hit the API on every tick. Failures aren't.
const verified = new Map(); // sha256(token) -> { who, exp }

async function verifyUser(token, devUser) {
  if (config.devNoAuth) return { email: devUser || "dev@local", isAdmin: !devUser || /admin/.test(devUser) };
  if (!token || typeof token !== "string") return null;
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const hit = verified.get(key);
  if (hit && hit.exp > Date.now()) return hit.who;
  const who = await verifyUserUncached(token);
  if (who) {
    verified.set(key, { who, exp: Date.now() + 60_000 });
    if (verified.size > 500) verified.delete(verified.keys().next().value);
  }
  return who;
}

async function verifyUserUncached(token) {
  const res = await fetch(`${config.apiUrl}/api/ops/rescrape`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  // Admin = can read the API's admin-only users list (same gate the dashboard's
  // Admin menu uses). Cached with the rest of the identity for 60s.
  const adm = await fetch(`${config.apiUrl}/api/users`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  const isAdmin = !!adm?.ok;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return { email: payload.email || payload.sub || "unknown", isAdmin };
  } catch { return { email: "unknown", isAdmin }; }
}

// End a view exactly once: drop it from `sessions`, log why, close it. A view
// can be ended from two places (evicted / login reset here, then the socket's
// own "close" event a moment later); the second caller just gets the first
// one's promise, so nothing is closed, counted or logged twice.
const ending = new WeakMap(); // session -> promise of its close()
function endSession(s, reason) {
  const already = ending.get(s);
  if (already) return already;
  sessions.delete(s);
  const kind = s.watchOnly ? "watch" : isPaused(s) ? "paused view" : "visible view";
  console.log(`[ws] session closed for ${s.who.email} (${sessions.size} active): ${reason}, ${kind}`);
  // Never wait forever on a stuck browser: the caller may hold the user's
  // connection queue (see withUserLock).
  const p = Promise.race([
    Promise.resolve().then(() => s.close()).catch((e) => console.warn(`[ws] close failed for ${s.who.email}: ${e.message}`)),
    new Promise((r) => { setTimeout(r, 10_000).unref(); }),
  ]);
  ending.set(s, p);
  return p;
}

// Paused = the dashboard tab is hidden or its FreightPOP pane is closed
// (client sent { type: "pause" }). Not set yet counts as visible.
const isPaused = (s) => s.paused === true;

// One connection at a time per person through "make room + register", so a
// burst of tabs opening together can't each see a free slot and all get in.
const userQueues = new Map(); // email -> end of that person's queue
function withUserLock(email, fn) {
  const run = (userQueues.get(email) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  userQueues.set(email, tail);
  tail.then(() => { if (userQueues.get(email) === tail) userQueues.delete(email); });
  return run;
}

function evict(old, why) {
  try { old.ws.close(4009, "replaced by a newer tab"); } catch {}
  return endSession(old, `evicted (${why})`);
}

// Make room for a new connection and register it. Returns the new session, or
// null when the connection was refused or went away. Runs under withUserLock.
async function admit(ws, who, target) {
  const email = who.email.toLowerCase();
  // `sessions` keeps connection order, so these are oldest first.
  const myViews = () => [...sessions].filter((s) => s.who.email.toLowerCase() === email && !s.watchOnly);
  // Gone while waiting in the queue: don't close anything on its behalf.
  if (ws.readyState !== 1) return null;
  // Tracking views: many allowed, but each person is capped. Over the cap, a
  // paused (hidden) view goes first, oldest first; a visible one only when
  // none is paused, oldest first. Never the new one — that's the tab they're
  // looking at. Watching a scrape doesn't count and is never closed here.
  if (target === "tab") {
    const cap = Math.max(1, Number(config.maxTabsPerUser) || 1);
    for (let views = myViews(); views.length >= cap; views = myViews()) {
      await evict(views.find(isPaused) || views[0], `over ${cap} views per user`);
    }
  }
  // Server full: take back this person's own paused views before refusing.
  // (Their visible views, and other people's, are left alone.)
  while (sessions.size >= config.maxSessions) {
    const old = myViews().find(isPaused);
    if (!old) break;
    await evict(old, "server at its session limit");
  }
  // No awaits from here to sessions.add, so the checks hold across users too.
  if (ws.readyState !== 1) return null;
  if (resetting.has(email)) { ws.close(1013, "login reset in progress"); return null; }
  if (sessions.size >= config.maxSessions) {
    console.log(`[ws] refused ${who.email}: too many sessions (${sessions.size} active)`);
    ws.close(4029, "too many sessions");
    return null;
  }
  const session = new ViewerSession(ws, who, { target });
  sessions.add(session);
  console.log(`[ws] session opened for ${who.email} (${sessions.size} active): ${target === "tab" ? `view ${myViews().length} of this user's` : "watch"}`);
  return session;
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin || "";
  if (!config.devNoAuth && !config.allowedOrigins.includes(origin)) {
    ws.close(4003, "origin not allowed");
    return;
  }
  let session = null;
  let authing = false; // an auth message is being handled (ignore repeats)
  // First message must be { type: "auth", token }. Token in the first frame
  // (not the URL) keeps it out of proxy access logs.
  const authTimer = setTimeout(() => ws.close(4001, "auth timeout"), 10_000);

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (!session) {
        if (msg.type !== "auth" || authing) return;
        authing = true;
        clearTimeout(authTimer);
        try {
          const who = await verifyUser(msg.token, msg.devUser);
          if (!who) { ws.close(4001, "unauthorized"); return; }
          // Mid login-reset: have the client retry in a moment (normal backoff).
          if (resetting.has(who.email.toLowerCase())) { ws.close(1013, "login reset in progress"); return; }
          const target = msg.target === "scrape" ? "scrape" : "tab";
          // Per-user cap, server limit and registration: see admit().
          session = await withUserLock(who.email.toLowerCase(), () => admit(ws, who, target));
        } finally {
          if (!session) authing = false;
        }
        if (!session) return;
        if (msg.viewport) session.viewport = {
          width: msg.viewport.width || 1280, height: msg.viewport.height || 800, dpr: 1,
        };
        try {
          await session.start();
        } catch (e) {
          if (e.code === "CAPACITY") { ws.close(4029, "capacity"); return; }
          throw e;
        }
        return;
      }
      await session.handle(msg);
    } catch (e) {
      console.warn("[ws] handler error:", e.message);
      try { ws.send(JSON.stringify({ type: "error", error: e.message })); } catch {}
    }
  });

  ws.on("close", async (code, reason) => {
    clearTimeout(authTimer);
    // Already ended (evicted, login reset) → endSession does nothing more.
    if (session) await endSession(session, `socket closed ${code}${reason?.length ? ` "${reason}"` : ""}`);
  });
});

server.listen(config.port, async () => {
  console.log(`[fpx-browser] listening on :${config.port}${config.devNoAuth ? " (DEV: auth disabled)" : ""}`);
  startSettings();
  initRuns().catch((e) => console.warn("[runs] init failed:", e.message));
  if (config.scrapeWorker) { startScrapeWorker(); startScheduler(); }
  startLoginKeepAlive();
  startAssistantIndexer();
  selfTest().then((r) => {
    selfTestResult = r;
    console.log(`[selftest] ${r.ok ? "OK" : "FAILED"} ${JSON.stringify(r)}`);
  });
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    for (const s of sessions) await s.close();
    await closeAll();
    flushUsage();
    process.exit(0);
  });
}
