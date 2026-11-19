---
name: cdp-bridge
description: "通过本地常驻 CDP 桥接守护进程（cdp-bridge）与命令行客户端（cdp）控制已打开的 Chrome/Edge 浏览器，执行页面元素快照、带虚拟指针显示的点击/悬停/滚轮滚动、表单与富文本输入、条件等待、截图及控制台与网络请求诊断。当需要进行交互式浏览器调试、前端端到端验收或操作已登录网页会话时使用。"
---

# cdp-bridge 浏览器调试与验收指南

`cdp-bridge` 通过后台守护进程维持与浏览器的**唯一一条 WebSocket 长连接**，所有 CLI 调用经本地 Unix Socket / Windows 命名管道高速复用，无需重复点击浏览器授权弹窗，也不会受本机 `HTTP_PROXY` 干扰。

## 核心使用铁律

1. **严禁绕过桥接直连浏览器端口**：禁止直接用 `curl http://127.0.0.1:9222/json`、Python `websockets` 或 `playwright.connect_over_cdp` 直连调试端口（会导致代理报错或重新触发浏览器授权弹窗）。统一使用 `cdp` 命令。
2. **先探路、优先用高层原语，少手写 `eval`**：
   - 查看页面可点击按钮、菜单项、输入框及推荐选择器：优先运行 `cdp elements <target>`，**不要**手写 `querySelectorAll` 脚本。
   - 点击（含 Radix UI 下拉菜单、AntD Tab/菜单）：优先运行 `cdp click <target> <selector-or-text>`（内置完整 `PointerEvent + MouseEvent` 序列、虚拟鼠标指针水波纹与精确文本优先匹配）。
   - 输入（含 React 受控框与 `.ProseMirror` / TipTap 富文本）：优先运行 `cdp fill <target> <selector> <text>`（对 `contenteditable` 自动走原生 `Input.insertText` 保留多行格式）。
   - 等待异步渲染：优先运行 `cdp wait <target> <selector> [--text "..."]`，避免盲目 `sleep`。
3. **多标签页场景锁定 8 位 `targetId` 前缀**：当 `cdp pages` 显示多个同源标签页（或返回值出现 `"ambiguousMatches"`）时，后续命令直接传 8 位十六进制 `targetId` 前缀（如 `426B5451`）以避免误操作其他标签页。
4. **控制输出体积节省上下文**：
   - 读取纯文本或表达式返回值加 `--raw`（如 `cdp text 426B5451 main --raw`、`cdp eval 426B5451 "location.href" --raw`）。
   - 排查接口时为 `cdp network` 加上过滤条件（如 `cdp network 426B5451 --all --type fetch,xhr --url "/api/"`），避免无过滤倾倒全量静态资源。
5. **多步连续交互优先用 `cdp batch`**：需要连续执行“输入 → 点击 → 等待 → 读文本/截图”时，用 `cdp batch <target> --stdin` 一次完成，减少多次进程启动开销。

## 标准工作流速查

### 1. 检查连接与定位目标标签页

```bash
# 直接列出打开页面（若桥接守护进程尚未启动，任意业务子命令均会自动拉起桥接并等待就绪）
cdp pages

# 仅只读检查桥接守护进程当前运行状态（不产生自启动副作用；加 --ensure 可按需启动）
cdp status

# 打开新标签页 / 激活置顶后台标签页 / 关闭多余标签页
cdp open "http://127.0.0.1:3000/dashboard"
cdp focus 426B5451
cdp close AEB5E87A
```

### 2. 页面快照、点击、输入、悬停与等待

```bash
# 1) 快照当前可见可交互元素（返回按钮/输入框文案及可直接复用的 selector）
cdp elements 426B5451
cdp elements 426B5451 "[role='dialog']"

# 2) 点击元素（支持 CSS 选择器或 text= 可见文本，支持点击后直接等待新元素出现）
cdp click 426B5451 'button[aria-label="更多操作"]' --wait-for "[role='menuitem']"
cdp click 426B5451 "text=新建任务" --exact

# 3) 填写受控输入框或 TipTap/ProseMirror 富文本（支持多行 stdin 与自动提交）
cdp fill 426B5451 ".ProseMirror" --stdin <<'EOF'
第一行内容
第二行内容
EOF
cdp click 426B5451 'button[aria-label="发送"]'

# 4) 条件等待与纯文本读取
cdp wait 426B5451 ".status-badge" --text "已完成" --timeout 20000
cdp text 426B5451 "main" --max-length 3000 --raw

# 5) 视口 / 指定元素 / 整页截图留档（默认隐藏虚拟指针；加 --with-cursor / --keep-cursor 可保留或还原指针位置与高亮框状态）
cdp screenshot 426B5451 ./check.png
cdp screenshot 426B5451 ./modal.png --selector "[role='dialog']" --with-cursor

# 6) 悬停模拟指针供用户确认（鼠标滑过不误触发，仅当用户在页面点击鼠标接管时模拟指针自动平滑淡出）
cdp hover 426B5451 320,180

# 7) 模拟鼠标滚轮滚动并在指针右下角显示滚动方向与像素距离（支持整页、局部滚动容器、top/bottom 与 into-view）
cdp scroll 426B5451 down 480
cdp scroll 426B5451 "[role='dialog']" down 500
cdp scroll 426B5451 ".target-card" into-view
```

### 3. 单连接批量流水线（`batch`）

```bash
cdp batch 426B5451 --stdin <<'EOF'
[
  { "cmd": "fill", "selector": ".ProseMirror", "text": "用一句话总结重点" },
  { "cmd": "click", "selector": "button[aria-label='发送']" },
  { "cmd": "wait", "selector": "[data-testid='assistant-message']", "timeout": 15000 },
  { "cmd": "text", "selector": "main", "maxLength": 2000 }
]
EOF
```

### 4. 控制台日志与网络请求精准诊断

```bash
# 查看近期错误/警告与未捕获异常（加 --all 包含 console.log/info，--grep 按正则过滤）
cdp logs 426B5451
cdp logs 426B5451 --all --grep "auth|session" --limit 30

# 默认仅看失败请求（4xx/5xx/断网及响应体摘要）；加过滤查看指定 API 请求
cdp network 426B5451
cdp network 426B5451 --all --type fetch,xhr --url "/api/v1/" --status 2xx,4xx,5xx
```

### 5. 自定义 JS 执行、原始 CDP 协议与诊断统计

```bash
# 执行表达式并直接输出纯值（--timeout 可放宽慢请求超时）
cdp eval 426B5451 "localStorage.getItem('auth_token')" --raw
cdp eval 426B5451 --file ./complex-check.js --timeout 30000

# 调用底层原始 CDP 方法
cdp call Browser.getVersion
cdp call Storage.getCookies '{"urls":["https://example.com"]}' --target 426B5451

# 查看工具调用统计看板与近期报错（用于复盘优化工具）
cdp diag summary --days 7
cdp diag errors --limit 10
```
