/**
 * Zero-dependency WebM (Matroska v4 EBML subset) single-track video muxer.
 * Supports V_VP8 and V_VP9 encoded chunks with exact Segment size, Duration,
 * multi-Cluster timecode splitting, and a Cues keyframe seek index.
 */

function encodeVintSize(length) {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`Invalid EBML element size: ${length}`);
  }
  // Strict `<` because all-1s value bits (0x7F, 0x3FFF, ...) mean "unknown size" in EBML
  if (length < 0x7f) {
    return Buffer.from([0x80 | length]);
  }
  if (length < 0x3fff) {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(0x4000 | length, 0);
    return b;
  }
  if (length < 0x1fffff) {
    return Buffer.from([
      0x20 | ((length >> 16) & 0x1f),
      (length >> 8) & 0xff,
      length & 0xff,
    ]);
  }
  if (length < 0x0fffffff) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE((0x10000000 | length) >>> 0, 0);
    return b;
  }
  return encodeFixed8ByteVintSize(length);
}

function encodeFixed8ByteVintSize(length) {
  const b = Buffer.allocUnsafe(8);
  const big = BigInt(length);
  b[0] = 0x01;
  b[1] = Number((big >> 48n) & 0xffn);
  b[2] = Number((big >> 40n) & 0xffn);
  b[3] = Number((big >> 32n) & 0xffn);
  b[4] = Number((big >> 24n) & 0xffn);
  b[5] = Number((big >> 16n) & 0xffn);
  b[6] = Number((big >> 8n) & 0xffn);
  b[7] = Number(big & 0xffn);
  return b;
}

function encodeUint(value) {
  const big = BigInt(Math.max(0, Math.round(Number(value) || 0)));
  if (big === 0n) {
    return Buffer.from([0x00]);
  }
  const bytes = [];
  let rem = big;
  while (rem > 0n) {
    bytes.unshift(Number(rem & 0xffn));
    rem >>= 8n;
  }
  return Buffer.from(bytes);
}

function encodeFloat64(value) {
  const b = Buffer.allocUnsafe(8);
  b.writeDoubleBE(Number(value) || 0, 0);
  return b;
}

function encodeString(str) {
  return Buffer.from(String(str), "utf8");
}

function ebmlElement(idBytes, payload) {
  const idBuf = Buffer.isBuffer(idBytes) ? idBytes : Buffer.from(idBytes);
  const bodyBuf = Buffer.isBuffer(payload)
    ? payload
    : Array.isArray(payload)
      ? Buffer.concat(payload)
      : Buffer.from(payload);
  return Buffer.concat([idBuf, encodeVintSize(bodyBuf.length), bodyBuf]);
}

function ebmlElementFixed8(idBytes, payload) {
  const idBuf = Buffer.isBuffer(idBytes) ? idBytes : Buffer.from(idBytes);
  const bodyBuf = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  return Buffer.concat([idBuf, encodeFixed8ByteVintSize(bodyBuf.length), bodyBuf]);
}

function createSimpleBlock(relTimestampMs, isKeyframe, frameData) {
  const header = Buffer.allocUnsafe(4);
  header[0] = 0x81; // Track number 1 as 1-byte VINT
  header.writeInt16BE(relTimestampMs, 1);
  header[3] = isKeyframe ? 0x80 : 0x00;
  const payload = Buffer.concat([
    header,
    Buffer.isBuffer(frameData) ? frameData : Buffer.from(frameData),
  ]);
  return ebmlElement([0xa3], payload);
}

/**
 * Mux encoded VP8 or VP9 video chunks into a standalone, seekable WebM Buffer.
 *
 * @param {object} options
 * @param {number} options.width - Video pixel width (>0)
 * @param {number} options.height - Video pixel height (>0)
 * @param {number} options.durationMs - Total clip duration in milliseconds
 * @param {"V_VP8"|"V_VP9"} [options.codecId="V_VP8"] - WebM CodecID
 * @param {Array<{data: Buffer|Uint8Array, timestampMs: number, keyframe: boolean}>} options.chunks
 * @returns {Buffer}
 */
