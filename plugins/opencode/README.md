# OpenCode 插件目录

本目录用于存放适配 **OpenCode** 的插件模块、自定义 Tool 封装与技能挂载配置。

## 规划结构约定

```text
plugins/opencode/
├── index.mjs             # OpenCode 插件主入口或自定义工具注册模块
├── opencode.example.json # OpenCode MCP / Plugin 接入配置示例
└── skills/               # 引用或打包 ../../skills/cdp-bridge
```
