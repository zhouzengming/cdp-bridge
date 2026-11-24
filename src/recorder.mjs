import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { muxWebm } from "./webm-muxer.mjs";

const SUPPORTED_VIDEO_EXTS = new Set([".webm", ".mp4", ".gif"]);

let cachedHasFfmpeg = null;

export function hasFfmpeg() {
  if (cachedHasFfmpeg !== null) return cachedHasFfmpeg;
  try {
    const res = spawnSync("ffmpeg", ["-version"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 3_000,
    });
    cachedHasFfmpeg = res.status === 0;
  } catch {
    cachedHasFfmpeg = false;
  }
  return cachedHasFfmpeg;
}

export function resolveRecordingOutputPath(outPathArg) {
  const resolved = path.resolve(
    outPathArg || `cdp-recording-${Date.now()}.webm`,
  );
  const ext = path.extname(resolved).toLowerCase() || ".webm";
  const finalPath = path.extname(resolved) ? resolved : `${resolved}.webm`;

  if (!SUPPORTED_VIDEO_EXTS.has(ext)) {
    throw new Error(
      `Unsupported recording output extension "${ext}". Supported extensions: .webm (built-in zero-dependency), .mp4 (requires ffmpeg), .gif (requires ffmpeg).`,
    );
  }
  if ((ext === ".mp4" || ext === ".gif") && !hasFfmpeg()) {
    throw new Error(
      `Output format "${ext}" requires ffmpeg in PATH, which is not installed on this machine. Use a ".webm" output path for built-in zero-dependency video recording, or install ffmpeg.`,
    );
  }
  return { outputPath: finalPath, ext };
}

/**
 * Normalize variable-frame-rate spooled frames into a monotonic timeline (ms)
 * starting at 0, appending a final hold frame if the recording remained open
 * after the last repaint so players hold the final UI state to the end.
 */
export function buildNormalizedFramePlan(
  frames,
  startedAtMs,
  stoppedAtMs,
  maxFps = 30,
) {
  const existing = (frames || []).filter(
    (f) => f && f.file && fs.existsSync(f.file),
  );
  if (existing.length === 0) {
    throw new Error(
      "No video frames were captured during the recording session.",
    );
  }

  const minStepMs = Math.max(16, Math.round(1000 / Math.max(1, Math.min(60, maxFps))));
  const baseWallMs = existing[0].wallTimeMs || startedAtMs || Date.now();
  const totalElapsedMs = Math.max(
    120,
    (stoppedAtMs || Date.now()) - (startedAtMs || baseWallMs),
  );

  const plan = [];
  let prevPtsMs = -minStepMs;

  for (let i = 0; i < existing.length; i += 1) {
    const rawRelMs = Math.max(0, (existing[i].wallTimeMs || baseWallMs) - baseWallMs);
    const ptsMs = i === 0 ? 0 : Math.max(rawRelMs, prevPtsMs + minStepMs);
    plan.push({
      file: existing[i].file,
      ptsMs,
      keyframeHint: i === 0,
    });
    prevPtsMs = ptsMs;
  }

  // Ensure at least 2 frames and hold the final UI state up to totalElapsedMs
  const targetEndMs = Math.max(totalElapsedMs, prevPtsMs + 100);
  if (plan.length === 1 || targetEndMs - prevPtsMs >= 80) {
    const holdPtsMs = Math.max(prevPtsMs + minStepMs, targetEndMs - 33);
    plan.push({
      file: existing[existing.length - 1].file,
      ptsMs: holdPtsMs,
      keyframeHint: false,
    });
  }

  // Compute per-frame durationUs and periodic keyframe markers (every ~2s)
  let lastKeyframePtsMs = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const nextPtsMs =
      i + 1 < plan.length
        ? plan[i + 1].ptsMs
        : Math.max(plan[i].ptsMs + 33, targetEndMs);
    plan[i].durationMs = Math.max(16, nextPtsMs - plan[i].ptsMs);
    if (i === 0 || plan[i].ptsMs - lastKeyframePtsMs >= 2_000) {
      plan[i].keyFrame = true;
      lastKeyframePtsMs = plan[i].ptsMs;
    } else {
      plan[i].keyFrame = false;
    }
  }

  return {
    plan,
    durationMs: Math.max(
      targetEndMs,
      plan[plan.length - 1].ptsMs + plan[plan.length - 1].durationMs,
    ),
  };
}

