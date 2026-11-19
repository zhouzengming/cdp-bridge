# CDP Bridge (MCP Edition) Plugin for Google Antigravity

面向**原生 Windows 环境（PowerShell / CMD）**与**无 Shell / 受限沙箱子代理**的 Google Antigravity 插件包（与纯 CLI 版 [`plugins/antigravity/`](../antigravity/) 按需二选一安装，请勿同时启用两个版本）。

## 与轻量 CLI 版 (`plugins/antigravity`) 的区别

- **底层共享常驻守护进程**：本插件声明了 `mcp_config.json`（启动全局 `cdp-mcp` Stdio 服务），但 `cdp-mcp` 内部依然连接 `cdp-bridge` 守护进程的 Windows 命名管道 / Unix Socket，**多窗口共享同一条浏览器连接，不会重复触发“允许远程调试”弹窗**。
- **零命令行转义与零编码问题**：所有多行文本、复杂 CSS 选择器与 JS 表达式通过纯 UTF-8 管道直传，彻底避开原生 Windows PowerShell 引号吞吃、`$` 变量误展开和 `CP936` 乱码。
- **内置 WMI 脱离 Job Object 自启动**：首次调用自动拉起 `cdp-bridge` 时，Windows 下通过 WMI `Win32_Process.Create` 脱离单步命令 Job Object，守护进程不会被连坐回收。

## 前置条件

先在克隆的仓库根目录执行 `npm link`（使全局 `cdp`、`cdp-bridge`、`cdp-mcp` 命令加入系统 `PATH`），并在 Chrome / Edge 开启远程调试。

## 安装方式

```bash
# 从本地目录安装
agy plugin install ./plugins/antigravity-mcp

# 或直接从 GitHub 子目录安装
agy plugin install https://github.com/zhouzengming/cdp-bridge/tree/main/plugins/antigravity-mcp
```
