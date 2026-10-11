#!/usr/bin/env node
/**
 * pi 环境安装脚本（postinstall 触发）。
 * pi 不支持包级 MCP / AGENTS.md / settings，需同步到 ~/.pi/agent/。
 * 仅同步配置与说明，不代为安装外部 CLI/二进制（如 playwright-cli 需用户自行安装）。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const packageRoot = path.join(__dirname, "..");
const piAgentDir = path.join(os.homedir(), ".pi", "agent");

function copyToPiAgent(sourceName, sourcePath) {
	if (!fs.existsSync(sourcePath)) {
		console.log(`[setup-pi] ${sourceName} 不存在，跳过`);
		return;
	}
	try {
		fs.mkdirSync(piAgentDir, { recursive: true });
		fs.copyFileSync(sourcePath, path.join(piAgentDir, sourceName));
		console.log(`[setup-pi] 已同步 ${sourceName} → ${piAgentDir}`);
	} catch (err) {
		console.error(`[setup-pi] 同步 ${sourceName} 失败:`, err.message);
	}
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 目标优先的深合并：只补目标缺失的 key，目标已有的值（含嵌套）一律保留。
 */
function fillMissing(target, source) {
	const result = { ...target };
	for (const [key, value] of Object.entries(source)) {
		if (!(key in result)) {
			result[key] = value;
		} else if (isPlainObject(result[key]) && isPlainObject(value)) {
			result[key] = fillMissing(result[key], value);
		}
	}
	return result;
}

// 3. 全局 settings 默认值 → ~/.pi/agent/settings.json（目标优先，不覆盖用户已有配置）
function mergeSettings() {
	const sourcePath = path.join(packageRoot, ".pi", "settings.json");
	if (!fs.existsSync(sourcePath)) {
		console.log("[setup-pi] .pi/settings.json 不存在，跳过");
		return;
	}

	let source;
	try {
		source = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
	} catch (err) {
		console.error("[setup-pi] 解析 .pi/settings.json 失败:", err.message);
		return;
	}

	const targetPath = path.join(piAgentDir, "settings.json");
	let target = {};
	if (fs.existsSync(targetPath)) {
		try {
			target = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
			if (!isPlainObject(target)) {
				throw new Error("顶层不是 JSON 对象");
			}
		} catch (err) {
			const backupPath = `${targetPath}.bak`;
			fs.copyFileSync(targetPath, backupPath);
			console.error(`[setup-pi] 解析 ${targetPath} 失败，已备份到 ${backupPath}，跳过合并:`, err.message);
			return;
		}
	}

	const merged = fillMissing(target, source);
	if (JSON.stringify(merged) === JSON.stringify(target)) {
		console.log("[setup-pi] settings.json 无需更新");
		return;
	}

	try {
		fs.mkdirSync(piAgentDir, { recursive: true });
		fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
		console.log(`[setup-pi] 已合并 settings.json → ${targetPath}`);
	} catch (err) {
		console.error("[setup-pi] 写入 settings.json 失败:", err.message);
	}
}

// 1. MCP 配置 → ~/.pi/agent/mcp.json
copyToPiAgent("mcp.json", path.join(packageRoot, ".mcp.json"));

// 2. 全局 AGENTS.md → ~/.pi/agent/AGENTS.md
copyToPiAgent("AGENTS.md", path.join(packageRoot, ".pi", "AGENTS.md"));

// 3. 全局 settings 默认值 → ~/.pi/agent/settings.json
mergeSettings();
