#!/usr/bin/env node
/**
 * 按 sources.json 从第三方 git 仓库 vendor 资源到 skills / agents / prompts / commands，带备份回滚。
 *
 * 条目字段：repo（必填）、path（默认与类型同名；skills 可用 "." 表示整仓库一个 skill）、
 * include / exclude（按上游资源名过滤，支持 * ? glob）、alias（上游名 → 本地名，过滤仍按上游名）、
 * capabilities（仅 plugins）。plugins 按约定目录拆解 skills / agents / commands / prompts，
 * capabilities 可覆盖 path / 过滤 / alias；hooks / mcp / extensions 不拆解。
 * 资源名：skill 取含 SKILL.md 的目录名，其余取文件名去后缀（.toml 命令转成 .md）。
 *
 * 落地后把 SKILL.md frontmatter 的 name 改写为目录名（上游带前缀会让按 name 路由失效）。
 * 清单外目录（个人资源）不动；退出清单的按 sources-lock.json 移除；覆盖与移除都先移进
 * .cache/sources/，任一步失败整体回滚。--check 只比对上游 HEAD 与 lock 并打印，不写盘（恒 exit 0）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const backupDir = path.join(repoRoot, ".cache", "sources");
const reposDir = path.join(repoRoot, ".cache", "repos");
const lockFile = path.join(repoRoot, "sources-lock.json");

// 不作为资源的仓库说明类 md
const MD_SKIP = new Set(["readme", "changelog", "license", "licence", "contributing", "code_of_conduct", "security"]);

// 只有 skills 落地为目录，其余是单个 .md
const RESOURCE_TYPES = {
  skills: { isDir: true },
  agents: { isDir: false },
  prompts: { isDir: false },
  commands: { isDir: false },
};

function abort(message) {
  console.error(message);
  process.exit(1);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** 不经 shell 调 git，避免 URL 注入 */
function execGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** 递归遍历（跳过 . 开头与 node_modules）；onDir 返回 false 时剪枝 */
function walk(dir, { onDir, onFile }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!onDir || onDir(full) !== false) walk(full, { onDir, onFile });
    } else if (onFile) {
      onFile(full);
    }
  }
}

/** 找所有含 SKILL.md 的目录 */
function findSkillDirs(dir) {
  const found = [];
  walk(dir, {
    onDir: (sub) => {
      if (fs.existsSync(path.join(sub, "SKILL.md"))) {
        found.push(sub);
        return false;
      }
    },
  });
  return found;
}

/** 递归收集文件名满足 accept 的文件 */
function findFiles(dir, accept) {
  const found = [];
  walk(dir, {
    onFile: (file) => {
      if (accept(path.basename(file))) found.push(file);
    },
  });
  return found;
}

function isMdResource(name) {
  return name.endsWith(".md") && !MD_SKIP.has(name.slice(0, -3).toLowerCase());
}

function isCommandFile(name) {
  return name.endsWith(".toml") || isMdResource(name);
}

/** 极简 TOML：只取字符串值（命令文件只用 description / prompt） */
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

/** .toml 命令转成命令模板 .md */
function tomlCommandToMd(tomlText) {
  const fields = parseTomlStrings(tomlText);
  const fm = fields.description ? `---\ndescription: ${JSON.stringify(fields.description)}\n---\n\n` : "";
  return `${fm}${(fields.prompt || "").trim()}\n`;
}

// 缓存键用 host/owner/repo 三级，避免同名仓库互相覆盖
function repoKey(repo) {
  const clean = repo.replace(/\.git$/, "");
  // scp 形式归一化为 host/owner/repo，与 https 对齐
  const normalized = clean.replace(/^git@([^:]+):/, "$1/");
  return normalized.split("/").filter(Boolean).slice(-3).join("/");
}

function cloneRepo(repo, destDir) {
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  execGit(["clone", "--depth", "1", repo, destDir], repoRoot);
}

