# CDP Bridge Plugin for Claude Code（轻量 CLI 版）

面向 **Anthropic Claude Code** 的原生轻量 CLI 插件（零常驻 MCP 子进程，适合 Linux / WSL2 / macOS 终端工作流；原生 Windows 或受限沙箱环境可选用 MCP 版 [`plugins/claude-code-mcp/`](../claude-code-mcp/)，两版按需二选一）。

## 内置组件

| 组件 | 路径 | 作用 |
| :--- | :--- | :--- |
| **Claude Plugin Manifest** | [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json) | Claude Code 原生插件清单 |
| **Skill** | [`skills/cdp-bridge/SKILL.md`](./skills/cdp-bridge/SKILL.md) | 自动发现的标准 `cdp-bridge` 浏览器交互调试与端到端验收工作流 |
| **Hook** | [`hooks/hooks.json`](./hooks/hooks.json) + [`scripts/cdp-guard.mjs`](./scripts/cdp-guard.mjs) | `PreToolUse` (`Bash`) 守护脚本（使用 `"${CLAUDE_PLUGIN_ROOT}"` 完整加引号路径），拦截绕过桥接直连 `:9222/json`、`wscat` 或 `playwright.connect_over_cdp` 的命令 |

---

## 前置依赖

请先按仓库根 [`README.md`](../../README.md#快速开始) 运行 `npm link`（或软链 `~/.local/bin/cdp`）安装全局 `cdp` 与 `cdp-bridge` 命令，并在 Chrome / Edge 开启远程调试。

---

## 安装方式（通过仓库内置 Claude Code Marketplace）

仓库根目录已提供标准 Claude Code 市场清单 [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)，支持通过 CLI 一键安装：

```bash
# 1) 添加市场（GitHub 远端 或 本地克隆路径）
claude plugin marketplace add zhouzengming/cdp-bridge
# 或本地目录：
# claude plugin marketplace add /path/to/cdp-bridge

# 2) 安装轻量 CLI 版插件（若需原生 Windows MCP 版请安装 cdp-bridge-mcp@cdp-bridge）
claude plugin install cdp-bridge@cdp-bridge
```

### 本地严格校验

```bash
claude plugin validate --strict ./plugins/claude-code
claude plugin validate --strict ./.claude-plugin/marketplace.json
```

> **临时放行直连端口**：如底层排障确需直连 `9222` 端口，可在命令前加 `CDP_ALLOW_DIRECT=1`。
