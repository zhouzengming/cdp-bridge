# Plugins 目录

本目录按**目标 Agent App / 插件规范**划分子目录，用于存放适配各主流 AI Coding Agent 的插件清单（Manifest）、生命周期 Hooks、规则（Rules）与安装配置。

所有宿主插件共享仓库底层的核心桥接源码 [`src/`](../src/)、标准技能规范 [`skills/cdp-bridge/`](../skills/cdp-bridge/) 与轻量 MCP 服务 [`mcp/`](../mcp/)，各子目录维护宿主专属的声明文件与守护胶水层。

## 目标宿主子目录状态

| 子目录 | 目标宿主 / 规范 | 状态 | 推荐场景与核心组件 |
| :--- | :--- | :--- | :--- |
| [`antigravity/`](./antigravity/) | Google Antigravity（轻量 CLI 版） | **已可用** | **Linux / WSL2 首选**：零常驻 MCP 子进程，含 `plugin.json`、`hooks.json`（防直连 9222 守护）、`rules/AGENTS.md`、`skills/cdp-bridge/` |
| [`antigravity-mcp/`](./antigravity-mcp/) | Google Antigravity（MCP + CLI 版） | **已可用** | **原生 Windows / 受限沙箱首选**：在 CLI 版基础上挂载 `cdp-mcp`（连接共享 Named Pipe/Socket，免除 PowerShell 转义与 GBK 乱码） |
| [`claude-code/`](./claude-code/) | Anthropic Claude Code | 规划脚手架 | `.claude-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json`、`skills/` |
| [`codex/`](./codex/) | OpenAI Codex | 规划脚手架 | `plugin.json`、`mcp.json`、`hooks/`、`skills/` |
| [`cursor/`](./cursor/) | Cursor IDE | 规划脚手架 | `mcp.json`、Hooks 与 Rules 集成配置 |
| [`opencode/`](./opencode/) | OpenCode | 规划脚手架 | OpenCode 插件入口、自定义工具与技能注册配置 |
| [`agent-plugins/`](./agent-plugins/) | [Agent Plugins 1.0](https://agent-plugins.org/specification) 跨端通用包 | 规划脚手架 | 厂商中立 `plugin.json` + `mcp.json` + `skills/` |