/** 确保缓存存在并更新到上游 HEAD，返回 { clonedDir, commit } */
function updateRepo(repo) {
  const key = repoKey(repo);
  const clonedDir = path.join(reposDir, key);
  // 旧缓存键是 owner/repo 两级：改名复用，避免重克隆
  if (!fs.existsSync(clonedDir)) {
    const legacyDir = path.join(reposDir, key.split("/").slice(-2).join("/"));
    if (legacyDir !== clonedDir && fs.existsSync(path.join(legacyDir, ".git"))) {
      fs.mkdirSync(path.dirname(clonedDir), { recursive: true });
      fs.renameSync(legacyDir, clonedDir);
      // 搬空后清掉旧 owner 目录（非空则忽略）
      try { fs.rmdirSync(path.dirname(legacyDir)); } catch { /* 其他仓库可能还在用 */ }
    }
  }
  if (fs.existsSync(path.join(clonedDir, ".git"))) {
    try {
      execGit(["fetch", "--depth", "1", "origin", "HEAD"], clonedDir);
      execGit(["reset", "--hard", "FETCH_HEAD"], clonedDir);
    } catch (err) {
      // 缓存损坏时降级为重新克隆，不整体失败
      console.warn(`[sync-sources] ${repo}: 更新缓存失败（${err.message}），改为重新克隆`);
      rmrf(clonedDir);
      cloneRepo(repo, clonedDir);
    }
  } else {
    rmrf(clonedDir);
    cloneRepo(repo, clonedDir);
  }
  const commit = execGit(["rev-parse", "--short", "HEAD"], clonedDir).trim();
  return { clonedDir, commit };
}

/** 同一 repo 只更新一次（cache 由本轮扫描传入） */
function updateRepoOnce(cache, repo) {
  if (!cache.has(repo)) cache.set(repo, updateRepo(repo));
  return cache.get(repo);
}

/** 精确名或 * ? glob 匹配，不区分大小写 */
function matchAny(patterns, name) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (typeof pattern !== "string") return false;
    if (!/[?*]/.test(pattern)) return pattern === name;
    const re = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i",
    );
    return re.test(name);
  });
}

/** 解析 alias 为改名器（无 alias 返回 null）；过滤按上游名，alias 只决定落地名 */
function parseAlias(raw, where, type) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: alias 必须是对象（{ "<上游名>": "<本地名>" }，如 { "unslop": "unslop-ui" }）`);
  }
  const map = new Map();
  for (const [from, value] of Object.entries(raw)) {
    const local = typeof value === "string" ? value.trim() : "";
    // 本地名会拼进路径，只接受单段
    if (!local || /[/\\\s\0]/.test(local) || local.startsWith(".")) {
      throw new Error(`${where}: alias["${from}"] = ${JSON.stringify(value)} 不是合法本地名（单段、不以 . 开头、不含路径分隔符/空白）`);
    }
    if (type !== "skills" && /\.(md|toml)$/i.test(local)) {
      throw new Error(`${where}: alias["${from}"] = "${local}" 不要带 .md / .toml 后缀（落地时按类型补）`);
    }
    map.set(from, local);
  }
  if (!map.size) return null;

  const used = new Set();
  return {
    resolve(name) {
      if (!map.has(name)) return name;
      used.add(name);
      return map.get(name);
    },
    // 未命中的键：拼错、上游改名或被过滤
    warnUnused() {
      for (const key of map.keys()) {
        if (!used.has(key)) console.warn(`[sync-sources] ${where}: alias "${key}" 未命中任何资源`);
      }
    },
  };
}

/** capabilities 归一化为 { 能力: [条目] }，条目字段同顶层 */
function normalizeCapabilities(entry) {
  const raw = entry.capabilities;
  if (raw === undefined || raw === null) {
    return Object.fromEntries(Object.keys(RESOURCE_TYPES).map((k) => [k, [{}]]));
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${entry.repo}: capabilities 必须是对象（{ "skills": [...], ... }），收到 ${Array.isArray(raw) ? "数组" : typeof raw}`);
  }
  const out = {};
  for (const [cap, value] of Object.entries(raw)) {
    // true / {} → 全量；对象或数组 → 一条或多条
    const list = value === true || value === undefined || value === null
      ? [{}]
      : Array.isArray(value) ? (value.length ? value : [{}]) : [value];
    out[cap] = list.map((item) => {
      const spec = item === true || item === undefined || item === null ? {} : item;
      if (typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error(`${entry.repo}: capabilities.${cap} 的条目必须是对象（path / include / exclude / alias）或 true`);
      }
      return spec;
    });
  }
  return out;
}