const BROWSER_ENCODER_BOOTSTRAP = `
window.__cdpCreateVideoEncoder = async function(firstFrameB64, bitrate) {
  if (typeof VideoEncoder !== "function") {
    throw new Error("WebCodecs VideoEncoder is not available in this browser context");
  }

  function b64ToUint8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function uint8ToB64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  const firstBlob = new Blob([b64ToUint8(firstFrameB64)], { type: "image/jpeg" });
  const firstBmp = await createImageBitmap(firstBlob);
  const width = Math.max(2, firstBmp.width & ~1);
  const height = Math.max(2, firstBmp.height & ~1);
  firstBmp.close();

  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) {
    ctx.imageSmoothingQuality = "high";
  }

  // Adaptive high bitrate for crisp UI text when caller leaves bitrate=0 (auto):
  // ~6 bits/pixel-sec at 30fps, floored at 12 Mbps (1080p -> ~12.4 Mbps, 1440p -> ~22 Mbps)
  const effectiveBitrate = bitrate > 0
    ? bitrate
    : Math.max(12_000_000, Math.min(32_000_000, Math.round(width * height * 6)));

  const candidates = [
    { codec: "vp09.00.10.08", muxCodecId: "V_VP9", latencyMode: "quality", bitrateMode: "variable" },
    { codec: "vp09.00.10.08", muxCodecId: "V_VP9", latencyMode: "quality" },
    { codec: "vp09.00.10.08", muxCodecId: "V_VP9" },
    { codec: "vp8", muxCodecId: "V_VP8", latencyMode: "quality", bitrateMode: "variable" },
    { codec: "vp8", muxCodecId: "V_VP8" }
  ];

  let chosen = null;
  let chosenCfg = null;
  for (const c of candidates) {
    try {
      const cfg = {
        codec: c.codec,
        width,
        height,
        bitrate: effectiveBitrate,
        framerate: 30
      };
      if (c.latencyMode) cfg.latencyMode = c.latencyMode;
      if (c.bitrateMode) cfg.bitrateMode = c.bitrateMode;
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (sup && sup.supported) {
        chosen = c;
        chosenCfg = cfg;
        break;
      }
    } catch {}
  }
  if (!chosen || !chosenCfg) {
    throw new Error("Neither VP9 nor VP8 WebCodecs VideoEncoder is supported by this browser");
  }

  const outChunks = [];
  let encoderError = null;

  const encoder = new VideoEncoder({
    output(chunk) {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      outChunks.push({
        b64: uint8ToB64(buf),
        timestampMs: Math.max(0, Math.round(chunk.timestamp / 1000)),
        keyframe: chunk.type === "key"
      });
    },
    error(err) {
      encoderError = err;
    }
  });

  encoder.configure(chosenCfg);

  return {
    width,
    height,
    muxCodecId: chosen.muxCodecId,
    async encodeBatch(items) {
      if (encoderError) throw encoderError;
      for (const item of items) {
        const blob = new Blob([b64ToUint8(item.b64)], { type: "image/jpeg" });
        const bmp = await createImageBitmap(blob);
        // Draw 1:1 pixel-exact when dimensions match (including 1px odd-dimension trim)
        // to avoid subpixel resampling blur across sharp UI text!
        if (Math.abs(bmp.width - width) <= 2 && Math.abs(bmp.height - height) <= 2) {
          ctx.drawImage(bmp, 0, 0);
        } else {
          ctx.fillStyle = "#0f172a";
          ctx.fillRect(0, 0, width, height);
          const scale = Math.min(width / bmp.width, height / bmp.height);
          const dw = Math.round(bmp.width * scale);
          const dh = Math.round(bmp.height * scale);
          const dx = Math.floor((width - dw) / 2);
          const dy = Math.floor((height - dh) / 2);
          ctx.drawImage(bmp, dx, dy, dw, dh);
        }
        bmp.close();

        const vf = new VideoFrame(canvas, {
          timestamp: Math.round(item.ptsMs * 1000),
          duration: Math.round(item.durationMs * 1000)
        });
        encoder.encode(vf, { keyFrame: Boolean(item.keyFrame) });
        vf.close();
      }
      await encoder.flush();
      if (encoderError) throw encoderError;
      return outChunks.splice(0, outChunks.length);
    },
    async close() {
      try {
        if (encoder.state !== "closed") {
          await encoder.flush();
          encoder.close();
        }
      } catch {}
      return outChunks.splice(0, outChunks.length);
    }
  };
};
true;
`;

