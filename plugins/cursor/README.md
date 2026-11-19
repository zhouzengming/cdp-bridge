# Cursor 插件目录

本目录用于存放适配 **Cursor IDE** 的插件配置、MCP 接入模板与 Rules / Hooks 集成说明。

## 规划结构约定

```text
plugins/cursor/
├── mcp.json              # Cursor MCP 服务接入配置（指向 ../../mcp/server.mjs）
├── rules/                # 可选：.mdc 浏览器调试与验收规则模板
└── hooks/                # 可选：Cursor Agent Hooks 脚本与配置
```
