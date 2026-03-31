#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "..", "server");
const SERVER_ENTRY = resolve(SERVER_DIR, "index.js");

let serverProc = null;
let serverLog = [];
const MAX_LOG_LINES = 40;

function readMessage() {
  return new Promise((resolve) => {
    let lenBuf = Buffer.alloc(0);

    function onData(chunk) {
      lenBuf = Buffer.concat([lenBuf, chunk]);

      if (lenBuf.length < 4) return;

      const msgLen = lenBuf.readUInt32LE(0);
      const full = lenBuf.slice(4);

      if (full.length < msgLen) return;

      process.stdin.removeListener("data", onData);
      const json = full.slice(0, msgLen).toString("utf-8");
      try {
        resolve(JSON.parse(json));
      } catch {
        resolve({ action: "unknown" });
      }
    }

    process.stdin.on("data", onData);
  });
}

function sendMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  process.stdout.write(len);
  process.stdout.write(buf);
}

function startServer() {
  if (serverProc && !serverProc.killed) {
    sendMessage({ status: "already_running", pid: serverProc.pid });
    return;
  }

  serverLog = [];

  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProc.stdout.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      serverLog.push(line);
      if (serverLog.length > MAX_LOG_LINES) serverLog.shift();
    }
  });

  serverProc.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      serverLog.push("[err] " + line);
      if (serverLog.length > MAX_LOG_LINES) serverLog.shift();
    }
  });

  serverProc.on("exit", (code) => {
    serverLog.push(`[exit] code=${code}`);
    serverProc = null;
  });

  sendMessage({ status: "started", pid: serverProc.pid });
}

function stopServer() {
  if (!serverProc || serverProc.killed) {
    sendMessage({ status: "not_running" });
    return;
  }
  const pid = serverProc.pid;
  serverProc.kill("SIGTERM");
  serverProc = null;
  sendMessage({ status: "stopped", pid });
}

function getStatus() {
  const running = serverProc != null && !serverProc.killed;
  sendMessage({
    status: running ? "running" : "stopped",
    pid: running ? serverProc.pid : null,
    log: serverLog.slice(-10),
  });
}

async function main() {
  while (true) {
    const msg = await readMessage();
    switch (msg.action) {
      case "start":
        startServer();
        break;
      case "stop":
        stopServer();
        break;
      case "status":
        getStatus();
        break;
      default:
        sendMessage({ error: "unknown action", received: msg.action });
    }
  }
}

main().catch(() => process.exit(1));
