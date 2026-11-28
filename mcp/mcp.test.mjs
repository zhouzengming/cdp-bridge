import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
import { dispatchMcpToolCall, MCP_TOOLS } from "./tools.mjs";

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
  const sockPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cdp-mcp-test-${process.pid}-${Date.now()}`
      : path.join(tmpDir, "bridge.sock");
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
      env: {
        ...process.env,
        CDP_BRIDGE_STATE_DIR: tmpDir,
        CDP_DIAG: "0",
        CDP_NO_AUTO_START: "1",
      },
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
      env: {
        ...process.env,
        CDP_BRIDGE_STATE_DIR: tmpDir,
        CDP_DIAG: "0",
        CDP_NO_AUTO_START: "1",
      },
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

function createHandshakeCountingBrowser({ delayUpgrade = false, label = "Browser" } = {}) {
  let upgradeCount = 0;
  const sockets = new Set();
  const pendingUpgrades = [];

  function completeWsHandshake(req, socket) {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        }
        const maskBytes = masked ? 4 : 0;
        if (buf.length < offset + maskBytes + len) return;
        const payload = Buffer.from(
          buf.subarray(offset + maskBytes, offset + maskBytes + len),
        );
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i += 1) {
            payload[i] ^= mask[i & 3];
          }
        }
        buf = buf.subarray(offset + maskBytes + len);

        if (opcode === 0x08) {
          try {
            socket.write(Buffer.from([0x88, 0x00]));
          } catch {}
          socket.end();
          return;
        }
        if (opcode === 0x01) {
          const msg = JSON.parse(payload.toString("utf8"));
          let result = {};
          if (msg.method === "Target.getTargets") {
            result = {
              targetInfos: [
                {
                  targetId: "ABCD1234000000000000000000000000",
                  type: "page",
                  title: `${label} Tab`,
                  url: "http://127.0.0.1:3000/",
                  attached: false,
                },
              ],
            };
          } else if (msg.method === "Browser.getVersion") {
            result = { product: `${label}/136.0` };
          }
          const respBytes = Buffer.from(
            JSON.stringify({ id: msg.id, result }),
            "utf8",
          );
          const header =
            respBytes.length < 126
              ? Buffer.from([0x81, respBytes.length])
              : Buffer.from([
                  0x81,
                  126,
                  (respBytes.length >> 8) & 0xff,
                  respBytes.length & 0xff,
                ]);
          try {
            socket.write(Buffer.concat([header, respBytes]));
          } catch {}
        }
      }
    });
  }

  // Return 404 on /json/version just like chrome://inspect remote debugging mode
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    upgradeCount += 1;
    socket.on("error", () => {});
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (delayUpgrade) {
      pendingUpgrades.push(() => completeWsHandshake(req, socket));
    } else {
      completeWsHandshake(req, socket);
    }
  });

  return {
    get upgradeCount() {
      return upgradeCount;
    },
    approveAllPending() {
      while (pendingUpgrades.length > 0) {
        const fn = pendingUpgrades.shift();
        fn();
      }
    },
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server.address().port;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("Sticky preferred-target.json prevents Chrome/Edge mtime flip-flopping and makes repeat connect idempotent", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-sticky-target-"));
  const stateDir = path.join(tmpDir, "state");
  const searchRoot = path.join(tmpDir, "browsers");
  const sockPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cdp-sticky-${process.pid}-${Date.now()}`
      : path.join(stateDir, "bridge.sock");
  const cdpCli = path.join(repoRoot, "src", "cdp.mjs");

  const chromeMock = createHandshakeCountingBrowser({ label: "Chrome" });
  const edgeMock = createHandshakeCountingBrowser({ label: "Edge" });
  const chromePort = await chromeMock.listen();
  const edgePort = await edgeMock.listen();

  const chromePortFile = path.join(
    searchRoot,
    "Google",
    "Chrome",
    "User Data",
    "DevToolsActivePort",
  );
  const edgePortFile = path.join(
    searchRoot,
    "Microsoft",
    "Edge",
    "User Data",
    "DevToolsActivePort",
  );
  fs.mkdirSync(path.dirname(chromePortFile), { recursive: true });
  fs.mkdirSync(path.dirname(edgePortFile), { recursive: true });
  fs.writeFileSync(
    chromePortFile,
    `${chromePort}\n/devtools/browser/chrome-uuid\n`,
  );
  fs.writeFileSync(edgePortFile, `${edgePort}\n/devtools/browser/edge-uuid\n`);

  // Give Edge a newer mtime than Chrome (reproducing dual-browser mtime conflict)
  const nowSec = Date.now() / 1000;
  fs.utimesSync(chromePortFile, nowSec - 3600, nowSec - 3600);
  fs.utimesSync(edgePortFile, nowSec, nowSec);

  const testEnv = {
    ...process.env,
    CDP_BRIDGE_SOCKET: sockPath,
    CDP_BRIDGE_STATE_DIR: stateDir,
    CDP_DEVTOOLS_SEARCH_ROOT: searchRoot,
    CDP_NO_WMI_BREAKAWAY: "1",
    CDP_DIAG: "0",
  };
  delete testEnv.CDP_WS_URL;
  delete testEnv.CDP_PORT;
  delete testEnv.CDP_HOST;
  delete testEnv.CDP_PORT_FILE;

  const runCdp = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cdpCli, "--socket", sockPath, ...args],
        { env: testEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ code: code ?? 1, stdout, stderr }),
      );
    });

  try {
    // 1) Explicit connect to Chrome (older mtime) records preferred-target.json
    const c1 = await runCdp(["connect", `127.0.0.1:${chromePort}`]);
    assert.equal(c1.code, 0, c1.stderr);
    const st1 = JSON.parse(c1.stdout);
    assert.equal(chromeMock.upgradeCount, 1);
    assert.equal(edgeMock.upgradeCount, 0);
    assert.ok(fs.existsSync(path.join(stateDir, "preferred-target.json")));

    // 2) Calling `connect` again to the same target reuses the live daemon with 0 extra handshakes
    const c2 = await runCdp(["connect", `127.0.0.1:${chromePort}`]);
    assert.equal(c2.code, 0, c2.stderr);
    const st2 = JSON.parse(c2.stdout);
    assert.equal(st2.pid, st1.pid, "Repeat connect to same target must reuse running daemon PID");
    assert.equal(chromeMock.upgradeCount, 1, "Repeat connect must not trigger a 2nd browser handshake");

    // 3) Stop daemon, then run `cdp pages` (auto-start without args): must stick to Chrome, NEVER Edge!
    await runCdp(["stop"]);
    await new Promise((r) => setTimeout(r, 150));
    const pagesRes = await runCdp(["pages"]);
    assert.equal(pagesRes.code, 0, pagesRes.stderr);
    const pagesJson = JSON.parse(pagesRes.stdout);
    assert.equal(pagesJson.pages[0].title, "Chrome Tab");
    assert.equal(chromeMock.upgradeCount, 2);
    assert.equal(edgeMock.upgradeCount, 0, "Auto-start must never flip-flop to Edge while Chrome is open");

    // 4) Bare `cdp restart` without args also stays on Chrome instead of switching to Edge
    const restartRes = await runCdp(["restart"]);
    assert.equal(restartRes.code, 0, restartRes.stderr);
    assert.equal(chromeMock.upgradeCount, 3);
    assert.equal(edgeMock.upgradeCount, 0, "Bare restart must stay on Chrome");
  } finally {
    await runCdp(["stop"]).catch(() => {});
    await chromeMock.close();
    await edgeMock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Concurrent start/connect calls reuse pending connecting handshake and MCP returns PENDING_BROWSER_APPROVAL guidance", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-pending-allow-"));
  const stateDir = path.join(tmpDir, "state");
  const sockPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cdp-allow-${process.pid}-${Date.now()}`
      : path.join(stateDir, "bridge.sock");
  const cdpCli = path.join(repoRoot, "src", "cdp.mjs");

  const gatedBrowser = createHandshakeCountingBrowser({
    delayUpgrade: true,
    label: "GatedChrome",
  });
  const port = await gatedBrowser.listen();
  const wsUrl = `ws://127.0.0.1:${port}/devtools/browser/gated-uuid`;

  const envOverrides = {
    CDP_BRIDGE_SOCKET: sockPath,
    CDP_BRIDGE_STATE_DIR: stateDir,
    CDP_NO_WMI_BREAKAWAY: "1",
    CDP_DIAG: "0",
  };

  const runCdp = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cdpCli, "--socket", sockPath, ...args],
        {
          env: { ...process.env, ...envOverrides },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ code: code ?? 1, stdout, stderr }),
      );
    });

  try {
    // 1) Initial MCP connect times out while user hasn't clicked "Allow" -> exit code 2 + explicit anti-kill notice
    const mcpPending = await dispatchMcpToolCall(
      "cdp_status",
      { connect: wsUrl, timeoutMs: 450 },
      { envOverrides },
    );
    assert.equal(mcpPending.isError, true);
    assert.match(mcpPending.content[0].text, /\[PENDING_BROWSER_APPROVAL\]/);
    assert.match(mcpPending.content[0].text, /严禁终止/);
    assert.equal(
      gatedBrowser.upgradeCount,
      1,
      "Initial connect opens exactly 1 pending browser handshake",
    );

    // 2) While daemon is STILL in "connecting" state, fire 3 concurrent start/connect calls, then simulate user clicking "Allow"
    const approvalTimer = setTimeout(() => {
      gatedBrowser.approveAllPending();
    }, 220);

    const [r1, r2, r3] = await Promise.all([
      runCdp(["start", "--timeout", "4000"]),
      runCdp(["start", "--timeout", "4000"]),
      runCdp(["connect", wsUrl, "--timeout", "4000"]),
    ]);
    clearTimeout(approvalTimer);

    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r3.code, 0, r3.stderr);
    const s1 = JSON.parse(r1.stdout);
    const s2 = JSON.parse(r2.stdout);
    const s3 = JSON.parse(r3.stdout);
    assert.equal(s1.browserState, "ready");
    assert.equal(s1.pid, s2.pid);
    assert.equal(s1.pid, s3.pid);
    assert.equal(
      gatedBrowser.upgradeCount,
      1,
      "Concurrent start/connect while waiting for Allow must NEVER kill the daemon or trigger a 2nd browser popup",
    );
  } finally {
    await runCdp(["stop"]).catch(() => {});
    await gatedBrowser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
