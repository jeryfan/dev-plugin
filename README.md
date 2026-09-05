# dev-plugin

个人跨工具 Agent 插件包：一份 skills + MCP 资源，同时兼容 **Claude Code**、**Codex CLI**、**Kimi Code** 和 **pi** 的插件规范。

## 原理

四个工具的插件体系都以 `SKILL.md`（Agent Skills 开放格式）为技能标准，差异只在清单文件。本仓库用一份资源 + 多份薄清单实现兼容：

```
dev-plugin/
├── skills/                      # skills
├── extensions/                  # pi 扩展
├── prompts/                     # pi 提示词模板
│   └── commit/SKILL.md
├── .mcp.json                    # MCP 配置
├── .claude-plugin/
│   ├── plugin.json              # Claude Code 清单
│   └── marketplace.json         # Claude Code 个人插件市场
├── .codex-plugin/plugin.json    # Codex 清单
├── .agents/plugins/marketplace.json  # Codex 个人插件市场
├── kimi.plugin.json             # Kimi 清单（mcpServers 由 sync 生成）
├── skills.json                  # 第三方 skill 拉取清单
├── skills-lock.json             # vendor 的上游 skill 版本记录（sync 生成）
├── package.json                 # pi 清单（pi.extensions/skills/prompts 键）
└── scripts/
    ├── sync-mcp.js              # MCP 配置同步
    └── sync-skills.js           # 第三方 skill vendor 同步
```

## 安装（每个工具一行命令）

| 工具 | 命令 |
|---|---|
| Claude Code | `/plugin marketplace add jeryfan/dev-plugin` 然后 `/plugin install dev-plugin@jeryfan` |
| Codex CLI | 在 `~/.agents/plugins/marketplace.json` 加入本仓库，或按 Codex 插件浏览器添加 |
| Kimi Code | `/plugins install jeryfan/dev-plugin` |
| pi | `pi install git:github.com/jeryfan/dev-plugin`（不带 ref，跟随默认分支，`pi update` 拉最新） |

> 仓库推送到 GitHub 后上述命令即可使用；本地测试可用 `claude --plugin-dir ./dev-plugin` 或 pi 的本地路径安装 `pi install /path/to/dev-plugin`。

## 维护

### 新增个人 skill

在 `skills/<name>/SKILL.md` 创建，带 YAML frontmatter（`name`、`description`）。四个工具自动共享，无需改清单。

### 第三方 skill

采用 vendor 模式：`scripts/sync-skills.js` 根据 **`skills.json` 清单**拉取上游最新 skill 到 `skills/`。同步流程带备份回退：拉取前把将被覆盖的旧 skill 移到 `.cache/skills/`，全部成功才删除备份，任一失败则回退到同步前状态；上次 vendor 但本次清单不再包含的 skill 会被自动移除；**清单之外的 `skills/` 目录视为个人 skill，不做任何改动**。

**发版前运行 `npm run sync` 并提交结果**，用户通过各工具的 update 命令（`pi update`、`/plugin update` 等）拿到最近一次同步的快照。上游版本记录在 `skills-lock.json`。

新增第三方 skill：编辑 `skills.json`，格式：

```json
{ "repo": "https://github.com/user/repo.git", "path": "skills", "include": ["a"], "exclude": ["b"] }
```

- `path`：skills 列表所在目录（默认根目录下的 `skills`，标准布局可省略），递归发现含 `SKILL.md` 的目录；同仓库有多个 skills 目录时可配置多条记录
- `include`：只拉取列出的 skill 目录名；省略则全量
- `exclude`：排除列出的 skill 目录名

同名 skill 冲突时后到者被跳过并告警。

### 新增 MCP server

只改 `.mcp.json`，然后运行 `npm run sync`（脚本会同步到 `kimi.plugin.json`）。Claude / Codex 直接读 `.mcp.json`，无需同步。

> 注：Kimi 不读 `.mcp.json`，`mcpServers` 必须内联在 `kimi.plugin.json`，这就是同步脚本存在的原因。pi 不支持包级 MCP，其全局配置由 pi-dev 的 postinstall 维护。

### 版本号

发版时统一更新 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`kimi.plugin.json`、`package.json` 中的 `version`。

## 与 pi-dev 的关系

两者独立：pi-dev 是 pi 专用的开发环境包（extensions、全局 AGENTS.md、同步脚本）；本仓库是跨工具的通用 skills/MCP 插件包。
