#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const command = process.argv[2] || "status";
const rawCmdArgs = process.argv.slice(3);

function parseConnectionArgs(args) {
  let host = process.env.CDP_HOST || "";
  let port = process.env.CDP_PORT || "";
  let wsUrl = process.env.CDP_WS_URL || "";
  let portFile = process.env.CDP_PORT_FILE || "";
  let waitMs = process.env.CDP_CONNECT_TIMEOUT
    ? Number(process.env.CDP_CONNECT_TIMEOUT)
    : 15_000;
  let noWait = false;
  let explicit = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === "--host" || arg === "-H") && i + 1 < args.length) {
      host = args[++i];
      explicit = true;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      explicit = true;
    } else if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
      port = args[++i];
      explicit = true;
    } else if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
      explicit = true;
    } else if (
      (arg === "--ws-url" || arg === "--url" || arg === "-u") &&
      i + 1 < args.length
    ) {
      wsUrl = args[++i];
      explicit = true;
    } else if (arg.startsWith("--ws-url=")) {
      wsUrl = arg.slice("--ws-url=".length);
      explicit = true;
    } else if (arg.startsWith("--url=")) {
      wsUrl = arg.slice("--url=".length);
      explicit = true;
    } else if (arg === "--port-file" && i + 1 < args.length) {
      portFile = args[++i];
      explicit = true;
    } else if (arg.startsWith("--port-file=")) {
      portFile = arg.slice("--port-file=".length);
      explicit = true;
    } else if (
      (arg === "--wait-ms" || arg === "--timeout") &&
      i + 1 < args.length
    ) {
      const parsedWait = Number(args[++i]);
      if (Number.isFinite(parsedWait) && parsedWait >= 0) {
        waitMs = parsedWait;
      }
    } else if (arg.startsWith("--wait-ms=") || arg.startsWith("--timeout=")) {
      const parsedWait = Number(arg.slice(arg.indexOf("=") + 1));
      if (Number.isFinite(parsedWait) && parsedWait >= 0) {
        waitMs = parsedWait;
      }
    } else if (arg === "--no-wait") {
      noWait = true;
    } else if (arg === "--socket" && i + 1 < args.length) {
      process.env.CDP_BRIDGE_SOCKET = args[++i];
    } else if (arg.startsWith("--socket=")) {
      process.env.CDP_BRIDGE_SOCKET = arg.slice("--socket=".length);
    } else if (!arg.startsWith("-")) {
      explicit = true;
      if (/^wss?:\/\//i.test(arg)) {
        wsUrl = arg;
      } else if (/^https?:\/\//i.test(arg)) {
        const parsed = new URL(arg);
        if (parsed.pathname && parsed.pathname.startsWith("/devtools/")) {
          parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
          wsUrl = parsed.toString();
        } else {
          host = parsed.hostname || host;
          port = parsed.port || port;
        }
      } else if (/^\d+$/.test(arg)) {
        port = arg;
      } else {
        const lastColon = arg.lastIndexOf(":");
        if (lastColon > 0 && /^\d+$/.test(arg.slice(lastColon + 1))) {
          host = arg.slice(0, lastColon).replace(/^\[|\]$/g, "");
          port = arg.slice(lastColon + 1);
        } else {
          host = arg;
        }
      }
    }
  }

  return { host, port, wsUrl, portFile, waitMs, noWait, explicit };
}

const connArgs = parseConnectionArgs(rawCmdArgs);

const isWindows = process.platform === "win32";

function getUid() {
  if (typeof process.getuid === "function") {
    return process.getuid();
  }
  try {
    return (
      os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_") || "user"
    );
  } catch {
    return (process.env.USERNAME || process.env.USER || "user").replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
  }
}

function runtimeDirectory() {
  const uid = getUid();
  if (isWindows) {
    return path.join(os.tmpdir(), `cdp-bridge-${uid}`);
  }
  const candidates = [
    process.env.XDG_RUNTIME_DIR,
    `/run/user/${uid}`,
    os.tmpdir(),
  ].filter(Boolean);

  for (const base of candidates) {
    const dir = path.join(base, `cdp-bridge-${uid}`);
    if (fs.existsSync(path.join(dir, "bridge.sock"))) {
      return dir;
    }
  }
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, `cdp-bridge-${uid}`);
}

function resolveSocketPath(runtimeDir) {
  if (process.env.CDP_BRIDGE_SOCKET) {
    return process.env.CDP_BRIDGE_SOCKET;
  }
  if (isWindows) {
    return `\\\\.\\pipe\\cdp-bridge-${getUid()}`;
  }
  return path.join(runtimeDir, "bridge.sock");
}

