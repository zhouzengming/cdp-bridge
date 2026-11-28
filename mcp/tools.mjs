import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mcpDir = path.dirname(fileURLToPath(import.meta.url));
export const CDP_CLI_SCRIPT = path.resolve(mcpDir, "..", "src", "cdp.mjs");

const CURSOR_ENUM = ["fast", "demo", "persist", "off"];

export const MCP_TOOLS = [
  {
    name: "cdp_status",
    description:
      "Inspect or initialize the persistent local cdp-bridge daemon connection to Chrome/Edge.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        ensure: {
          type: "boolean",
          description:
            "Auto-start the background cdp-bridge daemon if it is not currently running.",
        },
        connect: {
          type: "string",
          description:
            "Optional host:port (e.g. '127.0.0.1:9222') or full ws:// browser debugger URL to switch/connect to.",
        },
        timeoutMs: {
          type: "integer",
          description: "Timeout in milliseconds (default: 15000).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_pages",
    description:
      "List open browser tabs (targetId, title, url, attached). Auto-starts the bridge daemon if needed.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description:
            "Include non-page targets such as iframes, service workers, and extensions.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_manage_tab",
    description:
      "Open a new tab, navigate/reload an existing tab, activate/focus a background tab, or close a tab.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["open", "navigate", "reload", "focus", "close"],
          description: "Tab lifecycle action to perform.",
        },
        target: {
          type: "string",
          description:
            "Target ID/8-char prefix, URL substring/regex, or title (required for navigate/reload/focus/close).",
        },
        url: {
          type: "string",
          description: "URL to open or navigate to (required for open/navigate).",
        },
        background: {
          type: "boolean",
          description: "For 'open': open the new tab in the background without stealing focus.",
        },
        ignoreCache: {
          type: "boolean",
          description: "For 'reload': bypass browser cache.",
        },
        timeoutMs: {
          type: "integer",
          description: "Timeout in milliseconds.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_elements",
    description:
      "Snapshot visible interactive elements (buttons, links, inputs, menu items) and their recommended unique CSS/text selectors.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "string",
          description: "8-char targetId prefix (recommended), URL, or title.",
        },
        rootSelector: {
          type: "string",
          description: "Optional container CSS selector (e.g. \"[role='dialog']\").",
        },
        limit: {
          type: "integer",
          description: "Maximum elements to return (default: 80).",
        },
        includeHidden: {
          type: "boolean",
          description: "Include hidden/zero-size interactive elements.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_text",
    description:
      "Read visible innerText from the whole page or a specific CSS selector.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        selector: { type: "string", description: "Optional container CSS selector." },
        maxLength: {
          type: "integer",
          description: "Maximum text length to return (default: 50000).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_click",
    description:
      "Click an element by CSS selector or visible text (Radix UI / AntD PointerEvent compatible, renders Top-Layer ghost cursor ripple).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["target", "selectorOrText"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        selectorOrText: {
          type: "string",
          description:
            "CSS selector or 'text=Button Label' (falls back to visible text matching).",
        },
        byText: { type: "boolean", description: "Force visible text/aria-label matching." },
        exact: { type: "boolean", description: "Require exact text match." },
        index: { type: "integer", description: "0-based match index (default: 0)." },
        waitFor: {
          type: "string",
          description: "Optional CSS selector to wait for right after clicking.",
        },
        waitMs: { type: "integer", description: "Extra post-click wait in ms." },
        native: {
          type: "boolean",
          description: "Dispatch CDP Input.dispatchMouseEvent at element coordinates.",
        },
        cursor: { type: "string", enum: CURSOR_ENUM },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_fill",
    description:
      "Fill a React/Vue controlled input, <textarea>, <select>, or TipTap/ProseMirror contenteditable rich-text editor with pure UTF-8 text (preserves multi-line newlines without shell escaping).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["target", "selector"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        selector: { type: "string", description: "CSS selector of input or .ProseMirror." },
        text: {
          type: "string",
          description: "Text content to write (passed directly over UTF-8 pipe).",
        },
        clear: { type: "boolean", description: "Clear existing field value." },
        append: { type: "boolean", description: "Append to existing value instead of replacing." },
        submit: { type: "boolean", description: "Submit or click submit button after filling." },
        submitSelector: {
          type: "string",
          description: "Optional submit button CSS selector when submit=true.",
        },
        cursor: { type: "string", enum: CURSOR_ENUM },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_hover",
    description:
      "Move and hover the Top-Layer ghost cursor over an element or 'x,y' viewport coordinates (fades out smoothly when user clicks the page).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["target", "targetSpec"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        targetSpec: {
          type: "string",
          description: "CSS selector, 'text=...', or 'x,y' coordinates (e.g. '320,180').",
        },
        byText: { type: "boolean" },
        exact: { type: "boolean" },
        index: { type: "integer" },
        autoHide: {
          type: "boolean",
          description: "Auto-fade cursor after 2.6s instead of persistent hover.",
        },
        native: { type: "boolean" },
        cursor: { type: "string", enum: CURSOR_ENUM },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_drag",
    description:
      "Simulate smooth mouse press-move-release drag between elements, visible text, or x,y coordinates (or by dx/dy offset). Supports both Pointer/Mouse drag (sliders, splitters, @dnd-kit, canvas) and HTML5 DragEvent (draggable='true' kanban/sortable), with visual trajectory trail and soft water ripples.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["target", "from"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        from: {
          type: "string",
          description: "Start CSS selector, 'text=...', or 'x,y' viewport coordinates.",
        },
        to: {
          type: "string",
          description: "Destination CSS selector, 'text=...', or 'x,y' coordinates (optional if dx/dy set).",
        },
        dx: { type: "number", description: "Horizontal pixel offset relative to start/destination." },
        dy: { type: "number", description: "Vertical pixel offset relative to start/destination." },
        steps: { type: "integer", description: "Number of interpolated drag steps." },
        durationMs: { type: "integer", description: "Drag movement duration in ms." },
        html5: { type: "boolean", description: "Force HTML5 DragEvent (dragstart/dragover/drop) sequence." },
        pointerOnly: { type: "boolean", description: "Force Pointer/Mouse events only (skip HTML5 DragEvent)." },
        cursor: { type: "string", enum: CURSOR_ENUM },
        timeoutMs: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_scroll",
    description:
      "Simulate mouse wheel scroll on the page or a scrollable container with directional badge overlay.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        selectorOrCoords: {
          type: "string",
          description: "Optional scrollable container selector, target element, or 'x,y'.",
        },
        direction: {
          type: "string",
          enum: ["down", "up", "left", "right", "top", "bottom", "into-view"],
          description: "Scroll direction or mode (default: 'down').",
        },
        amount: {
          type: "integer",
          description: "Scroll distance in pixels (e.g. 480).",
        },
        dx: { type: "integer", description: "Explicit horizontal deltaX in pixels." },
        dy: { type: "integer", description: "Explicit vertical deltaY in pixels." },
        steps: { type: "integer", description: "Number of smooth wheel ticks." },
        waitMs: { type: "integer", description: "Wait after scrolling in ms." },
        cursor: { type: "string", enum: CURSOR_ENUM },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_wait",
    description:
      "Wait for a CSS selector, expected visible text substring, or truthy JS expression on the page.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        selectorOrExpr: {
          type: "string",
          description: "CSS selector or JS expression to poll.",
        },
        text: {
          type: "string",
          description: "Expected visible text substring.",
        },
        timeoutMs: {
          type: "integer",
          description: "Max wait duration in ms (default: 10000).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_screenshot",
    description:
      "Capture viewport, element, or full-page screenshot (PNG/JPEG/WebP). Optionally retains ghost cursor state or returns inline image content.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        outputPath: {
          type: "string",
          description: "File path to save screenshot. Defaults to a temp file if omitted.",
        },
        selector: { type: "string", description: "Optional CSS selector to crop." },
        fullPage: { type: "boolean", description: "Capture full scrollable page." },
        format: { type: "string", enum: ["png", "jpeg", "webp"] },
        quality: { type: "integer", description: "1-100 quality for jpeg/webp." },
        withCursor: {
          type: "boolean",
          description:
            "Retain/restore simulated ghost cursor, action badge, and highlight ring in screenshot.",
        },
        returnImage: {
          type: "boolean",
          description: "Also return native MCP base64 image block in the tool response.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_record",
    description:
      "Record browser page interactions (including Top-Layer ghost cursor, click ripples, and scroll badges) to a playable .webm video file (zero-dependency; .mp4/.gif supported when ffmpeg is installed).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["start", "pause", "resume", "stop", "concat", "status", "cancel", "clip"],
          description:
            "'start' begins recording with REC HUD; 'pause'/'resume' skips long waits without disk bloat and shows a skip toast; 'stop' finalizes video; 'concat' merges multiple .webm segments losslessly; 'clip' records for durationMs; 'status' inspects; 'cancel' discards.",
        },
        target: {
          type: "string",
          description:
            "Target ID/8-char prefix, URL, or title (required for start/clip; optional for pause/resume/stop/cancel if only 1 recording is active).",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "For action='concat': ordered list of >=2 segment video paths to merge.",
        },
        outputPath: {
          type: "string",
          description: "Output video file path (e.g. './acceptance.webm').",
        },
        durationMs: {
          type: "integer",
          description: "For action='clip': duration in ms to record before stopping.",
        },
        label: {
          type: "string",
          description: "Optional custom HUD label (on start) or toast text (on resume/concat).",
        },
        cleanupInputs: {
          type: "boolean",
          description: "For action='concat': delete input segment files after successful merge.",
        },
        hud: {
          type: "boolean",
          description:
            "Whether to display the top-right recording status indicator and floating prompts (default: true; set false to hide).",
        },
        badge: {
          type: "boolean",
          description:
            "Whether to display floating toast prompts on start/pause/resume/concat (default: true; set false to hide toasts only).",
        },
        noHud: {
          type: "boolean",
          description: "Alias for hud=false: disable top-right REC indicator pill and prompts.",
        },
        noBadge: {
          type: "boolean",
          description: "Alias for badge=false: disable floating skip/splice toast notifications.",
        },
        fps: { type: "integer", description: "Max frame rate (default: 30)." },
        quality: { type: "integer", description: "JPEG capture quality 10-100 (default: 92)." },
        bitrate: { type: "integer", description: "Target video bitrate in bps (default: auto >=12Mbps)." },
        maxWidth: { type: "integer", description: "Max video width in px (default: 2560)." },
        maxHeight: { type: "integer", description: "Max video height in px (default: 1440)." },
        maxDurationMs: {
          type: "integer",
          description: "Auto-stop safety cap in ms (default: 180000).",
        },
        noFocus: {
          type: "boolean",
          description: "Skip bringing the target tab to front when starting.",
        },
        keepFramesDir: {
          type: "string",
          description: "Optional directory to also export raw captured JPEG frames on stop.",
        },
        timeoutMs: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_logs",
    description:
      "Read captured console errors/warnings/uncaught exceptions (or all console logs) from the page.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        all: { type: "boolean", description: "Include console.log/info/debug." },
        level: { type: "string", description: "Comma-separated levels (e.g. 'error,warn')." },
        grep: { type: "string", description: "Regex filter on log message." },
        limit: { type: "integer", description: "Max entries (default: 50)." },
        clear: { type: "boolean", description: "Clear buffered logs after reading." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_network",
    description:
      "Inspect failed HTTP requests (>=400 or network errors with response body preview) or filtered API traffic.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        all: { type: "boolean", description: "Include successful 2xx/3xx requests." },
        url: { type: "string", description: "URL regex filter (e.g. '/api/v1/')." },
        method: { type: "string", description: "HTTP verb filter (e.g. 'POST,PUT')." },
        type: { type: "string", description: "Resource type filter (e.g. 'fetch,xhr')." },
        status: { type: "string", description: "Status filter (e.g. '4xx,5xx,200')." },
        resources: { type: "boolean", description: "Include performance resource timings." },
        limit: { type: "integer", description: "Max entries (default: 50)." },
        clear: { type: "boolean", description: "Clear buffered network entries." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_batch",
    description:
      "Execute multiple page steps sequentially over a single bridge connection (fill -> click -> scroll -> wait -> text/screenshot).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        target: {
          type: "string",
          description: "Default target ID/prefix, URL, or title for all steps.",
        },
        steps: {
          type: "array",
          description:
            "Array of step objects, e.g. [{cmd:'fill',selector:'.ProseMirror',text:'hello'},{cmd:'click',selector:'button[type=submit]'}].",
          items: { type: "object" },
        },
        continueOnError: { type: "boolean" },
        recordPath: {
          type: "string",
          description:
            "Optional output video path (e.g. './acceptance.webm') to record the entire batch interaction, saved even if a step fails.",
        },
        hud: {
          type: "boolean",
          description:
            "When recordPath is set, whether to display the top-right recording status indicator and prompts (default: true; set false to hide).",
        },
        noHud: {
          type: "boolean",
          description: "Alias for hud=false when recording a batch.",
        },
        noBadge: {
          type: "boolean",
          description: "Disable floating start/skip toast prompts when recording a batch.",
        },
        label: {
          type: "string",
          description: "Optional custom label on the top-right REC indicator when recordPath is set.",
        },
        fps: {
          type: "integer",
          description: "Optional frame rate when recordPath is set (default: 30).",
        },
        cursor: { type: "string", enum: CURSOR_ENUM },
        timeoutMs: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_eval",
    description:
      "Evaluate arbitrary JavaScript expression in the target page (passed safely via UTF-8 stdin without shell quoting).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["target", "expression"],
      properties: {
        target: { type: "string", description: "Target ID/prefix, URL, or title." },
        expression: { type: "string", description: "JavaScript expression to evaluate." },
        awaitPromise: {
          type: "boolean",
          description: "Await returned Promise (default: true).",
        },
        raw: {
          type: "boolean",
          description: "Return unwrapped evaluation value.",
        },
        timeoutMs: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cdp_call",
    description:
      "Invoke a low-level raw Chrome DevTools Protocol method (e.g. 'Browser.getVersion', 'DOM.getDocument').",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["method"],
      properties: {
        method: { type: "string", description: "CDP Domain.method name." },
        params: { type: "object", description: "CDP method parameters object." },
        target: { type: "string", description: "Optional page target to attach session." },
        sessionId: { type: "string", description: "Optional explicit CDP sessionId." },
        timeoutMs: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
];

function runCdpCli(cliArgs, { stdinText, timeoutMs = 35_000, callerLabel = "mcp", envOverrides = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      ...envOverrides,
    };
    if (!childEnv.CDP_CALLER) {
      childEnv.CDP_CALLER = callerLabel;
    }

    const child = spawn(process.execPath, [CDP_CLI_SCRIPT, ...cliArgs], {
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: err.message,
      });
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        resolve({
          ok: false,
          exitCode: 124,
          stdout,
          stderr: `cdp CLI timed out after ${timeoutMs}ms${stderr ? `\n${stderr}` : ""}`,
        });
        return;
      }
      resolve({
        ok: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.write(Buffer.from(String(stdinText), "utf8"));
    }
    child.stdin.end();
  });
}

