#!/usr/bin/env node

/**
 * Antigravity PreToolUse Guard Hook for cdp-bridge.
 * Blocks direct HTTP/WebSocket/Playwright/Puppeteer connections to raw browser
 * CDP debugging endpoints (e.g. 127.0.0.1:9222/json or /devtools/browser/...)
 * that would trigger duplicate browser approval prompts or HTTP_PROXY 502 errors,
 * guiding the agent to use the `cdp` CLI over the persistent local bridge instead.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_TOOLS = new Set(["run_command", "bash", "shell"]);

const HTTP_CLIENTS_RE =
  /^(?:curl|curl\.exe|wget|invoke-webrequest|iwr|invoke-restmethod|irm)$/i;
const WS_CLIENTS_RE = /^(?:wscat|websocat)$/i;
const SCRIPT_RUNNERS_RE =
  /^(?:python\d*(?:\.\d+)?|py|uv|node|deno|bun|tsx)$/i;

const DIRECT_CDP_HTTP_RE =
  /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):9222(?:\/(?:json|devtools)\b|\/?(?:\s|$|["']))/i;
const DIRECT_CDP_JSON_ANY_PORT_RE =
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/json\/(?:version|list|new|protocol)\b/i;
const DIRECT_CDP_WS_URL_RE =
  /wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):\d{2,5}\/devtools\/(?:browser|page)\b/i;
const DIRECT_AUTOMATION_CALL_RE =
  /\b(?:connect_over_cdp|connectOverCDP|puppeteer\.connect|websockets\.connect)\s*\(/;
const DIRECT_CDP_TARGET_HINT_RE =
  /(?:\b9222\b|\/devtools\/(?:browser|page)|DevToolsActivePort)/;

const DENY_REASON =
  "Direct connection to the browser CDP debugging port (e.g. 127.0.0.1:9222 or /devtools/browser) is blocked by the cdp-bridge plugin to avoid duplicate browser approval prompts and HTTP_PROXY 502 errors. Use the `cdp` CLI instead (e.g. `cdp pages`, `cdp elements <target>`, `cdp click <target> <selector>`, `cdp eval <target> <expr>`, or `cdp call Browser.getVersion`). Set CDP_ALLOW_DIRECT=1 if raw port access is intentionally required.";

export function extractLeadingExecutable(segment) {
  let rest = String(segment || "").trim();
  if (!rest || rest.startsWith("#")) return "";

  // Strip leading subshell parens or Grouping
  rest = rest.replace(/^[({\s]+/, "");

  // Strip leading env assignments (KEY=val, KEY="val", KEY='val') and wrappers (`env`, `nohup`, `command`)
  const tokenRe =
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)|env|nohup|command)\s+/;
  while (tokenRe.test(rest)) {
    rest = rest.replace(tokenRe, "").trimStart();
  }

  // Strip `timeout <duration>` wrapper if present
  rest = rest.replace(/^timeout(?:\s+-[^\s]+)*\s+\d+[smhd]?\s+/i, "");

  const match = rest.match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|&()]+))/);
  if (!match) return "";
  const rawExec = match[1] || match[2] || match[3] || "";
  return path.posix.basename(rawExec.replace(/\\/g, "/"));
}

export function evaluateCdpGuard(toolName, toolArgs = {}, env = process.env) {
  const normalizedTool = String(toolName || "").trim().toLowerCase();
  if (!COMMAND_TOOLS.has(normalizedTool)) {
    return { decision: "allow" };
  }

  const commandLine = String(
    toolArgs?.CommandLine ?? toolArgs?.command ?? "",
  ).trim();
  if (!commandLine) {
    return { decision: "allow" };
  }

  if (
    String(env?.CDP_ALLOW_DIRECT || "").trim() === "1" ||
    /\bCDP_ALLOW_DIRECT\s*=\s*1\b/.test(commandLine)
  ) {
    return { decision: "allow" };
  }

  const segments = commandLine.split(/(?:\r?\n|;|&&|\|\||\|)/);
  let hasScriptRunner = false;

  for (const seg of segments) {
    const execName = extractLeadingExecutable(seg);
    if (!execName) continue;

    if (
      HTTP_CLIENTS_RE.test(execName) &&
      (DIRECT_CDP_HTTP_RE.test(seg) || DIRECT_CDP_JSON_ANY_PORT_RE.test(seg))
    ) {
      return { decision: "deny", reason: DENY_REASON };
    }

    if (WS_CLIENTS_RE.test(execName) && DIRECT_CDP_WS_URL_RE.test(seg)) {
      return { decision: "deny", reason: DENY_REASON };
    }

    if (SCRIPT_RUNNERS_RE.test(execName)) {
      hasScriptRunner = true;
    }
  }

  if (
    hasScriptRunner &&
    DIRECT_AUTOMATION_CALL_RE.test(commandLine) &&
    DIRECT_CDP_TARGET_HINT_RE.test(commandLine)
  ) {
    return { decision: "deny", reason: DENY_REASON };
  }

  return { decision: "allow" };
}

function writeOutput(result) {
  const payload = { decision: result.decision || "allow" };
  if (result.reason) {
    payload.reason = result.reason;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const input = await readStdinJson();
  const toolCall = input?.toolCall || {};
  const res = evaluateCdpGuard(toolCall.name, toolCall.args, process.env);
  writeOutput(res);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(() => {
    writeOutput({ decision: "allow" });
  });
}