const runtimeDir = runtimeDirectory();
const socketPath = resolveSocketPath(runtimeDir);
const isNamedPipe = isWindows && /^\\\\[.?]\\pipe\\/i.test(socketPath);
const stateDir = isNamedPipe ? runtimeDir : path.dirname(socketPath);
const pidPath = isNamedPipe
  ? path.join(runtimeDir, "bridge.pid")
  : `${socketPath}.pid`;
const logPath = isNamedPipe
  ? path.join(runtimeDir, "bridge.log")
  : `${socketPath}.log`;

function findDevToolsActivePortCandidates() {
  const candidates = [];

  if (process.env.CDP_PORT_FILE) {
    candidates.push(process.env.CDP_PORT_FILE);
  }

  const winBrowserRelPaths = [
    "Google/Chrome/User Data/DevToolsActivePort",
    "Microsoft/Edge/User Data/DevToolsActivePort",
    "Google/Chrome Beta/User Data/DevToolsActivePort",
    "Google/Chrome SxS/User Data/DevToolsActivePort",
    "Microsoft/Edge Beta/User Data/DevToolsActivePort",
    "Microsoft/Edge Dev/User Data/DevToolsActivePort",
    "BraveSoftware/Brave-Browser/User Data/DevToolsActivePort",
    "Chromium/User Data/DevToolsActivePort",
  ];

  if (isWindows) {
    const localAppDataDirs = Array.from(
      new Set(
        [
          process.env.LOCALAPPDATA,
          path.join(os.homedir(), "AppData", "Local"),
        ].filter(Boolean),
      ),
    );
    for (const base of localAppDataDirs) {
      for (const rel of winBrowserRelPaths) {
        candidates.push(path.join(base, rel));
      }
    }
  } else {
    // Scan Windows host user profiles under WSL2 (/mnt/c/Users/*) alongside Linux native dirs
    try {
      const mntUsers = "/mnt/c/Users";
      if (fs.existsSync(mntUsers)) {
        for (const entry of fs.readdirSync(mntUsers)) {
          if (
            ["Public", "Default", "Default User", "All Users"].includes(entry)
          ) {
            continue;
          }
          for (const rel of winBrowserRelPaths) {
            candidates.push(path.join(mntUsers, entry, "AppData/Local", rel));
          }
        }
      }
    } catch {
      // Ignore permission errors scanning /mnt/c/Users
    }

    candidates.push(
      path.join(os.homedir(), ".config/google-chrome/DevToolsActivePort"),
      path.join(os.homedir(), ".config/microsoft-edge/DevToolsActivePort"),
      path.join(os.homedir(), ".config/chromium/DevToolsActivePort"),
      path.join(
        os.homedir(),
        ".config/BraveSoftware/Brave-Browser/DevToolsActivePort",
      ),
    );
  }

  const existing = candidates
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

  // Deduplicate identical port+path records so stale copied files don't mask real browser profiles
  const seenRecords = new Set();
  const unique = [];
  for (const filePath of existing) {
    try {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (!content || seenRecords.has(content)) {
        continue;
      }
      seenRecords.add(content);
      unique.push(filePath);
    } catch {
      continue;
    }
  }
  return unique;
}

function parseActivePortRecord(filePath) {
  const [port, websocketPath] = fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/);

  if (!port || !websocketPath) {
    throw new Error(`Invalid DevToolsActivePort file: ${filePath}`);
  }
  return { port: port.trim(), websocketPath: websocketPath.trim() };
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function parseActivePortFile(filePath, host = "127.0.0.1") {
  const { port, websocketPath } = parseActivePortRecord(filePath);
  return `ws://${formatHostForUrl(host)}:${port}${websocketPath}`;
}

function probeTcpPort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      resolve(false);
      return;
    }
    const sock = net.connect({ host, port: portNum });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

function fetchDebuggerWebsocketUrl(host, port, timeoutMs = 2_500) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host,
        port: Number(port),
        path: "/json/version",
        agent: false,
        timeout: timeoutMs,
        headers: {
          Host: `localhost:${port}`,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `HTTP ${res.statusCode} from http://${formatHostForUrl(host)}:${port}/json/version`,
              ),
            );
            return;
          }
          try {
            const info = JSON.parse(body);
            if (!info.webSocketDebuggerUrl) {
              reject(
                new Error(
                  `Missing webSocketDebuggerUrl in /json/version response`,
                ),
              );
              return;
            }
            const parsed = new URL(info.webSocketDebuggerUrl);
            parsed.hostname = host;
            parsed.port = String(port);
            resolve(parsed.toString());
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Timed out querying http://${formatHostForUrl(host)}:${port}/json/version`,
        ),
      );
    });
    req.on("error", reject);
  });
}

