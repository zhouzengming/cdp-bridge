# cdp-bridge

基于 Chrome DevTools Protocol (CDP) 的**本地常驻桥接守护进程 (`cdp-bridge`)**、**命令行操作客户端 (`cdp`)** 与**人机协同虚拟指针工具包**。

专为多终端、多 AI Coding Agent Session 协同控制与调试真实已登录浏览器而设计，零第三方依赖（纯 Node.js ESM），支持 **Linux、WSL2 以及原生 Windows (`win32`)** 跨平台运行：通过后台守护进程维持与浏览器的**唯一一条 WebSocket 长连接**，只需在首次连接时点击一次浏览器的“允许远程调试”授权弹窗，后续所有命令行调用或脚本均通过本地 Unix Socket（Linux / WSL2，`0600` 权限）或 Windows 命名管道（Named Pipe）高速多路复用，彻底避免频繁重连、重复弹窗与本机 HTTP 代理干扰。

---

## 1. 目录结构与运行文件

### 源码、Skill 与全局命令
| 文件 / 路径 | 说明 |
| :--- | :--- |
| `cdp-bridge.mjs` | 常驻桥接守护进程源码（Linux 软链 `~/.local/bin/cdp-bridge`，Windows 通过 `npm link` 生成全局命令） |
| `cdp.mjs` | CLI 客户端源码（Linux 软链 `~/.local/bin/cdp`，Windows 通过 `npm link` 生成全局命令） |
| `cursor.mjs` | 页面顶层 Top-Layer (`popover="manual"`) 虚拟指针、点击水波纹与人机接管叠加模块 |
| `diag.mjs` | 工具调用遥测采集、脱敏轮转与 `cdp diag` 自分析模块（日志默认写入 `logs/diag.jsonl`） |
| `skill/SKILL.md` | 面向 Coding Agent 的精简操作规范与工作流速查 Skill（可按需挂载或软链至工作区） |
| `package.json` | Node ESM 包定义与跨平台 `bin` 脚本入口（零外部第三方依赖） |
| `LICENSE` | MIT 开源许可证 |

### 运行时文件
- **Linux / WSL2**（默认位于 `/run/user/<uid>/cdp-bridge-<uid>/` 或 `$TMPDIR/cdp-bridge-<uid>/`）：
  | 文件名 | 说明 |
  | :--- | :--- |
  | `bridge.sock` | 本地控制 Unix Socket（权限 `0600`，仅当前用户可读写） |
  | `bridge.sock.pid` | 守护进程 PID 文件 |
  | `bridge.sock.log` | 守护进程运行日志与 WebSocket 状态输出 |
  | `client-sessions.json` | 客户端活跃 `targetId -> sessionId` 映射缓存（自动修剪已关闭标签页） |
- **原生 Windows (`win32`)**：
  | 路径 / 管道 | 说明 |
  | :--- | :--- |
  | `\\.\pipe\cdp-bridge-<username>` | 本地控制 Windows 命名管道（Named Pipe） |
  | `%TEMP%\cdp-bridge-<username>\bridge.pid` | 守护进程 PID 文件 |
  | `%TEMP%\cdp-bridge-<username>\bridge.log` | 守护进程运行日志与 WebSocket 状态输出 |
  | `%TEMP%\cdp-bridge-<username>\client-sessions.json` | 客户端活跃 `targetId -> sessionId` 映射缓存 |

### 环境变量
- `CDP_HOST`：指定浏览器远程调试主机 IP（默认 `127.0.0.1`）。
- `CDP_PORT`：指定浏览器远程调试端口（如 `9222`）。设置后会优先通过 `http://<host>:<port>/json/version` 解析 `webSocketDebuggerUrl`，若不可用（如 `chrome://inspect` / `edge://inspect` 模式）则回退结合 `DevToolsActivePort` 中的路径。
- `CDP_WS_URL`：手动指定完整的浏览器 WebSocket 调试地址（如 `ws://127.0.0.1:9222/devtools/browser/...`）。未指定时自动扫描并对候选端口做 **TCP 存活预检**，自动跳过已关闭浏览器的残留端口文件：
  - **原生 Windows**：`%LOCALAPPDATA%\Google\Chrome*\User Data\DevToolsActivePort`、`%LOCALAPPDATA%\Microsoft\Edge*\User Data\DevToolsActivePort`、Brave、Chromium
  - **Linux / WSL2**：WSL2 挂载的 `/mnt/c/Users/*/AppData/Local/{Google/Chrome*,Microsoft/Edge*,BraveSoftware/Brave-Browser,Chromium}/User Data/DevToolsActivePort` 及 `~/.config/{google-chrome,microsoft-edge,chromium,BraveSoftware/Brave-Browser}/DevToolsActivePort`
