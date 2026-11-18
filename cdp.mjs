#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CURSOR_HELPER_SOURCE, resolveCursorMode } from "./cursor.mjs";
import { recordCliInvocation, runDiagCommand } from "./diag.mjs";

const cliStartTimeMs = Date.now();
const bridgeScriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "cdp-bridge.mjs",
);
const rawArgs = process.argv.slice(2);

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

let socketOverride = process.env.CDP_BRIDGE_SOCKET || "";
let autoStartEnabled = process.env.CDP_NO_AUTO_START !== "1";
let autoStartAttempted = false;
let diagDisabled = false;
let diagLogOverride = "";
let resolvedCommandName = "";
const diagTelemetry = {
  autoStarted: false,
  reattached: false,
  targetQuery: "",
};

function getSocketState() {
  const runtimeDir = runtimeDirectory();
  const socketPath =
    socketOverride ||
    process.env.CDP_BRIDGE_SOCKET ||
    (isWindows
      ? `\\\\.\\pipe\\cdp-bridge-${getUid()}`
      : path.join(runtimeDir, "bridge.sock"));
  const isNamedPipe = isWindows && /^\\\\[.?]\\pipe\\/i.test(socketPath);
  const clientSessionsPath = path.join(
    isNamedPipe ? runtimeDir : path.dirname(socketPath),
    "client-sessions.json",
  );
  return { runtimeDir, socketPath, isNamedPipe, clientSessionsPath };
}

function loadClientSessions() {
  const { clientSessionsPath } = getSocketState();
  try {
    return JSON.parse(fs.readFileSync(clientSessionsPath, "utf8"));
  } catch {
    return {};
  }
}

