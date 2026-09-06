#!/usr/bin/env node
/**
 * 根据 sources.json 从第三方 git 仓库 vendor 资源（skills / agents / prompts）到对应目录，带备份回退。
 *
 * sources.json 格式：{ "skills": [...], "agents": [...], "prompts": [...] }，每类是条目数组：
 *   { repo, path?, include?, exclude? }
 *   - repo：git 仓库 URL
 *   - path：资源所在目录，省略时按类型取默认（skills → skills，agents → agents，prompts → prompts）
 *     skills 特殊值 "."：整个仓库即一个 skill（SKILL.md 在仓库根目录），skill 名取仓库名
 *   - include：只拉取列出的资源名；省略则全量
 *   - exclude：排除列出的资源名
 * 资源名：skill 为含 SKILL.md 的目录名；agents/prompts 为 .md 文件名（去后缀）。
 * 清单之外的目录（个人资源）不动；上次 vendor 但本次清单不再包含的会被自动移除（依据 sources-lock.json）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "sources.json"), "utf8"));
const backupDir = path.join(root, ".cache", "sources");
const reposDir = path.join(root, ".cache", "repos");
const lockFile = path.join(root, "sources-lock.json");

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

// md 发现时跳过的仓库说明类文件
const MD_SKIP = new Set(["readme", "changelog", "license", "licence", "contributing", "code_of_conduct", "security"]);

/** 递归查找 dir 下所有 .md 文件 */
function findMdFiles(base) {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md") && !MD_SKIP.has(entry.name.slice(0, -3).toLowerCase())) {
        found.push(full);
      }
    }
  })(base);
  return found;
}

// 三类资源的发现与落地规则
const TYPES = {
  skills: { targetDir: "skills", defaultPath: "skills", isDir: true },
  agents: { targetDir: "agents", defaultPath: "agents", isDir: false },
  prompts: { targetDir: "prompts", defaultPath: "prompts", isDir: false },
};

if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
  console.error("[sync-sources] sources.json 必须是对象，键为 skills / agents / prompts");
  process.exit(1);
}
for (const key of Object.keys(manifest)) {
  if (!TYPES[key]) {
    console.error(`[sync-sources] 未知资源类型: ${key}（支持: ${Object.keys(TYPES).join(" / ")}）`);
    process.exit(1);
  }
}

fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(reposDir, { recursive: true });

/** 克隆/更新仓库，返回 { clonedDir, commit } */
function checkout(repo) {
  const clonedDir = path.join(reposDir, repoKey(repo));
  if (fs.existsSync(path.join(clonedDir, ".git"))) {
    execSync("git fetch --depth 1 origin HEAD && git reset --hard FETCH_HEAD", {
      cwd: clonedDir,
      stdio: "pipe",
    });
  } else {
    rmrf(clonedDir);
    fs.mkdirSync(path.dirname(clonedDir), { recursive: true });
    execSync(`git clone --depth 1 ${repo} "${clonedDir}"`, { stdio: "pipe" });
  }
  const commit = execSync("git rev-parse --short HEAD", { cwd: clonedDir, encoding: "utf8" }).trim();
  return { clonedDir, commit };
}

// 解析出本次要同步的资源列表
const planned = []; // { type, name, source, repo, commit }
try {
  for (const [type, entries] of Object.entries(manifest)) {
    const cfg = TYPES[type];
    for (const entry of entries) {
      const { clonedDir, commit } = checkout(entry.repo);
      const scanRoot = path.join(clonedDir, entry.path || cfg.defaultPath);

      if (!fs.existsSync(scanRoot)) {
        throw new Error(`${entry.repo}: 目录不存在 ${entry.path || cfg.defaultPath}`);
      }

      const tryAdd = (name, source) => {
        if (entry.include && !entry.include.includes(name)) return;
        if (entry.exclude && entry.exclude.includes(name)) return;
        if (planned.some((p) => p.type === type && p.name === name)) {
          console.error(`[sync-sources] 跳过重名 ${type}: ${name}（${entry.repo}）`);
          return;
        }
        planned.push({ type, name, source, repo: entry.repo, commit });
      };

      // skills 特殊值 "."：整个仓库即一个 skill（SKILL.md 在仓库根目录），skill 名取仓库名
      if (type === "skills" && entry.path === ".") {
        if (!fs.existsSync(path.join(clonedDir, "SKILL.md"))) {
          throw new Error(`${entry.repo}: path 为 "."，但仓库根目录没有 SKILL.md`);
        }
        tryAdd(path.basename(clonedDir), clonedDir);
        continue;
      }

      if (cfg.isDir) {
        for (const dir of findSkillDirs(scanRoot)) tryAdd(path.basename(dir), dir);
      } else {
        for (const file of findMdFiles(scanRoot)) tryAdd(path.basename(file, ".md"), file);
      }
    }
  }
} catch (err) {
  console.error(`[sync-sources] 克隆失败: ${err.message}`);
  process.exit(1);
}

if (planned.length === 0) {
  console.error("[sync-sources] 清单未匹配到任何资源");
  process.exit(1);
}

const targetPath = (p) => path.join(root, TYPES[p.type].targetDir, p.name + (TYPES[p.type].isDir ? "" : ".md"));

// 上次 vendor 但本次清单不再包含的资源，从目标目录移除
const oldLock = fs.existsSync(lockFile)
  ? JSON.parse(fs.readFileSync(lockFile, "utf8"))
  : {};
for (const [type, locked] of Object.entries(oldLock)) {
  if (!TYPES[type]) continue;
  for (const name of Object.keys(locked)) {
    const p = { type, name };
    if (planned.some((x) => x.type === type && x.name === name)) continue;
    if (fs.existsSync(targetPath(p))) {
      rmrf(targetPath(p));
      console.log(`[sync-sources] 移除已退出清单的 ${type}: ${name}`);
    }
  }
}

// 备份将被覆盖的同名资源，失败时回退
const backedUp = [];
for (const p of planned) {
  const target = targetPath(p);
  if (fs.existsSync(target)) {
    const backup = path.join(backupDir, p.type, p.name + (TYPES[p.type].isDir ? "" : ".md"));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(target, backup);
    backedUp.push(p);
  }
}

try {
  for (const p of planned) {
    const target = targetPath(p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (TYPES[p.type].isDir) {
      // filter 排除 .git（path 指向仓库根时 source 含 .git）
      fs.cpSync(p.source, target, {
        recursive: true,
        filter: (src) => !src.split(path.sep).includes(".git"),
      });
    } else {
      fs.copyFileSync(p.source, target);
    }
    console.log(`[sync-sources] ${p.name} @ ${p.commit} → ${TYPES[p.type].targetDir}/${p.name}`);
  }
} catch (err) {
  for (const p of planned) rmrf(targetPath(p));
  for (const p of backedUp) {
    const backup = path.join(backupDir, p.type, p.name + (TYPES[p.type].isDir ? "" : ".md"));
    fs.renameSync(backup, targetPath(p));
  }
  console.error(`[sync-sources] 同步失败，已回退: ${err.message}`);
  process.exit(1);
}

rmrf(backupDir);
const lock = {};
for (const p of planned) {
  lock[p.type] ||= {};
  lock[p.type][p.name] = { repo: p.repo, commit: p.commit };
}
fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
const counts = Object.entries(lock).map(([t, m]) => `${t}: ${Object.keys(m).length}`).join(", ");
console.log(`[sync-sources] 完成，共 ${planned.length} 个资源（${counts}）`);
