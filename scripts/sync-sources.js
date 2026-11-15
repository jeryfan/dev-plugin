#!/usr/bin/env node
/**
 * 根据 sources.json 从第三方 git 仓库 vendor 资源（skills / agents / prompts / commands / plugins）到对应目录，带备份回退。
 *
 * sources.json 格式：{ "skills": [...], "agents": [...], "prompts": [...], "commands": [...], "plugins": [...] }，每类是条目数组：
 *   { repo, path?, include?, exclude?, alias?, capabilities? }
 *   - repo：git 仓库 URL
 *   - path：资源所在目录，省略时按类型取默认（与类型同名）；plugins 不支持（写进 capabilities 条目）
 *     skills 特殊值 "."：整个仓库即一个 skill（SKILL.md 在仓库根目录），skill 名取仓库名
 *   - include：只拉取列出的资源名；省略则全量；plugins 不支持（写进 capabilities 条目）；支持 * / ? glob（如 "principle-*"）
 *   - exclude：排除列出的资源名；plugins 不支持（同上）；同样支持 glob
 *   - alias：上游名 → 本地名，用于与已有资源同名时共存（如 { "unslop": "unslop-ui" }）；
 *     plugins 不支持（写进 capabilities 条目）。过滤按上游名，落地目录、frontmatter name、lock 键用本地名
 *
 * 落地归一化：skill 目录复制进 skills/ 后，自动把 SKILL.md frontmatter 的 name 改写为目录名
 * （部分上游的 name 带前缀，与目录不一致会让按 name 路由的工具找不到或重复注册；alias 改名后同样归一化为本地名）。
 *
 * --check：只核对上游 HEAD 与 sources-lock.json 是否一致并打印报告，不克隆、不写盘（恒 exit 0）。
 *   - capabilities（仅 plugins）：与顶层清单同构的字典（只是没有 plugins 键），键为能力名，值为条目数组
 *       { "skills": [{ "path": "custom-dir", "include": [...], "exclude": [...] }], "commands": true }
 *       - 键固定为 skills / agents / commands / prompts，写错会被跳过并告警
 *       - 条目字段 path / include / exclude / alias 与顶层一致（path 相对仓库根，默认与能力同名；没有 repo 字段）
 *       - 同一能力可写多条条目，用于插件内资源散落在不同目录；跨条目的同名资源只取第一条
 *       - true / {} / []：按约定目录全量拆解
 *       - 省略整个 capabilities 表示拆解全部能力
 * 资源名：skill 为含 SKILL.md 的目录名；agents/prompts 为 .md 文件名（去后缀）；
 * commands 为 .md / .toml 文件名（去后缀，.toml 提取 description/prompt 转 .md）。
 * plugins 类型：第三方插件仓库，按约定目录自动拆解落地——
 *   skills/（含 SKILL.md 的目录）→ skills，agents/（.md）→ agents，commands/ → commands，prompts/（.md）→ prompts。
 *   hooks / mcp / extensions 涉及执行代码与环境配置，不做自动拆解。
 * 清单之外的目录（个人资源）不动；上次 vendor 但本次清单不再包含的会被自动移除（依据 sources-lock.json）。
 * 移除与覆盖都先移进 .cache/sources/ 备份区，任一步失败则整体回滚到同步前状态。
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "sources.json"), "utf8"));
const backupDir = path.join(root, ".cache", "sources");
const reposDir = path.join(root, ".cache", "repos");
const lockFile = path.join(root, "sources-lock.json");

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

// 用 host/owner/repo 三级目录做缓存路径：避免不同 owner 的同名仓库、以及不同 host 的同 owner/repo 互相冲突
const repoKey = (repo) => {
  const clean = repo.replace(/\.git$/, "");
  // scp 格式 git@host:owner/repo 归一化为 host/owner/repo，与 https 格式对齐
  const normalized = clean.replace(/^git@([^:]+):/, "$1/");
  return normalized.split("/").filter(Boolean).slice(-3).join("/");
};

/** 递归遍历 dir（跳过 . 开头与 node_modules）；onDir 返回 false 则不再下钻该目录 */
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