/** 按类型收集资源，交给 add(name, source, content?) */
function collectByType(type, dir, add) {
  if (type === "skills") {
    for (const d of findSkillDirs(dir)) add(path.basename(d), d);
  } else if (type === "commands") {
    for (const f of findFiles(dir, isCommandFile)) {
      const name = path.basename(f).replace(/\.(md|toml)$/, "");
      add(name, f, f.endsWith(".toml") ? tomlCommandToMd(fs.readFileSync(f, "utf8")) : undefined);
    }
  } else {
    for (const f of findFiles(dir, isMdResource)) add(path.basename(f, ".md"), f);
  }
}

/** 按 capabilities 拆解插件仓库 */
function collectPlugin(entry, clonedDir, addFor) {
  if (entry.path || entry.include || entry.exclude || entry.alias) {
    console.warn(`[sync-sources] ${entry.repo}: plugins 只支持 repo + capabilities；path / include / exclude / alias 写到 capabilities.<能力> 的条目里（path 相对仓库根）`);
  }
  // 省略 capabilities = 有什么拆什么，缺目录不告警
  const explicit = entry.capabilities !== undefined && entry.capabilities !== null;
  let scanned = false;
  for (const [cap, specs] of Object.entries(normalizeCapabilities(entry))) {
    if (!RESOURCE_TYPES[cap]) {
      console.warn(`[sync-sources] 跳过不支持的插件能力 ${cap}（${entry.repo}），仅支持: ${Object.keys(RESOURCE_TYPES).join(" / ")}`);
      continue;
    }
    for (const spec of specs) {
      const dir = path.join(clonedDir, spec.path || cap);
      if (!fs.existsSync(dir)) {
        if (explicit) {
          console.warn(`[sync-sources] ${entry.repo}: capabilities.${cap} 声明了 ${spec.path || cap}，但目录不存在`);
        }
        continue;
      }
      scanned = true;
      const alias = parseAlias(spec.alias, `${entry.repo} capabilities.${cap}`, cap);
      collectByType(cap, dir, addFor(cap, { include: spec.include, exclude: spec.exclude }, alias));
      alias?.warnUnused();
    }
  }
  if (!scanned) {
    throw new Error(`${entry.repo}: 未找到任何声明的能力目录（${Object.keys(RESOURCE_TYPES).join(" / ")}），无法作为插件拆解`);
  }
}

/** 把已落地 skill 的 frontmatter name 改写为目录名（上游带前缀会让按 name 路由失效） */
function alignSkillName(skillDir) {
  const file = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) return;
  const fmEnd = text.indexOf("\n---", 3);
  if (fmEnd === -1) return;
  const dir = path.basename(skillDir);
  const fm = text.slice(0, fmEnd);
  const m = fm.match(/^name:\s*"?([^"\n]+)"?\s*$/m);
  if (!m || m[1].trim() === dir) return;
  fs.writeFileSync(file, fm.replace(/^name:.*$/m, `name: ${dir}`) + text.slice(fmEnd));
  console.log(`[sync-sources] 归一化 name: ${m[1].trim()} → ${dir}`);
}

/** 落盘名：目录类原名，文件类补 .md */
function outputName(type, name) {
  return name + (RESOURCE_TYPES[type]?.isDir ? "" : ".md");
}

function outputPath({ type, name }) {
  return path.join(repoRoot, type, outputName(type, name));
}

function backupPath({ type, name }) {
  return path.join(backupDir, type, outputName(type, name));
}

/** 去重与"已移除"比对共用的键，大小写不敏感 */
function resourceKey(type, name) {
  return `${type}:${name}`.toLowerCase();
}

function readLock() {
  return fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : {};
}

/** 存在就 rename 进备份区并登记；覆盖与移除都走这里 */
function moveToBackup(item, backedUp) {
  const target = outputPath(item);
  if (!fs.existsSync(target)) return false;
  const backup = backupPath(item);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.renameSync(target, backup);
  backedUp.push(item);
  return true;
}