export function muxWebm({
  width,
  height,
  durationMs,
  codecId = "V_VP8",
  chunks = [],
}) {
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Invalid video dimensions for WebM muxer: ${width}x${height}`);
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("Cannot mux WebM video with zero encoded chunks");
  }

  const normalizedCodec = codecId === "V_VP9" ? "V_VP9" : "V_VP8";

  // 1. EBML Header (0x1A45DFA3)
  const ebmlHeader = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], [
    ebmlElement([0x42, 0x86], encodeUint(1)), // EBMLVersion = 1
    ebmlElement([0x42, 0xf7], encodeUint(1)), // EBMLReadVersion = 1
    ebmlElement([0x42, 0xf2], encodeUint(4)), // EBMLMaxIDLength = 4
    ebmlElement([0x42, 0xf3], encodeUint(8)), // EBMLMaxSizeLength = 8
    ebmlElement([0x42, 0x82], encodeString("webm")), // DocType = "webm"
    ebmlElement([0x42, 0x87], encodeUint(4)), // DocTypeVersion = 4
    ebmlElement([0x42, 0x85], encodeUint(2)), // DocTypeReadVersion = 2
  ]);

  const lastChunkTs = Math.max(0, Math.round(chunks[chunks.length - 1].timestampMs || 0));
  const finalDurationMs = Math.max(Number(durationMs) || 0, lastChunkTs + 33);

  // 2. Segment Info (0x1549A966)
  const segmentInfo = ebmlElement([0x15, 0x49, 0xa9, 0x66], [
    ebmlElement([0x2a, 0xd7, 0xb1], encodeUint(1_000_000)), // TimestampScale = 1ms
    ebmlElement([0x44, 0x89], encodeFloat64(finalDurationMs)), // Duration (ms)
    ebmlElement([0x4d, 0x80], encodeString("cdp-bridge")), // MuxingApp
    ebmlElement([0x57, 0x41], encodeString("cdp-bridge")), // WritingApp
  ]);

  // 3. Tracks (0x1654AE6B)
  const videoSettings = ebmlElement([0xe0], [
    ebmlElement([0xb0], encodeUint(width)), // PixelWidth
    ebmlElement([0xba], encodeUint(height)), // PixelHeight
  ]);

  const trackEntry = ebmlElement([0xae], [
    ebmlElement([0xd7], encodeUint(1)), // TrackNumber = 1
    ebmlElement([0x73, 0xc5], encodeUint(1)), // TrackUID = 1
    ebmlElement([0x9c], encodeUint(0)), // FlagLacing = 0
    ebmlElement([0x22, 0xb5, 0x9c], encodeString("und")), // Language = und
    ebmlElement([0x86], encodeString(normalizedCodec)), // CodecID
    ebmlElement([0x83], encodeUint(1)), // TrackType = 1 (video)
    videoSettings,
  ]);

  const tracksElement = ebmlElement([0x16, 0x54, 0xae, 0x6b], [trackEntry]);

  // 4. Group chunks into Clusters (0x1F43B675) so relative int16 timecodes stay in 0..25000ms
  const clusterSpecs = [];
  let currentCluster = null;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const tsMs = Math.max(0, Math.round(chunk.timestampMs || 0));
    const isKeyframe = Boolean(chunk.keyframe || i === 0);

    const needNewCluster =
      !currentCluster ||
      tsMs - currentCluster.startMs > 25_000 ||
      (isKeyframe && tsMs - currentCluster.startMs >= 1_000);

    if (needNewCluster) {
      currentCluster = {
        startMs: tsMs,
        startsWithKeyframe: isKeyframe,
        blocks: [],
      };
      clusterSpecs.push(currentCluster);
    }

    const relTs = Math.max(0, Math.min(32_767, tsMs - currentCluster.startMs));
    currentCluster.blocks.push(createSimpleBlock(relTs, isKeyframe, chunk.data));
  }

  const preClusterOffset = segmentInfo.length + tracksElement.length;
  const clusterBuffers = [];
  const cuePoints = [];
  let runningOffset = preClusterOffset;

  for (const spec of clusterSpecs) {
    const clusterBuf = ebmlElement([0x1f, 0x43, 0xb6, 0x75], [
      ebmlElement([0xe7], encodeUint(spec.startMs)), // Cluster Timestamp
      ...spec.blocks,
    ]);
    if (spec.startsWithKeyframe) {
      cuePoints.push({
        timeMs: spec.startMs,
        clusterPosition: runningOffset,
      });
    }
    clusterBuffers.push(clusterBuf);
    runningOffset += clusterBuf.length;
  }

  // 5. Cues (0x1C53BB6B) placed after Clusters (offsets relative to Segment data start)
  const cueElements = cuePoints.map((cp) =>
    ebmlElement([0xbb], [
      ebmlElement([0xb3], encodeUint(cp.timeMs)), // CueTime
      ebmlElement([0xb7], [
        ebmlElement([0xf7], encodeUint(1)), // CueTrack = 1
        ebmlElement([0xf1], encodeUint(cp.clusterPosition)), // CueClusterPosition
      ]),
    ]),
  );
  const cuesElement =
    cueElements.length > 0
      ? ebmlElement([0x1c, 0x53, 0xbb, 0x6b], cueElements)
      : Buffer.alloc(0);

  // 6. Segment (0x18538067) with exact 8-byte VINT size
  const segmentElement = ebmlElementFixed8([0x18, 0x53, 0x80, 0x67], [
    segmentInfo,
    tracksElement,
    ...clusterBuffers,
    cuesElement,
  ]);

  return Buffer.concat([ebmlHeader, segmentElement]);
}

/**
 * Lightweight EBML structural inspector for tests and diagnostics.
 */
export function inspectWebmBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) {
    return { valid: false, reason: "buffer-too-small" };
  }
  const magic = buf.subarray(0, 4).toString("hex");
  if (magic !== "1a45dfa3") {
    return { valid: false, reason: `bad-ebml-magic:${magic}` };
  }
  const hasWebmDocType = buf.subarray(0, 64).includes(Buffer.from("webm", "utf8"));
  const segmentIdx = buf.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  let clusterCount = 0;
  let searchPos = segmentIdx >= 0 ? segmentIdx + 12 : 0;
  while (searchPos < buf.length) {
    const found = buf.indexOf(clusterId, searchPos);
    if (found === -1) break;
    clusterCount += 1;
    searchPos = found + 4;
  }
  const hasCues = buf.indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])) !== -1;
  return {
    valid: hasWebmDocType && segmentIdx > 0 && clusterCount > 0,
    bytes: buf.length,
    hasWebmDocType,
    segmentOffset: segmentIdx,
    clusterCount,
    hasCues,
  };
}
