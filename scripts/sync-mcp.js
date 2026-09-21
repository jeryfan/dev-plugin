#!/usr/bin/env node
/**
 * 以 .mcp.json 为唯一数据源，同步：
 * 1. mcp.json (符合 Agent Plugins 1.0 规范，包含 $schema 与 type: stdio)
 * 2. kimi.plugin.json (Kimi 不读 .mcp.json，必须内联 mcpServers)
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

// 1. 同步 Agent Plugins 1.0 规范的 mcp.json
const standardMcp = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {}
};

for (const [name, config] of Object.entries(mcpServers)) {
  standardMcp.mcpServers[name] = {
    type: config.type || (config.url ? "streamable-http" : "stdio"),
    ...config
  };
}
writeJson("mcp.json", standardMcp);

// 2. 同步 kimi.plugin.json
const kimi = readJson("kimi.plugin.json");
kimi.mcpServers = mcpServers;
writeJson("kimi.plugin.json", kimi);

