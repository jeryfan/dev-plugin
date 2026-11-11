#!/usr/bin/env node
/**
 * pi 环境安装脚本（postinstall 触发）。
 * pi 不支持包级 MCP / AGENTS.md / settings，需同步到 ~/.pi/agent/。
 * 仅同步配置与说明，不代为安装外部 CLI/二进制（如 playwright-cli 需用户自行安装）。
 *
 * 非破坏性策略：
 * - mcp.json / settings.json：目标优先深合并，只补用户没有的 key，已有配置一律保留
 * - AGENTS.md：覆盖前先把用户已有版本备份为 AGENTS.md.bak
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const packageRoot = path.join(__dirname, "..");
const piAgentDir = path.join(os.homedir(), ".pi", "agent");

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

function readJsonFile(filePath, label) {
	try {
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!isPlainObject(data)) throw new Error("顶层不是 JSON 对象");
		return data;
	} catch (err) {
		console.error(`[setup-pi] 解析 ${label} 失败:`, err.message);
		return undefined;
	}
}

/** JSON 配置合并落盘：源是包内默认，目标是用户已有配置（目标优先） */
function mergeJsonToPiAgent(sourceName, sourcePath) {
	if (!fs.existsSync(sourcePath)) {
		console.log(`[setup-pi] ${sourceName} 不存在，跳过`);
		return;
	}
	const source = readJsonFile(sourcePath, sourceName);
	if (source === undefined) return;

	const targetPath = path.join(piAgentDir, sourceName);
	let target = {};
	if (fs.existsSync(targetPath)) {
		target = readJsonFile(targetPath, targetPath);
		if (target === undefined) {
			const backupPath = `${targetPath}.bak`;
			fs.copyFileSync(targetPath, backupPath);
			console.error(`[setup-pi] ${targetPath} 无法解析，已备份到 ${backupPath}，跳过合并`);
			return;
		}
	}

	const merged = fillMissing(target, source);
	if (JSON.stringify(merged) === JSON.stringify(target)) {
		console.log(`[setup-pi] ${sourceName} 无需更新`);
		return;
	}

	try {
		fs.mkdirSync(piAgentDir, { recursive: true });
		fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
		console.log(`[setup-pi] 已合并 ${sourceName} → ${targetPath}`);
	} catch (err) {
		console.error(`[setup-pi] 写入 ${sourceName} 失败:`, err.message);
	}
}

/** 文本文件同步：内容一致则不动；覆盖前把用户已有版本备份为 <name>.bak */
function copyWithBackup(sourceName, sourcePath) {
	if (!fs.existsSync(sourcePath)) {
		console.log(`[setup-pi] ${sourceName} 不存在，跳过`);
		return;
	}
	const targetPath = path.join(piAgentDir, sourceName);
	try {
		const source = fs.readFileSync(sourcePath);
		if (fs.existsSync(targetPath)) {
			if (fs.readFileSync(targetPath).equals(source)) {
				console.log(`[setup-pi] ${sourceName} 无需更新`);
				return;
			}
			const backupPath = `${targetPath}.bak`;
			fs.copyFileSync(targetPath, backupPath);
			console.log(`[setup-pi] 已有 ${sourceName} 与包内版本不同，已备份到 ${backupPath}`);
		}
		fs.mkdirSync(piAgentDir, { recursive: true });
		fs.writeFileSync(targetPath, source);
		console.log(`[setup-pi] 已同步 ${sourceName} → ${piAgentDir}`);
	} catch (err) {
		console.error(`[setup-pi] 同步 ${sourceName} 失败:`, err.message);
	}
}

// 1. MCP 配置 → ~/.pi/agent/mcp.json（合并，保留用户已有 mcpServers）
mergeJsonToPiAgent("mcp.json", path.join(packageRoot, ".mcp.json"));

// 2. 全局 AGENTS.md → ~/.pi/agent/AGENTS.md（覆盖前备份）
copyWithBackup("AGENTS.md", path.join(packageRoot, ".pi", "AGENTS.md"));

// 3. 全局 settings 默认值 → ~/.pi/agent/settings.json（合并）
mergeJsonToPiAgent("settings.json", path.join(packageRoot, ".pi", "settings.json"));
