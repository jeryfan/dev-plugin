#!/usr/bin/env node
/**
 * 仓库体检（离线、快速）：发版前/CI 兜底。
 *
 * 校验项：
 * 1. 五份清单的 version 一致（plugin.json / .claude-plugin / .codex-plugin / kimi.plugin.json / package.json）
 * 2. 每个 skills/<name>/SKILL.md 有合法 frontmatter（name == 目录名、description 非空）
 * 3. sources-lock.json 里的资源全部落盘（无"lock 有、磁盘无"的漂移）
 * 4. mcp.json / kimi.plugin.json 与 .mcp.json 一致（等价于跑过 sync-mcp）
 * 5. sources.json 条目结构合法（每个条目有 repo 字符串）
 * 6. package.json 的 pi.* 本地路径存在（node_modules 依赖在 CI 上跳过）
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const errors = [];
const warn = (m) => console.warn(`[check] warn: ${m}`);
const fail = (m) => {
	errors.push(m);
	console.error(`[check] FAIL: ${m}`);
};
const readJson = (f) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
	} catch (err) {
		fail(`解析 ${f} 失败: ${err.message}`);
		return undefined;
	}
};

// 1. 版本一致
const MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "kimi.plugin.json", "package.json"];
const versions = {};
for (const f of MANIFESTS) {
	const j = readJson(f);
	if (j) versions[f] = j.version;
}
const uniq = new Set(Object.values(versions));
if (uniq.size > 1) fail(`清单版本不一致: ${JSON.stringify(versions)}`);
else console.log(`[check] 版本一致: ${[...uniq][0]}`);

// 2. SKILL.md frontmatter
const skillsDir = path.join(root, "skills");
if (fs.existsSync(skillsDir)) {
	let ok = 0;
	for (const name of fs.readdirSync(skillsDir)) {
		const dir = path.join(skillsDir, name);
		const file = path.join(dir, "SKILL.md");
		if (!fs.statSync(dir).isDirectory()) continue;
		if (!fs.existsSync(file)) {
			fail(`skills/${name}: 缺少 SKILL.md`);
			continue;
		}
		const text = fs.readFileSync(file, "utf8");
		if (!text.startsWith("---")) {
			fail(`skills/${name}: SKILL.md 缺少 frontmatter`);
			continue;
		}
		const fm = text.slice(0, text.indexOf("\n---", 3) === -1 ? text.length : text.indexOf("\n---", 3));
		const m = fm.match(/^name:\s*"?([^"\n]+)"?\s*$/m);
		if (!m) fail(`skills/${name}: frontmatter 缺 name`);
		else if (m[1].trim() !== name) fail(`skills/${name}: name 为 "${m[1].trim()}"，与目录不一致`);
		else if (!/^description:\s*\S/m.test(fm)) fail(`skills/${name}: frontmatter 缺 description`);
		else ok++;
	}
	console.log(`[check] skills frontmatter: ${ok} 个通过`);
}

// 3. lock ⊆ 磁盘
const lock = readJson("sources-lock.json") || {};
const TYPES = { skills: "skills", agents: "agents", prompts: "prompts", commands: "commands" };
for (const [type, locked] of Object.entries(lock)) {
	const dir = TYPES[type];
	if (!dir) {
		warn(`sources-lock.json 出现未知类型 ${type}`);
		continue;
	}
	const isDir = type === "skills";
	for (const name of Object.keys(locked)) {
		const p = path.join(root, dir, name + (isDir ? "" : ".md"));
		if (!fs.existsSync(p)) fail(`lock 中 ${type}/${name} 未落盘到 ${dir}/`);
	}
}

// 4. mcp.json / kimi.plugin.json 与 .mcp.json 一致
const src = readJson(".mcp.json");
if (src && src.mcpServers) {
	const mcp = readJson("mcp.json");
	if (mcp) {
		const expected = {};
		for (const [name, cfg] of Object.entries(src.mcpServers)) {
			expected[name] = { type: cfg.type || (cfg.url ? "streamable-http" : "stdio"), ...cfg };
		}
		if (JSON.stringify(mcp.mcpServers) !== JSON.stringify(expected)) {
			fail("mcp.json 与 .mcp.json 不一致，请运行 node scripts/sync-mcp.js");
		}
	}
	const kimi = readJson("kimi.plugin.json");
	if (kimi && JSON.stringify(kimi.mcpServers) !== JSON.stringify(src.mcpServers)) {
		fail("kimi.plugin.json 的 mcpServers 与 .mcp.json 不一致，请运行 node scripts/sync-mcp.js");
	}
	console.log("[check] MCP 清单一致");
}

// 5. sources.json 结构
const manifest = readJson("sources.json");
if (manifest) {
	const VALID = new Set(["skills", "agents", "prompts", "commands", "plugins"]);
	for (const [type, entries] of Object.entries(manifest)) {
		if (!VALID.has(type)) fail(`sources.json 未知类型: ${type}`);
		else if (!Array.isArray(entries)) fail(`sources.json ${type} 不是数组`);
		else
			for (const e of entries) {
				if (!e || typeof e.repo !== "string" || !e.repo) fail(`sources.json ${type} 有条目缺 repo`);
			}
	}
}

// 6. package.json pi.* 本地路径存在
const pkg = readJson("package.json");
if (pkg && pkg.pi) {
	for (const [field, paths] of Object.entries(pkg.pi)) {
		for (const p of paths) {
			if (p.startsWith("node_modules/")) continue; // CI 不装依赖
			if (!fs.existsSync(path.join(root, p))) fail(`package.json pi.${field} 路径不存在: ${p}`);
		}
	}
}

if (errors.length) {
	console.error(`[check] ${errors.length} 项失败`);
	process.exit(1);
}
console.log("[check] 全部通过");