/** 登记一条资源：过滤按上游名，alias 只决定落地名，去重 key 用落地名 */
function registerResource(plan, { filters = {}, alias = null, ...resource }) {
  const { type, name } = resource;
  if (filters.include && !matchAny(filters.include, name)) return;
  if (filters.exclude && matchAny(filters.exclude, name)) return;
  const local = alias ? alias.resolve(name) : name;
  const key = resourceKey(type, local);
  const origin = `${resource.repo}${local === name ? "" : ` 的 ${name}`}`;
  if (plan.index.has(key)) {
    console.warn(`[sync-sources] 跳过重名 ${type}: ${local}（${origin}），已被 ${plan.index.get(key)} 占用`);
    return;
  }
  plan.index.set(key, origin);
  plan.resources.push({ ...resource, name: local, upstream: local === name ? undefined : name });
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "sources.json"), "utf8"));
}

function validateManifest(manifest) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    abort("[sync-sources] sources.json 必须是对象，键为 skills / agents / prompts / commands / plugins");
  }
  for (const key of Object.keys(manifest)) {
    if (!RESOURCE_TYPES[key] && key !== "plugins") {
      abort(`[sync-sources] 未知资源类型: ${key}（支持: ${Object.keys(RESOURCE_TYPES).join(" / ")} / plugins）`);
    }
  }
}

/** 比对上游 commit 与 lock 并打印，不写盘 */
function checkUpstream(manifest) {
  const repos = new Set();
  for (const entries of Object.values(manifest)) {
    if (Array.isArray(entries)) {
      for (const e of entries) if (e && typeof e.repo === "string") repos.add(e.repo);
    }
  }
  const heads = new Map();
  for (const repo of repos) {
    try {
      heads.set(repo, execGit(["ls-remote", repo, "HEAD"], repoRoot).split(/\s+/)[0].slice(0, 7));
    } catch (err) {
      console.warn(`[sync-sources] ${repo}: ls-remote 失败（${err.message}）`);
    }
  }
  const oldLock = readLock();
  let stale = 0;
  for (const [type, locked] of Object.entries(oldLock)) {
    for (const [name, meta] of Object.entries(locked)) {
      const head = heads.get(meta.repo);
      const onDisk = fs.existsSync(outputPath({ type, name }));
      if (head && head !== meta.commit) {
        stale++;
        console.log(`[check] 过期 ${type}/${name}: locked=${meta.commit} upstream=${head}（${meta.repo}）`);
      }
      if (!onDisk) console.log(`[check] 未落盘 ${type}/${name}`);
    }
  }
  console.log(`[check] 完成：${stale} 个上游有更新`);
}

/** 扫描清单返回 { resources, index }；抛错时还没动资源目录 */
function buildPlan(manifest) {
  const plan = { resources: [], index: new Map() };
  const cache = new Map();
  for (const [type, entries] of Object.entries(manifest)) {
    if (!Array.isArray(entries)) {
      throw new Error(`sources.json: ${type} 必须是条目数组`);
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.repo !== "string" || !entry.repo) {
        throw new Error(`sources.json: ${type} 的每个条目都必须包含 repo 字段（git 仓库 URL）`);
      }
      const { clonedDir, commit } = updateRepoOnce(cache, entry.repo);
      const addFor = (resourceType, filters = {}, alias = null) => (name, source, content) => {
        registerResource(plan, { type: resourceType, name, source, content, repo: entry.repo, commit, filters, alias });
      };

      if (type === "plugins") {
        collectPlugin(entry, clonedDir, addFor);
        continue;
      }

      const scanRoot = path.join(clonedDir, entry.path || type);
      if (!fs.existsSync(scanRoot)) {
        throw new Error(`${entry.repo}: 目录不存在 ${entry.path || type}`);
      }

      const alias = parseAlias(entry.alias, `${type}@${entry.repo}`, type);

      // skills 的 "."：整个仓库即一个 skill，上游名取仓库目录名
      if (type === "skills" && entry.path === ".") {
        if (!fs.existsSync(path.join(clonedDir, "SKILL.md"))) {
          throw new Error(`${entry.repo}: path 为 "."，但仓库根目录没有 SKILL.md`);
        }
        addFor(type, {}, alias)(path.basename(clonedDir), clonedDir);
        alias?.warnUnused();
        continue;
      }

      collectByType(type, scanRoot, addFor(type, { include: entry.include, exclude: entry.exclude }, alias));
      alias?.warnUnused();
    }
  }
  return plan;
}

