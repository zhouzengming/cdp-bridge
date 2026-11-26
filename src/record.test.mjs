import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { dispatchMcpToolCall } from "../mcp/tools.mjs";
import { CURSOR_HELPER_SOURCE, resolveRecordHudOptions } from "./cursor.mjs";
import {
  buildNormalizedFramePlan,
  hasFfmpeg,
  resolveRecordingOutputPath,
} from "./recorder.mjs";
import {
  concatWebmBuffers,
  demuxWebm,
  inspectWebmBuffer,
  muxWebm,
} from "./webm-muxer.mjs";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const cdpScript = path.join(srcDir, "cdp.mjs");
const bridgeScript = path.join(srcDir, "cdp-bridge.mjs");

// Minimal 1x1 valid JPEG bytes (base64) for screencast/screenshot test payloads
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function createMockCdpBrowserServer(onCommand) {
  const sockets = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  function sendWsText(socket, obj) {
    if (!socket || socket.destroyed || !socket.writable || socket.writableEnded) {
      return;
    }
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {
      // Ignore write races during teardown
    }
  }

  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
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
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    let buf = Buffer.alloc(0);
    let textFragments = [];

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }

        const maskBytes = masked ? 4 : 0;
        if (buf.length < offset + maskBytes + len) {
          return;
        }

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
          if (!socket.destroyed && socket.writable && !socket.writableEnded) {
            try {
              socket.write(Buffer.from([0x88, 0x00]));
            } catch {}
            socket.end();
          }
          return;
        }
        if (opcode === 0x09) {
          if (!socket.destroyed && socket.writable && !socket.writableEnded) {
            socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          }
          continue;
        }
        if (opcode === 0x01 || opcode === 0x00) {
          textFragments.push(payload);
          if (!fin) {
            continue;
          }
          const fullPayload = Buffer.concat(textFragments);
          textFragments = [];
          const msg = JSON.parse(fullPayload.toString("utf8"));
          Promise.resolve(
            onCommand(msg, (eventObj) => sendWsText(socket, eventObj)),
          ).then(
            (result) => {
              const resp = { id: msg.id, result: result ?? {} };
              if (msg.sessionId) resp.sessionId = msg.sessionId;
              sendWsText(socket, resp);
            },
            (err) => {
              const resp = {
                id: msg.id,
                error: { code: -32000, message: err.message },
              };
              if (msg.sessionId) resp.sessionId = msg.sessionId;
              sendWsText(socket, resp);
            },
          );
        }
      }
    });
  });

  return {
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      return addr.port;
    },
    async close() {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("muxWebm encodes valid EBML VINT sizes (including 0x7f boundary), multi-Cluster splits, and Cues index", () => {
  // Note: SimpleBlock header is 4 bytes, so 123-byte frameData => 127-byte (0x7f) SimpleBlock body!
  // In EBML, 0x7f MUST use 2-byte VINT (0x407f) because 1-byte 0xff means "unknown size".
  const chunks = [
    { data: Buffer.alloc(122, 0x11), timestampMs: 0, keyframe: true },
    { data: Buffer.alloc(123, 0x22), timestampMs: 33, keyframe: false },
    { data: Buffer.alloc(127, 0x33), timestampMs: 66, keyframe: false },
    { data: Buffer.alloc(512, 0x44), timestampMs: 1_250, keyframe: true }, // >=1s keyframe -> Cluster #2
    { data: Buffer.alloc(256, 0x55), timestampMs: 27_000, keyframe: false }, // >25s delta -> Cluster #3
  ];

  const webm = muxWebm({
    width: 1280,
    height: 720,
    durationMs: 27_100,
    codecId: "V_VP9",
    chunks,
  });

  const info = inspectWebmBuffer(webm);
  assert.equal(info.valid, true);
  assert.equal(info.hasWebmDocType, true);
  assert.equal(info.clusterCount, 3);
  assert.equal(info.hasCues, true);
  assert.ok(webm.includes(Buffer.from("V_VP9", "utf8")));

  // Verify the 127-byte SimpleBlock explicitly uses [0xa3, 0x40, 0x7f] instead of [0xa3, 0xff]
  assert.ok(
    webm.includes(Buffer.from([0xa3, 0x40, 0x7f, 0x81])),
    "127-byte SimpleBlock payload must encode size as 2-byte VINT 0x407f",
  );

  // Round-trip demuxWebm and lossless concatWebmBuffers
  const demuxed = demuxWebm(webm);
  assert.equal(demuxed.width, 1280);
  assert.equal(demuxed.height, 720);
  assert.equal(demuxed.codecId, "V_VP9");
  assert.equal(demuxed.chunks.length, chunks.length);
  assert.deepEqual(demuxed.chunks[1].data, chunks[1].data);

  const seg2 = muxWebm({
    width: 1280,
    height: 720,
    durationMs: 1_500,
    codecId: "V_VP9",
    chunks: [
      { data: Buffer.alloc(180, 0x66), timestampMs: 0, keyframe: true },
      { data: Buffer.alloc(90, 0x77), timestampMs: 500, keyframe: false },
    ],
  });
  const merged = concatWebmBuffers([webm, seg2]);
  assert.equal(merged.segmentCount, 2);
  assert.equal(merged.totalChunks, chunks.length + 2);
  assert.equal(inspectWebmBuffer(merged.buffer).valid, true);
  const mergedDemux = demuxWebm(merged.buffer);
  assert.equal(mergedDemux.chunks.length, chunks.length + 2);
  assert.equal(mergedDemux.chunks[chunks.length].keyframe, true);
  assert.ok(mergedDemux.chunks[chunks.length].timestampMs > chunks[chunks.length - 1].timestampMs);

  const mismatchSeg = muxWebm({
    width: 800,
    height: 600,
    durationMs: 500,
    codecId: "V_VP9",
    chunks: [{ data: Buffer.alloc(64, 0x88), timestampMs: 0, keyframe: true }],
  });
  assert.throws(
    () => concatWebmBuffers([webm, mismatchSeg]),
    /Resolution or codec mismatch/,
  );
});

test("buildNormalizedFramePlan normalizes VFR timestamps and synthesizes final hold frame", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-rec-plan-"));
  try {
    const f0 = path.join(tmpDir, "frame-00000.jpg");
    const f1 = path.join(tmpDir, "frame-00001.jpg");
    fs.writeFileSync(f0, Buffer.from(TINY_JPEG_B64, "base64"));
    fs.writeFileSync(f1, Buffer.from(TINY_JPEG_B64, "base64"));

    // 1) Single-frame static page recorded for 1.5s -> adds a 2nd hold frame near end
    const staticPlan = buildNormalizedFramePlan(
      [{ file: f0, wallTimeMs: 1_000 }],
      1_000,
      2_500,
      30,
    );
    assert.equal(staticPlan.plan.length, 2);
    assert.equal(staticPlan.plan[0].ptsMs, 0);
    assert.equal(staticPlan.plan[0].keyFrame, true);
    assert.ok(staticPlan.plan[1].ptsMs >= 1_400);
    assert.ok(staticPlan.durationMs >= 1_500);

    // 2) Burst frames at identical millisecond are spaced monotonically
    const burstPlan = buildNormalizedFramePlan(
      [
        { file: f0, wallTimeMs: 5_000 },
        { file: f1, wallTimeMs: 5_000 },
        { file: f1, wallTimeMs: 5_005 },
      ],
      5_000,
      5_120,
      30,
    );
    for (let i = 1; i < burstPlan.plan.length; i += 1) {
      assert.ok(
        burstPlan.plan[i].ptsMs > burstPlan.plan[i - 1].ptsMs,
        "PTS must strictly increase",
      );
    }

    // 3) Output extension validation
    const resolvedWebm = resolveRecordingOutputPath(path.join(tmpDir, "demo-clip"));
    assert.match(resolvedWebm.outputPath, /demo-clip\.webm$/);
    assert.throws(
      () => resolveRecordingOutputPath(path.join(tmpDir, "bad.avi")),
      /Unsupported recording output extension/,
    );
    if (!hasFfmpeg()) {
      assert.throws(
        () => resolveRecordingOutputPath(path.join(tmpDir, "needs-ffmpeg.mp4")),
        /requires ffmpeg/,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("End-to-end cdp record start/stop, auto-demo cursor upgrade, batch --record failure recovery, and MCP cdp_record", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-rec-e2e-"));
  const sockPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cdp-rec-e2e-${process.pid}-${Date.now()}`
      : path.join(tmpDir, "bridge.sock");
  const logPath = path.join(tmpDir, "bridge.log");
  const activeRecFile = path.join(tmpDir, "active-recordings.json");

  const ackedFrameIds = [];
  const pageExpressions = [];
  const mouseEvents = [];
  let workerCreated = 0;
  let workerClosed = 0;
  let screencastActive = false;

  const mockBrowser = createMockCdpBrowserServer((msg, emitEvent) => {
    const { method, params = {}, sessionId } = msg;

    if (method === "Browser.getVersion") {
      return { product: "Chrome/136.0.0.0" };
    }
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          {
            targetId: "426B5451000000000000000000000000",
            type: "page",
            title: "Acceptance Test Bench",
            url: "http://127.0.0.1:3000/bench",
            attached: true,
          },
        ],
      };
    }
    if (method === "Target.createTarget") {
      if (params.url === "about:blank" && params.background) {
        workerCreated += 1;
        return { targetId: `WORKER0000000000000000000000000${workerCreated}` };
      }
      return { targetId: "NEWPAGE0000000000000000000000000" };
    }
    if (method === "Target.closeTarget") {
      if (String(params.targetId || "").startsWith("WORKER")) {
        workerClosed += 1;
      }
      return { success: true };
    }
    if (method === "Target.attachToTarget") {
      if (String(params.targetId || "").startsWith("WORKER")) {
        return { sessionId: `worker-sess-${workerCreated}` };
      }
      return { sessionId: "page-sess-main" };
    }
    if (method === "Page.startScreencast") {
      screencastActive = true;
      setImmediate(() => {
        emitEvent({
          method: "Page.screencastFrame",
          sessionId,
          params: {
            data: TINY_JPEG_B64,
            metadata: { deviceWidth: 1280, deviceHeight: 720 },
            sessionId: 501,
          },
        });
        setTimeout(() => {
          if (screencastActive) {
            emitEvent({
              method: "Page.screencastFrame",
              sessionId,
              params: {
                data: TINY_JPEG_B64,
                metadata: { deviceWidth: 1280, deviceHeight: 720 },
                sessionId: 502,
              },
            });
          }
        }, 35);
      });
      return {};
    }
    if (method === "Page.screencastFrameAck") {
      ackedFrameIds.push(params.sessionId);
      return {};
    }
    if (method === "Page.stopScreencast") {
      screencastActive = false;
      return {};
    }
    if (method === "Page.captureScreenshot") {
      return { data: TINY_JPEG_B64 };
    }
    if (method === "Input.dispatchMouseEvent") {
      mouseEvents.push(params);
      return {};
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      return { identifier: "hud-script-1" };
    }
    if (method === "Runtime.evaluate") {
      const expr = String(params.expression || "");

      // Background WebCodecs worker evaluations
      if (String(sessionId || "").startsWith("worker-sess-")) {
        if (expr.includes("window.isSecureContext && document.readyState")) {
          return { result: { type: "boolean", value: true } };
        }
        if (expr.includes("window.__cdpCreateVideoEncoder =")) {
          return { result: { type: "boolean", value: true } };
        }
        if (expr.includes("window.__activeCdpEncoder = await")) {
          return {
            result: {
              type: "object",
              value: { width: 1280, height: 720, muxCodecId: "V_VP9" },
            },
          };
        }
        if (expr.startsWith("window.__activeCdpEncoder.encodeBatch(")) {
          const jsonSlice = expr.slice(
            "window.__activeCdpEncoder.encodeBatch(".length,
            -1,
          );
          const batchItems = JSON.parse(jsonSlice);
          const encoded = batchItems.map((it, idx) => ({
            b64: Buffer.alloc(123 + idx, 0x5a).toString("base64"),
            timestampMs: it.ptsMs,
            keyframe: Boolean(it.keyFrame),
          }));
          return { result: { type: "object", value: encoded } };
        }
        if (expr.includes("window.__activeCdpEncoder.close()")) {
          return { result: { type: "object", value: [] } };
        }
      }

      // Main page evaluations
      pageExpressions.push(expr);
      if (expr.includes(".startDrag(")) {
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              fromX: 120,
              fromY: 200,
              fromTag: "DIV",
              fromText: "Card A",
              toX: 420,
              toY: 260,
              toRect: { left: 380, top: 230, width: 80, height: 60 },
              toTag: "DIV",
              toText: "Done Column",
              useHtml5: true,
            },
          },
        };
      }
      if (expr.includes("Scroll ↑ Top")) {
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              mode: "top",
              direction: "top",
              deltaX: 0,
              deltaY: -120,
              scrolledX: 0,
              scrolledY: -120,
              scrollX: 0,
              scrollY: 0,
              maxScrollY: 600,
              atTop: true,
              atBottom: false,
              badge: "Scroll ↑ Top",
            },
          },
        };
      }
      return { result: { type: "number", value: 42 } };
    }

    return {};
  });

  const port = await mockBrowser.listen();
  const wsUrl = `ws://127.0.0.1:${port}/devtools/browser/mock`;

  const daemon = spawn(
    process.execPath,
    [
      bridgeScript,
      "serve",
      "--ws-url",
      wsUrl,
      "--socket",
      sockPath,
      "--log-file",
      logPath,
    ],
    {
      env: {
        ...process.env,
        CDP_BRIDGE_STATE_DIR: tmpDir,
        CDP_DIAG: "0",
      },
      stdio: "ignore",
    },
  );

  const runCli = (args, stdinInput) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cdpScript, "--socket", sockPath, ...args],
        {
          env: {
            ...process.env,
            CDP_BRIDGE_SOCKET: sockPath,
            CDP_BRIDGE_STATE_DIR: tmpDir,
            CDP_DIAG: "0",
            CDP_NO_AUTO_START: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
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
      child.on("close", (code) => {
        resolve({ status: code ?? 1, stdout, stderr });
      });
      if (stdinInput !== undefined) {
        child.stdin.end(stdinInput, "utf8");
      } else {
        child.stdin.end();
      }
    });

  try {
    // Wait for daemon socket ready
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      const st = await runCli(["status"]);
      if (st.status === 0) {
        const parsed = JSON.parse(st.stdout);
        if (parsed.browserState === "ready") {
          ready = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ready, true, "mock cdp-bridge daemon should reach ready state");

    // 1) Before recording: `cdp scroll 426B5451 top` uses default `fast` cursor (`if (false)` for demo delay)
    const preScroll = await runCli(["scroll", "426B5451", "top"]);
    assert.equal(preScroll.status, 0, preScroll.stderr);
    assert.match(pageExpressions[pageExpressions.length - 1], /if \(false\)/);

    // 2) Start cross-command recording
    const outWebm = path.join(tmpDir, "acceptance.webm");
    const framesExportDir = path.join(tmpDir, "exported-frames");
    const recStart = await runCli(["record", "start", "426B5451", outWebm]);
    assert.equal(recStart.status, 0, recStart.stderr);
    const startJson = JSON.parse(recStart.stdout);
    assert.equal(startJson.recording, true);
    assert.ok(fs.existsSync(activeRecFile), "active-recordings.json must exist while recording");

    // 3) During recording: `cdp scroll 426B5451 top` auto-upgrades cursor to `demo` (`if (true)`)
    await new Promise((r) => setTimeout(r, 70));
    const midScroll = await runCli(["scroll", "426B5451", "top"]);
    assert.equal(midScroll.status, 0, midScroll.stderr);
    assert.match(
      pageExpressions[pageExpressions.length - 1],
      /if \(true\)/,
      "Active recording should auto-upgrade page cursor to smooth demo mode",
    );
    assert.ok(ackedFrameIds.includes(501), "Daemon must send Page.screencastFrameAck");

    // 3b) Screenshot during active recording must signal activelyRecording: true so screencast never flashes a pinned box
    const midShotPath = path.join(tmpDir, "mid-rec.png");
    const midShotRes = await runCli([
      "screenshot",
      "426B5451",
      midShotPath,
      "--with-cursor",
    ]);
    assert.equal(midShotRes.status, 0, midShotRes.stderr);
    assert.ok(
      pageExpressions.some(
        (e) =>
          e.includes("prepareScreenshot(") &&
          /activelyRecording:\s*true/.test(e),
      ),
      "Screenshot during active recording must pass activelyRecording: true",
    );

    // 4) Pause -> simulated wait -> Resume (verifying HUD toast & time compression)
    const recPause = await runCli(["record", "pause", "426B5451"]);
    assert.equal(recPause.status, 0, recPause.stderr);
    assert.equal(JSON.parse(recPause.stdout).paused, true);
    assert.ok(
      pageExpressions.some((e) => e.includes("录制已暂停")),
      "Pause should show paused HUD toast in page",
    );

    // Screenshot while paused behaves like non-recording (`activelyRecording: false`)
    pageExpressions.length = 0;
    const pausedShotPath = path.join(tmpDir, "paused-rec.png");
    const pausedShotRes = await runCli([
      "screenshot",
      "426B5451",
      pausedShotPath,
      "--with-cursor",
    ]);
    assert.equal(pausedShotRes.status, 0, pausedShotRes.stderr);
    assert.ok(
      pageExpressions.some(
        (e) =>
          e.includes("prepareScreenshot(") &&
          /activelyRecording:\s*false/.test(e),
      ),
      "Screenshot while paused must pass prepareScreenshot(true, { activelyRecording: false })",
    );

    // While paused, scroll runs in default fast mode (`if (false)`) rather than slow-mo
    const pausedScroll = await runCli(["scroll", "426B5451", "top"]);
    assert.equal(pausedScroll.status, 0, pausedScroll.stderr);
    assert.match(pageExpressions[pageExpressions.length - 1], /if \(false\)/);

    await new Promise((r) => setTimeout(r, 320));
    const recResume = await runCli(["record", "resume", "426B5451"]);
    assert.equal(recResume.status, 0, recResume.stderr);
    const resumeJson = JSON.parse(recResume.stdout);
    assert.equal(resumeJson.resumed, true);
    assert.ok(resumeJson.skippedMs >= 260);
    assert.ok(
      pageExpressions.some((e) => e.includes("已跳过")),
      "Resume should display floating skip-wait toast in page",
    );

    const recStatus = await runCli(["record", "status"]);
    assert.equal(recStatus.status, 0, recStatus.stderr);
    const statusJson = JSON.parse(recStatus.stdout);
    assert.equal(statusJson.count, 1);
    assert.equal(statusJson.recordings[0].pauseCount, 1);

    // 5) Stop recording (passing output path + --keep-frames without repeating targetId)
    const recStop = await runCli([
      "record",
      "stop",
      outWebm,
      "--keep-frames",
      framesExportDir,
    ]);
    assert.equal(recStop.status, 0, recStop.stderr);
    const stopJson = JSON.parse(recStop.stdout);
    assert.equal(stopJson.saved, outWebm);
    assert.equal(stopJson.format, "webm");
    assert.equal(stopJson.codec, "vp9");
    assert.equal(stopJson.pauseCount, 1);
    assert.ok(stopJson.skippedDurationMs >= 260);
    assert.ok(fs.existsSync(outWebm));
    assert.equal(inspectWebmBuffer(fs.readFileSync(outWebm)).valid, true);
    assert.equal(fs.existsSync(activeRecFile), false, "active-recordings.json cleaned up after stop");
    assert.ok(fs.readdirSync(framesExportDir).some((n) => n.endsWith(".jpg")));
    assert.equal(workerCreated, workerClosed, "Background WebCodecs worker target must be closed");

    // 5b) Test `cdp drag` interpolated mouse + HTML5 DragEvent sequence
    mouseEvents.length = 0;
    const dragRes = await runCli([
      "drag",
      "426B5451",
      "120,200",
      "420,260",
      "--steps",
      "5",
    ]);
    assert.equal(dragRes.status, 0, dragRes.stderr);
    const dragJson = JSON.parse(dragRes.stdout);
    assert.equal(dragJson.ok, true);
    assert.equal(dragJson.deltaX, 300);
    assert.equal(dragJson.deltaY, 60);
    assert.equal(dragJson.steps, 5);
    assert.equal(dragJson.html5Drag, true);
    assert.ok(mouseEvents.some((m) => m.type === "mousePressed" && m.buttons === 1));
    assert.equal(
      mouseEvents.filter((m) => m.type === "mouseMoved" && m.buttons === 1).length,
      5,
    );
    assert.ok(mouseEvents.some((m) => m.type === "mouseReleased" && m.buttons === 0));

    // 6) `cdp batch --record` preserves failure video in `finally` even when a step fails!
    const failedBatchWebm = path.join(tmpDir, "failed-batch.webm");
    const batchFail = await runCli(
      ["batch", "426B5451", "--record", failedBatchWebm, "--stdin"],
      JSON.stringify([
        { cmd: "eval", expr: "1 + 1" },
        { cmd: "nonexistent-step-to-trigger-failure" },
      ]),
    );
    assert.equal(batchFail.status, 1, "Batch with failing step must exit with status 1");
    assert.ok(
      fs.existsSync(failedBatchWebm),
      "Batch failure video must still be finalized and saved on disk",
    );
    assert.equal(inspectWebmBuffer(fs.readFileSync(failedBatchWebm)).valid, true);
    assert.match(batchFail.stderr, /"saved":/);

    // 7) MCP `cdp_record` (`action: "clip"`) integration
    const mcpClipWebm = path.join(tmpDir, "mcp-clip.webm");
    const mcpRes = await dispatchMcpToolCall(
      "cdp_record",
      {
        action: "clip",
        target: "426B5451",
        outputPath: mcpClipWebm,
        durationMs: 120,
      },
      {
        envOverrides: {
          CDP_BRIDGE_SOCKET: sockPath,
          CDP_BRIDGE_STATE_DIR: tmpDir,
          CDP_DIAG: "0",
          CDP_NO_AUTO_START: "1",
        },
      },
    );
    assert.equal(mcpRes.isError, undefined, JSON.stringify(mcpRes));
    const mcpData = JSON.parse(mcpRes.content[0].text);
    assert.equal(mcpData.saved, mcpClipWebm);
    assert.equal(inspectWebmBuffer(fs.readFileSync(mcpClipWebm)).valid, true);

    // 8) Multi-video lossless concatenation (`cdp record concat ... --rm --no-badge`)
    const mergedOut = path.join(tmpDir, "merged-final.webm");
    const concatRes = await runCli([
      "record",
      "concat",
      outWebm,
      mcpClipWebm,
      "-o",
      mergedOut,
      "--rm",
      "--no-badge",
    ]);
    assert.equal(concatRes.status, 0, concatRes.stderr);
    const concatJson = JSON.parse(concatRes.stdout);
    assert.equal(concatJson.saved, mergedOut);
    assert.equal(concatJson.segmentCount, 2);
    assert.equal(concatJson.cleanedInputs, true);
    assert.equal(fs.existsSync(outWebm), false, "--rm must clean segment 1");
    assert.equal(fs.existsSync(mcpClipWebm), false, "--rm must clean segment 2");
    assert.equal(inspectWebmBuffer(fs.readFileSync(mergedOut)).valid, true);

    // 9) Configurable HUD turn-off (--no-hud / MCP hud: false) suppresses all top-right overlays & toasts
    pageExpressions.length = 0;
    const silentWebm = path.join(tmpDir, "silent-no-hud.webm");
    const silentStart = await runCli([
      "record",
      "start",
      "426B5451",
      silentWebm,
      "--no-hud",
    ]);
    assert.equal(silentStart.status, 0, silentStart.stderr);
    assert.equal(JSON.parse(silentStart.stdout).hud, false);
    const silentPause = await runCli(["record", "pause", "426B5451"]);
    assert.equal(silentPause.status, 0, silentPause.stderr);
    const silentResume = await runCli(["record", "resume", "426B5451"]);
    assert.equal(silentResume.status, 0, silentResume.stderr);
    const silentStop = await runCli(["record", "stop", "426B5451"]);
    assert.equal(silentStop.status, 0, silentStop.stderr);
    assert.equal(
      pageExpressions.some(
        (e) => e.includes("setRecordingHud") || e.includes("showRecordingToast"),
      ),
      false,
      "--no-hud must suppress REC pill and all pause/resume toasts",
    );

    pageExpressions.length = 0;
    const mcpSilentWebm = path.join(tmpDir, "mcp-silent.webm");
    const mcpSilentRes = await dispatchMcpToolCall(
      "cdp_record",
      {
        action: "clip",
        target: "426B5451",
        outputPath: mcpSilentWebm,
        durationMs: 80,
        hud: false,
      },
      {
        envOverrides: {
          CDP_BRIDGE_SOCKET: sockPath,
          CDP_BRIDGE_STATE_DIR: tmpDir,
          CDP_DIAG: "0",
          CDP_NO_AUTO_START: "1",
        },
      },
    );
    assert.equal(mcpSilentRes.isError, undefined, JSON.stringify(mcpSilentRes));
    assert.equal(
      pageExpressions.some(
        (e) => e.includes("setRecordingHud") || e.includes("showRecordingToast"),
      ),
      false,
      "MCP cdp_record with hud:false must suppress top-right HUD",
    );
  } finally {
    await runCli(["stop"]);
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        daemon.kill("SIGKILL");
        resolve();
      }, 2_000);
      daemon.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await mockBrowser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveRecordHudOptions defaults to enabled and honors CLI flags and environment overrides", () => {
  assert.deepEqual(resolveRecordHudOptions({}, {}), { hud: true, badge: true });
  assert.deepEqual(resolveRecordHudOptions({ "no-hud": true }, {}), {
    hud: false,
    badge: false,
  });
  assert.deepEqual(resolveRecordHudOptions({ hud: "off" }, {}), {
    hud: false,
    badge: false,
  });
  assert.deepEqual(resolveRecordHudOptions({ hud: "0" }, {}), {
    hud: false,
    badge: false,
  });
  assert.deepEqual(resolveRecordHudOptions({}, { CDP_RECORD_HUD: "0" }), {
    hud: false,
    badge: false,
  });
  assert.deepEqual(
    resolveRecordHudOptions({ "show-hud": true }, { CDP_RECORD_HUD: "0" }),
    { hud: true, badge: true },
  );
  assert.deepEqual(resolveRecordHudOptions({ "no-badge": true }, {}), {
    hud: true,
    badge: false,
  });
  assert.deepEqual(resolveRecordHudOptions({}, { CDP_RECORD_BADGE: "off" }), {
    hud: true,
    badge: false,
  });
});

test("CURSOR_HELPER_SOURCE v10 tracks element liveness/scroll, clears SPA route residue, and avoids screencast flash", () => {
  class FakeEl {
    constructor(tag = "DIV") {
      this.tagName = tag;
      this.attrs = new Map();
      this.children = [];
      this.parent = null;
      this.shadowRootNode = null;
      this.style = { cssText: "" };
      this.textContent = "";
      this.popoverOpen = false;
      this.rect = { left: 0, top: 0, width: 100, height: 32 };
      this.opacity = "1";
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === docEl) return true;
        cur = cur.parent;
      }
      return false;
    }
    setAttribute(k, v) {
      this.attrs.set(String(k), String(v));
    }
    getAttribute(k) {
      return this.attrs.get(String(k)) ?? null;
    }
    appendChild(child) {
      if (child.parent) child.remove();
      child.parent = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (child.parent) child.remove();
      child.parent = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) this.children.push(child);
      else this.children.splice(idx, 0, child);
      return child;
    }
    remove() {
      if (!this.parent) return;
      const arr = this.parent.children;
      const i = arr.indexOf(this);
      if (i !== -1) arr.splice(i, 1);
      this.parent = null;
    }
    set innerHTML(v) {
      if (v === "") {
        for (const c of this.children.slice()) c.parent = null;
        this.children.length = 0;
      }
    }
    attachShadow() {
      const sr = new FakeEl("#shadow-root");
      sr.parent = this;
      this.shadowRootNode = sr;
      return sr;
    }
    showPopover() {
      this.popoverOpen = true;
    }
    hidePopover() {
      this.popoverOpen = false;
    }
    matches(sel) {
      return sel === ":popover-open" ? this.popoverOpen : false;
    }
    animate() {
      return { onfinish: null, cancel() {} };
    }
    getAnimations() {
      return [];
    }
    getBoundingClientRect() {
      return {
        left: this.rect.left,
        top: this.rect.top,
        width: this.rect.width,
        height: this.rect.height,
        right: this.rect.left + this.rect.width,
        bottom: this.rect.top + this.rect.height,
      };
    }
  }

  const docEl = new FakeEl("HTML");
  docEl.clientWidth = 1280;
  docEl.clientHeight = 720;

  const listeners = new Map();
  const navListeners = new Map();
  const locationObj = { href: "http://127.0.0.1:3000/history" };

  const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 720,
    location: locationObj,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    navigation: {
      addEventListener(type, fn) {
        if (!navListeners.has(type)) navListeners.set(type, new Set());
        navListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        navListeners.get(type)?.delete(fn);
      },
    },
    getComputedStyle(node) {
      return {
        display: "block",
        visibility: "visible",
        opacity: node.opacity ?? "1",
      };
    },
    emit(type) {
      for (const fn of listeners.get(type) || []) fn({ type });
      for (const fn of navListeners.get(type) || []) fn({ type });
    },
  };

  const sandbox = {
    window: fakeWindow,
    document: {
      documentElement: docEl,
      body: new FakeEl("BODY"),
      createElement: (tag) => new FakeEl(tag),
      createElementNS: (_ns, tag) => new FakeEl(tag),
      querySelector: () => null,
    },
    location: locationObj,
    performance: { now: () => 1000 },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    JSON,
    Symbol,
    WeakRef,
  };
  fakeWindow.window = fakeWindow;

  const api = vm.runInNewContext(CURSOR_HELPER_SOURCE, sandbox);
  assert.equal(api.version, 10);

  const getLayer = () => {
    const host = docEl.children.find(
      (c) => c.getAttribute("data-cdp-bridge-overlay") !== null,
    );
    return host.shadowRootNode.children[0];
  };

  // 1) Same route + scrolled live target shifts restored cursor & highlight box to new viewport rect
  const cardBtn = new FakeEl("BUTTON");
  cardBtn.rect = { left: 100, top: 200, width: 140, height: 40 };
  docEl.appendChild(cardBtn);

  api.showHover(170, 220, cardBtn.getBoundingClientRect(), 100, 120, false, cardBtn);
  cardBtn.rect = { left: 100, top: 80, width: 140, height: 40 };
  const restored = api.prepareScreenshot(true);
  assert.equal(restored.mode, "restored");
  assert.equal(restored.x, 170);
  assert.equal(restored.y, 100);
  const containsCss = (node, substr) =>
    String(node.style?.cssText || "").includes(substr) ||
    node.children.some((ch) => containsCss(ch, substr));
  assert.ok(
    getLayer().children.some((c) => containsCss(c, "top:77px")),
    "Pinned highlight box must track scrolled element top (80 - 3px pad = 77px)",
  );
  api.finishScreenshot(true);

  // 2) Unmounted or hidden element must return stale-target and mount zero pinned boxes
  cardBtn.remove();
  const staleTargetPrep = api.prepareScreenshot(true);
  assert.equal(staleTargetPrep.mode, "stale-target");
  assert.equal(
    getLayer().children.length,
    1,
    "Only cursorEl should remain when element is unmounted",
  );

  // 3) Synchronous SPA route transition inside click cancels post-click highlight box
  const navBtn = new FakeEl("BUTTON");
  navBtn.rect = { left: 200, top: 300, width: 120, height: 36 };
  docEl.appendChild(navBtn);
  const clickMeta = api.moveForClick(260, 318, navBtn.getBoundingClientRect(), 100, 120, false, navBtn);
  locationObj.href = "http://127.0.0.1:3000/replica/123";
  api.triggerClickImpact(260, 318, navBtn.getBoundingClientRect(), clickMeta.href, navBtn);
  assert.equal(
    getLayer().children.length,
    1,
    "Sync route change inside click must not leave ripple or 480ms highlight box",
  );
  assert.equal(api.prepareScreenshot(true).mode, "none");

  // 4) Async SPA route change (currententrychange/popstate) clears active boxes while preserving REC HUD
  api.setRecordingHud({ state: "rec", elapsedBaseMs: 1000, label: "Step 1" });
  const liveBtn = new FakeEl("BUTTON");
  liveBtn.rect = { left: 300, top: 240, width: 90, height: 36 };
  docEl.appendChild(liveBtn);
  api.showHover(345, 258, liveBtn.getBoundingClientRect(), 100, 120, false, liveBtn);
  assert.ok(getLayer().children.length > 1, "Hover highlight box should be present before route change");
  locationObj.href = "http://127.0.0.1:3000/history";
  fakeWindow.emit("currententrychange");
  assert.equal(getLayer().children.length, 1, "Route change event must strip transient highlight boxes");
  assert.equal(api.getRecordingHudState()?.state, "rec", "REC HUD must survive route transition");

  // 5) Active recording blocks prepareScreenshot from flashing pinned highlight DOM overlays
  api.showHover(345, 258, liveBtn.getBoundingClientRect(), 100, 120, false, liveBtn);
  const beforeRecCount = getLayer().children.length;
  const recPrep = api.prepareScreenshot(true, { activelyRecording: true });
  assert.equal(recPrep.mode, "live-recording");
  assert.equal(
    getLayer().children.length,
    beforeRecCount,
    "prepareScreenshot during active recording must not inject pinnedHighlightEl or ring DOM",
  );
  api.finishScreenshot(true, { activelyRecording: true });
  api.destroy();
});
