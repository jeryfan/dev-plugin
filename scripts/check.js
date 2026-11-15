#!/usr/bin/env node
/**
 * 仓库体检（离线、快速）：发版前 / CI 兜底。
 * 校验版本一致、skills frontmatter、lock 落盘、MCP 清单、sources.json 结构、pi 路径存在。
 */

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "kimi.plugin.json", "package.json"];
const RESOURCE_TYPES = ["skills", "agents", "prompts", "commands"];
const LOCK_TYPES = new Set(RESOURCE_TYPES);
const SOURCE_TYPES = new Set([...RESOURCE_TYPES, "plugins"]);
const errors = [];

function warn(message) {
  console.warn(`[check] warn: ${message}`);
}

function fail(message) {
  errors.push(message);
  console.error(`[check] FAIL: ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
  } catch (err) {
    fail(`解析 ${file} 失败: ${err.message}`);
    return undefined;
  }
}

/** 1. 五份清单版本一致 */
function checkVersions() {
  const versions = {};
  for (const file of MANIFESTS) {
    const json = readJson(file);
    if (json) versions[file] = json.version;
  }
  const uniq = new Set(Object.values(versions));
  if (uniq.size > 1) fail(`清单版本不一致: ${JSON.stringify(versions)}`);
  else console.log(`[check] 版本一致: ${[...uniq][0]}`);
}

/** 2. 每个 skills/<name>/SKILL.md 的 frontmatter（name 等于目录名、有 description） */
function checkSkills() {
  const skillsDir = path.join(repoRoot, "skills");
  if (!fs.existsSync(skillsDir)) return;
  let ok = 0;
  for (const name of fs.readdirSync(skillsDir)) {
    const dir = path.join(skillsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) {
      fail(`skills/${name}: 缺少 SKILL.md`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    if (!text.startsWith("---")) {
      fail(`skills/${name}: SKILL.md 缺少 frontmatter`);
      continue;
    }
    const fmEnd = text.indexOf("\n---", 3);
    const fm = text.slice(0, fmEnd === -1 ? text.length : fmEnd);
    const match = fm.match(/^name:\s*"?([^"\n]+)"?\s*$/m);
    if (!match) fail(`skills/${name}: frontmatter 缺 name`);
    else if (match[1].trim() !== name) fail(`skills/${name}: name 为 "${match[1].trim()}"，与目录不一致`);
    else if (!/^description:\s*\S/m.test(fm)) fail(`skills/${name}: frontmatter 缺 description`);
    else ok++;
  }
  console.log(`[check] skills frontmatter: ${ok} 个通过`);
}

/** 3. lock 里的资源都已落盘 */
function checkLock() {
  const lock = readJson("sources-lock.json") || {};
  for (const [type, locked] of Object.entries(lock)) {
    if (!LOCK_TYPES.has(type)) {
      warn(`sources-lock.json 出现未知类型 ${type}`);
      continue;
    }
    const isDir = type === "skills";
    for (const name of Object.keys(locked)) {
      const target = path.join(repoRoot, type, name + (isDir ? "" : ".md"));
      if (!fs.existsSync(target)) fail(`lock 中 ${type}/${name} 未落盘到 ${type}/`);
    }
  }
}

/** 4. mcp.json / kimi.plugin.json 与 .mcp.json 一致 */
function checkMcp() {
  const source = readJson(".mcp.json");
  if (!source || !source.mcpServers) return;

  const mcp = readJson("mcp.json");
  if (mcp) {
    const expected = {};
    for (const [name, config] of Object.entries(source.mcpServers)) {
      expected[name] = { type: config.type || (config.url ? "streamable-http" : "stdio"), ...config };
    }
    if (JSON.stringify(mcp.mcpServers) !== JSON.stringify(expected)) {
      fail("mcp.json 与 .mcp.json 不一致，请运行 node scripts/sync-mcp.js");
    }
  }

  const kimi = readJson("kimi.plugin.json");
  if (kimi && JSON.stringify(kimi.mcpServers) !== JSON.stringify(source.mcpServers)) {
    fail("kimi.plugin.json 的 mcpServers 与 .mcp.json 不一致，请运行 node scripts/sync-mcp.js");
  }
  console.log("[check] MCP 清单一致");
}

/** 5. sources.json 结构（alias 只查形状，本地名规则由 sync-sources 负责） */
function checkSources() {
  const manifest = readJson("sources.json");
  if (!manifest) return;

  const checkAlias = (alias, where) => {
    if (alias === undefined) return;
    if (!alias || typeof alias !== "object" || Array.isArray(alias)) {
      return fail(`${where}: alias 必须是对象（{ "<上游名>": "<本地名>" }）`);
    }
    for (const [from, to] of Object.entries(alias)) {
      if (typeof to !== "string" || !to.trim()) fail(`${where}: alias["${from}"] 的本地名必须是非空字符串`);
    }
  };

  for (const [type, entries] of Object.entries(manifest)) {
    if (!SOURCE_TYPES.has(type)) fail(`sources.json 未知类型: ${type}`);
    else if (!Array.isArray(entries)) fail(`sources.json ${type} 不是数组`);
    else
      for (const entry of entries) {
        if (!entry || typeof entry.repo !== "string" || !entry.repo) {
          fail(`sources.json ${type} 有条目缺 repo`);
          continue;
        }
        if (type !== "plugins") {
          checkAlias(entry.alias, `sources.json ${type} (${entry.repo})`);
          continue;
        }
        if (entry.alias !== undefined) warn(`sources.json plugins 条目 (${entry.repo}) 的 alias 应写在 capabilities 的条目里`);
        for (const [cap, specs] of Object.entries(entry.capabilities || {})) {
          for (const spec of Array.isArray(specs) ? specs : []) {
            if (spec && typeof spec === "object") checkAlias(spec.alias, `sources.json plugins ${cap} (${entry.repo})`);
          }
        }
      }
  }
}

/** 6. package.json 的 pi.* 本地路径存在（node_modules 依赖在 CI 上跳过） */
function checkPiPaths() {
  const pkg = readJson("package.json");
  if (!pkg || !pkg.pi) return;
  for (const [field, paths] of Object.entries(pkg.pi)) {
    for (const p of paths) {
      if (p.startsWith("node_modules/")) continue;
      if (!fs.existsSync(path.join(repoRoot, p))) fail(`package.json pi.${field} 路径不存在: ${p}`);
    }
  }
}

function main() {
  checkVersions();
  checkSkills();
  checkLock();
  checkMcp();
  checkSources();
  checkPiPaths();

  if (errors.length) {
    console.error(`[check] ${errors.length} 项失败`);
    process.exit(1);
  }
  console.log("[check] 全部通过");
}

main();