function saveClientSessions(sessions) {
  const { clientSessionsPath } = getSocketState();
  try {
    fs.mkdirSync(path.dirname(clientSessionsPath), { recursive: true });
    fs.writeFileSync(clientSessionsPath, JSON.stringify(sessions, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

function sendBridgeRequestOnce(payload, timeoutMs = 15_000) {
  const { socketPath } = getSocketState();
  const reqPayload =
    payload.timeoutMs === undefined && !String(payload.method || "").startsWith("bridge.")
      ? { ...payload, timeoutMs }
      : payload;

  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`CDP bridge request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let responseText = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(reqPayload)}\n`);
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

function ensureBridgeAutoStarted(timeoutMs = 15_000) {
  saveClientSessions({});
  const bridgeArgs = [bridgeScriptPath, "restart"];
  if (socketOverride) {
    bridgeArgs.push("--socket", socketOverride);
  }
  const waitMs = Math.max(5_000, Math.min(timeoutMs, 15_000));
  bridgeArgs.push("--timeout", String(waitMs));

  const res = spawnSync(process.execPath, bridgeArgs, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.status === 2) {
    throw new Error(
      "CDP bridge daemon was auto-started and is waiting for browser remote debugging approval. Click 'Allow' in the browser prompt, then re-run the command.",
    );
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(
      `Failed to auto-start CDP bridge daemon${detail ? `: ${detail}` : ""}`,
    );
  }
}

async function requestBridge(payload, timeoutMs = 15_000, options = {}) {
  const allowAutoStart =
    options.allowAutoStart !== false && autoStartEnabled && !autoStartAttempted;

  try {
    return await sendBridgeRequestOnce(payload, timeoutMs);
  } catch (error) {
    const isBridgeDown =
      error &&
      (error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        (typeof error.message === "string" &&
          error.message.includes("Browser CDP connection is disconnected")));

    if (!allowAutoStart || !isBridgeDown) {
      throw error;
    }

    autoStartAttempted = true;
    ensureBridgeAutoStarted(timeoutMs);
    diagTelemetry.autoStarted = true;
    return sendBridgeRequestOnce(payload, timeoutMs);
  }
}

function parseJson(value, label) {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error.message}`);
  }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLeadingGlobalFlags(argv) {
  const globalFlags = {
    help: false,
    raw: false,
    compact: false,
    target: undefined,
    timeout: undefined,
    socket: undefined,
  };
  let idx = 0;
  while (idx < argv.length) {
    const arg = argv[idx];
    if (arg === "-h" || arg === "--help") {
      globalFlags.help = true;
      idx += 1;
    } else if (arg === "--raw") {
      globalFlags.raw = true;
      idx += 1;
    } else if (arg === "--compact" || arg === "-c") {
      globalFlags.compact = true;
      idx += 1;
    } else if ((arg === "-t" || arg === "--target") && idx + 1 < argv.length) {
      globalFlags.target = argv[idx + 1];
      idx += 2;
    } else if (arg.startsWith("--target=")) {
      globalFlags.target = arg.slice("--target=".length);
      idx += 1;
    } else if (
      (arg === "--socket" || arg === "-s") &&
      idx + 1 < argv.length
    ) {
      globalFlags.socket = argv[idx + 1];
      idx += 2;
    } else if (arg.startsWith("--socket=")) {
      globalFlags.socket = arg.slice("--socket=".length);
      idx += 1;
    } else if (arg === "--no-auto-start") {
      autoStartEnabled = false;
      idx += 1;
    } else if (arg === "--no-diag") {
      diagDisabled = true;
      idx += 1;
    } else if (arg === "--no-cursor") {
      globalFlags["no-cursor"] = true;
      idx += 1;
    } else if (
      arg === "--with-cursor" ||
      arg === "--keep-cursor" ||
      arg === "--show-cursor"
    ) {
      globalFlags["with-cursor"] = true;
      idx += 1;
    } else if (arg === "--cursor" && idx + 1 < argv.length) {
      globalFlags.cursor = argv[idx + 1];
      idx += 2;
    } else if (arg.startsWith("--cursor=")) {
      globalFlags.cursor = arg.slice("--cursor=".length);
      idx += 1;
    } else if (arg === "--diag-log" && idx + 1 < argv.length) {
      diagLogOverride = argv[idx + 1];
      idx += 2;
    } else if (arg.startsWith("--diag-log=")) {
      diagLogOverride = arg.slice("--diag-log=".length);
      idx += 1;
    } else if (arg === "--timeout" && idx + 1 < argv.length) {
      globalFlags.timeout = Number(argv[idx + 1]);
      idx += 2;
    } else if (arg.startsWith("--timeout=")) {
      globalFlags.timeout = Number(arg.slice("--timeout=".length));
      idx += 1;
    } else {
      break;
    }
  }
  return {
    globalFlags,
    command: argv[idx],
    restArgs: argv.slice(idx + 1),
  };
}

function parseFlags(args, booleanFlags = [], globalDefaults = {}) {
  const boolSet = new Set([
    "help",
    "raw",
    "compact",
    "no-auto-start",
    "no-diag",
    "no-cursor",
    "with-cursor",
    "keep-cursor",
    "show-cursor",
    ...booleanFlags,
  ]);
  const flags = { ...globalDefaults };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        if (boolSet.has(key)) {
          flags[key] = true;
        } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          flags[key] = args[i + 1];
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === "-h") {
      flags.help = true;
    } else if (arg === "-c") {
      flags.compact = true;
    } else if (arg === "-s" && i + 1 < args.length) {
      const val = args[i + 1];
      if (val.includes("/") || val.includes("\\") || val.endsWith(".sock")) {
        flags.socket = val;
      } else {
        flags["session-id"] = val;
      }
      i += 1;
    } else if (arg === "-t" && i + 1 < args.length) {
      flags.target = args[i + 1];
      i += 1;
    } else if (arg === "-f" && i + 1 < args.length) {
      flags.file = args[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  if (typeof flags.socket === "string" && flags.socket) {
    socketOverride = flags.socket;
    process.env.CDP_BRIDGE_SOCKET = flags.socket;
  }
  if (flags["no-auto-start"]) {
    autoStartEnabled = false;
  }
  if (flags["no-diag"]) {
    diagDisabled = true;
  }
  if (typeof flags["diag-log"] === "string" && flags["diag-log"]) {
    diagLogOverride = flags["diag-log"];
  }
  return { flags, positional };
}

function takeTargetArg(positional, flags) {
  if (typeof flags.target === "string" && flags.target) {
    return { targetQuery: flags.target, restPositional: positional };
  }
  return {
    targetQuery: positional[0],
    restPositional: positional.slice(1),
  };
}

function resolveTimeoutMs(flags, fallbackMs = 15_000) {
  if (flags.timeout !== undefined && flags.timeout !== true) {
    const n = Number(flags.timeout);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return fallbackMs;
}

function readInputSource(positionalText, flags, label = "input") {
  if (flags.file && typeof flags.file === "string") {
    return fs.readFileSync(flags.file, "utf8");
  }
  if (
    flags.stdin === true ||
    positionalText === "-" ||
    (positionalText === undefined && !process.stdin.isTTY)
  ) {
    return fs.readFileSync(0, "utf8");
  }
  if (positionalText !== undefined) {
    return positionalText;
  }
  throw new Error(
    `Missing ${label}; pass it as an argument, --file <path>, or --stdin`,
  );
}

function buildMatcher(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegExp(pattern), "i");
  }
}

async function fetchAllTargets(timeoutMs = 10_000) {
  const targets = await requestBridge(
    { id: 1, method: "Target.getTargets" },
    timeoutMs,
  );
  const all = targets.targetInfos || [];

  // Automatically prune stale closed targetIds from client-sessions.json
  const cached = loadClientSessions();
  const openIds = new Set(all.map((t) => t.targetId));
  let dirty = false;
  for (const tid of Object.keys(cached)) {
    if (!openIds.has(tid)) {
      delete cached[tid];
      dirty = true;
    }
  }
  if (dirty) {
    saveClientSessions(cached);
  }
  return all;
}

async function listPageTargets() {
  const all = await fetchAllTargets();
  return all.filter((t) => t.type === "page");
}

async function attachTarget(targetId) {
  let sessionId = "";
  try {
    const bridgePage = await requestBridge({
      id: 1,
      method: "bridge.attach",
      params: { targetId },
    });
    sessionId = bridgePage.sessionId || "";
  } catch {
    // Fallback for older running bridge daemons without bridge.attach
  }
  if (!sessionId) {
    const attached = await requestBridge({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId, flatten: true },
    });
    sessionId = attached.sessionId;
  }
  const sessions = loadClientSessions();
  sessions[targetId] = sessionId;
  saveClientSessions(sessions);
  return sessionId;
}

async function resolvePage(targetQuery) {
  if (!targetQuery) {
    throw new Error("Missing <target> (URL regex, title regex, or targetId)");
  }
  diagTelemetry.targetQuery = String(targetQuery);

  const allTargets = await fetchAllTargets();
  const pages = allTargets.filter((t) => t.type === "page");
  const qLower = String(targetQuery).toLowerCase();
  const isHexId = /^[0-9a-f]{8,}$/i.test(targetQuery);

  let target =
    allTargets.find((p) => p.targetId.toLowerCase() === qLower) ||
    (isHexId
      ? pages.find((p) => p.targetId.toLowerCase().startsWith(qLower)) ||
        allTargets.find((p) => p.targetId.toLowerCase().startsWith(qLower))
      : undefined);

  let matchedCandidates = target ? [target] : [];

  if (!target) {
    const exactUrlMatches = pages.filter((p) => p.url === targetQuery);
    if (exactUrlMatches.length > 0) {
      target = exactUrlMatches[0];
      matchedCandidates = exactUrlMatches;
    } else {
      const matcher = buildMatcher(targetQuery);
      const urlMatches = pages.filter((p) => matcher.test(p.url || ""));
      if (urlMatches.length > 0) {
        target = urlMatches[0];
        matchedCandidates = urlMatches;
      } else {
        const titleMatches = pages.filter((p) => matcher.test(p.title || ""));
        if (titleMatches.length > 0) {
          target = titleMatches[0];
          matchedCandidates = titleMatches;
        }
      }
    }
  }

  if (!target) {
    const available = pages
      .map((p) => `  - [${p.targetId}] ${p.title || "(untitled)"} -> ${p.url}`)
      .join("\n");
    throw new Error(
      `No page target matches "${targetQuery}". Available pages:\n${available || "  (none)"}`,
    );
  }

  const buildResult = (sessionId) => {
    const pageInfo = {
      targetId: target.targetId,
      sessionId,
      title: target.title,
      url: target.url,
    };
    if (matchedCandidates.length > 1) {
      pageInfo.ambiguousMatches = matchedCandidates.length;
      pageInfo.matchedTargetIds = matchedCandidates.map((m) =>
        m.targetId.slice(0, 8),
      );
    }
    return pageInfo;
  };

  // 1. Check client-side session cache first
  const cachedSessions = loadClientSessions();
  if (cachedSessions[target.targetId]) {
    return buildResult(cachedSessions[target.targetId]);
  }

  // 2. Attach via bridge (enables Runtime/Log/Network ring buffers & active lifecycle state)
  const sessionId = await attachTarget(target.targetId);
  return buildResult(sessionId);
}

async function callPage(page, method, params = {}, timeoutMs = 15_000) {
  try {
    return await requestBridge(
      {
        id: 1,
        method,
        params,
        sessionId: page.sessionId,
        timeoutMs,
      },
      timeoutMs,
    );
  } catch (error) {
    if (
      error.message &&
      (error.message.includes("Session with given id not found") ||
        error.message.includes("Target closed"))
    ) {
      diagTelemetry.reattached = true;
      page.sessionId = await attachTarget(page.targetId);
      return requestBridge(
        {
          id: 2,
          method,
          params,
          sessionId: page.sessionId,
          timeoutMs,
        },
        timeoutMs,
      );
    }
    throw error;
  }
}

const IN_PAGE_MONITOR_SCRIPT = `(() => {
  if (window.__cdpBridgeMonitor) return true;
  const MAX_ITEMS = 200;
  const mon = {
    installedAt: new Date().toISOString(),
    logs: [],
    network: []
  };
  function pushBounded(arr, item) {
    arr.push(item);
    if (arr.length > MAX_ITEMS) arr.shift();
  }
  function formatArg(a) {
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (typeof a === "object" && a !== null) {
      try { return JSON.stringify(a).slice(0, 1000); } catch { return String(a); }
    }
    return String(a);
  }
  for (const level of ["error", "warn"]) {
    const orig = console[level];
    if (typeof orig === "function") {
      console[level] = function(...args) {
        try {
          pushBounded(mon.logs, {
            time: new Date().toISOString(),
            level,
            text: args.map(formatArg).join(" ")
          });
        } catch {}
        return orig.apply(this, args);
      };
    }
  }
  window.addEventListener("error", (ev) => {
    pushBounded(mon.logs, {
      time: new Date().toISOString(),
      level: "pageerror",
      text: ev.message || String(ev),
      filename: ev.filename,
      lineno: ev.lineno
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    pushBounded(mon.logs, {
      time: new Date().toISOString(),
      level: "unhandledrejection",
      text: reason instanceof Error ? (reason.stack || reason.message) : formatArg(reason)
    });
  });
  if (typeof window.fetch === "function") {
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const method = (init && init.method) || (input && input.method) || "GET";
      const start = Date.now();
      try {
        const res = await origFetch.apply(this, arguments);
        const entry = {
          time: new Date().toISOString(),
          type: "fetch",
          method,
          url,
          status: res.status,
          ok: res.ok,
          durationMs: Date.now() - start
        };
        if (!res.ok) {
          try {
            const clone = res.clone();
            const bodyText = await clone.text();
            entry.responseBody = bodyText.slice(0, 1000);
          } catch {}
        }
        pushBounded(mon.network, entry);
        return res;
      } catch (err) {
        pushBounded(mon.network, {
          time: new Date().toISOString(),
          type: "fetch",
          method,
          url,
          status: 0,
          ok: false,
          error: err && err.message ? err.message : String(err),
          durationMs: Date.now() - start
        });
        throw err;
      }
    };
  }
  window.__cdpBridgeMonitor = mon;
  return true;
})();`;

async function ensurePageMonitor(page, persistAcrossReloads = false) {
  try {
    if (persistAcrossReloads) {
      await callPage(page, "Page.enable", {}, 5_000);
      await callPage(
        page,
        "Page.addScriptToEvaluateOnNewDocument",
        { source: IN_PAGE_MONITOR_SCRIPT },
        5_000,
      );
    }
    await callPage(
      page,
      "Runtime.evaluate",
      { expression: IN_PAGE_MONITOR_SCRIPT, returnByValue: true },
      5_000,
    );
  } catch {
    // Non-fatal if page cannot be instrumented
  }
}

async function evaluateInPage(page, expression, options = {}) {
  const { awaitPromise = true, timeoutMs = 15_000 } = options;

  try {
    const evaluation = await callPage(
      page,
      "Runtime.evaluate",
      {
        expression,
        awaitPromise,
        returnByValue: true,
      },
      timeoutMs,
    );

    if (
      evaluation.exceptionDetails &&
      evaluation.exceptionDetails.exception?.description?.includes(
        "Converting circular structure to JSON",
      )
    ) {
      throw new Error("Object couldn't be returned by value");
    }

    return {
      page,
      evaluation: evaluation.result,
      exceptionDetails: evaluation.exceptionDetails,
    };
  } catch (error) {
    if (
      error.message &&
      (error.message.includes("Object couldn't be returned by value") ||
        error.message.includes("Object reference chain is too long"))
    ) {
      const objEval = await callPage(
        page,
        "Runtime.evaluate",
        {
          expression,
          awaitPromise,
          returnByValue: false,
        },
        timeoutMs,
      );
      if (objEval.exceptionDetails || !objEval.result?.objectId) {
        return {
          page,
          evaluation: objEval.result,
          exceptionDetails: objEval.exceptionDetails,
        };
      }
      const serialized = await callPage(
        page,
        "Runtime.callFunctionOn",
        {
          objectId: objEval.result.objectId,
          functionDeclaration: `function() {
            const seen = new WeakSet();
            function clean(val, depth) {
              if (val === null || val === undefined) return val;
              const t = typeof val;
              if (t === "string" || t === "number" || t === "boolean") return val;
              if (t === "function") return "[Function: " + (val.name || "anonymous") + "]";
              if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
              if (typeof Element !== "undefined" && val instanceof Element) {
                return "<" + val.tagName.toLowerCase() + (val.id ? "#" + val.id : "") + (val.className ? "." + String(val.className).trim().replace(/\\s+/g, ".") : "") + ">";
              }
              if (t !== "object") return String(val);
              if (seen.has(val)) return "[Circular]";
              if (depth >= 5) return Array.isArray(val) ? "[Array(" + val.length + ")]" : "[Object]";
              seen.add(val);
              if (Array.isArray(val)) return val.slice(0, 50).map((v) => clean(v, depth + 1));
              const out = {};
              for (const k of Object.keys(val).slice(0, 50)) {
                try { out[k] = clean(val[k], depth + 1); } catch (e) { out[k] = "[Throws: " + e.message + "]"; }
              }
              return out;
            }
            return clean(this, 0);
          }`,
          returnByValue: true,
        },
        timeoutMs,
      );
      return {
        page,
        evaluation: serialized.result,
        exceptionDetails: serialized.exceptionDetails,
        serializedFallback: true,
      };
    }
    throw error;
  }
}

async function waitOnPage(page, selectorOrExpr, options = {}) {
  const { timeoutMs = 10_000, expectedText } = options;
  const start = Date.now();
  const deadline = start + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const probe = await evaluateInPage(
        page,
        `(() => {
          const q = ${JSON.stringify(selectorOrExpr)};
          const wantText = ${JSON.stringify(expectedText ?? null)};
          if (q) {
            try {
              const all = Array.from(document.querySelectorAll(q));
              for (const el of all) {
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const visible = r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
                if (!visible && all.length > 1) continue;
                const txt = (el.innerText || el.textContent || "").trim();
                if (!wantText || txt.includes(wantText)) {
                  return { matched: true, mode: "selector", tag: el.tagName, text: txt.slice(0, 200) };
                }
              }
            } catch {}
          }
          if (wantText) {
            const bodyTxt = (document.body?.innerText || "");
            if (bodyTxt.includes(wantText)) {
              return { matched: true, mode: "text", text: wantText };
            }
          }
          if (q) {
            try {
              const val = (0, eval)(q);
              if (val) {
                return { matched: true, mode: "expression", value: String(val).slice(0, 200) };
              }
            } catch {}
          }
          return { matched: false };
        })()`,
        { timeoutMs: Math.min(timeoutMs, 5_000) },
      );
      const val = probe.evaluation?.value;
      if (val && val.matched) {
        return {
          page,
          elapsedMs: Date.now() - start,
          ...val,
        };
      }
    } catch {
      // Ignore transient reload context errors
    }
    await sleep(200);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for "${selectorOrExpr || expectedText}"${expectedText && selectorOrExpr ? ` with text "${expectedText}"` : ""}`,
  );
}

async function inspectPageElements(page, options = {}) {
  const {
    rootSelector = null,
    includeHidden = false,
    limit = 80,
    timeoutMs = 15_000,
  } = options;

  const expr = `(() => {
    const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)})` : "document"};
    if (!root) {
      return { foundRoot: false, error: "Root selector not found: " + ${JSON.stringify(rootSelector)} };
    }
    const INTERACTIVE_QUERY = [
      "button",
      "a[href]",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "summary",
      "[contenteditable='true']",
      ".ProseMirror",
      "[role='button']",
      "[role='link']",
      "[role='menuitem']",
      "[role='menuitemradio']",
      "[role='menuitemcheckbox']",
      "[role='option']",
      "[role='tab']",
      "[role='switch']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='combobox']"
    ].join(", ");

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function escAttr(v) {
      return String(v).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
    }

    function buildSelector(el) {
      const tag = el.tagName.toLowerCase();
      const testId = el.getAttribute("data-testid");
      if (testId) {
        const s = '[data-testid="' + escAttr(testId) + '"]';
        if (document.querySelectorAll(s).length === 1) return s;
      }
      if (el.id) {
        const s = "#" + CSS.escape(el.id);
        try { if (document.querySelectorAll(s).length === 1) return s; } catch {}
      }
      const aria = el.getAttribute("aria-label");
      if (aria && aria.length <= 60) {
        const s = tag + '[aria-label="' + escAttr(aria) + '"]';
        try { if (document.querySelectorAll(s).length === 1) return s; } catch {}
      }
      const name = el.getAttribute("name");
      if (name) {
        const s = tag + '[name="' + escAttr(name) + '"]';
        try { if (document.querySelectorAll(s).length === 1) return s; } catch {}
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.length <= 60) {
        const s = tag + '[placeholder="' + escAttr(placeholder) + '"]';
        try { if (document.querySelectorAll(s).length === 1) return s; } catch {}
      }
      if (el.classList && el.classList.contains("ProseMirror")) {
        if (document.querySelectorAll(".ProseMirror").length === 1) return ".ProseMirror";
      }
      const txt = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      if (txt && txt.length <= 40 && ["button", "a", "label", "summary"].includes(tag)) {
        return "text=" + txt;
      }
      const role = el.getAttribute("role");
      if (role && txt && txt.length <= 40) {
        return "text=" + txt;
      }
      // Fallback CSS path
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && parts.length < 4) {
        const t = cur.tagName.toLowerCase();
        if (cur.id) {
          parts.unshift("#" + CSS.escape(cur.id));
          break;
        }
        const parent = cur.parentElement;
        if (!parent) {
          parts.unshift(t);
          break;
        }
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        const nth = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")" : "";
        parts.unshift(t + nth);
        cur = parent;
      }
      return parts.join(" > ");
    }

    const rawNodes = Array.from(root.querySelectorAll(INTERACTIVE_QUERY));
    const filtered = ${JSON.stringify(includeHidden)} ? rawNodes : rawNodes.filter(isVisible);
    const items = filtered.slice(0, ${Number.isFinite(limit) ? limit : 80}).map((el, idx) => {
      const tag = el.tagName.toLowerCase();
      const item = { index: idx, tag };
      const type = el.getAttribute("type");
      if (type && tag === "input") item.type = type;
      const role = el.getAttribute("role");
      if (role) item.role = role;
      const txt = (el.innerText ?? el.value ?? el.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 80);
      if (txt) item.text = txt;
      const aria = el.getAttribute("aria-label");
      if (aria) item.ariaLabel = aria.slice(0, 80);
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) item.placeholder = placeholder.slice(0, 80);
      const testId = el.getAttribute("data-testid");
      if (testId) item.testId = testId;
      const href = tag === "a" ? el.getAttribute("href") : null;
      if (href && !href.startsWith("javascript:")) item.href = href.slice(0, 120);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
      const expanded = el.getAttribute("aria-expanded");
      if (expanded !== null) item.expanded = expanded === "true";
      const checked = el.type === "checkbox" || el.type === "radio" ? el.checked : el.getAttribute("aria-checked");
      if (checked === true || checked === "true") item.checked = true;
      if (el.isContentEditable) item.contentEditable = true;
      item.selector = buildSelector(el);
      return item;
    });

    return {
      foundRoot: true,
      title: document.title,
      href: location.href,
      readyState: document.readyState,
      totalMatched: filtered.length,
      returnedCount: items.length,
      elements: items
    };
  })()`;

  const res = await evaluateInPage(page, expr, { timeoutMs });
  const val = res.evaluation?.value;
  if (!val?.foundRoot) {
    throw new Error(val?.error || "Failed to inspect page elements");
  }
  const { foundRoot: _ignored, ...rest } = val;
  return { page, ...rest };
}

async function fillInPage(page, selector, text, options = {}) {
  const {
    clear = false,
    append = false,
    submit = false,
    submitSelector = null,
    cursorMode = resolveCursorMode(),
    timeoutMs = 15_000,
  } = options;
  const finalText = clear ? "" : text;

  const prepRes = await evaluateInPage(
    page,
    `(async () => {
      const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const visible = all.filter((node) => {
        const r = node.getBoundingClientRect();
        const s = window.getComputedStyle(node);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      });
      const el = visible[0] || all[0] || null;
      if (!el) return { ok: false, error: "Element not found: " + ${JSON.stringify(selector)} };

      el.scrollIntoView({ behavior: "instant", block: "center" });
      if (${JSON.stringify(cursorMode !== "off")}) {
        try {
          (${CURSOR_HELPER_SOURCE}).showFill(
            el,
            ${JSON.stringify(clear ? "Clear" : "Fill")},
            ${cursorMode === "demo" ? 200 : 140},
            260,
            ${JSON.stringify(cursorMode === "persist")}
          );
        } catch {}
        if (${JSON.stringify(cursorMode === "demo")}) {
          await new Promise((r) => setTimeout(r, 180));
        }
      }
      el.focus();

      if (el.isContentEditable) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        if (${JSON.stringify(append)}) {
          range.collapse(false);
        }
        sel.removeAllRanges();
        sel.addRange(range);
        if (!${JSON.stringify(append)}) {
          try { document.execCommand("delete", false, null); } catch {}
          if ((el.innerText || "").trim().length > 0 && ${JSON.stringify(finalText === "")}) {
            el.innerHTML = "";
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
          }
        }
        return { ok: true, mode: "contenteditable", tag: el.tagName };
      }

      if (el instanceof HTMLSelectElement) {
        const targetVal = ${JSON.stringify(finalText)};
        const opt = Array.from(el.options).find((o) => o.value === targetVal || o.text.trim() === targetVal);
        el.value = opt ? opt.value : targetVal;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, mode: "select", tag: el.tagName, valueLength: String(el.value || "").length };
      }

      const prev = ${JSON.stringify(append)} ? String(el.value || "") : "";
      const val = prev + ${JSON.stringify(finalText)};
      const proto = el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? window.HTMLInputElement.prototype
          : null;
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, val);
      } else {
        el.value = val;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        mode: "value-setter",
        tag: el.tagName,
        valueLength: String(el.value || "").length
      };
    })()`,
    { timeoutMs },
  );

  const prep = prepRes.evaluation?.value;
  if (!prep?.ok) {
    throw new Error(prep?.error || "Failed to fill target element");
  }

  let valueLength = prep.valueLength ?? 0;
  if (prep.mode === "contenteditable") {
    if (finalText.length > 0) {
      let insertedViaCdp = false;
      try {
        await callPage(
          page,
          "Input.insertText",
          { text: finalText },
          timeoutMs,
        );
        insertedViaCdp = true;
      } catch {
        insertedViaCdp = false;
      }

      const verifyRes = await evaluateInPage(
        page,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { length: 0 };
          let cur = (el.innerText ?? el.textContent ?? "").trim();
          if (!${JSON.stringify(insertedViaCdp)} || cur.length === 0) {
            el.focus();
            let ok = false;
            try { ok = document.execCommand("insertText", false, ${JSON.stringify(finalText)}); } catch {}
            if (!ok) {
              el.textContent = ${JSON.stringify(finalText)};
              el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(finalText)}, inputType: "insertText" }));
            }
            cur = (el.innerText ?? el.textContent ?? "").trim();
          }
          return { length: cur.length };
        })()`,
        { timeoutMs },
      );
      valueLength = verifyRes.evaluation?.value?.length ?? finalText.length;
    } else {
      valueLength = 0;
    }
  }

  let submitted = false;
  if (submit) {
    await sleep(100);
    if (submitSelector) {
      const clickRes = await clickInPage(page, submitSelector, {
        timeoutMs,
      });
      if (clickRes.ok) {
        submitted = `clicked:${submitSelector}`;
      }
    }
    if (!submitted) {
      const enterRes = await evaluateInPage(
        page,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          for (const type of ["keydown", "keypress", "keyup"]) {
            el.dispatchEvent(new KeyboardEvent(type, {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true
            }));
          }
          return "enter";
        })()`,
        { timeoutMs },
      );
      submitted = enterRes.evaluation?.value || "enter";
    }
  }

  return {
    page,
    ok: true,
    tag: prep.tag,
    mode: prep.mode,
    valueLength,
    submitted,
  };
}

async function clickInPage(page, selectorOrText, options = {}) {
  const {
    byText = false,
    exact = false,
    index = 0,
    waitMs = 0,
    waitFor = null,
    includeHidden = false,
    nativeMouse = false,
    cursorMode = resolveCursorMode(),
    timeoutMs = 15_000,
  } = options;

  const isTextPrefix = selectorOrText.startsWith("text=");
  const forceText = byText || isTextPrefix;
  const query = isTextPrefix ? selectorOrText.slice(5) : selectorOrText;

  const expr = `(async () => {
    function isVisible(node) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    let el = null;
    let matchedBy = "selector";
    if (!${JSON.stringify(forceText)}) {
      try {
        const all = Array.from(document.querySelectorAll(${JSON.stringify(query)}));
        const visible = all.filter(isVisible);
        const pool = !${JSON.stringify(includeHidden)} && visible.length > 0 ? visible : all;
        el = pool[${index}] || null;
      } catch {
        el = null;
      }
    }

    if (!el) {
      matchedBy = "text";
      const CLICKABLE_CANDIDATES = [
        "button",
        "[role='button']",
        "a",
        "[role='link']",
        "[role='tab']",
        "[role='menuitem']",
        "[role='menuitemradio']",
        "[role='menuitemcheckbox']",
        "[role='option']",
        "[role='switch']",
        "[role='checkbox']",
        "[role='radio']",
        "label",
        "summary",
        "li",
        ".ant-dropdown-menu-item",
        ".ant-select-item-option",
        ".ant-tabs-tab"
      ].join(", ");

      const rawNodes = Array.from(document.querySelectorAll(CLICKABLE_CANDIDATES));
      const nodes = ${JSON.stringify(includeHidden)} ? rawNodes : rawNodes.filter(isVisible);
      const q = ${JSON.stringify(query)};
      const qNorm = q.trim();

      const exactMatches = [];
      const partialMatches = [];
      for (const node of nodes) {
        const txt = (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim();
        const aria = (node.getAttribute("aria-label") || "").trim();
        const title = (node.getAttribute("title") || "").trim();
        if (txt === qNorm || aria === qNorm || title === qNorm) {
          exactMatches.push(node);
        } else if (!${JSON.stringify(exact)} && (txt.includes(q) || aria.includes(q) || title.includes(q))) {
          partialMatches.push(node);
        }
      }

      // Prefer exact matches first, then more specific (shorter text) partial matches
      partialMatches.sort((a, b) => {
        const lenA = (a.innerText || a.textContent || "").trim().length;
        const lenB = (b.innerText || b.textContent || "").trim().length;
        return lenA - lenB;
      });

      const candidates = [...exactMatches, ...partialMatches];
      el = candidates[${index}] || null;
    }

    if (!el) {
      return { ok: false, error: "No element matches " + ${JSON.stringify(selectorOrText)} };
    }

    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    if (${JSON.stringify(cursorMode !== "off")}) {
      try {
        (${CURSOR_HELPER_SOURCE}).showClick(
          cx,
          cy,
          rect,
          ${cursorMode === "demo" ? 200 : 140},
          ${nativeMouse ? 480 : 180},
          ${JSON.stringify(cursorMode === "persist")}
        );
      } catch {}
      if (${JSON.stringify(cursorMode === "demo")}) {
        await new Promise((r) => setTimeout(r, 180));
      }
    }

    if (!${JSON.stringify(nativeMouse)}) {
      const baseInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: cx,
        clientY: cy,
        button: 0
      };
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerover", { ...baseInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        el.dispatchEvent(new PointerEvent("pointerenter", { ...baseInit, bubbles: false, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent("mouseover", baseInit));
      el.dispatchEvent(new MouseEvent("mouseenter", { ...baseInit, bubbles: false }));
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerdown", { ...baseInit, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent("mousedown", { ...baseInit, buttons: 1 }));
      if (typeof el.focus === "function") {
        try { el.focus({ preventScroll: true }); } catch {}
      }
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerup", { ...baseInit, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent("mouseup", { ...baseInit, buttons: 0 }));
      el.click();
    }

    return {
      ok: true,
      matchedBy,
      tag: el.tagName,
      role: el.getAttribute("role") || undefined,
      text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
      ariaLabel: el.getAttribute("aria-label") || null,
      x: cx,
      y: cy
    };
  })()`;

  const res = await evaluateInPage(page, expr, { timeoutMs });
  const val = res.evaluation?.value;
  if (!val?.ok) {
    throw new Error(val?.error || `Click failed for ${selectorOrText}`);
  }

  if (nativeMouse) {
    await callPage(
      page,
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: val.x, y: val.y, button: "none" },
      timeoutMs,
    );
    await callPage(
      page,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: val.x,
        y: val.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      timeoutMs,
    );
    await callPage(
      page,
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: val.x,
        y: val.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
      timeoutMs,
    );
  }

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  let waitedResult;
  if (waitFor) {
    waitedResult = await waitOnPage(page, waitFor, { timeoutMs });
  }

  const { x: _x, y: _y, ...cleanVal } = val;
  const out = {
    page,
    ...cleanVal,
  };
  if (waitedResult) {
    out.waited = {
      elapsedMs: waitedResult.elapsedMs,
      mode: waitedResult.mode,
    };
  }
  return out;
}

async function hoverInPage(page, targetSpec, options = {}) {
  const {
    byText = false,
    exact = false,
    index = 0,
    persist = true,
    nativeMouse = false,
    cursorMode = resolveCursorMode(),
    timeoutMs = 15_000,
  } = options;

  const coordMatch = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
    String(targetSpec || ""),
  );
  const coords = coordMatch
    ? { x: Math.round(Number(coordMatch[1])), y: Math.round(Number(coordMatch[2])) }
    : null;

  const isTextPrefix = String(targetSpec || "").startsWith("text=");
  const forceText = byText || isTextPrefix;
  const query = isTextPrefix ? String(targetSpec).slice(5) : String(targetSpec || "");

  const expr = `(async () => {
    let cx = 0;
    let cy = 0;
    let rect = null;
    let el = null;
    let matchedBy = "coords";

    if (${JSON.stringify(coords)}) {
      cx = ${coords ? coords.x : 0};
      cy = ${coords ? coords.y : 0};
      el = document.elementFromPoint(cx, cy);
    } else {
      function isVisible(node) {
        const s = window.getComputedStyle(node);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      matchedBy = "selector";
      if (!${JSON.stringify(forceText)}) {
        try {
          const all = Array.from(document.querySelectorAll(${JSON.stringify(query)}));
          const vis = all.filter(isVisible);
          el = (vis.length > 0 ? vis : all)[${index}] || null;
        } catch { el = null; }
      }
      if (!el) {
        matchedBy = "text";
        const nodes = Array.from(document.querySelectorAll("button, [role='button'], a, [role='tab'], [role='menuitem'], [role='menuitemradio'], [role='option'], label, li")).filter(isVisible);
        const q = ${JSON.stringify(query)};
        const qNorm = q.trim();
        const exactList = nodes.filter((n) => ((n.innerText || "").trim() === qNorm || (n.getAttribute("aria-label") || "").trim() === qNorm));
        const partList = ${JSON.stringify(exact)} ? [] : nodes.filter((n) => !exactList.includes(n) && ((n.innerText || "").includes(q) || (n.getAttribute("aria-label") || "").includes(q)));
        el = [...exactList, ...partList][${index}] || null;
      }
      if (!el) {
        return { ok: false, error: "No element matches " + ${JSON.stringify(targetSpec)} };
      }
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      cx = Math.round(r.left + r.width / 2);
      cy = Math.round(r.top + r.height / 2);
    }

    if (${JSON.stringify(cursorMode !== "off")}) {
      try {
        (${CURSOR_HELPER_SOURCE}).showHover(
          cx,
          cy,
          rect,
          ${cursorMode === "demo" ? 220 : 150},
          ${nativeMouse ? 480 : 180},
          ${JSON.stringify(persist)}
        );
      } catch {}
    }

    if (el && !${JSON.stringify(nativeMouse)}) {
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerover", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        el.dispatchEvent(new PointerEvent("pointerenter", { ...init, bubbles: false, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        el.dispatchEvent(new PointerEvent("pointermove", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent("mouseover", init));
      el.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }));
      el.dispatchEvent(new MouseEvent("mousemove", init));
    }

    return {
      ok: true,
      matchedBy,
      x: cx,
      y: cy,
      tag: el ? el.tagName : null,
      text: el ? (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80) : null
    };
  })()`;

  const res = await evaluateInPage(page, expr, { timeoutMs });
  const val = res.evaluation?.value;
  if (!val?.ok) {
    throw new Error(val?.error || `Hover failed for ${targetSpec}`);
  }
  if (nativeMouse) {
    await callPage(
      page,
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: val.x, y: val.y, button: "none" },
      timeoutMs,
    );
  }
  return { page, ...val };
}

async function readPageText(page, selector, maxLen = 50_000, timeoutMs = 15_000) {
  const expr = `(() => {
    const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
    if (!root) return { found: false, text: null, href: location.href, title: document.title, readyState: document.readyState };
    const raw = (root.innerText ?? root.textContent ?? "").trim();
    return {
      found: true,
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      length: raw.length,
      text: raw.slice(0, ${Number.isFinite(maxLen) ? maxLen : 50_000})
    };
  })()`;
  const res = await evaluateInPage(page, expr, { timeoutMs });
  return {
    page,
    ...(res.evaluation?.value || {}),
  };
}

async function capturePageScreenshot(page, outPathArg, flags = {}, timeoutMs = 30_000) {
  const outPath = path.resolve(
    outPathArg || path.join(os.tmpdir(), `cdp-screenshot-${Date.now()}.png`),
  );
  const ext = path.extname(outPath).toLowerCase();
  const format =
    typeof flags.format === "string"
      ? flags.format
      : ext === ".jpg" || ext === ".jpeg"
        ? "jpeg"
        : ext === ".webp"
          ? "webp"
          : "png";

  const params = { format };
  if (flags.quality && (format === "jpeg" || format === "webp")) {
    params.quality = Number(flags.quality);
  }

  if (flags.selector && typeof flags.selector === "string") {
    const rectRes = await evaluateInPage(
      page,
      `(() => {
        const el = document.querySelector(${JSON.stringify(flags.selector)});
        if (!el) return null;
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return {
          x: Math.max(0, r.left + window.scrollX),
          y: Math.max(0, r.top + window.scrollY),
          width: Math.max(1, r.width),
          height: Math.max(1, r.height),
          scale: 1
        };
      })()`,
      { timeoutMs },
    );
    const clip = rectRes.evaluation?.value;
    if (!clip) {
      throw new Error(
        `Selector not found for screenshot: ${flags.selector}`,
      );
    }
    params.clip = clip;
  } else if (flags["full-page"] || flags.fullPage) {
    const metrics = await callPage(page, "Page.getLayoutMetrics", {}, timeoutMs);
    const size =
      metrics.cssContentSize ||
      metrics.contentSize ||
      metrics.layoutViewport;
    if (size && size.width && size.height) {
      params.captureBeyondViewport = true;
      params.clip = {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1,
      };
    }
  }

  const keepCursor = Boolean(
    flags["with-cursor"] ||
      flags["keep-cursor"] ||
      flags["show-cursor"] ||
      flags.withCursor ||
      flags.keepCursor ||
      process.env.CDP_SCREENSHOT_CURSOR === "1",
  );
  const preState = await evaluateInPage(
    page,
    `(() => {
      const hidden = document.visibilityState === "hidden";
      let cursorPrep = { mode: "none" };
      if (${JSON.stringify(keepCursor)}) {
        try {
          cursorPrep = (${CURSOR_HELPER_SOURCE}).prepareScreenshot(true);
        } catch {}
      } else {
        const c = window[Symbol.for("cdp.bridge.cursor")];
        if (c) c.prepareScreenshot(false);
      }
      return { hidden, cursorPrep };
    })()`,
    { timeoutMs: 3_000 },
  ).catch(() => null);

  if (preState?.evaluation?.value?.hidden) {
    await callPage(page, "Page.bringToFront", {}, 5_000).catch(() => {});
  }

  let shot;
  try {
    shot = await callPage(page, "Page.captureScreenshot", params, timeoutMs);
  } finally {
    await evaluateInPage(
      page,
      `(() => { const c = window[Symbol.for("cdp.bridge.cursor")]; if (c) c.finishScreenshot(${JSON.stringify(keepCursor)}); return true; })()`,
      { timeoutMs: 3_000 },
    ).catch(() => {});
  }
  if (!shot.data) {
    throw new Error("Page.captureScreenshot returned empty image data");
  }
  const buf = Buffer.from(shot.data, "base64");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  const out = {
    page,
    saved: outPath,
    format,
    bytes: buf.length,
    clip: params.clip || null,
  };
  if (keepCursor) {
    out.cursorState = preState?.evaluation?.value?.cursorPrep || { mode: "none" };
  }
  return out;
}

async function navigatePage(page, url, options = {}) {
  const { waitMs = 1_200, timeoutMs = 30_000 } = options;
  await ensurePageMonitor(page, true);
  await callPage(page, "Page.enable", {}, Math.min(timeoutMs, 15_000));
  const navigation = await callPage(page, "Page.navigate", { url }, timeoutMs);

  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let state = null;
  await sleep(Math.min(waitMs, 400));
  while (Date.now() < deadline) {
    try {
      const res = await callPage(
        page,
        "Runtime.evaluate",
        {
          expression:
            "({href: location.href, title: document.title, readyState: document.readyState})",
          returnByValue: true,
        },
        5_000,
      );
      state = res.result?.value || null;
      if (state && state.readyState === "complete") {
        break;
      }
    } catch {
      // Ignore transient navigation context changes
    }
    await sleep(200);
  }
  if (waitMs > 400) {
    await sleep(waitMs - 400);
  }
  await ensurePageMonitor(page, false);
  return {
    page,
    navigation,
    state,
  };
}

async function reloadPage(page, options = {}) {
  const { ignoreCache = false, waitMs = 600, timeoutMs = 30_000 } = options;
  await ensurePageMonitor(page, true);
  await callPage(page, "Page.reload", { ignoreCache }, Math.min(timeoutMs, 15_000));

  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let state = null;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const res = await callPage(
        page,
        "Runtime.evaluate",
        {
          expression:
            "({href: location.href, title: document.title, readyState: document.readyState})",
          returnByValue: true,
        },
        5_000,
      );
      state = res.result?.value || null;
      if (state && state.readyState === "complete") {
        break;
      }
    } catch {
      // Ignore transient navigation context destruction
    }
  }
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  await ensurePageMonitor(page, false);
  return {
    page,
    reloaded: true,
    ignoreCache,
    state,
  };
}

async function focusPage(page, timeoutMs = 10_000) {
  await requestBridge(
    {
      id: 1,
      method: "Target.activateTarget",
      params: { targetId: page.targetId },
      timeoutMs,
    },
    timeoutMs,
  ).catch(() => {});
  await callPage(page, "Page.bringToFront", {}, timeoutMs).catch(() => {});
  await callPage(
    page,
    "Page.setWebLifecycleState",
    { state: "active" },
    timeoutMs,
  ).catch(() => {});
  await callPage(
    page,
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    timeoutMs,
  ).catch(() => {});
  return {
    page,
    focused: true,
  };
}

function dedupeBySignature(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function matchesStatusFilter(status, filterExpr) {
  if (!filterExpr) return true;
  const parts = String(filterExpr)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const p of parts) {
    if (p === "error" || p === "failed") {
      if (!status || status >= 400) return true;
    } else if (/^[1-5]xx$/.test(p)) {
      const century = Number(p[0]) * 100;
      if (status >= century && status < century + 100) return true;
    } else if (/^\d+$/.test(p)) {
      if (status === Number(p)) return true;
    }
  }
  return false;
}

async function collectPageLogs(page, options = {}) {
  const {
    includeAll = false,
    levelFilter = null,
    grepPattern = null,
    limit = 50,
    clear = false,
    timeoutMs = 15_000,
  } = options;

  await ensurePageMonitor(page, true);

  let bridgeLogs = [];
  try {
    const bRes = await requestBridge(
      {
        id: 1,
        method: "bridge.logs",
        params: { sessionId: page.sessionId, includeAll, clear },
      },
      timeoutMs,
    );
    bridgeLogs = bRes.logs || [];
  } catch {
    // Fallback to in-page monitor if bridge lacks bridge.logs
  }

  const inPage = await evaluateInPage(
    page,
    `(() => {
      const mon = window.__cdpBridgeMonitor;
      if (!mon) return [];
      const out = mon.logs.slice();
      if (${JSON.stringify(clear)}) mon.logs.length = 0;
      return out;
    })()`,
    { timeoutMs },
  );

  let combined = dedupeBySignature(
    [...bridgeLogs, ...(inPage.evaluation?.value || [])],
    (entry) => `${entry.level}|${String(entry.text || "").slice(0, 200)}`,
  );

  if (levelFilter) {
    const allowed = new Set(
      String(levelFilter)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    combined = combined.filter((l) => allowed.has(String(l.level).toLowerCase()));
  }
  if (grepPattern) {
    const rx = buildMatcher(grepPattern);
    combined = combined.filter((l) => rx.test(String(l.text || "")));
  }

  const sliced = combined.slice(-limit);
  return {
    page,
    count: sliced.length,
    logs: sliced,
  };
}

async function collectPageNetwork(page, options = {}) {
  const {
    includeAll = false,
    includeResources = false,
    urlPattern = null,
    methodFilter = null,
    typeFilter = null,
    statusFilter = null,
    limit = 50,
    clear = false,
    timeoutMs = 15_000,
  } = options;

  const needAllFromSource = includeAll || Boolean(statusFilter);
  await ensurePageMonitor(page, true);

  let bridgeNet = [];
  try {
    const bRes = await requestBridge(
      {
        id: 1,
        method: "bridge.network",
        params: { sessionId: page.sessionId, includeAll: needAllFromSource, clear },
      },
      timeoutMs,
    );
    bridgeNet = bRes.requests || [];
  } catch {
    // Fallback to in-page monitor if bridge lacks bridge.network
  }

  const inPage = await evaluateInPage(
    page,
    `(() => {
      const mon = window.__cdpBridgeMonitor;
      const captured = mon ? mon.network.slice() : [];
      if (mon && ${JSON.stringify(clear)}) mon.network.length = 0;
      const filteredCaptured = ${JSON.stringify(needAllFromSource)}
        ? captured
        : captured.filter((r) => !r.ok || r.status >= 400);

      let perfResources = [];
      if (${JSON.stringify(includeResources)}) {
        const rawPerf = performance.getEntriesByType("resource");
        const filteredPerf = ${JSON.stringify(needAllFromSource)}
          ? rawPerf
          : rawPerf.filter((e) => e.responseStatus && e.responseStatus >= 400);
        perfResources = filteredPerf.slice(-${limit}).map((e) => ({
          name: e.name,
          initiatorType: e.initiatorType,
          durationMs: Math.round(e.duration),
          transferSize: e.transferSize,
          responseStatus: e.responseStatus || undefined
        }));
      }

      return {
        captured: filteredCaptured,
        performanceResources: perfResources
      };
    })()`,
    { timeoutMs },
  );

  const val = inPage.evaluation?.value || {};
  // Prefer entries that include responseBody when deduplicating fetch failures
  const mergedRaw = [...(val.captured || []), ...bridgeNet];
  let requests = dedupeBySignature(
    mergedRaw,
    (r) => `${r.method || "GET"}|${r.url}|${r.status}`,
  );

  if (urlPattern) {
    const rx = buildMatcher(urlPattern);
    requests = requests.filter((r) => rx.test(String(r.url || "")));
  }
  if (methodFilter) {
    const methods = new Set(
      String(methodFilter)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
    requests = requests.filter((r) =>
      methods.has(String(r.method || "GET").toUpperCase()),
    );
  }
  if (typeFilter) {
    const types = new Set(
      String(typeFilter)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    requests = requests.filter((r) =>
      types.has(String(r.type || "").toLowerCase()),
    );
  }
  if (statusFilter) {
    requests = requests.filter((r) =>
      matchesStatusFilter(Number(r.status || 0), statusFilter),
    );
  }

  const sliced = requests.slice(-limit);
  const out = {
    page,
    count: sliced.length,
    failedOrCapturedRequests: sliced,
  };
  if (includeResources) {
    out.performanceResources = val.performanceResources || [];
  }
  return out;
}

function usageText() {
  return `Usage: cdp [global-options] <command> [options]

