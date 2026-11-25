# MCP Server (`cdp-mcp`)

零第三方依赖的 **Model Context Protocol (MCP)** Stdio 服务端（[`server.mjs`](./server.mjs) + [`tools.mjs`](./tools.mjs)），专为**原生 Windows 环境（规避 PowerShell/CMD 引号转义与 CP936 中文乱码）**、**无 Shell 执行权限的桌面客户端**（如 Claude Desktop / OpenWebUI）及**只读子代理**设计。

## 架构特点（“常驻命名管道/Socket 底座 + 轻量 MCP 前端”）

1. **绝不取代守护进程，保持全局仅点 1 次 Allow**：
   - `cdp-mcp` 自身不新建浏览器 WebSocket 连接，而是复用 [`src/cdp-bridge.mjs`](../src/cdp-bridge.mjs) 的本地 Unix Socket 或 Windows 命名管道（`\\.\pipe\cdp-bridge-<username>`）。
   - 即使同时打开多个 Agent 窗口、IDE 会话与外部终端 `cdp` 命令，依然共享**唯一一条**浏览器调试连接与控制台/网络环形缓冲区。
   - 在原生 Windows 下首次按需拉起守护进程时，`cdp-bridge` 会自动通过 WMI `Win32_Process.Create`（[`src/win-spawn.mjs`](../src/win-spawn.mjs)）脱离宿主单步命令的 Job Object 强杀限制。
2. **彻底告别 Windows 命令行转义与乱码**：
   - `cdp_fill`、`cdp_eval`、`cdp_batch` 等工具通过 `shell: false` 子进程与纯 UTF-8 `stdin` 管道直接投递文本/脚本，完全绕开 `powershell.exe` / `cmd.exe` 的双引号吞吃、`$` 变量误展开与 GBK 代码页问题。
3. **双帧格式自动协商与权限注解**：
   - 自动识别并自适应 **单行 NDJSON**（MCP `2024-11-05` / `2025-03-26` / `2025-06-18`）与 **`Content-Length` 头部帧**。
   - 全部 18 个工具均附带标准 MCP `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint`），方便宿主按“只读探测 / 页面交互”精细控制审批策略。

---

## 暴露的 MCP 工具清单（18 个）

| 工具名 | 只读 (`readOnlyHint`) | 对应能力说明 |
| :--- | :---: | :--- |
| `cdp_status` | ✅ | 查询桥接状态（支持 `ensure: true` 按需拉起或 `connect` 切换目标端口） |
| `cdp_pages` | ✅ | 列出当前打开的浏览器标签页 |
| `cdp_elements` | ✅ | 快照可见可交互元素及推荐唯一选择器 |
| `cdp_text` | ✅ | 读取整页或指定容器可见文本 |
| `cdp_wait` | ✅ | 轮询等待选择器、可见文本或真值 JS 表达式 |
| `cdp_screenshot` | ✅ | 视口/元素/整页截图（支持 `withCursor` 还原虚拟指针、`returnImage` 返回内联图像块） |
| `cdp_logs` | ✅ | 读取页面近期错误/警告日志与未捕获异常 |
| `cdp_network` | ✅ | 诊断失败请求（4xx/5xx/断网及响应体摘要）或按正则/状态码过滤 API 流量 |
| `cdp_manage_tab` | ❌ | 新建（含 `background`）、跳转、刷新、置顶唤醒（`focus`）或关闭标签页 |
| `cdp_click` | ❌ | 按选择器、可见文本或 `x,y` 点击（带柔和半透明双层水波纹） |
| `cdp_fill` | ❌ | 纯 UTF-8 管道写入受控输入框、`<select>` 或 `.ProseMirror` 多行富文本 |
| `cdp_hover` | ❌ | 移动并悬停虚拟指针至元素或 `x,y` 坐标（用户点击页面时平滑淡出接管） |
| `cdp_drag` | ❌ | 平滑模拟鼠标按住拖动（兼容 Pointer/Mouse 与 HTML5 `DragEvent`，带轨迹虚线与起止波纹） |
| `cdp_scroll` | ❌ | 模拟鼠标滚轮滚动并展示滚动方向与像素角标 |
| `cdp_record` | ❌ | 零依赖高清 `.webm` 录屏（支持 `start` / `pause` / `resume` / `stop` / `concat` 多段无损拼接 / `clip` / `status` / `cancel`；默认显示右上角高透明 `REC` 提示，传 `hud: false` 可关闭） |
| `cdp_batch` | ❌ | 单次连接按序批量执行多步交互（支持 `drag`、`record-pause`/`record-resume` 与 `recordPath` 录屏，支持 `hud: false` 关闭右上角提示） |
| `cdp_eval` | ❌ | 纯 UTF-8 管道执行任意页面 JS 表达式 |
| `cdp_call` | ❌ | 调用底层原始 CDP 协议方法 |

---

## 接入配置方式

先在仓库根目录运行 `npm link`（或在 Linux/WSL2 软链 `~/.local/bin/cdp-mcp`），使全局 `cdp-mcp` 命令可用：

### 1. 通用客户端配置（Antigravity `~/.gemini/config/mcp_config.json` / Claude Desktop / Cursor / Codex）

```json
{
  "mcpServers": {
    "cdp-bridge": {
      "command": "cdp-mcp"
    }
  }
}
```

若未执行 `npm link`，也可直接指定 `node` 与 `mcp/server.mjs` 绝对路径：

```json
{
  "mcpServers": {
    "cdp-bridge": {
      "command": "node",
      "args": ["C:/path/to/cdp-bridge/mcp/server.mjs"]
    }
  }
}
```

### 2. Google Antigravity 插件一键安装（MCP 版）

原生 Windows 用户可直接安装仓库预置的 [`plugins/antigravity-mcp/`](../plugins/antigravity-mcp/) 插件（Linux / WSL2 用户推荐优先安装零常驻进程的轻量 CLI 版 [`plugins/antigravity/`](../plugins/antigravity/)，按需二选一）：

```bash
agy plugin install https://github.com/zhouzengming/cdp-bridge/tree/main/plugins/antigravity-mcp
```
