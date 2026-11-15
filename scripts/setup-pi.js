#!/usr/bin/env node
/**
 * pi 环境安装脚本（postinstall 触发）：把包内配置与说明同步到 ~/.pi/agent/。
 * 非破坏性：JSON 目标优先合并（只补缺失 key），AGENTS.md 覆盖前备份为 .bak。
 * 不代为安装外部 CLI / 二进制（如 playwright-cli 需用户自行安装）。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const piAgentDir = path.join(os.homedir(), ".pi", "agent");

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 目标优先的深合并：只补目标缺失的 key，已有值（含嵌套）一律保留 */
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
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
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
    fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    console.log(`[setup-pi] 已合并 ${sourceName} → ${targetPath}`);
  } catch (err) {
    console.error(`[setup-pi] 写入 ${sourceName} 失败:`, err.message);
  }
}

/** 文本文件同步：内容一致则不动，覆盖前把用户版本备份为 <name>.bak */
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

function main() {
  // 1. MCP 配置（合并，保留用户已有的 mcpServers）
  mergeJsonToPiAgent("mcp.json", path.join(repoRoot, ".mcp.json"));
  // 2. 全局 AGENTS.md（覆盖前备份）
  copyWithBackup("AGENTS.md", path.join(repoRoot, ".pi", "AGENTS.md"));
  // 3. settings 默认值（合并）
  mergeJsonToPiAgent("settings.json", path.join(repoRoot, ".pi", "settings.json"));
}

main();
