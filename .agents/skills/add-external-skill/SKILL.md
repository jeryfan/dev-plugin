---
name: add-external-skill
description: Add a third-party skill/agent/prompt repo to dev-plugin's sources.json manifest and sync it into the repo.
---

# Add External Skill

向本项目添加第三方资源（skills / agents / prompts）的流程：编辑 `sources.json` 清单 → `npm run sync` → 验证结果。

## sources.json 配置规则

清单是按资源类型分组的对象，每组是一条条仓库拉取记录：

```json
{
  "skills": [{ "repo": "https://github.com/user/repo.git", "path": "skills", "include": ["a"], "exclude": ["b"] }],
  "agents": [],
  "prompts": []
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `repo` | 是 | git 仓库 URL |
| `path` | 否 | 资源所在目录。skills 下每个含 `SKILL.md` 的子目录即一个 skill，agents/prompts 下每个 `.md` 文件即一个资源；省略时按类型默认 `skills` / `agents` / `prompts`。skills 的特殊值 `"."`：整个仓库即一个 skill（`SKILL.md` 在仓库根目录），skill 名取仓库名 |
| `include` | 否 | 只拉取列出的资源名；省略则全量 |
| `exclude` | 否 | 排除列出的资源名，在 include 之后生效 |

规则要点：

1. 同一仓库有多个资源目录时，配置多条记录，各自设置 `path`
2. 添加前先确认上游仓库中资源的实际位置，设置准确的 `path`，不要依赖递归兜底
3. 与其他记录或个人资源同名的资源会被跳过并告警，发现告警需处理（换 include/exclude 或放弃）
4. 不要手工在 `skills/`、`agents/`、`prompts/` 下创建 vendor 资源，一切通过清单 + 脚本完成

## 操作步骤

1. 在 `sources.json` 对应类型的数组中追加记录
2. 运行 `npm run sync`，确认目标资源出现在输出中且无报错/告警
3. 检查 `skills/<name>/SKILL.md`（或 `agents/`、`prompts/` 下的 .md 文件）存在且内容正确
4. 提醒用户：提交 `sources.json`、资源目录、`sources-lock.json` 后发布