async function readBrowserWebsocketUrl(options = connArgs) {
  if (options.wsUrl || process.env.CDP_WS_URL) {
    return options.wsUrl || process.env.CDP_WS_URL;
  }

  const targetHost = options.host || process.env.CDP_HOST || "127.0.0.1";
  const targetPort = options.port || process.env.CDP_PORT || "";

  if (options.portFile) {
    return parseActivePortFile(options.portFile, targetHost);
  }

  // When a port is explicitly specified, try HTTP /json/version first, then fallback to DevToolsActivePort path
  if (targetPort) {
    let httpError;
    try {
      return await fetchDebuggerWebsocketUrl(targetHost, targetPort);
    } catch (err) {
      httpError = err;
    }

    const portReachable = await probeTcpPort(targetHost, targetPort, 1_000);
    const candidates = findDevToolsActivePortCandidates();
    for (const candidate of candidates) {
      try {
        const rec = parseActivePortRecord(candidate);
        if (String(rec.port) === String(targetPort)) {
          return `ws://${formatHostForUrl(targetHost)}:${targetPort}${rec.websocketPath}`;
        }
      } catch {
        continue;
      }
    }
    if (portReachable) {
      for (const candidate of candidates) {
        try {
          const rec = parseActivePortRecord(candidate);
          return `ws://${formatHostForUrl(targetHost)}:${targetPort}${rec.websocketPath}`;
        } catch {
          continue;
        }
      }
    }

    throw new Error(
      `Unable to resolve CDP WebSocket from ${targetHost}:${targetPort} (${httpError?.message || "port unreachable"}). ` +
        `Ensure browser remote debugging is enabled on port ${targetPort} or pass --ws-url ws://${formatHostForUrl(targetHost)}:${targetPort}/devtools/browser/<id>`,
    );
  }

  const candidates = findDevToolsActivePortCandidates();
  if (candidates.length === 0) {
    const defaultPath = isWindows
      ? path.join(
          process.env.LOCALAPPDATA ||
            path.join(os.homedir(), "AppData", "Local"),
          "Google/Chrome/User Data/DevToolsActivePort",
        )
      : path.join(os.homedir(), ".config/google-chrome/DevToolsActivePort");
    throw new Error(`DevToolsActivePort file not found (checked ${defaultPath} and browser profile dirs)`);
  }

  // Prefer the newest DevToolsActivePort whose TCP port is actively listening
  const checkedSummary = [];
  for (const candidate of candidates) {
    try {
      const rec = parseActivePortRecord(candidate);
      const alive = await probeTcpPort(targetHost, rec.port, 800);
      checkedSummary.push(`${candidate} (${targetHost}:${rec.port} -> ${alive ? "open" : "closed"})`);
      if (alive) {
        return `ws://${formatHostForUrl(targetHost)}:${rec.port}${rec.websocketPath}`;
      }
    } catch {
      continue;
    }
  }

  throw new Error(
    `No active browser debugging port responded among DevToolsActivePort files:\n  - ${checkedSummary.join("\n  - ")}`,
  );
}