- `CDP_PORT_FILE`：手动指定自定义浏览器 User Data 目录下的 `DevToolsActivePort` 文件路径。
- `CDP_BRIDGE_SOCKET`（或 CLI `--socket <path>`）：自定义 Unix Socket 路径或 Windows Named Pipe 名称。
- `CDP_CONNECT_TIMEOUT`（或 CLI `--wait-ms` / `--timeout`）：启动/重连桥接时等待浏览器 WebSocket 进入 `ready` 状态的最大毫秒数（默认 `15000`）。
- `CDP_NO_AUTO_START=1`（或 CLI `--no-auto-start`）：桥接未运行时直接报错退出，禁用按需自动拉起。
- `CDP_DIAG_LOG`（或 CLI `--diag-log <path>`）：自定义工具调用诊断日志路径（默认 `<repo>/logs/diag.jsonl`，单条摘要控制在 100 字以内，满 10MB 自动滚动保留 3 份归档并自动脱敏 JWT/Token/Cookie）。
- `CDP_DIAG=0`（或 CLI `--no-diag`）：关闭工具调用诊断日志写入。
- `CDP_CURSOR`（或 CLI `--cursor <fast|demo|persist|off>` / `--no-cursor`）：控制 `click` / `fill` / `hover` 时的虚拟鼠标指针与水波纹叠加模式。默认为 `fast`（极速非阻塞模式：0 延迟播放虚拟指针飞入、点击扩散波纹与聚焦高亮框，空闲 2.6s 自动淡出；设为 `persist` 持续悬停不自动超时；设为 `demo` 开启 180ms 慢动作轨迹；设为 `0` / `off` 关闭）。**用户在浏览器中点击鼠标接管操作时（鼠标仅滑过页面不会误触发），模拟指针会立即在 `220ms` 内平滑淡出并退出顶层渲染，零阻塞让出视野。**
- `CDP_SCREENSHOT_CURSOR=1`（或 CLI `screenshot --with-cursor` / `--keep-cursor`）：截图时保留并还原最近一次模拟指针位置、角标与高亮框状态（即使此前因空闲超时已淡出也可自动还原入镜；不传该参数时默认自动隐藏模拟指针以保持截图纯净）。

---

## 2. 核心特性

1. **单次握手、按需自启动与多处复用**：
   - `cdp-bridge` 维护浏览器 WebSocket 长连接与 30 秒心跳保活（`Browser.getVersion`）。
   - `start` / `connect` / `restart` 默认等待 WebSocket 真正进入 `ready` 后才返回，确保 `cdp connect 127.0.0.1:9222 && cdp pages` 原子成功无竞态。
   - **客户端按需无感自启动**：执行任意页面或目标操作命令（如 `cdp pages`、`cdp elements`、`cdp eval` 等）时，若检测到桥接守护进程未运行或残留失效 Socket，客户端会在后台静默拉起 `cdp-bridge` 并自动重试（不影响 JSON / `--raw` 纯净标准输出）。
2. **自动防后台冻结与全量会话监控收口**：
   - 守护进程拦截并统一管理所有页面 Session 附着，自动开启 `Runtime` / `Log` / `Network` 环形缓冲（含失败请求响应体前 1000 字符摘要），并自动执行 `Page.setWebLifecycleState({ state: "active" })` 防止后台标签页被浏览器节流假死。
3. **Top-Layer 虚拟指针与人机无缝接管**：
   - 基于原生 Chromium `<div popover="manual">` Top Layer + 封闭 Shadow DOM（挂载于 `document.documentElement`、`<body>` 之外），不被原生 `<dialog>` 弹窗遮挡、不污染 `innerText` 与元素快照、兼容严格 CSP 站点；支持随时鼠标点击接管并平滑淡出。
4. **现代组件库全兼容交互**：
   - **`elements` 快照**：一键提取可见按钮、菜单项、输入框及唯一推荐 CSS 选择器，免手写 DOM 探路脚本。
   - **`page-click`**：派发完整 `PointerEvent` + `MouseEvent` 序列（原生兼容 Radix UI / Shadcn `DropdownMenuTrigger`、Ant Design、Headless UI），支持 `[role='menuitem']` / `[role='menuitemradio']` / `[role='option']`、可见元素优先、精确文本优先排序及 `--native` 真实坐标点击。
   - **`page-fill`**：对 `<input>` / `<textarea>` 走原型链原生 `value` setter，对 `.ProseMirror` / TipTap / Lexical 等 `contenteditable` 富文本编辑器自动通过 CDP `Input.insertText` 写入并保留多行换行。
