#!/usr/bin/env node
/**
 * 根据 sources.json 从第三方 git 仓库 vendor 资源（skills / agents / prompts / commands / plugins）到对应目录，带备份回退。
 *
 * sources.json 格式：{ "skills": [...], "agents": [...], "prompts": [...], "commands": [...], "plugins": [...] }，每类是条目数组：
 *   { repo, path?, include?, exclude?, capabilities? }
 *   - repo：git 仓库 URL
 *   - path：资源所在目录，省略时按类型取默认（与类型同名）；plugins 不支持（写进 capabilities 条目）
 *     skills 特殊值 "."：整个仓库即一个 skill（SKILL.md 在仓库根目录），skill 名取仓库名
 *   - include：只拉取列出的资源名；省略则全量；plugins 不支持（写进 capabilities 条目）
 *   - exclude：排除列出的资源名；plugins 不支持（同上）
 *   - capabilities（仅 plugins）：与顶层清单同构的字典（只是没有 plugins 键），键为能力名，值为条目数组
 *       { "skills": [{ "path": "custom-dir", "include": [...], "exclude": [...] }], "commands": true }
 *       - 键固定为 skills / agents / commands / prompts，写错会被跳过并告警
 *       - 条目字段 path / include / exclude 与顶层一致（path 相对仓库根，默认与能力同名；没有 repo 字段）
 *       - 同一能力可写多条条目，用于插件内资源散落在不同目录；跨条目的同名资源只取第一条
 *       - true / {} / []：按约定目录全量拆解
 *       - 省略整个 capabilities 表示拆解全部能力
 * 资源名：skill 为含 SKILL.md 的目录名；agents/prompts 为 .md 文件名（去后缀）；
 * commands 为 .md / .toml 文件名（去后缀，.toml 提取 description/prompt 转 .md）。
 * plugins 类型：第三方插件仓库，按约定目录自动拆解落地——
 *   skills/（含 SKILL.md 的目录）→ skills，agents/（.md）→ agents，commands/ → commands，prompts/（.md）→ prompts。
 *   hooks / mcp / extensions 涉及执行代码与环境配置，不做自动拆解。
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

/** 递归查找 dir 下所有命令文件（.md 与 .toml） */
function findCommandFiles(base) {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".toml")) {
        found.push(full);
      } else if (entry.name.endsWith(".md") && !MD_SKIP.has(entry.name.slice(0, -3).toLowerCase())) {
        found.push(full);
      }
    }
  })(base);
  return found;
}

/** 极简 TOML 解析：只提取 key = "..." / key = """...""" 的字符串值（命令文件只需 description / prompt） */
function parseTomlStrings(text) {
  const out = {};
  const re = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)")/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, key, multi, single] = m;
    if (multi !== undefined) {
      out[key] = multi;
    } else {
      try {
        out[key] = JSON.parse(`"${single}"`);
      } catch {
        out[key] = single;
      }
    }
  }
  return out;
}

/** .toml 命令（description + prompt）转成命令模板 .md */
function tomlCommandToMd(tomlText) {
  const fields = parseTomlStrings(tomlText);
  const fm = fields.description ? `---\ndescription: ${JSON.stringify(fields.description)}\n---\n\n` : "";
  return `${fm}${(fields.prompt || "").trim()}\n`;
}

/** 收集 dir 下的命令文件（.md 原样复制，.toml 转 markdown），通过 tryAdd 登记 */
function collectCommands(tryAdd, type, dir) {
  for (const f of findCommandFiles(dir)) {
    const name = path.basename(f).replace(/\.(md|toml)$/, "");
    const extra = f.endsWith(".toml") ? { content: tomlCommandToMd(fs.readFileSync(f, "utf8")) } : {};
    tryAdd(type, name, f, extra);
  }
}

// 插件能力：约定目录 → 落地资源类型。hooks / mcp / extensions 不自动拆解（安全与兼容性考虑）
const PLUGIN_CAPS = {
  skills: "skills",
  agents: "agents",
  commands: "commands",
  prompts: "prompts",
};

const CAP_KEYS = Object.keys(PLUGIN_CAPS);

