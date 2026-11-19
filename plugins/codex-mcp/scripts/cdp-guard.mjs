#!/usr/bin/env node

/**
 * OpenAI Codex PreToolUse Guard Hook for cdp-bridge.
 * Blocks direct HTTP/WebSocket/Playwright/Puppeteer connections to raw browser
 * CDP debugging endpoints (e.g. 127.0.0.1:9222/json or /devtools/browser/...)
 * that would trigger duplicate browser approval prompts or HTTP_PROXY 502 errors,
 * guiding Codex to use the `cdp` CLI (or `cdp-bridge` MCP tools) instead.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_TOOLS = new Set(["bash", "shell", "exec", "run_command"]);

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
  "Direct connection to the browser CDP debugging port (e.g. 127.0.0.1:9222 or /devtools/browser) is blocked by the cdp-bridge Codex plugin to prevent duplicate browser approval prompts and HTTP_PROXY 502 errors. Use the `cdp` CLI (e.g. `cdp pages`, `cdp elements <target>`, `cdp click`, `cdp eval`) or `cdp-bridge` MCP tools instead. Set CDP_ALLOW_DIRECT=1 if raw port access is intentionally required.";

export function extractLeadingExecutable(segment) {
  let rest = String(segment || "").trim();
  if (!rest || rest.startsWith("#")) return "";

  rest = rest.replace(/^[({\s]+/, "");

  const tokenRe =
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)|env|nohup|command)\s+/;
  while (tokenRe.test(rest)) {
    rest = rest.replace(tokenRe, "").trimStart();
  }

  rest = rest.replace(/^timeout(?:\s+-[^\s]+)*\s+\d+[smhd]?\s+/i, "");

  const match = rest.match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|&()]+))/);
  if (!match) return "";
  const rawExec = match[1] || match[2] || match[3] || "";
  return path.posix.basename(rawExec.replace(/\\/g, "/"));
}

export function evaluateCodexPreToolUse(event = {}, env = process.env) {
  const toolName = String(
    event.tool_name ?? event.toolName ?? event.name ?? event.tool ?? "",
  )
    .trim()
    .toLowerCase();

  if (!SHELL_TOOLS.has(toolName)) {
    return {};
  }

  const toolInput = event.tool_input ?? event.toolInput ?? event.input ?? {};
  const commandLine = String(
    toolInput.command ?? toolInput.cmd ?? toolInput.CommandLine ?? "",
  ).trim();
  if (!commandLine) {
    return {};
  }

  if (
    String(env?.CDP_ALLOW_DIRECT || "").trim() === "1" ||
    /\bCDP_ALLOW_DIRECT\s*=\s*1\b/.test(commandLine)
  ) {
    return {};
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
      return buildDenyEnvelope(DENY_REASON);
    }

    if (WS_CLIENTS_RE.test(execName) && DIRECT_CDP_WS_URL_RE.test(seg)) {
      return buildDenyEnvelope(DENY_REASON);
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
    return buildDenyEnvelope(DENY_REASON);
  }

  return {};
}

function buildDenyEnvelope(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function readHookInputSync() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntrypoint()) {
  const out = evaluateCodexPreToolUse(readHookInputSync(), process.env);
  if (Object.keys(out).length > 0) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}
