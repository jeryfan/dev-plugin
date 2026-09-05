---
name: add-external-skill
description: Add a third-party skill repo to dev-plugin's skills.json manifest and sync it into skills.
---

# Add External Skill

向本项目添加第三方 skill 的流程：编辑 `skills.json` 清单 → `npm run sync` → 验证结果。

## skills.json 配置规则

清单是数组，一条记录对应一个仓库的拉取任务：

```json
{ "repo": "https://github.com/user/repo.git", "path": "skills", "include": ["a"], "exclude": ["b"] }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `repo` | 是 | git 仓库 URL |
| `path` | 否 | skills 列表所在目录（其下每个含 `SKILL.md` 的子目录即一个 skill）。列表目录名不一定叫 `skills`；省略时默认根目录下的 `skills/`（标准布局） |
| `include` | 否 | 只拉取列出的 skill 目录名；省略则全量 |
| `exclude` | 否 | 排除列出的 skill 目录名，在 include 之后生效 |

规则要点：

1. 同一仓库有多个 skills 列表目录时，配置多条记录，各自设置 `path`
2. 添加前先确认上游仓库中 skills 的实际位置，设置准确的 `path`，不要依赖递归兜底
3. 与其他记录或个人 skill 同名的 skill 会被跳过并告警，发现告警需处理（换 include/exclude 或放弃）
4. 不要手工在 `skills/` 下创建 vendor skill 目录，一切通过清单 + 脚本完成

## 操作步骤

1. 在 `skills.json` 追加记录
2. 运行 `npm run sync`，确认目标 skill 出现在输出中且无报错/告警
3. 检查 `skills/<name>/SKILL.md` 存在且内容正确
4. 提醒用户：提交 `skills.json`、`skills/`、`skills-lock.json` 后发布