5. **批量流水线 (`batch`)、精简输出与调用遥测 (`diag`)**：
   - 支持单次进程内按序执行多步交互，支持 `--raw` 纯值输出、`network` / `logs` 多维过滤及内置 `cdp diag` 调用统计看板。

---

## 3. 快速开始（Linux / WSL2 / 原生 Windows）

### 3.1 前置条件：在浏览器中启用 CDP 远程调试
确保目标机器已安装 **Node.js $\ge 22$**，并在 Chromium 内核浏览器（Chrome、Edge、Brave、Chromium 等；不支持已移除 CDP 协议的现代 Firefox 系列）中开启远程调试：

1. **方式一：通过浏览器内置 Inspect 页面开启（推荐，无需重启浏览器）**
   - **Microsoft Edge**：打开 `edge://inspect/#remote-debugging`，勾选开启远程调试（Allow remote debugging）。
   - **Google Chrome**：打开 `chrome://inspect/#remote-debugging`，勾选开启远程调试。
   - *注：开启后首次执行 `cdp start` 连接时，浏览器会弹出一次安全确认框，点击“允许（Allow）”即可建立持久长连接。*
2. **方式二：通过命令行启动参数开启**
   - 启动浏览器时附带 `--remote-debugging-port=9222` 参数。

### 3.2 安装全局命令
```bash
git clone https://github.com/zhouzengming/cdp-bridge.git
cd cdp-bridge
npm link

# 或在 Linux / WSL2 下直接创建软链：
ln -sfn "$(pwd)/cdp.mjs" ~/.local/bin/cdp
ln -sfn "$(pwd)/cdp-bridge.mjs" ~/.local/bin/cdp-bridge
```

### 3.3 启动与验证
```bash
cdp start       # 启动后台桥接守护进程并等待 WebSocket ready
cdp status      # 查看连接状态、PID、转发计数与活跃会话数
cdp pages       # 列出当前所有打开的页面标签
```

---

## 4. 命令详解与使用示例

> **全局选项**（可放在子命令前或后）：
> - `-t, --target <target>`：通过参数指定目标页面（同位置参数 `<target>`，支持 Target ID/前缀、URL 或页面标题匹配）
> - `--socket <path>`：指定控制 Socket / Named Pipe
> - `--timeout <ms>`：覆盖当前命令超时时间
> - `--no-auto-start`：桥接未运行时直接报错退出，禁用按需自动拉起
> - `--no-diag`：跳过本次调用的 `logs/diag.jsonl` 遥测记录
> - `--cursor <fast|demo|persist|off>` / `--no-cursor`：切换或关闭虚拟鼠标指针叠加模式
> - `--with-cursor` / `--keep-cursor`：截图时保留并还原虚拟鼠标指针与高亮框
> - `--raw`：对 `eval` / `text` 直接输出纯值或纯文本，省去外层 JSON 包装
> - `-c, --compact`：输出单行紧凑 JSON

### 4.1 桥接管理与标签页生命周期（`connect` / `pages` / `open` / `close` / `focus`）

```bash
# 启动 / 重启 / 停止 / 查看状态
cdp start
cdp restart
cdp stop
cdp status

# 指定 IP、端口、端口文件或完整 WebSocket URL 连接
cdp connect 127.0.0.1:9222
cdp connect --port-file "/mnt/c/Users/<username>/AppData/Local/Microsoft/Edge/User Data/DevToolsActivePort"
cdp connect ws://192.0.2.10:9222/devtools/browser/3b8f...

# 列出页面标签（别名：list / tabs / list-pages；加 --all 包含 worker / iframe 等）
cdp pages
cdp pages --all
cdp targets     # 别名：list-targets，输出原始 Target.getTargets

# 新建、置顶唤醒与关闭标签页
cdp open "http://127.0.0.1:3000/dashboard"
cdp focus 426B5451      # 别名：activate，激活并解除后台节流与失焦限制
cdp close AEB5E87A      # 别名：page-close，关闭匹配标签页并清理缓存
```

### 4.2 页面元素快照、文本读取与 JS 执行（`elements` / `text` / `eval`）

```bash
# 查看整页或指定容器内的可见可交互元素及推荐选择器（别名：page-elements / snapshot / snap）
cdp elements 426B5451
cdp elements 426B5451 "[role='dialog']" --limit 40

# 读取页面或指定容器可见文本（默认截断 50000 字符）
cdp text 426B5451 "main" --max-length 3000 --raw

# 执行任意 JS 表达式（默认 awaitPromise: true，支持 DOM/循环引用自动降级序列化）
cdp eval 426B5451 "location.href" --raw
cdp eval 426B5451 --file ./inspect.js --timeout 30000
cat ./inspect.js | cdp eval 426B5451 --stdin
```