function requestBridge(payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`CDP bridge request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let responseText = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      responseText += chunk.toString("utf8");
      const newline = responseText.indexOf("\n");
      if (newline === -1) {
        return;
      }

      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(responseText.slice(0, newline));
        if (response.error) {
          const err = new Error(
            response.error.message || JSON.stringify(response.error),
          );
          err.data = response.error.data;
          reject(err);
          return;
        }
        resolve(response.result ?? {});
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function removeStaleRuntimeFiles() {
  const files = isNamedPipe ? [pidPath] : [socketPath, pidPath];
  for (const filePath of files) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function stopRunningBridge() {
  try {
    await requestBridge({ id: 1, method: "bridge.shutdown" }, 2_000);
  } catch {
    // Ignore if already stopped
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await requestBridge({ id: 1, method: "bridge.status" }, 300);
      await new Promise((resolve) => setTimeout(resolve, 80));
    } catch {
      break;
    }
  }
  removeStaleRuntimeFiles();
}

async function startBridge({ forceRestart = false } = {}) {
  let resolvedWsUrl = "";
  if (connArgs.explicit) {
    resolvedWsUrl = await readBrowserWebsocketUrl(connArgs);
  }

  let previousWsUrl = "";
  try {
    const status = await requestBridge(
      { id: 1, method: "bridge.status" },
      2_000,
    );
    previousWsUrl = status.browserWebsocketUrl || "";
    const sameTarget =
      !resolvedWsUrl ||
      (status.browserWebsocketUrl &&
        status.browserWebsocketUrl === resolvedWsUrl);
    if (!forceRestart && sameTarget && status.browserState === "ready") {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (
      !forceRestart &&
      sameTarget &&
      status.browserState === "connecting" &&
      connArgs.noWait
    ) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    await stopRunningBridge();
  } catch {
    removeStaleRuntimeFiles();
  }

  // On bare restart without explicit args, try auto-discovery first; if none found, reuse previous live endpoint
  if (!resolvedWsUrl && !connArgs.explicit) {
    try {
      resolvedWsUrl = await readBrowserWebsocketUrl(connArgs);
    } catch (err) {
      if (previousWsUrl) {
        try {
          const parsedPrev = new URL(previousWsUrl);
          if (
            await probeTcpPort(
              parsedPrev.hostname,
              parsedPrev.port || "80",
              800,
            )
          ) {
            resolvedWsUrl = previousWsUrl;
          } else {
            throw err;
          }
        } catch {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  const childEnv = { ...process.env };
  if (resolvedWsUrl) {
    childEnv.CDP_WS_URL = resolvedWsUrl;
  }
  if (connArgs.host) {
    childEnv.CDP_HOST = connArgs.host;
  }
  if (connArgs.port) {
    childEnv.CDP_PORT = connArgs.port;
  }
  if (connArgs.portFile) {
    childEnv.CDP_PORT_FILE = connArgs.portFile;
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [scriptPath, "serve"], {
    detached: true,
    env: childEnv,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);

  const socketDeadline = Date.now() + 5_000;
  let lastStatus = null;
  while (Date.now() < socketDeadline) {
    try {
      lastStatus = await requestBridge({ id: 1, method: "bridge.status" }, 1_000);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  if (!lastStatus) {
    throw new Error(`CDP bridge did not create ${socketPath}; see ${logPath}`);
  }

  if (connArgs.noWait || lastStatus.browserState === "ready") {
    console.log(JSON.stringify(lastStatus, null, 2));
    return;
  }

  // Wait for browser WebSocket handshake to reach "ready" (eliminates `cdp connect && cdp pages` race)
  const readyDeadline = Date.now() + connArgs.waitMs;
  while (Date.now() < readyDeadline) {
    if (lastStatus.browserState === "ready") {
      console.log(JSON.stringify(lastStatus, null, 2));
      return;
    }
    if (lastStatus.browserState === "disconnected") {
      throw new Error(
        `CDP bridge failed to connect to browser (${lastStatus.browserWebsocketUrl || "unknown"}): ${lastStatus.browserError || "WebSocket disconnected"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      lastStatus = await requestBridge({ id: 1, method: "bridge.status" }, 1_000);
    } catch {
      throw new Error(
        `CDP bridge exited while connecting to browser; see ${logPath}`,
      );
    }
  }

  if (lastStatus.browserState === "ready") {
    console.log(JSON.stringify(lastStatus, null, 2));
    return;
  }

  // Keep daemon alive so user can click "Allow" on chrome://inspect or edge://inspect dialog
  console.log(
    JSON.stringify(
      {
        ...lastStatus,
        pendingApprovalHint:
          "Browser WebSocket handshake is still connecting. If remote debugging was enabled via chrome://inspect or edge://inspect, click 'Allow' in the browser prompt.",
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegExp(pattern), "i");
  }
}

