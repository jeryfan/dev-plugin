---
name: add-custom-skill
description: Create a personal skill in dev-plugin's skills/ directory that is shared by Claude Code, Codex, Kimi and pi without touching any manifest.
---

# Add Custom Skill

在本仓库 `skills/` 下新增**自己维护的** skill。

## 与 vendor skill 的区别

| | 个人 skill | vendor skill |
|---|---|---|
| 创建方式 | 直接在 `skills/<name>/` 手写 | `sources.json` 清单 + `npm run sync` |
| 在 `sources-lock.json` 中 | 无记录 | 有记录（repo + commit） |
| `npm run sync` 的影响 | **不动** | 每次覆盖为上游最新版 |
| 能否手工编辑 | 能 | 不能（改了会被覆盖） |

## 命名规范

- 目录名 = skill 名：小写字母、数字、连字符，如 `my-workflow`
- `frontmatter.name` 必须与目录名一致
- **禁止与 vendor skill 同名**：重名时 `npm run sync` 会把 `skills/<name>` 备份到 `.cache/sources/` 后再写入上游版本，成功后删除备份——**你的版本会被静默覆盖且不可恢复**

## 操作步骤

1. **重名检查**（必做，跳过会有数据丢失风险）：

   ```bash
   cat sources-lock.json | grep '"<name>"'   # 有输出 = 撞 vendor 名，换名
   ls skills/                                # 检查现有 skill
   ```

2. 创建 `skills/<name>/SKILL.md`：

   ```markdown
   ---
   name: <name>
   description: 一句话说明这个 skill 做什么、什么时候该用。这是触发机制的主要依据，写清触发场景而不是只写功能名。
   ---

   # 标题

   正文：具体做法、步骤、约定。控制在 500 行以内，超了拆到 references/。
   ```

   - `name`、`description` 必填，其余字段省略
   - `description` 决定 skill 是否被调用，要写「用户会怎么描述这个需求」，不要只复述标题

3. 按需添加随附资源（可选，保持精简，别塞用不上的文件）：

   ```
   skills/<name>/
   ├── SKILL.md
   ├── scripts/     可执行的确定性逻辑
   ├── references/  需要时才读入上下文的文档
   └── assets/      输出用的模板、字体、图标
   ```

   在 SKILL.md 里明确写出「什么时候该读 references/ 下的哪个文件」。

4. **不需要改任何清单**——`skills/` 是四个工具共用的唯一分发目录，新建即被 Claude Code、Codex、Kimi、pi 同时发现。

5. 校验：

   - `name` 与目录名一致，且不在 `sources-lock.json` 中
   - SKILL.md 能被正常解析（frontmatter 用 `---` 包裹，无多余符号）
   - 跑一次 `npm run sync` 确认这个目录没出现在输出里（出现了说明撞名）

6. 提醒用户：提交 `skills/<name>/` 后发版
