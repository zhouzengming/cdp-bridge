import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(srcDir, "..");
export const DEFAULT_DIAG_LOG_PATH = path.join(repoDir, "logs", "diag.jsonl");

const MAX_PREVIEW_CHARS = 100;
const MAX_ARG_CHARS = 100;
const MAX_ERROR_CHARS = 400;
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MiB per file
const MAX_ROTATED_FILES = 3;

const CANONICAL_COMMAND_MAP = {
  connect: "connect",
  start: "start",
  restart: "restart",
  stop: "stop",
  status: "status",
  pages: "pages",
  list: "pages",
  tabs: "pages",
  "list-pages": "pages",
  targets: "targets",
  "list-targets": "targets",
  open: "open",
  "page-open": "open",
  close: "close",
  "page-close": "close",
  focus: "focus",
  activate: "focus",
  "page-focus": "focus",
  "page-activate": "focus",
  call: "call",
  send: "call",
  raw: "call",
  elements: "elements",
  "page-elements": "elements",
  snapshot: "elements",
  snap: "elements",
  "page-eval": "page-eval",
  eval: "page-eval",
  "page-text": "page-text",
  text: "page-text",
  "page-screenshot": "page-screenshot",
  screenshot: "page-screenshot",
  shot: "page-screenshot",
  "page-record": "page-record",
  record: "page-record",
  screencast: "page-record",
  "page-fill": "page-fill",
  fill: "page-fill",
  "page-type": "page-fill",
  type: "page-fill",
  "page-click": "page-click",
  click: "page-click",
  "page-hover": "page-hover",
  hover: "page-hover",
  move: "page-hover",
  "page-drag": "page-drag",
  drag: "page-drag",
  dnd: "page-drag",
  "page-scroll": "page-scroll",
  scroll: "page-scroll",
  wheel: "page-scroll",
  "page-wheel": "page-scroll",
  "page-reload": "page-reload",
  reload: "page-reload",
  "page-wait": "page-wait",
  wait: "page-wait",
  "page-navigate": "page-navigate",
  navigate: "page-navigate",
  goto: "page-navigate",
  nav: "page-navigate",
  "page-goto": "page-navigate",
  "page-logs": "page-logs",
  logs: "page-logs",
  "page-network": "page-network",
  network: "page-network",
  batch: "batch",
  diag: "diag",
  help: "help",
};

export function resolveDiagLogPath(overridePath) {
  if (overridePath && typeof overridePath === "string") {
    return path.resolve(overridePath);
  }
  if (process.env.CDP_DIAG_LOG) {
    return path.resolve(process.env.CDP_DIAG_LOG);
  }
  return DEFAULT_DIAG_LOG_PATH;
}

export function isDiagEnabled(disabledByFlag = false) {
  if (disabledByFlag) return false;
  const envVal = String(process.env.CDP_DIAG ?? "").trim().toLowerCase();
  if (envVal === "0" || envVal === "false" || envVal === "off") {
    return false;
  }
  return true;
}

export function normalizeCommandName(rawCommand) {
  if (!rawCommand) return "(none)";
  const key = String(rawCommand).toLowerCase();
  return CANONICAL_COMMAND_MAP[key] || "unknown";
}

export function redactSensitive(input) {
  if (input === null || input === undefined) return "";
  let text = String(input);
  // JWT tokens (eyJ...)
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[JWT_REDACTED]",
  );
  // Bearer / Basic authorization headers
  text = text.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "$1 [REDACTED]",
  );
  // Key-value secrets in JSON, URLs, or JS assignments
  text = text.replace(
    /((?:[a-z0-9_]*_)?(?:token|api[_-]?key|password|secret|authorization|cookie)\s*["'`:=]+\s*["']?)([^"'\s,;}{&]{6,})/gi,
    "$1[REDACTED]",
  );
  return text;
}

