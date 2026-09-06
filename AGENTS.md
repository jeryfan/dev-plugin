# dev-plugin

个人开发使用的跨工具 Agent 插件包：一份 skills + MCP 资源，同时兼容 Claude Code、Codex CLI、Kimi Code、pi 的插件规范，随仓库发布到 GitHub，各工具通过插件安装/更新获取。

## 目录规则

- `skills/`：唯一 skill 源，四个工具共用
  - **个人 skill**：直接在 `skills/<name>/` 下维护
  - **vendor skill**：来自第三方仓库，由脚本同步进 `skills/`，**不要手工编辑**（会被下次同步覆盖）；识别方式是在 `skills-lock.json` 中有记录
- `.mcp.json`：MCP server 唯一数据源，改完运行 `npm run sync` 同步到 `kimi.plugin.json`（Kimi 不读 .mcp.json，必须内联）。Claude / Codex 直接读 `.mcp.json`；pi 不支持包级 MCP
- `sources.json`：第三方资源拉取清单（手工维护，含 skills / agents / prompts 三类）
- `sources-lock.json`：vendor 版本锁定记录（脚本生成，不要手改）

## 同步规则

```bash
npm run sync   # = sync-mcp（MCP）+ sync-sources（第三方 skills / agents / prompts）
```

- `sync-sources.js` 按 `sources.json` 浅克隆上游最新版复制进 `skills/`、`agents/`、`prompts/`，带备份回退；清单外的目录（个人资源）不动；上次 vendor 但本次清单不再包含的资源会被自动移除
- 发版流程：`npm run sync` → bump 四个清单（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`kimi.plugin.json`、`package.json`）的 version → 提交推送

## 添加外部 skills

需要添加外部（第三方）资源时，**必须使用 `skills/add-external-skill/SKILL.md`** 中定义的规则编辑 `sources.json`，然后运行 `npm run sync` 验证。
