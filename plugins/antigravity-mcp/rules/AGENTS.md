# CDP Bridge 浏览器调试与验收约束（MCP + CLI）

当需要检查、操作或端到端验收本机已打开的 Chrome / Edge 等 Chromium 浏览器页面时，遵守以下约定：

1. **禁止绕过桥接直连调试端口**：严禁通过 `curl`/`wget` 请求 `127.0.0.1:9222/json`，或通过 `playwright.connect_over_cdp`、`puppeteer.connect`、Python `websockets` 直连浏览器调试端口。
2. **原生 Windows 或多行复杂文本优先走 `cdp-bridge` MCP 工具**：优先使用 `cdp_pages`、`cdp_elements`、`cdp_click`、`cdp_fill`、`cdp_hover`、`cdp_scroll`、`cdp_wait`、`cdp_batch`、`cdp_screenshot`、`cdp_logs`、`cdp_network` 等 MCP 工具，免除命令行引号转义与编码干扰；也可在 Bash 下搭配 `cdp` CLI 使用（参考 `cdp-bridge` 技能）。
