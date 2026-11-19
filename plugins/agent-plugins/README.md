# Agent Plugins 1.0 通用包目录

本目录用于存放遵循厂商中立标准 **[Agent Plugins 1.0](https://agent-plugins.org/specification)** 的跨客户端可移植插件包，供所有支持该规范的客户端统一加载。

## 规划结构约定

```text
plugins/agent-plugins/
├── plugin.json           # Agent Plugins 1.0 标准清单
├── mcp.json              # Stdio MCP 服务声明（指向 ../../mcp/server.mjs）
└── skills/               # 标准 Agent Skills（引用或同步 ../../skills/cdp-bridge）
```
