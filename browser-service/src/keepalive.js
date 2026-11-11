import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { acquireUserBrowser, writeState } from "./browser.js";

// FreightPOP logins last 12 hours. FreightPOP's newer app renews its token
// before then (POST appbe /token, grant_type=refresh_token); the Broker
// dashboard we drive never does, so hosted logins used to die overnight and
// the morning scrape failed. This renews each signed-in user's login in their
// own hosted browser once less than RENEW_LEFT_MS remains (FreightPOP's app
// uses the same half-life rule). Each renewal rotates the refresh token.

const CHECK_MS = 20 * 60_000;
const RENEW_LEFT_MS = 6 * 3600_000;
// Same-origin page that's cheap to load (an IIS 404) — just gives us
// app.freightpop.com's localStorage without starting the Broker app.
const ORIGIN_PAGE = "https://app.freightpop.com/Broker/Content/Images/circle_loading.gif";

let running = false;

export function startLoginKeepAlive() {
  setTimeout(() => tick().catch(() => {}), 90_000);
  setInterval(() => tick().catch(() => {}), CHECK_MS);
}

function profileStates() {
  let dirs = [];
  try { dirs = fs.readdirSync(config.profileRoot); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(config.profileRoot, d, "fpx-state.json"), "utf8"))); } catch {}
  }
  return out;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const st of profileStates()) {
      if (!st?.email || !st.loggedIn) continue;
      const exp = Date.parse(st.tokenExp || "");
      if (exp && exp - Date.now() > RENEW_LEFT_MS) continue;
      await renewLogin(st.email).catch((e) => console.warn(`[keepalive] ${st.email}: ${e.message}`));
    }
  } finally {
    running = false;
  }
}

export async function renewLogin(email, { force = false } = {}) {
  const lease = await acquireUserBrowser(email);
  let page;
  try {
    page = await lease.browser.newPage();
    await page.goto(ORIGIN_PAGE, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    const r = await page.evaluate(renewInPage, force ? Infinity : RENEW_LEFT_MS);
    const now = new Date().toISOString();
    if (r.reason === "renewed" || r.reason === "fresh") {
      writeState(email, { tokenExp: r.exp || null, keepAlive: { at: now, result: r.reason } });
    } else if (r.reason === "expired" || r.reason === "refused" || r.reason === "no-login") {
      writeState(email, { loggedIn: false, tokenExp: null, keepAlive: { at: now, result: r.reason, status: r.status || null } });
    } else {
      writeState(email, { keepAlive: { at: now, result: r.reason, status: r.status || null } });
    }
    console.log(`[keepalive] ${email}: ${r.reason}${r.exp ? ` (login good until ${r.exp})` : ""}${r.status ? ` [${r.status}]` : ""}`);
    return r;
  } finally {
    await page?.close().catch(() => {});
    lease.release();
  }
}

// Runs inside app.freightpop.com. Never returns token values.
async function renewInPage(leftMs) {
  const raw = localStorage.getItem("user");
  if (!raw) return { reason: "no-login" };
  let u; try { u = JSON.parse(raw); } catch { return { reason: "unreadable" }; }
  const st = (u && u.User_State) || {};
  const exp = Date.parse(st.AccessTokenExpiryTime || "");
  if (exp && exp - Date.now() > leftMs) return { reason: "fresh", exp: st.AccessTokenExpiryTime };
  if (!st.RefreshToken) return { reason: "no-refresh-token" };
  const rexp = Date.parse(st.RefreshTokenExpiryTime || "");
  if (rexp && rexp <= Date.now()) return { reason: "expired" };
  let res;
  try {
    res = await fetch("https://appbe.freightpop.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ refresh_token: String(st.RefreshToken).trim(), grant_type: "refresh_token" }),
    });
  } catch (e) { return { reason: "network", error: String(e) }; }
  if (!res.ok) return { reason: res.status === 400 || res.status === 401 ? "refused" : "error", status: res.status };
  let j; try { j = await res.json(); } catch { return { reason: "error", status: res.status }; }
  if (!j || !j.access_token || j.error) return { reason: "refused", status: res.status };
  let us = {};
  try { us = typeof j.UserState === "string" ? JSON.parse(j.UserState) : (j.UserState || {}); } catch {}
  u.User_State = {
    ...st, ...us,
    access_token: j.access_token,
    token_type: j.token_type || st.token_type,
    expires_in: j.expires_in,
    RefreshToken: j.refresh_token || us.RefreshToken || st.RefreshToken,
    AccessTokenExpiryTime: j.AccessTokenExpiryTime || us.AccessTokenExpiryTime,
    RefreshTokenExpiryTime: j.RefreshTokenExpiryTime || us.RefreshTokenExpiryTime,
    AccessTokenExpiryMinutes: j.AccessTokenExpiryMinutes ?? us.AccessTokenExpiryMinutes ?? st.AccessTokenExpiryMinutes,
    RefreshTokenExpiryMinutes: j.RefreshTokenExpiryMinutes ?? us.RefreshTokenExpiryMinutes ?? st.RefreshTokenExpiryMinutes,
    TokenGeneratedTime: j.TokenGeneratedTime || us.TokenGeneratedTime,
    RefreshTokenGeneratedTime: j.RefreshTokenGeneratedTime || us.RefreshTokenGeneratedTime,
  };
  localStorage.setItem("user", JSON.stringify(u));
  return { reason: "renewed", exp: u.User_State.AccessTokenExpiryTime };
}
