# Claude Code 插件目录

本目录用于存放适配 **Claude Code** 的插件包与市场分发配置。

## 规划结构约定

```text
plugins/claude-code/
├── .claude-plugin/
│   └── plugin.json       # Claude Code 插件元数据清单
├── .mcp.json             # 指向 ../../mcp/server.mjs 的 Stdio MCP 配置
├── hooks/
│   └── hooks.json        # 可选：会话生命周期与工具调用前后置 Hooks
└── skills/               # 引用或打包 ../../skills/cdp-bridge
```
