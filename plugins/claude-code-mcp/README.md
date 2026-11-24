# CDP Bridge (MCP Edition) Plugin for Claude Code

面向**原生 Windows（PowerShell / CMD）**与**受限沙箱环境**的 Claude Code 插件（与轻量 CLI 版 [`plugins/claude-code/`](../claude-code/) 按需二选一安装，请勿同时启用两个版本）。

## 核心特性

- **17 个零依赖 Stdio MCP 工具**：通过 [`.mcp.json`](./.mcp.json) 启动全局 `cdp-mcp` 服务端（含 `cdp_record` 验收录屏），底层复用共享的 `cdp-bridge` Windows Named Pipe / Linux Unix Socket，多窗口与外部终端依然**仅需首次点 1 次浏览器 Allow**。
- **免除 Windows PowerShell 引号转义与乱码**：多行中文、嵌套引号与 JS 表达式均经 UTF-8 管道直传，彻底避开 Windows 命令行转义坑。
- **内置 Skill + 防直连 9222 Hook**：同样内置 `cdp-bridge` Skill 与 `PreToolUse` (`Bash`) 守护脚本。

## 前置依赖

请先在仓库根目录运行 `npm link`（使 `cdp`、`cdp-bridge`、`cdp-mcp` 全局可用），并在 Chrome / Edge 开启远程调试。

## 安装方式

```bash
# 1) 添加市场（GitHub 远端 或 本地克隆目录）
claude plugin marketplace add zhouzengming/cdp-bridge

# 2) 安装 MCP + CLI 版插件
claude plugin install cdp-bridge-mcp@cdp-bridge
```

### 本地严格校验

```bash
claude plugin validate --strict ./plugins/claude-code-mcp
```
