# Codex 插件目录

本目录用于存放适配 **OpenAI Codex** 的插件包、MCP 声明与技能集成配置。

## 规划结构约定

```text
plugins/codex/
├── plugin.json           # Codex 插件清单
├── mcp.json              # 指向 ../../mcp/server.mjs 的 Stdio MCP 配置
├── hooks/                # 可选：Codex 会话生命周期 Hooks
└── skills/               # 引用或打包 ../../skills/cdp-bridge
```
