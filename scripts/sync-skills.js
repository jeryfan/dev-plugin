#!/usr/bin/env node
/**
 * 根据 skills.json 从第三方 git 仓库 vendor skill 到 skills/，带备份回退。
 * 清单格式：{ repo, path?, include?, exclude? }
 *   - path：skills 列表所在目录（默认根目录下的 skills），递归发现含 SKILL.md 的子目录；同仓库多个 skills 目录可配置多条
 *     特殊值 "."：整个仓库即一个 skill（SKILL.md 在仓库根目录），skill 名取仓库名
 *   - include：只拉取列出的 skill 目录名；省略则全量
 *   - exclude：排除列出的 skill 目录名
 * 清单之外的 skills/ 目录不改动。
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "skills.json"), "utf8"));
const backupDir = path.join(root, ".cache", "skills");
const reposDir = path.join(root, ".cache", "repos");
const skillsDir = path.join(root, "skills");
const lockFile = path.join(root, "skills-lock.json");

if (!Array.isArray(manifest)) {
  console.error("[sync-skills] skills.json 必须是数组");
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(reposDir, { recursive: true });

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
// 用 owner/repo 两级目录做缓存路径，避免不同 owner 的同名仓库（如 anthropics/skills 与 mattpocock/skills）冲突
const repoKey = (repo) =>
  repo.replace(/\.git$/, "").split("/").slice(-2).join("/");

/** 递归查找 dir 下所有含 SKILL.md 的目录 */
function findSkillDirs(base) {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, "SKILL.md"))) {
        found.push(full);
      } else {
        walk(full);
      }
    }
  })(base);
  return found;
}

// 克隆/更新清单仓库，解析出本次要同步的 skill 列表
const planned = []; // { name, source, repo, commit }
try {
  for (const entry of manifest) {
    const clonedDir = path.join(reposDir, repoKey(entry.repo));
    if (fs.existsSync(path.join(clonedDir, ".git"))) {
      execSync("git fetch --depth 1 origin HEAD && git reset --hard FETCH_HEAD", {
        cwd: clonedDir,
        stdio: "pipe",
      });
    } else {
      rmrf(clonedDir);
      fs.mkdirSync(path.dirname(clonedDir), { recursive: true });
      execSync(`git clone --depth 1 ${entry.repo} "${clonedDir}"`, { stdio: "pipe" });
    }

    const commit = execSync("git rev-parse --short HEAD", { cwd: clonedDir, encoding: "utf8" }).trim();
    const scanRoot = path.join(clonedDir, entry.path || "skills");

    if (!fs.existsSync(scanRoot)) {
      throw new Error(`${entry.repo}: 目录不存在 ${entry.path || "skills"}`);
    }

    // path 为 "." 时整个仓库即一个 skill（SKILL.md 在仓库根目录），skill 名取仓库名
    if (entry.path === ".") {
      if (!fs.existsSync(path.join(clonedDir, "SKILL.md"))) {
        throw new Error(`${entry.repo}: path 为 "."，但仓库根目录没有 SKILL.md`);
      }
      const name = path.basename(clonedDir);
      if (planned.some((p) => p.name === name)) {
        console.error(`[sync-skills] 跳过重名 skill: ${name}（${entry.repo}）`);
        continue;
      }
      planned.push({ name, source: clonedDir, repo: entry.repo, commit });
      continue;
    }

    for (const skillPath of findSkillDirs(scanRoot)) {
      const name = path.basename(skillPath);
      if (entry.include && !entry.include.includes(name)) continue;
      if (entry.exclude && entry.exclude.includes(name)) continue;
      if (planned.some((p) => p.name === name)) {
        console.error(`[sync-skills] 跳过重名 skill: ${name}（${entry.repo}）`);
        continue;
      }
      planned.push({ name, source: skillPath, repo: entry.repo, commit });
    }
  }
} catch (err) {
  console.error(`[sync-skills] 克隆失败: ${err.message}`);
  process.exit(1);
}

if (planned.length === 0) {
  console.error("[sync-skills] 清单未匹配到任何 skill");
  process.exit(1);
}

// 上次 vendor 但本次清单不再包含的 skill，从 skills/ 移除
const oldLock = fs.existsSync(lockFile)
  ? JSON.parse(fs.readFileSync(lockFile, "utf8"))
  : {};
for (const name of Object.keys(oldLock)) {
  if (planned.some((p) => p.name === name)) continue;
  if (fs.existsSync(path.join(skillsDir, name))) {
    rmrf(path.join(skillsDir, name));
    console.log(`[sync-skills] 移除已退出清单的 skill: ${name}`);
  }
}

// 备份将被覆盖的同名 skill，失败时回退
const backedUp = [];
for (const p of planned) {
  const target = path.join(skillsDir, p.name);
  if (fs.existsSync(target)) {
    fs.renameSync(target, path.join(backupDir, p.name));
    backedUp.push(p.name);
  }
}

try {
  for (const p of planned) {
    // filter 排除 .git（path 指向仓库根时 source 含 .git）
    fs.cpSync(p.source, path.join(skillsDir, p.name), {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes(".git"),
    });
    console.log(`[sync-skills] ${p.name} @ ${p.commit} → skills/${p.name}`);
  }
} catch (err) {
  for (const p of planned) rmrf(path.join(skillsDir, p.name));
  for (const name of backedUp) fs.renameSync(path.join(backupDir, name), path.join(skillsDir, name));
  console.error(`[sync-skills] 同步失败，已回退: ${err.message}`);
  process.exit(1);
}

rmrf(backupDir);
const lock = {};
for (const p of planned) lock[p.name] = { repo: p.repo, commit: p.commit };
fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`[sync-skills] 完成，共 ${planned.length} 个 skill`);