async function serveBridge() {
  fs.mkdirSync(stateDir, { recursive: true });

  let pidFd;
  try {
    pidFd = fs.openSync(pidPath, "wx");
    fs.writeSync(pidFd, String(process.pid));
    fs.closeSync(pidFd);
    pidFd = undefined;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }

    const existingPid = Number(fs.readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(existingPid) && isProcessRunning(existingPid)) {
      throw new Error(`CDP bridge is already running with PID ${existingPid}`);
    }
    removeStaleRuntimeFiles();
    pidFd = fs.openSync(pidPath, "wx");
    fs.writeSync(pidFd, String(process.pid));
    fs.closeSync(pidFd);
    pidFd = undefined;
  }

  let browserSocket;
  let browserWebsocketUrl = "";
  let browserState = "connecting";
  let browserError = "";
  let connectedAt = "";
  let lastActivityAt = new Date().toISOString();
  let handshakeCount = 0;
  let commandsForwarded = 0;
  let nextBrowserCommandId = 1;
  let shuttingDown = false;
  const readyWaiters = new Set();
  const pendingBrowserCommands = new Map();
  const pageSessions = new Map();
  const initializedSessions = new Set();
  const sessionLogs = new Map();
  const sessionNetwork = new Map();
  const pendingNetworkRequests = new Map();
  const failedBodyCandidates = new Map();
  const MAX_RING_BUFFER = 300;

  function settleReadyWaiters(err = null) {
    for (const waiter of readyWaiters) {
      clearTimeout(waiter.timer);
      if (err) {
        waiter.reject(err);
      } else {
        waiter.resolve();
      }
    }
    readyWaiters.clear();
  }

  function waitForBrowserReady(timeoutMs = 5_000) {
    if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (browserState !== "connecting") {
      return Promise.reject(
        new Error(
          `Browser CDP connection is ${browserState}${browserError ? `: ${browserError}` : ""}`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          readyWaiters.delete(waiter);
          reject(
            new Error(
              `Browser CDP connection is still connecting after ${timeoutMs}ms (check browser remote debugging approval prompt)`,
            ),
          );
        }, timeoutMs),
      };
      readyWaiters.add(waiter);
    });
  }

  function pushRing(map, sessionId, entry) {
    if (!sessionId) return;
    let list = map.get(sessionId);
    if (!list) {
      list = [];
      map.set(sessionId, list);
    }
    list.push(entry);
    if (list.length > MAX_RING_BUFFER) {
      list.shift();
    }
  }

  function publicStatus() {
    return {
      pid: process.pid,
      socketPath,
      logPath,
      browserWebsocketUrl,
      browserState,
      browserError,
      connectedAt,
      lastActivityAt,
      handshakeCount,
      commandsForwarded,
      activePageSessions: pageSessions.size,
    };
  }

  function cleanupRuntimeFiles() {
    try {
      const currentPid = Number(fs.readFileSync(pidPath, "utf8").trim());
      if (currentPid === process.pid) {
        fs.unlinkSync(pidPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Unable to remove PID file: ${error.message}`);
      }
    }

    if (!isNamedPipe) {
      try {
        fs.unlinkSync(socketPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error(`Unable to remove socket: ${error.message}`);
        }
      }
    }
  }

  async function forwardBrowserCommand(
    method,
    params = {},
    sessionId,
    timeoutMs = 60_000,
  ) {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      await waitForBrowserReady(Math.min(timeoutMs, 8_000));
    }
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      throw new Error(`Browser CDP connection is ${browserState}`);
    }

    const id = nextBrowserCommandId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingBrowserCommands.delete(id);
        reject(
          new Error(`Browser CDP command ${method} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      pendingBrowserCommands.set(id, { resolve, reject, sessionId, timer });
      browserSocket.send(JSON.stringify(message));
      commandsForwarded += 1;
      lastActivityAt = new Date().toISOString();
    });

    // Automatically initialize diagnostics & unfreeze background lifecycle on ANY Target.attachToTarget
    if (
      method === "Target.attachToTarget" &&
      params?.targetId &&
      result?.sessionId
    ) {
      initializeSession(params.targetId, result.sessionId);
    }

    return result;
  }

  function initializeSession(targetId, sessionId) {
    if (!sessionId) return;
    if (targetId) {
      pageSessions.set(targetId, sessionId);
    }
    if (initializedSessions.has(sessionId)) {
      return;
    }
    initializedSessions.add(sessionId);

    // Best-effort enable Runtime/Log/Network/Page & prevent background tab freezing
    void forwardBrowserCommand("Runtime.enable", {}, sessionId, 5_000).catch(
      () => {},
    );
    void forwardBrowserCommand("Log.enable", {}, sessionId, 5_000).catch(
      () => {},
    );
    void forwardBrowserCommand("Network.enable", {}, sessionId, 5_000).catch(
      () => {},
    );
    void forwardBrowserCommand("Page.enable", {}, sessionId, 5_000)
      .then(() =>
        forwardBrowserCommand(
          "Page.setWebLifecycleState",
          { state: "active" },
          sessionId,
          5_000,
        ),
      )
      .catch(() => {});
  }

  async function attachAndEnableSession(targetId) {
    const attached = await forwardBrowserCommand("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    initializeSession(targetId, sessionId);
    return sessionId;
  }

  async function resolvePageSession(params = {}) {
    const urlPattern = params.targetId || params.urlPattern || params.target;
    const targets = await forwardBrowserCommand("Target.getTargets");
    const allTargets = targets.targetInfos || [];
    const pages = allTargets.filter((c) => c.type === "page");
    const qLower = String(urlPattern || "").toLowerCase();
    const isHexId = /^[0-9a-f]{8,}$/i.test(urlPattern || "");

    let target =
      allTargets.find((c) => c.targetId.toLowerCase() === qLower) ||
      (isHexId
        ? pages.find((c) => c.targetId.toLowerCase().startsWith(qLower)) ||
          allTargets.find((c) => c.targetId.toLowerCase().startsWith(qLower))
        : undefined) ||
      pages.find((c) => c.url === urlPattern);

    let ambiguousMatches = 1;
    if (!target) {
      const matcher = buildMatcher(urlPattern);
      const urlMatches = pages.filter((c) => matcher.test(c.url || ""));
      if (urlMatches.length > 0) {
        target = urlMatches[0];
        ambiguousMatches = urlMatches.length;
      } else {
        const titleMatches = pages.filter((c) => matcher.test(c.title || ""));
        if (titleMatches.length > 0) {
          target = titleMatches[0];
          ambiguousMatches = titleMatches.length;
        }
      }
    }

    if (!target) {
      throw new Error(`No page target matches ${urlPattern}`);
    }

    let sessionId = pageSessions.get(target.targetId);
    if (sessionId) {
      try {
        await forwardBrowserCommand(
          "Runtime.evaluate",
          { expression: "1", returnByValue: true },
          sessionId,
          3_000,
        );
      } catch {
        pageSessions.delete(target.targetId);
        initializedSessions.delete(sessionId);
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      sessionId = await attachAndEnableSession(target.targetId);
    } else {
      // Ensure background tab remains unfrozen on reuse
      void forwardBrowserCommand(
        "Page.setWebLifecycleState",
        { state: "active" },
        sessionId,
        3_000,
      ).catch(() => {});
    }

    const out = {
      targetId: target.targetId,
      sessionId,
      type: target.type,
      title: target.title,
      url: target.url,
    };
    if (ambiguousMatches > 1) {
      out.ambiguousMatches = ambiguousMatches;
    }
    return out;
  }

  async function handleBridgeCommand(method, params) {
    if (method === "bridge.status") {
      return publicStatus();
    }
    if (method === "bridge.page" || method === "bridge.attach") {
      return resolvePageSession(params);
    }
    if (method === "bridge.logs") {
      const sid = params.sessionId;
      const all = (sessionLogs.get(sid) || []).slice();
      if (params.clear) {
        sessionLogs.delete(sid);
      }
      const logs = params.includeAll
        ? all
        : all.filter(
            (l) =>
              l.level === "error" ||
              l.level === "warning" ||
              l.level === "warn" ||
              l.level === "exception",
          );
      return { logs };
    }
    if (method === "bridge.network") {
      const sid = params.sessionId;
      const all = (sessionNetwork.get(sid) || []).slice();
      if (params.clear) {
        sessionNetwork.delete(sid);
      }
      const requests = params.includeAll
        ? all
        : all.filter((r) => !r.ok || r.status >= 400);
      return { requests };
    }
    throw new Error(`Unknown bridge method: ${method}`);
  }

  const controlServer = net.createServer((connection) => {
    let buffer = "";

    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let request;
        try {
          request = JSON.parse(line);
        } catch (error) {
          connection.write(
            `${JSON.stringify({
              id: null,
              error: { message: `Invalid JSON request: ${error.message}` },
            })}\n`,
          );
          continue;
        }

        if (!request || typeof request.method !== "string" || !request.method) {
          connection.write(
            `${JSON.stringify({
              id: request?.id ?? null,
              error: {
                message:
                  'Invalid bridge request: missing string "method" field',
              },
            })}\n`,
          );
          continue;
        }

        void (async () => {
          try {
            let result;
            if (request.method === "bridge.shutdown") {
              result = { stopping: true };
              connection.write(
                `${JSON.stringify({ id: request.id, result })}\n`,
              );
              setImmediate(() => void shutdown());
              return;
            }

            if (request.method.startsWith("bridge.")) {
              result = await handleBridgeCommand(
                request.method,
                request.params || {},
              );
            } else {
              result = await forwardBrowserCommand(
                request.method,
                request.params || {},
                request.sessionId,
                request.timeoutMs || 60_000,
              );
            }
            connection.write(
              `${JSON.stringify({ id: request.id, result })}\n`,
            );
          } catch (error) {
            connection.write(
              `${JSON.stringify({
                id: request.id,
                error: {
                  message: error.message,
                  data: error.data,
                },
              })}\n`,
            );
          }
        })();
      }
    });
  });

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(heartbeat);
    settleReadyWaiters(new Error("CDP bridge is shutting down"));

    for (const pending of pendingBrowserCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP bridge is shutting down"));
    }
    pendingBrowserCommands.clear();

    if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.close(1000, "bridge shutdown");
    }
    await new Promise((resolve) => controlServer.close(resolve));
    cleanupRuntimeFiles();
  }

  function cleanupDeadSession(deadSid, targetId) {
    for (const [tid, sid] of pageSessions.entries()) {
      if ((deadSid && sid === deadSid) || (targetId && tid === targetId)) {
        pageSessions.delete(tid);
        initializedSessions.delete(sid);
      }
    }
    if (deadSid) {
      initializedSessions.delete(deadSid);
      sessionLogs.delete(deadSid);
      sessionNetwork.delete(deadSid);
    }
  }

  function handleBrowserEvent(message) {
    const { method, params = {}, sessionId } = message;
    if (method === "Target.detachedFromTarget") {
      cleanupDeadSession(params.sessionId || sessionId, params.targetId);
      return;
    }
    if (method === "Target.targetDestroyed") {
      const tid = params.targetId;
      const sid = pageSessions.get(tid);
      cleanupDeadSession(sid, tid);
      return;
    }

    if (!sessionId) {
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      const rawType = params.type || "log";
      const level = rawType === "warning" ? "warn" : rawType;
      const text = (params.args || [])
        .map((a) => a.value ?? a.description ?? JSON.stringify(a))
        .join(" ");
      pushRing(sessionLogs, sessionId, {
        time: new Date().toISOString(),
        level,
        text: text.slice(0, 2000),
      });
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails || {};
      pushRing(sessionLogs, sessionId, {
        time: new Date().toISOString(),
        level: "exception",
        text: (
          details.exception?.description ||
          details.text ||
          "Uncaught exception"
        ).slice(0, 2000),
      });
    } else if (method === "Log.entryAdded" && params.entry) {
      pushRing(sessionLogs, sessionId, {
        time: new Date().toISOString(),
        level:
          params.entry.level === "warning"
            ? "warn"
            : params.entry.level || "info",
        text: String(params.entry.text || "").slice(0, 2000),
        url: params.entry.url,
      });
    } else if (method === "Network.requestWillBeSent") {
      pendingNetworkRequests.set(`${sessionId}:${params.requestId}`, {
        url: params.request?.url,
        method: params.request?.method,
        type: (params.type || "other").toLowerCase(),
        startTime: Date.now(),
      });
      if (pendingNetworkRequests.size > 2000) {
        const oldestKey = pendingNetworkRequests.keys().next().value;
        pendingNetworkRequests.delete(oldestKey);
      }
    } else if (method === "Network.responseReceived") {
      const reqKey = `${sessionId}:${params.requestId}`;
      const req = pendingNetworkRequests.get(reqKey);
      pendingNetworkRequests.delete(reqKey);
      const status = params.response?.status || 0;
      const entry = {
        time: new Date().toISOString(),
        type: (params.type || req?.type || "other").toLowerCase(),
        method: req?.method || "GET",
        url: params.response?.url || req?.url,
        status,
        ok: status >= 200 && status < 400,
        durationMs: req?.startTime ? Date.now() - req.startTime : undefined,
      };
      pushRing(sessionNetwork, sessionId, entry);
      if (status >= 400 && params.requestId) {
        failedBodyCandidates.set(reqKey, entry);
        if (failedBodyCandidates.size > 200) {
          const oldestKey = failedBodyCandidates.keys().next().value;
          failedBodyCandidates.delete(oldestKey);
        }
      }
    } else if (method === "Network.loadingFinished") {
      const reqKey = `${sessionId}:${params.requestId}`;
      const failedEntry = failedBodyCandidates.get(reqKey);
      if (failedEntry) {
        failedBodyCandidates.delete(reqKey);
        void forwardBrowserCommand(
          "Network.getResponseBody",
          { requestId: params.requestId },
          sessionId,
          3_000,
        )
          .then((res) => {
            if (res?.body) {
              const text = res.base64Encoded
                ? Buffer.from(res.body, "base64").toString("utf8")
                : String(res.body);
              failedEntry.responseBody = text.slice(0, 1000);
            }
          })
          .catch(() => {});
      }
    } else if (method === "Network.loadingFailed") {
      const reqKey = `${sessionId}:${params.requestId}`;
      const req = pendingNetworkRequests.get(reqKey);
      pendingNetworkRequests.delete(reqKey);
      failedBodyCandidates.delete(reqKey);
      pushRing(sessionNetwork, sessionId, {
        time: new Date().toISOString(),
        type: (params.type || req?.type || "other").toLowerCase(),
        method: req?.method || "GET",
        url: req?.url,
        status: 0,
        ok: false,
        error: params.errorText || "Loading failed",
        durationMs: req?.startTime ? Date.now() - req.startTime : undefined,
      });
    }
  }

  async function connectToBrowser() {
    const websocketUrl = await readBrowserWebsocketUrl();
    browserWebsocketUrl = websocketUrl;
    handshakeCount += 1;
    browserSocket = new WebSocket(websocketUrl);

    browserSocket.addEventListener("open", () => {
      browserState = "ready";
      browserError = "";
      connectedAt = new Date().toISOString();
      lastActivityAt = connectedAt;
      settleReadyWaiters(null);
      console.log(`[${lastActivityAt}] browser websocket ready (${websocketUrl})`);
    });

    browserSocket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error(`Ignoring invalid browser message: ${error.message}`);
        return;
      }

      lastActivityAt = new Date().toISOString();
      if (!message.id) {
        handleBrowserEvent(message);
        return;
      }

      const pending = pendingBrowserCommands.get(message.id);
      if (!pending) {
        return;
      }
      pendingBrowserCommands.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        if (
          pending.sessionId &&
          message.error.message &&
          (message.error.message.includes("Session with given id not found") ||
            message.error.message.includes("Target closed"))
        ) {
          cleanupDeadSession(pending.sessionId, null);
        }
        const error = new Error(message.error.message || "CDP command failed");
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
    });

    browserSocket.addEventListener("error", (event) => {
      browserError = event.message || "Browser WebSocket error";
      console.error(browserError);
    });

    browserSocket.addEventListener("close", (event) => {
      browserState = "disconnected";
      browserError = event.reason || `WebSocket closed with code ${event.code}`;
      settleReadyWaiters(new Error(browserError));
      for (const pending of pendingBrowserCommands.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(browserError));
      }
      pendingBrowserCommands.clear();
      pageSessions.clear();
      initializedSessions.clear();
      sessionLogs.clear();
      sessionNetwork.clear();
      pendingNetworkRequests.clear();
      failedBodyCandidates.clear();
      console.error(`[${new Date().toISOString()}] ${browserError}`);
      if (!shuttingDown) {
        void shutdown().finally(() => process.exit(1));
      }
    });
  }

  const heartbeat = setInterval(() => {
    if (browserSocket?.readyState !== WebSocket.OPEN) {
      return;
    }
    forwardBrowserCommand("Browser.getVersion", {}, undefined, 10_000).catch(
      (error) => {
        console.error(`CDP heartbeat failed: ${error.message}`);
      },
    );
  }, 30_000);

  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(socketPath, resolve);
  });
  if (!isNamedPipe) {
    fs.chmodSync(socketPath, 0o600);
  }
  console.log(
    `[${new Date().toISOString()}] control socket ready at ${socketPath}`,
  );

  try {
    await connectToBrowser();
  } catch (error) {
    browserState = "disconnected";
    browserError = error.message;
    settleReadyWaiters(error);
    console.error(error.stack || error.message);
  }
}