/** 递归查找 dir 下所有含 SKILL.md 的目录 */
function findSkillDirs(base) {
  const found = [];
  walk(base, {
    onDir: (dir) => {
      if (fs.existsSync(path.join(dir, "SKILL.md"))) {
        found.push(dir);
        return false;
      }
    },
  });
  return found;
}

// md 发现时跳过的仓库说明类文件
const MD_SKIP = new Set(["readme", "changelog", "license", "licence", "contributing", "code_of_conduct", "security"]);

const isMdResource = (name) =>
  name.endsWith(".md") && !MD_SKIP.has(name.slice(0, -3).toLowerCase());

/** 递归收集 dir 下满足 keep 的文件 */
function findFiles(base, keep) {
  const found = [];
  walk(base, {
    onFile: (f) => {
      if (keep(path.basename(f))) found.push(f);
    },
  });
  return found;
}

const isCommandFile = (name) => name.endsWith(".toml") || isMdResource(name);

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

// 四类资源类型：只有 skills 落地为目录，其余是单个 .md 文件；hooks / mcp / extensions 不拆解
const TYPES = {
  skills: { isDir: true },
  agents: { isDir: false },
  prompts: { isDir: false },
  commands: { isDir: false },
};

/** 归一化 capabilities：省略 / 对象 → { 能力: 条目数组 }（条目字段同顶层：path / include / exclude / alias） */
function normalizeCaps(entry) {
  const raw = entry.capabilities;
  if (raw === undefined || raw === null) {
    return Object.fromEntries(Object.keys(TYPES).map((k) => [k, [{}]]));
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
        throw new Error(`${entry.repo}: capabilities.${cap} 的条目必须是对象（path / include / exclude / alias）或 true`);
      }
      return spec;
    });
  }
  return out;
}

/** 按类型收集 dir 下的资源，交给 add(type, name, source, content?) */
function collectByType(type, dir, add) {
  if (type === "skills") {
    for (const d of findSkillDirs(dir)) add(type, path.basename(d), d);
  } else if (type === "commands") {
    for (const f of findFiles(dir, isCommandFile)) {
      const name = path.basename(f).replace(/\.(md|toml)$/, "");
      add(type, name, f, f.endsWith(".toml") ? tomlCommandToMd(fs.readFileSync(f, "utf8")) : undefined);
    }
  } else {
    for (const f of findFiles(dir, isMdResource)) add(type, path.basename(f, ".md"), f);
  }
}

/** 拆解第三方插件仓库：按 capabilities 声明的能力目录收集资源 */
function collectPlugin(entry, clonedDir, addFor) {
  if (entry.path || entry.include || entry.exclude || entry.alias) {
    console.warn(`[sync-sources] ${entry.repo}: plugins 只支持 repo + capabilities；path / include / exclude / alias 写到 capabilities.<能力> 的条目里（path 相对仓库根）`);
  }
  // 省略 capabilities 表示「有什么拆什么」，缺目录属正常；显式声明了才值得告警
  const explicit = entry.capabilities !== undefined && entry.capabilities !== null;
  let scanned = false;
  for (const [cap, specs] of Object.entries(normalizeCaps(entry))) {
    if (!TYPES[cap]) {
      console.warn(`[sync-sources] 跳过不支持的插件能力 ${cap}（${entry.repo}），仅支持: ${Object.keys(TYPES).join(" / ")}`);
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
      const alias = aliasFor(spec.alias, `${entry.repo} capabilities.${cap}`, cap);
      collectByType(cap, dir, addFor({ include: spec.include, exclude: spec.exclude }, alias));
      alias?.warnUnused();
    }
  }
  if (!scanned) {
    throw new Error(`${entry.repo}: 未找到任何声明的能力目录（${Object.keys(TYPES).join(" / ")}），无法作为插件拆解`);
  }
}

/**
 * 归一化已落地 skill 的 frontmatter name 为目录名。
 * 部分上游的 name 带前缀（如 vercel-composition-patterns），与目录不一致时，
 * 按 name 路由的工具会找不到或重复注册；统一在 sync 时改写，代替手工修 vendor 文件。
 */
