#!/usr/bin/env node
/**
 * 统一 bump 四个清单文件的版本号。
 * 用法: npm run version -- 1.2.3
 */
const fs = require('fs');
const path = require('path');

const FILES = [
  'package.json',
  'kimi.plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
];

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('用法: npm run version -- <semver>，例如: npm run version -- 0.1.0');
  process.exit(1);
}

const root = path.join(__dirname, '..');

for (const file of FILES) {
  const filePath = path.join(root, file);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const oldVersion = json.version;
  json.version = version;
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
  console.log(`${file}: ${oldVersion} -> ${version}`);
}
