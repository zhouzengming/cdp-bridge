# CDP Bridge Plugin for Google Antigravity

面向 **Google Antigravity**（Antigravity CLI `agy` / Antigravity IDE / Antigravity 2.0）的原生轻量 CLI 插件包。不额外常驻 MCP 子进程，开箱提供技能指引、工作区约束规则与防直连端口守护 Hook。

## 内置组件

| 组件 | 路径 | 作用 |
| :--- | :--- | :--- |
| **Manifest** | [`plugin.json`](./plugin.json) | Antigravity 原生插件元数据声明（含名称、版本、协议与图标） |
| **Skill** | [`skills/cdp-bridge/SKILL.md`](./skills/cdp-bridge/SKILL.md) | 渐进式加载的 `cdp-bridge` 标准工作流（`elements` / `click` / `fill` / `hover` / `scroll` / `batch` / `diag`） |
| **Hook** | [`hooks.json`](./hooks.json) + [`scripts/cdp-guard.mjs`](./scripts/cdp-guard.mjs) | `PreToolUse` 守护拦截：阻止 Agent 用 `curl :9222/json`、`wscat` 或 `playwright.connect_over_cdp` 绕过桥接直连浏览器端口，避免重复弹窗与 `HTTP_PROXY` 502 报错 |
| **Rule** | [`rules/AGENTS.md`](./rules/AGENTS.md) | 精简常驻规则（< 1 KB），引导涉及浏览器操作时优先激活 `cdp-bridge` Skill 并走高层原语 |
| **Logo** | [`assets/logo.svg`](./assets/logo.svg) | 插件列表专属矢量图标 |

---

## 前置依赖

本插件驱动全局 `cdp` CLI 与 `cdp-bridge` 守护进程工作。请先按仓库根 [`README.md`](../../README.md#快速开始) 完成 `npm link`（或软链 `~/.local/bin/cdp`）并在浏览器开启远程调试。

---

## 安装与挂载方式

任选以下一种方式接入 Antigravity：

### 方式一：通过 `agy plugin install` 安装（支持本地目录或 GitHub 子目录 URL）

```bash
# 1) 从本地已克隆仓库安装
agy plugin install /path/to/cdp-bridge/plugins/antigravity

# 2) 或直接从 GitHub 仓库子目录拉取安装
agy plugin install https://github.com/zhouzengming/cdp-bridge/tree/main/plugins/antigravity
```

### 方式二：通过 `plugins.json` 声明式挂载（适合本地源码实时联动）

在项目级 `.agents/plugins.json` 或全局 `~/.gemini/config/plugins.json` 中写入：

```json
{
  "entries": [
    {
      "path": "/path/to/cdp-bridge/plugins",
      "include_only": ["antigravity"]
    }
  ]
}
```

### 方式三：软链至项目 `.agents/plugins/`

```bash
mkdir -p /path/to/your-workspace/.agents/plugins
ln -sfn /path/to/cdp-bridge/plugins/antigravity /path/to/your-workspace/.agents/plugins/cdp-bridge
```

---

## 管理与本地校验

```bash
# 严格模式校验插件清单与组件完整性（0 errors, 0 warnings）
agy plugin validate ./plugins/antigravity --strict

# 运行插件自测（Manifest 校验 + Skill 同步校验 + PreToolUse Guard 单测）
node --test ./plugins/antigravity/plugin.test.mjs

# 查看已安装插件及启停控制
agy plugin list
agy plugin enable cdp-bridge
agy plugin disable cdp-bridge
```

> **临时放行直连调试端口**：若极少数底层排障确实需要直接用 `curl` 访问 `127.0.0.1:9222/json`，可在命令前显式附带环境变量 `CDP_ALLOW_DIRECT=1`（如 `CDP_ALLOW_DIRECT=1 curl http://127.0.0.1:9222/json/version`）。
