# dev-plugin

个人开发使用的跨工具 Agent 插件包：一份 skills + MCP 资源，同时兼容 Claude Code、Codex CLI、Kimi Code、pi 的插件规范，随仓库发布到 GitHub，各工具通过插件安装/更新获取。

## 目录规则

- `skills/`：分发的 skill 源，四个工具共用
  - **个人 skill**：直接在 `skills/<name>/` 下维护，同步脚本不碰（不在 `sources-lock.json` 中即视为个人资源）
  - **vendor skill**：来自第三方仓库，由脚本同步进 `skills/`，**不要手工编辑**（会被下次同步覆盖）；识别方式是在 `sources-lock.json` 中有记录
- `.agents/skills/`：维护本仓库用的**元 skill**（如何添加资源的操作指南），只在本地 clone 下工作，不随插件分发——`package.json` 的 `pi.skills` 只列了 `./skills`。新增 skill 的规范写在这里，而不是放进 `skills/`
- `.mcp.json`：MCP server 唯一数据源，改完运行 `npm run sync` 同步到 `kimi.plugin.json`（Kimi 不读 .mcp.json，必须内联）。Claude / Codex 直接读 `.mcp.json`；pi 不支持包级 MCP
- `sources.json`：第三方资源拉取清单（手工维护，含 skills / agents / prompts 三类）
- `sources-lock.json`：vendor 版本锁定记录（脚本生成，不要手改）

## 同步规则

```bash
npm run sync   # = sync-mcp（MCP）+ sync-sources（第三方 skills / agents / prompts）
```

- `sync-sources.js` 按 `sources.json` 浅克隆上游最新版复制进 `skills/`、`agents/`、`prompts/`，带备份回退；清单外的目录（个人资源）不动；上次 vendor 但本次清单不再包含的资源会被自动移除
- 发版流程：`npm run sync` → bump 四个清单（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`kimi.plugin.json`、`package.json`）的 version → 提交推送

## 添加 skills

两类 skill 的入口都在 `.agents/skills/`（元 skill，不在 `skills/` 下）：

| 场景 | 入口 |
| --- | --- |
| 添加第三方资源（skills / agents / prompts） | `.agents/skills/add-external-skill/SKILL.md` |
| 新增个人 skill | `.agents/skills/add-custom-skill/SKILL.md` |

添加外部（第三方）资源时，**必须按 `add-external-skill` 中定义的规则编辑 `sources.json`**，然后运行 `npm run sync` 验证。不要手工往 `skills/` 里塞第三方资源。
