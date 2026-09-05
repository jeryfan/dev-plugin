#!/usr/bin/env node
/**
 * 以 .mcp.json 为唯一数据源，同步 mcpServers 到 kimi.plugin.json（Kimi 不读 .mcp.json，必须内联）。
 * Claude / Codex 直接读 .mcp.json；pi 不支持包级 MCP，无需同步。
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const writeJson = (file, data) => {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`updated ${file}`);
};

const { mcpServers } = readJson(".mcp.json");
if (!mcpServers || typeof mcpServers !== "object") {
  console.error('.mcp.json must contain a "mcpServers" object');
  process.exit(1);
}

// kimi
const kimi = readJson("kimi.plugin.json");
kimi.mcpServers = mcpServers;
writeJson("kimi.plugin.json", kimi);