Bridge & Target Commands:
  connect [host:port | ws-url] [options]  Start/switch bridge and wait until ready (--host, --port, --ws-url, --port-file)
  start | restart | stop | status         Manage or inspect CDP bridge daemon
  pages | list | tabs [--all]             List open browser page tabs (aliases: list-pages)
  targets                                 List raw Target.getTargets info (alias: list-targets)
  open <url>                              Open URL in a new browser tab
  close <target>                          Close matching browser tab (alias: page-close)
  focus <target>                          Activate & unfreeze tab in foreground (aliases: activate, page-focus)
  call <method> [params-json] [session]   Forward raw CDP method (aliases: send, raw; supports --target <t>, --params <json>)

Page Inspection & Navigation:
  elements <target> [root-selector]       Snapshot visible interactive elements & selectors (aliases: page-elements, snapshot, snap)
  page-eval <target> [expr]               Evaluate JS in page (alias: eval; --file <path>, --stdin, --no-await, --raw)
  page-text <target> [selector]           Read page/element innerText (alias: text; --max-length <n>, --raw)
  page-screenshot <target> [out-path]     Save PNG/JPEG/WebP screenshot (aliases: screenshot, shot; --selector, --full-page, --with-cursor/--keep-cursor)
  page-navigate <target> <url>            Navigate tab to URL (aliases: navigate, goto, nav, page-goto; or --new <url>)
  page-reload <target> [--ignore-cache]   Reload page and wait until readyState is complete (alias: reload)
  page-wait <target> [selector-or-expr]   Wait for selector, --text <str>, or truthy JS expr (alias: wait; --timeout <ms>)

