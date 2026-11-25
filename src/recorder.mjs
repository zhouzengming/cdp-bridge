import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { concatWebmBuffers, demuxWebm, muxWebm } from "./webm-muxer.mjs";

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
  pausedTotalMs = 0,
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
  const hasEffectiveTs = existing.every((f) => Number.isFinite(f.effectiveTimeMs));
  const baseMs = hasEffectiveTs
    ? existing[0].effectiveTimeMs
    : existing[0].wallTimeMs || startedAtMs || Date.now();
  const rawActiveSpanMs =
    (stoppedAtMs || Date.now()) -
    (startedAtMs || existing[0].wallTimeMs || Date.now()) -
    Math.max(0, Number(pausedTotalMs) || 0);
  const totalElapsedMs = Math.max(120, rawActiveSpanMs);

  const plan = [];
  let prevPtsMs = -minStepMs;

  for (let i = 0; i < existing.length; i += 1) {
    const rawRelMs = hasEffectiveTs
      ? Math.max(0, existing[i].effectiveTimeMs - baseMs)
      : Math.max(0, (existing[i].wallTimeMs || baseMs) - baseMs);
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
      stopPayload.pausedTotalMs || 0,
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
    if (stopPayload.pauseCount) {
      out.pauseCount = stopPayload.pauseCount;
      out.skippedDurationMs = Math.round(stopPayload.pausedTotalMs || 0);
    }
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

async function withSecureEncoderWorker(requestBridge, timeoutMs, fn) {
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
    await requestBridge(
      { id: 1, method: "Page.enable", params: {}, sessionId: workerSessionId },
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

    const evalWorker = async (expression, stepTimeout = timeoutMs || 30_000) => {
      const res = await requestBridge(
        {
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
          sessionId: workerSessionId,
          timeoutMs: stepTimeout,
        },
        stepTimeout,
      );
      if (res.exceptionDetails) {
        const msg =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "Browser video worker evaluation failed";
        throw new Error(msg);
      }
      return res.result?.value;
    };

    for (let i = 0; i < 25; i += 1) {
      const ready = await evalWorker(
        `Boolean(window.isSecureContext && document.readyState === "complete")`,
        5_000,
      ).catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    return await fn(evalWorker);
  } finally {
    await requestBridge(
      { id: 1, method: "Target.closeTarget", params: { targetId: workerTargetId } },
      5_000,
    ).catch(() => {});
  }
}

/**
 * Render a brief (750ms) lossless-spliced transition toast clip ("⏭ 片段 k/N · 已跳过等待")
 * on top of Segment k's first keyframe using WebCodecs VideoDecoder + VideoEncoder.
 */
async function tryBuildSpliceToastChunks(
  segment,
  segmentIdx,
  totalSegments,
  customLabel,
  requestBridge,
) {
  if (typeof requestBridge !== "function") return null;
  const firstChunk = segment.chunks[0];
  if (!firstChunk) return null;
  const decoderCodec =
    segment.codecId === "V_VP9" ? "vp09.00.10.08" : "vp8";
  const toastText =
    customLabel || `⏭ 衔接片段 ${segmentIdx + 1}/${totalSegments} · 已跳过中间等待`;

  return withSecureEncoderWorker(requestBridge, 20_000, async (evalWorker) => {
    const firstB64 = firstChunk.data.toString("base64");
    const expr = `(async () => {
      if (typeof VideoDecoder !== "function" || typeof VideoEncoder !== "function") {
        return null;
      }
      function b64ToUint8(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }
      function uint8ToB64(bytes) {
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
      }

      const w = ${segment.width};
      const h = ${segment.height};
      let decodedFrame = null;
      const decoder = new VideoDecoder({
        output(vf) {
          if (!decodedFrame) decodedFrame = vf;
          else vf.close();
        },
        error() {}
      });
      decoder.configure({ codec: ${JSON.stringify(decoderCodec)}, codedWidth: w, codedHeight: h });
      decoder.decode(new EncodedVideoChunk({
        type: "key",
        timestamp: 0,
        data: b64ToUint8(${JSON.stringify(firstB64)})
      }));
      await decoder.flush();
      decoder.close();
      if (!decodedFrame) return null;

      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d", { alpha: false });
      const out = [];
      const bitrate = Math.max(12000000, Math.min(32000000, Math.round(w * h * 6)));
      const encoder = new VideoEncoder({
        output(ch) {
          const b = new Uint8Array(ch.byteLength);
          ch.copyTo(b);
          out.push({
            b64: uint8ToB64(b),
            timestampMs: Math.max(0, Math.round(ch.timestamp / 1000)),
            keyframe: ch.type === "key"
          });
        },
        error() {}
      });
      encoder.configure({ codec: ${JSON.stringify(decoderCodec)}, width: w, height: h, bitrate, framerate: 30 });

      const label = ${JSON.stringify(toastText)};
      ctx.font = "600 12px system-ui, -apple-system, sans-serif";
      const tw = Math.ceil(ctx.measureText(label).width);
      const pillW = tw + 24;
      const pillH = 26;
      const pillX = Math.max(12, w - pillW - 14);
      const pillY = 42; // Right beneath top-right REC pill

      const totalFrames = 22; // ~733ms crisp toast bridge
      for (let i = 0; i < totalFrames; i++) {
        ctx.drawImage(decodedFrame, 0, 0, w, h);
        const alpha = i < 3 ? (i + 1) / 3 : i > 17 ? (totalFrames - i) / 5 : 1;
        ctx.save();
        ctx.globalAlpha = 0.8 * alpha;
        ctx.fillStyle = "rgba(15, 23, 42, 0.28)";
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 13);
        ctx.fill();
        ctx.strokeStyle = "rgba(56, 189, 248, 0.34)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.shadowColor = "rgba(15, 23, 42, 0.55)";
        ctx.shadowBlur = 2;
        ctx.shadowOffsetY = 0.8;
        ctx.fillStyle = "rgba(240, 249, 255, 0.94)";
        ctx.textBaseline = "middle";
        ctx.fillText(label, pillX + 12, pillY + pillH / 2 + 0.5);
        ctx.restore();

        const vf = new VideoFrame(canvas, { timestamp: i * 33333, duration: 33333 });
        encoder.encode(vf, { keyFrame: i === 0 });
        vf.close();
      }
      decodedFrame.close();
      await encoder.flush();
      encoder.close();
      return out;
    })()`;
    const res = await evalWorker(expr, 15_000);
    if (!Array.isArray(res) || res.length === 0) return null;
    return {
      durationMs: res.length * 33,
      chunks: res.map((ch) => ({
        data: Buffer.from(ch.b64, "base64"),
        timestampMs: ch.timestampMs,
        keyframe: Boolean(ch.keyframe),
      })),
    };
  }).catch(() => null);
}

/**
 * Normalize & concatenate mixed-resolution or mixed-codec WebM segments via WebCodecs.
 */
async function reencodeMixedWebmSegments(
  segments,
  showBadge,
  requestBridge,
  timeoutMs = 90_000,
) {
  if (typeof requestBridge !== "function") {
    throw new Error(
      "Input WebM segments have mismatched dimensions/codecs; connect cdp-bridge to a browser (or install ffmpeg) to normalize and merge them.",
    );
  }
  const targetWidth = Math.max(...segments.map((s) => s.width)) & ~1;
  const targetHeight = Math.max(...segments.map((s) => s.height)) & ~1;

  return withSecureEncoderWorker(requestBridge, timeoutMs, async (evalWorker) => {
    await evalWorker(
      `(() => {
        const w = ${targetWidth};
        const h = ${targetHeight};
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = true;
        if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
        const out = [];
        const bitrate = Math.max(12000000, Math.min(32000000, Math.round(w * h * 6)));
        const encoder = new VideoEncoder({
          output(ch) {
            const b = new Uint8Array(ch.byteLength);
            ch.copyTo(b);
            let bin = "";
            for (let i = 0; i < b.length; i += 0x8000) {
              bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
            }
            out.push({
              b64: btoa(bin),
              timestampMs: Math.max(0, Math.round(ch.timestamp / 1000)),
              keyframe: ch.type === "key"
            });
          },
          error(e) { window.__cdpConcatErr = e; }
        });
        encoder.configure({ codec: "vp09.00.10.08", width: w, height: h, bitrate, framerate: 30, latencyMode: "quality" });
        window.__cdpMixedConcat = { canvas, ctx, encoder, out, w, h };
        return true;
      })()`,
      10_000,
    );

    let baseMs = 0;
    const allChunks = [];

    for (let s = 0; s < segments.length; s += 1) {
      const seg = segments[s];
      const decCodec = seg.codecId === "V_VP9" ? "vp09.00.10.08" : "vp8";
      const badgeText =
        showBadge && s > 0
          ? `⏭ 衔接片段 ${s + 1}/${segments.length} · 已跳过中间等待`
          : "";

      await evalWorker(
        `(() => {
          const st = window.__cdpMixedConcat;
          st.decoder = new VideoDecoder({
            output(vf) {
              const relMs = Math.max(0, Math.round(vf.timestamp / 1000)) - ${baseMs};
              st.ctx.fillStyle = "#0f172a";
              st.ctx.fillRect(0, 0, st.w, st.h);
              const scale = Math.min(st.w / vf.displayWidth, st.h / vf.displayHeight);
              const dw = Math.round(vf.displayWidth * scale);
              const dh = Math.round(vf.displayHeight * scale);
              st.ctx.drawImage(vf, Math.floor((st.w - dw) / 2), Math.floor((st.h - dh) / 2), dw, dh);
              const label = ${JSON.stringify(badgeText)};
              if (label && relMs <= 1600) {
                st.ctx.save();
                st.ctx.font = "600 12px system-ui, -apple-system, sans-serif";
                const tw = Math.ceil(st.ctx.measureText(label).width);
                const pw = tw + 24, ph = 26, px = Math.max(12, st.w - pw - 14), py = 42;
                st.ctx.globalAlpha = relMs > 1200 ? Math.max(0, (1600 - relMs) / 400) : 0.92;
                st.ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
                st.ctx.beginPath();
                st.ctx.roundRect(px, py, pw, ph, 13);
                st.ctx.fill();
                st.ctx.strokeStyle = "rgba(56, 189, 248, 0.62)";
                st.ctx.stroke();
                st.ctx.fillStyle = "#e0f2fe";
                st.ctx.textBaseline = "middle";
                st.ctx.fillText(label, px + 12, py + ph / 2 + 0.5);
                st.ctx.restore();
              }
              const outVf = new VideoFrame(st.canvas, { timestamp: vf.timestamp, duration: 33333 });
              st.encoder.encode(outVf, { keyFrame: relMs === 0 });
              outVf.close();
              vf.close();
            },
            error(e) { window.__cdpConcatErr = e; }
          });
          st.decoder.configure({ codec: ${JSON.stringify(decCodec)}, codedWidth: ${seg.width}, codedHeight: ${seg.height} });
          return true;
        })()`,
        10_000,
      );

      const BATCH = 24;
      for (let off = 0; off < seg.chunks.length; off += BATCH) {
        const slice = seg.chunks.slice(off, off + BATCH).map((c, idx) => ({
          b64: c.data.toString("base64"),
          tsUs: Math.round((baseMs + c.timestampMs) * 1000),
          key: Boolean(c.keyframe || (off === 0 && idx === 0)),
        }));
        const batchOut = await evalWorker(
          `(async () => {
            const st = window.__cdpMixedConcat;
            for (const it of ${JSON.stringify(slice)}) {
              const bin = atob(it.b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              st.decoder.decode(new EncodedVideoChunk({
                type: it.key ? "key" : "delta",
                timestamp: it.tsUs,
                data: bytes
              }));
            }
            await st.decoder.flush();
            await st.encoder.flush();
            if (window.__cdpConcatErr) throw window.__cdpConcatErr;
            return st.out.splice(0, st.out.length);
          })()`,
          30_000,
        );
        for (const ch of batchOut || []) {
          allChunks.push({
            data: Buffer.from(ch.b64, "base64"),
            timestampMs: ch.timestampMs,
            keyframe: Boolean(ch.keyframe),
          });
        }
      }

      await evalWorker(`window.__cdpMixedConcat.decoder.close(); true;`, 5_000);
      baseMs += seg.durationMs + 33;
    }

    const tail = await evalWorker(
      `(async () => {
        const st = window.__cdpMixedConcat;
        await st.encoder.flush();
        st.encoder.close();
        return st.out.splice(0, st.out.length);
      })()`,
      10_000,
    );
    for (const ch of tail || []) {
      allChunks.push({
        data: Buffer.from(ch.b64, "base64"),
        timestampMs: ch.timestampMs,
        keyframe: Boolean(ch.keyframe),
      });
    }

    return {
      buffer: muxWebm({
        width: targetWidth,
        height: targetHeight,
        durationMs: baseMs,
        codecId: "V_VP9",
        chunks: allChunks,
      }),
      width: targetWidth,
      height: targetHeight,
      codecId: "V_VP9",
      durationMs: baseMs,
      mode: "reencoded-normalized",
    };
  });
}

/**
 * Concatenate multiple recorded video files (.webm, or .mp4 via ffmpeg) into one output video.
 * Uses bit-exact zero-re-encode EBML splicing when WebM dimensions/codecs match (with optional
 * 0.7s splice toast bridge), falling back to WebCodecs normalization when dimensions differ.
 */
export async function concatRecordingVideos(
  inputPaths,
  options = {},
  requestBridge = null,
) {
  if (!Array.isArray(inputPaths) || inputPaths.length < 2) {
    throw new Error(
      "Usage: cdp record concat <seg1.webm> <seg2.webm> [...more] -o <merged.webm> [--rm] [--no-badge]",
    );
  }
  const resolvedInputs = inputPaths.map((p) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      throw new Error(`Input video segment not found: ${abs}`);
    }
    return abs;
  });

  const { outputPath, ext } = resolveRecordingOutputPath(
    options.outputPath || `cdp-merged-${Date.now()}.webm`,
  );
  const showBadge = options.showBadge !== false;
  const cleanupInputs = Boolean(options.cleanupInputs);
  const allWebmInputs = resolvedInputs.every(
    (p) => path.extname(p).toLowerCase() === ".webm",
  );

  if (!allWebmInputs) {
    if (!hasFfmpeg()) {
      throw new Error(
        "Concatenating non-.webm files requires ffmpeg in PATH. Record segments as .webm for zero-dependency concatenation.",
      );
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const listFile = path.join(
      path.dirname(outputPath),
      `.cdp-concat-${Date.now()}.txt`,
    );
    fs.writeFileSync(
      listFile,
      resolvedInputs
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n"),
      "utf8",
    );
    try {
      const res = spawnSync(
        "ffmpeg",
        ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outputPath],
        { encoding: "utf8", windowsHide: true, timeout: 120_000 },
      );
      if (res.status !== 0) {
        throw new Error(
          `ffmpeg concat failed: ${(res.stderr || res.stdout || "").slice(-500)}`,
        );
      }
    } finally {
      try {
        fs.unlinkSync(listFile);
      } catch {}
    }
    const st = fs.statSync(outputPath);
    if (cleanupInputs && st.size > 0) {
      for (const inp of resolvedInputs) {
        if (inp !== outputPath) {
          try { fs.unlinkSync(inp); } catch {}
        }
      }
    }
    return {
      saved: outputPath,
      format: ext.slice(1),
      bytes: st.size,
      segmentCount: resolvedInputs.length,
      mode: "ffmpeg-concat",
      cleanedInputs: cleanupInputs,
    };
  }

  const parsedSegments = resolvedInputs.map((p) => demuxWebm(fs.readFileSync(p)));
  const first = parsedSegments[0];
  const sameFormat = parsedSegments.every(
    (s) =>
      s.width === first.width &&
      s.height === first.height &&
      s.codecId === first.codecId,
  );

  let mergedWebmInfo;
  if (sameFormat) {
    const mergedChunks = [];
    let offsetMs = 0;
    let spliceBridgesInserted = 0;

    for (let s = 0; s < parsedSegments.length; s += 1) {
      const seg = parsedSegments[s];
      if (s > 0 && showBadge && typeof requestBridge === "function") {
        const bridge = await tryBuildSpliceToastChunks(
          seg,
          s,
          parsedSegments.length,
          options.badgeLabel || "",
          requestBridge,
        );
        if (bridge && bridge.chunks.length > 0) {
          for (let b = 0; b < bridge.chunks.length; b += 1) {
            mergedChunks.push({
              data: bridge.chunks[b].data,
              timestampMs: offsetMs + bridge.chunks[b].timestampMs,
              keyframe: b === 0 ? true : bridge.chunks[b].keyframe,
            });
          }
          offsetMs += bridge.durationMs;
          spliceBridgesInserted += 1;
        }
      }

      for (let c = 0; c < seg.chunks.length; c += 1) {
        mergedChunks.push({
          data: seg.chunks[c].data,
          timestampMs: offsetMs + seg.chunks[c].timestampMs,
          keyframe: c === 0 ? true : seg.chunks[c].keyframe,
        });
      }
      offsetMs += seg.durationMs + (s + 1 < parsedSegments.length ? 33 : 0);
    }

    mergedWebmInfo = {
      buffer: muxWebm({
        width: first.width,
        height: first.height,
        durationMs: offsetMs,
        codecId: first.codecId,
        chunks: mergedChunks,
      }),
      width: first.width,
      height: first.height,
      codecId: first.codecId,
      durationMs: offsetMs,
      mode:
        spliceBridgesInserted > 0
          ? "lossless-with-splice-toast"
          : "lossless-remux",
    };
  } else {
    mergedWebmInfo = await reencodeMixedWebmSegments(
      parsedSegments,
      showBadge,
      requestBridge,
      options.timeoutMs || 90_000,
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (ext === ".webm") {
    fs.writeFileSync(outputPath, mergedWebmInfo.buffer);
  } else {
    const tempWebm = `${outputPath}.tmp-${Date.now()}.webm`;
    fs.writeFileSync(tempWebm, mergedWebmInfo.buffer);
    try {
      convertWebmViaFfmpeg(tempWebm, outputPath, ext);
    } finally {
      try {
        fs.unlinkSync(tempWebm);
      } catch {}
    }
  }

  const finalStat = fs.statSync(outputPath);
  if (cleanupInputs && finalStat.size > 0) {
    for (const inp of resolvedInputs) {
      if (inp !== outputPath) {
        try {
          fs.unlinkSync(inp);
        } catch {}
      }
    }
  }

  return {
    saved: outputPath,
    format: ext.slice(1),
    codec:
      ext === ".webm"
        ? mergedWebmInfo.codecId === "V_VP9"
          ? "vp9"
          : "vp8"
        : ext === ".mp4"
          ? "h264"
          : "gif",
    bytes: finalStat.size,
    width: mergedWebmInfo.width,
    height: mergedWebmInfo.height,
    durationMs: Math.round(mergedWebmInfo.durationMs),
    segmentCount: resolvedInputs.length,
    mode: mergedWebmInfo.mode,
    cleanedInputs: cleanupInputs,
  };
}
