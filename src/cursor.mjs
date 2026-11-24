// Client-side non-blocking Ghost Cursor & Action Overlay snippet generator.
// Mounted on `document.documentElement` (outside `document.body`) using a
// closed Shadow Root + Chromium Top-Layer `popover="manual"`, completely
// immune to page z-index stacking contexts, CSP style-src restrictions,
// `document.body.innerText`, and `querySelectorAll` DOM queries.
//
// Supports:
// - Zero-latency non-blocking `fast` mode (default), `demo` slow-mo, `persist` (no idle timeout), and `off`.
// - Seamless human takeover: passive capture listeners detect real user mouse clicks
//   (`pointerdown` / `mousedown` with `event.isTrusted === true` outside active CDP
//   simulation guard) and smoothly fade out the simulated cursor out of the way,
//   ignoring mouse movement/hover sweeps to avoid accidental takeover.
// - Optional cursor state retention in screenshots (`--with-cursor` / `--keep-cursor`),
//   even across separate CLI turns after idle fade-out.

export function resolveCursorMode(flags = {}) {
  if (flags["no-cursor"]) {
    return "off";
  }
  const raw = String(
    flags.cursor !== undefined && flags.cursor !== true
      ? flags.cursor
      : process.env.CDP_CURSOR ?? "fast",
  )
    .trim()
    .toLowerCase();

  if (raw === "0" || raw === "false" || raw === "off" || raw === "none") {
    return "off";
  }
  if (raw === "demo" || raw === "slow") {
    return "demo";
  }
  if (raw === "persist" || raw === "pin" || raw === "keep") {
    return "persist";
  }
  return "fast";
}