/** 归一化 capabilities：省略 / 对象 → { 能力: 条目数组 }（与顶层清单同构，条目只含 path/include/exclude） */
function normalizeCaps(entry) {
  const raw = entry.capabilities;
  if (raw === undefined || raw === null) {
    return Object.fromEntries(CAP_KEYS.map((k) => [k, [{}]]));
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${entry.repo}: capabilities 必须是对象（{ "skills": [...], ... }），收到 ${Array.isArray(raw) ? "数组" : typeof raw}`);
  }
  const out = {};
  for (const [cap, value] of Object.entries(raw)) {
    // true / {}：全量默认目录；对象或数组：一条或多条条目
    const list = value === true || value === undefined || value === null
      ? [{}]
      : Array.isArray(value) ? (value.length ? value : [{}]) : [value];
    out[cap] = list.map((item) => {
      const spec = item === true || item === undefined || item === null ? {} : item;
      if (typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error(`${entry.repo}: capabilities.${cap} 的条目必须是对象（path / include / exclude）或 true`);
      }
      return spec;
    });
  }
  return out;
}

/** 按目标类型收集 dir 下的资源，通过 add 登记（skills 取目录，其余取 .md / .toml 文件） */
function collectByType(targetType, dir, add) {
  if (targetType === "skills") {
    for (const d of findSkillDirs(dir)) add("skills", path.basename(d), d);
  } else if (targetType === "commands") {
    collectCommands(add, "commands", dir);
  } else {
    for (const f of findMdFiles(dir)) add(targetType, path.basename(f, ".md"), f);
  }
}

/** 拆解第三方插件仓库：按 capabilities 声明的能力目录收集资源 */
function collectPlugin(entry, clonedDir, tryAdd) {
  if (entry.path || entry.include || entry.exclude) {
    console.error(`[sync-sources] ${entry.repo}: plugins 只支持 repo + capabilities；path / include / exclude 写到 capabilities.<能力> 的条目里（path 相对仓库根）`);
  }
  // 省略 capabilities 表示「有什么拆什么」，缺目录属正常；显式声明了才值得告警
  const explicit = entry.capabilities !== undefined && entry.capabilities !== null;
  let scanned = false;
  for (const [cap, specs] of Object.entries(normalizeCaps(entry))) {
    const target = PLUGIN_CAPS[cap];
    if (!target) {
      console.error(`[sync-sources] 跳过不支持的插件能力 ${cap}（${entry.repo}），仅支持: ${CAP_KEYS.join(" / ")}`);
      continue;
    }
    for (const spec of specs) {
      const dir = path.join(clonedDir, spec.path || cap);
      if (!fs.existsSync(dir)) {
        if (explicit) {
          console.error(`[sync-sources] ${entry.repo}: capabilities.${cap} 声明了 ${spec.path || cap}，但目录不存在`);
        }
        continue;
      }
      scanned = true;
      const filters = { include: spec.include, exclude: spec.exclude };
      collectByType(target, dir, (type, name, source, extra = {}) =>
        tryAdd(type, name, source, { ...extra, filters }));
    }
  }
  if (!scanned) {
    throw new Error(`${entry.repo}: 未找到任何声明的能力目录（${CAP_KEYS.join(" / ")}），无法作为插件拆解`);
  }
}

// 四类资源的发现与落地规则
const TYPES = {
  skills: { targetDir: "skills", defaultPath: "skills", isDir: true },
  agents: { targetDir: "agents", defaultPath: "agents", isDir: false },
  prompts: { targetDir: "prompts", defaultPath: "prompts", isDir: false },
  commands: { targetDir: "commands", defaultPath: "commands", isDir: false },
};

if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
  console.error("[sync-sources] sources.json 必须是对象，键为 skills / agents / prompts / commands / plugins");
  process.exit(1);
}
for (const key of Object.keys(manifest)) {
  if (!TYPES[key] && key !== "plugins") {
    console.error(`[sync-sources] 未知资源类型: ${key}（支持: ${Object.keys(TYPES).join(" / ")} / plugins）`);
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
const planned = []; // { type, name, source, repo, commit, content? }
try {
  for (const [type, entries] of Object.entries(manifest)) {
    for (const entry of entries) {
      const { clonedDir, commit } = checkout(entry.repo);

      const tryAdd = (type, name, source, extra = {}) => {
        const { filters = {}, ...rest } = extra;
        if (filters.include && !filters.include.includes(name)) return;
        if (filters.exclude && filters.exclude.includes(name)) return;
        if (planned.some((p) => p.type === type && p.name === name)) {
          console.error(`[sync-sources] 跳过重名 ${type}: ${name}（${entry.repo}）`);
          return;
        }
        planned.push({ type, name, source, repo: entry.repo, commit, ...rest });
      };

      if (type === "plugins") {
        collectPlugin(entry, clonedDir, tryAdd);
        continue;
      }

      const cfg = TYPES[type];
      const scanRoot = path.join(clonedDir, entry.path || cfg.defaultPath);

      if (!fs.existsSync(scanRoot)) {
        throw new Error(`${entry.repo}: 目录不存在 ${entry.path || cfg.defaultPath}`);
      }

      // skills 特殊值 "."：整个仓库即一个 skill（SKILL.md 在仓库根目录），skill 名取仓库名
      if (type === "skills" && entry.path === ".") {
        if (!fs.existsSync(path.join(clonedDir, "SKILL.md"))) {
          throw new Error(`${entry.repo}: path 为 "."，但仓库根目录没有 SKILL.md`);
        }
        tryAdd("skills", path.basename(clonedDir), clonedDir);
        continue;
      }

      const filters = { include: entry.include, exclude: entry.exclude };
      collectByType(type, scanRoot, (t, name, source, extra = {}) =>
        tryAdd(t, name, source, { ...extra, filters }));
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

// 备份将被覆盖的同名资源，失败时回退。先清空备份区，避免上次中断留下的残骸让 rename 失败
rmrf(backupDir);
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
    } else if (p.content !== undefined) {
      fs.writeFileSync(target, p.content);
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