// 目标存在却不在 lock 里 = 同名个人资源：直接中止（备份区成功后清空，等于静默删掉它）
function assertNoPersonalConflict(plan, oldLock) {
  const foreign = plan.resources.filter((item) => !oldLock[item.type]?.[item.name] && fs.existsSync(outputPath(item)));
  if (!foreign.length) return;
  for (const item of foreign) {
    console.error(`[sync-sources] ${item.type}/${item.name} 已存在且不在 lock 中（个人资源），会被 ${item.repo} 覆盖${item.upstream ? `（上游 ${item.upstream}）` : ""}`);
  }
  abort("[sync-sources] 已中止，磁盘未改动：给对应条目加 alias 换个本地名，或先移除该资源");
}

/** lock 里有、这次计划里没有的资源 */
function findRemoved(plan, oldLock) {
  return Object.entries(oldLock).flatMap(([type, locked]) =>
    RESOURCE_TYPES[type]
      ? Object.keys(locked)
          .filter((name) => !plan.index.has(resourceKey(type, name)))
          .map((name) => ({ type, name }))
      : [],
  );
}

function writeResources(plan, removed) {
  // 备份区同时暂存"将被覆盖"与"已退出清单"的资源；先备份再移除，失败才能整体回滚
  const backedUp = [];
  // 只回滚已开始复制的项；未移入备份区的旧版本不能动
  const copied = [];
  try {
    for (const item of removed) {
      if (moveToBackup(item, backedUp)) console.log(`[sync-sources] 移除已退出清单的 ${item.type}: ${item.name}`);
    }

    for (const item of plan.resources) moveToBackup(item, backedUp);

    for (const item of plan.resources) {
      copied.push(item); // 先登记再复制：失败时可能有残留，需清理（原件已在备份区）
      const target = outputPath(item);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (RESOURCE_TYPES[item.type].isDir) {
        // 排除 .git（path 为 "." 时 source 是仓库根）
        fs.cpSync(item.source, target, {
          recursive: true,
          filter: (src) => !src.split(path.sep).includes(".git"),
        });
        alignSkillName(target);
      } else if (item.content !== undefined) {
        fs.writeFileSync(target, item.content);
      } else {
        fs.copyFileSync(item.source, target);
      }
      const label = item.upstream ? `${item.upstream} → ${item.name}（alias）` : item.name;
      console.log(`[sync-sources] ${label} @ ${item.commit} → ${item.type}/${item.name}`);
    }
  } catch (err) {
    for (const item of copied) rmrf(outputPath(item));
    for (const item of backedUp) {
      const backup = backupPath(item);
      const target = outputPath(item);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(backup, target);
    }
    rmrf(backupDir);
    console.error("[sync-sources] 同步失败，已回退");
    throw err;
  }
}

function writeLock(plan) {
  const lock = {};
  // lock 记本地名，alias 改名时额外记 upstream 便于反查
  for (const item of plan.resources) {
    lock[item.type] ||= {};
    lock[item.type][item.name] = { repo: item.repo, commit: item.commit, ...(item.upstream ? { upstream: item.upstream } : {}) };
  }
  // 原子写：先写 .tmp 再 rename，避免截断的 lock 让移除判断出错
  fs.writeFileSync(`${lockFile}.tmp`, `${JSON.stringify(lock, null, 2)}\n`);
  fs.renameSync(`${lockFile}.tmp`, lockFile);
  const counts = Object.entries(lock).map(([t, m]) => `${t}: ${Object.keys(m).length}`).join(", ");
  console.log(`[sync-sources] 完成，共 ${plan.resources.length} 个资源（${counts}）`);
}

function main() {
  const manifest = loadManifest();
  validateManifest(manifest);
  if (process.argv.includes("--check")) {
    checkUpstream(manifest);
    return;
  }

  const plan = buildPlan(manifest);
  if (plan.resources.length === 0) abort("[sync-sources] 清单未匹配到任何资源");

  // 先清空备份区，避免上次中断的残骸让 rename 失败
  rmrf(backupDir);
  const oldLock = readLock();
  assertNoPersonalConflict(plan, oldLock);
  writeResources(plan, findRemoved(plan, oldLock));
  writeLock(plan);
  // 成功后才清备份区（失败由回滚分支清理）
  rmrf(backupDir);
}

main();
