#!/usr/bin/env node
/** 统一 bump 五份清单的版本号。用法: npm run bump-version -- 1.2.3 */

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const MANIFESTS = [
  "package.json",
  "plugin.json",
  "kimi.plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function abort(message) {
  console.error(message);
  process.exit(1);
}

function parseVersion(argv) {
  const version = argv[2];
  if (!version || !SEMVER.test(version)) {
    abort("用法: npm run bump-version -- <semver>，例如: npm run bump-version -- 0.1.0");
  }
  return version;
}

function bumpManifest(file, version) {
  const filePath = path.join(repoRoot, file);
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const previous = json.version;
  json.version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${file}: ${previous} -> ${version}`);
}

function main() {
  const version = parseVersion(process.argv);
  for (const file of MANIFESTS) bumpManifest(file, version);
}

main();
