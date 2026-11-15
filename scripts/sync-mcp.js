#!/usr/bin/env node
/**
 * 以 .mcp.json 为唯一数据源，同步 mcp.json（Agent Plugins 1.0，含 $schema 与 type）
 * 与 kimi.plugin.json（Kimi 不读 .mcp.json，必须内联 mcpServers）。
 * Claude / Codex 直接读 .mcp.json；pi 不支持包级 MCP，无需同步。
 */

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function abort(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(repoRoot, file), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`updated ${file}`);
}

function readMcpServers() {
  const { mcpServers } = readJson(".mcp.json");
  if (!mcpServers || typeof mcpServers !== "object") abort(".mcp.json must contain a \"mcpServers\" object");
  return mcpServers;
}

/** 补上 Agent Plugins 1.0 要求的 type；配置里已有的 type 优先 */
function withType(config) {
  return { type: config.type || (config.url ? "streamable-http" : "stdio"), ...config };
}

function writeStandardMcp(mcpServers) {
  const servers = Object.fromEntries(
    Object.entries(mcpServers).map(([name, config]) => [name, withType(config)]),
  );
  writeJson("mcp.json", { $schema: MCP_SCHEMA, mcpServers: servers });
}

function writeKimiPlugin(mcpServers) {
  const kimi = readJson("kimi.plugin.json");
  kimi.mcpServers = mcpServers;
  writeJson("kimi.plugin.json", kimi);
}

function main() {
  const mcpServers = readMcpServers();
  writeStandardMcp(mcpServers);
  writeKimiPlugin(mcpServers);
}

main();
