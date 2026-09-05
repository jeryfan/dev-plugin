#!/usr/bin/env node
/**
 * pi 环境安装脚本（postinstall 触发）。
 * pi 不支持包级 MCP / 全局 AGENTS.md，需同步到 ~/.pi/agent/。
 * 本项目只负责资源，不负责环境管理（如 playwright-cli 二进制需用户自行安装）。
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

// 1. MCP 配置 → ~/.pi/agent/mcp.json
copyToPiAgent("mcp.json", path.join(packageRoot, ".mcp.json"));

// 2. 全局 AGENTS.md → ~/.pi/agent/AGENTS.md
copyToPiAgent("AGENTS.md", path.join(packageRoot, ".pi", "AGENTS.md"));