async function encodePlanViaBrowser(plan, requestBridge, options = {}) {
  const bitrate = options.bitrate !== undefined ? Number(options.bitrate) : 0;
  const timeoutMs = Number(options.timeoutMs) || 60_000;

  const created = await requestBridge(
    {
      id: 1,
      method: "Target.createTarget",
      params: { url: "about:blank", background: true },
    },
    15_000,
  );
  const workerTargetId = created.targetId;

  try {
    const attached = await requestBridge(
      {
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: workerTargetId, flatten: true },
      },
      10_000,
    );
    const workerSessionId = attached.sessionId;

    // Navigate hidden worker to a synthetic 127.0.0.1 SecureContext fulfilled in-memory
    // by cdp-bridge via Fetch.fulfillRequest (zero external network, exposes WebCodecs VideoEncoder).
    await requestBridge(
      {
        id: 1,
        method: "Page.enable",
        params: {},
        sessionId: workerSessionId,
      },
      5_000,
    ).catch(() => {});
    await requestBridge(
      {
        id: 1,
        method: "Fetch.enable",
        params: {
          patterns: [{ urlPattern: "http://127.0.0.1/__cdp_video_encoder__*" }],
        },
        sessionId: workerSessionId,
      },
      5_000,
    );
    await requestBridge(
      {
        id: 1,
        method: "Page.navigate",
        params: { url: "http://127.0.0.1/__cdp_video_encoder__" },
        sessionId: workerSessionId,
      },
      10_000,
    );

    const evalWorker = async (expression, stepTimeout = 30_000) => {
      const res = await requestBridge(
        {
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId: workerSessionId,
          timeoutMs: stepTimeout,
        },
        stepTimeout,
      );
      if (res.exceptionDetails) {
        const msg =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "Browser video encoder evaluation failed";
        throw new Error(msg);
      }
      return res.result?.value;
    };

    // Wait briefly for the synthetic SecureContext document to commit before bootstrapping
    for (let i = 0; i < 25; i += 1) {
      const ready = await evalWorker(
        `Boolean(window.isSecureContext && document.readyState === "complete")`,
        5_000,
      ).catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    await evalWorker(BROWSER_ENCODER_BOOTSTRAP, 10_000);

    const firstB64 = fs.readFileSync(plan[0].file).toString("base64");
    const initMeta = await evalWorker(
      `(async () => {
        window.__activeCdpEncoder = await window.__cdpCreateVideoEncoder(${JSON.stringify(firstB64)}, ${bitrate});
        return {
          width: window.__activeCdpEncoder.width,
          height: window.__activeCdpEncoder.height,
          muxCodecId: window.__activeCdpEncoder.muxCodecId
        };
      })()`,
      15_000,
    );

    const allEncodedChunks = [];
    const BATCH_SIZE = 16;

    for (let offset = 0; offset < plan.length; offset += BATCH_SIZE) {
      const slice = plan.slice(offset, offset + BATCH_SIZE).map((item) => ({
        b64: fs.readFileSync(item.file).toString("base64"),
        ptsMs: item.ptsMs,
        durationMs: item.durationMs,
        keyFrame: item.keyFrame,
      }));

      const batchOut = await evalWorker(
        `window.__activeCdpEncoder.encodeBatch(${JSON.stringify(slice)})`,
        Math.max(20_000, timeoutMs),
      );
      for (const ch of batchOut || []) {
        allEncodedChunks.push({
          data: Buffer.from(ch.b64, "base64"),
          timestampMs: ch.timestampMs,
          keyframe: Boolean(ch.keyframe),
        });
      }
    }

    const tailOut = await evalWorker(`window.__activeCdpEncoder.close()`, 10_000);
    for (const ch of tailOut || []) {
      allEncodedChunks.push({
        data: Buffer.from(ch.b64, "base64"),
        timestampMs: ch.timestampMs,
        keyframe: Boolean(ch.keyframe),
      });
    }

    return {
      width: initMeta.width,
      height: initMeta.height,
      codecId: initMeta.muxCodecId,
      chunks: allEncodedChunks,
    };
  } finally {
    await requestBridge(
      {
        id: 1,
        method: "Target.closeTarget",
        params: { targetId: workerTargetId },
      },
      5_000,
    ).catch(() => {});
  }
}

