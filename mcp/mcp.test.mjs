import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildWmiBreakawayPowerShellScript,
  encodePowerShellCommand,
  formatWindowsCommandLine,
  quoteWindowsArg,
  trySpawnWindowsWmiBreakaway,
} from "../src/win-spawn.mjs";
import { MCP_TOOLS } from "./tools.mjs";

const mcpDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(mcpDir, "..");
const serverScript = path.join(mcpDir, "server.mjs");

test("Windows CommandLineToArgvW quoting and UTF-16LE PowerShell WMI breakaway script encoding", () => {
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg("serve"), "serve");
  assert.equal(
    quoteWindowsArg("C:\\Program Files\\nodejs\\node.exe"),
    '"C:\\Program Files\\nodejs\\node.exe"',
  );
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArg("C:\\Temp\\dir\\"), "C:\\Temp\\dir\\");
  assert.equal(
    quoteWindowsArg("C:\\Temp\\my dir\\"),
    '"C:\\Temp\\my dir\\\\"',
  );

  const cmdLine = formatWindowsCommandLine(
    "C:\\Program Files\\nodejs\\node.exe",
    ["C:\\Users\\测试 用户\\cdp-bridge\\src\\cdp-bridge.mjs", "serve", "--port", "9222"],
  );
  assert.match(cmdLine, /^"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\测试 用户\\cdp-bridge\\src\\cdp-bridge\.mjs" serve --port 9222$/);

  const psScript = buildWmiBreakawayPowerShellScript(
    "C:\\Program Files\\nodejs\\node.exe",
    ["C:\\Users\\O'Connor\\cdp-bridge.mjs", "serve"],
    "C:\\Users\\O'Connor\\Temp",
  );
  assert.match(psScript, /ShowWindow = \[uint16\]0/);
  assert.match(psScript, /O''Connor/);

  const b64 = encodePowerShellCommand(psScript);
  const decoded = Buffer.from(b64, "base64").toString("utf16le");
  assert.equal(decoded, psScript);

  const disabledRes = trySpawnWindowsWmiBreakaway("node", ["serve"], ".", {
    CDP_NO_WMI_BREAKAWAY: "1",
  });
  assert.equal(disabledRes.ok, false);
});

test("antigravity-mcp plugin files stay in sync with root version, skill, and guard script", () => {
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const mcpPluginDir = path.join(repoRoot, "plugins", "antigravity-mcp");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(mcpPluginDir, "plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "cdp-bridge-mcp");
  assert.equal(manifest.version, rootPkg.version);

  const mcpCfg = JSON.parse(
    fs.readFileSync(path.join(mcpPluginDir, "mcp_config.json"), "utf8"),
  );
  assert.equal(mcpCfg.mcpServers["cdp-bridge"].command, "cdp-mcp");

  assert.equal(
    fs.readFileSync(
      path.join(mcpPluginDir, "skills", "cdp-bridge", "SKILL.md"),
      "utf8",
    ),
    fs.readFileSync(
      path.join(repoRoot, "skills", "cdp-bridge", "SKILL.md"),
      "utf8",
    ),
  );
  assert.equal(
    fs.readFileSync(
      path.join(mcpPluginDir, "scripts", "cdp-guard.mjs"),
      "utf8",
    ),
    fs.readFileSync(
      path.join(repoRoot, "plugins", "antigravity", "scripts", "cdp-guard.mjs"),
      "utf8",
    ),
  );
});

test("MCP server speaks both NDJSON and Content-Length framing and forwards UTF-8 multi-line payloads to bridge socket", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-mcp-test-"));
  const sockPath = path.join(tmpDir, "bridge.sock");
  let lastEvalExpr = "";

  const mockBridge = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);

      let result = {};
      if (req.method === "bridge.status") {
        result = {
          pid: process.pid,
          socketPath: sockPath,
          browserState: "ready",
          commandsForwarded: 7,
        };
      } else if (req.method === "Target.getTargets") {
        result = {
          targetInfos: [
            {
              targetId: "426B5451000000000000000000000000",
              type: "page",
              title: "Demo App",
              url: "http://127.0.0.1:3000/app",
              attached: true,
            },
          ],
        };
      } else if (req.method === "bridge.attach") {
        result = { sessionId: "sess-1" };
      } else if (req.method === "Runtime.evaluate") {
        lastEvalExpr = req.params?.expression || "";
        result = {
          result: {
            type: "string",
            value: `ECHO:${lastEvalExpr.length}`,
          },
        };
      }
      conn.end(`${JSON.stringify({ id: req.id, result })}\n`);
    });
  });

  await new Promise((resolve) => mockBridge.listen(sockPath, resolve));

  try {
    // 1) Test standard newline-delimited MCP stdio
    const child = spawn(process.execPath, [serverScript, "--socket", sockPath], {
      env: { ...process.env, CDP_DIAG: "0", CDP_NO_AUTO_START: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map();
    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    });

    const callRpc = (id, method, params) =>
      new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    const initRes = await callRpc(1, "initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "win-test-client", version: "1.0.0" },
      capabilities: {},
    });
    assert.equal(initRes.result.serverInfo.name, "cdp-bridge");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listRes = await callRpc(2, "tools/list", {});
    assert.equal(listRes.result.tools.length, MCP_TOOLS.length);

    const pagesRes = await callRpc(3, "tools/call", {
      name: "cdp_pages",
      arguments: {},
    });
    const pagesJson = JSON.parse(pagesRes.result.content[0].text);
    assert.equal(pagesJson.count, 1);
    assert.equal(pagesJson.pages[0].title, "Demo App");

    // Multi-line Chinese + quotes + PowerShell $env syntax passed safely with zero shell escaping
    const trickyExpr = `(() => "第一行 '单引号' \\"双引号\\" $env:USERNAME\\n第二行中文")()`;
    const evalRes = await callRpc(4, "tools/call", {
      name: "cdp_eval",
      arguments: {
        target: "426B5451",
        expression: trickyExpr,
        raw: true,
      },
    });
    assert.equal(evalRes.result.isError, undefined);
    assert.match(evalRes.result.content[0].text, /^ECHO:/);
    assert.ok(lastEvalExpr.includes("$env:USERNAME"));
    assert.ok(lastEvalExpr.includes("第二行中文"));

    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));

    // 2) Test Content-Length header framing compatibility
    const clChild = spawn(process.execPath, [serverScript, "--socket", sockPath], {
      env: { ...process.env, CDP_DIAG: "0", CDP_NO_AUTO_START: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const clResponse = new Promise((resolve) => {
      let raw = Buffer.alloc(0);
      clChild.stdout.on("data", (chunk) => {
        raw = Buffer.concat([raw, chunk]);
        const sep = raw.indexOf("\r\n\r\n");
        if (sep === -1) return;
        const header = raw.subarray(0, sep).toString("ascii");
        const m = header.match(/Content-Length:\s*(\d+)/i);
        const len = Number(m[1]);
        if (raw.length >= sep + 4 + len) {
          const body = raw.subarray(sep + 4, sep + 4 + len).toString("utf8");
          resolve({ header, msg: JSON.parse(body) });
        }
      });
    });

    const reqBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    });
    clChild.stdin.write(
      `Content-Length: ${Buffer.byteLength(reqBody, "utf8")}\r\n\r\n${reqBody}`,
    );

    const { header, msg } = await clResponse;
    assert.match(header, /^Content-Length:/i);
    assert.equal(msg.id, 99);
    assert.deepEqual(msg.result, {});

    clChild.stdin.end();
    await new Promise((resolve) => clChild.once("close", resolve));
  } finally {
    mockBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
