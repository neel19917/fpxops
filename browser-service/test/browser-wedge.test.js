import { test, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { openWindowPage, isWedged, BROWSER_WEDGED, closeTargets, restartUserBrowser } from "../src/browser.js";

// A stand-in for Chromium's browser-level DevTools endpoint (what rootSend
// talks to): answers Target.createTarget and records every command.
const seen = [];
const wss = new WebSocketServer({ port: 0 });
wss.on("connection", (ws) => ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  seen.push(m);
  const result = m.method === "Target.createTarget" ? { targetId: `T${seen.length}` } : {};
  ws.send(JSON.stringify({ id: m.id, result }));
}));
await new Promise((r) => wss.once("listening", r));
const endpoint = `ws://127.0.0.1:${wss.address().port}`;
after(() => wss.close());

const fakeBrowser = (waitForTarget) => ({ wsEndpoint: () => endpoint, waitForTarget });

test("a window that never comes up: BROWSER_WEDGED, and the dead window is closed", async () => {
  seen.length = 0;
  const browser = fakeBrowser(async () => { throw new Error("Timed out after waiting 10000ms"); });
  const err = await openWindowPage(browser, null).then(() => null, (e) => e);
  assert.ok(err, "should throw");
  assert.equal(err.code, BROWSER_WEDGED);
  assert.ok(isWedged(err));
  assert.match(err.message, /did not open a new window — Timed out after waiting 10000ms/);
  const created = seen.find((m) => m.method === "Target.createTarget");
  const closed = seen.find((m) => m.method === "Target.closeTarget");
  assert.ok(created && closed, "createTarget then closeTarget");
  assert.equal(closed.params.targetId, "T1");
});

test("a window that comes up is returned and not closed", async () => {
  seen.length = 0;
  const page = { createCDPSession: async () => ({ send: async () => ({}) }), goto: async () => {} };
  const browser = fakeBrowser(async (pred) => {
    const target = { _targetId: "T1", page: async () => page };
    assert.ok(pred(target));
    return target;
  });
  assert.equal(await openWindowPage(browser, null), page);
  assert.ok(!seen.some((m) => m.method === "Target.closeTarget"));
});

test("other errors are not BROWSER_WEDGED", () => {
  assert.equal(isWedged(new Error("Timed out after 90 min")), false);
  assert.equal(isWedged(null), false);
});

test("closeTargets closes each window at the browser level", async () => {
  seen.length = 0;
  await closeTargets(fakeBrowser(), ["A", "B"]);
  assert.deepEqual(seen.filter((m) => m.method === "Target.closeTarget").map((m) => m.params.targetId).sort(), ["A", "B"]);
});

test("restartUserBrowser with no running browser is a no-op success", async () => {
  assert.equal(await restartUserBrowser("nobody@example.com"), true);
});