function convertWebmViaFfmpeg(tempWebmPath, outputPath, ext) {
  const args =
    ext === ".mp4"
      ? [
          "-y",
          "-i",
          tempWebmPath,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "17",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          outputPath,
        ]
      : [
          "-y",
          "-i",
          tempWebmPath,
          "-vf",
          "fps=15,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
          outputPath,
        ];

  const res = spawnSync("ffmpeg", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `ffmpeg conversion to ${ext} failed: ${(res.stderr || res.stdout || "").slice(-500)}`,
    );
  }
}

/**
 * Finalize a stopped bridge recording into a playable video file on disk,
 * optionally exporting raw frames and cleaning up the daemon's spool directory.
 */
export async function finalizeRecordingVideo(
  stopPayload,
  options = {},
  requestBridge,
) {
  const rawOutPath = options.outputPath || stopPayload.outputPath;
  const { outputPath, ext } = resolveRecordingOutputPath(rawOutPath);
  const keepFramesDir = options.keepFramesDir
    ? path.resolve(options.keepFramesDir)
    : null;

  try {
    if (keepFramesDir && stopPayload.spoolDir && fs.existsSync(stopPayload.spoolDir)) {
      fs.mkdirSync(keepFramesDir, { recursive: true });
      for (const f of stopPayload.frames || []) {
        if (f.file && fs.existsSync(f.file)) {
          fs.copyFileSync(f.file, path.join(keepFramesDir, path.basename(f.file)));
        }
      }
    }

    const { plan, durationMs } = buildNormalizedFramePlan(
      stopPayload.frames || [],
      stopPayload.startedAtMs,
      stopPayload.stoppedAtMs,
      options.fps || 30,
    );

    const encoded = await encodePlanViaBrowser(plan, requestBridge, {
      bitrate: options.bitrate,
      timeoutMs: options.timeoutMs || 60_000,
    });

    const webmBuf = muxWebm({
      width: encoded.width,
      height: encoded.height,
      durationMs,
      codecId: encoded.codecId,
      chunks: encoded.chunks,
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (ext === ".webm") {
      fs.writeFileSync(outputPath, webmBuf);
    } else {
      const tempWebm = path.join(
        stopPayload.spoolDir || path.dirname(outputPath),
        `temp-${Date.now()}.webm`,
      );
      fs.writeFileSync(tempWebm, webmBuf);
      try {
        convertWebmViaFfmpeg(tempWebm, outputPath, ext);
      } finally {
        try {
          fs.unlinkSync(tempWebm);
        } catch {}
      }
    }

    const finalStat = fs.statSync(outputPath);
    const out = {
      saved: outputPath,
      format: ext.slice(1),
      codec: ext === ".webm" ? (encoded.codecId === "V_VP9" ? "vp9" : "vp8") : ext === ".mp4" ? "h264" : "gif",
      bytes: finalStat.size,
      width: encoded.width,
      height: encoded.height,
      capturedFrames: (stopPayload.frames || []).length,
      encodedFrames: plan.length,
      durationMs: Math.round(durationMs),
    };
    if (keepFramesDir) {
      out.framesDir = keepFramesDir;
    }
    return out;
  } finally {
    if (stopPayload?.spoolDir) {
      try {
        fs.rmSync(stopPayload.spoolDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
