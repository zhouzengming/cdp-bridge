# Skills 目录

本目录存放遵循标准 `skills/<skill-name>/SKILL.md` 规范的 AI Coding Agent 技能包，可直接挂载至各主流 Agent 宿主或由 `plugins/` 下的插件包引用复用。

## 已内置技能

| 路径 | 名称 | 说明 |
| :--- | :--- | :--- |
| [`cdp-bridge/SKILL.md`](./cdp-bridge/SKILL.md) | `cdp-bridge` | 浏览器交互式调试与端到端验收标准工作流（元素快照、虚拟指针点击/悬停/滚轮、富文本输入、`batch` 流水线与日志/网络排障） |

## 挂载方式示例

```bash
# 工作区 .agents 规范目录（Antigravity / Codex 等）
mkdir -p /path/to/your-workspace/.agents/skills
ln -sfn "$(pwd)/skills/cdp-bridge" /path/to/your-workspace/.agents/skills/cdp-bridge

# Claude Code 全局个人技能目录
mkdir -p ~/.claude/skills
ln -sfn "$(pwd)/skills/cdp-bridge" ~/.claude/skills/cdp-bridge

# Codex 全局个人技能目录
mkdir -p ~/.codex/skills
ln -sfn "$(pwd)/skills/cdp-bridge" ~/.codex/skills/cdp-bridge

# Antigravity / Gemini 全局技能目录
mkdir -p ~/.gemini/config/skills
ln -sfn "$(pwd)/skills/cdp-bridge" ~/.gemini/config/skills/cdp-bridge
```