export function truncateSummary(input, maxChars = MAX_PREVIEW_CHARS) {
  if (input === null || input === undefined) return "";
  const singleLine = redactSensitive(input).replace(/\s+/g, " ").trim();
  const chars = Array.from(singleLine);
  if (chars.length <= maxChars) {
    return singleLine;
  }
  if (maxChars <= 1) {
    return chars.slice(0, maxChars).join("");
  }
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function detectCallerContext() {
  let agent = process.env.CDP_CALLER || "";
  let sessionId;

  if (!agent) {
    if (
      process.env.ANTIGRAVITY_AGENT ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      process.env.ANTIGRAVITY_CLI
    ) {
      agent = "antigravity";
      sessionId = process.env.ANTIGRAVITY_CONVERSATION_ID;
    } else if (
      process.env.CLAUDECODE ||
      process.env.CLAUDE_CODE_ENTRYPOINT ||
      process.env.CLAUDE_SESSION_ID
    ) {
      agent = "claude-code";
      sessionId = process.env.CLAUDE_SESSION_ID;
    } else if (
      process.env.CODEX_SANDBOX ||
      process.env.CODEX_CI ||
      process.env.CODEX_THREAD_ID
    ) {
      agent = "codex";
      sessionId = process.env.CODEX_THREAD_ID;
    } else {
      agent = "terminal";
    }
  }

  const out = {
    agent,
    cwd: process.cwd(),
    ppid: process.ppid,
  };
  if (sessionId) {
    out.sessionId = String(sessionId).slice(0, 36);
  }
  return out;
}

function buildResultPreviewAndMeta(canonicalCommand, data, telemetry = {}) {
  const meta = {};
  if (telemetry.autoStarted) meta.autoStarted = true;
  if (telemetry.reattached) meta.reattached = true;

  let target;
  const page = data?.page;
  if (page && typeof page === "object") {
    target = {
      targetId: page.targetId ? String(page.targetId).slice(0, 8) : undefined,
      url: page.url ? truncateSummary(page.url, 100) : undefined,
    };
    if (page.ambiguousMatches && page.ambiguousMatches > 1) {
      target.ambiguousMatches = page.ambiguousMatches;
      meta.ambiguousTarget = true;
    }
  } else if (data?.targetId) {
    target = {
      targetId: String(data.targetId).slice(0, 8),
      url: data.url ? truncateSummary(data.url, 100) : undefined,
    };
  }

  if (data && typeof data === "object") {
    if (data.serializedFallback) meta.serializedFallback = true;
    if (data.matchedBy) meta.matchedBy = data.matchedBy;
    if (data.tag) meta.tag = data.tag;
    if (data.role) meta.role = data.role;
    if (data.mode) meta.mode = data.mode;
    if (data.direction) meta.direction = data.direction;
    if (typeof data.count === "number") meta.count = data.count;
    if (typeof data.totalMatched === "number") meta.totalMatched = data.totalMatched;
    if (typeof data.completedSteps === "number") meta.completedSteps = data.completedSteps;
    if (typeof data.bytes === "number") meta.bytes = data.bytes;
    if (data.format) meta.format = data.format;
    if (data.codec) meta.codec = data.codec;
    if (typeof data.capturedFrames === "number") meta.capturedFrames = data.capturedFrames;
    if (typeof data.durationMs === "number") meta.durationMs = data.durationMs;
    if (data.exceptionDetails) {
      meta.hasException = true;
      const desc =
        data.exceptionDetails.exception?.description ||
        data.exceptionDetails.text ||
        "JS exception";
      meta.exceptionPreview = truncateSummary(desc, MAX_PREVIEW_CHARS);
    }
  }

  // Construct concise <=100 char preview tailored to the command output
  let rawPreview = "";
  if (data === null || data === undefined) {
    rawPreview = "";
  } else if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    rawPreview = String(data);
  } else if (canonicalCommand === "page-eval" && "evaluation" in data) {
    if (data.exceptionDetails) {
      rawPreview =
        data.exceptionDetails.exception?.description ||
        data.exceptionDetails.text ||
        "exception";
    } else {
      const val = data.evaluation?.value;
      rawPreview =
        typeof val === "string" ? val : JSON.stringify(val ?? data.evaluation?.description ?? null);
    }
  } else if (canonicalCommand === "page-text" && typeof data.text === "string") {
    rawPreview = data.text;
  } else if (canonicalCommand === "page-screenshot" && data.saved) {
    rawPreview = `saved=${data.saved} (${data.bytes}B)`;
  } else if (canonicalCommand === "page-record" && data.saved) {
    rawPreview = `saved=${data.saved} (${data.bytes}B, ${data.durationMs}ms, ${data.codec})`;
  } else if (canonicalCommand === "elements" && Array.isArray(data.elements)) {
    const sample = data.elements
      .slice(0, 4)
      .map((e) => e.selector || e.text || e.tag)
      .join(", ");
    rawPreview = `matched=${data.totalMatched} [${sample}]`;
  } else if (canonicalCommand === "pages" && Array.isArray(data.pages)) {
    const sample = data.pages
      .slice(0, 3)
      .map((p) => `${String(p.targetId).slice(0, 8)}:${p.title || p.url}`)
      .join(" | ");
    rawPreview = `count=${data.count} [${sample}]`;
  } else {
    // Strip verbose `page` envelope before summarizing
    const { page: _ignored, ...rest } = data;
    rawPreview = JSON.stringify(Object.keys(rest).length > 0 ? rest : data);
  }

  return {
    target,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    resultPreview: truncateSummary(rawPreview, MAX_PREVIEW_CHARS),
  };
}

