#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import { CURSOR_HELPER_SOURCE } from "./cursor.mjs";
import { trySpawnWindowsWmiBreakaway } from "./win-spawn.mjs";

process.stdout?.setDefaultEncoding?.("utf8");
process.stderr?.setDefaultEncoding?.("utf8");

const scriptPath = fileURLToPath(import.meta.url);
const command = process.argv[2] || "status";
const rawCmdArgs = process.argv.slice(3);

function parseConnectionArgs(args) {
  let host = process.env.CDP_HOST || "";
  let port = process.env.CDP_PORT || "";
  let wsUrl = process.env.CDP_WS_URL || "";
  let portFile = process.env.CDP_PORT_FILE || "";
  let logFile = "";
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
    } else if (arg === "--log-file" && i + 1 < args.length) {
      logFile = args[++i];
    } else if (arg.startsWith("--log-file=")) {
      logFile = arg.slice("--log-file=".length);
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

  return { host, port, wsUrl, portFile, logFile, waitMs, noWait, explicit };
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
function resolveNamedPipeStateDir(pipePath, fallbackDir) {
  if (process.env.CDP_BRIDGE_STATE_DIR) {
    return path.resolve(process.env.CDP_BRIDGE_STATE_DIR);
  }
  const rawLeaf = String(pipePath || "")
    .replace(/^\\\\[.?]\\pipe\\/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return rawLeaf ? path.join(os.tmpdir(), rawLeaf) : fallbackDir;
}

const stateDir = isNamedPipe
  ? resolveNamedPipeStateDir(socketPath, runtimeDir)
  : path.dirname(socketPath);
const pidPath = isNamedPipe
  ? path.join(stateDir, "bridge.pid")
  : `${socketPath}.pid`;
const logPath = isNamedPipe
  ? connArgs.logFile || path.join(stateDir, "bridge.log")
  : connArgs.logFile || `${socketPath}.log`;
const preferredTargetPath = path.join(stateDir, "preferred-target.json");
const startLockPath = path.join(stateDir, "start.lock");
const clientSessionsPath = path.join(stateDir, "client-sessions.json");

function clearClientSessionsCache() {
  try {
    fs.unlinkSync(clientSessionsPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Ignore transient cache cleanup errors
    }
  }
}

function loadPreferredTarget() {
  try {
    if (!fs.existsSync(preferredTargetPath)) return null;
    const data = JSON.parse(fs.readFileSync(preferredTargetPath, "utf8"));
    if (
      data &&
      typeof data === "object" &&
      (data.wsUrl || data.port || data.portFile)
    ) {
      return data;
    }
  } catch {
    // Ignore corrupted preferred-target file
  }
  return null;
}

function savePreferredTarget({
  wsUrl = "",
  host = "",
  port = "",
  portFile = "",
} = {}) {
  try {
    let resolvedHost = host;
    let resolvedPort = port ? String(port) : "";
    if (wsUrl) {
      try {
        const parsed = new URL(wsUrl);
        resolvedHost = resolvedHost || parsed.hostname || "127.0.0.1";
        resolvedPort = resolvedPort || parsed.port || "";
      } catch {
        // Keep explicit host/port if URL parse fails
      }
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      preferredTargetPath,
      JSON.stringify(
        {
          wsUrl,
          host: resolvedHost || "127.0.0.1",
          port: resolvedPort,
          portFile: portFile ? path.resolve(portFile) : "",
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    // Ignore transient state write errors
  }
}

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

  if (process.env.CDP_DEVTOOLS_SEARCH_ROOT) {
    const customRoot = path.resolve(process.env.CDP_DEVTOOLS_SEARCH_ROOT);
    for (const rel of winBrowserRelPaths) {
      candidates.push(path.join(customRoot, rel));
    }
    candidates.push(
      path.join(customRoot, ".config/google-chrome/DevToolsActivePort"),
      path.join(customRoot, ".config/microsoft-edge/DevToolsActivePort"),
      path.join(customRoot, ".config/chromium/DevToolsActivePort"),
      path.join(
        customRoot,
        ".config/BraveSoftware/Brave-Browser/DevToolsActivePort",
      ),
      path.join(customRoot, "DevToolsActivePort"),
    );
  } else if (isWindows) {
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

async function resolveLiveEndpointFromWsUrl(
  wsUrl,
  fallbackHost = "127.0.0.1",
  candidates = null,
) {
  if (!wsUrl) return "";
  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return "";
  }
  const host = parsed.hostname || fallbackHost;
  const port = parsed.port;
  if (!port || !(await probeTcpPort(host, port, 800))) {
    return "";
  }
  try {
    return await fetchDebuggerWebsocketUrl(host, port, 800);
  } catch {
    // chrome://inspect ports do not expose HTTP /json/version; check DevToolsActivePort or reuse wsUrl
  }
  const activeFiles = candidates || findDevToolsActivePortCandidates();
  for (const candidate of activeFiles) {
    try {
      const rec = parseActivePortRecord(candidate);
      if (String(rec.port) === String(port)) {
        return `ws://${formatHostForUrl(host)}:${rec.port}${rec.websocketPath}`;
      }
    } catch {
      continue;
    }
  }
  return wsUrl;
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

  // Honor sticky user-selected browser target (from prior `cdp connect`) while its port remains open,
  // preventing unintended browser flip-flopping when Chrome and Edge both have DevToolsActivePort files.
  const preferred = options.ignorePreferred ? null : loadPreferredTarget();
  if (preferred) {
    const prefHost = options.host || preferred.host || targetHost;
    if (preferred.portFile) {
      try {
        const rec = parseActivePortRecord(preferred.portFile);
        if (await probeTcpPort(prefHost, rec.port, 800)) {
          return `ws://${formatHostForUrl(prefHost)}:${rec.port}${rec.websocketPath}`;
        }
      } catch {
        // Fall through to wsUrl/port check
      }
    }
    if (preferred.wsUrl) {
      const livePref = await resolveLiveEndpointFromWsUrl(
        preferred.wsUrl,
        prefHost,
        candidates,
      );
      if (livePref) {
        return livePref;
      }
    } else if (preferred.port && (await probeTcpPort(prefHost, preferred.port, 800))) {
      try {
        return await fetchDebuggerWebsocketUrl(prefHost, preferred.port, 800);
      } catch {
        for (const candidate of candidates) {
          try {
            const rec = parseActivePortRecord(candidate);
            if (String(rec.port) === String(preferred.port)) {
              return `ws://${formatHostForUrl(prefHost)}:${rec.port}${rec.websocketPath}`;
            }
          } catch {
            continue;
          }
        }
      }
    }
  }

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

async function acquireStartLock(maxWaitMs = 8_000) {
  fs.mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(startLockPath, "wx");
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
      );
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") {
        return false;
      }
      try {
        const raw = fs.readFileSync(startLockPath, "utf8").trim();
        const info = raw ? JSON.parse(raw) : {};
        const ageMs = Date.now() - (Number(info.createdAtMs) || 0);
        const ownerAlive =
          Number.isInteger(info.pid) && isProcessRunning(info.pid);
        if (!ownerAlive || ageMs > 10_000) {
          fs.unlinkSync(startLockPath);
          continue;
        }
      } catch {
        // Lock file may have just been removed; retry
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  return false;
}

function releaseStartLock() {
  try {
    const raw = fs.readFileSync(startLockPath, "utf8").trim();
    const info = raw ? JSON.parse(raw) : {};
    if (!info.pid || info.pid === process.pid) {
      fs.unlinkSync(startLockPath);
    }
  } catch {
    // Ignore if already removed
  }
}

async function startBridge({ forceRestart = false } = {}) {
  let resolvedWsUrl = "";
  if (connArgs.explicit) {
    resolvedWsUrl = await readBrowserWebsocketUrl(connArgs);
    savePreferredTarget({
      wsUrl: resolvedWsUrl,
      host: connArgs.host,
      port: connArgs.port,
      portFile: connArgs.portFile,
    });
  }

  let lastStatus = null;
  let reusedRunningDaemon = false;

  await acquireStartLock();
  try {
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
      if (!forceRestart && sameTarget && status.browserState === "connecting") {
        lastStatus = status;
        reusedRunningDaemon = true;
      } else {
        await stopRunningBridge();
        clearClientSessionsCache();
      }
    } catch {
      removeStaleRuntimeFiles();
    }

    if (!reusedRunningDaemon) {
      // On bare restart/start without explicit args, prefer the previous live endpoint (if still open)
      // or sticky preferred-target.json before blind mtime scan across browsers.
      if (!resolvedWsUrl && !connArgs.explicit) {
        if (previousWsUrl) {
          resolvedWsUrl = await resolveLiveEndpointFromWsUrl(
            previousWsUrl,
            connArgs.host || "127.0.0.1",
          );
        }
        if (!resolvedWsUrl) {
          resolvedWsUrl = await readBrowserWebsocketUrl(connArgs);
        }
      }

      clearClientSessionsCache();

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

      const serveArgs = [scriptPath, "serve"];
      if (isWindows) {
        serveArgs.push("--log-file", logPath, "--socket", socketPath);
        if (resolvedWsUrl) serveArgs.push("--ws-url", resolvedWsUrl);
        if (connArgs.host) serveArgs.push("--host", connArgs.host);
        if (connArgs.port) serveArgs.push("--port", String(connArgs.port));
        if (connArgs.portFile) serveArgs.push("--port-file", connArgs.portFile);
      }

      const wmiSpawned = isWindows
        ? trySpawnWindowsWmiBreakaway(
            process.execPath,
            serveArgs,
            stateDir,
            childEnv,
          )
        : { ok: false };

      if (!wmiSpawned.ok) {
        const logFd = fs.openSync(logPath, "a");
        const child = spawn(process.execPath, [scriptPath, "serve"], {
          detached: true,
          env: childEnv,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        });
        child.unref();
        fs.closeSync(logFd);
      }

      const socketDeadline = Date.now() + 5_000;
      while (Date.now() < socketDeadline) {
        try {
          lastStatus = await requestBridge(
            { id: 1, method: "bridge.status" },
            1_000,
          );
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }

      if (!lastStatus) {
        throw new Error(
          `CDP bridge did not create ${socketPath}; see ${logPath}`,
        );
      }
    }
  } finally {
    releaseStartLock();
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

  if (connArgs.logFile) {
    const targetLogFile = path.resolve(connArgs.logFile);
    fs.mkdirSync(path.dirname(targetLogFile), { recursive: true });
    const appendLine = (...items) => {
      try {
        fs.appendFileSync(targetLogFile, `${util.format(...items)}\n`, "utf8");
      } catch {
        // Ignore transient log file write errors
      }
    };
    console.log = appendLine;
    console.error = appendLine;
  }

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
  let browserWebsocketUrl = connArgs.wsUrl || process.env.CDP_WS_URL || "";
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
  const recordingsByTarget = new Map();
  const recordingsBySession = new Map();
  const activeRecordingsPath = path.join(stateDir, "active-recordings.json");
  const MAX_RING_BUFFER = 300;

  function syncActiveRecordingsFile() {
    try {
      if (recordingsByTarget.size === 0) {
        fs.unlinkSync(activeRecordingsPath);
        return;
      }
      const snapshot = {};
      for (const [tid, rec] of recordingsByTarget.entries()) {
        snapshot[tid] = {
          recordingId: rec.recordingId,
          startedAtMs: rec.startedAtMs,
          outputPath: rec.outputPath,
          paused: Boolean(rec.paused),
        };
      }
      fs.writeFileSync(activeRecordingsPath, JSON.stringify(snapshot, null, 2));
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Ignore transient state file write errors
      }
    }
  }

  function formatWaitDurationLabel(ms) {
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  async function syncRecordingOverlayInPage(rec, hudConfig = {}) {
    if (!rec || !rec.showHud || !rec.sessionId) return;
    const state = hudConfig.state || "off";
    const elapsedBaseMs = Math.max(0, Math.round(hudConfig.elapsedBaseMs || 0));
    const label = hudConfig.label || rec.label || "";
    const toastText = hudConfig.toastText || "";

    if (rec.hudScriptIdentifier) {
      await forwardBrowserCommand(
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier: rec.hudScriptIdentifier },
        rec.sessionId,
        2_000,
      ).catch(() => {});
      rec.hudScriptIdentifier = null;
    }

    if (state === "rec" || state === "paused") {
      const bootRegisteredAt = Date.now();
      const newDocScript = `(() => {
        const mount = () => {
          try {
            const elapsed = ${state === "rec" ? `${elapsedBaseMs} + Math.max(0, Date.now() - ${bootRegisteredAt})` : `${elapsedBaseMs}`};
            (${CURSOR_HELPER_SOURCE}).setRecordingHud({
              state: ${JSON.stringify(state)},
              elapsedBaseMs: elapsed,
              label: ${JSON.stringify(label)}
            });
          } catch {}
        };
        if (document.documentElement) mount();
        else window.addEventListener("DOMContentLoaded", mount, { once: true });
      })();`;
      const added = await forwardBrowserCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: newDocScript },
        rec.sessionId,
        2_500,
      ).catch(() => null);
      if (added?.identifier) {
        rec.hudScriptIdentifier = added.identifier;
      }
    }

    const evalExpr = `(() => {
      try {
        const helper = (${CURSOR_HELPER_SOURCE});
        helper.setRecordingHud({
          state: ${JSON.stringify(state)},
          elapsedBaseMs: ${elapsedBaseMs},
          label: ${JSON.stringify(label)}
        });
        if (${JSON.stringify(Boolean(toastText))}) {
          helper.showRecordingToast(${JSON.stringify(toastText)}, 2200);
        }
      } catch {}
      return true;
    })()`;

    await forwardBrowserCommand(
      "Runtime.evaluate",
      { expression: evalExpr, returnByValue: true },
      rec.sessionId,
      2_500,
    ).catch(() => {});
  }

  function appendScreencastFrame(rec, base64Data, metadata = {}, allowWhenPaused = false) {
    if (
      !rec ||
      rec.stopping ||
      (rec.paused && !allowWhenPaused) ||
      !base64Data ||
      rec.frames.length >= rec.maxFrames
    ) {
      return;
    }
    const nowMs = Date.now();
    const effectivePauseMs =
      rec.pausedTotalMs + (rec.paused && rec.pausedAtMs ? Math.max(0, nowMs - rec.pausedAtMs) : 0);
    const effectiveTimeMs = Math.max(0, nowMs - rec.startedAtMs - effectivePauseMs);
    const idx = rec.nextFrameIndex++;
    const fileName = `frame-${String(idx).padStart(5, "0")}.jpg`;
    const filePath = path.join(rec.spoolDir, fileName);
    const buf = Buffer.from(base64Data, "base64");
    rec.frames.push({
      index: idx,
      file: filePath,
      bytes: buf.length,
      wallTimeMs: nowMs,
      effectiveTimeMs,
      deviceWidth: metadata.deviceWidth || 0,
      deviceHeight: metadata.deviceHeight || 0,
    });
    rec.totalBytes += buf.length;
    const writeTask = fs.promises.writeFile(filePath, buf).catch(() => {});
    rec.pendingWrites.add(writeTask);
    void writeTask.finally(() => rec.pendingWrites.delete(writeTask));
  }

  function findActiveRecording(targetQuery) {
    if (!targetQuery) {
      if (recordingsByTarget.size === 1) {
        return recordingsByTarget.values().next().value;
      }
      if (recordingsByTarget.size === 0) {
        throw new Error("No active screen recording session is currently running.");
      }
      const activeIds = Array.from(recordingsByTarget.keys())
        .map((id) => id.slice(0, 8))
        .join(", ");
      throw new Error(
        `Multiple recordings are active (${activeIds}); specify <target> to select one.`,
      );
    }
    const qLower = String(targetQuery).toLowerCase();
    for (const [tid, rec] of recordingsByTarget.entries()) {
      if (
        tid.toLowerCase() === qLower ||
        tid.toLowerCase().startsWith(qLower) ||
        rec.recordingId.toLowerCase() === qLower ||
        (rec.url && rec.url.toLowerCase().includes(qLower)) ||
        (rec.title && rec.title.toLowerCase().includes(qLower))
      ) {
        return rec;
      }
    }
    throw new Error(`No active recording matches "${targetQuery}".`);
  }

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
      activeRecordings: recordingsByTarget.size,
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
    if (method === "bridge.record.status") {
      const now = Date.now();
      const list = Array.from(recordingsByTarget.values()).map((rec) => {
        const curPausedMs =
          rec.pausedTotalMs + (rec.paused && rec.pausedAtMs ? Math.max(0, now - rec.pausedAtMs) : 0);
        return {
          recordingId: rec.recordingId,
          targetId: rec.targetId,
          title: rec.title,
          url: rec.url,
          outputPath: rec.outputPath,
          hud: rec.showHud,
          paused: rec.paused,
          pauseCount: rec.pauseCount,
          pausedTotalMs: curPausedMs,
          startedAt: new Date(rec.startedAtMs).toISOString(),
          elapsedMs: Math.max(0, now - rec.startedAtMs - curPausedMs),
          wallElapsedMs: now - rec.startedAtMs,
          capturedFrames: rec.frames.length,
          totalBytes: rec.totalBytes,
          autoStopped: rec.autoStopped,
        };
      });
      return { count: list.length, recordings: list };
    }
    if (method === "bridge.record.start") {
      const page = await resolvePageSession(params);
      if (recordingsByTarget.has(page.targetId)) {
        throw new Error(
          `A screen recording is already running on target ${page.targetId.slice(0, 8)}. Stop or cancel it first.`,
        );
      }
      const recordingId = `rec-${Date.now()}-${page.targetId.slice(0, 8).toLowerCase()}`;
      const spoolDir = path.join(stateDir, "recordings", recordingId);
      fs.mkdirSync(spoolDir, { recursive: true });

      const quality = Math.max(10, Math.min(100, Number(params.quality) || 92));
      const maxWidth = Math.max(64, Number(params.maxWidth) || 2560);
      const maxHeight = Math.max(64, Number(params.maxHeight) || 1440);
      const everyNthFrame = Math.max(1, Number(params.everyNthFrame) || 1);
      const maxDurationMs = Math.max(
        1_000,
        Math.min(600_000, Number(params.maxDurationMs) || 180_000),
      );
      const maxFrames = Math.max(10, Math.min(10_000, Number(params.maxFrames) || 3600));
      const envHudOff = /^(0|false|off|none|no|hide)$/i.test(
        String(process.env.CDP_RECORD_HUD ?? process.env.CDP_HUD ?? "").trim(),
      );
      const envBadgeOff = /^(0|false|off|none|no|hide)$/i.test(
        String(process.env.CDP_RECORD_BADGE ?? "").trim(),
      );
      const showHud = params.hud !== undefined ? Boolean(params.hud) : !envHudOff;
      const showBadge =
        showHud && (params.badge !== undefined ? Boolean(params.badge) : !envBadgeOff);
      const label = params.label ? String(params.label) : "";

      const rec = {
        recordingId,
        targetId: page.targetId,
        sessionId: page.sessionId,
        title: page.title,
        url: page.url,
        outputPath: params.outputPath || "",
        spoolDir,
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame,
        maxDurationMs,
        remainingMaxMs: maxDurationMs,
        maxFrames,
        showHud,
        showBadge,
        label,
        hudScriptIdentifier: null,
        startedAtMs: Date.now(),
        paused: false,
        pausedAtMs: 0,
        pausedTotalMs: 0,
        pauseCount: 0,
        nextFrameIndex: 0,
        totalBytes: 0,
        frames: [],
        pendingWrites: new Set(),
        stopping: false,
        autoStopped: false,
        maxTimer: null,
        resumeFollowTimer: null,
      };

      const armMaxTimer = (ms) => {
        if (rec.maxTimer) clearTimeout(rec.maxTimer);
        rec.maxTimer = setTimeout(() => {
          rec.autoStopped = true;
          rec.stopping = true;
          void forwardBrowserCommand("Page.stopScreencast", {}, rec.sessionId, 5_000).catch(
            () => {},
          );
          void syncRecordingOverlayInPage(rec, { state: "off" });
        }, ms);
        rec.maxTimer.unref?.();
      };
      rec.armMaxTimer = armMaxTimer;

      recordingsByTarget.set(page.targetId, rec);
      recordingsBySession.set(page.sessionId, rec);
      syncActiveRecordingsFile();

      try {
        if (params.focus !== false) {
          await forwardBrowserCommand("Page.bringToFront", {}, page.sessionId, 5_000).catch(
            () => {},
          );
        }
        await forwardBrowserCommand("Page.enable", {}, page.sessionId, 5_000);
        await forwardBrowserCommand(
          "Page.setWebLifecycleState",
          { state: "active" },
          page.sessionId,
          5_000,
        ).catch(() => {});

        if (showHud) {
          await syncRecordingOverlayInPage(rec, {
            state: "rec",
            elapsedBaseMs: 0,
            label,
            toastText: showBadge ? "● 开始录制验收画面" : "",
          });
        }

        await forwardBrowserCommand(
          "Page.startScreencast",
          {
            format: "jpeg",
            quality,
            maxWidth,
            maxHeight,
            everyNthFrame,
          },
          page.sessionId,
          10_000,
        );

        // Wait briefly for initial compositor frame; capture one explicitly if page is static
        await new Promise((resolve) => setTimeout(resolve, 140));
        if (rec.frames.length === 0 && !rec.stopping) {
          const initialShot = await forwardBrowserCommand(
            "Page.captureScreenshot",
            { format: "jpeg", quality },
            page.sessionId,
            5_000,
          ).catch(() => null);
          if (initialShot?.data) {
            appendScreencastFrame(rec, initialShot.data);
          }
        }
      } catch (err) {
        await syncRecordingOverlayInPage(rec, { state: "off" });
        recordingsByTarget.delete(page.targetId);
        recordingsBySession.delete(page.sessionId);
        syncActiveRecordingsFile();
        try {
          fs.rmSync(spoolDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }

      armMaxTimer(maxDurationMs);

      return {
        recording: true,
        recordingId,
        targetId: page.targetId,
        title: page.title,
        url: page.url,
        outputPath: rec.outputPath,
        startedAt: new Date(rec.startedAtMs).toISOString(),
        quality,
        maxWidth,
        maxHeight,
        maxDurationMs,
        hud: showHud,
      };
    }
    if (method === "bridge.record.pause") {
      const rec = findActiveRecording(params.targetId || params.target);
      if (rec.paused) {
        return {
          paused: true,
          alreadyPaused: true,
          recordingId: rec.recordingId,
          targetId: rec.targetId,
          capturedFrames: rec.frames.length,
        };
      }
      if (rec.maxTimer) {
        clearTimeout(rec.maxTimer);
        rec.maxTimer = null;
      }
      if (rec.resumeFollowTimer) {
        clearTimeout(rec.resumeFollowTimer);
        rec.resumeFollowTimer = null;
      }

      const prePauseShot = await forwardBrowserCommand(
        "Page.captureScreenshot",
        { format: "jpeg", quality: rec.quality },
        rec.sessionId,
        4_000,
      ).catch(() => null);
      if (prePauseShot?.data) {
        appendScreencastFrame(rec, prePauseShot.data);
      }

      const now = Date.now();
      const activeElapsedMs = Math.max(0, now - rec.startedAtMs - rec.pausedTotalMs);
      rec.remainingMaxMs = Math.max(5_000, rec.maxDurationMs - activeElapsedMs);
      rec.paused = true;
      rec.pausedAtMs = now;
      syncActiveRecordingsFile();

      await forwardBrowserCommand("Page.stopScreencast", {}, rec.sessionId, 5_000).catch(
        () => {},
      );
      if (params.hud === false && rec.showHud) {
        await syncRecordingOverlayInPage(rec, { state: "off" });
        rec.showHud = false;
        rec.showBadge = false;
      } else {
        await syncRecordingOverlayInPage(rec, {
          state: "paused",
          elapsedBaseMs: activeElapsedMs,
          label: rec.label,
          toastText:
            rec.showHud && rec.showBadge && params.badge !== false
              ? "⏸ 录制已暂停 · 等待中不占存储"
              : "",
        });
      }

      return {
        paused: true,
        recordingId: rec.recordingId,
        targetId: rec.targetId,
        activeElapsedMs,
        capturedFrames: rec.frames.length,
      };
    }
    if (method === "bridge.record.resume") {
      const rec = findActiveRecording(params.targetId || params.target);
      if (!rec.paused) {
        return {
          recording: true,
          resumed: false,
          alreadyRunning: true,
          recordingId: rec.recordingId,
          targetId: rec.targetId,
          capturedFrames: rec.frames.length,
        };
      }
      const now = Date.now();
      const skippedMs = Math.max(0, now - rec.pausedAtMs);
      rec.pausedTotalMs += skippedMs;
      rec.paused = false;
      rec.pausedAtMs = 0;
      rec.pauseCount += 1;
      const activeElapsedMs = Math.max(0, now - rec.startedAtMs - rec.pausedTotalMs);
      syncActiveRecordingsFile();

      if (params.focus) {
        await forwardBrowserCommand("Page.bringToFront", {}, rec.sessionId, 4_000).catch(
          () => {},
        );
      }
      await forwardBrowserCommand(
        "Page.setWebLifecycleState",
        { state: "active" },
        rec.sessionId,
        4_000,
      ).catch(() => {});

      if (params.hud === false && rec.showHud) {
        await syncRecordingOverlayInPage(rec, { state: "off" });
        rec.showHud = false;
        rec.showBadge = false;
      }

      const skipToast =
        !rec.showHud || !rec.showBadge || params.badge === false
          ? ""
          : params.toastText
            ? String(params.toastText)
            : `⏭ 已跳过 ${formatWaitDurationLabel(skippedMs)} 等待`;

      await syncRecordingOverlayInPage(rec, {
        state: "rec",
        elapsedBaseMs: activeElapsedMs,
        label: rec.label,
        toastText: skipToast,
      });

      await forwardBrowserCommand(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: rec.quality,
          maxWidth: rec.maxWidth,
          maxHeight: rec.maxHeight,
          everyNthFrame: rec.everyNthFrame,
        },
        rec.sessionId,
        10_000,
      );

      const countBeforeResume = rec.frames.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (!rec.stopping && !rec.paused && rec.frames.length === countBeforeResume) {
        const resumeShot = await forwardBrowserCommand(
          "Page.captureScreenshot",
          { format: "jpeg", quality: rec.quality },
          rec.sessionId,
          4_000,
        ).catch(() => null);
        if (resumeShot?.data) {
          appendScreencastFrame(rec, resumeShot.data);
        }
      }
      rec.resumeFollowTimer = setTimeout(() => {
        if (!rec.stopping && !rec.paused) {
          void forwardBrowserCommand(
            "Page.captureScreenshot",
            { format: "jpeg", quality: rec.quality },
            rec.sessionId,
            3_000,
          )
            .then((shot) => {
              if (shot?.data) appendScreencastFrame(rec, shot.data);
            })
            .catch(() => {});
        }
      }, 420);
      rec.resumeFollowTimer.unref?.();

      rec.armMaxTimer?.(rec.remainingMaxMs);

      return {
        recording: true,
        resumed: true,
        recordingId: rec.recordingId,
        targetId: rec.targetId,
        skippedMs,
        pausedTotalMs: rec.pausedTotalMs,
        pauseCount: rec.pauseCount,
        activeElapsedMs,
        capturedFrames: rec.frames.length,
      };
    }
    if (method === "bridge.record.stop") {
      const rec = findActiveRecording(params.targetId || params.target);
      if (rec.maxTimer) clearTimeout(rec.maxTimer);
      if (rec.resumeFollowTimer) clearTimeout(rec.resumeFollowTimer);

      const wasPaused = rec.paused;
      if (rec.paused && rec.pausedAtMs) {
        rec.pausedTotalMs += Math.max(0, Date.now() - rec.pausedAtMs);
        rec.paused = false;
        rec.pausedAtMs = 0;
      }

      // Capture final frame while HUD is still in REC state (unless stopped directly from paused state)
      if (!rec.autoStopped && !wasPaused) {
        const finalShot = await forwardBrowserCommand(
          "Page.captureScreenshot",
          { format: "jpeg", quality: rec.quality },
          rec.sessionId,
          4_000,
        ).catch(() => null);
        if (finalShot?.data) {
          appendScreencastFrame(rec, finalShot.data);
        }
      }

      rec.stopping = true;
      await forwardBrowserCommand("Page.stopScreencast", {}, rec.sessionId, 5_000).catch(
        () => {},
      );
      await syncRecordingOverlayInPage(rec, { state: "off" });
      await Promise.allSettled(Array.from(rec.pendingWrites));

      const stoppedAtMs = Date.now();
      recordingsByTarget.delete(rec.targetId);
      recordingsBySession.delete(rec.sessionId);
      syncActiveRecordingsFile();

      return {
        recordingId: rec.recordingId,
        targetId: rec.targetId,
        title: rec.title,
        url: rec.url,
        outputPath: rec.outputPath,
        spoolDir: rec.spoolDir,
        startedAtMs: rec.startedAtMs,
        stoppedAtMs,
        pausedTotalMs: rec.pausedTotalMs,
        pauseCount: rec.pauseCount,
        frames: rec.frames,
      };
    }
    if (method === "bridge.record.cancel") {
      const rec = findActiveRecording(params.targetId || params.target);
      rec.stopping = true;
      if (rec.maxTimer) clearTimeout(rec.maxTimer);
      if (rec.resumeFollowTimer) clearTimeout(rec.resumeFollowTimer);
      await forwardBrowserCommand("Page.stopScreencast", {}, rec.sessionId, 5_000).catch(
        () => {},
      );
      await syncRecordingOverlayInPage(rec, { state: "off" });
      await Promise.allSettled(Array.from(rec.pendingWrites));
      recordingsByTarget.delete(rec.targetId);
      recordingsBySession.delete(rec.sessionId);
      syncActiveRecordingsFile();
      try {
        fs.rmSync(rec.spoolDir, { recursive: true, force: true });
      } catch {}
      return {
        cancelled: true,
        recordingId: rec.recordingId,
        targetId: rec.targetId,
        discardedFrames: rec.frames.length,
      };
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

    for (const rec of recordingsByTarget.values()) {
      rec.stopping = true;
      if (rec.maxTimer) clearTimeout(rec.maxTimer);
      try {
        fs.rmSync(rec.spoolDir, { recursive: true, force: true });
      } catch {}
    }
    recordingsByTarget.clear();
    recordingsBySession.clear();
    syncActiveRecordingsFile();

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
    if (deadSid && recordingsBySession.has(deadSid)) {
      const rec = recordingsBySession.get(deadSid);
      rec.stopping = true;
      if (rec.maxTimer) clearTimeout(rec.maxTimer);
      recordingsBySession.delete(deadSid);
      recordingsByTarget.delete(rec.targetId);
      syncActiveRecordingsFile();
      try {
        fs.rmSync(rec.spoolDir, { recursive: true, force: true });
      } catch {}
    }
    if (targetId && recordingsByTarget.has(targetId)) {
      const rec = recordingsByTarget.get(targetId);
      rec.stopping = true;
      if (rec.maxTimer) clearTimeout(rec.maxTimer);
      recordingsByTarget.delete(targetId);
      recordingsBySession.delete(rec.sessionId);
      syncActiveRecordingsFile();
      try {
        fs.rmSync(rec.spoolDir, { recursive: true, force: true });
      } catch {}
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

    if (method === "Fetch.requestPaused") {
      const reqUrl = String(params.request?.url || "");
      if (reqUrl.startsWith("http://127.0.0.1/__cdp_video_encoder__")) {
        void forwardBrowserCommand(
          "Fetch.fulfillRequest",
          {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "text/html; charset=utf-8" },
            ],
            body: Buffer.from(
              "<!doctype html><meta charset=utf-8><title>cdp-video-encoder</title>",
              "utf8",
            ).toString("base64"),
          },
          sessionId,
          5_000,
        ).catch(() => {});
      } else if (params.requestId) {
        void forwardBrowserCommand(
          "Fetch.continueRequest",
          { requestId: params.requestId },
          sessionId,
          5_000,
        ).catch(() => {});
      }
      return;
    }

    if (method === "Page.screencastFrame") {
      if (params.sessionId !== undefined) {
        void forwardBrowserCommand(
          "Page.screencastFrameAck",
          { sessionId: params.sessionId },
          sessionId,
          5_000,
        ).catch(() => {});
      }
      const rec = recordingsBySession.get(sessionId);
      if (rec && !rec.stopping && params.data) {
        appendScreencastFrame(rec, params.data, params.metadata || {});
      }
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
  } else if (command === "start" || command === "connect") {
    await startBridge({ forceRestart: false });
  } else if (command === "restart") {
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