function pushCommonFlags(cliArgs, args = {}) {
  if (args.timeoutMs !== undefined) {
    cliArgs.push("--timeout", String(args.timeoutMs));
  }
  if (args.cursor) {
    cliArgs.push("--cursor", String(args.cursor));
  }
}

export async function dispatchMcpToolCall(name, args = {}, context = {}) {
  const callerLabel = context.callerLabel || "mcp";
  const envOverrides = context.envOverrides || {};

  let cliArgs = [];
  let stdinText;
  let outerTimeoutMs = (Number(args.timeoutMs) || 25_000) + 10_000;
  let tempScreenshotPath = "";

  switch (name) {
    case "cdp_status": {
      if (args.connect) {
        cliArgs = ["connect", String(args.connect)];
      } else {
        cliArgs = ["status"];
        if (args.ensure) cliArgs.push("--ensure");
      }
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_pages": {
      cliArgs = ["pages"];
      if (args.all) cliArgs.push("--all");
      break;
    }

    case "cdp_manage_tab": {
      const action = String(args.action || "");
      if (action === "open") {
        if (!args.url) throw new Error("cdp_manage_tab(open) requires 'url'");
        cliArgs = ["open", String(args.url)];
        if (args.background) cliArgs.push("--background");
      } else if (action === "navigate") {
        if (!args.target || !args.url) {
          throw new Error("cdp_manage_tab(navigate) requires 'target' and 'url'");
        }
        cliArgs = ["navigate", "--target", String(args.target), String(args.url)];
      } else if (action === "reload") {
        if (!args.target) throw new Error("cdp_manage_tab(reload) requires 'target'");
        cliArgs = ["reload", "--target", String(args.target)];
        if (args.ignoreCache) cliArgs.push("--ignore-cache");
      } else if (action === "focus") {
        if (!args.target) throw new Error("cdp_manage_tab(focus) requires 'target'");
        cliArgs = ["focus", "--target", String(args.target)];
      } else if (action === "close") {
        if (!args.target) throw new Error("cdp_manage_tab(close) requires 'target'");
        cliArgs = ["close", "--target", String(args.target)];
      } else {
        throw new Error(`Unsupported tab action: ${action}`);
      }
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_elements": {
      cliArgs = ["elements", "--target", String(args.target)];
      if (args.rootSelector) cliArgs.push(String(args.rootSelector));
      if (args.limit !== undefined) cliArgs.push("--limit", String(args.limit));
      if (args.includeHidden) cliArgs.push("--include-hidden");
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_text": {
      cliArgs = ["text", "--target", String(args.target)];
      if (args.selector) cliArgs.push(String(args.selector));
      if (args.maxLength !== undefined) {
        cliArgs.push("--max-length", String(args.maxLength));
      }
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_click": {
      cliArgs = [
        "click",
        "--target",
        String(args.target),
        String(args.selectorOrText),
      ];
      if (args.byText) cliArgs.push("--text");
      if (args.exact) cliArgs.push("--exact");
      if (args.index !== undefined) cliArgs.push("--index", String(args.index));
      if (args.waitFor) cliArgs.push("--wait-for", String(args.waitFor));
      if (args.waitMs !== undefined) cliArgs.push("--wait", String(args.waitMs));
      if (args.native) cliArgs.push("--native");
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_fill": {
      cliArgs = ["fill", "--target", String(args.target), String(args.selector)];
      if (args.clear) {
        cliArgs.push("--clear");
      } else {
        cliArgs.push("--stdin");
        stdinText = String(args.text ?? "");
      }
      if (args.append) cliArgs.push("--append");
      if (args.submit) cliArgs.push("--submit");
      if (args.submitSelector) {
        cliArgs.push("--submit-selector", String(args.submitSelector));
      }
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_hover": {
      cliArgs = [
        "hover",
        "--target",
        String(args.target),
        String(args.targetSpec),
      ];
      if (args.byText) cliArgs.push("--text");
      if (args.exact) cliArgs.push("--exact");
      if (args.index !== undefined) cliArgs.push("--index", String(args.index));
      if (args.autoHide) cliArgs.push("--auto-hide");
      if (args.native) cliArgs.push("--native");
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_drag": {
      cliArgs = ["drag", "--target", String(args.target), String(args.from)];
      if (args.to) cliArgs.push(String(args.to));
      if (args.dx !== undefined) cliArgs.push("--dx", String(args.dx));
      if (args.dy !== undefined) cliArgs.push("--dy", String(args.dy));
      if (args.steps !== undefined) cliArgs.push("--steps", String(args.steps));
      if (args.durationMs !== undefined) cliArgs.push("--duration", String(args.durationMs));
      if (args.html5) cliArgs.push("--html5");
      if (args.pointerOnly) cliArgs.push("--pointer-only");
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_scroll": {
      cliArgs = ["scroll", "--target", String(args.target)];
      if (args.selectorOrCoords) cliArgs.push(String(args.selectorOrCoords));
      if (args.direction) cliArgs.push(String(args.direction));
      if (args.amount !== undefined) cliArgs.push(String(args.amount));
      if (args.dx !== undefined) cliArgs.push("--dx", String(args.dx));
      if (args.dy !== undefined) cliArgs.push("--dy", String(args.dy));
      if (args.steps !== undefined) cliArgs.push("--steps", String(args.steps));
      if (args.waitMs !== undefined) cliArgs.push("--wait", String(args.waitMs));
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_wait": {
      cliArgs = ["wait", "--target", String(args.target)];
      if (args.selectorOrExpr) cliArgs.push(String(args.selectorOrExpr));
      if (args.text !== undefined) cliArgs.push("--text", String(args.text));
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_screenshot": {
      const ext = args.format === "jpeg" ? "jpg" : args.format === "webp" ? "webp" : "png";
      const outPath =
        args.outputPath ||
        path.join(os.tmpdir(), `cdp-mcp-shot-${Date.now()}.${ext}`);
      if (!args.outputPath) {
        tempScreenshotPath = outPath;
      }
      cliArgs = ["screenshot", "--target", String(args.target), String(outPath)];
      if (args.selector) cliArgs.push("--selector", String(args.selector));
      if (args.fullPage) cliArgs.push("--full-page");
      if (args.format) cliArgs.push("--format", String(args.format));
      if (args.quality !== undefined) cliArgs.push("--quality", String(args.quality));
      if (args.withCursor) cliArgs.push("--with-cursor");
      outerTimeoutMs = Math.max(outerTimeoutMs, 40_000);
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_record": {
      const action = String(args.action || "").toLowerCase();
      cliArgs = ["record", action];
      if (action === "concat" && Array.isArray(args.inputs)) {
        for (const inp of args.inputs) {
          cliArgs.push(String(inp));
        }
      }
      if (args.target) cliArgs.push("--target", String(args.target));
      if (args.outputPath) cliArgs.push("--output", String(args.outputPath));
      if (args.durationMs !== undefined) {
        cliArgs.push("--duration", String(args.durationMs));
      }
      if (args.label) cliArgs.push("--label", String(args.label));
      if (args.cleanupInputs) cliArgs.push("--rm");
      if (args.hud === false || args.noHud) {
        cliArgs.push("--no-hud");
      } else if (args.hud === true) {
        cliArgs.push("--show-hud");
      }
      if (args.badge === false || args.noBadge) {
        cliArgs.push("--no-badge");
      } else if (args.badge === true) {
        cliArgs.push("--show-badge");
      }
      if (args.fps !== undefined) cliArgs.push("--fps", String(args.fps));
      if (args.quality !== undefined) {
        cliArgs.push("--quality", String(args.quality));
      }
      if (args.bitrate !== undefined) {
        cliArgs.push("--bitrate", String(args.bitrate));
      }
      if (args.maxWidth !== undefined) {
        cliArgs.push("--max-width", String(args.maxWidth));
      }
      if (args.maxHeight !== undefined) {
        cliArgs.push("--max-height", String(args.maxHeight));
      }
      if (args.maxDurationMs !== undefined) {
        cliArgs.push("--max-duration", String(args.maxDurationMs));
      }
      if (args.noFocus) cliArgs.push("--no-focus");
      if (args.keepFramesDir) {
        cliArgs.push("--keep-frames", String(args.keepFramesDir));
      }
      if (action === "stop" || action === "clip" || action === "concat") {
        const clipExtra = action === "clip" ? Number(args.durationMs || 5_000) : 0;
        outerTimeoutMs = Math.max(outerTimeoutMs, clipExtra + 90_000);
      }
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_logs": {
      cliArgs = ["logs", "--target", String(args.target)];
      if (args.all) cliArgs.push("--all");
      if (args.level) cliArgs.push("--level", String(args.level));
      if (args.grep) cliArgs.push("--grep", String(args.grep));
      if (args.limit !== undefined) cliArgs.push("--limit", String(args.limit));
      if (args.clear) cliArgs.push("--clear");
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_network": {
      cliArgs = ["network", "--target", String(args.target)];
      if (args.all) cliArgs.push("--all");
      if (args.url) cliArgs.push("--url", String(args.url));
      if (args.method) cliArgs.push("--method", String(args.method));
      if (args.type) cliArgs.push("--type", String(args.type));
      if (args.status) cliArgs.push("--status", String(args.status));
      if (args.resources) cliArgs.push("--resources");
      if (args.limit !== undefined) cliArgs.push("--limit", String(args.limit));
      if (args.clear) cliArgs.push("--clear");
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_batch": {
      cliArgs = ["batch", "--stdin"];
      if (args.target) cliArgs.push("--target", String(args.target));
      if (args.continueOnError) cliArgs.push("--continue-on-error");
      if (args.recordPath) cliArgs.push("--record", String(args.recordPath));
      if (args.hud === false || args.noHud) {
        cliArgs.push("--no-hud");
      } else if (args.hud === true) {
        cliArgs.push("--show-hud");
      }
      if (args.noBadge) cliArgs.push("--no-badge");
      if (args.label) cliArgs.push("--label", String(args.label));
      if (args.fps !== undefined) cliArgs.push("--fps", String(args.fps));
      stdinText = JSON.stringify(args.steps || []);
      outerTimeoutMs = Math.max(
        outerTimeoutMs,
        args.recordPath ? 95_000 : 60_000,
      );
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_eval": {
      cliArgs = ["eval", "--target", String(args.target), "--stdin"];
      if (args.awaitPromise === false) cliArgs.push("--no-await");
      if (args.raw) cliArgs.push("--raw");
      stdinText = String(args.expression ?? "");
      pushCommonFlags(cliArgs, args);
      break;
    }

    case "cdp_call": {
      cliArgs = ["call", String(args.method)];
      if (args.params !== undefined) {
        cliArgs.push("--params", JSON.stringify(args.params));
      }
      if (args.target) cliArgs.push("--target", String(args.target));
      if (args.sessionId) cliArgs.push("--session-id", String(args.sessionId));
      pushCommonFlags(cliArgs, args);
      break;
    }

    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }

  const res = await runCdpCli(cliArgs, {
    stdinText,
    timeoutMs: outerTimeoutMs,
    callerLabel,
    envOverrides,
  });

  if (!res.ok) {
    const errText =
      [res.stderr, res.stdout].filter(Boolean).join("\n") ||
      `cdp exited with code ${res.exitCode}`;
    if (
      res.exitCode === 2 ||
      errText.includes("PENDING_BROWSER_APPROVAL") ||
      errText.includes("pendingApprovalHint")
    ) {
      const approvalNotice = [
        "[PENDING_BROWSER_APPROVAL] cdp-bridge 守护进程已在后台运行并维持当前握手，正在等待用户在浏览器弹窗中点击「允许 / Allow」。",
        "重要约束：",
        "1. 严禁终止（kill / Stop-Process / taskkill）桥接守护进程 PID，也严禁重复调用 cdp_status(connect) 或 cdp restart，否则会中断当前握手并弹出新的重复授权弹窗。",
        "2. 请直接提示用户在浏览器远程调试确认框中点击「允许 / Allow」，待用户确认后调用只读的 cdp_status({ ensure: false }) 或重试原操作即可。",
        "",
        errText,
      ].join("\n");
      return {
        isError: true,
        content: [{ type: "text", text: approvalNotice }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: errText }],
    };
  }

  const content = [{ type: "text", text: res.stdout || "{}" }];

  if (name === "cdp_screenshot" && args.returnImage) {
    const savedPath = args.outputPath || tempScreenshotPath;
    if (savedPath && fs.existsSync(savedPath)) {
      const mimeType =
        args.format === "jpeg"
          ? "image/jpeg"
          : args.format === "webp"
            ? "image/webp"
            : "image/png";
      content.push({
        type: "image",
        data: fs.readFileSync(savedPath).toString("base64"),
        mimeType,
      });
    }
  }

  return { content };
}