export const CURSOR_HELPER_SOURCE = `(() => {
  const SYM = Symbol.for("cdp.bridge.cursor");
  if (window[SYM] && window[SYM].version === 7) return window[SYM];
  if (window[SYM] && typeof window[SYM].destroy === "function") {
    try { window[SYM].destroy(); } catch {}
  }

  const IDLE_HIDE_MS = 2600;
  const TAKEOVER_FADE_MS = 220;
  let host = null;
  let root = null;
  let cursorEl = null;
  let badgeEl = null;
  let layerEl = null;
  let pinnedHighlightEl = null;

  let flightX = null;
  let flightY = null;
  let lastActionState = null; // { x, y, label, color, rect }
  let idleTimer = null;
  let hideLayerTimer = null;
  let renderGen = 0;
  let suspended = false;
  let visible = false;
  let takenOverByUser = false;
  let simGuardUntil = 0;
  let listenersBound = false;

  const listenerOpts = { capture: true, passive: true };

  function extendSimGuard(ms = 120) {
    const until = performance.now() + ms;
    if (until > simGuardUntil) simGuardUntil = until;
  }

  function onUserClickTakeover(ev) {
    if (!ev.isTrusted || !visible || suspended) return;
    if (performance.now() < simGuardUntil) return;
    dismissForUserTakeover();
  }

  function bindUserTakeoverListeners() {
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener("pointerdown", onUserClickTakeover, listenerOpts);
    window.addEventListener("mousedown", onUserClickTakeover, listenerOpts);
  }

  function unbindUserTakeoverListeners() {
    if (!listenersBound) return;
    listenersBound = false;
    window.removeEventListener("pointerdown", onUserClickTakeover, listenerOpts);
    window.removeEventListener("mousedown", onUserClickTakeover, listenerOpts);
  }

  function dismissForUserTakeover() {
    if (!visible) {
      takenOverByUser = true;
      return;
    }
    visible = false;
    takenOverByUser = true;
    flightX = null;
    flightY = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (hideLayerTimer) {
      clearTimeout(hideLayerTimer);
      hideLayerTimer = null;
    }

    const genAtDismiss = ++renderGen;

    if (cursorEl && lastActionState) {
      const { x, y } = lastActionState;
      try {
        cursorEl.getAnimations().forEach((a) => a.cancel());
        cursorEl.animate(
          [
            { transform: "translate3d(" + x + "px," + y + "px,0) scale(1)", opacity: 1 },
            { transform: "translate3d(" + x + "px," + y + "px,0) scale(0.88)", opacity: 0 }
          ],
          { duration: TAKEOVER_FADE_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" }
        );
      } catch {}
      cursorEl.style.opacity = "0";
    }

    if (layerEl) {
      for (const child of Array.from(layerEl.children)) {
        if (child === cursorEl) continue;
        try {
          child.animate(
            [{ opacity: 0.8 }, { opacity: 0 }],
            { duration: 180, easing: "ease-out", fill: "forwards" }
          );
        } catch {
          child.remove();
        }
      }
    }

    hideLayerTimer = setTimeout(() => {
      if (renderGen !== genAtDismiss) return;
      if (pinnedHighlightEl) {
        pinnedHighlightEl.remove();
        pinnedHighlightEl = null;
      }
      if (host && typeof host.hidePopover === "function") {
        try {
          if (!host.matches || host.matches(":popover-open")) {
            host.hidePopover();
          }
        } catch {}
      }
    }, TAKEOVER_FADE_MS + 20);
  }

  function ensureMounted() {
    const docEl = document.documentElement;
    if (!docEl) return false;
    bindUserTakeoverListeners();

    if (host && host.isConnected && root) {
      promoteTopLayer();
      return true;
    }

    host = document.createElement("div");
    host.setAttribute("data-cdp-bridge-overlay", "");
    host.setAttribute("aria-hidden", "true");
    try {
      host.setAttribute("popover", "manual");
    } catch {}
    host.style.cssText = [
      "display:block",
      "position:fixed",
      "inset:0",
      "width:0",
      "height:0",
      "margin:0",
      "padding:0",
      "border:0",
      "overflow:visible",
      "background:transparent",
      "pointer-events:none",
      "user-select:none",
      "z-index:2147483647"
    ].join(" !important;") + " !important;";

    root = host.attachShadow({ mode: "closed" });

    layerEl = document.createElement("div");
    layerEl.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:visible;z-index:2147483647;";

    cursorEl = document.createElement("div");
    cursorEl.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:24px",
      "height:24px",
      "pointer-events:none",
      "transform:translate3d(-100px,-100px,0)",
      "opacity:0",
      "will-change:transform,opacity",
      "filter:drop-shadow(0 2px 5px rgba(15,23,42,0.38))"
    ].join(";");

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.style.cssText = "display:block;overflow:visible;";

    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", "M3.2 2.4L20.4 10.7C21.3 11.1 21.2 12.4 20.2 12.7L13.1 14.6L9.7 21.1C9.2 22.0 7.9 21.8 7.6 20.8L2.1 3.7C1.8 2.8 2.5 2.0 3.2 2.4Z");
    path.setAttribute("fill", "#2563eb");
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);

    badgeEl = document.createElement("div");
    badgeEl.style.cssText = [
      "position:absolute",
      "left:16px",
      "top:16px",
      "padding:1px 6px",
      "border-radius:999px",
      "background:rgba(37,99,235,0.92)",
      "color:#ffffff",
      "font:600 10px/14px system-ui,-apple-system,sans-serif",
      "letter-spacing:0.02em",
      "white-space:nowrap",
      "border:1px solid rgba(255,255,255,0.85)",
      "pointer-events:none"
    ].join(";");
    badgeEl.textContent = "CDP";

    cursorEl.appendChild(svg);
    cursorEl.appendChild(badgeEl);
    layerEl.appendChild(cursorEl);
    root.appendChild(layerEl);
    docEl.appendChild(host);
    promoteTopLayer();
    return true;
  }

  function promoteTopLayer() {
    if (!host || typeof host.showPopover !== "function") return;
    try {
      if (host.matches && host.matches(":popover-open")) {
        host.hidePopover();
      }
      host.showPopover();
    } catch {}
  }

  function scheduleIdleFade(persist = false) {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (persist) return;
    const genAtSchedule = renderGen;
    idleTimer = setTimeout(() => {
      if (renderGen !== genAtSchedule) return;
      visible = false;
      if (!cursorEl) return;
      try {
        cursorEl.getAnimations().forEach((a) => a.cancel());
        cursorEl.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: 280, easing: "ease-out", fill: "forwards" }
        );
      } catch {}
      cursorEl.style.opacity = "0";
    }, IDLE_HIDE_MS);
  }

  function spawnRipple(x, y, color) {
    if (!layerEl) return;
    const primaryStroke = color || "rgba(56,189,248,0.58)";

    // Translucent 2-wave concentric water ripple — airy & readable over text and buttons
    const waves = [
      {
        delay: 0,
        duration: 560,
        endScale: 1.55,
        peakOpacity: 0.45,
        midOpacity: 0.26,
        border: "1.8px solid " + primaryStroke,
        shadow: "0 0 0 1px rgba(255,255,255,0.34)",
        bg: "rgba(56,189,248,0.05)"
      },
      {
        delay: 110,
        duration: 500,
        endScale: 1.18,
        peakOpacity: 0.34,
        midOpacity: 0.18,
        border: "1.4px solid rgba(255,255,255,0.42)",
        shadow: "0 0 0 1px rgba(37,99,235,0.34)",
        bg: "transparent"
      }
    ];

    for (const w of waves) {
      const ring = document.createElement("div");
      ring.style.cssText = [
        "position:fixed",
        "left:" + x + "px",
        "top:" + y + "px",
        "width:38px",
        "height:38px",
        "margin-left:-19px",
        "margin-top:-19px",
        "border-radius:50%",
        "border:" + w.border,
        "box-shadow:" + w.shadow,
        "background:" + w.bg,
        "opacity:0",
        "pointer-events:none",
        "will-change:transform,opacity"
      ].join(";");
      layerEl.insertBefore(ring, cursorEl);
      try {
        const anim = ring.animate(
          [
            { transform: "scale(0.28)", opacity: w.peakOpacity },
            { transform: "scale(" + (w.endScale * 0.64).toFixed(2) + ")", opacity: w.midOpacity, offset: 0.45 },
            { transform: "scale(" + w.endScale + ")", opacity: 0 }
          ],
          {
            delay: w.delay,
            duration: w.duration,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "forwards"
          }
        );
        anim.onfinish = () => ring.remove();
      } catch {
        setTimeout(() => ring.remove(), w.delay + w.duration);
      }
    }
  }

  function resolveScrollArrow(dx, dy) {
    const ax = Math.abs(dx || 0);
    const ay = Math.abs(dy || 0);
    if (ax < 1 && ay < 1) return "↕";
    if (ax > 0 && ay > 0) {
      if (ax >= ay * 2.5) return dx > 0 ? "→" : "←";
      if (ay >= ax * 2.5) return dy > 0 ? "↓" : "↑";
      if (dx > 0 && dy > 0) return "↘";
      if (dx > 0 && dy < 0) return "↗";
      if (dx < 0 && dy > 0) return "↙";
      return "↖";
    }
    if (ay >= ax) return dy > 0 ? "↓" : "↑";
    return dx > 0 ? "→" : "←";
  }

  function formatScrollLabel(dx, dy, customLabel) {
    if (customLabel) return customLabel;
    const arrow = resolveScrollArrow(dx, dy);
    const ax = Math.round(Math.abs(dx || 0));
    const ay = Math.round(Math.abs(dy || 0));
    if (ax > 0 && ay > 0) {
      return "Scroll " + arrow + " " + ax + "," + ay + "px";
    }
    const dist = ay || ax;
    return dist > 0 ? "Scroll " + arrow + " " + dist + "px" : "Scroll " + arrow;
  }

  function createScrollChevronSvg(dx, dy, strokeColor) {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "22");
    svg.setAttribute("viewBox", "0 0 24 24");
    const hasVec = Math.abs(dx || 0) >= 1 || Math.abs(dy || 0) >= 1;
    const angleDeg = hasVec ? Math.round((Math.atan2(dy || 0, dx || 0) * 180) / Math.PI - 90) : 0;
    svg.style.cssText = "display:block;overflow:visible;transform:rotate(" + angleDeg + "deg);";

    for (const d of ["M7.5 7.5L12 12L16.5 7.5", "M7.5 13L12 17.5L16.5 13"]) {
      const outline = document.createElementNS(svgNS, "path");
      outline.setAttribute("d", d);
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", "#ffffff");
      outline.setAttribute("stroke-width", "3.8");
      outline.setAttribute("stroke-linecap", "round");
      outline.setAttribute("stroke-linejoin", "round");
      svg.appendChild(outline);

      const p = document.createElementNS(svgNS, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", strokeColor || "#7c3aed");
      p.setAttribute("stroke-width", "2.2");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svg.appendChild(p);
    }
    return svg;
  }

  function spawnScrollEffect(x, y, dx, dy, color) {
    if (!layerEl) return;
    const ring = document.createElement("div");
    ring.style.cssText = [
      "position:fixed",
      "left:" + x + "px",
      "top:" + y + "px",
      "width:38px",
      "height:38px",
      "margin-left:-19px",
      "margin-top:-19px",
      "border-radius:50%",
      "border:2.2px dashed " + (color || "#8b5cf6"),
      "background:rgba(139,92,246,0.16)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "pointer-events:none",
      "will-change:transform,opacity"
    ].join(";");
    const chevronWrap = document.createElement("div");
    chevronWrap.style.cssText = "display:flex;align-items:center;justify-content:center;will-change:transform;";
    chevronWrap.appendChild(createScrollChevronSvg(dx, dy, "#7c3aed"));
    ring.appendChild(chevronWrap);
    layerEl.insertBefore(ring, cursorEl);

    const mag = Math.hypot(dx || 0, dy || 0);
    const ux = mag >= 1 ? (dx || 0) / mag : 0;
    const uy = mag >= 1 ? (dy || 0) / mag : 1;
    const shiftFromX = Math.round(-ux * 5);
    const shiftFromY = Math.round(-uy * 5);
    const shiftToX = Math.round(ux * 6);
    const shiftToY = Math.round(uy * 6);

    try {
      chevronWrap.animate(
        [
          { transform: "translate3d(" + shiftFromX + "px," + shiftFromY + "px,0)", opacity: 0.7 },
          { transform: "translate3d(" + shiftToX + "px," + shiftToY + "px,0)", opacity: 1, offset: 0.65 },
          { transform: "translate3d(" + shiftToX + "px," + shiftToY + "px,0)", opacity: 0 }
        ],
        { duration: 560, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
      );
      const anim = ring.animate(
        [
          { transform: "scale(0.78)", opacity: 0.96 },
          { transform: "scale(1.08)", opacity: 0.9, offset: 0.6 },
          { transform: "scale(1.22)", opacity: 0 }
        ],
        { duration: 580, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
      );
      anim.onfinish = () => ring.remove();
    } catch {
      setTimeout(() => ring.remove(), 580);
    }
  }

  function createStaticBox(rect, color) {
    const pad = 3;
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed",
      "left:" + Math.round(rect.left - pad) + "px",
      "top:" + Math.round(rect.top - pad) + "px",
      "width:" + Math.round(rect.width + pad * 2) + "px",
      "height:" + Math.round(rect.height + pad * 2) + "px",
      "border-radius:6px",
      "border:2px solid " + color,
      "box-shadow:0 0 0 2px rgba(37,99,235,0.15)",
      "pointer-events:none",
      "will-change:opacity"
    ].join(";");
    return box;
  }

  function spawnHighlightBox(rect, color, durationMs) {
    if (!layerEl || !rect || rect.width <= 0 || rect.height <= 0) return;
    const box = createStaticBox(rect, color);
    layerEl.appendChild(box);
    try {
      const anim = box.animate(
        [
          { opacity: 0.92 },
          { opacity: 0.75, offset: 0.6 },
          { opacity: 0 }
        ],
        { duration: durationMs, easing: "ease-out", fill: "forwards" }
      );
      anim.onfinish = () => box.remove();
    } catch {
      setTimeout(() => box.remove(), durationMs);
    }
  }

  function moveCursor(toX, toY, label, color, flightMs, persist = false) {
    if (!ensureMounted() || suspended) return;
    renderGen += 1;
    if (hideLayerTimer) {
      clearTimeout(hideLayerTimer);
      hideLayerTimer = null;
    }
    if (pinnedHighlightEl) {
      pinnedHighlightEl.remove();
      pinnedHighlightEl = null;
    }

    const fromX = flightX !== null ? flightX : Math.max(8, toX - 38);
    const fromY = flightY !== null ? flightY : Math.max(8, toY - 28);
    flightX = toX;
    flightY = toY;
    visible = true;
    takenOverByUser = false;
    layerEl.style.visibility = "visible";

    if (badgeEl) {
      badgeEl.textContent = label || "CDP";
      badgeEl.style.background = color || "rgba(37,99,235,0.92)";
    }

    cursorEl.style.opacity = "1";
    cursorEl.style.transform = "translate3d(" + toX + "px," + toY + "px,0)";
    try {
      cursorEl.getAnimations().forEach((a) => a.cancel());
      cursorEl.animate(
        [
          { transform: "translate3d(" + fromX + "px," + fromY + "px,0) scale(1)", opacity: 0.85 },
          { transform: "translate3d(" + toX + "px," + toY + "px,0) scale(0.88)", opacity: 1, offset: 0.82 },
          { transform: "translate3d(" + toX + "px," + toY + "px,0) scale(1)", opacity: 1 }
        ],
        { duration: flightMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
      );
    } catch {}

    scheduleIdleFade(persist);
  }

  const api = {
    version: 7,
    destroy() {
      unbindUserTakeoverListeners();
      if (idleTimer) clearTimeout(idleTimer);
      if (hideLayerTimer) clearTimeout(hideLayerTimer);
      if (host) {
        try { host.remove(); } catch {}
        host = null;
      }
    },
    repromote() {
      if (host && host.isConnected && !suspended) {
        promoteTopLayer();
      }
    },
    moveForClick(x, y, rect, flightMs = 110, guardMs = 220, persist = false) {
      extendSimGuard(guardMs + flightMs);
      const cleanRect = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      lastActionState = {
        kind: "click",
        x,
        y,
        label: "Click",
        color: "rgba(37,99,235,0.92)",
        boxColor: "rgba(56,189,248,0.55)",
        rect: cleanRect,
        persist
      };
      moveCursor(x, y, "Click", "rgba(37,99,235,0.92)", flightMs, persist);
    },
    triggerClickImpact(x, y, rect) {
      if (!ensureMounted() || suspended) return;
      const cleanRect = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      if (document.querySelector("dialog[open], [popover]:not([data-cdp-bridge-overlay])")) {
        promoteTopLayer();
      }
      spawnRipple(x, y, "rgba(56,189,248,0.58)");
      if (cleanRect) spawnHighlightBox(cleanRect, "rgba(56,189,248,0.48)", 480);
      if (cursorEl) {
        try {
          cursorEl.animate(
            [
              { transform: "translate3d(" + x + "px," + y + "px,0) scale(1)" },
              { transform: "translate3d(" + x + "px," + y + "px,0) scale(0.85)", offset: 0.36 },
              { transform: "translate3d(" + x + "px," + y + "px,0) scale(1)" }
            ],
            { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
          );
        } catch {}
      }
    },
    showClick(x, y, rect, flightMs = 110, guardMs = 220, persist = false) {
      this.moveForClick(x, y, rect, flightMs, guardMs, persist);
      this.triggerClickImpact(x, y, rect);
    },
    moveForFill(el, label = "Fill", flightMs = 140, guardMs = 240, persist = false) {
      if (!el) return null;
      extendSimGuard(guardMs + flightMs);
      const r = el.getBoundingClientRect();
      const cleanRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const x = Math.round(r.left + Math.min(24, Math.max(10, r.width / 2)));
      const y = Math.round(r.top + Math.min(20, Math.max(10, r.height / 2)));
      lastActionState = {
        kind: "fill",
        x,
        y,
        label,
        color: "rgba(16,185,129,0.92)",
        boxColor: "rgba(16,185,129,0.65)",
        rect: cleanRect,
        persist
      };
      moveCursor(x, y, label, "rgba(16,185,129,0.92)", flightMs, persist);
      return { x, y, cleanRect };
    },
    triggerFillImpact(pos) {
      if (!pos || !ensureMounted() || suspended) return;
      spawnRipple(pos.x, pos.y, "rgba(16,185,129,0.52)");
      if (pos.cleanRect) {
        spawnHighlightBox(pos.cleanRect, "rgba(16,185,129,0.58)", 620);
      }
      if (cursorEl) {
        try {
          cursorEl.animate(
            [
              { transform: "translate3d(" + pos.x + "px," + pos.y + "px,0) scale(1)" },
              { transform: "translate3d(" + pos.x + "px," + pos.y + "px,0) scale(0.86)", offset: 0.36 },
              { transform: "translate3d(" + pos.x + "px," + pos.y + "px,0) scale(1)" }
            ],
            { duration: 190, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
          );
        } catch {}
      }
    },
    showFill(el, label = "Fill", flightMs = 140, guardMs = 240, persist = false) {
      const pos = this.moveForFill(el, label, flightMs, guardMs, persist);
      this.triggerFillImpact(pos);
    },
    showHover(x, y, rect = null, flightMs = 160, guardMs = 160, persist = true) {
      extendSimGuard(guardMs);
      const cleanRect = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      lastActionState = {
        kind: "hover",
        x,
        y,
        label: "Hover",
        color: "rgba(245,158,11,0.94)",
        boxColor: "rgba(245,158,11,0.85)",
        rect: cleanRect,
        persist
      };
      moveCursor(x, y, "Hover", "rgba(245,158,11,0.94)", flightMs, persist);
      if (!suspended && cleanRect) {
        spawnHighlightBox(cleanRect, "rgba(245,158,11,0.85)", 600);
      }
    },
    showScroll(x, y, dx = 0, dy = 0, rect = null, customLabel = "", flightMs = 150, guardMs = 260, persist = false) {
      extendSimGuard(guardMs);
      const cleanRect = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      const label = formatScrollLabel(dx, dy, customLabel);
      lastActionState = {
        kind: "scroll",
        x,
        y,
        dx,
        dy,
        label,
        color: "rgba(124,58,237,0.94)",
        boxColor: "rgba(139,92,246,0.82)",
        rect: cleanRect,
        persist
      };
      moveCursor(x, y, label, "rgba(124,58,237,0.94)", flightMs, persist);
      if (!suspended) {
        spawnScrollEffect(x, y, dx, dy, "#8b5cf6");
        if (cleanRect) {
          spawnHighlightBox(cleanRect, "rgba(139,92,246,0.82)", 620);
        }
      }
      return label;
    },
    prepareScreenshot(withCursor) {
      if (!withCursor) {
        this.setSuspended(true);
        return { mode: "hidden" };
      }
      this.setSuspended(false);
      if (!lastActionState) {
        return { mode: "none" };
      }
      if (!ensureMounted()) {
        return { mode: "unavailable" };
      }
      renderGen += 1;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (hideLayerTimer) {
        clearTimeout(hideLayerTimer);
        hideLayerTimer = null;
      }
      const { x, y, label, color, boxColor, rect, kind } = lastActionState;
      layerEl.style.visibility = "visible";
      if (badgeEl) {
        badgeEl.textContent = label || "CDP";
        badgeEl.style.background = color || "rgba(37,99,235,0.92)";
      }
      try {
        cursorEl.getAnimations().forEach((a) => a.cancel());
      } catch {}
      cursorEl.style.opacity = "1";
      cursorEl.style.transform = "translate3d(" + x + "px," + y + "px,0) scale(1)";

      if (pinnedHighlightEl) {
        pinnedHighlightEl.remove();
        pinnedHighlightEl = null;
      }
      if (rect && rect.width > 0 && rect.height > 0) {
        pinnedHighlightEl = createStaticBox(rect, boxColor || "rgba(37,99,235,0.8)");
        pinnedHighlightEl.style.opacity = "0.9";
        layerEl.insertBefore(pinnedHighlightEl, cursorEl);
      }
      if (kind === "click" || kind === "hover" || kind === "scroll") {
        // Static crisp ring around pointer locus so static PNG clearly shows click/hover/scroll point
        const isScroll = kind === "scroll";
        const ringSize = isScroll ? 34 : 28;
        const half = ringSize / 2;
        const ringColor = isScroll ? "#8b5cf6" : kind === "hover" ? "#f59e0b" : "#3b82f6";
        const ringBg = isScroll
          ? "rgba(139,92,246,0.2)"
          : kind === "hover"
            ? "rgba(245,158,11,0.16)"
            : "rgba(59,130,246,0.18)";
        const dot = document.createElement("div");
        dot.setAttribute("data-pinned-ring", "");
        dot.style.cssText = [
          "position:fixed",
          "left:" + x + "px",
          "top:" + y + "px",
          "width:" + ringSize + "px",
          "height:" + ringSize + "px",
          "margin-left:-" + half + "px",
          "margin-top:-" + half + "px",
          "border-radius:50%",
          "border:2.5px " + (isScroll ? "dashed " : "solid ") + ringColor,
          "background:" + ringBg,
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "pointer-events:none"
        ].join(";");
        if (isScroll) {
          dot.appendChild(createScrollChevronSvg(lastActionState.dx || 0, lastActionState.dy || 0, "#6d28d9"));
        }
        if (pinnedHighlightEl) {
          const wrap = document.createElement("div");
          wrap.appendChild(pinnedHighlightEl);
          wrap.appendChild(dot);
          pinnedHighlightEl = wrap;
          layerEl.insertBefore(wrap, cursorEl);
        } else {
          pinnedHighlightEl = dot;
          layerEl.insertBefore(dot, cursorEl);
        }
      }
      visible = true;
      return { mode: "restored", x, y, label, kind };
    },
    finishScreenshot(withCursor) {
      if (!withCursor) {
        this.setSuspended(false);
        return;
      }
      if (pinnedHighlightEl) {
        pinnedHighlightEl.remove();
        pinnedHighlightEl = null;
      }
      if (visible) {
        scheduleIdleFade(Boolean(lastActionState && lastActionState.persist));
      }
    },
    setSuspended(flag) {
      suspended = Boolean(flag);
      if (layerEl) {
        layerEl.style.visibility = suspended ? "hidden" : "visible";
      }
    },
    dismissForUserTakeover,
    isOpenInTopLayer() {
      try {
        return Boolean(host && host.isConnected && (!host.matches || host.matches(":popover-open")));
      } catch {
        return Boolean(host && host.isConnected);
      }
    },
    isVisible() {
      return Boolean(visible && !suspended && host && host.isConnected);
    },
    getState() {
      return {
        visible: this.isVisible(),
        takenOverByUser,
        inTopLayer: this.isOpenInTopLayer(),
        lastActionState
      };
    }
  };

  window[SYM] = api;
  return api;
})()`;