Page Interaction (React / Vue / Radix UI / TipTap ProseMirror compatible):
  page-fill <target> <selector> [text]    Fill input/textarea/select/contenteditable (aliases: fill, type, page-type; --clear, --append, --submit)
  page-click <target> <selector-or-text>  Click by CSS selector or visible text (alias: click; --text, --exact, --index <n>, --wait-for <sel>, --native)
  page-hover <target> <selector-or-x,y>   Move & hover pointer on element or x,y coords until user takeover (aliases: hover, move)
  batch [target] [steps-json]             Run multiple steps sequentially over one connection (--file <path> | --stdin)

Diagnostics & Telemetry:
  page-logs <target> [--all] [--clear]    Read console errors/warnings or --all logs (alias: logs; --level, --grep, --limit)
  page-network <target> [--all] [--clear] Read failed or --all network requests (alias: network; --url, --method, --type, --status, --resources)
  diag [summary|errors|tail|path|clear]   Analyze tool invocation telemetry (--days <n>, --limit <n>, --cmd <name>, --agent <name>)

Global Options (accepted before or after <command>):
  -t, --target <target>                   Target ID/prefix, URL substring/regex, or title substring/regex
  --socket <path>                         Override bridge socket/pipe path (env: CDP_BRIDGE_SOCKET)
  --timeout <ms>                          Command timeout in milliseconds
  --no-auto-start                         Disable on-demand auto-start when bridge daemon is not running
  --no-diag                               Skip writing invocation record to logs/diag.jsonl (env: CDP_DIAG=0)
  --cursor <fast|demo|persist|off>        Visual pointer overlay mode (default: fast; fades out smoothly on user takeover)
  --no-cursor                             Disable visual pointer overlay on click/fill/hover
  --with-cursor, --keep-cursor            Retain/restore simulated pointer state & highlight in screenshot
  --raw                                   Print raw value/text directly without JSON envelope (for eval / text)
  -c, --compact                           Print compact single-line JSON output`;
}

async function runBatchSteps(defaultTarget, stepsInput, options = {}) {
  const {
    continueOnError = false,
    defaultTimeoutMs = 15_000,
    defaultCursorMode = resolveCursorMode(),
  } = options;
  let steps;
  const trimmed = String(stepsInput || "").trim();
  if (trimmed.startsWith("[")) {
    steps = parseJson(trimmed, "batch steps");
  } else {
    steps = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l, idx) => parseJson(l, `batch line ${idx + 1}`));
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("Batch input must be a non-empty JSON array or NDJSON of step objects");
  }

  let currentPage = defaultTarget ? await resolvePage(defaultTarget) : null;
  const results = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] || {};
    const cmd = String(step.cmd || step.action || step.type || "").toLowerCase();
    const stepTimeout = step.timeoutMs || step.timeout || defaultTimeoutMs;

    try {
      if (step.target) {
        currentPage = await resolvePage(String(step.target));
      }
      if (cmd === "sleep") {
        const ms = Number(step.ms ?? step.durationMs ?? 200);
        await sleep(ms);
        results.push({ index: i, cmd, ok: true, sleptMs: ms });
        continue;
      }
      if (cmd === "open") {
        const created = await requestBridge({
          id: 1,
          method: "Target.createTarget",
          params: { url: step.url },
        });
        await sleep(800);
        currentPage = await resolvePage(created.targetId);
        await ensurePageMonitor(currentPage, true);
        results.push({ index: i, cmd, ok: true, targetId: currentPage.targetId, url: currentPage.url });
        continue;
      }

      if (!currentPage) {
        throw new Error(`Step ${i} (${cmd}) requires a target (pass <target> to batch or "target" on step)`);
      }

      let stepRes;
      if (cmd === "eval" || cmd === "page-eval") {
        const ev = await evaluateInPage(
          currentPage,
          step.expr ?? step.expression,
          { awaitPromise: step.awaitPromise !== false, timeoutMs: stepTimeout },
        );
        stepRes = { value: ev.evaluation?.value, exceptionDetails: ev.exceptionDetails };
      } else if (cmd === "click" || cmd === "page-click") {
        const ck = await clickInPage(
          currentPage,
          step.selector ?? step.text ?? step.query,
          {
            byText: Boolean(step.byText || (step.text && !step.selector)),
            exact: Boolean(step.exact),
            index: step.index ?? 0,
            waitMs: step.waitMs ?? step.wait ?? 0,
            waitFor: step.waitFor ?? null,
            nativeMouse: Boolean(step.native),
            cursorMode: step.cursor ? resolveCursorMode({ cursor: step.cursor }) : defaultCursorMode,
            timeoutMs: stepTimeout,
          },
        );
        const { page: _p, ...rest } = ck;
        stepRes = rest;
      } else if (cmd === "hover" || cmd === "page-hover" || cmd === "move") {
        const hv = await hoverInPage(
          currentPage,
          step.selector ?? step.coords ?? step.text ?? `${step.x},${step.y}`,
          {
            byText: Boolean(step.byText || (step.text && !step.selector)),
            exact: Boolean(step.exact),
            index: step.index ?? 0,
            persist: step.persist !== false,
            nativeMouse: Boolean(step.native),
            cursorMode: step.cursor ? resolveCursorMode({ cursor: step.cursor }) : defaultCursorMode,
            timeoutMs: stepTimeout,
          },
        );
        const { page: _p, ...rest } = hv;
        stepRes = rest;
      } else if (cmd === "fill" || cmd === "page-fill" || cmd === "type" || cmd === "page-type") {
        const fl = await fillInPage(currentPage, step.selector, step.text ?? step.value ?? "", {
          clear: Boolean(step.clear),
          append: Boolean(step.append),
          submit: Boolean(step.submit),
          submitSelector: step.submitSelector ?? null,
          cursorMode: step.cursor ? resolveCursorMode({ cursor: step.cursor }) : defaultCursorMode,
          timeoutMs: stepTimeout,
        });
        const { page: _p, ...rest } = fl;
        stepRes = rest;
      } else if (cmd === "wait" || cmd === "page-wait") {
        const wt = await waitOnPage(
          currentPage,
          step.selector ?? step.expr ?? "",
          { timeoutMs: stepTimeout, expectedText: step.text },
        );
        const { page: _p, ...rest } = wt;
        stepRes = rest;
      } else if (cmd === "text" || cmd === "page-text") {
        const tx = await readPageText(
          currentPage,
          step.selector,
          step.maxLength ?? 50_000,
          stepTimeout,
        );
        const { page: _p, ...rest } = tx;
        stepRes = rest;
      } else if (cmd === "elements" || cmd === "page-elements" || cmd === "snapshot") {
        const elRes = await inspectPageElements(currentPage, {
          rootSelector: step.selector ?? step.root ?? null,
          includeHidden: Boolean(step.all),
          limit: step.limit ?? 80,
          timeoutMs: stepTimeout,
        });
        const { page: _p, ...rest } = elRes;
        stepRes = rest;
      } else if (cmd === "screenshot" || cmd === "page-screenshot" || cmd === "shot") {
        const sh = await capturePageScreenshot(
          currentPage,
          step.path ?? step.outPath,
          step,
          stepTimeout,
        );
        const { page: _p, ...rest } = sh;
        stepRes = rest;
      } else if (cmd === "navigate" || cmd === "page-navigate" || cmd === "goto" || cmd === "nav") {
        const nv = await navigatePage(currentPage, step.url, {
          waitMs: step.waitMs ?? 1_200,
          timeoutMs: stepTimeout,
        });
        const { page: _p, ...rest } = nv;
        stepRes = rest;
      } else if (cmd === "reload" || cmd === "page-reload") {
        const rl = await reloadPage(currentPage, {
          ignoreCache: Boolean(step.ignoreCache || step.hard),
          waitMs: step.waitMs ?? 600,
          timeoutMs: stepTimeout,
        });
        const { page: _p, ...rest } = rl;
        stepRes = rest;
      } else if (cmd === "focus" || cmd === "activate") {
        const fc = await focusPage(currentPage, stepTimeout);
        const { page: _p, ...rest } = fc;
        stepRes = rest;
      } else if (cmd === "logs" || cmd === "page-logs") {
        const lg = await collectPageLogs(currentPage, {
          includeAll: Boolean(step.all),
          levelFilter: step.level,
          grepPattern: step.grep,
          limit: step.limit ?? 50,
          clear: Boolean(step.clear),
          timeoutMs: stepTimeout,
        });
        const { page: _p, ...rest } = lg;
        stepRes = rest;
      } else if (cmd === "network" || cmd === "page-network") {
        const nw = await collectPageNetwork(currentPage, {
          includeAll: Boolean(step.all),
          includeResources: Boolean(step.resources),
          urlPattern: step.url,
          methodFilter: step.method,
          typeFilter: step.requestType,
          statusFilter: step.status,
          limit: step.limit ?? 50,
          clear: Boolean(step.clear),
          timeoutMs: stepTimeout,
        });
        const { page: _p, ...rest } = nw;
        stepRes = rest;
      } else if (cmd === "call" || cmd === "send" || cmd === "raw") {
        stepRes = await callPage(
          currentPage,
          step.method,
          step.params || {},
          stepTimeout,
        );
      } else {
        throw new Error(`Unknown batch step cmd: "${cmd}"`);
      }

      results.push({ index: i, cmd, ok: true, ...stepRes });
    } catch (error) {
      results.push({ index: i, cmd, ok: false, error: error.message });
      if (!continueOnError) {
        const batchErr = new Error(
          `Batch failed at step ${i} (${cmd}): ${error.message}`,
        );
        batchErr.partialResults = {
          page: currentPage,
          completedSteps: i,
          totalSteps: steps.length,
          results,
        };
        throw batchErr;
      }
    }
  }

  return {
    page: currentPage,
    completedSteps: results.length,
    totalSteps: steps.length,
    results,
  };
}

async function main() {
  const { globalFlags, command, restArgs } = extractLeadingGlobalFlags(rawArgs);
  resolvedCommandName = command || "help";
  if (globalFlags.socket) {
    socketOverride = globalFlags.socket;
    process.env.CDP_BRIDGE_SOCKET = globalFlags.socket;
  }

  if (!command || command === "help" || globalFlags.help) {
    console.log(usageText());
    return { outputMode: "none", data: null };
  }

  const { flags: probeHelp } = parseFlags(restArgs, ["help"], globalFlags);
  if (probeHelp.help) {
    resolvedCommandName = "help";
    console.log(usageText());
    return { outputMode: "none", data: null };
  }

  if (command === "diag") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["all-files"],
      globalFlags,
    );
    const data = runDiagCommand(positional, flags);
    return {
      outputMode: flags.raw ? "raw" : flags.compact ? "compact" : "pretty",
      data,
    };
  }

  if (
    command === "connect" ||
    command === "start" ||
    command === "restart" ||
    command === "stop"
  ) {
    if (command === "connect" || command === "restart" || command === "stop") {
      saveClientSessions({});
    }
    const forwardArgs = [...restArgs];
    if (globalFlags.timeout && !forwardArgs.includes("--timeout") && !forwardArgs.includes("--wait-ms")) {
      forwardArgs.push("--timeout", String(globalFlags.timeout));
    }
    const res = spawnSync(
      process.execPath,
      [bridgeScriptPath, command, ...forwardArgs],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
    if (res.status !== 0) {
      process.exitCode = res.status || 1;
    }
    return { outputMode: "none", data: null };
  }

  const formatMode = (flags) =>
    flags.raw ? "raw" : flags.compact ? "compact" : "pretty";

  if (command === "status") {
    const { flags } = parseFlags(
      restArgs,
      ["ensure", "auto-start"],
      globalFlags,
    );
    const data = await requestBridge(
      { id: 1, method: "bridge.status" },
      resolveTimeoutMs(flags, 10_000),
      { allowAutoStart: Boolean(flags.ensure || flags["auto-start"]) },
    );
    return { outputMode: formatMode(flags), data };
  }

  if (command === "targets" || command === "list-targets") {
    const { flags } = parseFlags(restArgs, [], globalFlags);
    const data = await requestBridge(
      { id: 1, method: "Target.getTargets" },
      resolveTimeoutMs(flags, 10_000),
    );
    return { outputMode: formatMode(flags), data };
  }

  if (
    command === "pages" ||
    command === "list" ||
    command === "tabs" ||
    command === "list-pages"
  ) {
    const { flags } = parseFlags(restArgs, ["all"], globalFlags);
    const allTargets = await fetchAllTargets(resolveTimeoutMs(flags, 10_000));
    const list = allTargets.filter((t) =>
      flags.all ? true : t.type === "page",
    );
    return {
      outputMode: formatMode(flags),
      data: {
        count: list.length,
        pages: list.map((t) => ({
          targetId: t.targetId,
          type: t.type,
          title: t.title,
          url: t.url,
          attached: t.attached,
        })),
      },
    };
  }

  if (command === "open" || command === "page-open") {
    const { flags, positional } = parseFlags(restArgs, ["background"], globalFlags);
    const url = positional[0] || (typeof flags.url === "string" ? flags.url : "");
    if (!url) {
      throw new Error("Usage: cdp open <url> [--background]");
    }
    const timeoutMs = resolveTimeoutMs(flags, 20_000);
    const created = await requestBridge(
      {
        id: 1,
        method: "Target.createTarget",
        params: { url, background: Boolean(flags.background) },
      },
      timeoutMs,
    );
    await sleep(800);
    const page = await resolvePage(created.targetId);
    await ensurePageMonitor(page, true);
    return {
      outputMode: formatMode(flags),
      data: { created: true, page },
    };
  }

  if (command === "close" || command === "page-close") {
    const { flags, positional } = parseFlags(restArgs, [], globalFlags);
    const { targetQuery } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error("Usage: cdp close <target>");
    }
    const timeoutMs = resolveTimeoutMs(flags, 10_000);
    const page = await resolvePage(targetQuery);
    const closed = await requestBridge(
      {
        id: 1,
        method: "Target.closeTarget",
        params: { targetId: page.targetId },
      },
      timeoutMs,
    );
    const cached = loadClientSessions();
    delete cached[page.targetId];
    saveClientSessions(cached);
    return {
      outputMode: formatMode(flags),
      data: {
        closed: closed.success !== false,
        targetId: page.targetId,
        title: page.title,
        url: page.url,
      },
    };
  }

  if (
    command === "focus" ||
    command === "activate" ||
    command === "page-focus" ||
    command === "page-activate"
  ) {
    const { flags, positional } = parseFlags(restArgs, [], globalFlags);
    const { targetQuery } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error("Usage: cdp focus <target>");
    }
    const page = await resolvePage(targetQuery);
    const data = await focusPage(page, resolveTimeoutMs(flags, 10_000));
    return { outputMode: formatMode(flags), data };
  }

  if (command === "call" || command === "send" || command === "raw") {
    const { flags, positional } = parseFlags(restArgs, [], globalFlags);
    let method = positional[0];
    let paramsJson =
      typeof flags.params === "string" ? flags.params : positional[1];
    let sessionId = flags["session-id"] || positional[2];

    // Support `send <sessionId-or-target> <Domain.method> [paramsJson]`
    if (
      method &&
      !method.includes(".") &&
      positional[1] &&
      positional[1].includes(".")
    ) {
      const targetOrSession = positional[0];
      method = positional[1];
      paramsJson =
        typeof flags.params === "string" ? flags.params : positional[2];
      if (/^[0-9a-f]{32}$/i.test(targetOrSession)) {
        try {
          const all = await fetchAllTargets();
          const matching = all.find(
            (p) => p.targetId.toLowerCase() === targetOrSession.toLowerCase(),
          );
          if (matching) {
            const resolved = await resolvePage(targetOrSession);
            sessionId = resolved.sessionId;
          } else {
            sessionId = targetOrSession;
          }
        } catch {
          sessionId = targetOrSession;
        }
      } else {
        const resolved = await resolvePage(targetOrSession);
        sessionId = resolved.sessionId;
      }
    } else if (flags.target && !sessionId) {
      const resolved = await resolvePage(String(flags.target));
      sessionId = resolved.sessionId;
    }

    if (!method) {
      throw new Error(
        "Usage: cdp call <Domain.method> [params-json] [session-id] [--target <target>]",
      );
    }

    const timeoutMs = resolveTimeoutMs(flags, 15_000);
    const data = await requestBridge(
      {
        id: 1,
        method,
        params: parseJson(paramsJson, "params"),
        sessionId,
        timeoutMs,
      },
      timeoutMs,
    );
    return { outputMode: formatMode(flags), data };
  }

  if (
    command === "elements" ||
    command === "page-elements" ||
    command === "snapshot" ||
    command === "snap"
  ) {
    const { flags, positional } = parseFlags(
      restArgs,
      ["all", "include-hidden"],
      globalFlags,
    );
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error(
        "Usage: cdp elements <target> [root-selector] [--all] [--limit <n>]",
      );
    }
    const rootSelector =
      restPositional[0] ||
      (typeof flags.selector === "string" ? flags.selector : null);
    const limit = flags.limit ? Number(flags.limit) : 80;
    const page = await resolvePage(targetQuery);
    const data = await inspectPageElements(page, {
      rootSelector,
      includeHidden: Boolean(flags.all || flags["include-hidden"]),
      limit,
      timeoutMs: resolveTimeoutMs(flags, 15_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-eval" || command === "eval") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["stdin", "no-await"],
      globalFlags,
    );
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error(
        "Usage: cdp page-eval <target> <expression> [--file <path> | --stdin] [--timeout <ms>] [--raw]",
      );
    }
    const expression = readInputSource(restPositional[0], flags, "expression");
    const page = await resolvePage(targetQuery);
    const data = await evaluateInPage(page, expression, {
      awaitPromise: !flags["no-await"],
      timeoutMs: resolveTimeoutMs(flags, 15_000),
    });
    if (flags.raw) {
      if (data.exceptionDetails) {
        throw new Error(
          data.exceptionDetails.exception?.description ||
            data.exceptionDetails.text ||
            "Evaluation threw an exception",
        );
      }
      return { outputMode: "raw", data: data.evaluation?.value };
    }
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-text" || command === "text") {
    const { flags, positional } = parseFlags(restArgs, [], globalFlags);
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error(
        "Usage: cdp page-text <target> [selector] [--max-length <n>] [--raw]",
      );
    }
    const selector =
      restPositional[0] ||
      (typeof flags.selector === "string" ? flags.selector : undefined);
    const maxLen = flags["max-length"] ? Number(flags["max-length"]) : 50_000;
    const page = await resolvePage(targetQuery);
    const data = await readPageText(
      page,
      selector,
      maxLen,
      resolveTimeoutMs(flags, 15_000),
    );
    if (flags.raw) {
      return { outputMode: "raw", data: data.text ?? "" };
    }
    return { outputMode: formatMode(flags), data };
  }

  if (
    command === "page-screenshot" ||
    command === "screenshot" ||
    command === "shot"
  ) {
    const { flags, positional } = parseFlags(
      restArgs,
      ["full-page", "with-cursor"],
      globalFlags,
    );
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error(
        "Usage: cdp page-screenshot <target> [output-path] [--selector <css>] [--full-page] [--format png|jpeg|webp]",
      );
    }
    const outPathArg =
      restPositional[0] ||
      (typeof flags.output === "string" ? flags.output : undefined);
    const page = await resolvePage(targetQuery);
    const data = await capturePageScreenshot(
      page,
      outPathArg,
      flags,
      resolveTimeoutMs(flags, 30_000),
    );
    return { outputMode: formatMode(flags), data };
  }

  if (
    command === "page-fill" ||
    command === "fill" ||
    command === "page-type" ||
    command === "type"
  ) {
    const { flags, positional } = parseFlags(
      restArgs,
      ["stdin", "submit", "clear", "append"],
      globalFlags,
    );
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    const [selector, textArg] = restPositional;
    if (!targetQuery || !selector) {
      throw new Error(
        "Usage: cdp page-fill <target> <selector> [text] [--file <path> | --stdin] [--clear] [--append] [--submit]",
      );
    }
    const text = flags.clear ? "" : readInputSource(textArg, flags, "text");
    const page = await resolvePage(targetQuery);
    const data = await fillInPage(page, selector, text, {
      clear: Boolean(flags.clear),
      append: Boolean(flags.append),
      submit: Boolean(flags.submit),
      submitSelector:
        typeof flags["submit-selector"] === "string"
          ? flags["submit-selector"]
          : null,
      cursorMode: resolveCursorMode(flags),
      timeoutMs: resolveTimeoutMs(flags, 15_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-click" || command === "click") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["text", "exact", "include-hidden", "native"],
      globalFlags,
    );
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    const selectorOrText = restPositional[0];
    if (!targetQuery || !selectorOrText) {
      throw new Error(
        "Usage: cdp page-click <target> <selector-or-text> [--text] [--exact] [--index <n>] [--wait <ms>] [--wait-for <sel>] [--native]",
      );
    }
    const page = await resolvePage(targetQuery);
    const data = await clickInPage(page, selectorOrText, {
      byText: Boolean(flags.text),
      exact: Boolean(flags.exact),
      index: flags.index !== undefined ? Number(flags.index) : 0,
      waitMs: flags.wait !== undefined ? Number(flags.wait) : 0,
      waitFor:
        typeof flags["wait-for"] === "string" ? flags["wait-for"] : null,
      includeHidden: Boolean(flags["include-hidden"]),
      nativeMouse: Boolean(flags.native),
      cursorMode: resolveCursorMode(flags),
      timeoutMs: resolveTimeoutMs(flags, 15_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-hover" || command === "hover" || command === "move") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["text", "exact", "native", "auto-hide"],
      globalFlags,
    );
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    const targetSpec = restPositional[0];
    if (!targetQuery || !targetSpec) {
      throw new Error(
        "Usage: cdp hover <target> <selector-or-x,y> [--text] [--exact] [--index <n>] [--auto-hide] [--native]",
      );
    }
    const page = await resolvePage(targetQuery);
    const data = await hoverInPage(page, targetSpec, {
      byText: Boolean(flags.text),
      exact: Boolean(flags.exact),
      index: flags.index !== undefined ? Number(flags.index) : 0,
      persist: !flags["auto-hide"],
      nativeMouse: Boolean(flags.native),
      cursorMode: resolveCursorMode(flags),
      timeoutMs: resolveTimeoutMs(flags, 15_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-reload" || command === "reload") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["ignore-cache", "hard"],
      globalFlags,
    );
    const { targetQuery } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error(
        "Usage: cdp page-reload <target> [--ignore-cache] [--wait-ms <ms>]",
      );
    }
    const page = await resolvePage(targetQuery);
    const data = await reloadPage(page, {
      ignoreCache: Boolean(flags["ignore-cache"] || flags.hard),
      waitMs: flags["wait-ms"] !== undefined ? Number(flags["wait-ms"]) : 600,
      timeoutMs: resolveTimeoutMs(flags, 30_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-wait" || command === "wait") {
    const { flags, positional } = parseFlags(restArgs, [], globalFlags);
    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    const selectorOrExpr = restPositional[0] || "";
    const expectedText =
      typeof flags.text === "string" ? flags.text : undefined;
    if (!targetQuery || (!selectorOrExpr && !expectedText)) {
      throw new Error(
        "Usage: cdp page-wait <target> [selector-or-expr] [--text <substring>] [--timeout <ms>]",
      );
    }
    const page = await resolvePage(targetQuery);
    const data = await waitOnPage(page, selectorOrExpr, {
      timeoutMs: resolveTimeoutMs(flags, 10_000),
      expectedText,
    });
    return { outputMode: formatMode(flags), data };
  }

  if (
    command === "page-navigate" ||
    command === "navigate" ||
    command === "goto" ||
    command === "nav" ||
    command === "page-goto"
  ) {
    const { flags, positional } = parseFlags(restArgs, ["new"], globalFlags);
    if (flags.new) {
      const url = typeof flags.new === "string" ? flags.new : positional[0];
      if (!url) {
        throw new Error("Usage: cdp page-navigate --new <url>");
      }
      const created = await requestBridge(
        {
          id: 1,
          method: "Target.createTarget",
          params: { url },
        },
        resolveTimeoutMs(flags, 20_000),
      );
      await sleep(800);
      const page = await resolvePage(created.targetId);
      await ensurePageMonitor(page, true);
      return {
        outputMode: formatMode(flags),
        data: { created: true, page },
      };
    }

    const { targetQuery, restPositional } = takeTargetArg(positional, flags);
    const url = restPositional[0];
    if (!targetQuery || !url) {
      throw new Error("Usage: cdp page-navigate <target> <url>");
    }
    const page = await resolvePage(targetQuery);
    const data = await navigatePage(page, url, {
      waitMs: flags["wait-ms"] !== undefined ? Number(flags["wait-ms"]) : 1_200,
      timeoutMs: resolveTimeoutMs(flags, 30_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-logs" || command === "logs") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["clear", "all"],
      globalFlags,
    );
    const { targetQuery } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error(
        "Usage: cdp page-logs <target> [--all] [--level <err,warn,log>] [--grep <regex>] [--clear] [--limit <n>]",
      );
    }
    const page = await resolvePage(targetQuery);
    const data = await collectPageLogs(page, {
      includeAll: Boolean(flags.all),
      levelFilter: typeof flags.level === "string" ? flags.level : null,
      grepPattern: typeof flags.grep === "string" ? flags.grep : null,
      limit: flags.limit ? Number(flags.limit) : 50,
      clear: Boolean(flags.clear),
      timeoutMs: resolveTimeoutMs(flags, 15_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "page-network" || command === "network") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["all", "clear", "resources"],
      globalFlags,
    );
    const { targetQuery } = takeTargetArg(positional, flags);
    if (!targetQuery) {
      throw new Error(
        "Usage: cdp page-network <target> [--all] [--url <regex>] [--method <verb>] [--type <fetch,xhr>] [--status <4xx,5xx,200>] [--resources] [--clear] [--limit <n>]",
      );
    }
    const page = await resolvePage(targetQuery);
    const data = await collectPageNetwork(page, {
      includeAll: Boolean(flags.all),
      includeResources: Boolean(flags.resources),
      urlPattern: typeof flags.url === "string" ? flags.url : null,
      methodFilter: typeof flags.method === "string" ? flags.method : null,
      typeFilter: typeof flags.type === "string" ? flags.type : null,
      statusFilter: typeof flags.status === "string" ? flags.status : null,
      limit: flags.limit ? Number(flags.limit) : 50,
      clear: Boolean(flags.clear),
      timeoutMs: resolveTimeoutMs(flags, 15_000),
    });
    return { outputMode: formatMode(flags), data };
  }

  if (command === "batch") {
    const { flags, positional } = parseFlags(
      restArgs,
      ["stdin", "continue-on-error"],
      globalFlags,
    );
    let defaultTarget =
      typeof flags.target === "string" ? flags.target : undefined;
    let stepsArg;
    if (!defaultTarget && positional.length >= 2) {
      defaultTarget = positional[0];
      stepsArg = positional[1];
    } else if (!defaultTarget && positional.length === 1) {
      if (positional[0].trim().startsWith("[") || positional[0].trim().startsWith("{")) {
        stepsArg = positional[0];
      } else {
        defaultTarget = positional[0];
      }
    } else {
      stepsArg = positional[0];
    }
    const stepsInput = readInputSource(stepsArg, flags, "batch steps JSON");
    const data = await runBatchSteps(defaultTarget, stepsInput, {
      continueOnError: Boolean(flags["continue-on-error"]),
      defaultTimeoutMs: resolveTimeoutMs(flags, 15_000),
      defaultCursorMode: resolveCursorMode(flags),
    });
    return { outputMode: formatMode(flags), data };
  }

  throw new Error(`Unknown command: ${command}\n\n${usageText()}`);
}

try {
  const { outputMode, data } = await main();
  let outputText = "";
  if (outputMode === "raw") {
    if (typeof data === "string") {
      outputText = data;
      console.log(data);
    } else if (data !== undefined) {
      outputText = JSON.stringify(data);
      console.log(outputText);
    }
  } else if (outputMode === "compact" && data !== null) {
    outputText = JSON.stringify(data);
    console.log(outputText);
  } else if (outputMode === "pretty" && data !== null) {
    outputText = JSON.stringify(data, null, 2);
    console.log(outputText);
  }
  recordCliInvocation({
    startTimeMs: cliStartTimeMs,
    rawArgs,
    rawCommand: resolvedCommandName,
    data,
    outputBytes: outputText ? Buffer.byteLength(outputText, "utf8") : 0,
    exitCode: process.exitCode || 0,
    error: null,
    telemetry: diagTelemetry,
    logPathOverride: diagLogOverride || undefined,
    disabled: diagDisabled,
  });
} catch (error) {
  if (error.partialResults) {
    console.error(JSON.stringify(error.partialResults, null, 2));
  }
  console.error(error.stack || error.message);
  process.exitCode = 1;
  recordCliInvocation({
    startTimeMs: cliStartTimeMs,
    rawArgs,
    rawCommand: resolvedCommandName || rawArgs[0] || "(none)",
    data: error.partialResults || null,
    outputBytes: 0,
    exitCode: 1,
    error,
    telemetry: diagTelemetry,
    logPathOverride: diagLogOverride || undefined,
    disabled: diagDisabled,
  });
}
