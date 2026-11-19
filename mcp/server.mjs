#!/usr/bin/env node

/**
 * Zero-dependency Stdio Model Context Protocol (MCP) Server for cdp-bridge.
 *
 * Architecture:
 * - Thin, stateless JSON-RPC 2.0 frontend over the persistent `cdp-bridge`
 *   background daemon (Unix Socket on Linux/WSL2/macOS, Named Pipe on Windows).
 * - Preserves single-handshake browser remote debugging across multiple agent
 *   windows and CLI terminals while completely eliminating PowerShell/CMD/sh
 *   argument quoting and CP936/UTF-8 encoding issues via direct UTF-8 pipes.
 * - Auto-detects both newline-delimited JSON-RPC (MCP 2024-11-05 / 2025-03-26 /
 *   2025-06-18) and Content-Length header framing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchMcpToolCall, MCP_TOOLS } from "./tools.mjs";

const mcpDir = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(mcpDir, "..", "package.json");
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "1.5.0";
  } catch {
    return "1.5.0";
  }
})();

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

let framingMode = null; // "line" | "content-length"
let clientCallerLabel = "mcp";

function parseCliOverrides(argv) {
  const envOverrides = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--socket" && i + 1 < argv.length) {
      envOverrides.CDP_BRIDGE_SOCKET = argv[++i];
    } else if (arg.startsWith("--socket=")) {
      envOverrides.CDP_BRIDGE_SOCKET = arg.slice("--socket=".length);
    } else if (arg === "--no-cursor") {
      envOverrides.CDP_CURSOR = "off";
    } else if (arg === "--cursor" && i + 1 < argv.length) {
      envOverrides.CDP_CURSOR = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: cdp-mcp [--socket <path-or-pipe>] [--cursor <fast|demo|persist|off>] [--no-cursor]\n",
      );
      process.exit(0);
    }
  }
  return envOverrides;
}

const cliEnvOverrides = parseCliOverrides(process.argv.slice(2));

function sendJsonRpc(message) {
  const json = JSON.stringify(message);
  if (framingMode === "content-length") {
    const byteLen = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function sendResult(id, result) {
  sendJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  sendJsonRpc({ jsonrpc: "2.0", id: id ?? null, error });
}

async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== "object") {
    sendError(null, -32600, "Invalid JSON-RPC message");
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const { id, method, params } = msg;

  // Notifications require no response
  if (!hasId) {
    return;
  }

  try {
    if (method === "initialize") {
      const requestedVersion = String(params?.protocolVersion || "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : DEFAULT_PROTOCOL_VERSION;

      const rawClientName = String(params?.clientInfo?.name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-");
      if (rawClientName) {
        clientCallerLabel = `mcp:${rawClientName}`;
      }

      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "cdp-bridge",
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: MCP_TOOLS });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      if (!toolName || typeof toolName !== "string") {
        sendError(id, -32602, "Missing tool name in tools/call");
        return;
      }
      try {
        const result = await dispatchMcpToolCall(toolName, toolArgs, {
          callerLabel: clientCallerLabel,
          envOverrides: cliEnvOverrides,
        });
        sendResult(id, result);
      } catch (err) {
        sendResult(id, {
          isError: true,
          content: [{ type: "text", text: err.message || String(err) }],
        });
      }
      return;
    }

    if (method === "resources/list") {
      sendResult(id, { resources: [] });
      return;
    }

    if (method === "resources/templates/list") {
      sendResult(id, { resourceTemplates: [] });
      return;
    }

    if (method === "prompts/list") {
      sendResult(id, { prompts: [] });
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    sendError(id, -32603, error.message || "Internal server error");
  }
}

// Dual-mode streaming parser (Content-Length LSP framing + newline-delimited JSON-RPC)
let buffer = Buffer.alloc(0);

function drainBuffer() {
  while (buffer.length > 0) {
    // Skip leading CR/LF whitespace when idle between frames
    if (!framingMode || framingMode === "line") {
      const headerProbe = buffer.subarray(0, Math.min(buffer.length, 32)).toString("ascii");
      if (/^Content-Length:/i.test(headerProbe)) {
        framingMode = "content-length";
      }
    }

    if (framingMode === "content-length") {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerStr = buffer.subarray(0, headerEnd).toString("ascii");
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLen = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLen) return;

      const bodyStr = buffer
        .subarray(bodyStart, bodyStart + contentLen)
        .toString("utf8");
      buffer = buffer.subarray(bodyStart + contentLen);

      try {
        const parsed = JSON.parse(bodyStr);
        void handleRpcMessage(parsed);
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err.message}`);
      }
      continue;
    }

    // Newline-delimited JSON-RPC mode (default for MCP stdio)
    const nlIndex = buffer.indexOf(0x0a); // '\n'
    if (nlIndex === -1) return;

    const line = buffer.subarray(0, nlIndex).toString("utf8").trim();
    buffer = buffer.subarray(nlIndex + 1);
    if (!line) continue;

    if (!framingMode) framingMode = "line";
    try {
      const parsed = JSON.parse(line);
      void handleRpcMessage(parsed);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});
