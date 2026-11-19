# CDP Bridge 浏览器调试与验收约束

当需要检查、操作或端到端验收本机已打开的 Chrome / Edge 等 Chromium 浏览器页面时，必须遵守以下约定：

1. **禁止绕过桥接直连调试端口**：严禁通过 `curl`/`wget` 请求 `127.0.0.1:9222/json`，或通过 `playwright.connect_over_cdp`、`puppeteer.connect`、Python `websockets` 直连浏览器调试端口（直连会触发重复远程调试授权弹窗或受 `HTTP_PROXY` 干扰报错）。统一使用全局 `cdp` 命令。
2. **按需激活 `cdp-bridge` Skill**：执行浏览器页面探测、交互模拟或控制台/网络排障前，优先阅读并遵循 `cdp-bridge` 技能中的标准工作流。
3. **高层原语优先于手写脚本**：优先使用 `cdp elements` 快照可交互元素，使用 `cdp click` / `cdp fill` / `cdp hover` / `cdp scroll` / `cdp wait` / `cdp batch` 完成页面交互，仅在高层原语无法满足时再使用 `cdp eval` 或 `cdp call`。