### 4.3 页面导航、刷新、等待与截图（`navigate` / `reload` / `wait` / `screenshot`）

```bash
# 导航（别名：navigate / goto / nav / page-goto）
cdp goto 426B5451 "http://127.0.0.1:3000/settings"
cdp navigate --new "http://localhost:5173"

# 刷新并等待 readyState === "complete"（--ignore-cache 或 --hard 强制忽略缓存）
cdp reload 426B5451 --ignore-cache --wait-ms 800

# 轮询等待选择器、可见文本或真值 JS 表达式
cdp wait 426B5451 ".status-badge" --text "已完成" --timeout 15000
cdp wait 426B5451 --text "加载成功"

# 截图（别名：screenshot / shot；默认隐藏模拟指针，加 --with-cursor / --keep-cursor 可保留或还原指针与焦点环状态）
cdp screenshot 426B5451 ./viewport.png
cdp screenshot 426B5451 ./pointer-state.png --with-cursor
cdp shot 426B5451 ./dialog.png --selector "[role='dialog']" --keep-cursor
cdp screenshot 426B5451 ./full.webp --full-page --format webp --quality 85
```

### 4.4 表单/富文本填写、点击、悬停与批量流水线（`fill` / `click` / `hover` / `batch`）

```bash
# 填写受控输入框、<select> 或 TipTap/ProseMirror 富文本编辑器（别名：fill / type / page-type）
cdp fill 426B5451 ".ProseMirror" "帮我生成一份摘要" --submit --submit-selector "button[aria-label='发送']"
cdp fill 426B5451 "input[name='keyword']" --clear
cdp fill 426B5451 ".ProseMirror" --file ./prompt.txt

# 点击元素（支持 CSS 选择器或可见文本，支持点击后直接等待新元素出现）
cdp click 426B5451 'button[aria-label="更多操作"]' --wait-for "[role='menuitem']"
cdp click 426B5451 "text=新建任务" --exact
cdp click 426B5451 ".tabs-tab" --index 1 --wait 500

# 移动并悬停模拟指针至元素或指定视口坐标（默认持续显示，仅当用户鼠标点击接管时自动平滑淡出，鼠标滑过不误触发）
cdp hover 426B5451 'button[aria-label="提交"]'
cdp hover 426B5451 320,180

# 在单次进程与单条连接内顺序执行多步操作
cdp batch 426B5451 --stdin <<'EOF'
[
  { "cmd": "fill", "selector": ".ProseMirror", "text": "测试批量交互" },
  { "cmd": "click", "selector": "button[aria-label='发送']" },
  { "cmd": "wait", "text": "已完成", "timeout": 20000 },
  { "cmd": "text", "selector": "main", "maxLength": 2000 }
]
EOF
```

### 4.5 控制台日志、网络请求诊断与调用遥测（`logs` / `network` / `diag`）

```bash
# 查看页面近期错误/警告与未捕获异常（加 --all 包含 console.log/info）
cdp logs 426B5451
cdp logs 426B5451 --all --level error,warn,log --grep "auth|session" --limit 30 --clear

# 默认仅查看异常/失败请求（>=400 或网络错误）；支持按类型、URL 正则、HTTP 方法与状态码精准筛选
cdp network 426B5451
cdp network 426B5451 --all --type fetch,xhr --url "/api/v1/" --method POST --status 2xx,4xx,5xx

# 查看工具自身调用统计看板（成功率、eval 占比、子命令分布、延迟分位数与 Top 报错）
cdp diag
cdp diag summary --days 7
cdp diag errors --limit 20
cdp diag tail --limit 20 --cmd page-click
cdp diag clear
```

### 4.6 底层原始 CDP 调用与 Socket NDJSON 协议（`call` / `send` / `raw`）

```bash
cdp call Browser.getVersion
cdp call DOM.getDocument '{"depth": 2}' --target 426B5451
cdp raw Target.activateTarget --params '{"targetId":"426B5451000000000000000000000000"}'
```

其他语言可直接连接本地控制 Socket / Named Pipe 发送单行 NDJSON 请求：
- `{"id": 1, "method": "bridge.status"}`
- `{"id": 1, "method": "bridge.attach", "params": {"targetId": "<tid>"}}`
- `{"id": 1, "method": "bridge.logs", "params": {"sessionId": "<sid>", "includeAll": false, "clear": false}}`
- `{"id": 1, "method": "bridge.network", "params": {"sessionId": "<sid>", "includeAll": false, "clear": false}}`
- `{"id": 1, "method": "bridge.shutdown"}`
- `{"id": 2, "method": "Runtime.evaluate", "params": {"expression": "document.title", "returnByValue": true}, "sessionId": "<sid>"}`

---

## License

[MIT](./LICENSE)
