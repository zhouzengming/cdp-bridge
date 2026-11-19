# CDP Bridge Plugin for OpenAI Codex（轻量 CLI 版）

面向 **OpenAI Codex** 的原生轻量 CLI 插件（零常驻 MCP 子进程，适合 Linux / WSL2 / macOS 终端工作流；原生 Windows 或受限沙箱环境可选用 MCP 版 [`plugins/codex-mcp/`](../codex-mcp/)，两版按需二选一）。

## 内置组件

| 组件 | 路径 | 作用 |
| :--- | :--- | :--- |
| **Codex Manifest** | [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) | Codex 原生插件清单与 Marketplace 展示元数据 |
| **Skill** | [`skills/cdp-bridge/SKILL.md`](./skills/cdp-bridge/SKILL.md) | 标准 `cdp-bridge` 浏览器交互调试与端到端验收工作流 |
| **Hook** | [`hooks/hooks.json`](./hooks/hooks.json) + [`scripts/cdp-guard.mjs`](./scripts/cdp-guard.mjs) | `PreToolUse` (`Bash`) 守护脚本：拦截绕过桥接直连 `127.0.0.1:9222/json`、`wscat` 或 `playwright.connect_over_cdp` 的命令，返回标准 `permissionDecision: "deny"` 指引改用 `cdp` CLI |

---

## 前置依赖

请先按仓库根 [`README.md`](../../README.md#快速开始) 运行 `npm link`（或软链 `~/.local/bin/cdp`）安装全局 `cdp` 与 `cdp-bridge` 命令，并在 Chrome / Edge 开启远程调试。

---

## 安装方式（通过仓库内置 Codex Marketplace 目录）

仓库根目录已提供标准 Codex 插件市场索引 [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json)，支持直接从 GitHub 或本地克隆目录安装：

```bash
# 1) 注册市场（任选其一：GitHub 远端 或 本地克隆目录）
codex plugin marketplace add zhouzengming/cdp-bridge
# 或本地路径：
# codex plugin marketplace add /path/to/cdp-bridge

# 2) 安装轻量 CLI 版插件（若需原生 Windows MCP 版请安装 cdp-bridge-mcp@cdp-bridge）
codex plugin add cdp-bridge@cdp-bridge
```

### 启用与信任插件 Hook

在 `~/.codex/config.toml` 中确认已启用 Hooks（新版 Codex 若默认开启可跳过）：

```toml
[features]
hooks = true
```

随后启动 `codex`，在首次 Hook 审核提示中选择 **Trust all and continue**（或在会话内通过 `/hooks` 与 `/plugins` 管理开关）。

> **临时放行直连端口**：如底层排障确需直连 `9222` 端口，可在命令前加 `CDP_ALLOW_DIRECT=1`。
