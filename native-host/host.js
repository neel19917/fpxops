#!/usr/bin/env node
// FPXpress native messaging host.
// Chrome spawns this process when the extension calls connectNative("com.fpxpress.server").
// We read length-prefixed JSON messages from stdin and respond the same way.
//
// Actions supported: start | stop | status.
// The actual API server is spawned DETACHED so it survives if Chrome closes this host.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..", "server");
const PIDFILE = join(HERE, ".server.pid");
const LOGFILE = join(HERE, "..", "server.log");

function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
  try {
    const s = fs.readFileSync(PIDFILE, "utf8").trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function send(msg) {
  const buf = Buffer.from(JSON.stringify(msg));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length);
  process.stdout.write(Buffer.concat([len, buf]));
}

// Read length-prefixed messages from stdin.
let stdinBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const body = stdinBuf.subarray(4, 4 + len).toString("utf8");
    stdinBuf = stdinBuf.subarray(4 + len);
    try { handle(JSON.parse(body)); }
    catch (e) { send({ ok: false, error: e.message || String(e) }); }
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  const action = msg && msg.action;
  if (action === "status") {
    const pid = readPid();
    const running = isAlive(pid);
    send({ ok: true, running, pid: running ? pid : null });
    return;
  }
  if (action === "start") {
    const existing = readPid();
    if (isAlive(existing)) { send({ ok: true, alreadyRunning: true, pid: existing }); return; }
    try {
      if (!fs.existsSync(join(SERVER_DIR, "index.js"))) {
        send({ ok: false, error: `server/index.js not found at ${SERVER_DIR}` });
        return;
      }
      if (!fs.existsSync(join(SERVER_DIR, "node_modules"))) {
        send({ ok: false, error: "Server dependencies not installed. Run `cd server && npm install` once first." });
        return;
      }
      const out = fs.openSync(LOGFILE, "a");
      const proc = spawn(process.execPath, ["index.js"], {
        cwd: SERVER_DIR,
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env },
      });
      proc.on("error", (e) => {
        try { fs.appendFileSync(LOGFILE, `\n[spawn-error] ${e.message}\n`); } catch {}
      });
      proc.unref();
      fs.writeFileSync(PIDFILE, String(proc.pid));
      send({ ok: true, pid: proc.pid });
    } catch (e) {
      send({ ok: false, error: e.message || String(e) });
    }
    return;
  }
  if (action === "stop") {
    const pid = readPid();
    if (!isAlive(pid)) { send({ ok: false, error: "Server not running" }); return; }
    try { process.kill(pid); } catch {}
    try { fs.unlinkSync(PIDFILE); } catch {}
    send({ ok: true });
    return;
  }
  if (action === "tail-log") {
    try {
      const stat = fs.statSync(LOGFILE);
      const readLen = Math.min(stat.size, 16 * 1024);
      const fd = fs.openSync(LOGFILE, "r");
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
      fs.closeSync(fd);
      send({ ok: true, log: buf.toString("utf8") });
    } catch (e) {
      send({ ok: false, error: e.message });
    }
    return;
  }
  send({ ok: false, error: `Unknown action: ${action}` });
}