function normalizeSkillName(target) {
  const file = path.join(target, "SKILL.md");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) return;
  const fmEnd = text.indexOf("\n---", 3);
  if (fmEnd === -1) return;
  const dir = path.basename(target);
  const fm = text.slice(0, fmEnd);
  const m = fm.match(/^name:\s*"?([^"\n]+)"?\s*$/m);
  if (!m || m[1].trim() === dir) return;
  fs.writeFileSync(file, fm.replace(/^name:.*$/m, `name: ${dir}`) + text.slice(fmEnd));
  console.log(`[sync-sources] 归一化 name: ${m[1].trim()} → ${dir}`);
}

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

// --check：只核对上游 commit 与 lock 的一致性并打印报告，不克隆、不写盘
if (process.argv.includes("--check")) {
  const repos = new Set();
  for (const entries of Object.values(manifest)) {
    if (Array.isArray(entries)) {
      for (const e of entries) if (e && typeof e.repo === "string") repos.add(e.repo);
    }
  }
  const heads = new Map();
  for (const repo of repos) {
    try {
      heads.set(repo, git(["ls-remote", repo, "HEAD"], root).split(/\s+/)[0].slice(0, 7));
    } catch (err) {
      console.warn(`[sync-sources] ${repo}: ls-remote 失败（${err.message}）`);
    }
  }
  const oldLock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : {};
  let stale = 0;
  for (const [type, locked] of Object.entries(oldLock)) {
    for (const [name, meta] of Object.entries(locked)) {
      const head = heads.get(meta.repo);
      const onDisk = fs.existsSync(path.join(root, type, name + (TYPES[type]?.isDir ? "" : ".md")));
      if (head && head !== meta.commit) {
        stale++;
        console.log(`[check] 过期 ${type}/${name}: locked=${meta.commit} upstream=${head}（${meta.repo}）`);
      }
      if (!onDisk) console.log(`[check] 未落盘 ${type}/${name}`);
    }
  }
  console.log(`[check] 完成：${stale} 个上游有更新`);
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(reposDir, { recursive: true });

/** 执行 git 命令，失败时抛出带 stderr 的错误（execFileSync 不走 shell，杜绝 URL 注入） */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err.stderr || "").toString().trim();
    throw new Error(`git ${args[0]} ${stderr || err.message}`);
  }
}

function cloneRepo(repo, clonedDir) {
  fs.mkdirSync(path.dirname(clonedDir), { recursive: true });
  git(["clone", "--depth", "1", repo, clonedDir], root);
}

/** 克隆/更新仓库，返回 { clonedDir, commit } */
function checkout(repo) {
  const clonedDir = path.join(reposDir, repoKey(repo));
  // 旧版缓存键是 owner/repo 两级，迁移到 host/owner/repo 三级：直接改名复用，避免全量重克隆
  if (!fs.existsSync(clonedDir)) {
    const legacyDir = path.join(reposDir, repo.replace(/\.git$/, "").split("/").slice(-2).join("/"));
    if (legacyDir !== clonedDir && fs.existsSync(path.join(legacyDir, ".git"))) {
      fs.mkdirSync(path.dirname(clonedDir), { recursive: true });
      fs.renameSync(legacyDir, clonedDir);
      // 旧 owner 目录搬空后顺手清掉（非空则忽略）
      try { fs.rmdirSync(path.dirname(legacyDir)); } catch { /* 还有其他仓库在用 */ }
    }
  }
  if (fs.existsSync(path.join(clonedDir, ".git"))) {
    try {
      git(["fetch", "--depth", "1", "origin", "HEAD"], clonedDir);
      git(["reset", "--hard", "FETCH_HEAD"], clonedDir);
    } catch (err) {
      // 缓存损坏（上次中断、手动改坏 .git 等）时降级为删除重克隆，而不是整体失败
      console.warn(`[sync-sources] ${repo}: 更新缓存失败（${err.message}），改为重新克隆`);
      rmrf(clonedDir);
      cloneRepo(repo, clonedDir);
    }
  } else {
    rmrf(clonedDir);
    cloneRepo(repo, clonedDir);
  }
  const commit = git(["rev-parse", "--short", "HEAD"], clonedDir).trim();
  return { clonedDir, commit };
}

// 同一 repo 在清单中出现多次时只 fetch 一次
const repoCache = new Map();
const checkoutCached = (repo) => {
  if (!repoCache.has(repo)) repoCache.set(repo, checkout(repo));
  return repoCache.get(repo);
};

