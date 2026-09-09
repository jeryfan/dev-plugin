---
name: add-external-skill
description: Add a third-party skill/agent/prompt/command repo or a whole plugin repo to dev-plugin's sources.json manifest and sync it into the repo.
---

# Add External Skill

向本项目添加第三方资源（skills / agents / prompts / commands / plugins）的流程：编辑 `sources.json` 清单 → `npm run sync` → 验证结果。

## sources.json 配置规则

清单是按资源类型分组的对象，每组是一条条仓库拉取记录：

```json
{
  "skills": [{ "repo": "https://github.com/user/repo.git", "path": "skills", "include": ["a"], "exclude": ["b"] }],
  "agents": [],
  "prompts": [],
  "commands": [],
  "plugins": [
    {
      "repo": "https://github.com/user/some-plugin.git",
      "capabilities": {
        "skills": [{ "path": "skills", "include": ["a"] }, { "path": "legacy/skills" }],
        "commands": true
      }
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `repo` | 是 | git 仓库 URL |
| `path` | 否 | 资源所在目录。skills 下每个含 `SKILL.md` 的子目录即一个 skill，agents/prompts 下每个 `.md` 文件即一个资源，commands 下每个 `.md` / `.toml` 文件即一个命令；省略时按类型取同名默认目录。**plugins 条目不支持**，写到 `capabilities` 的条目里（相对仓库根）。skills 的特殊值 `"."`：整个仓库即一个 skill（`SKILL.md` 在仓库根目录），skill 名取仓库名 |
| `include` | 否 | 只拉取列出的资源名；省略则全量。**plugins 条目不支持**，写到 `capabilities` 的条目里 |
| `exclude` | 否 | 排除列出的资源名，在 include 之后生效。同上，plugins 条目不支持 |
| `capabilities` | 否（仅 plugins） | 与顶层清单同构的字典（只是没有 `plugins` 键），见下节 |

## plugins 类型（整个插件仓库）

第三方插件 = 一组资源的容器，按**约定目录**自动拆解后复用现有管线：

| 插件内目录 | 落地为 | 说明 |
|---|---|---|
| `skills/` | `skills/` | 每个含 `SKILL.md` 的子目录即一个 skill |
| `agents/` | `agents/` | 每个 `.md` 文件 |
| `commands/` | `commands/` | `.md` 原样复制；`.toml` 提取 `description` + `prompt` 转成带 frontmatter 的 `.md` |
| `prompts/` | `prompts/` | 每个 `.md` 文件 |

### capabilities 字段

`capabilities` 是**与顶层清单同构的字典**：键是能力名，值是条目数组，条目字段与顶层一致（`path` / `include` / `exclude`），只是**没有 `repo`**（repo 在 plugin 条目层）：

```json
"capabilities": {
  "skills":   [{ "path": "skills", "include": ["a"] }, { "path": "legacy/skills" }],
  "commands": [{ "exclude": ["b"] }],
  "agents":   true
}
```

| 写法 | 含义 |
|---|---|
| 省略整个 `capabilities` | 拆解全部能力，缺哪个目录就跳过（不告警） |
| `"commands": true` / `{}` / `[]` | 按约定目录（与能力同名，相对仓库根）全量拆解 |
| `"skills": [{ "path": "legacy/skills" }]` | 覆盖约定目录名，相对仓库根（插件在 monorepo 子目录时也用它，如 `"plugins/foo/skills"`） |
| `"skills": [{...}, {...}]` | 同一能力多条条目，用于资源散落在多个目录；跨条目同名只取第一条 |

规则：

1. 键固定为 `skills` / `agents` / `commands` / `prompts`；写错（`skill`、`mcp`）只告警并跳过，不会静默丢失其它能力
2. 显式声明的能力目录不存在时会告警；省略 `capabilities` 时不告警
3. hooks / mcp / extensions **不做自动拆解**（涉及自动执行代码与环境配置，有安全风险）；上游含这些能力时忽略，需要 MCP 时手工评估后加进 `.mcp.json`
4. 插件必须至少命中一个能力目录，否则同步报错
5. 拆解后的资源与 skills / agents / prompts / commands 类型的记录共享命名空间，重名会被跳过并告警

## commands 类型（斜杠命令）

落地到顶层 `commands/`，各工具接线方式不同，**新增目录后无需改清单**（已配好）：

| 工具 | 读取方式 |
|---|---|
| Claude Code | 自动发现插件根的 `commands/` |
| Kimi Code | `kimi.plugin.json` 的 `"commands": "./commands/"` |
| pi | `package.json` 的 `pi.prompts` 包含 `./commands` |
| Codex CLI | 插件规范不支持 commands，不分发 |

命令文件格式：带 YAML frontmatter（`description`、可选 `argument-hint` 等）的 markdown，正文为提示词，参数占位符用 `{{args}}`。

规则要点：

1. 同一仓库有多个资源目录时，配置多条记录，各自设置 `path`
2. 添加前先确认上游仓库中资源的实际位置，设置准确的 `path`，不要依赖递归兜底
3. 与其他记录或个人资源同名的资源会被跳过并告警，发现告警需处理（换 include/exclude 或放弃）
4. 不要手工在 `skills/`、`agents/`、`prompts/`、`commands/` 下创建 vendor 资源，一切通过清单 + 脚本完成

## 操作步骤

1. 在 `sources.json` 对应类型的数组中追加记录
2. 运行 `npm run sync`，确认目标资源出现在输出中且无报错/告警
3. 检查 `skills/<name>/SKILL.md`（或 `agents/`、`prompts/`、`commands/` 下的 .md 文件）存在且内容正确
4. 提醒用户：提交 `sources.json`、资源目录、`sources-lock.json` 后发布