function rotateLogIfNeeded(logPath) {
  try {
    const st = fs.statSync(logPath);
    if (st.size < MAX_LOG_BYTES) {
      return;
    }
  } catch {
    return;
  }

  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i -= 1) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    try {
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    } catch {
      // Best effort rotation
    }
  }
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Best effort rotation
  }
}

export function appendDiagEntry(entry, logPathOverride) {
  try {
    const logPath = resolveDiagLogPath(logPathOverride);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateLogIfNeeded(logPath);
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Never fail or pollute stdout due to diag logging errors
  }
}

export function recordCliInvocation({
  startTimeMs,
  rawArgs = [],
  rawCommand,
  data,
  outputBytes = 0,
  exitCode = 0,
  error = null,
  telemetry = {},
  logPathOverride,
  disabled = false,
}) {
  if (!isDiagEnabled(disabled)) return;
  const canonical = normalizeCommandName(rawCommand);
  // Skip logging `cdp diag` self-inspection calls so analytics stay pure
  if (canonical === "diag") return;

  const durationMs = Math.max(0, Date.now() - startTimeMs);
  const sanitizedArgs = rawArgs.slice(0, 12).map((a) => truncateSummary(a, MAX_ARG_CHARS));
  const argsTotalChars = rawArgs.reduce((acc, a) => acc + String(a || "").length, 0);

  const { target, meta, resultPreview } = buildResultPreviewAndMeta(
    canonical,
    data,
    telemetry,
  );
  if (telemetry.targetQuery && target) {
    target.query = truncateSummary(telemetry.targetQuery, 60);
  } else if (telemetry.targetQuery) {
    // Failed before target resolved
  }

  const ok = !error && exitCode === 0 && !meta?.hasException;
  const record = {
    ts: new Date().toISOString(),
    durationMs,
    caller: detectCallerContext(),
    rawCommand: rawCommand || "(none)",
    command: canonical,
    args: sanitizedArgs,
    ...(argsTotalChars > MAX_ARG_CHARS ? { argsTotalChars } : {}),
    ...(target
      ? { target }
      : telemetry.targetQuery
        ? { target: { query: truncateSummary(telemetry.targetQuery, 60) } }
        : {}),
    ok,
    exitCode,
    ...(meta ? { meta } : {}),
    ...(outputBytes > 0 ? { outputBytes } : {}),
    ...(resultPreview ? { resultPreview } : {}),
    ...(error
      ? {
          error: {
            message: truncateSummary(error.message || String(error), MAX_ERROR_CHARS),
            ...(error.code ? { code: error.code } : {}),
          },
        }
      : {}),
  };

  appendDiagEntry(record, logPathOverride);
}

function readDiagRecords(logPath, { includeRotated = false, sinceMs = 0, agentFilter = null } = {}) {
  const files = [];
  if (includeRotated) {
    for (let i = MAX_ROTATED_FILES; i >= 1; i -= 1) {
      const p = `${logPath}.${i}`;
      if (fs.existsSync(p)) files.push(p);
    }
  }
  if (fs.existsSync(logPath)) {
    files.push(logPath);
  }

  const records = [];
  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (sinceMs > 0 && rec.ts) {
          const t = Date.parse(rec.ts);
          if (Number.isFinite(t) && t < sinceMs) continue;
        }
        if (agentFilter && rec.caller?.agent !== agentFilter) {
          continue;
        }
        records.push(rec);
      } catch {
        continue;
      }
    }
  }
  return records;
}

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return 0;
  const idx = Math.min(
    sortedNums.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedNums.length) - 1),
  );
  return sortedNums[idx];
}