const BRIDGE_USAGE = `Usage: cdp-bridge <command> [options]

Commands:
  start [host:port | ws-url]     Start CDP bridge daemon and wait until ready
  restart [host:port | ws-url]   Restart CDP bridge daemon (alias: connect)
  status                         Show bridge status
  stop                           Stop running bridge daemon
  pages | list | tabs | targets  List browser targets

Connection Options (for start / restart / connect):
  --host, -H <ip>                Browser debugging host IP (default: 127.0.0.1, env: CDP_HOST)
  --port, -p <port>              Browser debugging port (queries /json/version or DevToolsActivePort, env: CDP_PORT)
  --ws-url, --url, -u <ws-url>   Explicit browser WebSocket URL (env: CDP_WS_URL)
  --port-file <path>             Path to DevToolsActivePort file (env: CDP_PORT_FILE)
  --socket <path>                Custom control Unix socket or Named Pipe (env: CDP_BRIDGE_SOCKET)
  --wait-ms, --timeout <ms>      Max wait for browser WebSocket ready state (default: 15000)
  --no-wait                      Return as soon as control socket starts without waiting for WebSocket ready`;

try {
  if (command === "serve") {
    await serveBridge();
  } else if (command === "start") {
    await startBridge({ forceRestart: false });
  } else if (command === "restart" || command === "connect") {
    await startBridge({ forceRestart: true });
  } else if (command === "status") {
    console.log(
      JSON.stringify(
        await requestBridge({ id: 1, method: "bridge.status" }),
        null,
        2,
      ),
    );
  } else if (command === "stop") {
    console.log(
      JSON.stringify(
        await requestBridge({ id: 1, method: "bridge.shutdown" }),
        null,
        2,
      ),
    );
  } else if (
    command === "tabs" ||
    command === "pages" ||
    command === "list" ||
    command === "list-pages" ||
    command === "targets" ||
    command === "list-targets"
  ) {
    const raw = await requestBridge({ id: 1, method: "Target.getTargets" });
    const isRawTargets = command === "targets" || command === "list-targets";
    const pages = (raw.targetInfos || []).filter((t) =>
      isRawTargets ? true : t.type === "page",
    );
    console.log(
      JSON.stringify(
        isRawTargets ? raw : { count: pages.length, pages },
        null,
        2,
      ),
    );
  } else if (command === "help" || command === "--help" || command === "-h") {
    console.log(BRIDGE_USAGE);
  } else {
    throw new Error(
      `Unknown cdp-bridge command: ${command} (for page/CDP commands like "${command}", use \`cdp ${command} ...\` instead).\n\n${BRIDGE_USAGE}`,
    );
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
