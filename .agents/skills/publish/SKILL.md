---
name: publish
description: Release dev-plugin by bumping the version in all five manifests, then committing and pushing to GitHub. Defaults to +0.0.1 (patch); also accepts an explicit version. Use when the user asks to 发版、发布新版本、版本号加 0.0.1、bump/release/publish this plugin. Note this is a git release, NOT npm publish.
---

# Publish

dev-plugin 的发版：更新版本号 → 提交 → 推送。

- 默认行为：版本号 +0.0.1（如 `0.0.9` → `0.0.10`）
- 用户给了具体版本号时用指定值（如「发到 0.2.0」）

## 操作步骤

1. **前置检查（推荐，对应 AGENTS.md 的发版流程）**：

   ```bash
   npm run check
   npm run sync
   ```

   如果 sync 拉下了上游 vendor 变更，**先单独提交这些变更**（参照历史：`chore: 同步上游资源…`），不要和版本号混进同一个 commit。

2. 确定新版本号：

   ```bash
   node -p "require('./package.json').version"
   ```

   - 无指定版本：当前版本 patch 位 +1
   - 有指定版本：必须是合法 semver（`\d+\.\d+\.\d+`，可带 `-`/`+` 后缀），且**应高于当前版本**——脚本不校验大小关系，发低版本前要人工确认
   - `bump-version.js` **只接受显式 semver**，不接受 `patch` / `minor` 这类关键词

   ```bash
   npm run bump-version -- <X.Y.Z>
   ```

   确认输出中五份清单全部更新：`package.json`、`plugin.json`、`kimi.plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`。

3. 只提交这五份清单，commit message 沿用历史格式：

   ```bash
   git add package.json plugin.json kimi.plugin.json .claude-plugin/plugin.json .codex-plugin/plugin.json
   git commit -m "chore: 更新所有插件版本至 <X.Y.Z>"
   git push
   ```

   - 不要把无关的工作区改动带进这个 commit；有未提交改动时先向用户确认如何处理
   - 推送前确认当前分支是用户预期的分支（一般是 main/master），别推到别的分支上

4. 向用户报告新版本号与推送结果。