function normalizeErrorBucket(msg = "") {
  return String(msg)
    .replace(/"[0-9a-fA-F]{8,32}"/g, '"<targetId>"')
    .replace(/\b[0-9a-fA-F]{32}\b/g, "<id32>")
    .replace(/Available pages:[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function runDiagCommand(positional = [], flags = {}) {
  const sub = String(positional[0] || "summary").toLowerCase();
  const logPath = resolveDiagLogPath(
    typeof flags["diag-log"] === "string" ? flags["diag-log"] : undefined,
  );

  if (sub === "path") {
    let bytes = 0;
    const exists = fs.existsSync(logPath);
    if (exists) {
      try {
        bytes = fs.statSync(logPath).size;
      } catch {}
    }
    return { logPath, exists, bytes };
  }

  if (sub === "clear") {
    const removedFiles = [];
    for (const candidate of [
      logPath,
      `${logPath}.1`,
      `${logPath}.2`,
      `${logPath}.3`,
    ]) {
      try {
        if (fs.existsSync(candidate)) {
          fs.unlinkSync(candidate);
          removedFiles.push(candidate);
        }
      } catch {}
    }
    return { cleared: true, logPath, removedFiles };
  }

  let sinceMs = 0;
  if (flags.days !== undefined && flags.days !== true) {
    const days = Number(flags.days);
    if (Number.isFinite(days) && days > 0) {
      sinceMs = Date.now() - days * 86_400_000;
    }
  } else if (typeof flags.since === "string" && flags.since) {
    const parsed = Date.parse(flags.since);
    if (Number.isFinite(parsed)) sinceMs = parsed;
  }

  const includeRotated = Boolean(flags["all-files"] || flags.days || flags.since);
  const agentFilter = typeof flags.agent === "string" ? flags.agent : null;
  const records = readDiagRecords(logPath, { includeRotated, sinceMs, agentFilter });
  const limit = flags.limit ? Number(flags.limit) : 20;

  if (sub === "tail" || sub === "recent") {
    const cmdFilter = typeof flags.cmd === "string" ? flags.cmd.toLowerCase() : null;
    const filtered = cmdFilter
      ? records.filter(
          (r) =>
            r.command === cmdFilter ||
            String(r.rawCommand || "").toLowerCase() === cmdFilter,
        )
      : records;
    const items = filtered.slice(-limit);
    return {
      logPath,
      totalMatched: filtered.length,
      returnedCount: items.length,
      records: items,
    };
  }

  if (sub === "errors" || sub === "failures") {
    const failed = records.filter((r) => !r.ok);
    const items = failed.slice(-limit);
    return {
      logPath,
      totalErrors: failed.length,
      returnedCount: items.length,
      errors: items,
    };
  }

  if (sub !== "summary" && sub !== "stats") {
    throw new Error(
      `Unknown diag subcommand: "${sub}". Supported: summary | errors | tail | path | clear`,
    );
  }

  let fileBytes = 0;
  try {
    if (fs.existsSync(logPath)) fileBytes = fs.statSync(logPath).size;
  } catch {}

  const totalCalls = records.length;
  if (totalCalls === 0) {
    return {
      logPath,
      fileBytes,
      overview: {
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        successRate: "100.0%",
        evalCalls: 0,
        evalRatio: "0.0%",
      },
      byAgent: {},
      byCommand: [],
      aliasUsage: {},
      unknownCommands: {},
      optimizationSignals: {},
      latencyMs: { avg: 0, p50: 0, p95: 0, max: 0, slowestTop5: [] },
      topErrors: [],
    };
  }

  let successCalls = 0;
  let evalCalls = 0;
  const byAgent = {};
  const cmdStats = new Map();
  const aliasUsage = {};
  const unknownCommands = {};
  const errorBuckets = new Map();
  const durations = [];

  const signals = {
    autoStartTriggers: 0,
    sessionReattaches: 0,
    ambiguousTargetHits: 0,
    serializedFallbacks: 0,
    evalExceptions: 0,
    clickBySelector: 0,
    clickByText: 0,
  };

  for (const r of records) {
    if (r.ok) successCalls += 1;
    const cmd = r.command || "unknown";
    if (cmd === "page-eval") evalCalls += 1;

    const ag = r.caller?.agent || "unknown";
    byAgent[ag] = (byAgent[ag] || 0) + 1;

    const dur = Number(r.durationMs || 0);
    durations.push(dur);

    let st = cmdStats.get(cmd);
    if (!st) {
      st = { command: cmd, count: 0, failed: 0, durations: [] };
      cmdStats.set(cmd, st);
    }
    st.count += 1;
    if (!r.ok) st.failed += 1;
    st.durations.push(dur);

    if (r.rawCommand && r.rawCommand !== cmd && cmd !== "unknown") {
      const k = `${r.rawCommand} -> ${cmd}`;
      aliasUsage[k] = (aliasUsage[k] || 0) + 1;
    }
    if (cmd === "unknown" && r.rawCommand) {
      unknownCommands[r.rawCommand] = (unknownCommands[r.rawCommand] || 0) + 1;
    }

    const m = r.meta || {};
    if (m.autoStarted) signals.autoStartTriggers += 1;
    if (m.reattached) signals.sessionReattaches += 1;
    if (m.ambiguousTarget) signals.ambiguousTargetHits += 1;
    if (m.serializedFallback) signals.serializedFallbacks += 1;
    if (m.hasException) signals.evalExceptions += 1;
    if (cmd === "page-click") {
      if (m.matchedBy === "text") signals.clickByText += 1;
      else if (m.matchedBy === "selector") signals.clickBySelector += 1;
    }

    if (!r.ok) {
      const rawErr =
        r.error?.message || m.exceptionPreview || `exitCode=${r.exitCode}`;
      const bucket = normalizeErrorBucket(rawErr);
      const existing = errorBuckets.get(bucket);
      if (!existing) {
        errorBuckets.set(bucket, {
          error: bucket,
          count: 1,
          lastTs: r.ts,
          sampleCmd: `${r.rawCommand} ${(r.args || []).slice(0, 3).join(" ")}`.trim(),
        });
      } else {
        existing.count += 1;
        existing.lastTs = r.ts;
      }
    }
  }

  const sortedDurations = [...durations].sort((a, b) => a - b);
  const avgLatency = Math.round(
    durations.reduce((a, b) => a + b, 0) / durations.length,
  );

  const byCommand = Array.from(cmdStats.values())
    .sort((a, b) => b.count - a.count)
    .map((s) => {
      const sd = [...s.durations].sort((a, b) => a - b);
      const avg = Math.round(sd.reduce((a, b) => a + b, 0) / sd.length);
      return {
        command: s.command,
        count: s.count,
        share: `${((s.count / totalCalls) * 100).toFixed(1)}%`,
        failed: s.failed,
        avgMs: avg,
        p95Ms: percentile(sd, 95),
      };
    });

  const slowestTop5 = [...records]
    .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
    .slice(0, 5)
    .map((r) => ({
      ts: r.ts,
      durationMs: r.durationMs,
      command: r.rawCommand,
      args: (r.args || []).slice(0, 3),
      ok: r.ok,
    }));

  const topErrors = Array.from(errorBuckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    logPath,
    fileBytes,
    timeRange: {
      firstTs: records[0]?.ts || null,
      lastTs: records[records.length - 1]?.ts || null,
    },
    overview: {
      totalCalls,
      successCalls,
      failedCalls: totalCalls - successCalls,
      successRate: `${((successCalls / totalCalls) * 100).toFixed(1)}%`,
      evalCalls,
      evalRatio: `${((evalCalls / totalCalls) * 100).toFixed(1)}%`,
    },
    byAgent,
    byCommand,
    aliasUsage,
    unknownCommands,
    optimizationSignals: signals,
    latencyMs: {
      avg: avgLatency,
      p50: percentile(sortedDurations, 50),
      p95: percentile(sortedDurations, 95),
      max: sortedDurations[sortedDurations.length - 1] || 0,
      slowestTop5,
    },
    topErrors,
  };
}
