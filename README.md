# dev-plugin

个人跨工具 Agent 插件包：以一份共享 skills 资源为核心，并为 **Claude Code**、**Codex CLI**、**Kimi Code** 和 **pi** 提供各自的插件清单与适配配置。

## 原理

本仓库以 `skills/` 作为跨工具共享核心。各工具对 MCP、agents、extensions、prompts 和安装生命周期的支持不同，因此这些资源并非全部等价分发：

```
dev-plugin/
├── skills/                           # 跨工具共享 skills
├── agents/                           # vendor agents
├── extensions/                       # pi 扩展
├── prompts/                          # pi prompts；当前无自有 prompt
├── AGENTS.md                         # 仓库维护说明
├── .pi/AGENTS.md                     # 安装时复制给 pi 的全局说明
├── .mcp.json                         # MCP 唯一数据源
├── .claude-plugin/
│   ├── plugin.json                   # Claude Code 清单
│   └── marketplace.json              # Claude Code marketplace
├── .codex-plugin/plugin.json         # Codex 清单
├── .agents/plugins/marketplace.json  # Codex marketplace
├── .agents/skills/                   # 维护本仓库的元 skills，不随插件分发
├── kimi.plugin.json                  # Kimi 清单，mcpServers 由 sync 生成
├── package.json                      # pi 清单与 npm 生命周期脚本
├── sources.json                      # 第三方资源拉取清单
├── sources-lock.json                 # vendor 上游版本记录
└── scripts/
    ├── sync-mcp.js                   # 同步 Kimi MCP 配置
    ├── sync-sources.js               # 同步第三方资源
    ├── setup-pi.js                   # 配置 pi 的全局 MCP 与 AGENTS.md
    └── bump-version.js               # 统一更新清单版本号
```

## 安装与更新

以下命令安装或更新的是本仓库插件/package，不是对应 CLI 本体。

### Claude Code

安装：

```bash
claude plugin marketplace add jeryfan/dev-plugin
claude plugin install dev-plugin@jeryfan
```

更新：

```bash
claude plugin marketplace update jeryfan
claude plugin update dev-plugin@jeryfan
```

也可以在 Claude Code 会话中使用等价的 `/plugin` 命令。本地测试：

```bash
claude --plugin-dir /absolute/path/to/dev-plugin
```

### Codex CLI

安装：

```bash
codex plugin marketplace add jeryfan/dev-plugin
codex plugin add dev-plugin@jeryfan
```

更新本仓库插件：

```bash
codex plugin marketplace upgrade jeryfan
codex plugin add dev-plugin@jeryfan
```

> 第一个命令刷新 marketplace 快照，第二个命令按最新快照重新安装插件。当前 Codex CLI 没有独立的 `codex plugin update` 命令；`codex update` 更新的是 Codex CLI 本体，不是本插件。

### Kimi Code

在 Kimi Code 会话中安装：

```text
/plugins install https://github.com/jeryfan/dev-plugin
```

已安装插件有更新时，可在 `/plugins` 管理器中选择插件并按 `Enter` 更新；也可重复执行安装命令。清单文件为仓库根目录的 `kimi.plugin.json`。

### pi

安装：

```bash
pi install git:github.com/jeryfan/dev-plugin
```

更新本插件：

```bash
pi update git:github.com/jeryfan/dev-plugin
```

更新全部已安装 package：

```bash
pi update --extensions
```

本地路径安装：

```bash
pi install /absolute/path/to/dev-plugin
```

> 注意：pi 安装会触发本包的 `postinstall`。`scripts/setup-pi.js` 会把 `.mcp.json` 和 `.pi/AGENTS.md` 分别复制到 `~/.pi/agent/mcp.json` 与 `~/.pi/agent/AGENTS.md`，并覆盖已有同名文件；如已有自定义配置，请先备份。

## 维护

### 新增个人 skill

在 `skills/<name>/SKILL.md` 创建个人 skill，并添加包含 `name`、`description` 的 YAML frontmatter。该目录由四个工具的包装层作为共享 skills 来源，无需逐个修改清单。

流程规范见 `.agents/skills/add-custom-skill/SKILL.md`。**个人 skill 不会被 `npm run sync` 删除**——脚本只移除「`sources-lock.json` 里有记录、但本次清单已不含」的 vendor 资源，清单外的目录一律不动。

### 第三方资源（skills / agents / prompts）

采用 vendor 模式：`scripts/sync-sources.js` 根据 **`sources.json` 清单**拉取上游最新资源到 `skills/`、`agents/`、`prompts/`。同步流程带备份回退：拉取前把将被覆盖的旧资源移到 `.cache/sources/`，全部成功才删除备份，任一失败则回退到同步前状态；上次 vendor 但本次清单不再包含的资源会被自动移除；**清单之外的目录视为个人资源，不做任何改动**。

**发版前运行 `npm run sync` 并提交生成的 skills、agents、Kimi MCP 清单和 `sources-lock.json`**。各客户端需使用上文各自的插件/package 更新命令。vendor skills 和 agents 是发版时提交的快照；`.mcp.json` 中的 `chrome-devtools-mcp@latest` 则在实际运行时解析 npm 最新版本，不受插件版本固定。

新增第三方资源：按 `.agents/skills/add-external-skill/SKILL.md` 编辑 `sources.json` 对应类型的数组，条目格式：

```json
{
  "skills": [
    {
      "repo": "https://github.com/user/repo.git",
      "path": "skills",
      "include": ["a"],
      "exclude": ["b"]
    }
  ],
  "agents": [],
  "prompts": []
}
```

- `path`：资源所在目录（默认按类型：`skills` / `agents` / `prompts`），skills 递归发现含 `SKILL.md` 的目录，agents/prompts 递归发现 `.md` 文件；同仓库多个资源目录可配置多条；skills 的特殊值 `"."` 表示整个仓库即一个 skill
- `include`：只拉取列出的资源名；省略则全量
- `exclude`：排除列出的资源名

同名资源冲突时后到者被跳过并告警。

### 新增 MCP server

只改 `.mcp.json`，然后运行 `node scripts/sync-mcp.js`（脚本会同步到 `kimi.plugin.json`）。Claude / Codex 直接读 `.mcp.json`，无需同步。发版前仍需按上文执行完整的 `npm run sync`。

> 注：Kimi 不读 `.mcp.json`，`mcpServers` 必须内联在 `kimi.plugin.json`，这就是同步脚本存在的原因。pi 不支持包级 MCP；本包的 `postinstall` 会通过 `scripts/setup-pi.js` 写入 pi 的全局配置，覆盖行为见安装说明。

### 版本号

使用以下命令统一更新四个清单的版本号：

```bash
npm run version -- <semver>
```

该命令会更新 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`kimi.plugin.json` 和 `package.json`。