/** include/exclude 匹配：支持精确名与 * / ? glob（不区分大小写） */
function matchAny(patterns, name) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => {
    if (typeof p !== "string") return false;
    if (!/[?*]/.test(p)) return p === name;
    const re = new RegExp(
      "^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i",
    );
    return re.test(name);
  });
}

/**
 * 解析 alias（上游名 → 本地名），返回改名器；没有 alias 返回 null。
 * 在 include / exclude 之后生效：过滤按上游名，alias 只决定落地名。
 */
function aliasFor(raw, where, type) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: alias 必须是对象（{ "<上游名>": "<本地名>" }，如 { "unslop": "unslop-ui" }）`);
  }
  const map = new Map();
  for (const [from, value] of Object.entries(raw)) {
    const local = typeof value === "string" ? value.trim() : "";
    // 本地名会拼进目标路径，只接受单段名字
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
    // 没命中任何资源的键：拼错、上游改名，或被 include/exclude 过滤
    warnUnused() {
      for (const key of map.keys()) {
        if (!used.has(key)) console.warn(`[sync-sources] ${where}: alias "${key}" 未命中任何资源`);
      }
    },
  };
}

// 解析出本次要同步的资源列表
const planned = []; // { type, name, upstream?, source, repo, commit, content? }
const plannedByKey = new Map(); // "type:name"（小写）→ 首次占用的来源；去重与重名告警共用
try {
  for (const [type, entries] of Object.entries(manifest)) {
    if (!Array.isArray(entries)) {
      throw new Error(`sources.json: ${type} 必须是条目数组`);
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.repo !== "string" || !entry.repo) {
        throw new Error(`sources.json: ${type} 的每个条目都必须包含 repo 字段（git 仓库 URL）`);
      }
      const { clonedDir, commit } = checkoutCached(entry.repo);

      // 条目的登记函数：过滤、alias 改名、全局去重都在这里，key 用的是落地名
      const addFor = (filters = {}, alias = null) => (resourceType, name, source, content) => {
        if (filters.include && !matchAny(filters.include, name)) return;
        if (filters.exclude && matchAny(filters.exclude, name)) return;
        const local = alias ? alias.resolve(name) : name;
        const key = `${resourceType}:${local}`.toLowerCase();
        const origin = `${entry.repo}${local === name ? "" : ` 的 ${name}`}`;
        if (plannedByKey.has(key)) {
          console.warn(`[sync-sources] 跳过重名 ${resourceType}: ${local}（${origin}），已被 ${plannedByKey.get(key)} 占用`);
          return;
        }
        plannedByKey.set(key, origin);
        planned.push({
          type: resourceType,
          name: local,
          upstream: local === name ? undefined : name,
          source,
          repo: entry.repo,
          commit,
          content,
        });
      };

      if (type === "plugins") {
        collectPlugin(entry, clonedDir, addFor);
        continue;
      }

      const scanRoot = path.join(clonedDir, entry.path || type);
      if (!fs.existsSync(scanRoot)) {
        throw new Error(`${entry.repo}: 目录不存在 ${entry.path || type}`);
      }

      const alias = aliasFor(entry.alias, `${type}@${entry.repo}`, type);

      // skills 特殊值 "."：整个仓库即一个 skill（SKILL.md 在仓库根目录），上游名取仓库目录名
      if (type === "skills" && entry.path === ".") {
        if (!fs.existsSync(path.join(clonedDir, "SKILL.md"))) {
          throw new Error(`${entry.repo}: path 为 "."，但仓库根目录没有 SKILL.md`);
        }
        addFor({}, alias)(type, path.basename(clonedDir), clonedDir);
        alias?.warnUnused();
        continue;
      }

      collectByType(type, scanRoot, addFor({ include: entry.include, exclude: entry.exclude }, alias));
      alias?.warnUnused();
    }
  }
} catch (err) {
  console.error(`[sync-sources] 同步中止: ${err.message}`);
  process.exit(1);
}

if (planned.length === 0) {
  console.error("[sync-sources] 清单未匹配到任何资源");
  process.exit(1);
}

/** 落盘名：目录类用原名，文件类补 .md */
const fileName = (p) => p.name + (TYPES[p.type].isDir ? "" : ".md");
const targetPath = (p) => path.join(root, p.type, fileName(p));
const backupPath = (p) => path.join(backupDir, p.type, fileName(p));

// 备份区同时承担两件事：暂存"将被覆盖的同名资源"，以及暂存"已退出清单、要被移除的资源"。
// 两者一起进备份区，失败时才回滚得回来——移除跑在备份之前的话，被删的资源恢复不了。
// 先清空备份区，避免上次中断留下的残骸让 rename 失败
rmrf(backupDir);
const backedUp = [];
const stash = (p) => {
  const target = targetPath(p);
  if (!fs.existsSync(target)) return false;
  const backup = backupPath(p);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.renameSync(target, backup);
  backedUp.push(p);
  return true;
};

// 上次 vendor 但本次清单不再包含的资源
const oldLock = fs.existsSync(lockFile)
  ? JSON.parse(fs.readFileSync(lockFile, "utf8"))
  : {};

// 落盘前护栏：目标已存在却不在 lock 里 = 同名个人资源。覆盖它虽然先进备份区，
// 但成功后备份区整体删除，等于静默删掉个人资源——直接中止，给出 alias 解法。
const foreign = planned.filter((p) => !oldLock[p.type]?.[p.name] && fs.existsSync(targetPath(p)));
if (foreign.length) {
  for (const p of foreign) {
    console.error(`[sync-sources] ${p.type}/${p.name} 已存在且不在 lock 中（个人资源），会被 ${p.repo} 覆盖${p.upstream ? `（上游 ${p.upstream}）` : ""}`);
  }
  console.error('[sync-sources] 已中止，磁盘未改动：给对应条目加 alias 换个本地名，或先移除该资源');
  process.exit(1);
}

const retired = Object.entries(oldLock).flatMap(([type, locked]) =>
  TYPES[type]
    ? Object.keys(locked)
        .filter((name) => !plannedByKey.has(`${type}:${name}`.toLowerCase()))
        .map((name) => ({ type, name }))
    : [],
);

// copied 记录"已开始落地"的项：回滚时只删这些，尚未 stash 的旧版本绝不能动
const copied = [];
try {
  for (const p of retired) {
    if (stash(p)) console.log(`[sync-sources] 移除已退出清单的 ${p.type}: ${p.name}`);
  }

  for (const p of planned) stash(p);

  for (const p of planned) {
    copied.push(p); // 先登记再复制：复制中途失败时该目标可能有残留，需要清掉（原件已在备份区）
    const target = targetPath(p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (TYPES[p.type].isDir) {
      // filter 排除 .git（path 指向仓库根时 source 含 .git）
      fs.cpSync(p.source, target, {
        recursive: true,
        filter: (src) => !src.split(path.sep).includes(".git"),
      });
      normalizeSkillName(target);
    } else if (p.content !== undefined) {
      fs.writeFileSync(target, p.content);
    } else {
      fs.copyFileSync(p.source, target);
    }
    const label = p.upstream ? `${p.upstream} → ${p.name}（alias）` : p.name;
    console.log(`[sync-sources] ${label} @ ${p.commit} → ${p.type}/${p.name}`);
  }
} catch (err) {
  for (const p of copied) rmrf(targetPath(p));
  for (const p of backedUp) {
    const backup = backupPath(p);
    const target = targetPath(p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(backup, target);
  }
  rmrf(backupDir);
  console.error(`[sync-sources] 同步失败，已回退: ${err.message}`);
  process.exit(1);
}

rmrf(backupDir);
const lock = {};
// lock 记本地名；alias 改名时额外记 upstream，便于从 lock 反查这个目录对应上游哪个资源
for (const p of planned) {
  lock[p.type] ||= {};
  lock[p.type][p.name] = { repo: p.repo, commit: p.commit, ...(p.upstream ? { upstream: p.upstream } : {}) };
}
// 原子写：先写临时文件再 rename，避免中断留下截断的 lock 导致下次 retired 计算错误
fs.writeFileSync(`${lockFile}.tmp`, `${JSON.stringify(lock, null, 2)}\n`);
fs.renameSync(`${lockFile}.tmp`, lockFile);
const counts = Object.entries(lock).map(([t, m]) => `${t}: ${Object.keys(m).length}`).join(", ");
console.log(`[sync-sources] 完成，共 ${planned.length} 个资源（${counts}）`);
